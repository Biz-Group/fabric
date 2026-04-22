import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  assertOrgOwns,
  requireOrgContributor,
  requireOrgMember,
} from "./lib/orgAuth";

export const listByDepartment = query({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const parent = await ctx.db.get(args.departmentId);
    if (!parent || parent.clerkOrgId !== caller.orgId) return [];
    return await ctx.db
      .query("processes")
      .withIndex("by_clerkOrgId_and_departmentId", (q) =>
        q
          .eq("clerkOrgId", caller.orgId)
          .eq("departmentId", args.departmentId),
      )
      .order("asc")
      .collect();
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

export const create = mutation({
  args: { departmentId: v.id("departments"), name: v.string() },
  handler: async (ctx, args) => {
    const caller = await requireOrgContributor(ctx);
    const parentDepartment = await ctx.db.get(args.departmentId);
    assertOrgOwns(caller, parentDepartment);

    const existing = await ctx.db
      .query("processes")
      .withIndex("by_clerkOrgId_and_departmentId", (q) =>
        q
          .eq("clerkOrgId", caller.orgId)
          .eq("departmentId", args.departmentId),
      )
      .order("desc")
      .take(1);
    const maxSortOrder = existing.length > 0 ? existing[0].sortOrder : 0;
    const id = await ctx.db.insert("processes", {
      departmentId: args.departmentId,
      name: args.name,
      sortOrder: maxSortOrder + 1,
      clerkOrgId: caller.orgId,
    });
    // Mark department summary as stale (cascades to function)
    await ctx.runMutation(internal.summariesHelpers.markDepartmentSummaryStale, {
      departmentId: args.departmentId,
    });
    return id;
  },
});

export const update = mutation({
  args: {
    processId: v.id("processes"),
    name: v.string(),
    departmentId: v.optional(v.id("departments")),
  },
  handler: async (ctx, args) => {
    const caller = await requireOrgContributor(ctx);
    const proc = await ctx.db.get(args.processId);
    assertOrgOwns(caller, proc);

    const patch: Record<string, unknown> = { name: args.name };
    const isMoving =
      args.departmentId !== undefined &&
      args.departmentId !== proc.departmentId;

    if (isMoving) {
      const targetDepartment = await ctx.db.get(args.departmentId!);
      assertOrgOwns(caller, targetDepartment);
      const existing = await ctx.db
        .query("processes")
        .withIndex("by_clerkOrgId_and_departmentId", (q) =>
          q
            .eq("clerkOrgId", caller.orgId)
            .eq("departmentId", args.departmentId!),
        )
        .order("desc")
        .take(1);
      patch.departmentId = args.departmentId;
      patch.sortOrder = (existing.length > 0 ? existing[0].sortOrder : 0) + 1;
    }

    await ctx.db.patch(args.processId, patch);

    if (isMoving) {
      const previousDepartment = await ctx.db.get(proc.departmentId);
      // Check if old department still has processes with summaries
      const remaining = await ctx.db
        .query("processes")
        .withIndex("by_clerkOrgId_and_departmentId", (q) =>
          q
            .eq("clerkOrgId", caller.orgId)
            .eq("departmentId", proc.departmentId),
        )
        .collect();
      const hasSummaries = remaining.some((p) => p.rollingSummary);
      if (previousDepartment && (remaining.length === 0 || !hasSummaries)) {
        await ctx.db.patch(proc.departmentId, {
          summary: undefined,
          summaryUpdatedAt: undefined,
          summaryStale: undefined,
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
      await ctx.runMutation(internal.summariesHelpers.markDepartmentSummaryStale, {
        departmentId: args.departmentId!,
      });
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
      .collect();
    return children.length;
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
        summaryUpdatedAt: undefined,
        summaryStale: undefined,
      });
      await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
        functionId: department.functionId,
      });
    } else if (department) {
      await ctx.runMutation(internal.summariesHelpers.markDepartmentSummaryStale, {
        departmentId,
      });
    }
  },
});
