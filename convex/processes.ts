import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  buildSafeDescriptionFields,
  classifyDescriptionSafety,
  DescriptionSafetyRisk,
  normalizeDescriptionInput,
} from "./descriptionSafety";
import type { UsageAttribution } from "./lib/aiUsageMeter";
import {
  assertOrgOwns,
  requireOrgContributor,
  requireOrgMember,
  resolveOrgForAction,
} from "./lib/orgAuth";
import { toLightweightSummaryListRow } from "./summaryV2";
import { withSummaryV2ReadGate } from "./lib/summaryV2Feature";
import {
  derivePendingWorkStatus,
  getConversationCounts,
  getLatestConversation,
  getLatestDoneConversation,
  PENDING_WORK_LABELS,
  summarizeFlow,
} from "./readModelHelpers";

type DescriptionUpdate =
  | { kind: "unchanged" }
  | { kind: "clear" }
  | {
      kind: "set";
      description: string;
      descriptionSafetyStatus: "safe";
      descriptionSafetyCheckedAt: number;
      descriptionSafetyModel: string;
      descriptionSafetyPromptVersion: string;
      descriptionSafetyRisk: DescriptionSafetyRisk;
      descriptionSafetyReason: string;
    };

const descriptionUpdateValidator = v.union(
  v.object({ kind: v.literal("unchanged") }),
  v.object({ kind: v.literal("clear") }),
  v.object({
    kind: v.literal("set"),
    description: v.string(),
    descriptionSafetyStatus: v.literal("safe"),
    descriptionSafetyCheckedAt: v.number(),
    descriptionSafetyModel: v.string(),
    descriptionSafetyPromptVersion: v.string(),
    descriptionSafetyRisk: v.union(
      v.literal("none"),
      v.literal("prompt_injection"),
      v.literal("agent_instruction"),
      v.literal("policy_override"),
      v.literal("sensitive_data_request"),
      v.literal("malicious_or_abusive"),
      v.literal("irrelevant"),
    ),
    descriptionSafetyReason: v.string(),
  }),
);

function applyDescriptionUpdate(
  patch: Record<string, unknown>,
  descriptionUpdate: DescriptionUpdate,
) {
  if (descriptionUpdate.kind === "unchanged") return;
  if (descriptionUpdate.kind === "clear") {
    patch.description = undefined;
    patch.descriptionSafetyStatus = undefined;
    patch.descriptionSafetyCheckedAt = undefined;
    patch.descriptionSafetyModel = undefined;
    patch.descriptionSafetyPromptVersion = undefined;
    patch.descriptionSafetyRisk = undefined;
    patch.descriptionSafetyReason = undefined;
    return;
  }

  patch.description = descriptionUpdate.description;
  patch.descriptionSafetyStatus = descriptionUpdate.descriptionSafetyStatus;
  patch.descriptionSafetyCheckedAt =
    descriptionUpdate.descriptionSafetyCheckedAt;
  patch.descriptionSafetyModel = descriptionUpdate.descriptionSafetyModel;
  patch.descriptionSafetyPromptVersion =
    descriptionUpdate.descriptionSafetyPromptVersion;
  patch.descriptionSafetyRisk = descriptionUpdate.descriptionSafetyRisk;
  patch.descriptionSafetyReason = descriptionUpdate.descriptionSafetyReason;
}

async function buildDescriptionUpdate(
  ctx: ActionCtx,
  attribution: UsageAttribution,
  description: string | undefined,
  current: Pick<
    Doc<"processes">,
    "description" | "descriptionSafetyStatus"
  > | null,
): Promise<DescriptionUpdate> {
  if (description === undefined) return { kind: "unchanged" };

  const normalized = normalizeDescriptionInput(description);
  if (normalized.kind === "empty") return { kind: "clear" };

  if (
    current?.description === normalized.value &&
    current.descriptionSafetyStatus === "safe"
  ) {
    return { kind: "unchanged" };
  }

  const decision = await classifyDescriptionSafety(
    ctx,
    attribution,
    normalized.value,
  );
  return {
    kind: "set",
    ...buildSafeDescriptionFields(normalized.value, decision),
  };
}

