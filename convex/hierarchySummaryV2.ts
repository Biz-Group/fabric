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
  buildDepartmentOverviewRequest,
  buildFunctionOverviewRequest,
  classifyHierarchyChild,
  DEPARTMENT_OVERVIEW_V2_OPERATION,
  finishHierarchySnapshotHash,
  FUNCTION_OVERVIEW_V2_OPERATION,
  initialHierarchySnapshotHashState,
  isUsableHierarchyChild,
  updateHierarchySnapshotHashState,
  type DepartmentOverviewPromptSource,
  type FunctionOverviewPromptSource,
  type HierarchyChildState,
} from "./lib/hierarchyOverviewV2";
import { isSummaryV2EnabledForOrg } from "./lib/summaryV2Feature";
import {
  departmentOverviewArtifactV2Validator,
  functionOverviewArtifactV2Validator,
  normalizeDepartmentOverviewArtifactV2,
  normalizeFunctionOverviewArtifactV2,
  renderSummaryV2AsLegacyMarkdown,
  SUMMARY_V2_AI_BUDGETS,
  SUMMARY_V2_CAPS,
  SUMMARY_V2_PROMPT_VERSIONS,
  type DepartmentOverviewArtifactV2,
  type FunctionOverviewArtifactV2,
  type HierarchySummarySourceInput,
  type SummaryCoverage,
  type SummaryRunError,
  type SummarySourceRef,
  type SummarySourceKeyMap,
} from "./summaryV2";

const PAGE_SIZE = 20;
const RUN_STALE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 2;
const MAX_RESUMES = 2;
const CLEANUP_BATCH_SIZE = 20;
const TERMINAL_STATES = ["succeeded", "partial", "failed"] as const;

type RollupEntity =
  | { kind: "department"; departmentId: Id<"departments"> }
  | { kind: "function"; functionId: Id<"functions"> };

type RollupOwner = Doc<"departments"> | Doc<"functions">;

function runError(
  code: string,
  message: string,
  retryable: boolean,
): SummaryRunError {
  return { code, message: message.slice(0, 500), retryable };
}

function actionFailure(error: unknown) {
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
      message: "The model returned an invalid hierarchy overview payload.",
      retryable: true,
    };
  }
  if (error instanceof Error && error.message === "source_changed") {
    return {
      code: "source_changed",
      message: "A child overview changed during this generation.",
      retryable: false,
    };
  }
  return {
    code: "generation_failed",
    message: error instanceof Error ? error.message : "Generation failed.",
    retryable: true,
  };
}

function initialRollupScan() {
  const hash = initialHierarchySnapshotHashState();
  return {
    eligibleSources: 0,
    includedSources: 0,
    currentSources: 0,
    completedSources: 0,
    nextOrdinal: 1,
    nextChunkIndex: 0,
    hashFirst: hash.first,
    hashSecond: hash.second,
    hashLength: hash.length,
    pendingSources: [] as HierarchySummarySourceInput[],
  };
}

function entityKey(entity: RollupEntity): string {
  return entity.kind === "department"
    ? `department:${entity.departmentId}`
    : `function:${entity.functionId}`;
}

function rollupEntity(run: Doc<"summaryRuns">): RollupEntity | null {
  return run.entity.kind === "department" || run.entity.kind === "function"
    ? run.entity
    : null;
}

async function ownsRun(
  ctx: MutationCtx,
  run: Doc<"summaryRuns">,
): Promise<RollupOwner | null> {
  const entity = rollupEntity(run);
  if (!entity) return null;
  if (entity.kind === "department") {
    const department = await ctx.db.get(entity.departmentId);
    return department &&
      department.clerkOrgId === run.clerkOrgId &&
      department.summaryV2GenerationId === run.generationId &&
      department.summaryV2RunId === run._id
      ? department
      : null;
  }
  const fn = await ctx.db.get(entity.functionId);
  return fn &&
    fn.clerkOrgId === run.clerkOrgId &&
    fn.summaryV2GenerationId === run.generationId &&
    fn.summaryV2RunId === run._id
    ? fn
    : null;
}

export function processState(
  process: Doc<"processes">,
): HierarchyChildState {
  return classifyHierarchyChild({
    hasArtifact: process.summaryV2 !== undefined,
    artifactComplete: process.summaryV2?.coverage.complete,
    sourceRevisionMatches:
      process.summaryV2SourceRevision !== undefined &&
      process.summaryV2SourceRevision === (process.summaryEvidenceRevision ?? 0),
    refreshing:
      process.summaryEvidenceRefreshScheduledAt !== undefined ||
      process.summaryRegenScheduledAt !== undefined,
    lastRunFailed: process.summaryV2LastRunState === "failed",
  });
}

export function departmentState(
  department: Doc<"departments">,
): HierarchyChildState {
  return classifyHierarchyChild({
    hasArtifact: department.summaryV2 !== undefined,
    artifactComplete: department.summaryV2?.coverage.complete,
    sourceRevisionMatches:
      department.summaryV2SourceRevision !== undefined &&
      department.summaryV2SourceRevision ===
        (department.summarySourceRevision ?? 0),
    refreshing: department.summaryRegenScheduledAt !== undefined,
    lastRunFailed: department.summaryV2LastRunState === "failed",
    explicitStale: department.summaryStale === true,
  });
}

