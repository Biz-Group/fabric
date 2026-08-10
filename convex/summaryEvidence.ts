import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import {
  AITruncationError,
  assertCompletionNotTruncated,
  isAIConfigured,
} from "./lib/aiProvider";
import { meteredCompletion } from "./lib/aiUsageMeter";
import {
  buildConversationEvidenceV2Request,
  CONVERSATION_EVIDENCE_V2_OPERATION,
  conversationEvidenceSourceKey,
  isConversationEvidenceV2Current,
  normalizeProcessSummaryEvidenceV2,
} from "./lib/conversationEvidenceV2";
import { hashTranscript } from "./lib/transcriptHash";
import { isSummaryV2EnabledForOrg } from "./lib/summaryV2Feature";
import { generateSummaryInputForConversation } from "./postCall";
import {
  conversationEvidenceFailureCodeV2Validator,
  processSummaryEvidenceV2Validator,
  SUMMARY_V2_AI_BUDGETS,
  SUMMARY_V2_PROMPT_VERSIONS,
  type ConversationEvidenceFailureCodeV2,
} from "./summaryV2";

const PREPARATION_PAGE_SIZE = 20;
const EVIDENCE_REFRESH_STALE_MS = 10 * 60_000;
const phaseValidator = v.union(v.literal("evidence"), v.literal("legacy"));
type PreparationPhase = "evidence" | "legacy";

export const getConversationForEvidence = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.clerkOrgId !== args.clerkOrgId) return null;
    return {
      contributorName: conversation.contributorName,
      transcript: conversation.transcript ?? null,
      status: conversation.status,
      processSummaryEvidenceV2: conversation.processSummaryEvidenceV2 ?? null,
      processSummaryEvidenceV2Failure:
        conversation.processSummaryEvidenceV2Failure ?? null,
    };
  },
});

export const saveConversationSummaryEvidenceV2 = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    clerkOrgId: v.string(),
    expectedTranscriptHash: v.string(),
    evidence: processSummaryEvidenceV2Validator,
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.clerkOrgId !== args.clerkOrgId) {
      throw new Error("Conversation not found in this organization");
    }
    if (
      conversation.status !== "done" ||
      hashTranscript(conversation.transcript ?? null) !==
        args.expectedTranscriptHash ||
      args.evidence.transcriptHash !== args.expectedTranscriptHash ||
      args.evidence.promptVersion !==
        SUMMARY_V2_PROMPT_VERSIONS.conversationEvidence
    ) {
      return { saved: false as const };
    }
    await ctx.db.patch(args.conversationId, {
      processSummaryEvidenceV2: args.evidence,
      processSummaryEvidenceV2Failure: undefined,
    });
    return { saved: true as const };
  },
});

export const markConversationEvidenceFailureV2 = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    clerkOrgId: v.string(),
    expectedTranscriptHash: v.string(),
    generationId: v.string(),
    code: conversationEvidenceFailureCodeV2Validator,
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.clerkOrgId !== args.clerkOrgId) {
      throw new Error("Conversation not found in this organization");
    }
    if (
      conversation.status !== "done" ||
      hashTranscript(conversation.transcript ?? null) !== args.expectedTranscriptHash
    ) {
      return { saved: false as const };
    }
    await ctx.db.patch(args.conversationId, {
      processSummaryEvidenceV2Failure: {
        transcriptHash: args.expectedTranscriptHash,
        promptVersion: SUMMARY_V2_PROMPT_VERSIONS.conversationEvidence,
        generationId: args.generationId,
        failedAt: Date.now(),
        code: args.code,
      },
    });
    return { saved: true as const };
  },
});

function failureCode(error: unknown): ConversationEvidenceFailureCodeV2 {
  if (error instanceof AITruncationError) return "truncated";
  if (
    error instanceof Error &&
    error.message === "Invalid conversation evidence tool output"
  ) {
    return "invalid_output";
  }
  return "generation_failed";
}

