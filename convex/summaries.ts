import { v } from "convex/values";
import {
  action,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  assertOrgOwns,
  requireOrgContributor,
  requireOrgMember,
  resolveOrgForAction,
} from "./lib/orgAuth";
import {
  AITruncationError,
  assertCompletionNotTruncated,
  isAIConfigured,
} from "./lib/aiProvider";
import { meteredCompletion } from "./lib/aiUsageMeter";
import {
  isSummaryV2EnabledForOrg,
  readableSummaryV2,
} from "./lib/summaryV2Feature";
import {
  getSummaryEntityKey,
  readCompatibleSummary,
  renderSummaryV2AsLegacyMarkdown,
  summaryEntityRefValidator,
  type SummaryCompatibilityRead,
  type SummaryEntityRef,
  type SummaryOverviewResponse,
  type SummaryOverviewState,
} from "./summaryV2";
import { requestProcessEvidenceRefreshForOrg } from "./summaryEvidence";
import {
  requestDepartmentSummaryV2ForOrg,
  requestFunctionSummaryV2ForOrg,
} from "./hierarchySummaryV2";

const SUMMARY_PIPELINE_STALE_MS = 10 * 60_000;

type SummaryOwner =
  | { kind: "process"; doc: Doc<"processes"> }
  | { kind: "department"; doc: Doc<"departments"> }
  | { kind: "function"; doc: Doc<"functions"> };

type SummaryRefreshResult = {
  status: "current" | "scheduled" | "coalesced" | "disabled";
  scheduled: boolean;
};

async function getSummaryOwner(
  ctx: Pick<QueryCtx, "db">,
  orgId: string,
  entity: SummaryEntityRef,
): Promise<SummaryOwner> {
  if (entity.kind === "process") {
    const doc = await ctx.db.get(entity.processId);
    assertOrgOwns({ orgId }, doc);
    return { kind: "process", doc };
  }
  if (entity.kind === "department") {
    const doc = await ctx.db.get(entity.departmentId);
    assertOrgOwns({ orgId }, doc);
    return { kind: "department", doc };
  }
  const doc = await ctx.db.get(entity.functionId);
  assertOrgOwns({ orgId }, doc);
  return { kind: "function", doc };
}

function hasLiveTimestamp(value: number | undefined, now: number): boolean {
  return value !== undefined && now - value < SUMMARY_PIPELINE_STALE_MS;
}

function hasActiveSummaryWork(
  owner: SummaryOwner,
  run: Doc<"summaryRuns"> | null,
  now = Date.now(),
): boolean {
  if (run?.state === "queued" || run?.state === "running") return true;
  if (owner.kind === "process") {
    return (
      hasLiveTimestamp(owner.doc.summaryEvidenceRefreshScheduledAt, now) ||
      hasLiveTimestamp(owner.doc.summaryRegenScheduledAt, now)
    );
  }
  return hasLiveTimestamp(owner.doc.summaryRegenScheduledAt, now);
}

function hasCurrentV2Artifact(owner: SummaryOwner): boolean {
  if (!owner.doc.summaryV2) return false;
  if (owner.kind === "process") {
    return (
      owner.doc.summaryV2SourceRevision ===
      (owner.doc.summaryEvidenceRevision ?? 0)
    );
  }
  return (
    owner.doc.summaryStale !== true &&
    owner.doc.summaryV2SourceRevision === (owner.doc.summarySourceRevision ?? 0)
  );
}

function hasStaleArtifact(owner: SummaryOwner): boolean {
  if (owner.kind === "process") {
    return (
      // The flag is authoritative and covers a legacy-only row, whose staleness
      // cannot be derived from the V2 revision pair.
      owner.doc.summaryStale === true ||
      Boolean(
        owner.doc.summaryV2 &&
          owner.doc.summaryV2SourceRevision !==
            (owner.doc.summaryEvidenceRevision ?? 0),
      )
    );
  }
  return (
    owner.doc.summaryStale === true ||
    Boolean(
      owner.doc.summaryV2 &&
        owner.doc.summaryV2SourceRevision !==
          (owner.doc.summarySourceRevision ?? 0),
    )
  );
}

