/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { conversationEvidenceSourceKey } from "./lib/conversationEvidenceV2";
import { hashTranscript } from "./lib/transcriptHash";
import schema from "./schema";
import { SUMMARY_V2_PROMPT_VERSIONS } from "./summaryV2";

const modules = import.meta.glob("./**/*.ts");
const ORG = "org_summary_evidence";
const OTHER_ORG = "org_summary_evidence_other";
const AI_ENV = [
  "AI_PROVIDER",
  "FOUNDRY_ENDPOINT",
  "FOUNDRY_API_KEY",
  "FOUNDRY_CLAUDE_DEPLOYMENT",
] as const;

function configureFoundry(): void {
  process.env.AI_PROVIDER = "foundry";
  process.env.FOUNDRY_ENDPOINT = "https://fabric-test.services.ai.azure.com";
  process.env.FOUNDRY_API_KEY = "test-key";
  process.env.FOUNDRY_CLAUDE_DEPLOYMENT = "fabric-claude";
}

async function seed(ctx: MutationCtx, orgId = ORG) {
  const functionId = await ctx.db.insert("functions", {
    name: "Operations",
    sortOrder: 0,
    clerkOrgId: orgId,
  });
  const departmentId = await ctx.db.insert("departments", {
    functionId,
    name: "Service",
    sortOrder: 0,
    clerkOrgId: orgId,
  });
  const processId = await ctx.db.insert("processes", {
    departmentId,
    name: "Handle request",
    sortOrder: 0,
    clerkOrgId: orgId,
  });
  const conversationId = await ctx.db.insert("conversations", {
    processId,
    contributorName: "Alice",
    transcript: [
      {
        role: "user",
        content: "I receive the request and send it to Finance.",
        time_in_call_secs: 1,
        speakerName: "Alice",
      },
    ],
    status: "done",
    clerkOrgId: orgId,
  });
  return { processId, conversationId };
}

function toolPayload(conversationId: Id<"conversations">) {
  return {
    sourceKey: conversationEvidenceSourceKey(conversationId),
    steps: [
      {
        title: "Receive request",
        body: "Alice receives the request and sends it to Finance.",
      },
    ],
    actors: ["Alice", "Finance"],
    tools: [],
    handoffsAndDependencies: ["Alice sends the request to Finance"],
    reportedVariations: [],
    frictionPoints: [],
    uncertainties: [],
  };
}