export async function generateEvidenceForConversation(
  ctx: ActionCtx,
  conversationId: Id<"conversations">,
  clerkOrgId: string,
  generationId: string,
): Promise<"cached" | "saved" | "stale" | "failed" | "skipped"> {
  const conversation: Awaited<
    ReturnType<typeof ctx.runQuery<typeof internal.summaryEvidence.getConversationForEvidence>>
  > = await ctx.runQuery(internal.summaryEvidence.getConversationForEvidence, {
    conversationId,
    clerkOrgId,
  });
  if (!conversation || conversation.status !== "done") return "skipped";

  const transcriptHash = hashTranscript(conversation.transcript);
  if (
    isConversationEvidenceV2Current(
      conversation.processSummaryEvidenceV2,
      transcriptHash,
    )
  ) {
    return "cached";
  }

  if (!isAIConfigured("synthesis")) {
    await ctx.runMutation(
      internal.summaryEvidence.markConversationEvidenceFailureV2,
      {
        conversationId,
        clerkOrgId,
        expectedTranscriptHash: transcriptHash,
        generationId,
        code: "not_configured",
      },
    );
    return "failed";
  }

  try {
    const request = buildConversationEvidenceV2Request({
      conversationId,
      contributorName: conversation.contributorName,
      transcript: conversation.transcript,
    });
    const completion = await meteredCompletion(
      ctx,
      {
        clerkOrgId,
        entityType: "conversation",
        entityId: conversationId,
        entityLabel: conversation.contributorName,
        runId: generationId,
      },
      request,
    );
    assertCompletionNotTruncated(
      completion,
      CONVERSATION_EVIDENCE_V2_OPERATION,
      SUMMARY_V2_AI_BUDGETS.conversationEvidence.maxTokens,
    );
    const evidence = normalizeProcessSummaryEvidenceV2(
      completion.toolInput,
      conversationEvidenceSourceKey(conversationId),
      {
        transcriptHash,
        promptVersion: SUMMARY_V2_PROMPT_VERSIONS.conversationEvidence,
        generatedAt: Date.now(),
        provider: completion.provider,
        model: completion.model,
      },
    );
    if (!evidence) throw new Error("Invalid conversation evidence tool output");

    const saved: { saved: boolean } = await ctx.runMutation(
      internal.summaryEvidence.saveConversationSummaryEvidenceV2,
      {
        conversationId,
        clerkOrgId,
        expectedTranscriptHash: transcriptHash,
        evidence,
      },
    );
    return saved.saved ? "saved" : "stale";
  } catch (error) {
    await ctx.runMutation(
      internal.summaryEvidence.markConversationEvidenceFailureV2,
      {
        conversationId,
        clerkOrgId,
        expectedTranscriptHash: transcriptHash,
        generationId,
        code: failureCode(error),
      },
    );
    throw error;
  }
}

export const generateConversationSummaryEvidenceV2 = internalAction({
  args: {
    conversationId: v.id("conversations"),
    clerkOrgId: v.string(),
    generationId: v.string(),
  },
  handler: async (ctx, args) =>
    await generateEvidenceForConversation(
      ctx,
      args.conversationId,
      args.clerkOrgId,
      args.generationId,
    ),
});