function ownerRunId(owner: SummaryOwner): Id<"summaryRuns"> | undefined {
  return owner.doc.summaryV2RunId;
}

function ownerLastRunState(owner: SummaryOwner) {
  return owner.doc.summaryV2LastRunState;
}

function ownerLastError(owner: SummaryOwner) {
  return owner.doc.summaryV2LastError ?? null;
}

function ownerLegacyMarkdown(owner: SummaryOwner): string | null {
  return owner.kind === "process"
    ? (owner.doc.rollingSummary ?? null)
    : (owner.doc.summary ?? null);
}

/**
 * The Markdown an overview falls back to when the structured artifact is not
 * readable. Publishing writes the projection into the legacy field, so this is
 * normally that stored string; deriving it from a retained artifact keeps a
 * rollback from blanking a row whose legacy field was never written.
 */
function ownerCompatibilityMarkdown(owner: SummaryOwner): string | null {
  const stored = ownerLegacyMarkdown(owner);
  if (stored?.trim()) return stored;
  return owner.doc.summaryV2
    ? renderSummaryV2AsLegacyMarkdown(owner.doc.summaryV2)
    : null;
}

function overviewRefreshKey(owner: SummaryOwner): string {
  if (owner.kind === "process") {
    return [
      owner.doc.summaryEvidenceRevision ?? 0,
      owner.doc.summaryV2SourceRevision ?? "none",
      owner.doc.summaryEvidenceRefreshGenerationId ?? "idle",
      owner.doc.summaryV2GenerationId ?? "idle",
    ].join(":");
  }
  return [
    owner.doc.summarySourceRevision ?? 0,
    owner.doc.summaryV2SourceRevision ?? "none",
    owner.doc.summaryStale === true ? "stale" : "settled",
    owner.doc.summaryV2GenerationId ?? "idle",
  ].join(":");
}

async function getRelevantRun(
  ctx: Pick<QueryCtx, "db">,
  orgId: string,
  entity: SummaryEntityRef,
  runId: Id<"summaryRuns"> | undefined,
): Promise<Doc<"summaryRuns"> | null> {
  const entityKey = getSummaryEntityKey(entity);
  if (runId) {
    const run = await ctx.db.get(runId);
    if (run?.clerkOrgId === orgId && run.entityKey === entityKey) return run;
  }

  const terminalRuns: Doc<"summaryRuns">[] = [];
  for (const state of ["succeeded", "partial", "failed"] as const) {
    const run = await ctx.db
      .query("summaryRuns")
      .withIndex(
        "by_clerkOrgId_and_entityKey_and_state_and_createdAt",
        (q) =>
          q
            .eq("clerkOrgId", orgId)
            .eq("entityKey", entityKey)
            .eq("state", state),
      )
      .order("desc")
      .first();
    if (run) terminalRuns.push(run);
  }
  terminalRuns.sort((a, b) => b.createdAt - a.createdAt);
  return terminalRuns[0] ?? null;
}

function runMatchesCurrentSource(
  owner: SummaryOwner,
  run: Doc<"summaryRuns"> | null,
): boolean {
  if (run?.sourceRevision === undefined) return false;
  const currentRevision =
    owner.kind === "process"
      ? (owner.doc.summaryEvidenceRevision ?? 0)
      : (owner.doc.summarySourceRevision ?? 0);
  return run.sourceRevision === currentRevision;
}

function flowGenerationStatus(flow: Doc<"processFlows"> | null) {
  if (!flow) return "idle" as const;
  return flow.status;
}

function insightsGenerationStatus(flow: Doc<"processFlows"> | null) {
  if (!flow) return "idle" as const;
  if (flow.status === "generating") return "generating" as const;
  if (flow.status === "failed") return "failed" as const;
  if (flow.generationVersion === undefined) return "ready" as const;
  if (flow.detailsStatus === "pending" || flow.detailsStatus === "generating") {
    return "generating" as const;
  }
  if (flow.detailsStatus === "failed") return "failed" as const;
  return "ready" as const;
}