function stubClaude(
  conversationId: Id<"conversations">,
  mode: "valid" | "malformed" | "truncated" = "valid",
) {
  return vi.fn(async () => {
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
            usage: { input_tokens: 10, output_tokens: 1536 },
          }
        : {
            id: `msg_${mode}`,
            type: "message",
            role: "assistant",
            model: "fabric-claude",
            content: [
              {
                type: "tool_use",
                id: "tool_1",
                name: "return_conversation_evidence",
                input:
                  mode === "malformed"
                    ? { sourceKey: "C-wrong", steps: [] }
                    : toolPayload(conversationId),
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
  });
}

beforeEach(() => {
  for (const name of AI_ENV) delete process.env[name];
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const name of AI_ENV) delete process.env[name];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("conversation evidence generation", () => {
  test("saves valid evidence, meters it to the generation, and then hits cache", async () => {
    configureFoundry();
    const t = convexTest(schema, modules);
    const { conversationId } = await t.run((ctx) => seed(ctx));
    const fetchMock = stubClaude(conversationId);
    vi.stubGlobal("fetch", fetchMock);

    const first = await t.action(
      internal.summaryEvidence.generateConversationSummaryEvidenceV2,
      { conversationId, clerkOrgId: ORG, generationId: "generation-1" },
    );
    const second = await t.action(
      internal.summaryEvidence.generateConversationSummaryEvidenceV2,
      { conversationId, clerkOrgId: ORG, generationId: "generation-2" },
    );

    expect(first).toBe("saved");
    expect(second).toBe("cached");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = await t.run(async (ctx) => ({
      conversation: await ctx.db.get(conversationId),
      usage: await ctx.db.query("aiUsageEvents").collect(),
    }));
    expect(stored.conversation?.processSummaryEvidenceV2).toMatchObject({
      schemaVersion: "v2",
      promptVersion: SUMMARY_V2_PROMPT_VERSIONS.conversationEvidence,
      actors: ["Alice", "Finance"],
    });
    expect(stored.usage).toHaveLength(1);
    expect(stored.usage[0]).toMatchObject({
      operation: "conversation-summary-evidence-v2",
      entityType: "conversation",
      entityId: conversationId,
      runId: "generation-1",
      status: "ok",
    });
  });

  test("retries a truncated extraction once, more concisely, and saves that", async () => {
    configureFoundry();
    const t = convexTest(schema, modules);
    const { conversationId } = await t.run((ctx) => seed(ctx));
    const truncated = stubClaude(conversationId, "truncated");
    const valid = stubClaude(conversationId);
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return bodies.length === 1 ? truncated() : valid();
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await t.action(
      internal.summaryEvidence.generateConversationSummaryEvidenceV2,
      { conversationId, clerkOrgId: ORG, generationId: "generation-retry" },
    );

    expect(result).toBe("saved");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Only the retry carries the tightening instruction, and it forgoes its own
    // transport retries so both attempts fit one action's clock.
    expect(bodies[0]).not.toContain("Retry after a truncated response");
    expect(bodies[1]).toContain("Retry after a truncated response");

    const stored = await t.run(async (ctx) => ({
      conversation: await ctx.db.get(conversationId),
      usage: await ctx.db.query("aiUsageEvents").collect(),
    }));
    expect(stored.conversation?.processSummaryEvidenceV2).toMatchObject({
      actors: ["Alice", "Finance"],
    });
    expect(stored.conversation?.processSummaryEvidenceV2Failure).toBeUndefined();
    // The discarded attempt was still billed, so it must still be on the ledger.
    expect(stored.usage.map((row) => row.status)).toEqual(["truncated", "ok"]);
  });

  test.each([
    ["truncated" as const, "truncated"],
    ["malformed" as const, "invalid_output"],
  ])("does not persist %s output", async (mode, expectedCode) => {
    configureFoundry();
    const t = convexTest(schema, modules);
    const { conversationId } = await t.run((ctx) => seed(ctx));
    vi.stubGlobal("fetch", stubClaude(conversationId, mode));

    await expect(
      t.action(
        internal.summaryEvidence.generateConversationSummaryEvidenceV2,
        { conversationId, clerkOrgId: ORG, generationId: "generation-failed" },
      ),
    ).rejects.toThrow();

    const stored = await t.run((ctx) => ctx.db.get(conversationId));
    expect(stored?.processSummaryEvidenceV2).toBeUndefined();
    expect(stored?.processSummaryEvidenceV2Failure).toMatchObject({
      generationId: "generation-failed",
      code: expectedCode,
    });
    if (mode === "truncated") {
      const usage = await t.run((ctx) => ctx.db.query("aiUsageEvents").collect());
      expect(usage[0]?.status).toBe("truncated");
    }
  });

  test("rejects cross-tenant evidence reads and writes", async () => {
    const t = convexTest(schema, modules);
    const { conversationId } = await t.run((ctx) => seed(ctx));
    expect(
      await t.query(internal.summaryEvidence.getConversationForEvidence, {
        conversationId,
        clerkOrgId: OTHER_ORG,
      }),
    ).toBeNull();

    const transcriptHash = await t.run(async (ctx) => {
      const row = await ctx.db.get(conversationId);
      return hashTranscript(row?.transcript ?? null);
    });
    await expect(
      t.mutation(
        internal.summaryEvidence.saveConversationSummaryEvidenceV2,
        {
          conversationId,
          clerkOrgId: OTHER_ORG,
          expectedTranscriptHash: transcriptHash,
          evidence: {
            schemaVersion: "v2",
            sourceMode: "interview_evidence",
            steps: [],
            actors: [],
            tools: [],
            handoffsAndDependencies: [],
            reportedVariations: [],
            frictionPoints: [],
            uncertainties: [],
            transcriptHash,
            promptVersion: SUMMARY_V2_PROMPT_VERSIONS.conversationEvidence,
            generatedAt: 1,
            provider: "fabric-foundry",
            model: "test-model",
          },
        },
      ),
    ).rejects.toThrow(/not found/i);
  });

  test("drops a late save after speaker labels change and skips deleted rows", async () => {
    const t = convexTest(schema, modules);
    const { conversationId } = await t.run((ctx) => seed(ctx));
    const oldHash = await t.run(async (ctx) => {
      const row = await ctx.db.get(conversationId);
      return hashTranscript(row?.transcript ?? null);
    });
    await t.run(async (ctx) => {
      const row = await ctx.db.get(conversationId);
      await ctx.db.patch(conversationId, {
        transcript: row?.transcript?.map((message) => ({
          ...message,
          speakerName: "Corrected speaker",
        })),
      });
    });
    const lateSave = await t.mutation(
      internal.summaryEvidence.saveConversationSummaryEvidenceV2,
      {
        conversationId,
        clerkOrgId: ORG,
        expectedTranscriptHash: oldHash,
        evidence: {
          schemaVersion: "v2",
          sourceMode: "interview_evidence",
          steps: [],
          actors: [],
          tools: [],
          handoffsAndDependencies: [],
          reportedVariations: [],
          frictionPoints: [],
          uncertainties: [],
          transcriptHash: oldHash,
          promptVersion: SUMMARY_V2_PROMPT_VERSIONS.conversationEvidence,
          generatedAt: 1,
          provider: "fabric-foundry",
          model: "test-model",
        },
      },
    );
    expect(lateSave.saved).toBe(false);

    await t.run((ctx) => ctx.db.delete(conversationId));
    expect(
      await t.action(
        internal.summaryEvidence.generateConversationSummaryEvidenceV2,
        { conversationId, clerkOrgId: ORG, generationId: "after-delete" },
      ),
    ).toBe("skipped");
  });
});

describe("process evidence preparation gate", () => {
  test("coalesces completions and hands off only after preparation finishes", async () => {
    const t = convexTest(schema, modules);
    const { processId } = await t.run((ctx) => seed(ctx));
    const first = await t.mutation(
      internal.summaryEvidence.requestProcessEvidenceRefresh,
      { processId, clerkOrgId: ORG },
    );
    const second = await t.mutation(
      internal.summaryEvidence.requestProcessEvidenceRefresh,
      { processId, clerkOrgId: ORG, forceRefresh: true },
    );
    const third = await t.mutation(
      internal.summaryEvidence.requestProcessEvidenceRefresh,
      { processId, clerkOrgId: ORG },
    );
    expect(first.scheduled).toBe(true);
    expect(second).toEqual({
      scheduled: false,
      generationId: first.generationId,
    });
    expect(third).toEqual({
      scheduled: false,
      generationId: first.generationId,
    });

    let process = await t.run((ctx) => ctx.db.get(processId));
    expect(process?.summaryEvidenceRefreshRequestedAgain).toBe(true);
    expect(process?.summaryEvidenceForceRefreshRequested).toBe(true);
    expect(process?.summaryRegenScheduledAt).toBeUndefined();

    await t.mutation(internal.summaryEvidence.finishProcessEvidenceRefresh, {
      processId,
      clerkOrgId: ORG,
      generationId: first.generationId,
    });
    process = await t.run((ctx) => ctx.db.get(processId));
    expect(process?.summaryEvidenceRefreshGenerationId).toBe(first.generationId);
    expect(process?.summaryRegenScheduledAt).toBeUndefined();

    await t.mutation(internal.summaryEvidence.finishProcessEvidenceRefresh, {
      processId,
      clerkOrgId: ORG,
      generationId: first.generationId,
    });
    process = await t.run((ctx) => ctx.db.get(processId));
    expect(process?.summaryEvidenceRefreshGenerationId).toBeUndefined();
    expect(process?.summaryRegenScheduledAt).toEqual(expect.any(Number));
  });

  test("preparation detects transcript and prompt cache misses", async () => {
    const t = convexTest(schema, modules);
    const { processId, conversationId } = await t.run((ctx) => seed(ctx));
    const request = await t.mutation(
      internal.summaryEvidence.requestProcessEvidenceRefresh,
      { processId, clerkOrgId: ORG },
    );
    const initial = await t.query(
      internal.summaryEvidence.getProcessPreparationPage,
      {
        processId,
        clerkOrgId: ORG,
        generationId: request.generationId,
        phase: "evidence",
        cursor: null,
      },
    );
    expect(initial.candidateIds).toEqual([conversationId]);

    await t.run(async (ctx) => {
      const row = await ctx.db.get(conversationId);
      const transcriptHash = hashTranscript(row?.transcript ?? null);
      await ctx.db.patch(conversationId, {
        processSummaryEvidenceV2: {
          schemaVersion: "v2",
          sourceMode: "interview_evidence",
          steps: [],
          actors: [],
          tools: [],
          handoffsAndDependencies: [],
          reportedVariations: [],
          frictionPoints: [],
          uncertainties: [],
          transcriptHash,
          promptVersion: SUMMARY_V2_PROMPT_VERSIONS.conversationEvidence,
          generatedAt: 1,
          provider: "fabric-foundry",
          model: "test-model",
        },
      });
    });
    const cached = await t.query(
      internal.summaryEvidence.getProcessPreparationPage,
      {
        processId,
        clerkOrgId: ORG,
        generationId: request.generationId,
        phase: "evidence",
        cursor: null,
      },
    );
    expect(cached.candidateIds).toEqual([]);

    await t.run(async (ctx) => {
      const row = await ctx.db.get(conversationId);
      await ctx.db.patch(conversationId, {
        transcript: row?.transcript?.map((message) => ({
          ...message,
          speakerName: "Bob",
        })),
      });
    });
    const relabelled = await t.query(
      internal.summaryEvidence.getProcessPreparationPage,
      {
        processId,
        clerkOrgId: ORG,
        generationId: request.generationId,
        phase: "evidence",
        cursor: null,
      },
    );
    expect(relabelled.candidateIds).toEqual([conversationId]);
  });
});