export const listByDepartment = query({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const parent = await ctx.db.get(args.departmentId);
    if (!parent || parent.clerkOrgId !== caller.orgId) return [];
    const docs = await ctx.db
      .query("processes")
      .withIndex("by_clerkOrgId_and_departmentId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("departmentId", args.departmentId),
      )
      .order("asc")
      .collect();
    // Order by the maintained `sortOrder` field (stable fallback to the
    // creation order from `.order("asc")` for equal values). See functions.list.
    return docs
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((doc) =>
        toLightweightSummaryListRow(withSummaryV2ReadGate(doc), {
          legacyMarkdown: doc.rollingSummary,
          legacyGeneratedAt: doc.summaryUpdatedAt,
          stale:
            doc.summaryStale === true ||
            Boolean(
              doc.summaryV2 &&
                doc.summaryV2SourceRevision !==
                  (doc.summaryEvidenceRevision ?? 0),
            ),
        }),
      );
  },
});

// All processes in the caller's org, each enriched with its department and
// function name/id. Powers the ⌘K command palette (search source) and the
// per-department process counts in the navigator. Mirrors `departments.listAll`.
export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const caller = await requireOrgMember(ctx);
    const processes = await ctx.db
      .query("processes")
      .withIndex("by_clerkOrgId_and_departmentId", (q) =>
        q.eq("clerkOrgId", caller.orgId),
      )
      .collect();
    const departments = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q.eq("clerkOrgId", caller.orgId),
      )
      .collect();
    const functions = await ctx.db
      .query("functions")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))
      .collect();
    const deptMap = new Map(departments.map((d) => [d._id, d]));
    const fnMap = new Map(functions.map((f) => [f._id, f.name]));
    return processes
      .map((p) => {
        const dept = deptMap.get(p.departmentId);
        const functionId = dept?.functionId ?? null;
        return {
          ...toLightweightSummaryListRow(withSummaryV2ReadGate(p), {
            legacyMarkdown: p.rollingSummary,
            legacyGeneratedAt: p.summaryUpdatedAt,
            stale:
              p.summaryStale === true ||
              Boolean(
                p.summaryV2 &&
                  p.summaryV2SourceRevision !==
                    (p.summaryEvidenceRevision ?? 0),
              ),
          }),
          departmentName: dept?.name ?? "Unknown",
          functionId,
          functionName: functionId
            ? (fnMap.get(functionId) ?? "Unknown")
            : "Unknown",
        };
      })
      .sort(
        (a, b) =>
          a.functionName.localeCompare(b.functionName) ||
          a.departmentName.localeCompare(b.departmentName) ||
          a.sortOrder - b.sortOrder,
      );
  },
});

export const get = query({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const doc = await ctx.db.get(args.processId);
    if (!doc || doc.clerkOrgId !== caller.orgId) return null;
    return doc;
  },
});

