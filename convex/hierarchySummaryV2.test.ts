/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";
import {
  renderSummaryV2AsLegacyMarkdown,
  SUMMARY_V2_PROMPT_VERSIONS,
  type DepartmentOverviewArtifactV2,
  type FunctionOverviewArtifactV2,
  type ProcessOverviewArtifactV2,
} from "./summaryV2";

const modules = import.meta.glob("./**/*.ts");
const ORG = "org_hierarchy_summary_v2";
const OTHER_ORG = "org_hierarchy_summary_v2_other";
const AI_ENV = [
  "AI_PROVIDER",
  "FOUNDRY_ENDPOINT",
  "FOUNDRY_API_KEY",
  "FOUNDRY_CLAUDE_DEPLOYMENT",
  "SUMMARY_V2",
] as const;

function configureFoundry() {
  process.env.AI_PROVIDER = "foundry";
  process.env.FOUNDRY_ENDPOINT = "https://fabric-test.services.ai.azure.com";
  process.env.FOUNDRY_API_KEY = "test-key";
  process.env.FOUNDRY_CLAUDE_DEPLOYMENT = "fabric-claude";
}

const baseProvenance = {
  sourceSnapshotHash: "child-snapshot",
  generatedAt: 1,
  promptVersion: SUMMARY_V2_PROMPT_VERSIONS.processOverview,
  provider: "fabric-foundry",
  model: "test-model",
};

function processArtifact(
  hash: string,
  complete = true,
): ProcessOverviewArtifactV2 {
  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    headline: `Process ${hash}`,
    executiveBrief: "The process receives, checks, and hands off a request.",
    scope: [],
    consensus: [],
    variations: [],
    gaps: [],
    notable: [],
    coverage: {
      includedSources: complete ? 2 : 1,
      totalEligibleSources: 2,
      uniqueContributors: complete ? 2 : 1,
      complete,
    },
    provenance: { ...baseProvenance, sourceSnapshotHash: hash },
  };
}

function departmentArtifact(
  hash: string,
  complete = true,
): DepartmentOverviewArtifactV2 {
  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    headline: `Department ${hash}`,
    executiveBrief: "The department coordinates its documented processes.",
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
      ...baseProvenance,
      sourceSnapshotHash: hash,
      promptVersion: SUMMARY_V2_PROMPT_VERSIONS.departmentOverview,
    },
  };
}

function functionArtifact(hash: string): FunctionOverviewArtifactV2 {
  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    headline: `Function ${hash}`,
    executiveBrief: "The function coordinates its departments.",
    crossDepartmentDependencies: [],
    strategicPatterns: [],
    variationsAndTensions: [],
    gaps: [],
    notable: [],
    coverage: { includedSources: 1, totalEligibleSources: 1, complete: true },
    provenance: {
      ...baseProvenance,
      sourceSnapshotHash: hash,
      promptVersion: SUMMARY_V2_PROMPT_VERSIONS.functionOverview,
    },
  };
}

async function seedRoot(ctx: MutationCtx) {
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
    summaryStale: true,
    clerkOrgId: ORG,
  });
  return { functionId, departmentId };
}

async function insertProcess(
  ctx: MutationCtx,
  args: {
    departmentId: Id<"departments">;
    name: string;
    artifact?: ProcessOverviewArtifactV2;
    evidenceRevision?: number;
    artifactRevision?: number;
    failed?: boolean;
    clerkOrgId?: string;
  },
) {
  return await ctx.db.insert("processes", {
    departmentId: args.departmentId,
    name: args.name,
    sortOrder: 1,
    clerkOrgId: args.clerkOrgId ?? ORG,
    summaryEvidenceRevision: args.evidenceRevision ?? 1,
    summaryV2SourceRevision: args.artifactRevision,
    summaryV2: args.artifact,
    summaryV2LastRunState: args.failed ? "failed" : undefined,
  });
}

