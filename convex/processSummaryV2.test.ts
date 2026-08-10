/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { hashTranscript } from "./lib/transcriptHash";
import schema from "./schema";
import {
  renderSummaryV2AsLegacyMarkdown,
  SUMMARY_V2_PROMPT_VERSIONS,
  type ProcessOverviewArtifactV2,
} from "./summaryV2";

const modules = import.meta.glob("./**/*.ts");
const ORG = "org_process_summary_v2";
const AI_ENV = [
  "AI_PROVIDER",
  "FOUNDRY_ENDPOINT",
  "FOUNDRY_API_KEY",
  "FOUNDRY_CLAUDE_DEPLOYMENT",
  "SUMMARY_V2",
] as const;

function configureFoundry(): void {
  process.env.AI_PROVIDER = "foundry";
  process.env.FOUNDRY_ENDPOINT = "https://fabric-test.services.ai.azure.com";
  process.env.FOUNDRY_API_KEY = "test-key";
  process.env.FOUNDRY_CLAUDE_DEPLOYMENT = "fabric-claude";
}

function oldArtifact(): ProcessOverviewArtifactV2 {
  return {
    schemaVersion: "v2",
    sourceMode: "interview_evidence",
    headline: "Previous successful overview",
    executiveBrief: "This artifact must survive a failed refresh.",
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
      sourceSnapshotHash: "old-snapshot",
      generatedAt: 1,
      promptVersion: SUMMARY_V2_PROMPT_VERSIONS.processOverview,
      provider: "fabric-foundry",
      model: "old-model",
    },
  };
}

async function seed(
  ctx: MutationCtx,
  conversationCount: number,
  withPreviousArtifact = false,
) {
  const functionId = await ctx.db.insert("functions", {
    name: "Operations",
    sortOrder: 0,
    clerkOrgId: ORG,
  });
  const departmentId = await ctx.db.insert("departments", {
    functionId,
    name: "Service",
    sortOrder: 0,
    clerkOrgId: ORG,
  });
  const previous = withPreviousArtifact ? oldArtifact() : null;
  const processId = await ctx.db.insert("processes", {
    departmentId,
    name: "Handle request",
    sortOrder: 0,
    clerkOrgId: ORG,
    summaryEvidenceRevision: 1,
    ...(previous
      ? {
          summaryV2: previous,
          rollingSummary: renderSummaryV2AsLegacyMarkdown(previous),
          summaryUpdatedAt: previous.provenance.generatedAt,
        }
      : {}),
  });
  const conversationIds: Id<"conversations">[] = [];
  for (let index = 0; index < conversationCount; index += 1) {
    const transcript = [
      {
        role: "user",
        content: `Contributor ${index + 1} receives and checks request ${index + 1}.`,
        time_in_call_secs: index,
        speakerName: `Contributor ${index + 1}`,
      },
    ];
    const transcriptHash = hashTranscript(transcript);
    conversationIds.push(
      await ctx.db.insert("conversations", {
        processId,
        contributorName: `Contributor ${index + 1}`,
        transcript,
        status: "done",
        clerkOrgId: ORG,
        processSummaryEvidenceV2: {
          schemaVersion: "v2",
          sourceMode: "interview_evidence",
          steps: [
            {
              id: `step-${index + 1}`,
              title: "Receive and check request",
              body: `Contributor ${index + 1} receives and checks the request.`,
            },
          ],
          actors: [`Contributor ${index + 1}`],
          tools: ["Request form"],
          handoffsAndDependencies: ["Finance approval follows the check"],
          reportedVariations:
            index % 2 === 0 ? ["Urgent requests may arrive by email"] : [],
          frictionPoints: ["Approval is followed up manually"],
          uncertainties:
            index === 0 ? ["The escalation owner is unclear"] : [],
          transcriptHash,
          promptVersion: SUMMARY_V2_PROMPT_VERSIONS.conversationEvidence,
          generatedAt: 1,
          provider: "fabric-foundry",
          model: "evidence-model",
        },
      }),
    );
  }
  return { processId, departmentId, conversationIds };
}

