import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireOrgMember } from "./lib/orgAuth";

export const listByProcess = query({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const caller = await requireOrgMember(ctx);
    const parent = await ctx.db.get(args.processId);
    if (!parent || parent.clerkOrgId !== caller.orgId) return [];
    return await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", caller.orgId).eq("processId", args.processId),
      )
      .order("desc")
      .take(200);
  },
});
