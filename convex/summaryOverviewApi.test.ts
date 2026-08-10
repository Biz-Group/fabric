/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";
import {
  renderSummaryV2AsLegacyMarkdown,
  SUMMARY_V2_PROMPT_VERSIONS,
  type DepartmentOverviewArtifactV2,
  type ProcessOverviewArtifactV2,
} from "./summaryV2";

const modules = import.meta.glob("./**/*.ts");
const ORG = "org_summary_overview_api";
const OTHER_ORG = "org_summary_overview_api_other";
const ISSUER = "https://summary-overview.test";
const originalSummaryV2 = process.env.SUMMARY_V2;

type Role = "viewer" | "contributor" | "admin";

function identity(name: string, orgId = ORG) {
  return {
    tokenIdentifier: `${ISSUER}|${name}`,
    subject: name,
    issuer: ISSUER,
    name,
    email: `${name}@example.test`,
    orgId,
    orgSlug: orgId,
  };
}

async function seedMember(ctx: MutationCtx, name: string, role: Role) {
  const userId = await ctx.db.insert("users", {
    tokenIdentifier: `${ISSUER}|${name}`,
    name,
    email: `${name}@example.test`,
    profileComplete: true,
  });
  await ctx.db.insert("memberships", {
    tokenIdentifier: `${ISSUER}|${name}`,
    userId,
    clerkOrgId: ORG,
    role,
    createdAt: Date.now(),
  });
  return userId;
}

function departmentArtifact(
  hash: string,
  generatedAt: number,
  complete = true,
): DepartmentOverviewArtifactV2 {
  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    headline: `Department ${hash}`,
    executiveBrief: "A bounded department overview retained during refresh.",
    crossProcessDependencies: [],
    sharedPatterns: [],
    variationsAndTensions: [],
    gaps: [],
    notable: [],
    coverage: {
      includedSources: complete ? 2 : 1,
      totalEligibleSources: 2,
      complete,
    },
    provenance: {
      sourceSnapshotHash: hash,
      generatedAt,
      promptVersion: SUMMARY_V2_PROMPT_VERSIONS.departmentOverview,
      provider: "fabric-foundry",
      model: "test-model",
    },
  };
}

function processArtifact(hash: string): ProcessOverviewArtifactV2 {
  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    headline: `Process ${hash}`,
    executiveBrief: "A bounded process overview.",
    scope: [],
    consensus: [],
    variations: [],
    gaps: [],
    notable: [],
    coverage: {
      includedSources: 1,
      totalEligibleSources: 1,
      uniqueContributors: 1,
      complete: true,
    },
    provenance: {
      sourceSnapshotHash: hash,
      generatedAt: 1_780_000_000_000,
      promptVersion: SUMMARY_V2_PROMPT_VERSIONS.processOverview,
      provider: "fabric-foundry",
      model: "test-model",
    },
  };
}

async function seedHierarchy(ctx: MutationCtx) {
  const functionId = await ctx.db.insert("functions", {
    name: "Operations",
    sortOrder: 1,
    summarySourceRevision: 1,
    clerkOrgId: ORG,
  });
  const departmentId = await ctx.db.insert("departments", {
    functionId,
    name: "Service",
    sortOrder: 1,
    summarySourceRevision: 1,
    clerkOrgId: ORG,
  });
  const processId = await ctx.db.insert("processes", {
    departmentId,
    name: "Request handling",
    sortOrder: 1,
    summaryEvidenceRevision: 1,
    clerkOrgId: ORG,
  });
  return { functionId, departmentId, processId };
}

