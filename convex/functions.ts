import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireAuth } from "./lib/auth";

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireAuth(ctx);
    return await ctx.db
      .query("functions")
      .order("asc")
      .collect();
  },
});

export const get = query({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    return await ctx.db.get(args.functionId);
  },
});

export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    const existing = await ctx.db.query("functions").order("desc").take(1);
    const maxSortOrder = existing.length > 0 ? existing[0].sortOrder : 0;
    return await ctx.db.insert("functions", {
      name: args.name,
      sortOrder: maxSortOrder + 1,
    });
  },
});

export const update = mutation({
  args: { functionId: v.id("functions"), name: v.string() },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    await ctx.db.patch(args.functionId, { name: args.name });
  },
});

export const remove = mutation({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    // Delete child departments and their processes
    const departments = await ctx.db
      .query("departments")
      .withIndex("by_functionId", (q) => q.eq("functionId", args.functionId))
      .collect();
    for (const dept of departments) {
      const processes = await ctx.db
        .query("processes")
        .withIndex("by_departmentId", (q) => q.eq("departmentId", dept._id))
        .collect();
      for (const proc of processes) {
        await ctx.db.delete(proc._id);
      }
      await ctx.db.delete(dept._id);
    }
    await ctx.db.delete(args.functionId);
  },
});