export async function requestDepartmentSummaryV2ForOrg(
  ctx: MutationCtx,
  args: {
    departmentId: Id<"departments">;
    clerkOrgId: string;
    forceRefresh?: boolean;
    actorUserId?: Id<"users">;
  },
) {
    if (!isSummaryV2EnabledForOrg(args.clerkOrgId)) throw new Error("SUMMARY_V2 is disabled");
    const department = await ctx.db.get(args.departmentId);
    if (!department || department.clerkOrgId !== args.clerkOrgId) {
      throw new Error("Department not found in this organization");
    }
    if (
      !args.forceRefresh &&
      department.summaryV2 &&
      department.summaryStale !== true &&
      department.summaryV2SourceRevision ===
        (department.summarySourceRevision ?? 0)
    ) {
      return { scheduled: false as const, generationId: null };
    }
    const now = Date.now();
    const inFlight =
      department.summaryRegenScheduledAt !== undefined &&
      now - department.summaryRegenScheduledAt < RUN_STALE_MS &&
      department.summaryV2GenerationId !== undefined;
    if (inFlight) {
      await ctx.db.patch(department._id, {
        summaryRegenRequestedAgain: true,
        summaryForceRefreshRequested:
          department.summaryForceRefreshRequested || args.forceRefresh,
      });
      return {
        scheduled: false as const,
        generationId: department.summaryV2GenerationId!,
      };
    }
    const generationId = crypto.randomUUID();
    await ctx.db.patch(department._id, {
      summaryRegenScheduledAt: now,
      summaryRegenRequestedAgain: false,
      summaryForceRefreshRequested: args.forceRefresh ?? false,
      summaryV2GenerationId: generationId,
      summaryV2RunId: undefined,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.hierarchySummaryV2.startDepartmentRun,
      {
        departmentId: department._id,
        clerkOrgId: args.clerkOrgId,
        generationId,
        forceRefresh: args.forceRefresh ?? false,
        actorUserId: args.actorUserId,
      },
    );
    return { scheduled: true as const, generationId };
}

export const requestDepartmentSummaryV2 = internalMutation({
  args: {
    departmentId: v.id("departments"),
    clerkOrgId: v.string(),
    forceRefresh: v.optional(v.boolean()),
    actorUserId: v.optional(v.id("users")),
  },
  handler: requestDepartmentSummaryV2ForOrg,
});

export async function requestFunctionSummaryV2ForOrg(
  ctx: MutationCtx,
  args: {
    functionId: Id<"functions">;
    clerkOrgId: string;
    forceRefresh?: boolean;
    actorUserId?: Id<"users">;
  },
) {
    if (!isSummaryV2EnabledForOrg(args.clerkOrgId)) throw new Error("SUMMARY_V2 is disabled");
    const fn = await ctx.db.get(args.functionId);
    if (!fn || fn.clerkOrgId !== args.clerkOrgId) {
      throw new Error("Function not found in this organization");
    }
    if (
      !args.forceRefresh &&
      fn.summaryV2 &&
      fn.summaryStale !== true &&
      fn.summaryV2SourceRevision === (fn.summarySourceRevision ?? 0)
    ) {
      return { scheduled: false as const, generationId: null };
    }
    const now = Date.now();
    const inFlight =
      fn.summaryRegenScheduledAt !== undefined &&
      now - fn.summaryRegenScheduledAt < RUN_STALE_MS &&
      fn.summaryV2GenerationId !== undefined;
    if (inFlight) {
      await ctx.db.patch(fn._id, {
        summaryRegenRequestedAgain: true,
        summaryForceRefreshRequested:
          fn.summaryForceRefreshRequested || args.forceRefresh,
      });
      return {
        scheduled: false as const,
        generationId: fn.summaryV2GenerationId!,
      };
    }
    const generationId = crypto.randomUUID();
    await ctx.db.patch(fn._id, {
      summaryRegenScheduledAt: now,
      summaryRegenRequestedAgain: false,
      summaryForceRefreshRequested: args.forceRefresh ?? false,
      summaryV2GenerationId: generationId,
      summaryV2RunId: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.hierarchySummaryV2.startFunctionRun, {
      functionId: fn._id,
      clerkOrgId: args.clerkOrgId,
      generationId,
      forceRefresh: args.forceRefresh ?? false,
      actorUserId: args.actorUserId,
    });
    return { scheduled: true as const, generationId };
}

export const requestFunctionSummaryV2 = internalMutation({
  args: {
    functionId: v.id("functions"),
    clerkOrgId: v.string(),
    forceRefresh: v.optional(v.boolean()),
    actorUserId: v.optional(v.id("users")),
  },
  handler: requestFunctionSummaryV2ForOrg,
});

export const startDepartmentRun = internalMutation({
  args: {
    departmentId: v.id("departments"),
    clerkOrgId: v.string(),
    generationId: v.string(),
    forceRefresh: v.boolean(),
    actorUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const department = await ctx.db.get(args.departmentId);
    if (
      !department ||
      department.clerkOrgId !== args.clerkOrgId ||
      department.summaryV2GenerationId !== args.generationId ||
      department.summaryV2RunId !== undefined
    ) {
      return null;
    }
    if (!isSummaryV2EnabledForOrg(department.clerkOrgId)) {
      await ctx.db.patch(department._id, {
        summaryRegenScheduledAt: undefined,
        summaryRegenRequestedAgain: undefined,
        summaryForceRefreshRequested: undefined,
        summaryV2GenerationId: undefined,
        summaryV2RunId: undefined,
      });
      return null;
    }
    const now = Date.now();
    const runId = await ctx.db.insert("summaryRuns", {
      clerkOrgId: args.clerkOrgId,
      entity: { kind: "department", departmentId: department._id },
      entityKey: `department:${department._id}`,
      generationId: args.generationId,
      sourceRevision: department.summarySourceRevision ?? 0,
      sourceSnapshot: {
        hash: "pending",
        includedSources: 0,
        totalEligibleSources: 0,
      },
      state: "queued",
      progress: { stage: "rollup_reduce", completed: 0, total: 1 },
      createdAt: now,
      lastProgressAt: now,
      attempt: 0,
      maxAttempts: MAX_ATTEMPTS,
      resumeCount: 0,
      forceRefresh: args.forceRefresh,
      actorUserId: args.actorUserId,
      rollupPhase: "scan_sources",
      rollupScan: initialRollupScan(),
    });
    await ctx.db.patch(department._id, { summaryV2RunId: runId });
    await ctx.scheduler.runAfter(
      0,
      internal.hierarchySummaryV2.scanDepartmentSources,
      { runId, generationId: args.generationId },
    );
    return runId;
  },
});

export const startFunctionRun = internalMutation({
  args: {
    functionId: v.id("functions"),
    clerkOrgId: v.string(),
    generationId: v.string(),
    forceRefresh: v.boolean(),
    actorUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const fn = await ctx.db.get(args.functionId);
    if (
      !fn ||
      fn.clerkOrgId !== args.clerkOrgId ||
      fn.summaryV2GenerationId !== args.generationId ||
      fn.summaryV2RunId !== undefined
    ) {
      return null;
    }
    if (!isSummaryV2EnabledForOrg(fn.clerkOrgId)) {
      await ctx.db.patch(fn._id, {
        summaryRegenScheduledAt: undefined,
        summaryRegenRequestedAgain: undefined,
        summaryForceRefreshRequested: undefined,
        summaryV2GenerationId: undefined,
        summaryV2RunId: undefined,
      });
      return null;
    }
    const now = Date.now();
    const runId = await ctx.db.insert("summaryRuns", {
      clerkOrgId: args.clerkOrgId,
      entity: { kind: "function", functionId: fn._id },
      entityKey: `function:${fn._id}`,
      generationId: args.generationId,
      sourceRevision: fn.summarySourceRevision ?? 0,
      sourceSnapshot: {
        hash: "pending",
        includedSources: 0,
        totalEligibleSources: 0,
      },
      state: "queued",
      progress: { stage: "rollup_reduce", completed: 0, total: 1 },
      createdAt: now,
      lastProgressAt: now,
      attempt: 0,
      maxAttempts: MAX_ATTEMPTS,
      resumeCount: 0,
      forceRefresh: args.forceRefresh,
      actorUserId: args.actorUserId,
      rollupPhase: "refresh_children",
      rollupScan: initialRollupScan(),
    });
    await ctx.db.patch(fn._id, { summaryV2RunId: runId });
    await ctx.scheduler.runAfter(
      0,
      internal.hierarchySummaryV2.prepareFunctionChildren,
      { runId, generationId: args.generationId },
    );
    return runId;
  },
});

export const prepareFunctionChildren = internalMutation({
  args: { runId: v.id("summaryRuns"), generationId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const run = await ctx.db.get(args.runId);
    if (
      !run ||
      run.generationId !== args.generationId ||
      run.entity.kind !== "function" ||
      run.rollupPhase !== "refresh_children" ||
      !run.rollupScan
    ) return;
    const fn = await ownsRun(ctx, run);
    if (!fn || !isSummaryV2EnabledForOrg(fn.clerkOrgId)) return;
    const functionId = run.entity.functionId;
    const scan = run.rollupScan;
    const page = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q
          .eq("clerkOrgId", run.clerkOrgId)
          .eq("functionId", functionId),
      )
      .order("asc")
      .paginate({ numItems: PAGE_SIZE, cursor: scan.cursor ?? null });
    let eligible = scan.eligibleSources;
    let completed = scan.completedSources;
    for (const department of page.page) {
      eligible += 1;
      const state = departmentState(department);
      if (isUsableHierarchyChild(state)) {
        completed += 1;
      } else if (state !== "refreshing") {
        const requestResult: { scheduled: boolean; generationId: string | null } =
          await ctx.runMutation(
            internal.hierarchySummaryV2.requestDepartmentSummaryV2,
            {
              departmentId: department._id,
              clerkOrgId: run.clerkOrgId,
            },
          );
        if (!requestResult.scheduled && requestResult.generationId === null) {
          completed += 1;
        }
      }
    }
    if (!page.isDone) {
      await ctx.db.patch(run._id, {
        state: "running",
        progress: {
          stage: "rollup_reduce",
          completed,
          total: eligible + 1,
        },
        lastProgressAt: Date.now(),
        rollupScan: {
          ...scan,
          cursor: page.continueCursor,
          eligibleSources: eligible,
          completedSources: completed,
        },
      });
      await ctx.scheduler.runAfter(
        0,
        internal.hierarchySummaryV2.prepareFunctionChildren,
        args,
      );
      return;
    }
    await ctx.db.patch(run._id, {
      state: "running",
      progress: { stage: "rollup_reduce", completed, total: eligible },
      lastProgressAt: Date.now(),
      rollupPhase: "wait_children",
      rollupScan: initialRollupScan(),
    });
    await ctx.scheduler.runAfter(
      0,
      internal.hierarchySummaryV2.waitForFunctionChildren,
      args,
    );
  },
});

export const waitForFunctionChildren = internalMutation({
  args: { runId: v.id("summaryRuns"), generationId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const run = await ctx.db.get(args.runId);
    if (
      !run ||
      run.generationId !== args.generationId ||
      run.entity.kind !== "function" ||
      run.rollupPhase !== "wait_children" ||
      !run.rollupScan
    ) return;
    const owner = await ownsRun(ctx, run);
    const functionId = run.entity.functionId;
    if (!owner || owner._id !== functionId) return;
    const scan = run.rollupScan;
    const page = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q
          .eq("clerkOrgId", run.clerkOrgId)
          .eq("functionId", functionId),
      )
      .order("asc")
      .paginate({ numItems: PAGE_SIZE, cursor: scan.cursor ?? null });
    let eligible = scan.eligibleSources;
    let completed = scan.completedSources;
    for (const department of page.page) {
      eligible += 1;
      if (departmentState(department) !== "refreshing") completed += 1;
    }
    if (!page.isDone) {
      await ctx.db.patch(run._id, {
        progress: {
          stage: "rollup_reduce",
          completed,
          total: eligible + 1,
        },
        lastProgressAt: Date.now(),
        rollupScan: {
          ...scan,
          cursor: page.continueCursor,
          eligibleSources: eligible,
          completedSources: completed,
        },
      });
      await ctx.scheduler.runAfter(
        0,
        internal.hierarchySummaryV2.waitForFunctionChildren,
        args,
      );
      return;
    }
    if (completed < eligible) {
      await ctx.db.patch(run._id, {
        progress: { stage: "rollup_reduce", completed, total: eligible },
        lastProgressAt: Date.now(),
        rollupScan: initialRollupScan(),
      });
      await ctx.scheduler.runAfter(
        2_000,
        internal.hierarchySummaryV2.waitForFunctionChildren,
        args,
      );
      return;
    }
    if (
      owner.summaryRegenRequestedAgain ||
      (owner.summarySourceRevision ?? 0) !== (run.sourceRevision ?? 0)
    ) {
      await failSupersededRun(ctx, run, owner);
      return;
    }
    await ctx.db.patch(run._id, {
      rollupPhase: "scan_sources",
      rollupScan: initialRollupScan(),
      progress: { stage: "rollup_reduce", completed: eligible, total: eligible },
      lastProgressAt: Date.now(),
    });
    await ctx.scheduler.runAfter(
      0,
      internal.hierarchySummaryV2.scanFunctionSources,
      args,
    );
  },
});

