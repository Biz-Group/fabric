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
  patch.descriptionSafetyCheckedAt = descriptionUpdate.descriptionSafetyCheckedAt;
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
    Doc<"departments">,
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
  return { kind: "set", ...buildSafeDescriptionFields(normalized.value, decision) };
}

export const listByFunction = query({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    // Defense-in-depth: confirm the parent function belongs to this org before
    // returning its children. If it doesn't, return [] rather than throwing —
    // matches the "treat cross-org access as empty" UX.
    const parent = await ctx.db.get(args.functionId);
    if (!parent || parent.clerkOrgId !== caller.orgId) return [];
    const docs = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("functionId", args.functionId),
      )
      .order("asc")
      .collect();
    // Order by the maintained `sortOrder` field (stable fallback to the
    // creation order from `.order("asc")` for equal values). See functions.list.
    return docs.sort((a, b) => a.sortOrder - b.sortOrder);
  },
});

export const get = query({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const doc = await ctx.db.get(args.departmentId);
    if (!doc || doc.clerkOrgId !== caller.orgId) return null;
    return doc;
  },
});

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const caller = await requireOrgMember(ctx);
    // Uses `by_clerkOrgId_and_functionId` with only the first (clerkOrgId)
    // prefix eq — valid because Convex indexes support prefix queries.
    const depts = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q.eq("clerkOrgId", caller.orgId),
      )
      .order("asc")
      .collect();
    const functions = await ctx.db
      .query("functions")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))
      .collect();
    const fnMap = new Map(functions.map((f) => [f._id, f.name]));
    return depts
      .map((d) => ({
        ...d,
        functionName: fnMap.get(d.functionId) ?? "Unknown",
      }))
      // Grouped by function in the picker, so order by function name then the
      // per-function `sortOrder` for a predictable, stable list.
      .sort(
        (a, b) =>
          a.functionName.localeCompare(b.functionName) ||
          a.sortOrder - b.sortOrder,
      );
  },
});

export const create = action({
  args: {
    functionId: v.id("functions"),
    name: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"departments">> => {
    const { orgId } = await resolveOrgForAction(ctx);
    const caller = await ctx.runQuery(
      internal.postCall.requireOrgContributorInternal,
      {},
    );
    const parentExists: boolean = await ctx.runQuery(
      internal.departments.functionExistsInOrg,
      { functionId: args.functionId, clerkOrgId: orgId },
    );
    if (!parentExists) throw new Error("Not found");
    const descriptionUpdate = await buildDescriptionUpdate(
      ctx,
      {
        clerkOrgId: orgId,
        // No entityId: the department does not exist yet at safety-check time.
        entityType: "department",
        entityLabel: args.name,
        actorUserId: caller.userId,
      },
      args.description,
      null,
    );
    return await ctx.runMutation(internal.departments.createInternal, {
      functionId: args.functionId,
      name: args.name,
      clerkOrgId: orgId,
      descriptionUpdate,
    });
  },
});

export const functionExistsInOrg = internalQuery({
  args: { functionId: v.id("functions"), clerkOrgId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const fn = await ctx.db.get(args.functionId);
    return !!fn && fn.clerkOrgId === args.clerkOrgId;
  },
});

export const createInternal = internalMutation({
  args: {
    functionId: v.id("functions"),
    name: v.string(),
    clerkOrgId: v.string(),
    descriptionUpdate: descriptionUpdateValidator,
  },
  handler: async (ctx, args): Promise<Id<"departments">> => {
    const parentFunction = await ctx.db.get(args.functionId);
    if (!parentFunction || parentFunction.clerkOrgId !== args.clerkOrgId) {
      throw new Error("Not found");
    }

    const existing = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("functionId", args.functionId),
      )
      .order("desc")
      .take(1);
    const maxSortOrder = existing.length > 0 ? existing[0].sortOrder : 0;
    const row = {
      functionId: args.functionId,
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
            descriptionSafetyModel: args.descriptionUpdate.descriptionSafetyModel,
            descriptionSafetyPromptVersion:
              args.descriptionUpdate.descriptionSafetyPromptVersion,
            descriptionSafetyRisk: args.descriptionUpdate.descriptionSafetyRisk,
            descriptionSafetyReason:
              args.descriptionUpdate.descriptionSafetyReason,
          }
        : {};
    const id = await ctx.db.insert("departments", {
      ...row,
      ...descriptionFields,
    });
    // Mark function summary as stale
    await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
      functionId: args.functionId,
    });
    return id;
  },
});