function deriveOverviewState(
  owner: SummaryOwner,
  run: Doc<"summaryRuns"> | null,
  content: SummaryCompatibilityRead,
): SummaryOverviewState {
  if (hasActiveSummaryWork(owner, run)) return "refreshing";
  const lastSuccessfulGenerationAt =
    content.format === "v2"
      ? content.artifact.provenance.generatedAt
      : content.format === "legacy"
        ? (owner.doc.summaryUpdatedAt ?? null)
        : null;
  const failureCompletedAt =
    run?.state === "failed"
      ? (run.completedAt ?? run.createdAt)
      : ownerLastRunState(owner) === "failed"
        ? (owner.doc.summaryV2LastCompletedAt ?? null)
        : null;
  if (
    failureCompletedAt !== null &&
    (lastSuccessfulGenerationAt === null ||
      failureCompletedAt >= lastSuccessfulGenerationAt)
  ) {
    return "failed";
  }
  if (content.format === "none") return "missing";
  if (hasStaleArtifact(owner)) return "stale";
  if (content.format === "v2" && !content.artifact.coverage.complete) {
    return "partial";
  }
  return "current";
}

/**
 * Whether a rebuild has any input the stored overview has not already read.
 *
 * Generation is the expensive step, and the control that spends it used to be
 * live unconditionally: a `current` overview could be rebuilt any number of
 * times, each pass paying full token cost to re-derive the same brief from the
 * same evidence. A rebuild is offered only where it can change the answer —
 * nothing generated yet, evidence recorded since the last pass, a failed run to
 * retry, or a legacy row that has never been built in the structured format.
 */
function overviewRefreshAvailable(
  entityKind: SummaryEntityRef["kind"],
  state: SummaryOverviewState,
  content: SummaryCompatibilityRead,
): boolean {
  // A run already in flight is the rebuild; there is nothing to start.
  if (state === "refreshing") return false;
  if (state === "partial") {
    // Partial coverage means different things at the two levels, and only one
    // of them is unread input.
    //
    // A process excludes conversations whose evidence extraction did not land.
    // Extraction re-runs inside the rebuild, so pressing it can genuinely pull
    // those conversations in — the control stays live.
    //
    // A rollup excludes children that hold no current overview of their own,
    // including a process nobody has recorded a conversation for yet. Rebuilding
    // the parent cannot read those children; only building the child can, and
    // that bumps this row's source revision, which surfaces here as `stale`.
    // Left live, a department with one conversation-less process would offer an
    // endless rollup that returns the same brief every time.
    return entityKind === "process";
  }
  if (state !== "current") return true;
  // A legacy-only row reads as current because nothing has changed under it,
  // but it holds no structured artifact — the rebuild is how it migrates.
  return content.format !== "v2";
}

type OverviewSnapshot = {
  owner: SummaryOwner;
  run: Doc<"summaryRuns"> | null;
  content: SummaryCompatibilityRead;
  state: SummaryOverviewState;
};

/**
 * The one read behind both the overview surface and the rebuild gate, so the
 * disabled control and the refused mutation can never disagree about whether
 * an overview has anything left to build from.
 */
async function readOverviewSnapshot(
  ctx: Pick<QueryCtx, "db">,
  orgId: string,
  entity: SummaryEntityRef,
): Promise<OverviewSnapshot> {
  const owner = await getSummaryOwner(ctx, orgId, entity);
  const run = await getRelevantRun(ctx, orgId, entity, ownerRunId(owner));
  const content = readCompatibleSummary({
    // `readableSummaryV2` is the rollback gate: with `SUMMARY_V2` disabled
    // every surface reads the deterministic Markdown projection instead, and
    // no stored artifact is touched.
    summaryV2: readableSummaryV2(owner.doc.clerkOrgId, owner.doc.summaryV2),
    legacyMarkdown: ownerCompatibilityMarkdown(owner),
  });
  return {
    owner,
    run,
    content,
    state: deriveOverviewState(owner, run, content),
  };
}

