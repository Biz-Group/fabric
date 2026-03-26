import { v } from "convex/values";
import { query } from "./_generated/server";
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
