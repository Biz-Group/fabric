import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";

/**
 * Remove all seed/test conversations (those with elevenlabsConversationId
 * starting with "seed-") within a single org, and reset the rolling summary
 * on any affected processes if no real conversations remain.
 *
 * Run via:
 *   npx convex run cleanup:removeTestData '{"clerkOrgId":"org_xxx"}'
 */
export const removeTestData = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const allConversations = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId),
      )
      .collect();
    const testConversations = allConversations.filter((c) =>
      c.elevenlabsConversationId?.startsWith("seed-"),
    );

    if (testConversations.length === 0) {
      console.log(`No test conversations found for org ${args.clerkOrgId}.`);
      return { deleted: 0 };
    }

    const affectedProcessIds = new Set<Id<"processes">>();

    for (const conv of testConversations) {
      affectedProcessIds.add(conv.processId);
      await ctx.db.delete(conv._id);
    }

    // For each affected process, check if any real conversations remain in
    // this org. If not, clear the rolling summary.
    for (const processId of affectedProcessIds) {
      const remaining = await ctx.db
        .query("conversations")
        .withIndex("by_clerkOrgId_and_processId", (q) =>
          q.eq("clerkOrgId", args.clerkOrgId).eq("processId", processId),
        )
        .take(1);

      if (remaining.length === 0) {
        await ctx.db.patch(processId, { rollingSummary: undefined });
      }
    }

    console.log(
      `Removed ${testConversations.length} test conversation(s) across ${affectedProcessIds.size} process(es) in org ${args.clerkOrgId}.`,
    );
    return { deleted: testConversations.length };
  },
});
