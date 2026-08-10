/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";
import {
  SUMMARY_V2_PROMPT_VERSIONS,
  type ProcessOverviewArtifactV2,
} from "./summaryV2";

const modules = import.meta.glob("./**/*.ts");
const ORG = "org_summary_ops";
const OTHER_ORG = "org_summary_ops_other";
const NOW = 1_786_000_000_000;
const originalSummaryV2 = process.env.SUMMARY_V2;

function usageRow(
  operation: string,
  overrides: {
    clerkOrgId?: string;
    createdAt?: number;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    costMicroUsd?: number;
    status?: "ok" | "truncated" | "failed";
    key: string;
  },
) {
  return {
    deployment: "dev" as const,
    idempotencyKey: overrides.key,
    createdAt: overrides.createdAt ?? NOW,
    clerkOrgId: overrides.clerkOrgId ?? ORG,
    unit: "tokens" as const,
    operation,
    provider: "fabric-foundry",
    model: "test-model",
    status: overrides.status ?? ("ok" as const),
    inputTokens: overrides.inputTokens ?? 1_000,
    outputTokens: overrides.outputTokens ?? 500,
    costMicroUsd: overrides.costMicroUsd ?? 1_200,
    priceVersion: "test-prices",
    costSource: "computed" as const,
    latencyMs: overrides.latencyMs,
  };
}

function processArtifact(
  overrides: Partial<ProcessOverviewArtifactV2> = {},
): ProcessOverviewArtifactV2 {
  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    headline: "Requests are reviewed before work begins",
    executiveBrief: "A coordinator checks each request and routes it onward.",
    scope: [],
    consensus: [],
    variations: [],
    gaps: [],
    notable: [],
    coverage: {
      includedSources: 2,
      totalEligibleSources: 2,
      uniqueContributors: 2,
      complete: true,
    },
    provenance: {
      sourceSnapshotHash: "ops-snapshot",
      generatedAt: NOW,
      promptVersion: SUMMARY_V2_PROMPT_VERSIONS.processOverview,
      provider: "fabric-foundry",
      model: "test-model",
    },
    ...overrides,
  };
}