describe("unified summary overview API", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.SUMMARY_V2 = "true";
  });

  afterEach(() => {
    if (originalSummaryV2 === undefined) delete process.env.SUMMARY_V2;
    else process.env.SUMMARY_V2 = originalSummaryV2;
    vi.useRealTimers();
  });

  test("reports every public state and retains prior artifacts on refresh/failure", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      await seedMember(ctx, "viewer", "viewer");
      const functionId = await ctx.db.insert("functions", {
        name: "Operations",
        sortOrder: 1,
        clerkOrgId: ORG,
      });
      const insertDepartment = async (
        name: string,
        fields: Partial<Parameters<typeof ctx.db.insert<"departments">>[1]>,
      ) =>
        await ctx.db.insert("departments", {
          functionId,
          name,
          sortOrder: 1,
          clerkOrgId: ORG,
          ...fields,
        });

      const missing = await insertDepartment("Missing", {});
      const legacy = await insertDepartment("Legacy", {
        summary: "# Existing legacy overview",
        summaryUpdatedAt: 1_779_000_000_000,
        summaryStale: false,
      });
      const current = await insertDepartment("Current", {
        summaryV2: departmentArtifact("current", 1_780_000_000_001),
        summarySourceRevision: 2,
        summaryV2SourceRevision: 2,
        summaryStale: false,
      });
      const stale = await insertDepartment("Stale", {
        summaryV2: departmentArtifact("stale", 1_780_000_000_002),
        summarySourceRevision: 3,
        summaryV2SourceRevision: 2,
        summaryStale: true,
      });
      const partial = await insertDepartment("Partial", {
        summaryV2: departmentArtifact("partial", 1_780_000_000_003, false),
        summarySourceRevision: 4,
        summaryV2SourceRevision: 4,
        summaryStale: false,
      });
      const refreshing = await insertDepartment("Refreshing", {
        summaryV2: departmentArtifact("refreshing", 1_780_000_000_004),
        summary: "Previous compatibility Markdown",
        summarySourceRevision: 5,
        summaryV2SourceRevision: 4,
        summaryStale: true,
        summaryRegenScheduledAt: Date.now(),
        summaryV2GenerationId: "refreshing-generation",
      });
      const refreshRun = await ctx.db.insert("summaryRuns", {
        clerkOrgId: ORG,
        entity: { kind: "department", departmentId: refreshing },
        entityKey: `department:${refreshing}`,
        generationId: "refreshing-generation",
        sourceRevision: 5,
        sourceSnapshot: {
          hash: "refreshing-source",
          includedSources: 1,
          totalEligibleSources: 2,
          complete: false,
        },
        state: "running",
        progress: { stage: "rollup_reduce", completed: 1, total: 2 },
        createdAt: Date.now(),
        startedAt: Date.now(),
        lastProgressAt: Date.now(),
        attempt: 1,
        maxAttempts: 2,
        resumeCount: 0,
      });
      await ctx.db.patch(refreshing, { summaryV2RunId: refreshRun });

      const failed = await insertDepartment("Failed", {
        summaryV2: departmentArtifact("failed-prior", 1_780_000_000_005),
        summarySourceRevision: 6,
        summaryV2SourceRevision: 5,
        summaryStale: true,
        summaryV2LastRunState: "failed",
        summaryV2LastError: {
          code: "generation_failed",
          message: "Synthetic failure",
          retryable: true,
        },
        summaryV2LastCompletedAt: Date.now(),
      });
      await ctx.db.insert("summaryRuns", {
        clerkOrgId: ORG,
        entity: { kind: "department", departmentId: failed },
        entityKey: `department:${failed}`,
        generationId: "failed-generation",
        sourceRevision: 6,
        sourceSnapshot: {
          hash: "failed-source",
          includedSources: 1,
          totalEligibleSources: 2,
          complete: false,
        },
        state: "failed",
        progress: { stage: "rollup_reduce", completed: 1, total: 2 },
        error: {
          code: "generation_failed",
          message: "Synthetic failure",
          retryable: true,
        },
        createdAt: Date.now() + 1,
        completedAt: Date.now() + 1,
        attempt: 2,
        maxAttempts: 2,
        resumeCount: 0,
      });
      return { missing, legacy, current, stale, partial, refreshing, failed };
    });

    const viewer = t.withIdentity(identity("viewer"));
    const responses = await Promise.all(
      Object.entries(ids).map(async ([name, departmentId]) => [
        name,
        await viewer.query(api.summaries.getOverview, {
          entity: { kind: "department", departmentId },
        }),
      ]),
    );
    const byName = Object.fromEntries(responses);

    expect(byName.missing.state).toBe("missing");
    expect(byName.legacy.state).toBe("current");
    expect(byName.legacy.content).toEqual({
      format: "legacy",
      artifact: null,
      markdown: "# Existing legacy overview",
    });
    expect(byName.legacy.lastSuccessfulGenerationAt).toBe(1_779_000_000_000);
    expect(byName.current.state).toBe("current");
    expect(byName.stale.state).toBe("stale");
    expect(byName.partial.state).toBe("partial");
    expect(byName.refreshing.state).toBe("refreshing");
    expect(byName.failed.state).toBe("failed");
    expect(byName.refreshing.content.format).toBe("v2");
    expect(byName.refreshing.progress).toEqual({
      stage: "rollup_reduce",
      completed: 1,
      total: 2,
    });
    expect(byName.failed.content.format).toBe("v2");
    expect(byName.failed.error?.code).toBe("generation_failed");
    expect(byName.current.lastSuccessfulGenerationAt).toBe(1_780_000_000_001);
  });

  test("allows member refresh, restricts force refresh, and enforces tenant ownership", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      await seedMember(ctx, "viewer", "viewer");
      await seedMember(ctx, "contributor", "contributor");
      await seedMember(ctx, "admin", "admin");
      const hierarchy = await seedHierarchy(ctx);
      const contributorDepartment = await ctx.db.insert("departments", {
        functionId: hierarchy.functionId,
        name: "Contributor refresh",
        sortOrder: 2,
        summarySourceRevision: 1,
        summaryStale: true,
        clerkOrgId: ORG,
      });
      const adminDepartment = await ctx.db.insert("departments", {
        functionId: hierarchy.functionId,
        name: "Admin refresh",
        sortOrder: 3,
        summarySourceRevision: 1,
        summaryStale: true,
        clerkOrgId: ORG,
      });
      const otherFunction = await ctx.db.insert("functions", {
        name: "Other tenant",
        sortOrder: 1,
        clerkOrgId: OTHER_ORG,
      });
      const otherDepartment = await ctx.db.insert("departments", {
        functionId: otherFunction,
        name: "Other tenant department",
        sortOrder: 1,
        clerkOrgId: OTHER_ORG,
      });
      return {
        ...hierarchy,
        contributorDepartment,
        adminDepartment,
        otherDepartment,
      };
    });

    const viewer = t.withIdentity(identity("viewer"));
    expect(
      await viewer.mutation(api.summaries.ensureCurrent, {
        entity: { kind: "department", departmentId: ids.departmentId },
      }),
    ).toEqual({ status: "scheduled", scheduled: true });
    await expect(
      viewer.mutation(api.summaries.forceRefresh, {
        entity: { kind: "department", departmentId: ids.departmentId },
      }),
    ).rejects.toThrow("Insufficient permissions");

    const contributor = t.withIdentity(identity("contributor"));
    const contributorEntity = {
      kind: "department" as const,
      departmentId: ids.contributorDepartment,
    };
    expect(
      await contributor.mutation(api.summaries.forceRefresh, {
        entity: contributorEntity,
      }),
    ).toEqual({ status: "scheduled", scheduled: true });
    expect(
      await contributor.mutation(api.summaries.forceRefresh, {
        entity: contributorEntity,
      }),
    ).toEqual({ status: "coalesced", scheduled: false });
    expect(
      await t.withIdentity(identity("admin")).mutation(api.summaries.forceRefresh, {
        entity: { kind: "department", departmentId: ids.adminDepartment },
      }),
    ).toEqual({ status: "scheduled", scheduled: true });

    await expect(
      t.query(api.summaries.getOverview, {
        entity: { kind: "department", departmentId: ids.departmentId },
      }),
    ).rejects.toThrow("Not authenticated");
    await expect(
      t.mutation(api.summaries.ensureCurrent, {
        entity: { kind: "department", departmentId: ids.departmentId },
      }),
    ).rejects.toThrow("Not authenticated");
    await expect(
      viewer.query(api.summaries.getOverview, {
        entity: { kind: "department", departmentId: ids.otherDepartment },
      }),
    ).rejects.toThrow("Not found");
    await expect(
      viewer.mutation(api.summaries.ensureCurrent, {
        entity: { kind: "department", departmentId: ids.otherDepartment },
      }),
    ).rejects.toThrow("Not found");
  });

  test("a viewer cannot create duplicate process work for one unchanged snapshot", async () => {
    const t = convexTest(schema, modules);
    const { processId, failedProcessId } = await t.run(async (ctx) => {
      await seedMember(ctx, "viewer", "viewer");
      const { departmentId, processId } = await seedHierarchy(ctx);
      await ctx.db.patch(processId, { summaryEvidenceRevision: 4 });
      const failedProcessId = await ctx.db.insert("processes", {
        departmentId,
        name: "Failed unchanged process",
        sortOrder: 2,
        summaryEvidenceRevision: 9,
        summaryV2LastRunState: "failed",
        clerkOrgId: ORG,
      });
      await ctx.db.insert("summaryRuns", {
        clerkOrgId: ORG,
        entity: { kind: "process", processId: failedProcessId },
        entityKey: `process:${failedProcessId}`,
        generationId: "failed-unchanged-generation",
        sourceRevision: 9,
        sourceSnapshot: {
          hash: "failed-unchanged-source",
          includedSources: 0,
          totalEligibleSources: 1,
          complete: false,
        },
        state: "failed",
        progress: { stage: "final_reduce", completed: 0, total: 1 },
        error: {
          code: "generation_failed",
          message: "Synthetic failure",
          retryable: true,
        },
        createdAt: Date.now(),
        completedAt: Date.now(),
        attempt: 2,
        maxAttempts: 2,
        resumeCount: 0,
      });
      return { processId, failedProcessId };
    });
    const viewer = t.withIdentity(identity("viewer"));

    const first = await viewer.mutation(api.summaries.ensureCurrent, {
      entity: { kind: "process", processId },
    });
    const afterFirst = await t.run(async (ctx) => ctx.db.get(processId));
    const second = await viewer.mutation(api.summaries.ensureCurrent, {
      entity: { kind: "process", processId },
    });
    const afterSecond = await t.run(async (ctx) => ctx.db.get(processId));

    expect(first).toEqual({ status: "scheduled", scheduled: true });
    expect(second).toEqual({ status: "coalesced", scheduled: false });
    expect(afterFirst?.summaryEvidenceRevision).toBe(5);
    expect(afterSecond?.summaryEvidenceRevision).toBe(5);
    expect(afterSecond?.summaryEvidenceRefreshGenerationId).toBe(
      afterFirst?.summaryEvidenceRefreshGenerationId,
    );
    expect(afterSecond?.summaryEvidenceRefreshRequestedAgain).toBe(false);

    expect(
      await viewer.mutation(api.summaries.ensureCurrent, {
        entity: { kind: "process", processId: failedProcessId },
      }),
    ).toEqual({ status: "coalesced", scheduled: false });
    const failedProcess = await t.run(async (ctx) =>
      ctx.db.get(failedProcessId),
    );
    expect(failedProcess?.summaryEvidenceRevision).toBe(9);
    expect(failedProcess?.summaryEvidenceRefreshGenerationId).toBeUndefined();
  });

  test("returns bounded Flow/Insights metadata without their owned details", async () => {
    const t = convexTest(schema, modules);
    const processId = await t.run(async (ctx) => {
      await seedMember(ctx, "viewer", "viewer");
      const { processId } = await seedHierarchy(ctx);
      await ctx.db.patch(processId, {
        summaryV2: processArtifact("bounded"),
        rollingSummary: "Compatibility summary",
        summaryV2SourceRevision: 1,
      });
      await ctx.db.insert("processFlows", {
        processId,
        status: "ready",
        stale: true,
        generatedAt: 1_780_000_000_100,
        conversationCount: 1,
        nodes: [
          {
            id: "secret-node",
            label: "Secret node detail",
            category: "action",
            description: "This belongs only to Flow.",
            actors: ["Operator"],
            tools: ["System"],
            painPoints: ["Manual work"],
            automationPotential: "high",
            confidence: "high",
            isBottleneck: true,
            isTribalKnowledge: false,
            riskIndicators: ["Delay"],
            sources: ["Conversation 1"],
          },
        ],
        edges: [],
        insights: {
          criticalPath: ["secret-node"],
          handoffCount: 7,
          toolCount: 8,
          automationOpportunities: ["Secret opportunity"],
          topBottlenecks: ["Secret bottleneck"],
        },
        clerkOrgId: ORG,
      });
      return processId;
    });

    const overview = await t
      .withIdentity(identity("viewer"))
      .query(api.summaries.getOverview, {
        entity: { kind: "process", processId },
      });

    expect(overview.flow).toEqual({
      available: true,
      stale: true,
      generationStatus: "ready",
    });
    expect(overview.insights).toEqual({
      available: true,
      stale: true,
      generationStatus: "ready",
    });
    expect(Object.keys(overview.flow ?? {}).sort()).toEqual([
      "available",
      "generationStatus",
      "stale",
    ].sort());
    expect(Object.keys(overview.insights ?? {}).sort()).toEqual([
      "available",
      "generationStatus",
      "stale",
    ].sort());
    const serialized = JSON.stringify({
      flow: overview.flow,
      insights: overview.insights,
    });
    expect(serialized).not.toContain("secret-node");
    expect(serialized).not.toContain("Secret opportunity");
    expect(serialized).not.toContain("handoffCount");
  });

  test("a SUMMARY_V2 rollback reads the legacy projection and keeps every artifact", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      await seedMember(ctx, "contributor", "contributor");
      const { functionId, departmentId, processId } = await seedHierarchy(ctx);
      await ctx.db.patch(departmentId, {
        summaryV2: departmentArtifact("rollback", 1_780_000_000_010),
        summary: "## Stored projection\n\nWritten beside the artifact.",
        summaryUpdatedAt: 1_780_000_000_010,
        summarySourceRevision: 1,
        summaryV2SourceRevision: 1,
        summaryStale: false,
      });
      // Publishing writes the projection beside the artifact in one mutation, so
      // this row is the defensive case: a rollback must still show content
      // rather than blanking an entity that has an artifact.
      const projectionOnly = await ctx.db.insert("departments", {
        functionId,
        name: "Projection only",
        sortOrder: 2,
        summaryV2: departmentArtifact("projection-only", 1_780_000_000_011),
        summarySourceRevision: 1,
        summaryV2SourceRevision: 1,
        summaryStale: false,
        clerkOrgId: ORG,
      });
      await ctx.db.patch(processId, {
        summaryV2: processArtifact("rollback-process"),
        rollingSummary: "Stored process projection",
        summaryUpdatedAt: 1_780_000_000_012,
        summaryV2SourceRevision: 1,
        summaryEvidenceRevision: 1,
      });
      return { functionId, departmentId, processId, projectionOnly };
    });
    const contributor = t.withIdentity(identity("contributor"));

    process.env.SUMMARY_V2 = "false";
    const rolledBack = await contributor.query(api.summaries.getOverview, {
      entity: { kind: "department", departmentId: ids.departmentId },
    });
    expect(rolledBack.content).toEqual({
      format: "legacy",
      artifact: null,
      markdown: "## Stored projection\n\nWritten beside the artifact.",
    });
    expect(rolledBack.coverage).toBeNull();
    expect(rolledBack.state).toBe("current");
    expect(rolledBack.lastSuccessfulGenerationAt).toBe(1_780_000_000_010);

    const derived = await contributor.query(api.summaries.getOverview, {
      entity: { kind: "department", departmentId: ids.projectionOnly },
    });
    const stored = await t.run(async (ctx) => ctx.db.get(ids.projectionOnly));
    expect(derived.content.format).toBe("legacy");
    expect(derived.content.markdown).toBe(
      renderSummaryV2AsLegacyMarkdown(stored!.summaryV2!),
    );

    // List metadata follows the same gate, so no badge claims structured
    // coverage the UI is no longer rendering.
    const departments = await contributor.query(api.departments.listByFunction, {
      functionId: ids.functionId,
    });
    const processes = await contributor.query(api.processes.listByDepartment, {
      departmentId: ids.departmentId,
    });
    expect(departments[0].name).toBe("Service");
    expect(departments[0].summaryOverview).toMatchObject({
      format: "legacy",
      state: "current",
      coverage: null,
    });
    expect(departments[0]).not.toHaveProperty("summaryV2");
    expect(processes[0].summaryOverview).toMatchObject({
      format: "legacy",
      state: "current",
      coverage: null,
    });

    // Rollback also stops generation, and nothing was deleted on the way.
    expect(
      await contributor.mutation(api.summaries.forceRefresh, {
        entity: { kind: "department", departmentId: ids.departmentId },
      }),
    ).toEqual({ status: "disabled", scheduled: false });
    expect(
      await contributor.mutation(api.summaries.ensureCurrent, {
        entity: { kind: "process", processId: ids.processId },
      }),
    ).toEqual({ status: "disabled", scheduled: false });

    process.env.SUMMARY_V2 = "true";
    const restored = await contributor.query(api.summaries.getOverview, {
      entity: { kind: "department", departmentId: ids.departmentId },
    });
    expect(restored.content.format).toBe("v2");
    expect(restored.coverage).toEqual({
      includedSources: 2,
      totalEligibleSources: 2,
      complete: true,
    });
    const afterRollback = await t.run(async (ctx) => ({
      department: await ctx.db.get(ids.departmentId),
      process: await ctx.db.get(ids.processId),
    }));
    expect(afterRollback.department?.summaryV2?.provenance.sourceSnapshotHash).toBe(
      "rollback",
    );
    expect(afterRollback.process?.summaryV2?.provenance.sourceSnapshotHash).toBe(
      "rollback-process",
    );
    expect(afterRollback.process?.summaryEvidenceRefreshGenerationId).toBeUndefined();
  });

  test("keeps existing generation actions as response-compatible V2 adapters", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      await seedMember(ctx, "contributor", "contributor");
      const hierarchy = await seedHierarchy(ctx);
      await ctx.db.patch(hierarchy.departmentId, {
        summary: "Existing department brief",
        summaryStale: true,
      });
      await ctx.db.patch(hierarchy.functionId, {
        summary: "Existing function brief",
        summaryStale: true,
      });
      return hierarchy;
    });
    const contributor = t.withIdentity(identity("contributor"));

    expect(
      await contributor.action(api.summaries.generateDepartmentSummary, {
        departmentId: ids.departmentId,
      }),
    ).toEqual({ summary: "Existing department brief", message: null });
    expect(
      await contributor.action(api.summaries.generateFunctionSummary, {
        functionId: ids.functionId,
      }),
    ).toEqual({ summary: "Existing function brief", message: null });
    expect(
      await contributor.action(api.summaries.forceRefreshProcessSummary, {
        processId: ids.processId,
      }),
    ).toEqual({ message: null });

    const scheduled = await t.run(async (ctx) => ({
      department: await ctx.db.get(ids.departmentId),
      fn: await ctx.db.get(ids.functionId),
      process: await ctx.db.get(ids.processId),
    }));
    expect(scheduled.department?.summaryV2GenerationId).toBeTruthy();
    expect(scheduled.fn?.summaryV2GenerationId).toBeTruthy();
    expect(scheduled.process?.summaryEvidenceRefreshGenerationId).toBeTruthy();
  });
});
