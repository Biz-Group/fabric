import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AITruncationError,
  FOUNDRY_CLAUDE_MODEL,
  FOUNDRY_SAFETY_MODEL,
  MEASURED_THROUGHPUT,
  assertCompletionNotTruncated,
  generateAICompletion,
  getPersistedAIProvider,
  isWithinTimeBudget,
  maxTokensForTimeout,
  minTimeoutMsForMaxTokens,
} from "./aiProvider";

const AI_ENV_NAMES = [
  "FOUNDRY_ENDPOINT",
  "FOUNDRY_API_KEY",
  "FOUNDRY_SYNTHESIS_BACKEND",
  "FOUNDRY_CLAUDE_DEPLOYMENT",
  "FOUNDRY_OPENAI_FALLBACK_DEPLOYMENT",
  "FOUNDRY_SAFETY_DEPLOYMENT",
] as const;

type ObservedRequest = {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
};

async function observeRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<ObservedRequest> {
  const request = input instanceof Request ? input : new Request(input, init);
  return {
    url: request.url,
    headers: request.headers,
    body: (await request.clone().json()) as Record<string, unknown>,
  };
}

/**
 * Minimum Foundry synthesis config. The provider-agnostic tests below (time
 * budget, near-miss telemetry, retry overrides) need *a* working backend to
 * exercise `generateAICompletion`; Foundry Claude is the only one there is.
 */
function useFoundry(): void {
  process.env.FOUNDRY_ENDPOINT = "https://fabric-test.services.ai.azure.com/";
  process.env.FOUNDRY_API_KEY = "foundry-test-key";
  process.env.FOUNDRY_CLAUDE_DEPLOYMENT = "fabric-claude-haiku-4-5";
}