export const update = action({
  args: {
    departmentId: v.id("departments"),
    name: v.string(),
    functionId: v.optional(v.id("functions")),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const { orgId } = await resolveOrgForAction(ctx);
    const caller = await ctx.runQuery(
      internal.postCall.requireOrgContributorInternal,
      {},
    );
    const dept: Doc<"departments"> | null = await ctx.runQuery(
      internal.departments.getForDescriptionUpdate,
      { departmentId: args.departmentId, clerkOrgId: orgId },
    );
    if (!dept) throw new Error("Not found");

    const descriptionUpdate = await buildDescriptionUpdate(
      ctx,
      {
        clerkOrgId: orgId,
        entityType: "department",
        entityId: args.departmentId,
        entityLabel: args.name,
        actorUserId: caller.userId,
      },
      args.description,
      dept,
    );

    await ctx.runMutation(internal.departments.updateInternal, {
      departmentId: args.departmentId,
      name: args.name,
      functionId: args.functionId,
      clerkOrgId: orgId,
      descriptionUpdate,
    });
    return null;
  },
});

export const getForDescriptionUpdate = internalQuery({
  args: { departmentId: v.id("departments"), clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const dept = await ctx.db.get(args.departmentId);
    if (!dept || dept.clerkOrgId !== args.clerkOrgId) return null;
    return dept;
  },
});

export const updateInternal = internalMutation({
  args: {
    departmentId: v.id("departments"),
    name: v.string(),
    functionId: v.optional(v.id("functions")),
    clerkOrgId: v.string(),
    descriptionUpdate: descriptionUpdateValidator,
  },
  handler: async (ctx, args) => {
    const dept = await ctx.db.get(args.departmentId);
    if (!dept || dept.clerkOrgId !== args.clerkOrgId) {
      throw new Error("Not found");
    }

    const oldName = dept.name;
    const patch: Record<string, unknown> = { name: args.name };
    const isMoving =
      args.functionId !== undefined && args.functionId !== dept.functionId;

    if (isMoving) {
      const targetFunction = await ctx.db.get(args.functionId!);
      if (!targetFunction || targetFunction.clerkOrgId !== args.clerkOrgId) {
        throw new Error("Not found");
      }
      const existing = await ctx.db
        .query("departments")
        .withIndex("by_clerkOrgId_and_functionId", (q) =>
          q
            .eq("clerkOrgId", args.clerkOrgId)
            .eq("functionId", args.functionId!),
        )
        .order("desc")
        .take(1);
      patch.functionId = args.functionId;
      patch.sortOrder = (existing.length > 0 ? existing[0].sortOrder : 0) + 1;
    }

    applyDescriptionUpdate(patch, args.descriptionUpdate);
    await ctx.db.patch(args.departmentId, patch);

    // Cascade name change to users referencing the old department name.
    // See note on the equivalent cascade in functions.ts::update.
    if (oldName !== args.name) {
      const usersWithOldName = await ctx.db
        .query("users")
        .withIndex("by_department", (q) => q.eq("department", oldName))
        .collect();
      for (const user of usersWithOldName) {
        await ctx.db.patch(user._id, { department: args.name });
      }
    }

    if (isMoving) {
      await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
        functionId: dept.functionId,
      });
      await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
        functionId: args.functionId!,
      });
    }
  },
});

export const childCount = query({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const parent = await ctx.db.get(args.departmentId);
    assertOrgOwns(caller, parent);
    const children = await ctx.db
      .query("processes")
      .withIndex("by_clerkOrgId_and_departmentId", (q) =>
        q
          .eq("clerkOrgId", caller.orgId)
          .eq("departmentId", args.departmentId),
      )
      .take(1000);
    return children.length;
  },
});

export const deleteEligibility = query({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const dept = await ctx.db.get(args.departmentId);
    assertOrgOwns(caller, dept);

    if (caller.role === "viewer") {
      return {
        canDelete: false,
        blocker: "role" as const,
        childKind: null,
        canCleanUpChildren: false,
      };
    }

    const children = await ctx.db
      .query("processes")
      .withIndex("by_clerkOrgId_and_departmentId", (q) =>
        q
          .eq("clerkOrgId", caller.orgId)
          .eq("departmentId", args.departmentId),
      )
      .take(1);

    if (children.length > 0) {
      return {
        canDelete: false,
        blocker: "children" as const,
        childKind: "processes" as const,
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
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    const caller = await requireOrgContributor(ctx);
    const dept = await ctx.db.get(args.departmentId);
    assertOrgOwns(caller, dept);
    const children = await ctx.db
      .query("processes")
      .withIndex("by_clerkOrgId_and_departmentId", (q) =>
        q
          .eq("clerkOrgId", caller.orgId)
          .eq("departmentId", args.departmentId),
      )
      .take(1);
    if (children.length > 0) {
      throw new Error(
        "Cannot delete this department because it still has processes. Remove all processes first.",
      );
    }
    const functionId = dept.functionId;
    await ctx.db.delete(args.departmentId);
    // Mark function summary as stale
    await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
      functionId,
    });
  },
});