async function seedHierarchy(
  ctx: MutationCtx,
  orgId: string,
  processFields: Record<string, unknown> = {},
) {
  await ctx.db.insert("tenants", {
    clerkOrgId: orgId,
    name: `Tenant ${orgId}`,
    slug: orgId,
    allowedEmailDomains: [],
    status: "active",
    source: "console",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const functionId = await ctx.db.insert("functions", {
    name: "Operations",
    sortOrder: 1,
    clerkOrgId: orgId,
  });
  const departmentId = await ctx.db.insert("departments", {
    functionId,
    name: "Service",
    sortOrder: 1,
    clerkOrgId: orgId,
  });
  const processId = await ctx.db.insert("processes", {
    departmentId,
    name: "Request handling",
    sortOrder: 1,
    clerkOrgId: orgId,
    ...processFields,
  });
  return { functionId, departmentId, processId };
}

describe("summary ops reporting", () => {
  beforeEach(() => {
    process.env.SUMMARY_V2 = "true";
  });
  afterEach(() => {
    if (originalSummaryV2 === undefined) delete process.env.SUMMARY_V2;
    else process.env.SUMMARY_V2 = originalSummaryV2;
  });

  test("stage cost report separates stages, levels, and latency percentiles", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const latencies = [400, 800, 1_200, 1_600, 9_000];
      for (const [index, latencyMs] of latencies.entries()) {
        await ctx.db.insert(
          "aiUsageEvents",
          usageRow("conversation-summary-evidence-v2", {
            key: `evidence-${index}`,
            latencyMs,
            createdAt: NOW + index,
          }),
        );
      }
      await ctx.db.insert(
        "aiUsageEvents",
        usageRow("process-summary-v2-chunk", {
          key: "chunk-1",
          latencyMs: 30_000,
          outputTokens: 3_000,
          costMicroUsd: 9_000,
        }),
      );
      await ctx.db.insert(
        "aiUsageEvents",
        usageRow("process-summary-v2-final", {
          key: "final-1",
          latencyMs: 20_000,
          costMicroUsd: 5_000,
          status: "truncated",
        }),
      );
      await ctx.db.insert(
        "aiUsageEvents",
        usageRow("department-summary-v2-final", {
          key: "dept-1",
          latencyMs: 15_000,
          costMicroUsd: 4_000,
        }),
      );
      await ctx.db.insert(
        "aiUsageEvents",
        usageRow("function-summary-v2-final", {
          key: "fn-1",
          latencyMs: 18_000,
          costMicroUsd: 6_000,
          status: "failed",
        }),
      );
      // Another tenant's row, and an unrelated operation, must not be counted.
      await ctx.db.insert(
        "aiUsageEvents",
        usageRow("process-summary-v2-final", {
          key: "final-other-org",
          clerkOrgId: OTHER_ORG,
          costMicroUsd: 999_999,
        }),
      );
      await ctx.db.insert(
        "aiUsageEvents",
        usageRow("process-flow-v3-stage", {
          key: "flow-1",
          costMicroUsd: 777_777,
        }),
      );
    });

    const report = await t.query(internal.summaryOps.stageCostReport, {
      sinceMs: NOW - 1_000,
      clerkOrgId: ORG,
    });

    const evidence = report.byStage.find(
      (stage) => stage.stage === "evidence",
    )!;
    expect(evidence.calls).toBe(5);
    expect(evidence.latencyMs.p50).toBe(1_200);
    expect(evidence.latencyMs.p95).toBe(9_000);
    expect(evidence.latencyMs.max).toBe(9_000);

    const final = report.byStage.find(
      (stage) => stage.operation === "process-summary-v2-final",
    )!;
    expect(final.calls).toBe(1);
    expect(final.truncated).toBe(1);
    expect(final.costMicroUsd).toBe(5_000);

    expect(
      report.byStage.find(
        (stage) => stage.operation === "function-summary-v2-final",
      )!.failed,
    ).toBe(1);

    const levels = Object.fromEntries(
      report.byLevel.map((entry) => [entry.level, entry.costMicroUsd]),
    );
    expect(levels.conversation).toBe(5 * 1_200);
    expect(levels.process).toBe(9_000 + 5_000);
    expect(levels.department).toBe(4_000);
    expect(levels.function).toBe(6_000);
    // Flow spend and the other tenant's spend stay out of the total.
    expect(report.totalCostMicroUsd).toBe(6_000 + 14_000 + 4_000 + 6_000);
    expect(report.truncatedSample).toBe(false);
  });

  test("run health report surfaces stalled runs, retries, and error codes", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      const seeded = await seedHierarchy(ctx, ORG);
      const base = {
        clerkOrgId: ORG,
        sourceSnapshot: {
          hash: "snapshot",
          includedSources: 1,
          totalEligibleSources: 2,
          complete: false,
        },
        createdAt: now - 60 * 60_000,
        attempt: 2,
        maxAttempts: 3,
        resumeCount: 1,
      };
      await ctx.db.insert("summaryRuns", {
        ...base,
        entity: { kind: "process" as const, processId: seeded.processId },
        entityKey: "process:stalled",
        generationId: "gen-stalled",
        state: "running",
        progress: { stage: "chunk_reduce", completed: 1, total: 3 },
        lastProgressAt: now - 45 * 60_000,
      });
      await ctx.db.insert("summaryRuns", {
        ...base,
        entity: { kind: "process" as const, processId: seeded.processId },
        entityKey: "process:healthy",
        generationId: "gen-healthy",
        state: "running",
        progress: { stage: "final_reduce", completed: 2, total: 3 },
        lastProgressAt: now - 30_000,
        attempt: 1,
        resumeCount: 0,
      });
      await ctx.db.insert("summaryRuns", {
        ...base,
        entity: {
          kind: "department" as const,
          departmentId: seeded.departmentId,
        },
        entityKey: "department:failed",
        generationId: "gen-failed",
        state: "failed",
        progress: { stage: "rollup_reduce", completed: 0, total: 1 },
        lastProgressAt: now - 90 * 60_000,
        completedAt: now - 89 * 60_000,
        error: {
          code: "generation_failed",
          message: "Synthetic failure",
          retryable: true,
        },
      });
    });

    const report = await t.query(internal.summaryOps.runHealthReport, {});
    expect(report.stalled).toHaveLength(1);
    expect(report.stalled[0].entityKey).toBe("process:stalled");
    expect(report.stalled[0].stage).toBe("chunk_reduce");
    expect(report.retriedRuns).toBe(2);
    expect(report.resumedRuns).toBe(2);
    expect(report.partialSnapshots).toBe(3);
    expect(report.errorsByCode).toEqual([
      { code: "generation_failed", count: 1 },
    ]);
    expect(report.rollout.mode).toBe("all");
  });

  test("stored artifact audit fails a measured-language artifact", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await seedHierarchy(ctx, ORG, {
        summaryV2: processArtifact({
          headline: "Approvals clear in 3 days on average",
          executiveBrief:
            "The event log shows 38% of cases are reworked each month.",
        }),
      });
    });

    const report = await t.query(internal.summaryOps.auditStoredArtifacts, {
      clerkOrgId: ORG,
    });
    expect(report.auditedArtifacts).toBe(1);
    expect(report.passed).toBe(false);
    expect(report.violations[0].level).toBe("process");
    expect(report.violations[0].failures.join(" ")).toContain(
      "measured_language",
    );
    expect(
      report.violationsByCategory.some(
        (entry) => entry.category === "measured_language",
      ),
    ).toBe(true);
  });

  test("stored artifact audit passes a clean artifact and catches an unsourced claim", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await seedHierarchy(ctx, ORG, { summaryV2: processArtifact() });
    });
    const clean = await t.query(internal.summaryOps.auditStoredArtifacts, {
      clerkOrgId: ORG,
    });
    expect(clean.passed).toBe(true);
    expect(clean.cleanArtifacts).toBe(1);

    const t2 = convexTest(schema, modules);
    await t2.run(async (ctx) => {
      await seedHierarchy(ctx, ORG, {
        summaryV2: processArtifact({
          notable: [
            {
              id: "notable-unsourced",
              title: "A manager approves every request",
              body: "Stated as fact with no source at all.",
              evidenceLevel: "single_source",
              supportCount: 0,
              sources: [],
            },
          ],
        }),
      });
    });
    const dirty = await t2.query(internal.summaryOps.auditStoredArtifacts, {
      clerkOrgId: ORG,
    });
    expect(dirty.passed).toBe(false);
    expect(dirty.violations[0].failures.join(" ")).toContain(
      "factual_finding_without_source",
    );
  });

  test("V2 coverage report measures share against summarized entities only", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const seeded = await seedHierarchy(ctx, ORG, {
        summaryV2: processArtifact(),
        rollingSummary: "# Projected legacy Markdown",
      });
      // A legacy-only process and a never-summarized process in the same org.
      await ctx.db.insert("processes", {
        departmentId: seeded.departmentId,
        name: "Legacy only",
        sortOrder: 2,
        clerkOrgId: ORG,
        rollingSummary: "# Old narrative",
      });
      await ctx.db.insert("processes", {
        departmentId: seeded.departmentId,
        name: "Never summarized",
        sortOrder: 3,
        clerkOrgId: ORG,
      });
      await ctx.db.patch(seeded.departmentId, {
        summaryV2: undefined,
        summary: "# Legacy department narrative",
      });
    });

    const report = await t.query(internal.summaryOps.v2CoverageReport, {
      clerkOrgId: ORG,
    });
    const processes = report.byLevel.find(
      (entry) => entry.level === "process",
    )!;
    expect(processes.rows).toBe(3);
    // The never-summarized row is excluded from the denominator.
    expect(processes.withAnySummary).toBe(2);
    expect(processes.withV2).toBe(1);
    expect(processes.legacyOnly).toBe(1);
    expect(processes.v2Share).toBe(0.5);

    const departments = report.byLevel.find(
      (entry) => entry.level === "department",
    )!;
    expect(departments.withV2).toBe(0);
    expect(departments.legacyOnly).toBe(1);

    expect(report.overall.withAnySummary).toBe(3);
    expect(report.overall.withV2).toBe(1);
    expect(report.rollout.mode).toBe("all");
  });

  test("coverage report scans every tenant when no organization is named", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await seedHierarchy(ctx, ORG, { summaryV2: processArtifact() });
      await seedHierarchy(ctx, OTHER_ORG, {
        rollingSummary: "# Other tenant legacy",
      });
    });
    const report = await t.query(internal.summaryOps.v2CoverageReport, {});
    expect(report.organizationsScanned).toBe(2);
    expect(report.overall.withAnySummary).toBe(2);
    expect(report.overall.withV2).toBe(1);
    expect(report.overall.v2Share).toBe(0.5);
  });
});
