import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
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
  buildProcessOverviewChunkRequest,
  buildProcessOverviewFinalRequest,
  chunkOutputForFinalPrompt,
  finishSnapshotHash,
  initialSnapshotHashState,
  PROCESS_OVERVIEW_V2_CHUNK_OPERATION,
  PROCESS_OVERVIEW_V2_FINAL_OPERATION,
  processArtifactToChunkOutput,
  type ProcessEvidencePromptSource,
  updateSnapshotHashState,
} from "./lib/processOverviewV2";
import { hashTranscript } from "./lib/transcriptHash";
import {
  isConversationEvidenceV2Current,
} from "./lib/conversationEvidenceV2";
import { isSummaryV2EnabledForOrg } from "./lib/summaryV2Feature";
import {
  normalizeProcessOverviewArtifactV2,
  processOverviewArtifactV2Validator,
  renderSummaryV2AsLegacyMarkdown,
  summaryChunkOutputV2Validator,
  SUMMARY_V2_AI_BUDGETS,
  SUMMARY_V2_CAPS,
  SUMMARY_V2_PROMPT_VERSIONS,
  type ProcessSummarySourceInput,
  type SummaryChunkOutputV2,
  type SummaryCoverage,
  type SummaryRunError,
  type SummarySourceKeyMap,
} from "./summaryV2";

const SOURCE_SCAN_PAGE_SIZE = 20;
const RUN_STALE_MS = 10 * 60_000;
const MAX_RUN_ATTEMPTS = 2;
const MAX_RUN_RESUMES = 2;
const CLEANUP_BATCH_SIZE = 20;
const TERMINAL_STATES = ["succeeded", "partial", "failed"] as const;

type RunFailureCode =
  | "feature_disabled"
  | "not_configured"
  | "no_evidence_sources"
  | "no_current_evidence"
  | "invalid_output"
  | "truncated"
  | "generation_failed"
  | "source_changed"
  | "superseded"
  | "watchdog_exhausted";

function errorFor(
  code: RunFailureCode,
  message: string,
  retryable: boolean,
): SummaryRunError {
  return { code, message: message.slice(0, 500), retryable };
}

function actionFailure(error: unknown): {
  code: RunFailureCode;
  message: string;
  retryable: boolean;
} {
  if (error instanceof AITruncationError) {
    return {
      code: "truncated",
      message: "The model reached its output limit before completing the overview.",
      retryable: true,
    };
  }
  if (error instanceof Error && error.message === "not_configured") {
    return {
      code: "not_configured",
      message: "AI synthesis is not configured for this deployment.",
      retryable: false,
    };
  }
  if (error instanceof Error && error.message === "invalid_output") {
    return {
      code: "invalid_output",
      message: "The model returned an invalid process overview payload.",
      retryable: true,
    };
  }
  if (error instanceof Error && error.message === "source_changed") {
    return {
      code: "source_changed",
      message: "Conversation evidence changed during this generation.",
      retryable: false,
    };
  }
  return {
    code: "generation_failed",
    message: error instanceof Error ? error.message : "Generation failed.",
    retryable: true,
  };
}

function processIdFromRun(run: Doc<"summaryRuns">): Id<"processes"> | null {
  return run.entity.kind === "process" ? run.entity.processId : null;
}

async function ownsRun(
  ctx: MutationCtx,
  run: Doc<"summaryRuns">,
): Promise<Doc<"processes"> | null> {
  const processId = processIdFromRun(run);
  if (!processId) return null;
  const process = await ctx.db.get(processId);
  if (
    !process ||
    process.clerkOrgId !== run.clerkOrgId ||
    process.summaryV2GenerationId !== run.generationId ||
    process.summaryV2RunId !== run._id
  ) {
    return null;
  }
  return process;
}

export const requestProcessSummaryV2 = internalMutation({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    if (!isSummaryV2EnabledForOrg(args.clerkOrgId)) {
      throw new Error("SUMMARY_V2 is disabled");
    }
    const process = await ctx.db.get(args.processId);
    if (!process || process.clerkOrgId !== args.clerkOrgId) {
      throw new Error("Process not found in this organization");
    }

    const now = Date.now();
    const inFlight =
      process.summaryRegenScheduledAt !== undefined &&
      now - process.summaryRegenScheduledAt < RUN_STALE_MS &&
      process.summaryV2GenerationId !== undefined;
    if (inFlight) {
      await ctx.db.patch(args.processId, { summaryRegenRequestedAgain: true });
      return {
        scheduled: false as const,
        generationId: process.summaryV2GenerationId!,
      };
    }

    const generationId = crypto.randomUUID();
    await ctx.db.patch(args.processId, {
      summaryRegenScheduledAt: now,
      summaryRegenRequestedAgain: false,
      summaryV2GenerationId: generationId,
      summaryV2RunId: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.processSummaryV2.startProcessRun, {
      processId: args.processId,
      clerkOrgId: args.clerkOrgId,
      generationId,
    });
    return { scheduled: true as const, generationId };
  },
});