function foundryClaudeResponse(options?: { outputTokens?: number }): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "fabric-claude-haiku-4-5",
      content: [{ type: "text", text: "Summary" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 8,
        output_tokens: options?.outputTokens ?? 3,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** The structured payload logged with a given console.warn message, if any. */
function warnPayload(
  warn: { mock: { calls: unknown[][] } },
  message: string,
): Record<string, unknown> | undefined {
  const call = warn.mock.calls.find((args) => args[0] === message);
  return call?.[1] as Record<string, unknown> | undefined;
}

describe("AI provider adapter", () => {
  beforeEach(() => {
    for (const name of AI_ENV_NAMES) delete process.env[name];
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const name of AI_ENV_NAMES) delete process.env[name];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("uses the Foundry Claude Messages API for synthesis", async () => {
    process.env.FOUNDRY_ENDPOINT =
      "https://fabric-test.services.ai.azure.com/";
    process.env.FOUNDRY_API_KEY = "foundry-test-key";
    process.env.FOUNDRY_CLAUDE_DEPLOYMENT = "fabric-claude-haiku-4-5";

    let observed: ObservedRequest | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        observed = await observeRequest(input, init);
        return new Response(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "fabric-claude-haiku-4-5",
            content: [{ type: "text", text: "Generated summary" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 4 },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "request-id": "msg_request_test",
            },
          },
        );
      }),
    );

    const completion = await generateAICompletion({
      capability: "synthesis",
      operation: "adapter-test-claude",
      system: "System prompt",
      user: "User prompt",
      maxTokens: 8192,
    });

    expect(observed?.url).toBe(
      "https://fabric-test.services.ai.azure.com/anthropic/v1/messages",
    );
    expect(observed?.headers.get("x-api-key")).toBe("foundry-test-key");
    expect(observed?.body).toMatchObject({
      model: "fabric-claude-haiku-4-5",
      system: "System prompt",
      max_tokens: 8192,
    });
    expect(completion).toMatchObject({
      provider: "foundry-claude",
      model: FOUNDRY_CLAUDE_MODEL,
      deployment: "fabric-claude-haiku-4-5",
      text: "Generated summary",
      toolInput: null,
      finishReason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    expect(getPersistedAIProvider()).toBe("fabric-foundry");
  });

  test("uses Foundry OpenAI strict tool calling for safety", async () => {
    process.env.FOUNDRY_ENDPOINT =
      "https://fabric-test.services.ai.azure.com/openai/v1";
    process.env.FOUNDRY_API_KEY = "foundry-test-key";
    process.env.FOUNDRY_SAFETY_DEPLOYMENT = "fabric-description-safety";

    let observed: ObservedRequest | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        observed = await observeRequest(input, init);
        return new Response(
          JSON.stringify({
            id: "chatcmpl_test",
            object: "chat.completion",
            created: 1,
            model: "fabric-description-safety",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_test",
                      type: "function",
                      function: {
                        name: "classify",
                        arguments: '{"decision":"allow"}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 5,
              total_tokens: 25,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const completion = await generateAICompletion({
      capability: "safety",
      operation: "adapter-test-safety",
      system: "Classify safely",
      user: "Business context",
      maxTokens: 1000,
      tool: {
        name: "classify",
        description: "Classify the input",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { decision: { type: "string" } },
          required: ["decision"],
        },
      },
    });

    expect(observed?.url).toBe(
      "https://fabric-test.services.ai.azure.com/openai/v1/chat/completions",
    );
    expect(observed?.headers.get("authorization")).toBe(
      "Bearer foundry-test-key",
    );
    expect(observed?.body).toMatchObject({
      model: "fabric-description-safety",
      max_completion_tokens: 1000,
      reasoning_effort: "minimal",
      parallel_tool_calls: false,
      tools: [{ function: { name: "classify", strict: true } }],
    });
    expect(completion).toMatchObject({
      provider: "foundry-openai",
      model: FOUNDRY_SAFETY_MODEL,
      toolInput: { decision: "allow" },
      finishReason: "tool_calls",
    });
  });

  test("honors a per-request maxRetries override (no retry on 429)", async () => {
    useFoundry();

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateAICompletion({
        capability: "synthesis",
        operation: "adapter-test-no-retry",
        system: "System prompt",
        user: "User prompt",
        maxTokens: 100,
        maxRetries: 0,
      }),
    ).rejects.toThrow();

    // Default would attempt 3 times; the override must make it exactly one.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("warns when a request asks for more output than its timeout covers", async () => {
    useFoundry();
    vi.stubGlobal("fetch", vi.fn(async () => foundryClaudeResponse()));
    const warn = vi.spyOn(console, "warn");

    // 8,192 tokens needs ~256 s at the worst measured rate; this call gets the
    // default 120 s, whose ceiling is 3,770.
    await generateAICompletion({
      capability: "synthesis",
      operation: "adapter-test-over-budget",
      system: "System prompt",
      user: "User prompt",
      maxTokens: 8192,
    });

    expect(warnPayload(warn, "AI request exceeds its time budget")).toMatchObject({
      operation: "adapter-test-over-budget",
      maxTokens: 8192,
      timeoutMs: 120_000,
      maxTokensAtThisTimeout: 3770,
      minTimeoutMsForTheseTokens: 256_062,
    });
  });

  test("stays quiet when the request fits its time budget", async () => {
    useFoundry();
    vi.stubGlobal("fetch", vi.fn(async () => foundryClaudeResponse()));
    const warn = vi.spyOn(console, "warn");

    await generateAICompletion({
      capability: "synthesis",
      operation: "adapter-test-within-budget",
      system: "System prompt",
      user: "User prompt",
      maxTokens: 3770,
    });

    expect(
      warnPayload(warn, "AI request exceeds its time budget"),
    ).toBeUndefined();
  });

  test("logs a near miss when latency eats most of the timeout", async () => {
    useFoundry();
    let nowMs = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        nowMs += 90_000;
        return foundryClaudeResponse({ outputTokens: 9000 });
      }),
    );
    const warn = vi.spyOn(console, "warn");

    await generateAICompletion({
      capability: "synthesis",
      operation: "adapter-test-near-miss",
      system: "System prompt",
      user: "User prompt",
      maxTokens: 3770,
      timeoutMs: 120_000,
    });

    // 90 s of a 120 s budget — succeeded, but throughput has drifted.
    expect(
      warnPayload(warn, "AI request latency neared its timeout"),
    ).toMatchObject({
      operation: "adapter-test-near-miss",
      latencyMs: 90_000,
      timeoutMs: 120_000,
      usedShareOfTimeout: 0.75,
      outputTokens: 9000,
      observedOverallTokensPerSecond: 100,
    });
  });

  test("does not log a near miss for a comfortably fast call", async () => {
    useFoundry();
    let nowMs = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        nowMs += 20_000;
        return foundryClaudeResponse();
      }),
    );
    const warn = vi.spyOn(console, "warn");

    await generateAICompletion({
      capability: "synthesis",
      operation: "adapter-test-fast",
      system: "System prompt",
      user: "User prompt",
      maxTokens: 3770,
      timeoutMs: 120_000,
    });

    expect(
      warnPayload(warn, "AI request latency neared its timeout"),
    ).toBeUndefined();
  });
});

