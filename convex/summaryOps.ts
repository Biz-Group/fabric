/**
 * Operational reporting for the Summary V2 rollout and soak.
 *
 * Everything here is an `internalQuery`: these reports read across tenants and
 * are meant to be run from the Convex dashboard or CLI by an operator, never
 * exposed to an application client. They are read-only and bounded — each one
 * takes an explicit row limit and never collects an unbounded table — so a
 * report on a large deployment degrades into "sampled", never into a failed
 * transaction.
 *
 * See docs/summary-overview-v2-rollout-runbook.md for the thresholds these
 * numbers are judged against.
 */

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { CONVERSATION_EVIDENCE_V2_OPERATION } from "./lib/conversationEvidenceV2";
import {
  DEPARTMENT_OVERVIEW_V2_OPERATION,
  FUNCTION_OVERVIEW_V2_OPERATION,
} from "./lib/hierarchyOverviewV2";
import {
  PROCESS_OVERVIEW_V2_CHUNK_OPERATION,
  PROCESS_OVERVIEW_V2_FINAL_OPERATION,
} from "./lib/processOverviewV2";
import { evaluateSummaryArtifact } from "./lib/summaryEvaluation";
import { summaryV2Rollout } from "./lib/summaryV2Feature";
import type { SummaryArtifactV2 } from "./summaryV2";

/**
 * Every AI operation the Summary V2 pipeline can bill, tagged with the level
 * whose cost it belongs to. Cost per hierarchy level is a rollout gate, and it
 * is only answerable if the mapping is stated once, here.
 */
const SUMMARY_V2_STAGES = [
  {
    operation: CONVERSATION_EVIDENCE_V2_OPERATION,
    stage: "evidence",
    level: "conversation",
  },
  {
    operation: PROCESS_OVERVIEW_V2_CHUNK_OPERATION,
    stage: "chunk_reduce",
    level: "process",
  },
  {
    operation: PROCESS_OVERVIEW_V2_FINAL_OPERATION,
    stage: "final_reduce",
    level: "process",
  },
  {
    operation: DEPARTMENT_OVERVIEW_V2_OPERATION,
    stage: "rollup_reduce",
    level: "department",
  },
  {
    operation: FUNCTION_OVERVIEW_V2_OPERATION,
    stage: "rollup_reduce",
    level: "function",
  },
] as const;

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_ROW_LIMIT = 1_000;
const MAX_ROW_LIMIT = 4_000;

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_ROW_LIMIT;
  return Math.max(1, Math.min(MAX_ROW_LIMIT, Math.floor(limit)));
}

/** Nearest-rank percentile over an already-sorted ascending array. */
function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

type StageAccumulator = {
  stage: string;
  level: string;
  operation: string;
  calls: number;
  failed: number;
  truncated: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  latencies: number[];
};

/**
 * Per-stage latency and token cost for the V2 pipeline.
 *
 * Reads the usage ledger, which is the only place per-tenant AI spend exists:
 * every tenant shares one provider deployment, so provider telemetry cannot
 * answer this.
 */
