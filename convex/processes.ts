import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAuth, requireContributor } from "./lib/auth";

export const listByDepartment = query({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    return await ctx.db
      .query("processes")
      .withIndex("by_departmentId", (q) =>
        q.eq("departmentId", args.departmentId)
      )
      .order("asc")
      .collect();
  },
});

export const get = query({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    return await ctx.db.get(args.processId);
  },
});

export const create = mutation({
  args: { departmentId: v.id("departments"), name: v.string() },
  handler: async (ctx, args) => {
    await requireContributor(ctx);
    const parentDepartment = await ctx.db.get(args.departmentId);
    if (!parentDepartment) {
      throw new Error("Department not found");
    }
    const existing = await ctx.db
      .query("processes")
      .withIndex("by_departmentId", (q) => q.eq("departmentId", args.departmentId))
      .order("desc")
      .take(1);
    const maxSortOrder = existing.length > 0 ? existing[0].sortOrder : 0;
    const id = await ctx.db.insert("processes", {
      departmentId: args.departmentId,
      name: args.name,
      sortOrder: maxSortOrder + 1,
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
    await requireContributor(ctx);
    const proc = await ctx.db.get(args.processId);
    if (!proc) throw new Error("Process not found");

    const patch: Record<string, unknown> = { name: args.name };
    const isMoving =
      args.departmentId !== undefined &&
      args.departmentId !== proc.departmentId;

    if (isMoving) {
      const targetDepartment = await ctx.db.get(args.departmentId!);
      if (!targetDepartment) {
        throw new Error("Target department not found");
      }
      const existing = await ctx.db
        .query("processes")
        .withIndex("by_departmentId", (q) => q.eq("departmentId", args.departmentId!))
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
        .withIndex("by_departmentId", (q) => q.eq("departmentId", proc.departmentId))
        .collect();
      const hasSummaries = remaining.some((p) => p.rollingSummary);
      if (previousDepartment && (remaining.length === 0 || !hasSummaries)) {
        // No processes or none with summaries — clear the department summary
        await ctx.db.patch(proc.departmentId, {
          summary: undefined,
          summaryUpdatedAt: undefined,
          summaryStale: undefined,
        });
        if (previousDepartment) {
          await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
            functionId: previousDepartment.functionId,
          });
        }
      } else if (previousDepartment) {
        await ctx.runMutation(internal.summariesHelpers.markDepartmentSummaryStale, {
          departmentId: proc.departmentId,
        });
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
    await requireAuth(ctx);
    const children = await ctx.db
      .query("conversations")
      .withIndex("by_processId", (q) => q.eq("processId", args.processId))
      .collect();
    return children.length;
  },
});

export const remove = mutation({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    await requireContributor(ctx);
    const children = await ctx.db
      .query("conversations")
      .withIndex("by_processId", (q) => q.eq("processId", args.processId))
      .take(1);
    if (children.length > 0) {
      throw new Error(
        "Cannot delete this process because it still has conversations. Remove all conversations first."
      );
    }
    const process = await ctx.db.get(args.processId);
    const departmentId = process?.departmentId;
    await ctx.db.delete(args.processId);
    // Clean up department summary
    if (departmentId) {
      const department = await ctx.db.get(departmentId);
      const remaining = await ctx.db
        .query("processes")
        .withIndex("by_departmentId", (q) => q.eq("departmentId", departmentId))
        .collect();
      const hasSummaries = remaining.some((p) => p.rollingSummary);
      if (department && (remaining.length === 0 || !hasSummaries)) {
        await ctx.db.patch(departmentId, {
          summary: undefined,
          summaryUpdatedAt: undefined,
          summaryStale: undefined,
        });
        if (department) {
          await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
            functionId: department.functionId,
          });
        }
      } else if (department) {
        await ctx.runMutation(internal.summariesHelpers.markDepartmentSummaryStale, {
          departmentId,
        });
      }
    }
  },
});