async function startScannedRun(
  t: ReturnType<typeof convexTest>,
  processId: Id<"processes">,
) {
  const requested = await t.mutation(
    internal.processSummaryV2.requestProcessSummaryV2,
    { processId, clerkOrgId: ORG },
  );
  const runId = await t.mutation(internal.processSummaryV2.startProcessRun, {
    processId,
    clerkOrgId: ORG,
    generationId: requested.generationId,
  });
  if (!runId) throw new Error("Run did not start");
  for (let page = 0; page < 20; page += 1) {
    await t.mutation(internal.processSummaryV2.scanProcessSources, {
      runId,
      generationId: requested.generationId,
    });
    const run = await t.run((ctx) => ctx.db.get(runId));
    if (!run?.sourceScan) {
      return { runId, generationId: requested.generationId, run };
    }
  }
  throw new Error("Source scan did not finish");
}

type StubMode = "valid" | "invalid" | "truncated";

function overviewPayload(keys: string[]) {
  const uniqueKeys = [...new Set(keys)];
  const first = uniqueKeys[0] ?? "C1";
  const corroborated = uniqueKeys.slice(0, 2);
  return {
    headline: "How requests are handled",
    executiveBrief:
      "Contributors describe receiving, checking, and handing requests to Finance.",
    scope: [
      {
        title: "Who runs the work",
        body: "The service contributor owns intake and checking; Finance owns approval.",
        evidenceLevel:
          corroborated.length > 1 ? "corroborated" : "single_source",
        sourceKeys: corroborated.length > 1 ? corroborated : [first],
      },
    ],
    consensus:
      corroborated.length > 1
        ? [
            {
              title: "Finance approval follows checking",
              body: "Multiple contributors describe Finance approval after checking.",
              evidenceLevel: "corroborated",
              sourceKeys: corroborated,
            },
          ]
        : [],
    variations:
      uniqueKeys.length > 1
        ? [
            {
              title: "Contributors disagree on urgent intake",
              body: "One contributor reports email intake while another reports the standard request form.",
              evidenceLevel: "corroborated",
              sourceKeys: [first, uniqueKeys[uniqueKeys.length - 1]],
            },
          ]
        : [],
    gaps: [
      {
        title: "Escalation ownership is unclear",
        body: "The evidence does not establish who owns escalation.",
        evidenceLevel: "inferred_gap",
        sourceKeys: [],
      },
    ],
    notable: [
      {
        title: "Manual follow-up is reported",
        body: "A contributor reports following up approval manually.",
        evidenceLevel: "single_source",
        sourceKeys: [first],
      },
    ],
  };
}

function stubClaude(mode: StubMode = "valid") {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = (await request.clone().json()) as {
        tools?: Array<{ name: string }>;
        messages?: Array<{ content: string }>;
      };
      const keys = body.messages?.[0]?.content.match(/C\d+/g) ?? [];
      const payload =
        mode === "truncated"
          ? {
              id: "msg_truncated",
              type: "message",
              role: "assistant",
              model: "fabric-claude",
              content: [],
              stop_reason: "max_tokens",
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 3072 },
            }
          : {
              id: `msg_${fetchMock.mock.calls.length}`,
              type: "message",
              role: "assistant",
              model: "fabric-claude",
              content: [
                {
                  type: "tool_use",
                  id: "tool_1",
                  name: body.tools?.[0]?.name ?? "return_process_overview",
                  input:
                    mode === "invalid"
                      ? { headline: "Incomplete" }
                      : overviewPayload(keys),
                },
              ],
              stop_reason: "tool_use",
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 20 },
            };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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