async function requestSummaryRefresh(
  ctx: MutationCtx,
  orgId: string,
  actorUserId: Id<"users">,
  entity: SummaryEntityRef,
  forceRefresh: boolean,
): Promise<SummaryRefreshResult> {
  const { owner, run, content, state } = await readOverviewSnapshot(
    ctx,
    orgId,
    entity,
  );
  if (!isSummaryV2EnabledForOrg(orgId)) {
    return { status: "disabled", scheduled: false };
  }

  const active = hasActiveSummaryWork(owner, run);
  if (!forceRefresh && active) {
    return { status: "coalesced", scheduled: false };
  }
  // The same gate the surface disables its control on, enforced where the spend
  // actually starts. `forceRefresh` overrides coalescing, not arithmetic: an
  // overview holding every available source has nothing to rebuild from, and a
  // second pass would bill a full generation for the same brief. An in-flight
  // run is excluded here — it is reported by the coalescing paths instead.
  if (!active && !overviewRefreshAvailable(entity.kind, state, content)) {
    return { status: "current", scheduled: false };
  }
  if (!forceRefresh && hasCurrentV2Artifact(owner)) {
    return { status: "current", scheduled: false };
  }
  if (
    !forceRefresh &&
    run?.state === "failed" &&
    runMatchesCurrentSource(owner, run)
  ) {
    return { status: "coalesced", scheduled: false };
  }

  const result =
    entity.kind === "process"
      ? await requestProcessEvidenceRefreshForOrg(ctx, {
          processId: entity.processId,
          clerkOrgId: orgId,
          forceRefresh,
        })
      : entity.kind === "department"
        ? await requestDepartmentSummaryV2ForOrg(ctx, {
            departmentId: entity.departmentId,
            clerkOrgId: orgId,
            forceRefresh,
            actorUserId,
          })
        : await requestFunctionSummaryV2ForOrg(ctx, {
            functionId: entity.functionId,
            clerkOrgId: orgId,
            forceRefresh,
            actorUserId,
          });
  return {
    status: result.scheduled ? "scheduled" : "coalesced",
    scheduled: result.scheduled,
  };
}

/** One bounded read model for process, department, and function overviews. */
export const getOverview = query({
  args: { entity: summaryEntityRefValidator },
  handler: async (ctx, args): Promise<SummaryOverviewResponse> => {
    const caller = await requireOrgMember(ctx);
    const { owner, run, content, state } = await readOverviewSnapshot(
      ctx,
      caller.orgId,
      args.entity,
    );
    const flow =
      owner.kind === "process"
        ? ((await ctx.db
            .query("processFlows")
            .withIndex("by_clerkOrgId_and_processId", (q) =>
              q
                .eq("clerkOrgId", caller.orgId)
                .eq("processId", owner.doc._id),
            )
            .first()) ?? null)
        : null;
    const hasFlowArtifact = flow !== null && flow.nodes.length > 0;

    return {
      entity: args.entity,
      refreshKey: overviewRefreshKey(owner),
      state,
      refreshAvailable: overviewRefreshAvailable(
        args.entity.kind,
        state,
        content,
      ),
      content,
      coverage: content.format === "v2" ? content.artifact.coverage : null,
      lastSuccessfulGenerationAt:
        content.format === "v2"
          ? content.artifact.provenance.generatedAt
          : content.format === "legacy"
            ? (owner.doc.summaryUpdatedAt ?? null)
            : null,
      progress: run?.progress ?? null,
      error:
        state === "failed" ? (run?.error ?? ownerLastError(owner)) : null,
      flow:
        owner.kind === "process"
          ? {
              available: hasFlowArtifact,
              stale: flow?.stale ?? false,
              generationStatus: flowGenerationStatus(flow),
            }
          : null,
      insights:
        owner.kind === "process"
          ? {
              available: hasFlowArtifact,
              stale: flow?.stale ?? false,
              generationStatus: insightsGenerationStatus(flow),
            }
          : null,
    };
  },
});