export const stageCostReport = internalQuery({
  args: {
    sinceMs: v.optional(v.number()),
    clerkOrgId: v.optional(v.string()),
    rowLimitPerOperation: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const since = args.sinceMs ?? Date.now() - DEFAULT_WINDOW_MS;
    const limit = boundedLimit(args.rowLimitPerOperation);
    const stages: StageAccumulator[] = [];
    let sampledRows = 0;
    let truncatedSample = false;

    for (const definition of SUMMARY_V2_STAGES) {
      const rows = await ctx.db
        .query("aiUsageEvents")
        .withIndex("by_operation_and_createdAt", (q) =>
          q.eq("operation", definition.operation).gte("createdAt", since),
        )
        .take(limit);
      if (rows.length === limit) truncatedSample = true;

      const accumulator: StageAccumulator = {
        stage: definition.stage,
        level: definition.level,
        operation: definition.operation,
        calls: 0,
        failed: 0,
        truncated: 0,
        inputTokens: 0,
        outputTokens: 0,
        costMicroUsd: 0,
        latencies: [],
      };
      for (const row of rows) {
        if (args.clerkOrgId && row.clerkOrgId !== args.clerkOrgId) continue;
        sampledRows += 1;
        accumulator.calls += 1;
        if (row.status === "failed") accumulator.failed += 1;
        if (row.status === "truncated") accumulator.truncated += 1;
        accumulator.inputTokens += row.inputTokens ?? 0;
        accumulator.outputTokens += row.outputTokens ?? 0;
        accumulator.costMicroUsd += row.costMicroUsd;
        if (row.latencyMs !== undefined) {
          accumulator.latencies.push(row.latencyMs);
        }
      }
      stages.push(accumulator);
    }

    const byStage = stages.map((accumulator) => {
      const sorted = [...accumulator.latencies].sort((a, b) => a - b);
      return {
        stage: accumulator.stage,
        level: accumulator.level,
        operation: accumulator.operation,
        calls: accumulator.calls,
        failed: accumulator.failed,
        truncated: accumulator.truncated,
        inputTokens: accumulator.inputTokens,
        outputTokens: accumulator.outputTokens,
        costMicroUsd: accumulator.costMicroUsd,
        costPerCallMicroUsd:
          accumulator.calls === 0
            ? null
            : Math.round(accumulator.costMicroUsd / accumulator.calls),
        latencyMs: {
          p50: percentile(sorted, 0.5),
          p95: percentile(sorted, 0.95),
          max: sorted.length === 0 ? null : sorted[sorted.length - 1],
        },
      };
    });

    const byLevel = new Map<
      string,
      { level: string; calls: number; costMicroUsd: number; outputTokens: number }
    >();
    for (const stage of byStage) {
      const entry = byLevel.get(stage.level) ?? {
        level: stage.level,
        calls: 0,
        costMicroUsd: 0,
        outputTokens: 0,
      };
      entry.calls += stage.calls;
      entry.costMicroUsd += stage.costMicroUsd;
      entry.outputTokens += stage.outputTokens;
      byLevel.set(stage.level, entry);
    }

    return {
      since,
      clerkOrgId: args.clerkOrgId ?? null,
      sampledRows,
      // True when any stage hit the row limit, so the operator knows the
      // figures are a floor rather than the full window.
      truncatedSample,
      byStage,
      byLevel: [...byLevel.values()],
      totalCostMicroUsd: byStage.reduce(
        (total, stage) => total + stage.costMicroUsd,
        0,
      ),
    };
  },
});

/**
 * Run reliability during the soak: stalled runs, retries, terminal failures,
 * and partial artifacts. These are the symptoms the soak is watching for.
 */
export const runHealthReport = internalQuery({
  args: {
    stalledAfterMs: v.optional(v.number()),
    rowLimitPerState: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const stalledAfterMs = args.stalledAfterMs ?? 15 * 60_000;
    const limit = boundedLimit(args.rowLimitPerState);
    const states = [
      "queued",
      "running",
      "succeeded",
      "partial",
      "failed",
    ] as const;

    const byState: Array<{ state: string; count: number; sampled: boolean }> =
      [];
    const stalled: Array<{
      runId: string;
      clerkOrgId: string;
      entityKey: string;
      state: string;
      stage: string;
      ageMs: number;
      attempt: number;
      resumeCount: number;
    }> = [];
    const errorCounts = new Map<string, number>();
    let retriedRuns = 0;
    let resumedRuns = 0;
    let partialSnapshots = 0;

    for (const state of states) {
      const rows = await ctx.db
        .query("summaryRuns")
        .withIndex("by_state_and_lastProgressAt", (q) => q.eq("state", state))
        .order("desc")
        .take(limit);
      byState.push({
        state,
        count: rows.length,
        sampled: rows.length === limit,
      });

      for (const run of rows) {
        if (run.attempt > 1) retriedRuns += 1;
        if (run.resumeCount > 0) resumedRuns += 1;
        if (run.sourceSnapshot.complete === false) partialSnapshots += 1;
        if (run.error) {
          errorCounts.set(
            run.error.code,
            (errorCounts.get(run.error.code) ?? 0) + 1,
          );
        }
        if (state !== "queued" && state !== "running") continue;
        const lastActivity = run.lastProgressAt ?? run.startedAt ?? run.createdAt;
        const ageMs = now - lastActivity;
        if (ageMs < stalledAfterMs) continue;
        stalled.push({
          runId: run._id,
          clerkOrgId: run.clerkOrgId,
          entityKey: run.entityKey,
          state: run.state,
          stage: run.progress.stage,
          ageMs,
          attempt: run.attempt,
          resumeCount: run.resumeCount,
        });
      }
    }

    return {
      now,
      stalledAfterMs,
      rollout: describeRollout(),
      byState,
      retriedRuns,
      resumedRuns,
      partialSnapshots,
      errorsByCode: [...errorCounts.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count),
      stalled: stalled.sort((a, b) => b.ageMs - a.ageMs).slice(0, 50),
    };
  },
});

