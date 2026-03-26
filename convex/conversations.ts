import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireAuth } from "./lib/auth";

export const listByProcess = query({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    return await ctx.db
      .query("conversations")
      .withIndex("by_processId", (q) => q.eq("processId", args.processId))
      .order("desc")
      .collect();
  },
});