export const startProcessRun = internalMutation({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    generationId: v.string(),
  },
  handler: async (ctx, args) => {
    const process = await ctx.db.get(args.processId);
    if (
      !process ||
      process.clerkOrgId !== args.clerkOrgId ||
      process.summaryV2GenerationId !== args.generationId ||
      process.summaryV2RunId !== undefined
    ) {
      return null;
    }
    if (!isSummaryV2EnabledForOrg(process.clerkOrgId)) {
      await ctx.db.patch(process._id, {
        summaryRegenScheduledAt: undefined,
        summaryRegenRequestedAgain: undefined,
        summaryV2GenerationId: undefined,
        summaryV2RunId: undefined,
      });
      return null;
    }
    const now = Date.now();
    const initialHash = initialSnapshotHashState();
    const runId = await ctx.db.insert("summaryRuns", {
      clerkOrgId: args.clerkOrgId,
      entity: { kind: "process", processId: args.processId },
      entityKey: `process:${args.processId}`,
      generationId: args.generationId,
      sourceRevision: process.summaryEvidenceRevision ?? 0,
      sourceSnapshot: { hash: "pending", includedSources: 0, totalEligibleSources: 0 },
      state: "queued",
      progress: { stage: "evidence", completed: 0, total: 1 },
      createdAt: now,
      lastProgressAt: now,
      attempt: 0,
      maxAttempts: MAX_RUN_ATTEMPTS,
      resumeCount: 0,
      sourceScan: {
        eligibleSources: 0,
        includedSources: 0,
        nextOrdinal: 1,
        nextChunkIndex: 0,
        hashFirst: initialHash.first,
        hashSecond: initialHash.second,
        hashLength: initialHash.length,
        pendingSources: [],
      },
    });
    await ctx.db.patch(args.processId, { summaryV2RunId: runId });
    await ctx.scheduler.runAfter(0, internal.processSummaryV2.scanProcessSources, {
      runId,
      generationId: args.generationId,
    });
    return runId;
  },
});

async function insertChunk(
  ctx: MutationCtx,
  run: Doc<"summaryRuns">,
  chunkIndex: number,
  sources: ProcessSummarySourceInput[],
): Promise<void> {
  await ctx.db.insert("summaryChunks", {
    clerkOrgId: run.clerkOrgId,
    summaryRunId: run._id,
    generationId: run.generationId,
    chunkIndex,
    sourceCount: sources.length,
    sourceInputs: sources,
    state: "queued",
    attempt: 0,
    createdAt: Date.now(),
  });
}

export const scanProcessSources = internalMutation({
  args: {
    runId: v.id("summaryRuns"),
    generationId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.generationId !== args.generationId || !run.sourceScan) return;
    const process = await ownsRun(ctx, run);
    if (!process) return;
    const processId = processIdFromRun(run)!;
    const scan = run.sourceScan;
    const page = await ctx.db
      .query("conversations")
      .withIndex("by_clerkOrgId_and_processId_and_status", (q) =>
        q
          .eq("clerkOrgId", run.clerkOrgId)
          .eq("processId", processId)
          .eq("status", "done"),
      )
      .order("asc")
      .paginate({
        numItems: SOURCE_SCAN_PAGE_SIZE,
        cursor: scan.cursor ?? null,
      });

    let hashState = {
      first: scan.hashFirst,
      second: scan.hashSecond,
      length: scan.hashLength,
    };
    let eligibleSources = scan.eligibleSources;
    let includedSources = scan.includedSources;
    let nextOrdinal = scan.nextOrdinal;
    let nextChunkIndex = scan.nextChunkIndex;
    let pendingSources = [...scan.pendingSources];

    for (const conversation of page.page) {
      const transcriptHash = hashTranscript(conversation.transcript ?? null);
      const evidence = conversation.processSummaryEvidenceV2;
      const promptVersion =
        evidence?.promptVersion ??
        `missing:${SUMMARY_V2_PROMPT_VERSIONS.conversationEvidence}`;
      hashState = updateSnapshotHashState(hashState, {
        conversationId: conversation._id,
        transcriptHash,
        promptVersion,
      });
      eligibleSources += 1;

      if (isConversationEvidenceV2Current(evidence, transcriptHash)) {
        pendingSources.push({
          key: `C${nextOrdinal}`,
          conversationId: conversation._id,
          label: conversation.contributorName,
          transcriptHash,
          promptVersion,
        });
        includedSources += 1;
        nextOrdinal += 1;
      }
    }

    if (pendingSources.length >= SUMMARY_V2_CAPS.reduceChunkSources) {
      await insertChunk(
        ctx,
        run,
        nextChunkIndex,
        pendingSources.slice(0, SUMMARY_V2_CAPS.reduceChunkSources),
      );
      nextChunkIndex += 1;
      pendingSources = pendingSources.slice(SUMMARY_V2_CAPS.reduceChunkSources);
    }

    if (!page.isDone) {
      await ctx.db.patch(run._id, {
        state: "running",
        progress: {
          stage: "evidence",
          completed: eligibleSources,
          total: eligibleSources + 1,
        },
        lastProgressAt: Date.now(),
        sourceScan: {
          cursor: page.continueCursor,
          eligibleSources,
          includedSources,
          nextOrdinal,
          nextChunkIndex,
          hashFirst: hashState.first,
          hashSecond: hashState.second,
          hashLength: hashState.length,
          pendingSources,
        },
      });
      await ctx.scheduler.runAfter(
        0,
        internal.processSummaryV2.scanProcessSources,
        args,
      );
      return;
    }

    if (pendingSources.length > 0) {
      await insertChunk(ctx, run, nextChunkIndex, pendingSources);
      nextChunkIndex += 1;
    }
    const sourceSnapshot = {
      hash: finishSnapshotHash(hashState),
      includedSources,
      totalEligibleSources: eligibleSources,
    };

    if (includedSources === 0) {
      // Two different outcomes used to share one retryable error. Zero eligible
      // sources means no conversation has been completed for this process at
      // all: there was nothing to read, retrying reads nothing again, and the
      // overview is undocumented rather than broken — the read model maps this
      // code back to `missing`. Eligible sources that produced no current
      // evidence is a real failure of extraction, and worth retrying.
      const noSources = eligibleSources === 0;
      await ctx.db.patch(run._id, {
        sourceSnapshot,
        sourceScan: undefined,
        chunkCount: 0,
        state: "failed",
        progress: { stage: "evidence", completed: 0, total: eligibleSources },
        error: noSources
          ? errorFor(
              "no_evidence_sources",
              "No conversation has been completed for this process yet.",
              false,
            )
          : errorFor(
              "no_current_evidence",
              "No current structured conversation evidence is available.",
              true,
            ),
        lastProgressAt: Date.now(),
        completedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.processSummaryV2.finishProcessRun, {
        processId,
        clerkOrgId: run.clerkOrgId,
        generationId: run.generationId,
        runId: run._id,
      });
      return;
    }

    const direct = nextChunkIndex === 1;
    await ctx.db.patch(run._id, {
      sourceSnapshot,
      sourceScan: undefined,
      chunkCount: nextChunkIndex,
      state: "running",
      progress: direct
        ? { stage: "final_reduce", completed: 0, total: 1 }
        : { stage: "chunk_reduce", completed: 0, total: nextChunkIndex },
      startedAt: run.startedAt ?? Date.now(),
      lastProgressAt: Date.now(),
    });
    if (direct) {
      await ctx.scheduler.runAfter(
        0,
        internal.processSummaryV2.generateProcessFinal,
        { runId: run._id, generationId: run.generationId },
      );
    } else {
      await ctx.scheduler.runAfter(
        0,
        internal.processSummaryV2.generateProcessChunk,
        { runId: run._id, generationId: run.generationId, chunkIndex: 0 },
      );
    }
  },
});