export const getProcessPreparationPage = internalQuery({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    generationId: v.string(),
    phase: phaseValidator,
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const process = await ctx.db.get(args.processId);
    if (
      !process ||
      process.clerkOrgId !== args.clerkOrgId ||
      process.summaryEvidenceRefreshGenerationId !== args.generationId
    ) {
      return {
        owned: false as const,
        candidateIds: [] as Id<"conversations">[],
        continueCursor: "",
        isDone: true,
      };
    }

    const page = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId_and_status", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("processId", args.processId)
          .eq("status", "done"),
      )
      .order("asc")
      .paginate({ numItems: PREPARATION_PAGE_SIZE, cursor: args.cursor });

    const candidateIds = page.page
      .filter((conversation) => {
        const transcriptHash = hashTranscript(conversation.transcript ?? null);
        if (args.phase === "legacy") {
          return (
            !conversation.processSummaryInput ||
            conversation.processSummaryInputHash !== transcriptHash
          );
        }
        if (
          isConversationEvidenceV2Current(
            conversation.processSummaryEvidenceV2,
            transcriptHash,
          )
        ) {
          return false;
        }
        const failure = conversation.processSummaryEvidenceV2Failure;
        return !(
          failure?.generationId === args.generationId &&
          failure.transcriptHash === transcriptHash &&
          failure.promptVersion ===
            SUMMARY_V2_PROMPT_VERSIONS.conversationEvidence
        );
      })
      .map((conversation) => conversation._id);

    return {
      owned: true as const,
      candidateIds,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export async function requestProcessEvidenceRefreshForOrg(
  ctx: MutationCtx,
  args: {
    processId: Id<"processes">;
    clerkOrgId: string;
    forceRefresh?: boolean;
  },
) {
    const process = await ctx.db.get(args.processId);
    if (!process || process.clerkOrgId !== args.clerkOrgId) {
      throw new Error("Process not found in this organization");
    }

    const now = Date.now();
    const inFlight =
      process.summaryEvidenceRefreshScheduledAt !== undefined &&
      now - process.summaryEvidenceRefreshScheduledAt <
        EVIDENCE_REFRESH_STALE_MS &&
      process.summaryEvidenceRefreshGenerationId !== undefined;
    if (inFlight) {
      await ctx.db.patch(args.processId, {
        summaryEvidenceRefreshRequestedAgain: true,
        // Two or more completions landed before reduction. A full rebuild is
        // required because the legacy incremental reducer can ingest only one
        // latest conversation per pass.
        summaryEvidenceForceRefreshRequested: true,
        summaryEvidenceRevision:
          (process.summaryEvidenceRevision ?? 0) + 1,
      });
      return {
        scheduled: false as const,
        generationId: process.summaryEvidenceRefreshGenerationId!,
      };
    }

    const generationId = crypto.randomUUID();
    await ctx.db.patch(args.processId, {
      summaryEvidenceRefreshScheduledAt: now,
      summaryEvidenceRefreshRequestedAgain: false,
      summaryEvidenceForceRefreshRequested: Boolean(args.forceRefresh),
      summaryEvidenceRefreshGenerationId: generationId,
      summaryEvidenceRevision: (process.summaryEvidenceRevision ?? 0) + 1,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.summaryEvidence.prepareProcessEvidenceRefresh,
      {
        processId: args.processId,
        clerkOrgId: args.clerkOrgId,
        generationId,
        phase: "evidence",
        cursor: null,
      },
    );
    return { scheduled: true as const, generationId };
}

export const requestProcessEvidenceRefresh = internalMutation({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    forceRefresh: v.optional(v.boolean()),
  },
  handler: requestProcessEvidenceRefreshForOrg,
});

/**
 * Records that a process's evidence changed, and spends nothing on it.
 *
 * Every generation is a human action now. A completed conversation, an edited
 * transcript, or a deleted conversation only advances the evidence revision and
 * raises the stale flag, so the overview keeps showing its last good content
 * with a Rebuild control instead of paying for extraction and reduction that
 * nobody asked for. Short test recordings were reliably triggering a full
 * refresh — evidence extraction, the compatibility map, and a reduce — for a few
 * seconds of audio with nothing in it.
 */
export const markProcessSummaryStale = internalMutation({
  args: { processId: v.id("processes"), clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const process = await ctx.db.get(args.processId);
    if (!process || process.clerkOrgId !== args.clerkOrgId) return;
    await ctx.db.patch(args.processId, {
      summaryStale: true,
      summaryEvidenceRevision: (process.summaryEvidenceRevision ?? 0) + 1,
    });
  },
});

export const touchProcessEvidenceRefresh = internalMutation({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    generationId: v.string(),
  },
  handler: async (ctx, args) => {
    const process = await ctx.db.get(args.processId);
    if (
      process?.clerkOrgId !== args.clerkOrgId ||
      process.summaryEvidenceRefreshGenerationId !== args.generationId
    ) {
      return false;
    }
    await ctx.db.patch(args.processId, {
      summaryEvidenceRefreshScheduledAt: Date.now(),
    });
    return true;
  },
});

export const prepareProcessEvidenceRefresh = internalAction({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    generationId: v.string(),
    phase: phaseValidator,
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<void> => {
    const page: {
      owned: boolean;
      candidateIds: Id<"conversations">[];
      continueCursor: string;
      isDone: boolean;
    } = await ctx.runQuery(
      internal.summaryEvidence.getProcessPreparationPage,
      args,
    );
    if (!page.owned) return;

    const [next, ...rest] = page.candidateIds;
    if (next) {
      await ctx.scheduler.runAfter(
        0,
        internal.summaryEvidence.prepareConversationArtifacts,
        {
          ...args,
          conversationId: next,
          remainingIds: rest,
          continueCursor: page.continueCursor,
          pageIsDone: page.isDone,
        },
      );
      return;
    }
    await scheduleAfterPage(ctx, args, page.continueCursor, page.isDone);
  },
});

async function scheduleAfterPage(
  ctx: ActionCtx,
  args: {
    processId: Id<"processes">;
    clerkOrgId: string;
    generationId: string;
    phase: PreparationPhase;
  },
  continueCursor: string,
  pageIsDone: boolean,
): Promise<void> {
  if (!pageIsDone) {
    await ctx.scheduler.runAfter(
      0,
      internal.summaryEvidence.prepareProcessEvidenceRefresh,
      { ...args, cursor: continueCursor },
    );
    return;
  }
  if (args.phase === "evidence") {
    if (isSummaryV2EnabledForOrg(args.clerkOrgId)) {
      await ctx.runMutation(
        internal.summaryEvidence.finishProcessEvidenceRefresh,
        {
          processId: args.processId,
          clerkOrgId: args.clerkOrgId,
          generationId: args.generationId,
        },
      );
      return;
    }
    await ctx.scheduler.runAfter(
      0,
      internal.summaryEvidence.prepareProcessEvidenceRefresh,
      { ...args, phase: "legacy", cursor: null },
    );
    return;
  }
  await ctx.runMutation(internal.summaryEvidence.finishProcessEvidenceRefresh, {
    processId: args.processId,
    clerkOrgId: args.clerkOrgId,
    generationId: args.generationId,
  });
}

export const prepareConversationArtifacts = internalAction({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    generationId: v.string(),
    phase: phaseValidator,
    cursor: v.union(v.string(), v.null()),
    conversationId: v.id("conversations"),
    remainingIds: v.array(v.id("conversations")),
    continueCursor: v.string(),
    pageIsDone: v.boolean(),
  },
  handler: async (ctx, args): Promise<void> => {
    const owned: boolean = await ctx.runMutation(
      internal.summaryEvidence.touchProcessEvidenceRefresh,
      {
        processId: args.processId,
        clerkOrgId: args.clerkOrgId,
        generationId: args.generationId,
      },
    );
    if (!owned) return;

    try {
      if (args.phase === "evidence") {
        await generateEvidenceForConversation(
          ctx,
          args.conversationId,
          args.clerkOrgId,
          args.generationId,
        );
      } else if (isAIConfigured("synthesis")) {
        await generateSummaryInputForConversation(
          ctx,
          args.conversationId,
          args.clerkOrgId,
          args.generationId,
        );
      }
    } catch (error) {
      console.error("Conversation preparation step failed; continuing", {
        phase: args.phase,
        conversationId: args.conversationId,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }

    const [next, ...rest] = args.remainingIds;
    if (next) {
      await ctx.scheduler.runAfter(
        0,
        internal.summaryEvidence.prepareConversationArtifacts,
        { ...args, conversationId: next, remainingIds: rest },
      );
      return;
    }
    await scheduleAfterPage(
      ctx,
      args,
      args.continueCursor,
      args.pageIsDone,
    );
  },
});

export const finishProcessEvidenceRefresh = internalMutation({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    generationId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const process = await ctx.db.get(args.processId);
    if (
      !process ||
      process.clerkOrgId !== args.clerkOrgId ||
      process.summaryEvidenceRefreshGenerationId !== args.generationId
    ) {
      return;
    }

    if (process.summaryEvidenceRefreshRequestedAgain) {
      await ctx.db.patch(args.processId, {
        summaryEvidenceRefreshScheduledAt: Date.now(),
        summaryEvidenceRefreshRequestedAgain: false,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.summaryEvidence.prepareProcessEvidenceRefresh,
        {
          processId: args.processId,
          clerkOrgId: args.clerkOrgId,
          generationId: args.generationId,
          phase: "evidence",
          cursor: null,
        },
      );
      return;
    }

    const forceRefresh = Boolean(process.summaryEvidenceForceRefreshRequested);
    await ctx.db.patch(args.processId, {
      summaryEvidenceRefreshScheduledAt: undefined,
      summaryEvidenceRefreshRequestedAgain: undefined,
      summaryEvidenceForceRefreshRequested: undefined,
      summaryEvidenceRefreshGenerationId: undefined,
    });
    if (isSummaryV2EnabledForOrg(args.clerkOrgId)) {
      await ctx.runMutation(
        internal.processSummaryV2.requestProcessSummaryV2,
        {
          processId: args.processId,
          clerkOrgId: args.clerkOrgId,
        },
      );
    } else {
      await ctx.runMutation(internal.postCall.requestProcessSummaryRegen, {
        processId: args.processId,
        clerkOrgId: args.clerkOrgId,
        forceRefresh,
      });
    }
  },
});
