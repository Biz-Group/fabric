/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import schema from "./schema";
import {
  getSummaryEntityKey,
  SUMMARY_V2_PROMPT_VERSIONS,
  type DepartmentOverviewArtifactV2,
  type FunctionOverviewArtifactV2,
  type ProcessOverviewArtifactV2,
  type ProcessSummaryEvidenceV2,
  type SummaryCoverage,
  type SummaryFinding,
  type SummaryProvenance,
  type SummarySourceRef,
} from "./summaryV2";

const modules = import.meta.glob("./**/*.ts");
const ORG_A = "org_summary_v2_a";
const ORG_B = "org_summary_v2_b";
const GENERATED_AT = 1_786_000_000_000;

type Seeded = {
  functionId: Id<"functions">;
  departmentId: Id<"departments">;
  processId: Id<"processes">;
  conversationId: Id<"conversations">;
};

async function seedHierarchy(ctx: MutationCtx, clerkOrgId: string): Promise<Seeded> {
  const functionId = await ctx.db.insert("functions", {
    name: "Synthetic function",
    sortOrder: 0,
    clerkOrgId,
  });
  const departmentId = await ctx.db.insert("departments", {
    functionId,
    name: "Synthetic department",
    sortOrder: 0,
    clerkOrgId,
  });
  const processId = await ctx.db.insert("processes", {
    departmentId,
    name: "Synthetic process",
    sortOrder: 0,
    clerkOrgId,
  });
  const conversationId = await ctx.db.insert("conversations", {
    processId,
    contributorName: "Contributor A",
    status: "done",
    clerkOrgId,
  });
  return { functionId, departmentId, processId, conversationId };
}

function coverage(complete = true): SummaryCoverage {
  return {
    includedSources: complete ? 1 : 0,
    totalEligibleSources: 1,
    uniqueContributors: 1,
    complete,
  };
}

function provenance(promptVersion: string): SummaryProvenance {
  return {
    sourceSnapshotHash: "sha256:synthetic",
    generatedAt: GENERATED_AT,
    promptVersion,
    provider: "fabric-foundry",
    model: "test-model",
  };
}

function finding(source: SummarySourceRef): SummaryFinding {
  return {
    id: "finding-1",
    title: "Synthetic finding",
    body: "A bounded finding backed by a synthetic source.",
    evidenceLevel: "single_source",
    supportCount: 1,
    sources: [source],
  };
}

function processArtifact(ids: Seeded): ProcessOverviewArtifactV2 {
  const item = finding({
    kind: "conversation",
    conversationId: ids.conversationId,
    label: "Contributor A · Interview 1",
  });
  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    headline: "Synthetic process overview",
    executiveBrief: "A structured brief for schema validation.",
    scope: [item],
    consensus: [],
    variations: [],
    gaps: [],
    notable: [],
    coverage: coverage(),
    provenance: provenance(SUMMARY_V2_PROMPT_VERSIONS.processOverview),
  };
}

function departmentArtifact(ids: Seeded): DepartmentOverviewArtifactV2 {
  const item = finding({
    kind: "process",
    processId: ids.processId,
    label: "Synthetic process",
  });
  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    headline: "Synthetic department overview",
    executiveBrief: "A structured department brief for schema validation.",
    crossProcessDependencies: [item],
    sharedPatterns: [],
    variationsAndTensions: [],
    gaps: [],
    notable: [],
    coverage: coverage(),
    provenance: provenance(SUMMARY_V2_PROMPT_VERSIONS.departmentOverview),
  };
}

function functionArtifact(ids: Seeded): FunctionOverviewArtifactV2 {
  const item = finding({
    kind: "department",
    departmentId: ids.departmentId,
    label: "Synthetic department",
  });
  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    headline: "Synthetic function overview",
    executiveBrief: "A structured function brief for schema validation.",
    crossDepartmentDependencies: [item],
    strategicPatterns: [],
    variationsAndTensions: [],
    gaps: [],
    notable: [],
    coverage: coverage(),
    provenance: provenance(SUMMARY_V2_PROMPT_VERSIONS.functionOverview),
  };
}

function conversationEvidence(): ProcessSummaryEvidenceV2 {
  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    steps: [
      {
        id: "step-1",
        title: "Receive request",
        body: "The request is received in a shared queue.",
      },
    ],
    actors: ["Coordinator"],
    tools: ["Shared queue"],
    handoffsAndDependencies: ["Coordinator sends request to approver"],
    reportedVariations: [],
    frictionPoints: [],
    uncertainties: ["Final confirmation owner is not documented"],
    transcriptHash: "sha256:transcript",
    promptVersion: SUMMARY_V2_PROMPT_VERSIONS.conversationEvidence,
    generatedAt: GENERATED_AT,
    provider: "fabric-foundry",
    model: "test-model",
  };
}