describe("process Summary V2 pipeline", () => {
  test("one source reduces directly and dual-writes deterministic Markdown", async () => {
    configureFoundry();
    const t = convexTest(schema, modules);
    const { processId } = await t.run((ctx) => seed(ctx, 1));
    await t.run(async (ctx) => {
      await ctx.db.insert("processFlows", {
        processId,
        clerkOrgId: ORG,
        status: "ready",
        stale: false,
        generatedAt: 1,
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
      });
    });
    const { runId, generationId } = await startScannedRun(t, processId);
    const fetchMock = stubClaude();

    await t.action(internal.processSummaryV2.generateProcessFinal, {
      runId,
      generationId,
    });

    const stored = await t.run(async (ctx) => ({
      process: await ctx.db.get(processId),
      run: await ctx.db.get(runId),
      flow: await ctx.db
        .query("processFlows")
        .withIndex("by_clerkOrgId_and_processId", (q) =>
          q.eq("clerkOrgId", ORG).eq("processId", processId),
        )
        .unique(),
      usage: await ctx.db.query("aiUsageEvents").collect(),
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stored.run?.chunkCount).toBe(1);
    expect(stored.run?.state).toBe("succeeded");
    expect(stored.process?.summaryV2?.coverage).toMatchObject({
      includedSources: 1,
      totalEligibleSources: 1,
      complete: true,
    });
    expect(stored.process?.rollingSummary).toBe(
      renderSummaryV2AsLegacyMarkdown(stored.process!.summaryV2!),
    );
    expect(stored.flow?.stale).toBe(false);
    expect(stored.usage[0]).toMatchObject({
      operation: "process-summary-v2-final",
      entityType: "process",
      entityId: processId,
      runId: generationId,
    });
  });

  test("partial evidence keeps included source keys contiguous and reports exact coverage", async () => {
    configureFoundry();
    const t = convexTest(schema, modules);
    const { processId, conversationIds } = await t.run((ctx) => seed(ctx, 3));
    await t.run((ctx) =>
      ctx.db.patch(conversationIds[1], {
        processSummaryEvidenceV2: undefined,
      }),
    );
    const { runId, generationId } = await startScannedRun(t, processId);
    const chunk = await t.run(async (ctx) =>
      await ctx.db
        .query("summaryChunks")
        .withIndex("by_clerkOrgId_and_summaryRunId_and_chunkIndex", (q) =>
          q.eq("clerkOrgId", ORG).eq("summaryRunId", runId).eq("chunkIndex", 0),
        )
        .unique(),
    );
    expect(chunk?.sourceInputs?.map(({ key, conversationId }) => ({
      key,
      conversationId,
    }))).toEqual([
      { key: "C1", conversationId: conversationIds[0] },
      { key: "C2", conversationId: conversationIds[2] },
    ]);

    stubClaude();
    await t.action(internal.processSummaryV2.generateProcessFinal, {
      runId,
      generationId,
    });
    const stored = await t.run(async (ctx) => ({
      process: await ctx.db.get(processId),
      run: await ctx.db.get(runId),
    }));
    expect(stored.run?.state).toBe("partial");
    expect(stored.process?.summaryV2?.coverage).toEqual({
      includedSources: 2,
      totalEligibleSources: 3,
      uniqueContributors: 2,
      complete: false,
    });
  });

  test("55 ordered sources preserve agreement, contradiction, uncertainty, and exact coverage", async () => {
    configureFoundry();
    const t = convexTest(schema, modules);
    const { processId } = await t.run((ctx) => seed(ctx, 55));
    const { runId, generationId, run } = await startScannedRun(t, processId);
    expect(run?.chunkCount).toBe(3);
    const sourceKeys = await t.run(async (ctx) => {
      const chunks = await ctx.db
        .query("summaryChunks")
        .withIndex("by_clerkOrgId_and_summaryRunId_and_chunkIndex", (q) =>
          q.eq("clerkOrgId", ORG).eq("summaryRunId", runId),
        )
        .collect();
      return chunks.flatMap((chunk) =>
        (chunk.sourceInputs ?? []).map((source) => source.key),
      );
    });
    expect(sourceKeys).toEqual(
      Array.from({ length: 55 }, (_, index) => `C${index + 1}`),
    );
    const fetchMock = stubClaude();

    for (let chunkIndex = 0; chunkIndex < 3; chunkIndex += 1) {
      await t.action(internal.processSummaryV2.generateProcessChunk, {
        runId,
        generationId,
        chunkIndex,
      });
    }
    await t.action(internal.processSummaryV2.generateProcessFinal, {
      runId,
      generationId,
    });

    const stored = await t.run((ctx) => ctx.db.get(processId));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(stored?.summaryV2?.coverage).toEqual({
      includedSources: 55,
      totalEligibleSources: 55,
      uniqueContributors: 55,
      complete: true,
    });
    expect(stored?.summaryV2?.consensus).toHaveLength(1);
    expect(stored?.summaryV2?.variations).toHaveLength(1);
    expect(stored?.summaryV2?.variations[0].title).toMatch(/disagree/i);
    expect(stored?.summaryV2?.gaps[0].evidenceLevel).toBe("inferred_gap");
  });

  test("chunk validation failure retries without losing completed progress", async () => {
    configureFoundry();
    const t = convexTest(schema, modules);
    const { processId } = await t.run((ctx) => seed(ctx, 21));
    const { runId, generationId } = await startScannedRun(t, processId);
    stubClaude("invalid");
    await t.action(internal.processSummaryV2.generateProcessChunk, {
      runId,
      generationId,
      chunkIndex: 0,
    });
    let chunk = await t.run(async (ctx) =>
      await ctx.db
        .query("summaryChunks")
        .withIndex("by_clerkOrgId_and_summaryRunId_and_chunkIndex", (q) =>
          q.eq("clerkOrgId", ORG).eq("summaryRunId", runId).eq("chunkIndex", 0),
        )
        .unique(),
    );
    expect(chunk?.state).toBe("queued");
    expect(chunk?.attempt).toBe(1);

    vi.unstubAllGlobals();
    stubClaude("valid");
    await t.action(internal.processSummaryV2.generateProcessChunk, {
      runId,
      generationId,
      chunkIndex: 0,
    });
    chunk = await t.run(async (ctx) =>
      await ctx.db
        .query("summaryChunks")
        .withIndex("by_clerkOrgId_and_summaryRunId_and_chunkIndex", (q) =>
          q.eq("clerkOrgId", ORG).eq("summaryRunId", runId).eq("chunkIndex", 0),
        )
        .unique(),
    );
    expect(chunk?.state).toBe("succeeded");
    expect(chunk?.attempt).toBe(2);
    const run = await t.run((ctx) => ctx.db.get(runId));
    expect(run?.progress).toEqual({
      stage: "chunk_reduce",
      completed: 1,
      total: 2,
    });
  });

  test.each(["invalid", "truncated"] as const)(
    "%s final output retains the previous successful artifact",
    async (mode) => {
      configureFoundry();
      const t = convexTest(schema, modules);
      const { processId } = await t.run((ctx) => seed(ctx, 1, true));
      const { runId, generationId } = await startScannedRun(t, processId);
      stubClaude(mode);
      await t.action(internal.processSummaryV2.generateProcessFinal, {
        runId,
        generationId,
      });
      await t.action(internal.processSummaryV2.generateProcessFinal, {
        runId,
        generationId,
      });
      const stored = await t.run(async (ctx) => ({
        process: await ctx.db.get(processId),
        run: await ctx.db.get(runId),
      }));
      expect(stored.run?.state).toBe("failed");
      expect(stored.process?.summaryV2).toEqual(oldArtifact());
      expect(stored.process?.rollingSummary).toBe(
        renderSummaryV2AsLegacyMarkdown(oldArtifact()),
      );
    },
  );

  test("concurrent requests supersede the old generation before it can write", async () => {
    configureFoundry();
    const t = convexTest(schema, modules);
    const { processId } = await t.run((ctx) => seed(ctx, 1, true));
    const { runId, generationId } = await startScannedRun(t, processId);
    const second = await t.mutation(
      internal.processSummaryV2.requestProcessSummaryV2,
      { processId, clerkOrgId: ORG },
    );
    expect(second.scheduled).toBe(false);
    const fetchMock = stubClaude();
    await t.action(internal.processSummaryV2.generateProcessFinal, {
      runId,
      generationId,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const run = await t.run((ctx) => ctx.db.get(runId));
    expect(run?.state).toBe("failed");
    expect(run?.error?.code).toBe("superseded");
    expect((await t.run((ctx) => ctx.db.get(processId)))?.summaryV2).toEqual(
      oldArtifact(),
    );
  });

  test("a superseded final write cannot replace the previous artifact", async () => {
    const t = convexTest(schema, modules);
    const { processId } = await t.run((ctx) => seed(ctx, 1, true));
    const { runId, generationId, run } = await startScannedRun(t, processId);
    expect(
      await t.mutation(internal.processSummaryV2.claimProcessFinal, {
        runId,
        generationId,
      }),
    ).toBe(true);
    await t.mutation(internal.processSummaryV2.requestProcessSummaryV2, {
      processId,
      clerkOrgId: ORG,
    });
    const candidate: ProcessOverviewArtifactV2 = {
      ...oldArtifact(),
      headline: "This late result must not be saved",
      provenance: {
        ...oldArtifact().provenance,
        sourceSnapshotHash: run!.sourceSnapshot.hash,
      },
    };
    const result = await t.mutation(
      internal.processSummaryV2.saveProcessFinal,
      {
        runId,
        generationId,
        sourceRevision: run!.sourceRevision ?? 0,
        artifact: candidate,
      },
    );
    const stored = await t.run(async (ctx) => ({
      process: await ctx.db.get(processId),
      run: await ctx.db.get(runId),
    }));
    expect(result.saved).toBe(false);
    expect(stored.run?.error?.code).toBe("superseded");
    expect(stored.process?.summaryV2).toEqual(oldArtifact());
  });

  test("disabling the feature flag blocks an in-flight final result", async () => {
    configureFoundry();
    const t = convexTest(schema, modules);
    const { processId } = await t.run((ctx) => seed(ctx, 1, true));
    const { runId, generationId } = await startScannedRun(t, processId);
    process.env.SUMMARY_V2 = "false";
    const fetchMock = stubClaude();
    await t.action(internal.processSummaryV2.generateProcessFinal, {
      runId,
      generationId,
    });
    const stored = await t.run(async (ctx) => ({
      process: await ctx.db.get(processId),
      run: await ctx.db.get(runId),
    }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stored.run?.error?.code).toBe("feature_disabled");
    expect(stored.process?.summaryV2).toEqual(oldArtifact());
  });

  test("relabeling and deletion change the exact source snapshot", async () => {
    const t = convexTest(schema, modules);
    const { processId, conversationIds } = await t.run((ctx) => seed(ctx, 2));
    const first = await startScannedRun(t, processId);
    const firstSnapshot = first.run?.sourceSnapshot;
    await t.run(async (ctx) => {
      const conversation = await ctx.db.get(conversationIds[0]);
      await ctx.db.patch(conversationIds[0], {
        transcript: conversation?.transcript?.map((message) => ({
          ...message,
          speakerName: "Relabelled contributor",
        })),
      });
      await ctx.db.delete(conversationIds[1]);
      await ctx.db.patch(processId, {
        summaryRegenScheduledAt: undefined,
        summaryRegenRequestedAgain: undefined,
        summaryV2GenerationId: undefined,
        summaryV2RunId: undefined,
      });
    });
    const second = await startScannedRun(t, processId);
    expect(second.run?.sourceSnapshot.hash).not.toBe(firstSnapshot?.hash);
    expect(second.run?.sourceSnapshot.totalEligibleSources).toBe(1);
    expect(firstSnapshot?.totalEligibleSources).toBe(2);
  });

  test("the watchdog resumes stale durable scan state", async () => {
    const t = convexTest(schema, modules);
    const { processId } = await t.run((ctx) => seed(ctx, 25));
    const requested = await t.mutation(
      internal.processSummaryV2.requestProcessSummaryV2,
      { processId, clerkOrgId: ORG },
    );
    const runId = await t.mutation(internal.processSummaryV2.startProcessRun, {
      processId,
      clerkOrgId: ORG,
      generationId: requested.generationId,
    });
    if (!runId) throw new Error("Run did not start");
    await t.run(async (ctx) => {
      await ctx.db.patch(runId, {
        lastProgressAt: Date.now() - 20 * 60_000,
      });
    });
    await t.mutation(internal.processSummaryV2.reapStuckProcessSummaryRuns, {});
    const run = await t.run((ctx) => ctx.db.get(runId));
    expect(run?.resumeCount).toBe(1);
    expect(run?.lastProgressAt).toBeGreaterThan(Date.now() - 60_000);
    expect(run?.sourceScan).toBeDefined();
  });

  test("bounded cleanup retains the newest terminal run", async () => {
    const t = convexTest(schema, modules);
    const { processId } = await t.run((ctx) => seed(ctx, 1));
    const ids = await t.run(async (ctx) => {
      const base = {
        clerkOrgId: ORG,
        entity: { kind: "process" as const, processId },
        entityKey: `process:${processId}`,
        sourceSnapshot: {
          hash: "cleanup-snapshot",
          includedSources: 1,
          totalEligibleSources: 1,
        },
        state: "succeeded" as const,
        progress: { stage: "final_reduce" as const, completed: 1, total: 1 },
        attempt: 1,
        maxAttempts: 2,
        resumeCount: 0,
      };
      const oldRunId = await ctx.db.insert("summaryRuns", {
        ...base,
        generationId: "old-generation",
        createdAt: 1,
        completedAt: 2,
      });
      const newestRunId = await ctx.db.insert("summaryRuns", {
        ...base,
        generationId: "new-generation",
        createdAt: 3,
        completedAt: 4,
      });
      const oldChunkId = await ctx.db.insert("summaryChunks", {
        clerkOrgId: ORG,
        summaryRunId: oldRunId,
        generationId: "old-generation",
        chunkIndex: 0,
        sourceCount: 1,
        state: "succeeded",
        attempt: 1,
        createdAt: 1,
      });
      return { oldRunId, newestRunId, oldChunkId };
    });

    await t.mutation(
      internal.processSummaryV2.cleanupSupersededProcessRuns,
      { processId, clerkOrgId: ORG },
    );
    const remaining = await t.run(async (ctx) => ({
      oldRun: await ctx.db.get(ids.oldRunId),
      newestRun: await ctx.db.get(ids.newestRunId),
      oldChunk: await ctx.db.get(ids.oldChunkId),
    }));
    expect(remaining.oldRun).toBeNull();
    expect(remaining.oldChunk).toBeNull();
    expect(remaining.newestRun).not.toBeNull();
  });

  test("the feature flag routes the post-evidence handoff to V2", async () => {
    process.env.SUMMARY_V2 = "true";
    const t = convexTest(schema, modules);
    const { processId } = await t.run((ctx) => seed(ctx, 1));
    const evidenceRequest = await t.mutation(
      internal.summaryEvidence.requestProcessEvidenceRefresh,
      { processId, clerkOrgId: ORG },
    );
    await t.mutation(internal.summaryEvidence.finishProcessEvidenceRefresh, {
      processId,
      clerkOrgId: ORG,
      generationId: evidenceRequest.generationId,
    });
    const storedProcess = await t.run((ctx) => ctx.db.get(processId));
    expect(storedProcess?.summaryV2GenerationId).toEqual(expect.any(String));
    expect(storedProcess?.summaryV2RunId).toBeUndefined();
    expect(storedProcess?.summaryRegenScheduledAt).toEqual(expect.any(Number));
  });
});