export const claimProcessChunk = internalMutation({
  args: {
    runId: v.id("summaryRuns"),
    generationId: v.string(),
    chunkIndex: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.generationId !== args.generationId) return false;
    const process = await ownsRun(ctx, run);
    if (!process) return false;
    if (!isSummaryV2EnabledForOrg(process.clerkOrgId)) {
      await ctx.db.patch(run._id, {
        state: "failed",
        error: errorFor(
          "feature_disabled",
          "Summary V2 was disabled before this run completed.",
          false,
        ),
        completedAt: Date.now(),
        lastProgressAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.processSummaryV2.finishProcessRun, {
        processId: process._id,
        clerkOrgId: run.clerkOrgId,
        generationId: run.generationId,
        runId: run._id,
      });
      return false;
    }
    if (
      process.summaryRegenRequestedAgain ||
      (process.summaryEvidenceRevision ?? 0) !== (run.sourceRevision ?? 0)
    ) {
      await ctx.db.patch(run._id, {
        state: "failed",
        error: errorFor("superseded", "Newer evidence superseded this run.", false),
        completedAt: Date.now(),
        lastProgressAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.processSummaryV2.finishProcessRun, {
        processId: process._id,
        clerkOrgId: run.clerkOrgId,
        generationId: run.generationId,
        runId: run._id,
      });
      return false;
    }
    const chunk = await ctx.db
      .query("summaryChunks")
      .withIndex("by_clerkOrgId_and_summaryRunId_and_chunkIndex", (q) =>
        q
          .eq("clerkOrgId", run.clerkOrgId)
          .eq("summaryRunId", run._id)
          .eq("chunkIndex", args.chunkIndex),
      )
      .unique();
    if (
      !chunk ||
      (chunk.state !== "queued" && chunk.state !== "failed") ||
      chunk.attempt >= run.maxAttempts
    ) {
      return false;
    }
    const now = Date.now();
    await ctx.db.patch(chunk._id, {
      state: "running",
      attempt: chunk.attempt + 1,
      startedAt: now,
      error: undefined,
    });
    await ctx.db.patch(run._id, {
      state: "running",
      error: undefined,
      lastProgressAt: now,
    });
    await ctx.db.patch(process._id, { summaryRegenScheduledAt: now });
    return true;
  },
});

export const getProcessChunkInput = internalQuery({
  args: {
    runId: v.id("summaryRuns"),
    generationId: v.string(),
    chunkIndex: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.generationId !== args.generationId) return null;
    const processId = processIdFromRun(run);
    if (!processId) return null;
    const process = await ctx.db.get(processId);
    if (!process || process.clerkOrgId !== run.clerkOrgId) return null;
    const chunk = await ctx.db
      .query("summaryChunks")
      .withIndex("by_clerkOrgId_and_summaryRunId_and_chunkIndex", (q) =>
        q
          .eq("clerkOrgId", run.clerkOrgId)
          .eq("summaryRunId", run._id)
          .eq("chunkIndex", args.chunkIndex),
      )
      .unique();
    if (!chunk?.sourceInputs) return null;

    const sources: ProcessEvidencePromptSource[] = [];
    for (const input of chunk.sourceInputs) {
      const conversation = await ctx.db.get(input.conversationId);
      const evidence = conversation?.processSummaryEvidenceV2;
      if (
        !conversation ||
        conversation.clerkOrgId !== run.clerkOrgId ||
        conversation.processId !== processId ||
        hashTranscript(conversation.transcript ?? null) !== input.transcriptHash ||
        evidence?.promptVersion !== input.promptVersion ||
        !isConversationEvidenceV2Current(evidence, input.transcriptHash)
      ) {
        return { status: "source_changed" as const };
      }
      sources.push({ ...input, evidence });
    }
    return {
      status: "ready" as const,
      processId,
      processName: process.name,
      clerkOrgId: run.clerkOrgId,
      sourceSnapshot: run.sourceSnapshot,
      sources,
    };
  },
});