/** Non-forcing refresh-on-view entrypoint for every authenticated org member. */
export const ensureCurrent = mutation({
  args: { entity: summaryEntityRefValidator },
  handler: async (ctx, args): Promise<SummaryRefreshResult> => {
    const caller = await requireOrgMember(ctx);
    return await requestSummaryRefresh(
      ctx,
      caller.orgId,
      caller.userId,
      args.entity,
      false,
    );
  },
});

/** Explicit regeneration entrypoint; authorization stays contributor-only. */
export const forceRefresh = mutation({
  args: { entity: summaryEntityRefValidator },
  handler: async (ctx, args): Promise<SummaryRefreshResult> => {
    const caller = await requireOrgContributor(ctx);
    return await requestSummaryRefresh(
      ctx,
      caller.orgId,
      caller.userId,
      args.entity,
      true,
    );
  },
});

// --- Shared Prompt Constants ---

// Rollup summaries are bounded markdown briefs, but their input grows with the
// org, so the output can too. Truncated output is never saved — see the
// AITruncationError branches below.
const ROLLUP_SUMMARY_MAX_TOKENS = 8192;

const DEPARTMENT_SUMMARY_SYSTEM_PROMPT = `You are an analyst synthesizing process-level summaries for an organizational department into a structured brief. Your output must use the following markdown format exactly:

## Overview
Executive summary of how this department operates (2-3 sentences).

## Cross-Process Handoffs
How processes feed into each other — inputs, outputs, and dependencies. Cite the source process using [Process name] format — e.g., "Output from [Compensation] feeds into [Bank Transfers] for payment execution."

## Shared Themes
Patterns that appear across multiple processes — common tools, shared bottlenecks, recurring pain points. Cite which processes share each theme.

## Tensions & Gaps
Contradictions between processes or uncovered gaps in the handoff chain. Be specific about which processes conflict and how.

## Notable Details
Unique findings from individual processes worth surfacing at the department level. Cite the source process.

Rules:
- Always cite processes using [Process name] format.
- Write in clear, concise prose within each section.
- If there is only one process, note that a fuller picture will emerge as more processes are documented.
- Output ONLY the markdown sections above, nothing else.`;

const FUNCTION_SUMMARY_SYSTEM_PROMPT = `You are an analyst synthesizing department-level summaries for an organizational function into a structured brief. Your output must use the following markdown format exactly:

## Overview
High-level summary of how this function operates as a whole (2-3 sentences).

## Cross-Department Patterns
How departments relate — shared dependencies, organizational handoffs. Cite the source department using [Dept name] format — e.g., "Both [Payroll] and [Treasury] depend on the same HRIS data feed."

## Strategic Themes
Recurring patterns across departments — common tooling, shared constraints, workforce themes. Cite which departments share each theme.

## Tensions & Gaps
Cross-departmental contradictions or organizational blind spots. Be specific about which departments are affected.

## Notable Details
Department-specific findings worth escalating to the function level. Cite the source department.

Rules:
- Always cite departments using [Dept name] format.
- Write in clear, concise prose within each section.
- If there is only one department, note that a fuller picture will emerge as more departments are documented.
- Output ONLY the markdown sections above, nothing else.`;

// --- Summary Generation Actions ---