function describeRollout() {
  const rollout = summaryV2Rollout();
  return rollout.mode === "allowlist"
    ? { mode: rollout.mode, orgCount: rollout.orgIds.size }
    : { mode: rollout.mode, orgCount: null };
}

type AuditRow = {
  clerkOrgId: string;
  level: "process" | "department" | "function";
  entityId: string;
  name: string;
  failures: string[];
};

function auditArtifact(
  row: {
    _id: string;
    clerkOrgId: string;
    name: string;
    summaryV2?: SummaryArtifactV2;
  },
  level: "process" | "department" | "function",
): AuditRow | null {
  if (!row.summaryV2) return null;
  const report = evaluateSummaryArtifact(row.summaryV2);
  if (report.passed) return null;
  return {
    clerkOrgId: row.clerkOrgId,
    level,
    entityId: row._id,
    name: row.name,
    // Bounded so one badly generated artifact cannot dominate the report.
    failures: report.failures.slice(0, 10),
  };
}

async function orgIdsToAudit(
  ctx: QueryCtx,
  clerkOrgId: string | undefined,
  limit: number,
): Promise<string[]> {
  if (clerkOrgId) return [clerkOrgId];
  const tenants = await ctx.db.query("tenants").take(limit);
  return tenants.map((tenant: Doc<"tenants">) => tenant.clerkOrgId);
}

/**
 * Runs the release-gate scorers over stored artifacts. This is the production
 * counterpart to the golden-set suite: the fixtures prove the gates are right,
 * this proves the live artifacts pass them.
 */