function sourceMap(sources: ProcessEvidencePromptSource[]): SummarySourceKeyMap {
  return Object.fromEntries(
    sources.map((source) => [
      source.key,
      {
        kind: "conversation" as const,
        conversationId: source.conversationId as Id<"conversations">,
        label: source.label,
      },
    ]),
  );
}

function coverageFor(
  sources: ProcessEvidencePromptSource[],
  totalEligibleSources: number,
): SummaryCoverage {
  return {
    includedSources: sources.length,
    totalEligibleSources,
    uniqueContributors: new Set(sources.map((source) => source.label)).size,
    complete: sources.length === totalEligibleSources,
  };
}

export const generateProcessChunk = internalAction({
  args: {
    runId: v.id("summaryRuns"),
    generationId: v.string(),
    chunkIndex: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const claimed: boolean = await ctx.runMutation(
      internal.processSummaryV2.claimProcessChunk,
      args,
    );
    if (!claimed) return;
    try {
      if (!isAIConfigured("synthesis")) throw new Error("not_configured");
      const input = await ctx.runQuery(
        internal.processSummaryV2.getProcessChunkInput,
        args,
      );
      if (!input || input.status === "source_changed") {
        throw new Error("source_changed");
      }
      const request = buildProcessOverviewChunkRequest({
        processName: input.processName,
        sources: input.sources,
      });
      const completion = await meteredCompletion(
        ctx,
        {
          clerkOrgId: input.clerkOrgId,
          entityType: "process",
          entityId: input.processId,
          entityLabel: input.processName,
          runId: args.generationId,
        },
        request,
      );
      assertCompletionNotTruncated(
        completion,
        PROCESS_OVERVIEW_V2_CHUNK_OPERATION,
        SUMMARY_V2_AI_BUDGETS.chunkReduce.maxTokens,
      );
      const artifact = normalizeProcessOverviewArtifactV2(completion.toolInput, {
        sourceByKey: sourceMap(input.sources),
        coverage: coverageFor(input.sources, input.sources.length),
        provenance: {
          sourceSnapshotHash: `${input.sourceSnapshot.hash}:chunk:${args.chunkIndex}`,
          generatedAt: Date.now(),
          promptVersion: SUMMARY_V2_PROMPT_VERSIONS.processOverview,
          provider: completion.provider,
          model: completion.model,
        },
      });
      if (!artifact) throw new Error("invalid_output");
      await ctx.runMutation(internal.processSummaryV2.saveProcessChunk, {
        ...args,
        output: processArtifactToChunkOutput(artifact),
      });
    } catch (error) {
      const failure = actionFailure(error);
      await ctx.runMutation(internal.processSummaryV2.failProcessChunk, {
        ...args,
        ...failure,
      });
    }
  },
});

