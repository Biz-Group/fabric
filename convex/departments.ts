import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
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
    return await ctx.db.insert("departments", {
      functionId: args.functionId,
      name: args.name,
      sortOrder: maxSortOrder + 1,
    });
  },
});

export const update = mutation({
  args: { departmentId: v.id("departments"), name: v.string() },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    await ctx.db.patch(args.departmentId, { name: args.name });
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
    await ctx.db.delete(args.departmentId);
  },
});
