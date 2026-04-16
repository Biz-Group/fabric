import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAuth, requireContributor } from "./lib/auth";

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
    await requireContributor(ctx);
    const parentFunction = await ctx.db.get(args.functionId);
    if (!parentFunction) {
      throw new Error("Function not found");
    }
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
    await requireContributor(ctx);
    const dept = await ctx.db.get(args.departmentId);
    if (!dept) throw new Error("Department not found");

    const oldName = dept.name;
    const patch: Record<string, unknown> = { name: args.name };
    const isMoving =
      args.functionId !== undefined && args.functionId !== dept.functionId;

    if (isMoving) {
      const targetFunction = await ctx.db.get(args.functionId!);
      if (!targetFunction) {
        throw new Error("Target function not found");
      }
      const existing = await ctx.db
        .query("departments")
        .withIndex("by_functionId", (q) => q.eq("functionId", args.functionId!))
        .order("desc")
        .take(1);
      patch.functionId = args.functionId;
      patch.sortOrder = (existing.length > 0 ? existing[0].sortOrder : 0) + 1;
    }

    await ctx.db.patch(args.departmentId, patch);

    // Cascade name change to all users referencing the old department name
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
      const oldFunction = await ctx.db.get(dept.functionId);
      if (oldFunction) {
        await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
          functionId: dept.functionId,
        });
      }
      await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
        functionId: args.functionId!,
      });
    }
  },
});

export const childCount = query({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    const children = await ctx.db
      .query("processes")
      .withIndex("by_departmentId", (q) => q.eq("departmentId", args.departmentId))
      .collect();
    return children.length;
  },
});

export const remove = mutation({
  args: { departmentId: v.id("departments") },
  handler: async (ctx, args) => {
    await requireContributor(ctx);
    const children = await ctx.db
      .query("processes")
      .withIndex("by_departmentId", (q) => q.eq("departmentId", args.departmentId))
      .take(1);
    if (children.length > 0) {
      throw new Error(
        "Cannot delete this department because it still has processes. Remove all processes first."
      );
    }
    const dept = await ctx.db.get(args.departmentId);
    const functionId = dept?.functionId;
    await ctx.db.delete(args.departmentId);
    // Mark function summary as stale
    if (functionId) {
      const parentFunction = await ctx.db.get(functionId);
      if (parentFunction) {
        await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
          functionId,
        });
      }
    }
  },
});