export const auditStoredArtifacts = internalQuery({
  args: {
    clerkOrgId: v.optional(v.string()),
    rowLimitPerTable: v.optional(v.number()),
    orgLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = boundedLimit(args.rowLimitPerTable);
    const orgIds = await orgIdsToAudit(ctx, args.clerkOrgId, args.orgLimit ?? 50);
    const violations: AuditRow[] = [];
    let auditedArtifacts = 0;

    for (const orgId of orgIds) {
      const processes = await ctx.db
        .query("processes")
        .withIndex("by_clerkOrgId_and_departmentId", (q) =>
          q.eq("clerkOrgId", orgId),
        )
        .take(limit);
      const departments = await ctx.db
        .query("departments")
        .withIndex("by_clerkOrgId_and_functionId", (q) =>
          q.eq("clerkOrgId", orgId),
        )
        .take(limit);
      const functions = await ctx.db
        .query("functions")
        .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", orgId))
        .take(limit);

      for (const row of processes) {
        if (!row.summaryV2) continue;
        auditedArtifacts += 1;
        const violation = auditArtifact(row, "process");
        if (violation) violations.push(violation);
      }
      for (const row of departments) {
        if (!row.summaryV2) continue;
        auditedArtifacts += 1;
        const violation = auditArtifact(row, "department");
        if (violation) violations.push(violation);
      }
      for (const row of functions) {
        if (!row.summaryV2) continue;
        auditedArtifacts += 1;
        const violation = auditArtifact(row, "function");
        if (violation) violations.push(violation);
      }
    }

    const byCategory = new Map<string, number>();
    for (const violation of violations) {
      for (const failure of violation.failures) {
        const category = failure.split(/[ (:]/)[0];
        byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
      }
    }

    return {
      organizationsAudited: orgIds.length,
      auditedArtifacts,
      cleanArtifacts: auditedArtifacts - violations.length,
      violations: violations.slice(0, 100),
      violationsByCategory: [...byCategory.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
      // The gate is binary: any violating stored artifact blocks the phase.
      passed: violations.length === 0,
    };
  },
});

/**
 * Phase 11 input: what share of summaries that exist at all are structured V2
 * artifacts. `withAnySummary` is the denominator that matters — an entity that
 * has never been summarized is not evidence for or against migration.
 */
export const v2CoverageReport = internalQuery({
  args: {
    clerkOrgId: v.optional(v.string()),
    rowLimitPerTable: v.optional(v.number()),
    orgLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = boundedLimit(args.rowLimitPerTable);
    const orgIds = await orgIdsToAudit(ctx, args.clerkOrgId, args.orgLimit ?? 50);

    type LevelTotals = {
      level: string;
      rows: number;
      withAnySummary: number;
      withV2: number;
      legacyOnly: number;
      staleV2: number;
      partialV2: number;
    };
    const totals: Record<string, LevelTotals> = {
      process: {
        level: "process",
        rows: 0,
        withAnySummary: 0,
        withV2: 0,
        legacyOnly: 0,
        staleV2: 0,
        partialV2: 0,
      },
      department: {
        level: "department",
        rows: 0,
        withAnySummary: 0,
        withV2: 0,
        legacyOnly: 0,
        staleV2: 0,
        partialV2: 0,
      },
      function: {
        level: "function",
        rows: 0,
        withAnySummary: 0,
        withV2: 0,
        legacyOnly: 0,
        staleV2: 0,
        partialV2: 0,
      },
    };

    const count = (
      level: keyof typeof totals,
      row: {
        summaryV2?: SummaryArtifactV2;
        legacyMarkdown?: string;
        stale: boolean;
      },
    ) => {
      const entry = totals[level];
      entry.rows += 1;
      const hasLegacy = Boolean(row.legacyMarkdown?.trim());
      const hasV2 = Boolean(row.summaryV2);
      if (hasLegacy || hasV2) entry.withAnySummary += 1;
      if (hasV2) {
        entry.withV2 += 1;
        if (row.stale) entry.staleV2 += 1;
        if (row.summaryV2 && !row.summaryV2.coverage.complete) {
          entry.partialV2 += 1;
        }
      } else if (hasLegacy) {
        entry.legacyOnly += 1;
      }
    };

    for (const orgId of orgIds) {
      for (const row of await ctx.db
        .query("processes")
        .withIndex("by_clerkOrgId_and_departmentId", (q) =>
          q.eq("clerkOrgId", orgId),
        )
        .take(limit)) {
        count("process", {
          summaryV2: row.summaryV2,
          legacyMarkdown: row.rollingSummary,
          stale:
            row.summaryV2SourceRevision !== undefined &&
            row.summaryV2SourceRevision !== (row.summaryEvidenceRevision ?? 0),
        });
      }
      for (const row of await ctx.db
        .query("departments")
        .withIndex("by_clerkOrgId_and_functionId", (q) =>
          q.eq("clerkOrgId", orgId),
        )
        .take(limit)) {
        count("department", {
          summaryV2: row.summaryV2,
          legacyMarkdown: row.summary,
          stale: row.summaryStale === true,
        });
      }
      for (const row of await ctx.db
        .query("functions")
        .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", orgId))
        .take(limit)) {
        count("function", {
          summaryV2: row.summaryV2,
          legacyMarkdown: row.summary,
          stale: row.summaryStale === true,
        });
      }
    }

    const byLevel = Object.values(totals).map((entry) => ({
      ...entry,
      v2Share:
        entry.withAnySummary === 0
          ? null
          : Number((entry.withV2 / entry.withAnySummary).toFixed(4)),
    }));
    const withAnySummary = byLevel.reduce(
      (total, entry) => total + entry.withAnySummary,
      0,
    );
    const withV2 = byLevel.reduce((total, entry) => total + entry.withV2, 0);

    return {
      rollout: describeRollout(),
      organizationsScanned: orgIds.length,
      byLevel,
      overall: {
        withAnySummary,
        withV2,
        v2Share:
          withAnySummary === 0
            ? null
            : Number((withV2 / withAnySummary).toFixed(4)),
      },
    };
  },
});