export const getWorkbench = query({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const process = await ctx.db.get(args.processId);
    if (!process || process.clerkOrgId !== caller.orgId) return null;

    const department = await ctx.db.get(process.departmentId);
    if (!department || department.clerkOrgId !== caller.orgId) return null;

    const fn = await ctx.db.get(department.functionId);
    if (!fn || fn.clerkOrgId !== caller.orgId) return null;

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("processId", args.processId),
      )
      .order("desc")
      .take(200);
    const flow =
      (await ctx.db
        .query("processFlows")
        .withIndex("by_clerkOrgId_and_processId", (q) =>
          q.eq("clerkOrgId", caller.orgId).eq("processId", args.processId),
        )
        .first()) ?? null;
    let summaryRun = process.summaryV2RunId
      ? await ctx.db.get(process.summaryV2RunId)
      : null;
    if (!summaryRun) {
      const terminalRuns: Doc<"summaryRuns">[] = [];
      for (const state of ["succeeded", "partial", "failed"] as const) {
        const latest = await ctx.db
          .query("summaryRuns")
          .withIndex(
            "by_clerkOrgId_and_entityKey_and_state_and_createdAt",
            (q) =>
              q
                .eq("clerkOrgId", caller.orgId)
                .eq("entityKey", `process:${process._id}`)
                .eq("state", state),
          )
          .order("desc")
          .first();
        if (latest) terminalRuns.push(latest);
      }
      terminalRuns.sort((a, b) => b.createdAt - a.createdAt);
      summaryRun = terminalRuns[0] ?? null;
    }

    const conversationCounts = getConversationCounts(conversations);
    const pendingWorkStatus = derivePendingWorkStatus(conversationCounts);
    const latestConversation = getLatestConversation(conversations);
    const latestDoneConversation = getLatestDoneConversation(conversations);
    // Resolve the contributor's Clerk user id so the client can look up their
    // uploaded avatar via Clerk's org membership data. Only set when the
    // conversation is linked to a Fabric user (agent interviews); free-text
    // contributors on voice/upload flows fall back to initials.
    // The avatar has to depict the person the header names, which on an
    // on-behalf row is the subject rather than the submitting account. When the
    // subject has no account (external interviewee) fall back to initials —
    // showing the submitter's photo beside someone else's name would misattribute.
    const latestContributorAccountId =
      latestConversation?.subjectUserId ??
      (latestConversation?.submittedByName
        ? null
        : latestConversation?.userId) ??
      null;
    const latestContributorUser =
      latestContributorAccountId != null
        ? await ctx.db.get(latestContributorAccountId)
        : null;
    const latestContributorClerkUserId =
      latestContributorUser?.tokenIdentifier.split("|").pop() || null;
    const flowSummary = summarizeFlow(flow, conversationCounts.done);
    const lastUpdatedAt = Math.max(
      process._creationTime,
      latestDoneConversation?._creationTime ?? 0,
      flowSummary?.generatedAt ?? 0,
    );

    return {
      process: {
        _id: process._id,
        _creationTime: process._creationTime,
        departmentId: process.departmentId,
        name: process.name,
        description: process.description ?? null,
        descriptionSafetyStatus: process.descriptionSafetyStatus ?? null,
        rollingSummary: process.rollingSummary ?? null,
        // The structured artifact is deliberately NOT returned here. Every
        // overview surface reads it through `summaries.getOverview`, which
        // applies the `SUMMARY_V2` rollback and per-tenant gates; returning it
        // raw from the workbench query would serve it to a tenant the rollout
        // has not reached and would survive a rollback.
        summaryRun: summaryRun
          ? {
              generationId: summaryRun.generationId,
              state: summaryRun.state,
              progress: summaryRun.progress,
              error: summaryRun.error ?? null,
              coverage: summaryRun.sourceSnapshot,
              createdAt: summaryRun.createdAt,
              completedAt: summaryRun.completedAt ?? null,
            }
          : null,
        // When a summary regeneration is in flight, so the UI can show it is
        // working. A rebuild schedules background work and returns
        // immediately, and on a process whose conversations predate the map
        // step it runs one call per conversation before the summary changes —
        // without this the panel looks idle for minutes. Null once the run
        // releases the gate. Clients must treat a timestamp older than
        // SUMMARY_REGEN_STALE_MS (convex/postCall.ts) as finished: a run that
        // died mid-flight never clears it.
        summaryRegenStartedAt: process.summaryRegenScheduledAt ?? null,
      },
      department: {
        _id: department._id,
        _creationTime: department._creationTime,
        functionId: department.functionId,
        name: department.name,
        description: department.description ?? null,
        descriptionSafetyStatus: department.descriptionSafetyStatus ?? null,
      },
      function: {
        _id: fn._id,
        _creationTime: fn._creationTime,
        name: fn.name,
      },
      pendingWork: {
        status: pendingWorkStatus,
        label: PENDING_WORK_LABELS[pendingWorkStatus],
      },
      conversationCounts,
      latestContributor: latestConversation
        ? {
            conversationId: latestConversation._id,
            name: latestConversation.contributorName,
            at: latestConversation._creationTime,
            inputMode: latestConversation.inputMode ?? "agent",
            clerkUserId: latestContributorClerkUserId,
            // Non-null only when an admin filed this on someone else's behalf,
            // so the header can disclose who actually submitted it.
            submittedByName: latestConversation.submittedByName ?? null,
          }
        : null,
      lastUpdatedAt,
      flow: flowSummary,
    };
  },
});

