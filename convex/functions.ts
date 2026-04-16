import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireAuth, requireContributor } from "./lib/auth";

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
    await requireContributor(ctx);
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
    await requireContributor(ctx);
    const existing = await ctx.db.get(args.functionId);
    if (!existing) throw new Error("Function not found");
    const oldName = existing.name;
    await ctx.db.patch(args.functionId, { name: args.name });

    // Cascade name change to all users referencing the old function name
    if (oldName !== args.name) {
      const usersWithOldName = await ctx.db
        .query("users")
        .withIndex("by_function", (q) => q.eq("function", oldName))
        .collect();
      for (const user of usersWithOldName) {
        await ctx.db.patch(user._id, { function: args.name });
      }
    }
  },
});

export const childCount = query({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    const children = await ctx.db
      .query("departments")
      .withIndex("by_functionId", (q) => q.eq("functionId", args.functionId))
      .collect();
    return children.length;
  },
});

export const remove = mutation({
  args: { functionId: v.id("functions") },
  handler: async (ctx, args) => {
    await requireContributor(ctx);
    const children = await ctx.db
      .query("departments")
      .withIndex("by_functionId", (q) => q.eq("functionId", args.functionId))
      .take(1);
    if (children.length > 0) {
      throw new Error(
        "Cannot delete this function because it still has departments. Remove all departments first."
      );
    }
    await ctx.db.delete(args.functionId);
  },
});