describe("Summary V2 schema", () => {
  test("stores every artifact and source-reference union branch", async () => {
    const t = convexTest(schema, modules);
    const stored = await t.run(async (ctx) => {
      const ids = await seedHierarchy(ctx, ORG_A);
      await ctx.db.patch(ids.functionId, { summaryV2: functionArtifact(ids) });
      await ctx.db.patch(ids.departmentId, {
        summaryV2: departmentArtifact(ids),
      });
      await ctx.db.patch(ids.processId, {
        summaryV2: processArtifact(ids),
        summaryUpdatedAt: GENERATED_AT,
      });
      await ctx.db.patch(ids.conversationId, {
        processSummaryEvidenceV2: conversationEvidence(),
      });
      return {
        fn: await ctx.db.get(ids.functionId),
        department: await ctx.db.get(ids.departmentId),
        process: await ctx.db.get(ids.processId),
        conversation: await ctx.db.get(ids.conversationId),
      };
    });

    expect(
      stored.fn?.summaryV2?.crossDepartmentDependencies[0].sources[0].kind,
    ).toBe("department");
    expect(
      stored.department?.summaryV2?.crossProcessDependencies[0].sources[0]
        .kind,
    ).toBe("process");
    expect(stored.process?.summaryV2?.scope[0].sources[0].kind).toBe(
      "conversation",
    );
    expect(stored.process?.summaryUpdatedAt).toBe(GENERATED_AT);
    expect(stored.conversation?.processSummaryEvidenceV2?.steps).toHaveLength(1);
  });

  test("legacy hierarchy and flow rows remain valid without V2 fields", async () => {
    const t = convexTest(schema, modules);
    const rows = await t.run(async (ctx) => {
      const ids = await seedHierarchy(ctx, ORG_A);
      const flowId = await ctx.db.insert("processFlows", {
        processId: ids.processId,
        status: "ready",
        stale: false,
        generatedAt: GENERATED_AT,
        conversationCount: 1,
        nodes: [],
        edges: [],
        insights: {
          criticalPath: [],
          handoffCount: 0,
          toolCount: 0,
          automationOpportunities: [],
          topBottlenecks: [],
        },
        clerkOrgId: ORG_A,
      });
      return {
        process: await ctx.db.get(ids.processId),
        flow: await ctx.db.get(flowId),
      };
    });
    expect(rows.process?.summaryV2).toBeUndefined();
    expect(rows.flow?.summarySourceSnapshot).toBeUndefined();
  });

  test("new flows may persist optional overview snapshot provenance", async () => {
    const t = convexTest(schema, modules);
    const flow = await t.run(async (ctx) => {
      const ids = await seedHierarchy(ctx, ORG_A);
      const flowId = await ctx.db.insert("processFlows", {
        processId: ids.processId,
        status: "ready",
        stale: false,
        generatedAt: GENERATED_AT,
        conversationCount: 1,
        summarySourceSnapshot: {
          sourceSnapshotHash: "sha256:synthetic",
          summaryGeneratedAt: GENERATED_AT,
          summaryPromptVersion: SUMMARY_V2_PROMPT_VERSIONS.processOverview,
        },
        nodes: [],
        edges: [],
        insights: {
          criticalPath: [],
          handoffCount: 0,
          toolCount: 0,
          automationOpportunities: [],
          topBottlenecks: [],
        },
        clerkOrgId: ORG_A,
      });
      return await ctx.db.get(flowId);
    });
    expect(flow?.summarySourceSnapshot?.sourceSnapshotHash).toBe(
      "sha256:synthetic",
    );
  });

  test("rejects an artifact with a source outside the strict union", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.run(async (ctx) => {
        const ids = await seedHierarchy(ctx, ORG_A);
        const invalid = processArtifact(ids) as unknown as ProcessOverviewArtifactV2;
        invalid.scope[0].sources = [
          {
            kind: "external",
            externalId: "outside",
            label: "Outside source",
          } as unknown as SummarySourceRef,
        ];
        await ctx.db.patch(ids.processId, { summaryV2: invalid });
      }),
    ).rejects.toThrow();
  });

  test("stores every summary-run entity union branch and bounded chunks", async () => {
    const t = convexTest(schema, modules);
    const result = await t.run(async (ctx) => {
      const ids = await seedHierarchy(ctx, ORG_A);
      const entities = [
        { kind: "process" as const, processId: ids.processId },
        { kind: "department" as const, departmentId: ids.departmentId },
        { kind: "function" as const, functionId: ids.functionId },
      ];
      const runIds: Id<"summaryRuns">[] = [];
      for (const [index, entity] of entities.entries()) {
        runIds.push(
          await ctx.db.insert("summaryRuns", {
            clerkOrgId: ORG_A,
            entity,
            entityKey: getSummaryEntityKey(entity),
            generationId: `generation-${index}`,
            sourceSnapshot: {
              hash: `sha256:snapshot-${index}`,
              includedSources: 1,
              totalEligibleSources: 1,
            },
            state: "queued",
            progress: { stage: "evidence", completed: 0, total: 1 },
            createdAt: GENERATED_AT + index,
            attempt: 0,
            maxAttempts: 3,
            resumeCount: 0,
          }),
        );
      }
      const chunkId = await ctx.db.insert("summaryChunks", {
        clerkOrgId: ORG_A,
        summaryRunId: runIds[0],
        generationId: "generation-0",
        chunkIndex: 0,
        sourceCount: 1,
        state: "succeeded",
        output: {
          schemaVersion: "v2",
          headline: "Chunk headline",
          sections: [
            { key: "scope", findings: processArtifact(ids).scope },
          ],
          coverage: coverage(),
        },
        attempt: 1,
        createdAt: GENERATED_AT,
        completedAt: GENERATED_AT + 1,
      });
      return {
        runs: await Promise.all(runIds.map((id) => ctx.db.get(id))),
        chunk: await ctx.db.get(chunkId),
      };
    });

    expect(result.runs.map((run) => run?.entity.kind)).toEqual([
      "process",
      "department",
      "function",
    ]);
    expect(result.chunk?.output?.sections[0].key).toBe("scope");
  });

  test("run and chunk indexes remain tenant scoped", async () => {
    const t = convexTest(schema, modules);
    const result = await t.run(async (ctx) => {
      const idsA = await seedHierarchy(ctx, ORG_A);
      const idsB = await seedHierarchy(ctx, ORG_B);
      const entityA = { kind: "process" as const, processId: idsA.processId };
      const entityB = { kind: "process" as const, processId: idsB.processId };
      const common = {
        generationId: "shared-generation-label",
        sourceSnapshot: {
          hash: "sha256:snapshot",
          includedSources: 1,
          totalEligibleSources: 1,
        },
        state: "running" as const,
        progress: { stage: "chunk_reduce" as const, completed: 0, total: 1 },
        createdAt: GENERATED_AT,
        attempt: 1,
        maxAttempts: 3,
        resumeCount: 0,
      };
      const runA = await ctx.db.insert("summaryRuns", {
        ...common,
        clerkOrgId: ORG_A,
        entity: entityA,
        entityKey: getSummaryEntityKey(entityA),
      });
      await ctx.db.insert("summaryRuns", {
        ...common,
        clerkOrgId: ORG_B,
        entity: entityB,
        entityKey: getSummaryEntityKey(entityB),
      });
      await ctx.db.insert("summaryChunks", {
        clerkOrgId: ORG_A,
        summaryRunId: runA,
        generationId: common.generationId,
        chunkIndex: 0,
        sourceCount: 1,
        state: "queued",
        attempt: 0,
        createdAt: GENERATED_AT,
      });

      const orgARuns = await ctx.db
        .query("summaryRuns")
        .withIndex(
          "by_clerkOrgId_and_entityKey_and_state_and_createdAt",
          (q) =>
            q
              .eq("clerkOrgId", ORG_A)
              .eq("entityKey", getSummaryEntityKey(entityA))
              .eq("state", "running"),
        )
        .collect();
      const orgAChunks = await ctx.db
        .query("summaryChunks")
        .withIndex(
          "by_clerkOrgId_and_summaryRunId_and_state_and_chunkIndex",
          (q) =>
            q
              .eq("clerkOrgId", ORG_A)
              .eq("summaryRunId", runA)
              .eq("state", "queued"),
        )
        .collect();
      return { orgARuns, orgAChunks };
    });

    expect(result.orgARuns).toHaveLength(1);
    expect(result.orgARuns[0].clerkOrgId).toBe(ORG_A);
    expect(result.orgAChunks).toHaveLength(1);
    expect(result.orgAChunks[0].clerkOrgId).toBe(ORG_A);
  });

  test("strict summary-run entity validation rejects mixed union fields", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.run(async (ctx) => {
        const ids = await seedHierarchy(ctx, ORG_A);
        const invalidRun = {
          clerkOrgId: ORG_A,
          entity: {
            kind: "process",
            processId: ids.processId,
            departmentId: ids.departmentId,
          },
          entityKey: `process:${ids.processId}`,
          generationId: "invalid-generation",
          sourceSnapshot: {
            hash: "sha256:invalid",
            includedSources: 1,
            totalEligibleSources: 1,
          },
          state: "queued",
          progress: { stage: "evidence", completed: 0, total: 1 },
          createdAt: GENERATED_AT,
          attempt: 0,
          maxAttempts: 3,
          resumeCount: 0,
        } as unknown as Omit<Doc<"summaryRuns">, "_id" | "_creationTime">;
        await ctx.db.insert("summaryRuns", invalidRun);
      }),
    ).rejects.toThrow();
  });
});