export const create = action({
  args: {
    departmentId: v.id("departments"),
    name: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"processes">> => {
    const { orgId } = await resolveOrgForAction(ctx);
    const caller = await ctx.runQuery(
      internal.postCall.requireOrgContributorInternal,
      {},
    );
    const parentExists: boolean = await ctx.runQuery(
      internal.processes.departmentExistsInOrg,
      { departmentId: args.departmentId, clerkOrgId: orgId },
    );
    if (!parentExists) throw new Error("Not found");
    const descriptionUpdate = await buildDescriptionUpdate(
      ctx,
      {
        clerkOrgId: orgId,
        // No entityId: the process does not exist yet at safety-check time.
        entityType: "process",
        entityLabel: args.name,
        actorUserId: caller.userId,
      },
      args.description,
      null,
    );
    return await ctx.runMutation(internal.processes.createInternal, {
      departmentId: args.departmentId,
      name: args.name,
      clerkOrgId: orgId,
      descriptionUpdate,
    });
  },
});

export const departmentExistsInOrg = internalQuery({
  args: { departmentId: v.id("departments"), clerkOrgId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const dept = await ctx.db.get(args.departmentId);
    return !!dept && dept.clerkOrgId === args.clerkOrgId;
  },
});

export const createInternal = internalMutation({
  args: {
    departmentId: v.id("departments"),
    name: v.string(),
    clerkOrgId: v.string(),
    descriptionUpdate: descriptionUpdateValidator,
  },
  handler: async (ctx, args): Promise<Id<"processes">> => {
    const parentDepartment = await ctx.db.get(args.departmentId);
    if (!parentDepartment || parentDepartment.clerkOrgId !== args.clerkOrgId) {
      throw new Error("Not found");
    }

    const existing = await ctx.db
      .query("processes")
      .withIndex("by_clerkOrgId_and_departmentId", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("departmentId", args.departmentId),
      )
      .order("desc")
      .take(1);
    const maxSortOrder = existing.length > 0 ? existing[0].sortOrder : 0;
    const row = {
      departmentId: args.departmentId,
      name: args.name,
      sortOrder: maxSortOrder + 1,
      clerkOrgId: args.clerkOrgId,
    };
    const descriptionFields =
      args.descriptionUpdate.kind === "set"
        ? {
            description: args.descriptionUpdate.description,
            descriptionSafetyStatus:
              args.descriptionUpdate.descriptionSafetyStatus,
            descriptionSafetyCheckedAt:
              args.descriptionUpdate.descriptionSafetyCheckedAt,
            descriptionSafetyModel:
              args.descriptionUpdate.descriptionSafetyModel,
            descriptionSafetyPromptVersion:
              args.descriptionUpdate.descriptionSafetyPromptVersion,
            descriptionSafetyRisk: args.descriptionUpdate.descriptionSafetyRisk,
            descriptionSafetyReason:
              args.descriptionUpdate.descriptionSafetyReason,
          }
        : {};
    const id = await ctx.db.insert("processes", {
      ...row,
      ...descriptionFields,
    });
    // Mark department summary as stale (cascades to function)
    await ctx.runMutation(
      internal.summariesHelpers.markDepartmentSummaryStale,
      {
        departmentId: args.departmentId,
      },
    );
    return id;
  },
});

export const update = action({
  args: {
    processId: v.id("processes"),
    name: v.string(),
    departmentId: v.optional(v.id("departments")),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const { orgId } = await resolveOrgForAction(ctx);
    const caller = await ctx.runQuery(
      internal.postCall.requireOrgContributorInternal,
      {},
    );
    const proc: Doc<"processes"> | null = await ctx.runQuery(
      internal.processes.getForDescriptionUpdate,
      { processId: args.processId, clerkOrgId: orgId },
    );
    if (!proc) throw new Error("Not found");

    const descriptionUpdate = await buildDescriptionUpdate(
      ctx,
      {
        clerkOrgId: orgId,
        entityType: "process",
        entityId: args.processId,
        entityLabel: args.name,
        actorUserId: caller.userId,
      },
      args.description,
      proc,
    );

    await ctx.runMutation(internal.processes.updateInternal, {
      processId: args.processId,
      name: args.name,
      departmentId: args.departmentId,
      clerkOrgId: orgId,
      descriptionUpdate,
    });
    return null;
  },
});

export const getForDescriptionUpdate = internalQuery({
  args: { processId: v.id("processes"), clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const proc = await ctx.db.get(args.processId);
    if (!proc || proc.clerkOrgId !== args.clerkOrgId) return null;
    return proc;
  },
});

export const updateInternal = internalMutation({
  args: {
    processId: v.id("processes"),
    name: v.string(),
    departmentId: v.optional(v.id("departments")),
    clerkOrgId: v.string(),
    descriptionUpdate: descriptionUpdateValidator,
  },
  handler: async (ctx, args) => {
    const proc = await ctx.db.get(args.processId);
    if (!proc || proc.clerkOrgId !== args.clerkOrgId) {
      throw new Error("Not found");
    }

    const patch: Record<string, unknown> = { name: args.name };
    const isMoving =
      args.departmentId !== undefined &&
      args.departmentId !== proc.departmentId;

    if (isMoving) {
      const targetDepartment = await ctx.db.get(args.departmentId!);
      if (
        !targetDepartment ||
        targetDepartment.clerkOrgId !== args.clerkOrgId
      ) {
        throw new Error("Not found");
      }
      const existing = await ctx.db
        .query("processes")
        .withIndex("by_clerkOrgId_and_departmentId", (q) =>
          q
            .eq("clerkOrgId", args.clerkOrgId)
            .eq("departmentId", args.departmentId!),
        )
        .order("desc")
        .take(1);
      patch.departmentId = args.departmentId;
      patch.sortOrder = (existing.length > 0 ? existing[0].sortOrder : 0) + 1;
    }

    applyDescriptionUpdate(patch, args.descriptionUpdate);
    await ctx.db.patch(args.processId, patch);

    if (isMoving) {
      const previousDepartment = await ctx.db.get(proc.departmentId);
      // Check if old department still has processes with summaries
      const remaining = await ctx.db
        .query("processes")
        .withIndex("by_clerkOrgId_and_departmentId", (q) =>
          q
            .eq("clerkOrgId", args.clerkOrgId)
            .eq("departmentId", proc.departmentId),
        )
        .collect();
      const hasSummaries = remaining.some((p) => p.rollingSummary);
      if (previousDepartment && (remaining.length === 0 || !hasSummaries)) {
        await ctx.db.patch(proc.departmentId, {
          summary: undefined,
          summaryV2: undefined,
          summaryUpdatedAt: undefined,
          summaryStale: undefined,
          summarySourceRevision:
            (previousDepartment.summarySourceRevision ?? 0) + 1,
          ...(previousDepartment.summaryV2GenerationId
            ? { summaryRegenRequestedAgain: true }
            : {}),
        });
        await ctx.runMutation(
          internal.summariesHelpers.markFunctionSummaryStale,
          { functionId: previousDepartment.functionId },
        );
      } else if (previousDepartment) {
        await ctx.runMutation(
          internal.summariesHelpers.markDepartmentSummaryStale,
          { departmentId: proc.departmentId },
        );
      }
      // Mark new parent department stale
      await ctx.runMutation(
        internal.summariesHelpers.markDepartmentSummaryStale,
        {
          departmentId: args.departmentId!,
        },
      );
    } else if (proc.name !== args.name) {
      await ctx.runMutation(
        internal.summariesHelpers.markDepartmentSummaryStale,
        { departmentId: proc.departmentId },
      );
    }
  },
});

export const childCount = query({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const parent = await ctx.db.get(args.processId);
    assertOrgOwns(caller, parent);
    const children = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("processId", args.processId),
      )
      .take(1000);
    return children.length;
  },
});