describe("AI time budget (P1)", () => {
  test("derives the ceilings the v3 plan documents", () => {
    expect(maxTokensForTimeout(210_000)).toBe(6695);
    expect(maxTokensForTimeout(150_000)).toBe(4745);
    expect(maxTokensForTimeout(120_000)).toBe(3770);
  });

  test("every planned flow-stage budget satisfies the rule", () => {
    // Mirrors the per-call budgets table in
    // docs/process-flow-generation-v3-plan.md. If MEASURED_THROUGHPUT is
    // refreshed and a stage stops fitting, this fails here rather than in
    // production. Add each stage's real request builder as step 4 lands it.
    const stageBudgets = [
      { stage: "graph pass", maxTokens: 6_144, timeoutMs: 210_000 },
      { stage: "detail batch", maxTokens: 4_096, timeoutMs: 150_000 },
    ];

    for (const budget of stageBudgets) {
      expect({
        stage: budget.stage,
        fits: isWithinTimeBudget(budget.maxTokens, budget.timeoutMs),
      }).toEqual({ stage: budget.stage, fits: true });
    }
  });

  test("flags the call sites that are over budget today", () => {
    // The 450 s flow-generation stopgap (retired in step 4) and the
    // 8,192-token synthesis calls left on the default timeout (step 2).
    // Asserting the detector sees them keeps the known debt visible.
    expect(isWithinTimeBudget(32_768, 450_000)).toBe(false);
    expect(isWithinTimeBudget(8_192, 120_000)).toBe(false);
    expect(isWithinTimeBudget(16_384, 120_000)).toBe(false);
  });

  test("round-trips against minTimeoutMsForMaxTokens", () => {
    for (const timeoutMs of [60_000, 120_000, 210_000, 450_000]) {
      const ceiling = maxTokensForTimeout(timeoutMs);
      expect(isWithinTimeBudget(ceiling, timeoutMs)).toBe(true);
      expect(isWithinTimeBudget(ceiling + 1, timeoutMs)).toBe(false);
      expect(minTimeoutMsForMaxTokens(ceiling)).toBeLessThanOrEqual(timeoutMs);
    }
  });

  test("gives no budget to a timeout shorter than time-to-first-token", () => {
    expect(maxTokensForTimeout(MEASURED_THROUGHPUT.worstTtftMs)).toBe(0);
    expect(maxTokensForTimeout(0)).toBe(0);
    expect(isWithinTimeBudget(1, 1_000)).toBe(false);
  });
});

describe("completion truncation guard", () => {
  test("throws AITruncationError when output hit the token cap", () => {
    expect(() =>
      assertCompletionNotTruncated(
        { finishReason: "length" },
        "process summary rebuild",
        8192,
      ),
    ).toThrow(AITruncationError);

    let caught: unknown;
    try {
      assertCompletionNotTruncated(
        { finishReason: "max_tokens" },
        "process summary rebuild",
        8192,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AITruncationError);
    const truncation = caught as AITruncationError;
    expect(truncation.operation).toBe("process summary rebuild");
    expect(truncation.finishReason).toBe("max_tokens");
    expect(truncation.maxTokens).toBe(8192);
    expect(truncation.message).toContain("was not saved");
  });

  test("passes through completions that finished normally", () => {
    for (const finishReason of ["end_turn", "stop", "tool_calls", null]) {
      expect(() =>
        assertCompletionNotTruncated({ finishReason }, "process summary"),
      ).not.toThrow();
    }
  });
});
