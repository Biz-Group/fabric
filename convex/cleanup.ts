import { internalMutation } from "./_generated/server";

// Remove all seed/test conversations (those with elevenlabsConversationId starting with "seed-")
// and reset the rolling summary on any affected processes.
// Run via: npx convex run --component _root cleanup:removeTestData
export const removeTestData = internalMutation({
  args: {},
  handler: async (ctx) => {
    const allConversations = await ctx.db.query("conversations").collect();
    const testConversations = allConversations.filter((c) =>
      c.elevenlabsConversationId.startsWith("seed-"),
    );

    if (testConversations.length === 0) {
      console.log("No test conversations found.");
      return { deleted: 0 };
    }

    // Track affected processes so we can update their rolling summaries
    const affectedProcessIds = new Set<string>();

    for (const conv of testConversations) {
      affectedProcessIds.add(conv.processId);
      await ctx.db.delete(conv._id);
    }

    // For each affected process, check if there are remaining real conversations.
    // If not, clear the rolling summary. If yes, leave it (regenerateProcessSummary
    // can be called separately to recompute).
    for (const processId of affectedProcessIds) {
      const remaining = await ctx.db
        .query("conversations")
        .withIndex("by_processId", (q) =>
          q.eq("processId", processId as any),
        )
        .take(1);

      if (remaining.length === 0) {
        await ctx.db.patch(processId as any, { rollingSummary: undefined });
      }
    }

    console.log(
      `Removed ${testConversations.length} test conversation(s) across ${affectedProcessIds.size} process(es).`,
    );
    return { deleted: testConversations.length };
  },
});