export const deleteEligibility = query({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const process = await ctx.db.get(args.processId);
    assertOrgOwns(caller, process);

    if (caller.role === "viewer") {
      return {
        canDelete: false,
        blocker: "role" as const,
        childKind: null,
        canCleanUpChildren: false,
      };
    }

    const children = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("processId", args.processId),
      )
      .take(1);

    if (children.length > 0) {
      return {
        canDelete: false,
        blocker: "children" as const,
        childKind: "conversations" as const,
        canCleanUpChildren: caller.role === "admin",
      };
    }

    return {
      canDelete: true,
      blocker: null,
      childKind: null,
      canCleanUpChildren: false,
    };
  },
});

export const remove = mutation({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const caller = await requireOrgContributor(ctx);
    const process = await ctx.db.get(args.processId);
    assertOrgOwns(caller, process);

    const children = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("processId", args.processId),
      )
      .take(1);
    if (children.length > 0) {
      throw new Error(
        "Cannot delete this process because it still has conversations. Remove all conversations first.",
      );
    }
    const departmentId = process.departmentId;
    await ctx.runMutation(internal.processFlows.deleteForProcess, {
      processId: args.processId,
      clerkOrgId: caller.orgId,
    });
    await ctx.db.delete(args.processId);

    // Clean up department summary
    const department = await ctx.db.get(departmentId);
    const remaining = await ctx.db
      .query("processes")
      .withIndex("by_clerkOrgId_and_departmentId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("departmentId", departmentId),
      )
      .collect();
    const hasSummaries = remaining.some((p) => p.rollingSummary);
    if (department && (remaining.length === 0 || !hasSummaries)) {
      await ctx.db.patch(departmentId, {
        summary: undefined,
        summaryV2: undefined,
        summaryUpdatedAt: undefined,
        summaryStale: undefined,
        summarySourceRevision: (department.summarySourceRevision ?? 0) + 1,
        ...(department.summaryV2GenerationId
          ? { summaryRegenRequestedAgain: true }
          : {}),
      });
      await ctx.runMutation(
        internal.summariesHelpers.markFunctionSummaryStale,
        {
          functionId: department.functionId,
        },
      );
    } else if (department) {
      await ctx.runMutation(
        internal.summariesHelpers.markDepartmentSummaryStale,
        {
          departmentId,
        },
      );
    }
  },
});