function initialScan() {
  return {
    eligibleSources: 0,
    includedSources: 0,
    currentSources: 0,
    completedSources: 0,
    nextOrdinal: 1,
    nextChunkIndex: 0,
    hashFirst: 0x811c9dc5,
    hashSecond: 0x9e3779b9,
    hashLength: 0,
    pendingSources: [],
  };
}

async function startDepartmentRun(
  t: ReturnType<typeof convexTest>,
  departmentId: Id<"departments">,
  forceRefresh = false,
) {
  const request = await t.mutation(
    internal.hierarchySummaryV2.requestDepartmentSummaryV2,
    { departmentId, clerkOrgId: ORG, forceRefresh },
  );
  const runId = await t.mutation(
    internal.hierarchySummaryV2.startDepartmentRun,
    {
      departmentId,
      clerkOrgId: ORG,
      generationId: request.generationId!,
      forceRefresh,
    },
  );
  if (!runId) throw new Error("Department run did not start");
  await t.mutation(internal.hierarchySummaryV2.scanDepartmentSources, {
    runId,
    generationId: request.generationId!,
  });
  return { runId, generationId: request.generationId! };
}

async function startFunctionSourceScan(
  t: ReturnType<typeof convexTest>,
  functionId: Id<"functions">,
) {
  const request = await t.mutation(
    internal.hierarchySummaryV2.requestFunctionSummaryV2,
    { functionId, clerkOrgId: ORG },
  );
  const runId = await t.mutation(internal.hierarchySummaryV2.startFunctionRun, {
    functionId,
    clerkOrgId: ORG,
    generationId: request.generationId!,
    forceRefresh: false,
  });
  if (!runId) throw new Error("Function run did not start");
  await t.run(async (ctx) => {
    await ctx.db.patch(runId, {
      rollupPhase: "scan_sources",
      rollupScan: initialScan(),
    });
  });
  await t.mutation(internal.hierarchySummaryV2.scanFunctionSources, {
    runId,
    generationId: request.generationId!,
  });
  return { runId, generationId: request.generationId! };
}

function responsePayload(toolName: string, keys: string[]) {
  const first = keys[0];
  const finding = first
    ? [
        {
          title: "Shared coordination",
          body: "The included sources describe a shared coordination dependency.",
          evidenceLevel: "single_source",
          sourceKeys: [first],
        },
      ]
    : [];
  const common = {
    headline: "How the hierarchy operates",
    executiveBrief:
      "The included child overviews describe coordinated request handling.",
    variationsAndTensions: [],
    gaps: [
      {
        title: "Some child knowledge is unclear",
        body: "The available evidence does not establish every child operation.",
        evidenceLevel: "inferred_gap",
        sourceKeys: [],
      },
    ],
    notable: [],
  };
  return toolName.includes("department")
    ? {
        ...common,
        crossProcessDependencies: finding,
        sharedPatterns: [],
      }
    : {
        ...common,
        crossDepartmentDependencies: finding,
        strategicPatterns: [],
      };
}

