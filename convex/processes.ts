import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAuth } from "./lib/auth";

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
    await requireAuth(ctx);
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
  args: { processId: v.id("processes"), name: v.string() },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    await ctx.db.patch(args.processId, { name: args.name });
  },
});

export const remove = mutation({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    // Delete child conversations
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_processId", (q) => q.eq("processId", args.processId))
      .collect();
    for (const conv of conversations) {
      await ctx.db.delete(conv._id);
    }
    const process = await ctx.db.get(args.processId);
    const departmentId = process?.departmentId;
    await ctx.db.delete(args.processId);
    // Mark department summary as stale (cascades to function)
    if (departmentId) {
      await ctx.runMutation(internal.summariesHelpers.markDepartmentSummaryStale, {
        departmentId,
      });
    }
  },
});
