import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  assertOrgOwns,
  requireOrgContributor,
  requireOrgMember,
} from "./lib/orgAuth";
import { toLightweightSummaryListRow } from "./summaryV2";
import { withSummaryV2ReadGate } from "./lib/summaryV2Feature";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const caller = await requireOrgMember(ctx);
    const docs = await ctx.db
      .query("functions")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))
      .order("asc")
      .collect();
    // Order by the maintained `sortOrder` field. Today it tracks creation
    // order; this makes it authoritative so manual reordering will Just Work.
    // JS sort is stable, so equal sortOrder falls back to the creation order
    // established by `.order("asc")` above.
    return docs
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((doc) =>
        toLightweightSummaryListRow(withSummaryV2ReadGate(doc), {
          legacyMarkdown: doc.summary,
          legacyGeneratedAt: doc.summaryUpdatedAt,
          stale: doc.summaryStale,
        }),
      );
  },
});

export const get = query({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const doc = await ctx.db.get(args.functionId);
    // Do not throw on cross-org — return null so the frontend treats it as
    // a "not found" (e.g., stale selection) without leaking existence.
    if (!doc || doc.clerkOrgId !== caller.orgId) return null;
    const run = doc.summaryV2RunId
      ? await ctx.db.get(doc.summaryV2RunId)
      : null;
    return {
      ...doc,
      summaryRun: run
        ? {
            generationId: run.generationId,
            state: run.state,
            progress: run.progress,
            error: run.error ?? null,
            coverage: run.sourceSnapshot,
            createdAt: run.createdAt,
            completedAt: run.completedAt ?? null,
          }
        : null,
    };
  },
});

export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const caller = await requireOrgContributor(ctx);
    const existing = await ctx.db
      .query("functions")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", caller.orgId))
      .order("desc")
      .take(1);
    const maxSortOrder = existing.length > 0 ? existing[0].sortOrder : 0;
    return await ctx.db.insert("functions", {
      name: args.name,
      sortOrder: maxSortOrder + 1,
      clerkOrgId: caller.orgId,
    });
  },
});

export const update = mutation({
  args: { functionId: v.id("functions"), name: v.string() },
  handler: async (ctx, args) => {
    const caller = await requireOrgContributor(ctx);
    const existing = await ctx.db.get(args.functionId);
    assertOrgOwns(caller, existing);
    const oldName = existing.name;
    await ctx.db.patch(args.functionId, { name: args.name });

    // User profile fields are global and user-managed. A tenant-scoped
    // hierarchy rename must not rewrite them: one user can belong to multiple
    // organizations, and matching a free-form label does not establish that
    // this function is the profile's intended reference.
    if (oldName !== args.name) {
      await ctx.runMutation(
        internal.summariesHelpers.markFunctionSummaryStale,
        { functionId: args.functionId },
      );
    }
  },
});

export const childCount = query({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const parent = await ctx.db.get(args.functionId);
    assertOrgOwns(caller, parent);
    const children = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("functionId", args.functionId),
      )
      .take(1000);
    return children.length;
  },
});

export const deleteEligibility = query({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const target = await ctx.db.get(args.functionId);
    assertOrgOwns(caller, target);

    if (caller.role === "viewer") {
      return {
        canDelete: false,
        blocker: "role" as const,
        childKind: null,
        canCleanUpChildren: false,
      };
    }

    const children = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("functionId", args.functionId),
      )
      .take(1);

    if (children.length > 0) {
      return {
        canDelete: false,
        blocker: "children" as const,
        childKind: "departments" as const,
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
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    const caller = await requireOrgContributor(ctx);
    const target = await ctx.db.get(args.functionId);
    assertOrgOwns(caller, target);
    const children = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("functionId", args.functionId),
      )
      .take(1);
    if (children.length > 0) {
      throw new Error(
        "Cannot delete this function because it still has departments. Remove all departments first.",
      );
    }
    await ctx.scheduler.runAfter(
      0,
      internal.hierarchySummaryV2.deleteRollupRunsForEntity,
      {
        entity: { kind: "function", functionId: args.functionId },
        clerkOrgId: caller.orgId,
      },
    );
    await ctx.db.delete(args.functionId);
  },
});