async function insertRollupChunk(
  ctx: MutationCtx,
  run: Doc<"summaryRuns">,
  chunkIndex: number,
  sources: HierarchySummarySourceInput[],
) {
  await ctx.db.insert("summaryChunks", {
    clerkOrgId: run.clerkOrgId,
    summaryRunId: run._id,
    generationId: run.generationId,
    chunkIndex,
    sourceCount: sources.length,
    rollupInputs: sources,
    state: "queued",
    attempt: 0,
    createdAt: Date.now(),
  });
}

async function failSupersededRun(
  ctx: MutationCtx,
  run: Doc<"summaryRuns">,
  owner: RollupOwner,
) {
  await ctx.db.patch(run._id, {
    state: "failed",
    error: runError("superseded", "Newer child state superseded this run.", false),
    completedAt: Date.now(),
    lastProgressAt: Date.now(),
  });
  await scheduleFinish(ctx, run, owner);
}

async function scheduleFinish(
  ctx: MutationCtx,
  run: Doc<"summaryRuns">,
  owner: RollupOwner,
) {
  if (run.entity.kind === "department") {
    await ctx.scheduler.runAfter(0, internal.hierarchySummaryV2.finishRollupRun, {
      entity: { kind: "department", departmentId: owner._id as Id<"departments"> },
      clerkOrgId: run.clerkOrgId,
      generationId: run.generationId,
      runId: run._id,
    });
  } else {
    await ctx.scheduler.runAfter(0, internal.hierarchySummaryV2.finishRollupRun, {
      entity: { kind: "function", functionId: owner._id as Id<"functions"> },
      clerkOrgId: run.clerkOrgId,
      generationId: run.generationId,
      runId: run._id,
    });
  }
}