export const saveProcessChunk = internalMutation({
  args: {
    runId: v.id("summaryRuns"),
    generationId: v.string(),
    chunkIndex: v.number(),
    output: summaryChunkOutputV2Validator,
  },
  handler: async (ctx, args): Promise<void> => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.generationId !== args.generationId) return;
    const process = await ownsRun(ctx, run);
    if (!process) return;
    const featureDisabled = !isSummaryV2EnabledForOrg(process.clerkOrgId);
    if (
      featureDisabled ||
      run.state !== "running" ||
      process.summaryRegenRequestedAgain ||
      (process.summaryEvidenceRevision ?? 0) !== (run.sourceRevision ?? 0)
    ) {
      await ctx.db.patch(run._id, {
        state: "failed",
        error: featureDisabled
          ? errorFor(
              "feature_disabled",
              "Summary V2 was disabled before this run completed.",
              false,
            )
          : errorFor(
              "superseded",
              "Newer evidence superseded this run.",
              false,
            ),
        completedAt: Date.now(),
        lastProgressAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.processSummaryV2.finishProcessRun, {
        processId: process._id,
        clerkOrgId: run.clerkOrgId,
        generationId: run.generationId,
        runId: run._id,
      });
      return;
    }
    const chunk = await ctx.db
      .query("summaryChunks")
      .withIndex("by_clerkOrgId_and_summaryRunId_and_chunkIndex", (q) =>
        q
          .eq("clerkOrgId", run.clerkOrgId)
          .eq("summaryRunId", run._id)
          .eq("chunkIndex", args.chunkIndex),
      )
      .unique();
    if (!chunk || chunk.state !== "running") return;
    const now = Date.now();
    await ctx.db.patch(chunk._id, {
      state: "succeeded",
      output: args.output,
      error: undefined,
      completedAt: now,
    });
    const chunkCount = run.chunkCount ?? 0;
    const completed = args.chunkIndex + 1;
    if (completed < chunkCount) {
      await ctx.db.patch(run._id, {
        progress: { stage: "chunk_reduce", completed, total: chunkCount },
        lastProgressAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.processSummaryV2.generateProcessChunk,
        {
          runId: run._id,
          generationId: run.generationId,
          chunkIndex: completed,
        },
      );
      return;
    }
    await ctx.db.patch(run._id, {
      progress: { stage: "final_reduce", completed: 0, total: 1 },
      lastProgressAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.processSummaryV2.generateProcessFinal,
      { runId: run._id, generationId: run.generationId },
    );
  },
});

export const failProcessChunk = internalMutation({
  args: {
    runId: v.id("summaryRuns"),
    generationId: v.string(),
    chunkIndex: v.number(),
    code: v.string(),
    message: v.string(),
    retryable: v.boolean(),
  },
  handler: async (ctx, args): Promise<void> => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.generationId !== args.generationId) return;
    const process = await ownsRun(ctx, run);
    if (!process) return;
    const chunk = await ctx.db
      .query("summaryChunks")
      .withIndex("by_clerkOrgId_and_summaryRunId_and_chunkIndex", (q) =>
        q
          .eq("clerkOrgId", run.clerkOrgId)
          .eq("summaryRunId", run._id)
          .eq("chunkIndex", args.chunkIndex),
      )
      .unique();
    if (!chunk) return;
    const error = errorFor(
      args.code as RunFailureCode,
      args.message,
      args.retryable,
    );
    const retry = args.retryable && chunk.attempt < run.maxAttempts;
    await ctx.db.patch(chunk._id, {
      state: retry ? "queued" : "failed",
      error,
      completedAt: retry ? undefined : Date.now(),
    });
    if (retry) {
      await ctx.db.patch(run._id, { error, lastProgressAt: Date.now() });
      await ctx.scheduler.runAfter(
        0,
        internal.processSummaryV2.generateProcessChunk,
        {
          runId: run._id,
          generationId: run.generationId,
          chunkIndex: args.chunkIndex,
        },
      );
      return;
    }
    const priorSuccess = await ctx.db
      .query("summaryChunks")
      .withIndex("by_clerkOrgId_and_summaryRunId_and_state_and_chunkIndex", (q) =>
        q
          .eq("clerkOrgId", run.clerkOrgId)
          .eq("summaryRunId", run._id)
          .eq("state", "succeeded"),
      )
      .take(1);
    await ctx.db.patch(run._id, {
      state: priorSuccess.length > 0 ? "partial" : "failed",
      error,
      completedAt: Date.now(),
      lastProgressAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.processSummaryV2.finishProcessRun, {
      processId: process._id,
      clerkOrgId: run.clerkOrgId,
      generationId: run.generationId,
      runId: run._id,
    });
  },
});

export const claimProcessFinal = internalMutation({
  args: { runId: v.id("summaryRuns"), generationId: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.generationId !== args.generationId || run.state !== "running") {
      return false;
    }
    const process = await ownsRun(ctx, run);
    if (!process || run.progress.stage !== "final_reduce") return false;
    if (!isSummaryV2EnabledForOrg(process.clerkOrgId)) {
      await ctx.db.patch(run._id, {
        state: "failed",
        error: errorFor(
          "feature_disabled",
          "Summary V2 was disabled before this run completed.",
          false,
        ),
        completedAt: Date.now(),
        lastProgressAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.processSummaryV2.finishProcessRun, {
        processId: process._id,
        clerkOrgId: run.clerkOrgId,
        generationId: run.generationId,
        runId: run._id,
      });
      return false;
    }
    if (
      process.summaryRegenRequestedAgain ||
      (process.summaryEvidenceRevision ?? 0) !== (run.sourceRevision ?? 0)
    ) {
      await ctx.db.patch(run._id, {
        state: "failed",
        error: errorFor("superseded", "Newer evidence superseded this run.", false),
        completedAt: Date.now(),
        lastProgressAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.processSummaryV2.finishProcessRun, {
        processId: process._id,
        clerkOrgId: run.clerkOrgId,
        generationId: run.generationId,
        runId: run._id,
      });
      return false;
    }
    if (run.attempt >= run.maxAttempts) return false;
    const now = Date.now();
    await ctx.db.patch(run._id, {
      attempt: run.attempt + 1,
      error: undefined,
      lastProgressAt: now,
    });
    await ctx.db.patch(process._id, { summaryRegenScheduledAt: now });
    return true;
  },
});

export const getFinalChunksPage = internalQuery({
  args: {
    runId: v.id("summaryRuns"),
    generationId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.generationId !== args.generationId) return null;
    const page = await ctx.db
      .query("summaryChunks")
      .withIndex("by_clerkOrgId_and_summaryRunId_and_chunkIndex", (q) =>
        q.eq("clerkOrgId", run.clerkOrgId).eq("summaryRunId", run._id),
      )
      .order("asc")
      .paginate({ numItems: 20, cursor: args.cursor });
    return {
      chunks: page.page.map((chunk) => ({
        chunkIndex: chunk.chunkIndex,
        state: chunk.state,
        output: chunk.output ?? null,
        sourceInputs: chunk.sourceInputs ?? [],
      })),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      sourceSnapshot: run.sourceSnapshot,
      sourceRevision: run.sourceRevision ?? 0,
      chunkCount: run.chunkCount ?? 0,
      entity: run.entity,
      clerkOrgId: run.clerkOrgId,
    };
  },
});