export const generateDepartmentSummary = action({
  args: {
    departmentId: v.id("departments"),
    forceRefresh: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ summary: string | null; message: string | null }> => {
    const { orgId } = await resolveOrgForAction(ctx);
    const caller = await ctx.runQuery(
      internal.postCall.requireOrgContributorInternal,
      {},
    );

    const dept: Doc<"departments"> | null = await ctx.runQuery(
      internal.summariesHelpers.getDepartment,
      { departmentId: args.departmentId, clerkOrgId: orgId },
    );
    if (!dept) {
      return { summary: null, message: "Department not found." };
    }

    if (isSummaryV2EnabledForOrg(orgId)) {
      if (
        !args.forceRefresh &&
        dept.summaryV2 &&
        dept.summaryStale !== true &&
        dept.summaryV2SourceRevision === (dept.summarySourceRevision ?? 0)
      ) {
        return {
          summary: renderSummaryV2AsLegacyMarkdown(dept.summaryV2),
          message: null,
        };
      }
      await ctx.runMutation(
        internal.hierarchySummaryV2.requestDepartmentSummaryV2,
        {
          departmentId: dept._id,
          clerkOrgId: orgId,
          forceRefresh: args.forceRefresh,
          actorUserId: caller.userId,
        },
      );
      return { summary: dept.summary ?? null, message: null };
    }

    if (!args.forceRefresh && dept.summary && dept.summaryStale === false) {
      return { summary: dept.summary, message: null };
    }

    const processSummaries: Array<{
      processName: string;
      summary: string;
    }> = await ctx.runQuery(
      internal.summariesHelpers.getProcessSummariesByDepartment,
      { departmentId: args.departmentId, clerkOrgId: orgId },
    );

    if (processSummaries.length === 0) {
      return {
        summary: null,
        message:
          "No process summaries available yet. Record conversations for the processes in this department first.",
      };
    }

    if (!isAIConfigured("synthesis")) {
      return {
        summary: null,
        message: "Summary generation is not configured (missing API key).",
      };
    }

    const summaryBlock = processSummaries
      .map((s) => `[Process: ${s.processName}]\n${s.summary}`)
      .join("\n\n");

    let generated: string | null;
    try {
      const completion = await meteredCompletion(
        ctx,
        {
          clerkOrgId: orgId,
          entityType: "department",
          entityId: args.departmentId,
          entityLabel: dept.name,
          actorUserId: caller.userId,
        },
        {
          capability: "synthesis",
          operation: "department-summary",
          system: DEPARTMENT_SUMMARY_SYSTEM_PROMPT,
          user: `Here are the process summaries for this department:\n\n${summaryBlock}`,
          maxTokens: ROLLUP_SUMMARY_MAX_TOKENS,
        },
      );
      assertCompletionNotTruncated(
        completion,
        "department-summary",
        ROLLUP_SUMMARY_MAX_TOKENS,
      );
      generated = completion.text;
    } catch (error) {
      if (error instanceof AITruncationError) {
        console.error(error.message);
        return {
          summary: null,
          message:
            "This department has too much content to summarize in one pass. Try again, or summarize fewer processes.",
        };
      }
      return {
        summary: null,
        message: "Failed to generate summary. Please try again.",
      };
    }

    if (!generated) {
      return {
        summary: null,
        message: "Failed to generate summary. Please try again.",
      };
    }

    await ctx.runMutation(internal.summariesHelpers.saveDepartmentSummary, {
      departmentId: args.departmentId,
      summary: generated,
    });

    return { summary: generated, message: null };
  },
});