async function finishSourceScan(
  ctx: MutationCtx,
  run: Doc<"summaryRuns">,
  owner: RollupOwner,
  scan: NonNullable<Doc<"summaryRuns">["rollupScan"]>,
  hash: { first: number; second: number; length: number },
) {
  let nextChunkIndex = scan.nextChunkIndex;
  if (scan.pendingSources.length > 0) {
    await insertRollupChunk(
      ctx,
      run,
      nextChunkIndex,
      scan.pendingSources,
    );
    nextChunkIndex += 1;
  }
  const sourceSnapshot = {
    hash: finishHierarchySnapshotHash(hash),
    includedSources: scan.includedSources,
    totalEligibleSources: scan.eligibleSources,
    currentSources: scan.currentSources,
    complete: scan.currentSources === scan.eligibleSources,
  };
  if (scan.includedSources === 0) {
    // Nothing to roll up, which a rollup can never fix by trying again: a
    // parent reads child artifacts, so the only route forward is building a
    // child. The old retryable error made this read as a failed refresh and
    // invited a retry that scanned the same empty set — the read model now maps
    // this code back to the state the entity is actually in.
    await ctx.db.patch(run._id, {
      sourceSnapshot,
      rollupScan: undefined,
      chunkCount: 0,
      state: "failed",
      error: runError(
        "no_readable_children",
        scan.eligibleSources === 0
          ? "This has no children to roll up yet."
          : "No child holds a current overview to roll up yet.",
        false,
      ),
      completedAt: Date.now(),
      lastProgressAt: Date.now(),
    });
    await scheduleFinish(ctx, run, owner);
    return;
  }
  await ctx.db.patch(run._id, {
    sourceSnapshot,
    rollupScan: undefined,
    rollupPhase: "final_reduce",
    chunkCount: nextChunkIndex,
    state: "running",
    progress: { stage: "final_reduce", completed: 0, total: 1 },
    startedAt: run.startedAt ?? Date.now(),
    lastProgressAt: Date.now(),
  });
  await ctx.scheduler.runAfter(
    0,
    internal.hierarchySummaryV2.generateHierarchyFinal,
    { runId: run._id, generationId: run.generationId },
  );
}