type FinalChunkPage = {
  chunks: Array<{
    chunkIndex: number;
    state: "queued" | "running" | "succeeded" | "failed";
    output: SummaryChunkOutputV2 | null;
    sourceInputs: ProcessSummarySourceInput[];
  }>;
  continueCursor: string;
  isDone: boolean;
  sourceSnapshot: Doc<"summaryRuns">["sourceSnapshot"];
  sourceRevision: number;
  chunkCount: number;
  entity: Doc<"summaryRuns">["entity"];
  clerkOrgId: string;
};

async function loadAllFinalChunks(
  ctx: ActionCtx,
  runId: Id<"summaryRuns">,
  generationId: string,
): Promise<FinalChunkPage | null> {
  let cursor: string | null = null;
  let aggregate: FinalChunkPage | null = null;
  do {
    const page: FinalChunkPage | null = await ctx.runQuery(
      internal.processSummaryV2.getFinalChunksPage,
      { runId, generationId, cursor },
    );
    if (!page) return null;
    aggregate = aggregate
      ? { ...page, chunks: [...aggregate.chunks, ...page.chunks] }
      : page;
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  return aggregate;
}

export const generateProcessFinal = internalAction({
  args: { runId: v.id("summaryRuns"), generationId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const claimed: boolean = await ctx.runMutation(
      internal.processSummaryV2.claimProcessFinal,
      args,
    );
    if (!claimed) return;
    try {
      if (!isAIConfigured("synthesis")) throw new Error("not_configured");
      const loaded = await loadAllFinalChunks(
        ctx,
        args.runId,
        args.generationId,
      );
      if (
        !loaded ||
        loaded.entity.kind !== "process" ||
        loaded.chunks.length !== loaded.chunkCount
      ) {
        throw new Error("source_changed");
      }
      const processInput = await ctx.runQuery(
        internal.processSummaryV2.getProcessChunkInput,
        { ...args, chunkIndex: 0 },
      );
      if (!processInput || processInput.status === "source_changed") {
        throw new Error("source_changed");
      }

      const allSourceInputs = loaded.chunks.flatMap(
        (chunk) => chunk.sourceInputs,
      );
      const keyByConversationId = Object.fromEntries(
        allSourceInputs.map((source) => [source.conversationId, source.key]),
      );
      const allSources = loaded.chunkCount === 1
        ? processInput.sources
        : [];
      const chunks = loaded.chunkCount === 1
        ? undefined
        : loaded.chunks.map((chunk) => {
            if (chunk.state !== "succeeded" || !chunk.output) {
              throw new Error("source_changed");
            }
            return chunkOutputForFinalPrompt(chunk.output, keyByConversationId);
          });
      const request = buildProcessOverviewFinalRequest({
        processName: processInput.processName,
        directSources: loaded.chunkCount === 1 ? allSources : undefined,
        chunks,
      });
      const completion = await meteredCompletion(
        ctx,
        {
          clerkOrgId: loaded.clerkOrgId,
          entityType: "process",
          entityId: loaded.entity.processId,
          entityLabel: processInput.processName,
          runId: args.generationId,
        },
        request,
      );
      assertCompletionNotTruncated(
        completion,
        PROCESS_OVERVIEW_V2_FINAL_OPERATION,
        SUMMARY_V2_AI_BUDGETS.finalReduce.maxTokens,
      );
      const sourceByKey: SummarySourceKeyMap = Object.fromEntries(
        allSourceInputs.map((source) => [
          source.key,
          {
            kind: "conversation" as const,
            conversationId: source.conversationId,
            label: source.label,
          },
        ]),
      );
      const coverage: SummaryCoverage = {
        includedSources: loaded.sourceSnapshot.includedSources,
        totalEligibleSources: loaded.sourceSnapshot.totalEligibleSources,
        uniqueContributors: new Set(
          allSourceInputs.map((source) => source.label),
        ).size,
        complete:
          loaded.sourceSnapshot.includedSources ===
          loaded.sourceSnapshot.totalEligibleSources,
      };
      const artifact = normalizeProcessOverviewArtifactV2(completion.toolInput, {
        sourceByKey,
        coverage,
        provenance: {
          sourceSnapshotHash: loaded.sourceSnapshot.hash,
          generatedAt: Date.now(),
          promptVersion: SUMMARY_V2_PROMPT_VERSIONS.processOverview,
          provider: completion.provider,
          model: completion.model,
        },
      });
      if (!artifact) throw new Error("invalid_output");
      await ctx.runMutation(internal.processSummaryV2.saveProcessFinal, {
        ...args,
        sourceRevision: loaded.sourceRevision,
        artifact,
      });
    } catch (error) {
      const failure = actionFailure(error);
      await ctx.runMutation(internal.processSummaryV2.failProcessFinal, {
        ...args,
        ...failure,
      });
    }
  },
});

export const saveProcessFinal = internalMutation({
  args: {
    runId: v.id("summaryRuns"),
    generationId: v.string(),
    sourceRevision: v.number(),
    artifact: processOverviewArtifactV2Validator,
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.generationId !== args.generationId) return { saved: false };
    const process = await ownsRun(ctx, run);
    if (!process) return { saved: false };
    const featureDisabled = !isSummaryV2EnabledForOrg(process.clerkOrgId);
    if (
      featureDisabled ||
      process.summaryRegenRequestedAgain ||
      (process.summaryEvidenceRevision ?? 0) !== args.sourceRevision ||
      (run.sourceRevision ?? 0) !== args.sourceRevision ||
      args.artifact.provenance.sourceSnapshotHash !== run.sourceSnapshot.hash
    ) {
      await ctx.db.patch(run._id, {
        state: "failed",
        error: featureDisabled
          ? errorFor(
              "feature_disabled",
              "Summary V2 was disabled before this run completed.",
              false,
            )
          : errorFor(
              "superseded",
              "Newer evidence superseded this run.",
              false,
            ),
        completedAt: Date.now(),
        lastProgressAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.processSummaryV2.finishProcessRun, {
        processId: process._id,
        clerkOrgId: run.clerkOrgId,
        generationId: run.generationId,
        runId: run._id,
      });
      return { saved: false };
    }

    const snapshotChanged =
      process.summaryV2?.provenance.sourceSnapshotHash !==
      args.artifact.provenance.sourceSnapshotHash;
    const now = Date.now();
    await ctx.db.patch(process._id, {
      summaryV2: args.artifact,
      summaryV2SourceRevision: args.sourceRevision,
      rollingSummary: renderSummaryV2AsLegacyMarkdown(args.artifact),
      summaryUpdatedAt: args.artifact.provenance.generatedAt,
      // Only current if this run consumed the newest evidence. Anything that
      // landed mid-run left the revision ahead, and the overview stays stale.
      summaryStale: args.sourceRevision !== (process.summaryEvidenceRevision ?? 0),
    });
    await ctx.db.patch(run._id, {
      state: args.artifact.coverage.complete ? "succeeded" : "partial",
      progress: { stage: "final_reduce", completed: 1, total: 1 },
      error: undefined,
      lastProgressAt: now,
      completedAt: now,
    });
    await ctx.runMutation(internal.processFlows.markFlowStale, {
      processId: process._id,
      clerkOrgId: run.clerkOrgId,
      trigger: "summaryRebuilt",
    });
    if (snapshotChanged) {
      await ctx.runMutation(
        internal.summariesHelpers.markDepartmentSummaryStale,
        { departmentId: process.departmentId },
      );
    }
    await ctx.scheduler.runAfter(0, internal.processSummaryV2.finishProcessRun, {
      processId: process._id,
      clerkOrgId: run.clerkOrgId,
      generationId: run.generationId,
      runId: run._id,
    });
    return { saved: true };
  },
});

export const failProcessFinal = internalMutation({
  args: {
    runId: v.id("summaryRuns"),
    generationId: v.string(),
    code: v.string(),
    message: v.string(),
    retryable: v.boolean(),
  },
  handler: async (ctx, args): Promise<void> => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.generationId !== args.generationId) return;
    const process = await ownsRun(ctx, run);
    if (!process) return;
    const error = errorFor(
      args.code as RunFailureCode,
      args.message,
      args.retryable,
    );
    if (args.retryable && run.attempt < run.maxAttempts) {
      await ctx.db.patch(run._id, { error, lastProgressAt: Date.now() });
      await ctx.scheduler.runAfter(
        0,
        internal.processSummaryV2.generateProcessFinal,
        { runId: run._id, generationId: run.generationId },
      );
      return;
    }
    await ctx.db.patch(run._id, {
      state: "failed",
      error,
      completedAt: Date.now(),
      lastProgressAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.processSummaryV2.finishProcessRun, {
      processId: process._id,
      clerkOrgId: run.clerkOrgId,
      generationId: run.generationId,
      runId: run._id,
    });
  },
});