function stubClaude() {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = (await request.clone().json()) as {
        tools?: Array<{ name: string }>;
        messages?: Array<{ content: string }>;
      };
      const toolName = body.tools?.[0]?.name ?? "return_department_overview";
      const keys = body.messages?.[0]?.content.match(/[PD]\d+/g) ?? [];
      return new Response(
        JSON.stringify({
          id: "msg_rollup",
          type: "message",
          role: "assistant",
          model: "fabric-claude",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: toolName,
              input: responsePayload(toolName, keys),
            },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 30 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const name of AI_ENV) delete process.env[name];
  process.env.SUMMARY_V2 = "true";
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const name of AI_ENV) delete process.env[name];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Hierarchy Summary V2 pipeline", () => {
  test("department rollup excludes stale, missing, failed, and cross-org children with exact partial coverage", async () => {
    configureFoundry();
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const root = await seedRoot(ctx);
      const currentId = await insertProcess(ctx, {
        departmentId: root.departmentId,
        name: "Current process",
        artifact: processArtifact("current"),
        artifactRevision: 1,
      });
      const partialId = await insertProcess(ctx, {
        departmentId: root.departmentId,
        name: "Partial process",
        artifact: processArtifact("partial", false),
        artifactRevision: 1,
      });
      await insertProcess(ctx, {
        departmentId: root.departmentId,
        name: "Stale process",
        artifact: processArtifact("stale"),
        evidenceRevision: 2,
        artifactRevision: 1,
      });
      await insertProcess(ctx, {
        departmentId: root.departmentId,
        name: "Failed process",
        failed: true,
      });
      const foreignId = await insertProcess(ctx, {
        departmentId: root.departmentId,
        name: "Foreign process must never appear",
        artifact: processArtifact("foreign"),
        artifactRevision: 1,
        clerkOrgId: OTHER_ORG,
      });
      return { ...root, currentId, partialId, foreignId };
    });
    const { runId, generationId } = await startDepartmentRun(
      t,
      seeded.departmentId,
    );
    const before = await t.run(async (ctx) => ({
      run: await ctx.db.get(runId),
      chunks: await ctx.db
        .query("summaryChunks")
        .withIndex("by_clerkOrgId_and_summaryRunId_and_chunkIndex", (q) =>
          q.eq("clerkOrgId", ORG).eq("summaryRunId", runId),
        )
        .take(10),
    }));
    expect(before.run?.sourceSnapshot).toMatchObject({
      includedSources: 2,
      totalEligibleSources: 4,
      currentSources: 1,
      complete: false,
    });
    expect(before.chunks[0].rollupInputs?.map((source) => source.key)).toEqual([
      "P1",
      "P2",
    ]);

    const fetchMock = stubClaude();
    await t.action(internal.hierarchySummaryV2.generateHierarchyFinal, {
      runId,
      generationId,
    });
    const stored = await t.run(async (ctx) => ({
      department: await ctx.db.get(seeded.departmentId),
      fn: await ctx.db.get(seeded.functionId),
      run: await ctx.db.get(runId),
      usage: await ctx.db.query("aiUsageEvents").take(10),
    }));
    expect(stored.run?.state).toBe("partial");
    expect(stored.department?.summaryV2?.coverage).toEqual({
      includedSources: 2,
      totalEligibleSources: 4,
      complete: false,
    });
    expect(stored.department?.summary).toBe(
      renderSummaryV2AsLegacyMarkdown(stored.department!.summaryV2!),
    );
    expect(
      stored.department?.summaryV2?.crossProcessDependencies[0].sources,
    ).toEqual([
      {
        kind: "process",
        processId: seeded.currentId,
        label: "Current process",
      },
    ]);
    expect(stored.fn?.summaryStale).toBe(true);
    expect(stored.fn?.summarySourceRevision).toBe(2);
    expect(stored.usage[0]).toMatchObject({
      operation: "department-summary-v2-final",
      entityId: seeded.departmentId,
      runId: generationId,
    });
    const [requestInput, requestInit] = fetchMock.mock.calls[0];
    const requestBody = await (requestInput instanceof Request
      ? requestInput.clone()
      : new Request(requestInput, requestInit)
    ).text();
    expect(requestBody).not.toContain(seeded.foreignId);
    expect(requestBody).not.toContain("Foreign process must never appear");
  });

  test("a rollup with nothing readable under it is not a retryable failure", async () => {
    configureFoundry();
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const root = await seedRoot(ctx);
      // The shape a department lands on before anyone builds a child: processes
      // exist, none holds an overview to roll up.
      await insertProcess(ctx, {
        departmentId: root.departmentId,
        name: "Never recorded",
      });
      await insertProcess(ctx, {
        departmentId: root.departmentId,
        name: "Also never recorded",
      });
      return root;
    });

    const { runId } = await startDepartmentRun(t, seeded.departmentId);

    const run = await t.run(async (ctx) => ctx.db.get(runId));
    expect(run?.sourceSnapshot).toMatchObject({
      includedSources: 0,
      totalEligibleSources: 2,
    });
    // A parent reads child artifacts, so pressing rebuild again scans the same
    // empty set. Building a child is the only route forward, and that is not a
    // failure to report.
    expect(run?.error?.code).toBe("no_readable_children");
    expect(run?.error?.retryable).toBe(false);
    expect(run?.error?.message).toContain(
      "No child holds a current overview",
    );

    // A department with no children at all reaches the same outcome, and says
    // the plainer thing.
    const emptyDepartmentId = await t.run(
      async (ctx) =>
        await ctx.db.insert("departments", {
          functionId: seeded.functionId,
          name: "No processes yet",
          sortOrder: 2,
          summarySourceRevision: 1,
          summaryStale: true,
          clerkOrgId: ORG,
        }),
    );
    const empty = await startDepartmentRun(t, emptyDepartmentId);
    const emptyRun = await t.run(async (ctx) => ctx.db.get(empty.runId));
    expect(emptyRun?.sourceSnapshot).toMatchObject({
      includedSources: 0,
      totalEligibleSources: 0,
    });
    expect(emptyRun?.error?.code).toBe("no_readable_children");
    expect(emptyRun?.error?.message).toContain("no children to roll up");
  });

  test("function rollup cannot become current from stale or missing departments", async () => {
    configureFoundry();
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const root = await seedRoot(ctx);
      await ctx.db.patch(root.functionId, { summaryStale: true });
      await ctx.db.patch(root.departmentId, {
        summaryV2: departmentArtifact("current"),
        summaryV2SourceRevision: 1,
        summaryStale: false,
      });
      const partialId = await ctx.db.insert("departments", {
        functionId: root.functionId,
        name: "Partial department",
        sortOrder: 2,
        summarySourceRevision: 1,
        summaryV2SourceRevision: 1,
        summaryV2: departmentArtifact("partial", false),
        summaryStale: false,
        clerkOrgId: ORG,
      });
      await ctx.db.insert("departments", {
        functionId: root.functionId,
        name: "Stale department",
        sortOrder: 3,
        summarySourceRevision: 2,
        summaryV2SourceRevision: 1,
        summaryV2: departmentArtifact("stale"),
        summaryStale: true,
        clerkOrgId: ORG,
      });
      await ctx.db.insert("departments", {
        functionId: root.functionId,
        name: "Failed department",
        sortOrder: 4,
        summarySourceRevision: 1,
        summaryV2LastRunState: "failed",
        clerkOrgId: ORG,
      });
      await ctx.db.insert("departments", {
        functionId: root.functionId,
        name: "Foreign department",
        sortOrder: 5,
        summarySourceRevision: 1,
        summaryV2SourceRevision: 1,
        summaryV2: departmentArtifact("foreign"),
        summaryStale: false,
        clerkOrgId: OTHER_ORG,
      });
      return { ...root, partialId };
    });
    const { runId, generationId } = await startFunctionSourceScan(
      t,
      seeded.functionId,
    );
    const fetchMock = stubClaude();
    await t.action(internal.hierarchySummaryV2.generateHierarchyFinal, {
      runId,
      generationId,
    });
    const stored = await t.run(async (ctx) => ({
      fn: await ctx.db.get(seeded.functionId),
      run: await ctx.db.get(runId),
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stored.run?.state).toBe("partial");
    expect(stored.fn?.summaryV2?.coverage).toEqual({
      includedSources: 2,
      totalEligibleSources: 4,
      complete: false,
    });
  });

  test("function preparation schedules stale and missing departments separately before reduce", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const root = await seedRoot(ctx);
      await ctx.db.patch(root.departmentId, {
        summaryV2: departmentArtifact("current"),
        summaryV2SourceRevision: 1,
        summaryStale: false,
      });
      const staleId = await ctx.db.insert("departments", {
        functionId: root.functionId,
        name: "Stale department",
        sortOrder: 2,
        summarySourceRevision: 2,
        summaryV2SourceRevision: 1,
        summaryV2: departmentArtifact("stale"),
        summaryStale: true,
        clerkOrgId: ORG,
      });
      const missingId = await ctx.db.insert("departments", {
        functionId: root.functionId,
        name: "Missing department",
        sortOrder: 3,
        summarySourceRevision: 1,
        clerkOrgId: ORG,
      });
      return { ...root, staleId, missingId };
    });
    const request = await t.mutation(
      internal.hierarchySummaryV2.requestFunctionSummaryV2,
      { functionId: seeded.functionId, clerkOrgId: ORG },
    );
    const runId = await t.mutation(internal.hierarchySummaryV2.startFunctionRun, {
      functionId: seeded.functionId,
      clerkOrgId: ORG,
      generationId: request.generationId!,
      forceRefresh: false,
    });
    await t.mutation(internal.hierarchySummaryV2.prepareFunctionChildren, {
      runId: runId!,
      generationId: request.generationId!,
    });
    const stored = await t.run(async (ctx) => ({
      run: await ctx.db.get(runId!),
      stale: await ctx.db.get(seeded.staleId),
      missing: await ctx.db.get(seeded.missingId),
      usage: await ctx.db.query("aiUsageEvents").take(1),
    }));
    expect(stored.run?.rollupPhase).toBe("wait_children");
    expect(stored.run?.progress).toEqual({
      stage: "rollup_reduce",
      completed: 1,
      total: 3,
    });
    expect(stored.stale?.summaryV2GenerationId).toEqual(expect.any(String));
    expect(stored.missing?.summaryV2GenerationId).toEqual(expect.any(String));
    expect(stored.usage).toHaveLength(0);
  });

  test("function waits for child refresh failure, then reduces only settled current inputs", async () => {
    configureFoundry();
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const root = await seedRoot(ctx);
      await ctx.db.patch(root.departmentId, {
        summaryV2: departmentArtifact("current"),
        summaryV2SourceRevision: 1,
        summaryStale: false,
      });
      const staleId = await ctx.db.insert("departments", {
        functionId: root.functionId,
        name: "Stale department",
        sortOrder: 2,
        summarySourceRevision: 2,
        summaryV2SourceRevision: 1,
        summaryV2: departmentArtifact("stale"),
        summaryStale: true,
        clerkOrgId: ORG,
      });
      return { ...root, staleId };
    });
    const functionRequest = await t.mutation(
      internal.hierarchySummaryV2.requestFunctionSummaryV2,
      { functionId: seeded.functionId, clerkOrgId: ORG },
    );
    const functionRunId = await t.mutation(
      internal.hierarchySummaryV2.startFunctionRun,
      {
        functionId: seeded.functionId,
        clerkOrgId: ORG,
        generationId: functionRequest.generationId!,
        forceRefresh: false,
      },
    );
    await t.mutation(internal.hierarchySummaryV2.prepareFunctionChildren, {
      runId: functionRunId!,
      generationId: functionRequest.generationId!,
    });
    const stale = await t.run((ctx) => ctx.db.get(seeded.staleId));
    const childRunId = await t.mutation(
      internal.hierarchySummaryV2.startDepartmentRun,
      {
        departmentId: seeded.staleId,
        clerkOrgId: ORG,
        generationId: stale!.summaryV2GenerationId!,
        forceRefresh: false,
      },
    );
    await t.mutation(internal.hierarchySummaryV2.scanDepartmentSources, {
      runId: childRunId!,
      generationId: stale!.summaryV2GenerationId!,
    });
    await t.mutation(internal.hierarchySummaryV2.finishRollupRun, {
      entity: { kind: "department", departmentId: seeded.staleId },
      clerkOrgId: ORG,
      generationId: stale!.summaryV2GenerationId!,
      runId: childRunId!,
    });
    await t.mutation(internal.hierarchySummaryV2.waitForFunctionChildren, {
      runId: functionRunId!,
      generationId: functionRequest.generationId!,
    });
    let functionRun = await t.run((ctx) => ctx.db.get(functionRunId!));
    expect(functionRun?.rollupPhase).toBe("scan_sources");
    await t.mutation(internal.hierarchySummaryV2.scanFunctionSources, {
      runId: functionRunId!,
      generationId: functionRequest.generationId!,
    });
    stubClaude();
    await t.action(internal.hierarchySummaryV2.generateHierarchyFinal, {
      runId: functionRunId!,
      generationId: functionRequest.generationId!,
    });
    functionRun = await t.run((ctx) => ctx.db.get(functionRunId!));
    const fn = await t.run((ctx) => ctx.db.get(seeded.functionId));
    expect(functionRun?.state).toBe("partial");
    expect(fn?.summaryV2?.coverage).toEqual({
      includedSources: 1,
      totalEligibleSources: 2,
      complete: false,
    });
  });

  test("a successful child refresh supersedes the waiting function run before a fresh complete reduce", async () => {
    configureFoundry();
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const root = await seedRoot(ctx);
      await ctx.db.patch(root.departmentId, {
        summaryV2: departmentArtifact("current"),
        summaryV2SourceRevision: 1,
        summaryStale: false,
      });
      const staleId = await ctx.db.insert("departments", {
        functionId: root.functionId,
        name: "Refreshable department",
        sortOrder: 2,
        summarySourceRevision: 2,
        summaryV2SourceRevision: 1,
        summaryV2: departmentArtifact("stale"),
        summaryStale: true,
        clerkOrgId: ORG,
      });
      await insertProcess(ctx, {
        departmentId: staleId,
        name: "Refreshable process",
        artifact: processArtifact("refreshable"),
        artifactRevision: 1,
      });
      return { ...root, staleId };
    });
    const firstRequest = await t.mutation(
      internal.hierarchySummaryV2.requestFunctionSummaryV2,
      { functionId: seeded.functionId, clerkOrgId: ORG },
    );
    const firstRunId = await t.mutation(
      internal.hierarchySummaryV2.startFunctionRun,
      {
        functionId: seeded.functionId,
        clerkOrgId: ORG,
        generationId: firstRequest.generationId!,
        forceRefresh: false,
      },
    );
    await t.mutation(internal.hierarchySummaryV2.prepareFunctionChildren, {
      runId: firstRunId!,
      generationId: firstRequest.generationId!,
    });
    const stale = await t.run((ctx) => ctx.db.get(seeded.staleId));
    const childRunId = await t.mutation(
      internal.hierarchySummaryV2.startDepartmentRun,
      {
        departmentId: seeded.staleId,
        clerkOrgId: ORG,
        generationId: stale!.summaryV2GenerationId!,
        forceRefresh: false,
      },
    );
    await t.mutation(internal.hierarchySummaryV2.scanDepartmentSources, {
      runId: childRunId!,
      generationId: stale!.summaryV2GenerationId!,
    });
    const fetchMock = stubClaude();
    await t.action(internal.hierarchySummaryV2.generateHierarchyFinal, {
      runId: childRunId!,
      generationId: stale!.summaryV2GenerationId!,
    });
    await t.mutation(internal.hierarchySummaryV2.finishRollupRun, {
      entity: { kind: "department", departmentId: seeded.staleId },
      clerkOrgId: ORG,
      generationId: stale!.summaryV2GenerationId!,
      runId: childRunId!,
    });
    await t.mutation(internal.hierarchySummaryV2.waitForFunctionChildren, {
      runId: firstRunId!,
      generationId: firstRequest.generationId!,
    });
    expect((await t.run((ctx) => ctx.db.get(firstRunId!)))?.error?.code).toBe(
      "superseded",
    );
    await t.mutation(internal.hierarchySummaryV2.finishRollupRun, {
      entity: { kind: "function", functionId: seeded.functionId },
      clerkOrgId: ORG,
      generationId: firstRequest.generationId!,
      runId: firstRunId!,
    });
    const refreshedFunction = await t.run((ctx) => ctx.db.get(seeded.functionId));
    const secondRunId = await t.mutation(
      internal.hierarchySummaryV2.startFunctionRun,
      {
        functionId: seeded.functionId,
        clerkOrgId: ORG,
        generationId: refreshedFunction!.summaryV2GenerationId!,
        forceRefresh: false,
      },
    );
    await t.mutation(internal.hierarchySummaryV2.prepareFunctionChildren, {
      runId: secondRunId!,
      generationId: refreshedFunction!.summaryV2GenerationId!,
    });
    await t.mutation(internal.hierarchySummaryV2.waitForFunctionChildren, {
      runId: secondRunId!,
      generationId: refreshedFunction!.summaryV2GenerationId!,
    });
    await t.mutation(internal.hierarchySummaryV2.scanFunctionSources, {
      runId: secondRunId!,
      generationId: refreshedFunction!.summaryV2GenerationId!,
    });
    await t.action(internal.hierarchySummaryV2.generateHierarchyFinal, {
      runId: secondRunId!,
      generationId: refreshedFunction!.summaryV2GenerationId!,
    });
    const finalFunction = await t.run((ctx) => ctx.db.get(seeded.functionId));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(finalFunction?.summaryV2?.coverage).toEqual({
      includedSources: 2,
      totalEligibleSources: 2,
      complete: true,
    });
  });

  test("forced department refresh invalidates a current function even when its snapshot is unchanged", async () => {
    configureFoundry();
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const root = await seedRoot(ctx);
      await insertProcess(ctx, {
        departmentId: root.departmentId,
        name: "Current process",
        artifact: processArtifact("current"),
        artifactRevision: 1,
      });
      await ctx.db.patch(root.functionId, {
        summaryV2: functionArtifact("current-function"),
        summary: "current function",
        summaryStale: false,
        summarySourceRevision: 5,
        summaryV2SourceRevision: 5,
      });
      await ctx.db.patch(root.departmentId, {
        summaryV2: departmentArtifact("old"),
        summaryV2SourceRevision: 1,
        summaryStale: false,
      });
      return root;
    });
    const { runId, generationId } = await startDepartmentRun(
      t,
      seeded.departmentId,
      true,
    );
    await t.run(async (ctx) => {
      const run = await ctx.db.get(runId);
      const department = await ctx.db.get(seeded.departmentId);
      await ctx.db.patch(seeded.departmentId, {
        summaryV2: {
          ...department!.summaryV2!,
          provenance: {
            ...department!.summaryV2!.provenance,
            sourceSnapshotHash: run!.sourceSnapshot.hash,
          },
        },
      });
    });
    stubClaude();
    await t.action(internal.hierarchySummaryV2.generateHierarchyFinal, {
      runId,
      generationId,
    });
    const fn = await t.run((ctx) => ctx.db.get(seeded.functionId));
    expect(fn?.summaryStale).toBe(true);
    expect(fn?.summarySourceRevision).toBe(6);
  });

  test("a child change after final claim cannot publish a superseded department artifact", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const root = await seedRoot(ctx);
      await insertProcess(ctx, {
        departmentId: root.departmentId,
        name: "Current process",
        artifact: processArtifact("current"),
        artifactRevision: 1,
      });
      const previous = departmentArtifact("previous");
      await ctx.db.patch(root.departmentId, {
        summaryV2: previous,
        summary: renderSummaryV2AsLegacyMarkdown(previous),
        summaryV2SourceRevision: 0,
        summaryStale: true,
      });
      return { ...root, previous };
    });
    const { runId, generationId } = await startDepartmentRun(
      t,
      seeded.departmentId,
    );
    expect(
      await t.mutation(internal.hierarchySummaryV2.claimHierarchyFinal, {
        runId,
        generationId,
      }),
    ).toBe(true);
    await t.mutation(internal.summariesHelpers.markDepartmentSummaryStale, {
      departmentId: seeded.departmentId,
    });
    const run = await t.run((ctx) => ctx.db.get(runId));
    const candidate: DepartmentOverviewArtifactV2 = {
      ...departmentArtifact("candidate"),
      coverage: {
        includedSources: 1,
        totalEligibleSources: 1,
        complete: true,
      },
      provenance: {
        ...departmentArtifact("candidate").provenance,
        sourceSnapshotHash: run!.sourceSnapshot.hash,
      },
    };
    const result = await t.mutation(
      internal.hierarchySummaryV2.saveDepartmentFinal,
      {
        runId,
        generationId,
        sourceRevision: run!.sourceRevision ?? 0,
        artifact: candidate,
      },
    );
    const stored = await t.run(async (ctx) => ({
      department: await ctx.db.get(seeded.departmentId),
      run: await ctx.db.get(runId),
    }));
    expect(result.saved).toBe(false);
    expect(stored.run?.error?.code).toBe("superseded");
    expect(stored.department?.summaryV2).toEqual(seeded.previous);
  });

  test("concurrent department refresh requests coalesce and protect the first generation", async () => {
    const t = convexTest(schema, modules);
    const { departmentId } = await t.run(seedRoot);
    const first = await t.mutation(
      internal.hierarchySummaryV2.requestDepartmentSummaryV2,
      { departmentId, clerkOrgId: ORG },
    );
    const second = await t.mutation(
      internal.hierarchySummaryV2.requestDepartmentSummaryV2,
      { departmentId, clerkOrgId: ORG, forceRefresh: true },
    );
    const department = await t.run((ctx) => ctx.db.get(departmentId));
    expect(first.scheduled).toBe(true);
    expect(second).toEqual({
      scheduled: false,
      generationId: first.generationId,
    });
    expect(department?.summaryRegenRequestedAgain).toBe(true);
    expect(department?.summaryForceRefreshRequested).toBe(true);
  });

  test("process and department rename or move invalidate every affected parent", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const first = await seedRoot(ctx);
      const secondFunctionId = await ctx.db.insert("functions", {
        name: "Finance",
        sortOrder: 2,
        summarySourceRevision: 0,
        clerkOrgId: ORG,
      });
      const secondDepartmentId = await ctx.db.insert("departments", {
        functionId: secondFunctionId,
        name: "Payments",
        sortOrder: 1,
        summarySourceRevision: 0,
        clerkOrgId: ORG,
      });
      const processId = await insertProcess(ctx, {
        departmentId: first.departmentId,
        name: "Handle request",
      });
      return { ...first, secondFunctionId, secondDepartmentId, processId };
    });
    const createdDepartmentId = await t.mutation(
      internal.departments.createInternal,
      {
        functionId: seeded.secondFunctionId,
        name: "Created department",
        clerkOrgId: ORG,
        descriptionUpdate: { kind: "unchanged" },
      },
    );
    await t.mutation(internal.processes.createInternal, {
      departmentId: createdDepartmentId,
      name: "Created process",
      clerkOrgId: ORG,
      descriptionUpdate: { kind: "unchanged" },
    });
    await t.mutation(internal.processes.updateInternal, {
      processId: seeded.processId,
      name: "Handle renamed request",
      clerkOrgId: ORG,
      descriptionUpdate: { kind: "unchanged" },
    });
    await t.mutation(internal.processes.updateInternal, {
      processId: seeded.processId,
      name: "Handle renamed request",
      departmentId: seeded.secondDepartmentId,
      clerkOrgId: ORG,
      descriptionUpdate: { kind: "unchanged" },
    });
    await t.mutation(internal.departments.updateInternal, {
      departmentId: seeded.secondDepartmentId,
      name: "Payments renamed",
      functionId: seeded.functionId,
      clerkOrgId: ORG,
      descriptionUpdate: { kind: "unchanged" },
    });
    const stored = await t.run(async (ctx) => ({
      firstDepartment: await ctx.db.get(seeded.departmentId),
      secondDepartment: await ctx.db.get(seeded.secondDepartmentId),
      createdDepartment: await ctx.db.get(createdDepartmentId),
      firstFunction: await ctx.db.get(seeded.functionId),
      secondFunction: await ctx.db.get(seeded.secondFunctionId),
    }));
    expect(stored.firstDepartment?.summarySourceRevision).toBeGreaterThan(1);
    expect(stored.secondDepartment?.summarySourceRevision).toBeGreaterThan(0);
    expect(stored.createdDepartment?.summarySourceRevision).toBe(1);
    expect(stored.firstFunction?.summarySourceRevision).toBeGreaterThan(1);
    expect(stored.secondFunction?.summarySourceRevision).toBeGreaterThan(0);
  });
});