export const scanDepartmentSources = internalMutation({
  args: { runId: v.id("summaryRuns"), generationId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const run = await ctx.db.get(args.runId);
    if (
      !run ||
      run.generationId !== args.generationId ||
      run.entity.kind !== "department" ||
      run.rollupPhase !== "scan_sources" ||
      !run.rollupScan
    ) return;
    const owner = await ownsRun(ctx, run);
    const departmentId = run.entity.departmentId;
    if (!owner || owner._id !== departmentId) return;
    if (
      owner.summaryRegenRequestedAgain ||
      (owner.summarySourceRevision ?? 0) !== (run.sourceRevision ?? 0)
    ) {
      await failSupersededRun(ctx, run, owner);
      return;
    }
    const scan = run.rollupScan;
    const page = await ctx.db
      .query("processes")
      .withIndex("by_clerkOrgId_and_departmentId", (q) =>
        q
          .eq("clerkOrgId", run.clerkOrgId)
          .eq("departmentId", departmentId),
      )
      .order("asc")
      .paginate({ numItems: PAGE_SIZE, cursor: scan.cursor ?? null });
    let hash = {
      first: scan.hashFirst,
      second: scan.hashSecond,
      length: scan.hashLength,
    };
    let eligible = scan.eligibleSources;
    let included = scan.includedSources;
    let current = scan.currentSources;
    let ordinal = scan.nextOrdinal;
    let chunkIndex = scan.nextChunkIndex;
    let pending = [...scan.pendingSources];
    for (const process of page.page) {
      const state = processState(process);
      const artifact = process.summaryV2;
      hash = updateHierarchySnapshotHashState(hash, {
        childId: process._id,
        label: process.name,
        state,
        artifactSnapshotHash: artifact?.provenance.sourceSnapshotHash ?? "",
        artifactPromptVersion: artifact?.provenance.promptVersion ?? "",
        artifactGeneratedAt: artifact?.provenance.generatedAt ?? 0,
      });
      eligible += 1;
      if (isUsableHierarchyChild(state) && artifact) {
        pending.push({
          kind: "process",
          key: `P${ordinal}`,
          processId: process._id,
          label: process.name,
          state,
          artifactSnapshotHash: artifact.provenance.sourceSnapshotHash,
          artifactPromptVersion: artifact.provenance.promptVersion,
          artifactGeneratedAt: artifact.provenance.generatedAt,
        });
        ordinal += 1;
        included += 1;
        if (state === "current") current += 1;
      }
    }
    if (pending.length >= SUMMARY_V2_CAPS.reduceChunkSources) {
      await insertRollupChunk(
        ctx,
        run,
        chunkIndex,
        pending.slice(0, SUMMARY_V2_CAPS.reduceChunkSources),
      );
      chunkIndex += 1;
      pending = pending.slice(SUMMARY_V2_CAPS.reduceChunkSources);
    }
    const nextScan = {
      cursor: page.isDone ? undefined : page.continueCursor,
      eligibleSources: eligible,
      includedSources: included,
      currentSources: current,
      completedSources: eligible,
      nextOrdinal: ordinal,
      nextChunkIndex: chunkIndex,
      hashFirst: hash.first,
      hashSecond: hash.second,
      hashLength: hash.length,
      pendingSources: pending,
    };
    if (!page.isDone) {
      await ctx.db.patch(run._id, {
        state: "running",
        progress: { stage: "rollup_reduce", completed: eligible, total: eligible + 1 },
        lastProgressAt: Date.now(),
        rollupScan: nextScan,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.hierarchySummaryV2.scanDepartmentSources,
        args,
      );
      return;
    }
    await finishSourceScan(ctx, run, owner, nextScan, hash);
  },
});

export const scanFunctionSources = internalMutation({
  args: { runId: v.id("summaryRuns"), generationId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const run = await ctx.db.get(args.runId);
    if (
      !run ||
      run.generationId !== args.generationId ||
      run.entity.kind !== "function" ||
      run.rollupPhase !== "scan_sources" ||
      !run.rollupScan
    ) return;
    const owner = await ownsRun(ctx, run);
    const functionId = run.entity.functionId;
    if (!owner || owner._id !== functionId) return;
    if (
      owner.summaryRegenRequestedAgain ||
      (owner.summarySourceRevision ?? 0) !== (run.sourceRevision ?? 0)
    ) {
      await failSupersededRun(ctx, run, owner);
      return;
    }
    const scan = run.rollupScan;
    const page = await ctx.db
      .query("departments")
      .withIndex("by_clerkOrgId_and_functionId", (q) =>
        q
          .eq("clerkOrgId", run.clerkOrgId)
          .eq("functionId", functionId),
      )
      .order("asc")
      .paginate({ numItems: PAGE_SIZE, cursor: scan.cursor ?? null });
    let hash = {
      first: scan.hashFirst,
      second: scan.hashSecond,
      length: scan.hashLength,
    };
    let eligible = scan.eligibleSources;
    let included = scan.includedSources;
    let current = scan.currentSources;
    let ordinal = scan.nextOrdinal;
    let chunkIndex = scan.nextChunkIndex;
    let pending = [...scan.pendingSources];
    for (const department of page.page) {
      const state = departmentState(department);
      const artifact = department.summaryV2;
      hash = updateHierarchySnapshotHashState(hash, {
        childId: department._id,
        label: department.name,
        state,
        artifactSnapshotHash: artifact?.provenance.sourceSnapshotHash ?? "",
        artifactPromptVersion: artifact?.provenance.promptVersion ?? "",
        artifactGeneratedAt: artifact?.provenance.generatedAt ?? 0,
      });
      eligible += 1;
      if (isUsableHierarchyChild(state) && artifact) {
        pending.push({
          kind: "department",
          key: `D${ordinal}`,
          departmentId: department._id,
          label: department.name,
          state,
          artifactSnapshotHash: artifact.provenance.sourceSnapshotHash,
          artifactPromptVersion: artifact.provenance.promptVersion,
          artifactGeneratedAt: artifact.provenance.generatedAt,
        });
        ordinal += 1;
        included += 1;
        if (state === "current") current += 1;
      }
    }
    if (pending.length >= SUMMARY_V2_CAPS.reduceChunkSources) {
      await insertRollupChunk(
        ctx,
        run,
        chunkIndex,
        pending.slice(0, SUMMARY_V2_CAPS.reduceChunkSources),
      );
      chunkIndex += 1;
      pending = pending.slice(SUMMARY_V2_CAPS.reduceChunkSources);
    }
    const nextScan = {
      cursor: page.isDone ? undefined : page.continueCursor,
      eligibleSources: eligible,
      includedSources: included,
      currentSources: current,
      completedSources: eligible,
      nextOrdinal: ordinal,
      nextChunkIndex: chunkIndex,
      hashFirst: hash.first,
      hashSecond: hash.second,
      hashLength: hash.length,
      pendingSources: pending,
    };
    if (!page.isDone) {
      await ctx.db.patch(run._id, {
        state: "running",
        progress: { stage: "rollup_reduce", completed: eligible, total: eligible + 1 },
        lastProgressAt: Date.now(),
        rollupScan: nextScan,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.hierarchySummaryV2.scanFunctionSources,
        args,
      );
      return;
    }
    await finishSourceScan(ctx, run, owner, nextScan, hash);
  },
});

export const claimHierarchyFinal = internalMutation({
  args: { runId: v.id("summaryRuns"), generationId: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (
      !run ||
      run.generationId !== args.generationId ||
      run.state !== "running" ||
      run.rollupPhase !== "final_reduce"
    ) return false;
    const owner = await ownsRun(ctx, run);
    if (!owner) return false;
    if (!isSummaryV2EnabledForOrg(owner.clerkOrgId)) {
      await ctx.db.patch(run._id, {
        state: "failed",
        error: runError(
          "feature_disabled",
          "Summary V2 was disabled before this run completed.",
          false,
        ),
        completedAt: Date.now(),
        lastProgressAt: Date.now(),
      });
      await scheduleFinish(ctx, run, owner);
      return false;
    }
    if (
      owner.summaryRegenRequestedAgain ||
      (owner.summarySourceRevision ?? 0) !== (run.sourceRevision ?? 0)
    ) {
      await failSupersededRun(ctx, run, owner);
      return false;
    }
    if (run.attempt >= run.maxAttempts) return false;
    await ctx.db.patch(run._id, {
      attempt: run.attempt + 1,
      error: undefined,
      lastProgressAt: Date.now(),
    });
    await ctx.db.patch(owner._id, { summaryRegenScheduledAt: Date.now() });
    return true;
  },
});

export const getHierarchyPromptPage = internalQuery({
  args: {
    runId: v.id("summaryRuns"),
    generationId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    const entity = run ? rollupEntity(run) : null;
    if (!run || !entity || run.generationId !== args.generationId) return null;
    const page = await ctx.db
      .query("summaryChunks")
      .withIndex("by_clerkOrgId_and_summaryRunId_and_chunkIndex", (q) =>
        q.eq("clerkOrgId", run.clerkOrgId).eq("summaryRunId", run._id),
      )
      .order("asc")
      .paginate({ numItems: 1, cursor: args.cursor });
    const sources: Array<
      DepartmentOverviewPromptSource | FunctionOverviewPromptSource
    > = [];
    const sourceMapEntries: Array<[string, SummarySourceRef]> = [];
    for (const chunk of page.page) {
      for (const input of chunk.rollupInputs ?? []) {
        if (entity.kind === "department" && input.kind === "process") {
          const process = await ctx.db.get(input.processId);
          if (
            !process ||
            process.clerkOrgId !== run.clerkOrgId ||
            process.departmentId !== entity.departmentId ||
            process.name !== input.label ||
            !process.summaryV2 ||
            processState(process) !== input.state ||
            process.summaryV2.provenance.sourceSnapshotHash !==
              input.artifactSnapshotHash ||
            process.summaryV2.provenance.promptVersion !==
              input.artifactPromptVersion ||
            process.summaryV2.provenance.generatedAt !== input.artifactGeneratedAt
          ) return { status: "source_changed" as const };
          sources.push({
            key: input.key,
            label: input.label,
            state: input.state,
            artifact: process.summaryV2,
          });
          sourceMapEntries.push([
            input.key,
            {
              kind: "process",
              processId: input.processId,
              label: input.label,
            },
          ]);
        } else if (entity.kind === "function" && input.kind === "department") {
          const department = await ctx.db.get(input.departmentId);
          if (
            !department ||
            department.clerkOrgId !== run.clerkOrgId ||
            department.functionId !== entity.functionId ||
            department.name !== input.label ||
            !department.summaryV2 ||
            departmentState(department) !== input.state ||
            department.summaryV2.provenance.sourceSnapshotHash !==
              input.artifactSnapshotHash ||
            department.summaryV2.provenance.promptVersion !==
              input.artifactPromptVersion ||
            department.summaryV2.provenance.generatedAt !==
              input.artifactGeneratedAt
          ) return { status: "source_changed" as const };
          sources.push({
            key: input.key,
            label: input.label,
            state: input.state,
            artifact: department.summaryV2,
          });
          sourceMapEntries.push([
            input.key,
            {
              kind: "department",
              departmentId: input.departmentId,
              label: input.label,
            },
          ]);
        } else {
          return { status: "source_changed" as const };
        }
      }
    }
    const owner =
      entity.kind === "department"
        ? await ctx.db.get(entity.departmentId)
        : await ctx.db.get(entity.functionId);
    if (!owner || owner.clerkOrgId !== run.clerkOrgId) return null;
    return {
      status: "ready" as const,
      sources,
      sourceMapEntries,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      entity,
      entityName: owner.name,
      clerkOrgId: run.clerkOrgId,
      sourceRevision: run.sourceRevision ?? 0,
      sourceSnapshot: run.sourceSnapshot,
      actorUserId: run.actorUserId ?? null,
    };
  },
});

type LoadedPrompt = {
  entity: RollupEntity;
  entityName: string;
  clerkOrgId: string;
  sourceRevision: number;
  sourceSnapshot: Doc<"summaryRuns">["sourceSnapshot"];
  actorUserId: Id<"users"> | null;
  sources: Array<DepartmentOverviewPromptSource | FunctionOverviewPromptSource>;
  sourceByKey: SummarySourceKeyMap;
};

type HierarchyPromptPage =
  | { status: "source_changed" }
  | {
      status: "ready";
      sources: Array<
        DepartmentOverviewPromptSource | FunctionOverviewPromptSource
      >;
      sourceMapEntries: Array<[string, SummarySourceRef]>;
      continueCursor: string;
      isDone: boolean;
      entity: RollupEntity;
      entityName: string;
      clerkOrgId: string;
      sourceRevision: number;
      sourceSnapshot: Doc<"summaryRuns">["sourceSnapshot"];
      actorUserId: Id<"users"> | null;
    };

async function loadHierarchyPrompt(
  ctx: ActionCtx,
  runId: Id<"summaryRuns">,
  generationId: string,
): Promise<LoadedPrompt | null> {
  let cursor: string | null = null;
  let loaded: LoadedPrompt | null = null;
  do {
    const page: HierarchyPromptPage | null = await ctx.runQuery(
      internal.hierarchySummaryV2.getHierarchyPromptPage,
      { runId, generationId, cursor },
    );
    if (!page || page.status === "source_changed") return null;
    if (loaded === null) {
      loaded = {
        entity: page.entity,
        entityName: page.entityName,
        clerkOrgId: page.clerkOrgId,
        sourceRevision: page.sourceRevision,
        sourceSnapshot: page.sourceSnapshot,
        actorUserId: page.actorUserId,
        sources: page.sources,
        sourceByKey: Object.fromEntries(page.sourceMapEntries),
      };
    } else {
      loaded.sources.push(...page.sources);
      loaded.sourceByKey = {
        ...loaded.sourceByKey,
        ...Object.fromEntries(page.sourceMapEntries),
      };
    }
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  return loaded;
}

export const generateHierarchyFinal = internalAction({
  args: { runId: v.id("summaryRuns"), generationId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const claimed: boolean = await ctx.runMutation(
      internal.hierarchySummaryV2.claimHierarchyFinal,
      args,
    );
    if (!claimed) return;
    try {
      if (!isAIConfigured("synthesis")) throw new Error("not_configured");
      const loaded = await loadHierarchyPrompt(
        ctx,
        args.runId,
        args.generationId,
      );
      if (
        !loaded ||
        loaded.sources.length === 0 ||
        loaded.sources.length !== loaded.sourceSnapshot.includedSources
      ) {
        throw new Error("source_changed");
      }
      const isDepartment = loaded.entity.kind === "department";
      const request = isDepartment
        ? buildDepartmentOverviewRequest({
            departmentName: loaded.entityName,
            sources: loaded.sources as DepartmentOverviewPromptSource[],
          })
        : buildFunctionOverviewRequest({
            functionName: loaded.entityName,
            sources: loaded.sources as FunctionOverviewPromptSource[],
          });
      const entityId =
        loaded.entity.kind === "department"
          ? loaded.entity.departmentId
          : loaded.entity.functionId;
      const completion = await meteredCompletion(
        ctx,
        {
          clerkOrgId: loaded.clerkOrgId,
          entityType: isDepartment ? "department" : "function",
          entityId,
          entityLabel: loaded.entityName,
          actorUserId: loaded.actorUserId ?? undefined,
          runId: args.generationId,
        },
        request,
      );
      assertCompletionNotTruncated(
        completion,
        isDepartment
          ? DEPARTMENT_OVERVIEW_V2_OPERATION
          : FUNCTION_OVERVIEW_V2_OPERATION,
        SUMMARY_V2_AI_BUDGETS.hierarchyFinalReduce.maxTokens,
      );
      const coverage: SummaryCoverage = {
        includedSources: loaded.sourceSnapshot.includedSources,
        totalEligibleSources: loaded.sourceSnapshot.totalEligibleSources,
        complete:
          loaded.sourceSnapshot.complete === true &&
          loaded.sourceSnapshot.currentSources ===
            loaded.sourceSnapshot.totalEligibleSources,
      };
      const provenance = {
        sourceSnapshotHash: loaded.sourceSnapshot.hash,
        generatedAt: Date.now(),
        promptVersion: isDepartment
          ? SUMMARY_V2_PROMPT_VERSIONS.departmentOverview
          : SUMMARY_V2_PROMPT_VERSIONS.functionOverview,
        provider: completion.provider,
        model: completion.model,
      };
      const artifact = isDepartment
        ? normalizeDepartmentOverviewArtifactV2(completion.toolInput, {
            sourceByKey: loaded.sourceByKey,
            coverage,
            provenance,
          })
        : normalizeFunctionOverviewArtifactV2(completion.toolInput, {
            sourceByKey: loaded.sourceByKey,
            coverage,
            provenance,
          });
      if (!artifact) throw new Error("invalid_output");
      if (isDepartment) {
        await ctx.runMutation(internal.hierarchySummaryV2.saveDepartmentFinal, {
          ...args,
          sourceRevision: loaded.sourceRevision,
          artifact: artifact as DepartmentOverviewArtifactV2,
        });
      } else {
        await ctx.runMutation(internal.hierarchySummaryV2.saveFunctionFinal, {
          ...args,
          sourceRevision: loaded.sourceRevision,
          artifact: artifact as FunctionOverviewArtifactV2,
        });
      }
    } catch (error) {
      await ctx.runMutation(internal.hierarchySummaryV2.failHierarchyFinal, {
        ...args,
        ...actionFailure(error),
      });
    }
  },
});

async function saveFinal(
  ctx: MutationCtx,
  args: {
    runId: Id<"summaryRuns">;
    generationId: string;
    sourceRevision: number;
    artifact: DepartmentOverviewArtifactV2 | FunctionOverviewArtifactV2;
  },
  expectedKind: "department" | "function",
) {
  const run = await ctx.db.get(args.runId);
  if (
    !run ||
    run.generationId !== args.generationId ||
    run.entity.kind !== expectedKind
  ) return { saved: false };
  const owner = await ownsRun(ctx, run);
  if (!owner) return { saved: false };
  if (
    !isSummaryV2EnabledForOrg(owner.clerkOrgId) ||
    owner.summaryRegenRequestedAgain ||
    (owner.summarySourceRevision ?? 0) !== args.sourceRevision ||
    (run.sourceRevision ?? 0) !== args.sourceRevision ||
    args.artifact.provenance.sourceSnapshotHash !== run.sourceSnapshot.hash
  ) {
    await failSupersededRun(ctx, run, owner);
    return { saved: false };
  }
  const snapshotChanged =
    owner.summaryV2?.provenance.sourceSnapshotHash !==
    args.artifact.provenance.sourceSnapshotHash;
  const now = Date.now();
  const legacySummary = renderSummaryV2AsLegacyMarkdown(args.artifact);
  if (expectedKind === "department") {
    const department = owner as Doc<"departments">;
    await ctx.db.patch(department._id, {
      summaryV2: args.artifact as DepartmentOverviewArtifactV2,
      summary: legacySummary,
      summaryUpdatedAt: args.artifact.provenance.generatedAt,
      summaryStale: false,
      summaryV2SourceRevision: args.sourceRevision,
    });
  } else {
    const fn = owner as Doc<"functions">;
    await ctx.db.patch(fn._id, {
      summaryV2: args.artifact as FunctionOverviewArtifactV2,
      summary: legacySummary,
      summaryUpdatedAt: args.artifact.provenance.generatedAt,
      summaryStale: false,
      summaryV2SourceRevision: args.sourceRevision,
    });
  }
  await ctx.db.patch(run._id, {
    state: args.artifact.coverage.complete ? "succeeded" : "partial",
    progress: { stage: "final_reduce", completed: 1, total: 1 },
    error: undefined,
    completedAt: now,
    lastProgressAt: now,
  });
  if (
    expectedKind === "department" &&
    run.entity.kind === "department" &&
    (snapshotChanged || run.forceRefresh)
  ) {
    const department = owner as Doc<"departments">;
    await ctx.runMutation(internal.summariesHelpers.markFunctionSummaryStale, {
      functionId: department.functionId,
    });
  }
  await scheduleFinish(ctx, run, owner);
  return { saved: true };
}

export const saveDepartmentFinal = internalMutation({
  args: {
    runId: v.id("summaryRuns"),
    generationId: v.string(),
    sourceRevision: v.number(),
    artifact: departmentOverviewArtifactV2Validator,
  },
  handler: async (ctx, args) => saveFinal(ctx, args, "department"),
});

export const saveFunctionFinal = internalMutation({
  args: {
    runId: v.id("summaryRuns"),
    generationId: v.string(),
    sourceRevision: v.number(),
    artifact: functionOverviewArtifactV2Validator,
  },
  handler: async (ctx, args) => saveFinal(ctx, args, "function"),
});

export const failHierarchyFinal = internalMutation({
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
    const owner = await ownsRun(ctx, run);
    if (!owner) return;
    const error = runError(args.code, args.message, args.retryable);
    if (args.retryable && run.attempt < run.maxAttempts) {
      await ctx.db.patch(run._id, { error, lastProgressAt: Date.now() });
      await ctx.scheduler.runAfter(
        0,
        internal.hierarchySummaryV2.generateHierarchyFinal,
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
    await scheduleFinish(ctx, run, owner);
  },
});

export const finishRollupRun = internalMutation({
  args: {
    entity: v.union(
      v.object({ kind: v.literal("department"), departmentId: v.id("departments") }),
      v.object({ kind: v.literal("function"), functionId: v.id("functions") }),
    ),
    clerkOrgId: v.string(),
    generationId: v.string(),
    runId: v.id("summaryRuns"),
  },
  handler: async (ctx, args): Promise<void> => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.generationId !== args.generationId) return;
    if (
      (args.entity.kind === "department" &&
        (run.entity.kind !== "department" ||
          run.entity.departmentId !== args.entity.departmentId)) ||
      (args.entity.kind === "function" &&
        (run.entity.kind !== "function" ||
          run.entity.functionId !== args.entity.functionId))
    ) return;
    const owner = await ownsRun(ctx, run);
    if (!owner || owner.clerkOrgId !== args.clerkOrgId) return;
    const terminalPatch = {
      summaryV2LastRunState: run.state,
      summaryV2LastError: run.error,
      summaryV2LastCompletedAt: run.completedAt ?? Date.now(),
    };
    if (!isSummaryV2EnabledForOrg(owner.clerkOrgId)) {
      await ctx.db.patch(owner._id, {
        ...terminalPatch,
        summaryRegenScheduledAt: undefined,
        summaryRegenRequestedAgain: undefined,
        summaryForceRefreshRequested: undefined,
        summaryV2GenerationId: undefined,
        summaryV2RunId: undefined,
      });
    } else if (owner.summaryRegenRequestedAgain) {
      const generationId = crypto.randomUUID();
      const forceRefresh = owner.summaryForceRefreshRequested ?? false;
      await ctx.db.patch(owner._id, {
        ...terminalPatch,
        summaryRegenScheduledAt: Date.now(),
        summaryRegenRequestedAgain: false,
        summaryForceRefreshRequested: false,
        summaryV2GenerationId: generationId,
        summaryV2RunId: undefined,
      });
      if (args.entity.kind === "department") {
        await ctx.scheduler.runAfter(
          0,
          internal.hierarchySummaryV2.startDepartmentRun,
          {
            departmentId: args.entity.departmentId,
            clerkOrgId: args.clerkOrgId,
            generationId,
            forceRefresh,
          },
        );
      } else {
        await ctx.scheduler.runAfter(
          0,
          internal.hierarchySummaryV2.startFunctionRun,
          {
            functionId: args.entity.functionId,
            clerkOrgId: args.clerkOrgId,
            generationId,
            forceRefresh,
          },
        );
      }
    } else {
      await ctx.db.patch(owner._id, {
        ...terminalPatch,
        summaryRegenScheduledAt: undefined,
        summaryRegenRequestedAgain: undefined,
        summaryForceRefreshRequested: undefined,
        summaryV2GenerationId: undefined,
        summaryV2RunId: undefined,
      });
    }
    await ctx.scheduler.runAfter(
      0,
      internal.hierarchySummaryV2.cleanupSupersededRollupRuns,
      { entity: args.entity, clerkOrgId: args.clerkOrgId },
    );
  },
});

export const cleanupSupersededRollupRuns = internalMutation({
  args: {
    entity: v.union(
      v.object({ kind: v.literal("department"), departmentId: v.id("departments") }),
      v.object({ kind: v.literal("function"), functionId: v.id("functions") }),
    ),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const terminal: Doc<"summaryRuns">[] = [];
    const key = entityKey(args.entity);
    for (const state of TERMINAL_STATES) {
      const rows = await ctx.db
        .query("summaryRuns")
        .withIndex("by_clerkOrgId_and_entityKey_and_state_and_createdAt", (q) =>
          q
            .eq("clerkOrgId", args.clerkOrgId)
            .eq("entityKey", key)
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
    if (chunks.length < CLEANUP_BATCH_SIZE) await ctx.db.delete(obsolete._id);
    await ctx.scheduler.runAfter(
      0,
      internal.hierarchySummaryV2.cleanupSupersededRollupRuns,
      args,
    );
  },
});

export const deleteRollupRunsForEntity = internalMutation({
  args: {
    entity: v.union(
      v.object({ kind: v.literal("department"), departmentId: v.id("departments") }),
      v.object({ kind: v.literal("function"), functionId: v.id("functions") }),
    ),
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const key = entityKey(args.entity);
    let target: Doc<"summaryRuns"> | null = null;
    for (const state of [
      "queued",
      "running",
      "succeeded",
      "partial",
      "failed",
    ] as const) {
      target = await ctx.db
        .query("summaryRuns")
        .withIndex("by_clerkOrgId_and_entityKey_and_state_and_createdAt", (q) =>
          q
            .eq("clerkOrgId", args.clerkOrgId)
            .eq("entityKey", key)
            .eq("state", state),
        )
        .first();
      if (target) break;
    }
    if (!target) return;
    const chunks = await ctx.db
      .query("summaryChunks")
      .withIndex("by_clerkOrgId_and_summaryRunId_and_chunkIndex", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("summaryRunId", target!._id),
      )
      .take(CLEANUP_BATCH_SIZE);
    for (const chunk of chunks) await ctx.db.delete(chunk._id);
    if (chunks.length < CLEANUP_BATCH_SIZE) await ctx.db.delete(target._id);
    await ctx.scheduler.runAfter(
      0,
      internal.hierarchySummaryV2.deleteRollupRunsForEntity,
      args,
    );
  },
});

export const reapStuckHierarchySummaryRuns = internalMutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const cutoff = Date.now() - RUN_STALE_MS;
    const stale: Doc<"summaryRuns">[] = [];
    for (const state of ["queued", "running"] as const) {
      stale.push(
        ...(await ctx.db
          .query("summaryRuns")
          .withIndex("by_state_and_lastProgressAt", (q) =>
            q.eq("state", state).lt("lastProgressAt", cutoff),
          )
          .take(20)),
      );
    }
    for (const run of stale) {
      const entity = rollupEntity(run);
      if (!entity) continue;
      const owner = await ownsRun(ctx, run);
      if (!owner) continue;
      if (!isSummaryV2EnabledForOrg(owner.clerkOrgId) || run.resumeCount >= MAX_RESUMES) {
        await ctx.db.patch(run._id, {
          state: "failed",
          error: runError(
            isSummaryV2EnabledForOrg(owner.clerkOrgId) ? "watchdog_exhausted" : "feature_disabled",
            isSummaryV2EnabledForOrg(owner.clerkOrgId)
              ? "Summary generation stopped after repeated recovery attempts."
              : "Summary V2 was disabled before this run completed.",
            false,
          ),
          completedAt: Date.now(),
          lastProgressAt: Date.now(),
        });
        await scheduleFinish(ctx, run, owner);
        continue;
      }
      await ctx.db.patch(run._id, {
        resumeCount: run.resumeCount + 1,
        lastProgressAt: Date.now(),
      });
      await ctx.db.patch(owner._id, { summaryRegenScheduledAt: Date.now() });
      const resumeArgs = { runId: run._id, generationId: run.generationId };
      if (run.rollupPhase === "refresh_children") {
        await ctx.scheduler.runAfter(
          0,
          internal.hierarchySummaryV2.prepareFunctionChildren,
          resumeArgs,
        );
      } else if (run.rollupPhase === "wait_children") {
        await ctx.scheduler.runAfter(
          0,
          internal.hierarchySummaryV2.waitForFunctionChildren,
          resumeArgs,
        );
      } else if (run.rollupPhase === "scan_sources") {
        await ctx.scheduler.runAfter(
          0,
          entity.kind === "department"
            ? internal.hierarchySummaryV2.scanDepartmentSources
            : internal.hierarchySummaryV2.scanFunctionSources,
          resumeArgs,
        );
      } else if (run.rollupPhase === "final_reduce") {
        await ctx.scheduler.runAfter(
          0,
          internal.hierarchySummaryV2.generateHierarchyFinal,
          resumeArgs,
        );
      }
    }
  },
});
