import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Fans a finished conversation out to the two pipelines that consume it.
 *
 * The two are deliberately independent. They read different things — the
 * overview extracts evidence from transcripts, the flow builds a graph from each
 * conversation's structured extraction — and they fail in different ways, so
 * neither is allowed to gate, delay, or break the other. Each is dispatched
 * inside its own try/catch: a summary pipeline that cannot start must still
 * leave the process flow generating, and vice versa.
 *
 * Both entry points coalesce internally, so several conversations finishing at
 * once produce one run of each rather than one of each per conversation.
 *
 * Throwing is not an option here: every caller has already committed the
 * conversation as `done`, and failing after that point would report a recording
 * as failed when the transcript is safely stored. The dispatch failures are
 * logged and swallowed; the flow watchdog cron and the overview's Rebuild
 * control are the recovery paths.
 */
export async function startConversationPipelines(
  ctx: ActionCtx,
  processId: Id<"processes">,
  clerkOrgId: string,
): Promise<void> {
  try {
    await ctx.runMutation(
      internal.summaryEvidence.requestProcessSummaryRebuild,
      { processId, clerkOrgId },
    );
  } catch (error) {
    console.error("Could not start the summary rebuild for a conversation", {
      processId,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }

  try {
    await ctx.runMutation(internal.processFlows.requestFlowGeneration, {
      processId,
      clerkOrgId,
    });
  } catch (error) {
    console.error("Could not start flow generation for a conversation", {
      processId,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }
}
