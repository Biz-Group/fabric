import { afterEach, describe, expect, test, vi } from "vitest";
import { generateAICompletion } from "./aiProvider";
import {
  buildConversationEvidenceV2Request,
  CONVERSATION_EVIDENCE_V2_SCHEMA,
  CONVERSATION_EVIDENCE_V2_TOOL_NAME,
  conversationEvidenceSourceKey,
  isConversationEvidenceV2Current,
  normalizeProcessSummaryEvidenceV2,
} from "./conversationEvidenceV2";
import {
  SUMMARY_V2_AI_BUDGETS,
  SUMMARY_V2_CAPS,
  SUMMARY_V2_PROMPT_VERSIONS,
  type ProcessSummaryEvidenceV2,
} from "../summaryV2";

const ENV_NAMES = [
  "FOUNDRY_ENDPOINT",
  "FOUNDRY_API_KEY",
  "FOUNDRY_SYNTHESIS_BACKEND",
  "FOUNDRY_CLAUDE_DEPLOYMENT",
  "FOUNDRY_OPENAI_FALLBACK_DEPLOYMENT",
] as const;

const SOURCE_KEY = conversationEvidenceSourceKey("conversation_123");
const TOOL_PAYLOAD = {
  sourceKey: SOURCE_KEY,
  steps: [{ title: "Receive request", body: "Operations receives the form." }],
  actors: ["Operations"],
  tools: ["Intake form"],
  handoffsAndDependencies: ["Finance approves the request"],
  reportedVariations: ["Urgent requests arrive by email"],
  frictionPoints: ["Approvals are chased manually"],
  uncertainties: ["The escalation owner was not confirmed"],
};

function request() {
  return buildConversationEvidenceV2Request({
    conversationId: "conversation_123",
    contributorName: "Alice",
    transcript: [{ role: "user", content: "We receive a form." }],
  });
}

function evidence(overrides: Partial<ProcessSummaryEvidenceV2> = {}) {
  return {
    schemaVersion: "v2" as const,
    sourceMode: "interview_evidence" as const,
    steps: [],
    actors: [],
    tools: [],
    handoffsAndDependencies: [],
    reportedVariations: [],
    frictionPoints: [],
    uncertainties: [],
    transcriptHash: "hash-a",
    promptVersion: SUMMARY_V2_PROMPT_VERSIONS.conversationEvidence,
    generatedAt: 1,
    provider: "fabric-foundry",
    model: "test-model",
    ...overrides,
  };
}

async function observedBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const outbound = input instanceof Request ? input : new Request(input, init);
  return (await outbound.clone().json()) as Record<string, unknown>;
}

afterEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("conversation evidence V2 contract", () => {
  test("uses stable opaque source keys", () => {
    const first = conversationEvidenceSourceKey("conversation_123");
    expect(first).toBe(conversationEvidenceSourceKey("conversation_123"));
    expect(first).not.toBe(conversationEvidenceSourceKey("conversation_456"));
    expect(first).not.toContain("conversation_123");
    expect(first).toMatch(/^C-[a-z0-9]+-[a-z0-9]+$/);
  });

  test("builds one strict, deterministic request with the locked budget", () => {
    const built = request();
    expect(built).toMatchObject({
      capability: "synthesis",
      temperature: 0,
      maxTokens: SUMMARY_V2_AI_BUDGETS.conversationEvidence.maxTokens,
      timeoutMs: SUMMARY_V2_AI_BUDGETS.conversationEvidence.timeoutMs,
      maxRetries: SUMMARY_V2_AI_BUDGETS.conversationEvidence.maxRetries,
      tool: {
        name: CONVERSATION_EVIDENCE_V2_TOOL_NAME,
        inputSchema: CONVERSATION_EVIDENCE_V2_SCHEMA,
      },
    });
    expect(built.user).toContain(`Source key: ${SOURCE_KEY}`);
    expect(CONVERSATION_EVIDENCE_V2_SCHEMA).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining([
        "steps",
        "actors",
        "tools",
        "handoffsAndDependencies",
        "reportedVariations",
        "frictionPoints",
        "uncertainties",
      ]),
    });
  });

  test("invalidates cache only for transcript or prompt-version changes", () => {
    expect(isConversationEvidenceV2Current(evidence(), "hash-a")).toBe(true);
    expect(isConversationEvidenceV2Current(evidence(), "hash-b")).toBe(false);
    expect(
      isConversationEvidenceV2Current(
        evidence({ promptVersion: "a-new-prompt-version" }),
        "hash-a",
      ),
    ).toBe(false);
  });

  test("normalizes bounded evidence and rejects malformed or wrong-source output", () => {
    const metadata = {
      transcriptHash: "hash-a",
      promptVersion: SUMMARY_V2_PROMPT_VERSIONS.conversationEvidence,
      generatedAt: 123.9,
      provider: "fabric-foundry",
      model: "test-model",
    };
    const normalized = normalizeProcessSummaryEvidenceV2(
      {
        ...TOOL_PAYLOAD,
        steps: Array.from({ length: 50 }, (_, index) => ({
          title: `Step ${index}`,
          body: "Observed work",
          ignored: true,
        })),
        actors: Array.from({ length: 30 }, (_, index) => `Actor ${index}`),
        ignored: "not persisted",
      },
      SOURCE_KEY,
      metadata,
    );
    expect(normalized?.steps).toHaveLength(SUMMARY_V2_CAPS.conversationSteps);
    expect(normalized?.actors).toHaveLength(
      SUMMARY_V2_CAPS.conversationEvidenceGroup,
    );
    expect(normalized).not.toHaveProperty("sourceKey");
    expect(normalized).not.toHaveProperty("ignored");
    expect(
      normalizeProcessSummaryEvidenceV2(
        { ...TOOL_PAYLOAD, sourceKey: "C-wrong" },
        SOURCE_KEY,
        metadata,
      ),
    ).toBeNull();
    expect(
      normalizeProcessSummaryEvidenceV2(
        { sourceKey: SOURCE_KEY, steps: [] },
        SOURCE_KEY,
        metadata,
      ),
    ).toBeNull();
  });
});

describe("conversation evidence tool transport", () => {
  test("Foundry Claude forces the strict schema tool", async () => {
    process.env.FOUNDRY_ENDPOINT = "https://fabric-test.services.ai.azure.com";
    process.env.FOUNDRY_API_KEY = "test-key";
    process.env.FOUNDRY_CLAUDE_DEPLOYMENT = "fabric-claude";
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        body = await observedBody(input, init);
        return new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "fabric-claude",
            content: [
              {
                type: "tool_use",
                id: "tool_1",
                name: CONVERSATION_EVIDENCE_V2_TOOL_NAME,
                input: TOOL_PAYLOAD,
              },
            ],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 20 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    expect((await generateAICompletion(request())).toolInput).toEqual(
      TOOL_PAYLOAD,
    );
    expect(body).toMatchObject({
      temperature: 0,
      tool_choice: { type: "tool", name: CONVERSATION_EVIDENCE_V2_TOOL_NAME },
      tools: [
        {
          name: CONVERSATION_EVIDENCE_V2_TOOL_NAME,
          input_schema: { additionalProperties: false },
        },
      ],
    });
  });

  test("Foundry OpenAI sends the same schema in strict mode", async () => {
    process.env.FOUNDRY_ENDPOINT = "https://fabric-test.services.ai.azure.com";
    process.env.FOUNDRY_API_KEY = "test-key";
    process.env.FOUNDRY_SYNTHESIS_BACKEND = "gpt5mini";
    process.env.FOUNDRY_OPENAI_FALLBACK_DEPLOYMENT = "fabric-gpt";
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        body = await observedBody(input, init);
        return new Response(
          JSON.stringify({
            id: "chatcmpl_1",
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: CONVERSATION_EVIDENCE_V2_TOOL_NAME,
                        arguments: JSON.stringify(TOOL_PAYLOAD),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    expect((await generateAICompletion(request())).toolInput).toEqual(
      TOOL_PAYLOAD,
    );
    expect(body).toMatchObject({
      parallel_tool_calls: false,
      tools: [
        {
          function: {
            name: CONVERSATION_EVIDENCE_V2_TOOL_NAME,
            strict: true,
            parameters: { additionalProperties: false },
          },
        },
      ],
    });
  });
});