export const finishProcessRun = internalMutation({
  args: {
    processId: v.id("processes"),
    clerkOrgId: v.string(),
    generationId: v.string(),
    runId: v.id("summaryRuns"),
  },
  handler: async (ctx, args): Promise<void> => {
    const process = await ctx.db.get(args.processId);
    const run = await ctx.db.get(args.runId);
    if (
      !process ||
      !run ||
      process.clerkOrgId !== args.clerkOrgId ||
      process.summaryV2GenerationId !== args.generationId ||
      process.summaryV2RunId !== args.runId
    ) {
      return;
    }
    if (!isSummaryV2EnabledForOrg(process.clerkOrgId)) {
      await ctx.db.patch(process._id, {
        summaryV2LastRunState: run.state,
        summaryV2LastError: run.error,
        summaryV2LastCompletedAt: run.completedAt ?? Date.now(),
        summaryRegenScheduledAt: undefined,
        summaryRegenRequestedAgain: undefined,
        summaryV2GenerationId: undefined,
        summaryV2RunId: undefined,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.processSummaryV2.cleanupSupersededProcessRuns,
        { processId: process._id, clerkOrgId: args.clerkOrgId },
      );
      return;
    }
    if (process.summaryRegenRequestedAgain) {
      const nextGenerationId = crypto.randomUUID();
      await ctx.db.patch(process._id, {
        summaryV2LastRunState: run.state,
        summaryV2LastError: run.error,
        summaryV2LastCompletedAt: run.completedAt ?? Date.now(),
        summaryRegenScheduledAt: Date.now(),
        summaryRegenRequestedAgain: false,
        summaryV2GenerationId: nextGenerationId,
        summaryV2RunId: undefined,
      });
      await ctx.scheduler.runAfter(0, internal.processSummaryV2.startProcessRun, {
        processId: process._id,
        clerkOrgId: args.clerkOrgId,
        generationId: nextGenerationId,
      });
    } else {
      await ctx.db.patch(process._id, {
        summaryV2LastRunState: run.state,
        summaryV2LastError: run.error,
        summaryV2LastCompletedAt: run.completedAt ?? Date.now(),
        summaryRegenScheduledAt: undefined,
        summaryRegenRequestedAgain: undefined,
        summaryV2GenerationId: undefined,
        summaryV2RunId: undefined,
      });
    }
    await ctx.scheduler.runAfter(
      0,
      internal.processSummaryV2.cleanupSupersededProcessRuns,
      { processId: process._id, clerkOrgId: args.clerkOrgId },
    );
  },
});

export const cleanupSupersededProcessRuns = internalMutation({
  args: { processId: v.id("processes"), clerkOrgId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const entityKey = `process:${args.processId}`;
    const terminal: Doc<"summaryRuns">[] = [];
    for (const state of TERMINAL_STATES) {
      const rows = await ctx.db
        .query("summaryRuns")
        .withIndex("by_clerkOrgId_and_entityKey_and_state_and_createdAt", (q) =>
          q
            .eq("clerkOrgId", args.clerkOrgId)
            .eq("entityKey", entityKey)
            .eq("state", state),
        )
        .order("desc")
        .take(10);
      terminal.push(...rows);
    }
    terminal.sort((a, b) => b.createdAt - a.createdAt);
    const obsolete = terminal[1];
    if (!obsolete) return;
    const chunks = await ctx.db
      .query("summaryChunks")
      .withIndex("by_clerkOrgId_and_summaryRunId_and_chunkIndex", (q) =>
        q
          .eq("clerkOrgId", args.clerkOrgId)
          .eq("summaryRunId", obsolete._id),
      )
      .take(CLEANUP_BATCH_SIZE);
    for (const chunk of chunks) await ctx.db.delete(chunk._id);
    if (chunks.length === CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.processSummaryV2.cleanupSupersededProcessRuns,
        args,
      );
      return;
    }
    await ctx.db.delete(obsolete._id);
    await ctx.scheduler.runAfter(
      0,
      internal.processSummaryV2.cleanupSupersededProcessRuns,
      args,
    );
  },
});

