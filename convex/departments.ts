import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAuth } from "./lib/auth";

export const listByFunction = query({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    return await ctx.db
      .query("departments")
      .withIndex("by_functionId", (q) => q.eq("functionId", args.functionId))
      .order("asc")
      .collect();
  },
});

export const get = query({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    return await ctx.db.get(args.departmentId);
  },
});

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    await requireAuth(ctx);
    const allDepts = await ctx.db.query("departments").order("asc").collect();
    const allFunctions = await ctx.db.query("functions").order("asc").collect();
    const fnMap = new Map(allFunctions.map((f) => [f._id, f.name]));
    return allDepts.map((d) => ({
      ...d,
      functionName: fnMap.get(d.functionId) ?? "Unknown",
    }));
  },
});

export const create = mutation({
  args: { functionId: v.id("functions"), name: v.string() },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    const existing = await ctx.db
      .query("departments")
      .withIndex("by_functionId", (q) => q.eq("functionId", args.functionId))
      .order("desc")
      .take(1);
    const maxSortOrder = existing.length > 0 ? existing[0].sortOrder : 0;
    const id = await ctx.db.insert("departments", {
      functionId: args.functionId,
      name: args.name,
      sortOrder: maxSortOrder + 1,
    });
    // Mark function summary as stale
    await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
      functionId: args.functionId,
    });
    return id;
  },
});

export const update = mutation({
  args: {
    departmentId: v.id("departments"),
    name: v.string(),
    functionId: v.optional(v.id("functions")),
  },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    const dept = await ctx.db.get(args.departmentId);
    if (!dept) throw new Error("Department not found");

    const patch: Record<string, unknown> = { name: args.name };
    const isMoving = args.functionId && args.functionId !== dept.functionId;

    if (isMoving) {
      const existing = await ctx.db
        .query("departments")
        .withIndex("by_functionId", (q) => q.eq("functionId", args.functionId!))
        .order("desc")
        .take(1);
      patch.functionId = args.functionId;
      patch.sortOrder = (existing.length > 0 ? existing[0].sortOrder : 0) + 1;
    }

    await ctx.db.patch(args.departmentId, patch);

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

export const remove = mutation({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    // Delete child processes
    const processes = await ctx.db
      .query("processes")
      .withIndex("by_departmentId", (q) => q.eq("departmentId", args.departmentId))
      .collect();
    for (const proc of processes) {
      await ctx.db.delete(proc._id);
    }
    const dept = await ctx.db.get(args.departmentId);
    const functionId = dept?.functionId;
    await ctx.db.delete(args.departmentId);
    // Mark function summary as stale
    if (functionId) {
      await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
        functionId,
      });
    }
  },
});