export const generateFunctionSummary = action({
  args: {
    functionId: v.id("functions"),
    forceRefresh: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ summary: string | null; message: string | null }> => {
    const { orgId } = await resolveOrgForAction(ctx);
    const caller = await ctx.runQuery(
      internal.postCall.requireOrgContributorInternal,
      {},
    );

    const func: Doc<"functions"> | null = await ctx.runQuery(
      internal.summariesHelpers.getFunction,
      { functionId: args.functionId, clerkOrgId: orgId },
    );
    if (!func) {
      return { summary: null, message: "Function not found." };
    }

    if (isSummaryV2EnabledForOrg(orgId)) {
      if (
        !args.forceRefresh &&
        func.summaryV2 &&
        func.summaryStale !== true &&
        func.summaryV2SourceRevision === (func.summarySourceRevision ?? 0)
      ) {
        return {
          summary: renderSummaryV2AsLegacyMarkdown(func.summaryV2),
          message: null,
        };
      }
      await ctx.runMutation(internal.hierarchySummaryV2.requestFunctionSummaryV2, {
        functionId: func._id,
        clerkOrgId: orgId,
        forceRefresh: args.forceRefresh,
        actorUserId: caller.userId,
      });
      return { summary: func.summary ?? null, message: null };
    }

    if (!args.forceRefresh && func.summary && func.summaryStale === false) {
      return { summary: func.summary, message: null };
    }

    const deptSummaries: Array<{
      departmentId: Id<"departments">;
      departmentName: string;
      summary: string | null;
    }> = await ctx.runQuery(
      internal.summariesHelpers.getDepartmentSummariesByFunction,
      { functionId: args.functionId, clerkOrgId: orgId },
    );

    if (deptSummaries.length === 0) {
      return {
        summary: null,
        message: "No departments exist under this function yet.",
      };
    }

    // Cascade generation: generate missing department summaries first
    const deptResults: Array<{ departmentName: string; summary: string }> = [];
    for (const dept of deptSummaries) {
      if (dept.summary) {
        deptResults.push({
          departmentName: dept.departmentName,
          summary: dept.summary,
        });
      } else {
        const genResult: {
          summary: string | null;
          message: string | null;
        } = await ctx.runAction(
          internal.summariesHelpers.generateDepartmentSummaryInternal,
          { departmentId: dept.departmentId, clerkOrgId: orgId },
        );
        if (genResult.summary) {
          deptResults.push({
            departmentName: dept.departmentName,
            summary: genResult.summary,
          });
        }
      }
    }

    if (deptResults.length === 0) {
      return {
        summary: null,
        message:
          "No department summaries available yet. Record conversations for the processes first.",
      };
    }

    if (!isAIConfigured("synthesis")) {
      return {
        summary: null,
        message: "Summary generation is not configured (missing API key).",
      };
    }

    const summaryBlock = deptResults
      .map((s) => `[Department: ${s.departmentName}]\n${s.summary}`)
      .join("\n\n");

    let summary: string | null;
    try {
      const completion = await meteredCompletion(
        ctx,
        {
          clerkOrgId: orgId,
          entityType: "function",
          entityId: args.functionId,
          entityLabel: func.name,
          actorUserId: caller.userId,
        },
        {
          capability: "synthesis",
          operation: "function-summary",
          system: FUNCTION_SUMMARY_SYSTEM_PROMPT,
          user: `Here are the department summaries for this function:\n\n${summaryBlock}`,
          maxTokens: ROLLUP_SUMMARY_MAX_TOKENS,
        },
      );
      assertCompletionNotTruncated(
        completion,
        "function-summary",
        ROLLUP_SUMMARY_MAX_TOKENS,
      );
      summary = completion.text;
    } catch (error) {
      if (error instanceof AITruncationError) {
        console.error(error.message);
        return {
          summary: null,
          message:
            "This function has too much content to summarize in one pass. Try again, or summarize fewer departments.",
        };
      }
      return {
        summary: null,
        message: "Failed to generate summary. Please try again.",
      };
    }

    if (!summary) {
      return {
        summary: null,
        message: "Failed to generate summary. Please try again.",
      };
    }

    await ctx.runMutation(internal.summariesHelpers.saveFunctionSummary, {
      functionId: args.functionId,
      summary,
    });

    return { summary, message: null };
  },
});

export const forceRefreshProcessSummary = action({
  args: {
    processId: v.id("processes"),
  },
  handler: async (ctx, args): Promise<{ message: string | null }> => {
    const { orgId } = await resolveOrgForAction(ctx);
    await ctx.runQuery(internal.postCall.requireOrgContributorInternal, {});
    // Through the gate, not straight to the action: a manual rebuild pressed
    // while conversations are still landing should join the in-flight run
    // rather than start a competing one.
    await ctx.runMutation(
      internal.summaryEvidence.requestProcessEvidenceRefresh,
      {
        processId: args.processId,
        clerkOrgId: orgId,
        forceRefresh: true,
      },
    );
    return { message: null };
  },
});