async function resumeRun(
  ctx: MutationCtx,
  run: Doc<"summaryRuns">,
): Promise<void> {
  if (run.sourceScan) {
    await ctx.scheduler.runAfter(0, internal.processSummaryV2.scanProcessSources, {
      runId: run._id,
      generationId: run.generationId,
    });
    return;
  }
  if (run.progress.stage === "final_reduce") {
    await ctx.scheduler.runAfter(0, internal.processSummaryV2.generateProcessFinal, {
      runId: run._id,
      generationId: run.generationId,
    });
    return;
  }
  const candidates: Doc<"summaryChunks">[] = [];
  for (const state of ["running", "queued", "failed"] as const) {
    const chunk = await ctx.db
      .query("summaryChunks")
      .withIndex("by_clerkOrgId_and_summaryRunId_and_state_and_chunkIndex", (q) =>
        q
          .eq("clerkOrgId", run.clerkOrgId)
          .eq("summaryRunId", run._id)
          .eq("state", state),
      )
      .first();
    if (chunk) candidates.push(chunk);
  }
  candidates.sort((a, b) => a.chunkIndex - b.chunkIndex);
  const chunk = candidates[0];
  if (!chunk) return;
  if (chunk.state === "running") {
    await ctx.db.patch(chunk._id, { state: "queued" });
  }
  await ctx.scheduler.runAfter(0, internal.processSummaryV2.generateProcessChunk, {
    runId: run._id,
    generationId: run.generationId,
    chunkIndex: chunk.chunkIndex,
  });
}

export const reapStuckProcessSummaryRuns = internalMutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const cutoff = Date.now() - RUN_STALE_MS;
    const stale: Doc<"summaryRuns">[] = [];
    for (const state of ["queued", "running"] as const) {
      const rows = await ctx.db
        .query("summaryRuns")
        .withIndex("by_state_and_lastProgressAt", (q) =>
          q.eq("state", state).lt("lastProgressAt", cutoff),
        )
        .take(10);
      stale.push(...rows);
    }
    for (const run of stale) {
      const processId = processIdFromRun(run);
      const process = processId ? await ownsRun(ctx, run) : null;
      if (!process || !processId) continue;
      if (!isSummaryV2EnabledForOrg(process.clerkOrgId)) {
        await ctx.db.patch(run._id, {
          state: "failed",
          error: errorFor(
            "feature_disabled",
            "Summary V2 was disabled before this run completed.",
            false,
          ),
          completedAt: Date.now(),
          lastProgressAt: Date.now(),
        });
        await ctx.scheduler.runAfter(0, internal.processSummaryV2.finishProcessRun, {
          processId,
          clerkOrgId: run.clerkOrgId,
          generationId: run.generationId,
          runId: run._id,
        });
        continue;
      }
      if (run.resumeCount >= MAX_RUN_RESUMES) {
        await ctx.db.patch(run._id, {
          state: "failed",
          error: errorFor(
            "watchdog_exhausted",
            "Summary generation stopped after repeated recovery attempts.",
            true,
          ),
          completedAt: Date.now(),
          lastProgressAt: Date.now(),
        });
        await ctx.scheduler.runAfter(0, internal.processSummaryV2.finishProcessRun, {
          processId,
          clerkOrgId: run.clerkOrgId,
          generationId: run.generationId,
          runId: run._id,
        });
        continue;
      }
      await ctx.db.patch(run._id, {
        resumeCount: run.resumeCount + 1,
        lastProgressAt: Date.now(),
      });
      await ctx.db.patch(process._id, { summaryRegenScheduledAt: Date.now() });
      await resumeRun(ctx, run);
    }
  },
});
