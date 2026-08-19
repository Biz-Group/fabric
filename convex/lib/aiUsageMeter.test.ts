import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AIRequestError, type AICompletion, type AIRequest } from "./aiProvider";
import { PRICE_VERSION } from "./aiPricing";
import {
  PROVIDER_REPORTED_VERSION,
  buildCompletionUsageEvent,
  buildVoiceUsageEvent,
  recordAgentConversationUsage,
  resetDeploymentLabelWarning,
  resolveDeploymentLabel,
  type UsageAttribution,
} from "./aiUsageMeter";

const REQUEST: AIRequest = {
  capability: "safety",
  operation: "description-safety",
  system: "system",
  user: "user",
  maxTokens: 1_000,
};

const ATTRIBUTION: UsageAttribution = {
  clerkOrgId: "org_123",
  tenantName: "Acme",
  entityType: "department",
  entityId: "dept_abc",
  entityLabel: "Finance",
  actorUserId: "user_xyz",
};

function completion(overrides: Partial<AICompletion> = {}): AICompletion {
  return {
    provider: "foundry-openai",
    model: "foundry:gpt-5-nano@2025-08-07",
    deployment: "fabric-description-safety",
    text: null,
    toolInput: { decision: "allow" },
    finishReason: "stop",
    usage: { inputTokens: 1_000, outputTokens: 200, cachedReadTokens: 0 },
    requestId: "req_1",
    ...overrides,
  };
}

function build(input: {
  completion?: AICompletion;
  error?: unknown;
  startedAt?: number;
  endedAt?: number;
  attribution?: UsageAttribution;
}) {
  return buildCompletionUsageEvent({
    attribution: input.attribution ?? ATTRIBUTION,
    request: REQUEST,
    deployment: "prod",
    idempotencyKey: "prod:description-safety:1000:req_1",
    startedAt: input.startedAt ?? 1_000,
    endedAt: input.endedAt ?? 1_350,
    completion: input.completion,
    error: input.error,
  });
}

beforeEach(() => {
  delete process.env.USAGE_DEPLOYMENT_LABEL;
  resetDeploymentLabelWarning();
});

afterEach(() => {
  delete process.env.USAGE_DEPLOYMENT_LABEL;
});

describe("buildCompletionUsageEvent", () => {
  test("records a successful call with computed cost", () => {
    const event = build({ completion: completion() });

    expect(event.status).toBe("ok");
    expect(event.unit).toBe("tokens");
    expect(event.tokenClass).toBe("fabric-synthesis");
    expect(event.costSource).toBe("computed");
    expect(event.priceVersion).toBe(PRICE_VERSION);
    // 1,000 in at $0.05/MTok + 200 out at $0.40/MTok.
    expect(event.costMicroUsd).toBe(Math.round(1_000 * 0.05 + 200 * 0.4));
    expect(event.inputTokens).toBe(1_000);
    expect(event.outputTokens).toBe(200);
    expect(event.latencyMs).toBe(350);
    expect(event.requestId).toBe("req_1");
    expect(event.errorType).toBeUndefined();
  });

  test("timestamps the row at the call's start, not its end", () => {
    // Rollups bucket by day. Stamping the end time would push a call that
    // straddles midnight into the wrong day.
    expect(build({ completion: completion(), startedAt: 42 }).createdAt).toBe(42);
  });

  test("marks a token-limited completion truncated, with its real tokens", () => {
    // The call succeeded and was billed; the call site will discard the content.
    // Recording it as failed would hide real spend.
    const event = build({
      completion: completion({ finishReason: "length" }),
    });
    expect(event.status).toBe("truncated");
    expect(event.costMicroUsd).toBeGreaterThan(0);
    expect(event.outputTokens).toBe(200);
  });

  test("records a failure with no tokens and no cost", () => {
    const event = build({
      error: new AIRequestError("boom", {
        provider: "foundry-openai",
        status: 500,
        requestId: "req_failed",
      }),
    });

    expect(event.status).toBe("failed");
    expect(event.errorType).toBe("AIRequestError");
    expect(event.requestId).toBe("req_failed");
    expect(event.costMicroUsd).toBe(0);
    expect(event.inputTokens).toBeUndefined();
    expect(event.outputTokens).toBeUndefined();
  });

  test("falls back to the capability when a failure has no resolved backend", () => {
    const event = build({ error: new Error("network down") });
    expect(event.provider).toBe("unresolved:safety");
    expect(event.model).toBe("unknown");
    expect(event.errorType).toBe("Error");
  });

  test("prefers provider-reported cost when the provider supplies one", () => {
    // No current provider reports cost — Foundry does not — so `costUsd` here
    // is synthetic. The branch stays covered for whichever provider next does.
    const event = build({
      completion: completion({
        provider: "foundry-openai",
        model: "foundry:gpt-5-nano@2025-08-07",
        costUsd: 0.00042,
      }),
    });

    expect(event.costSource).toBe("provider");
    expect(event.priceVersion).toBe(PROVIDER_REPORTED_VERSION);
    expect(event.costMicroUsd).toBe(420);
    expect(event.providerReportedCostMicroUsd).toBe(420);
  });

  test("prices from our table when the provider reports no cost", () => {
    const event = build({ completion: completion({ costUsd: undefined }) });
    expect(event.costSource).toBe("computed");
    expect(event.providerReportedCostMicroUsd).toBeUndefined();
  });

  test("carries attribution through, including an absent entity id", () => {
    // Description safety runs before the entity exists on the create path.
    const event = build({
      completion: completion(),
      attribution: {
        clerkOrgId: "org_new",
        entityType: "process",
        entityLabel: "Onboarding",
        actorUserId: "user_1",
      },
    });

    expect(event.clerkOrgId).toBe("org_new");
    expect(event.entityType).toBe("process");
    expect(event.entityId).toBeUndefined();
    expect(event.entityLabel).toBe("Onboarding");
    expect(event.actorUserId).toBe("user_1");
  });

  test("propagates cache token counts for pricing and audit", () => {
    const event = build({
      completion: completion({
        provider: "foundry-claude",
        model: "foundry:claude-haiku-4-5@2",
        usage: {
          inputTokens: 500,
          outputTokens: 100,
          cachedReadTokens: 4_000,
          cacheWriteTokens: 1_000,
        },
      }),
    });

    expect(event.cachedReadTokens).toBe(4_000);
    expect(event.cacheWriteTokens).toBe(1_000);
    expect(event.costMicroUsd).toBe(
      500 * 1 + 4_000 * 0.1 + 1_000 * 1.25 + 100 * 5,
    );
  });
});

describe("buildVoiceUsageEvent", () => {
  function buildVoice(overrides: Partial<Parameters<typeof buildVoiceUsageEvent>[0]> = {}) {
    return buildVoiceUsageEvent({
      attribution: {
        clerkOrgId: "org_1",
        entityType: "conversation",
        entityId: "conv_1",
      },
      deployment: "prod",
      idempotencyKey: "prod:voice-transcription:conv_1:1000",
      createdAt: 1_000,
      operation: "voice-transcription",
      provider: "elevenlabs",
      model: "scribe_v2",
      rateKey: "elevenlabs:scribe_v2",
      seconds: 600,
      status: "ok",
      ...overrides,
    });
  }

  test("prices Scribe from its billed duration", () => {
    const event = buildVoice();
    // 600s at $0.22/hour = $0.0366666… → 36,667 micro-USD.
    expect(event.unit).toBe("seconds");
    expect(event.seconds).toBe(600);
    expect(event.costMicroUsd).toBe(Math.round((600 * 220_000) / 3600));
    expect(event.costSource).toBe("computed");
  });

  test("carries no tokenClass — transcription consumes no tokens", () => {
    // Tagging it would file it under a token bucket it does not belong to.
    const event = buildVoice();
    expect(event.tokenClass).toBeUndefined();
    expect(event.inputTokens).toBeUndefined();
    expect(event.outputTokens).toBeUndefined();
  });

  test("still records cost for a failed transcription", () => {
    // ElevenLabs may have processed audio before erroring, and an unmetered
    // failure is indistinguishable from a call that never happened.
    const event = buildVoice({ status: "failed", errorType: "TypeError" });
    expect(event.status).toBe("failed");
    expect(event.errorType).toBe("TypeError");
  });

  test("marks an unknown rate key unpriced rather than free", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const event = buildVoice({ rateKey: "elevenlabs:not-a-model" });
    expect(event.costMicroUsd).toBe(0);
    expect(event.priceVersion).toBe("unpriced");
    warn.mockRestore();
  });
});

describe("recordAgentConversationUsage", () => {
  /** Minimal ActionCtx stand-in that captures what would be written. */
  function captureCtx() {
    const written: Record<string, unknown>[] = [];
    const ctx = {
      runMutation: async (_ref: unknown, args: Record<string, unknown>) => {
        written.push(args);
      },
    } as unknown as Parameters<typeof recordAgentConversationUsage>[0];
    return { ctx, written };
  }

  const METADATA = {
    call_duration_secs: 5,
    cost_fiat: 0.0250345,
    text_only: true,
    charging: {
      is_burst: false,
      tier: "pro",
      llm_price: 0.0220345,
      platform_price: 0.003,
      free_minutes_consumed: 0,
      free_llm_dollars_consumed: 0,
      llm_usage: {
        irreversible_generation: {
          model_usage: {
            "claude-haiku-4-5": {
              input: { tokens: 12877, price: 0.012877 },
              input_cache_read: { tokens: 0, price: 0 },
              input_cache_write: { tokens: 6362, price: 0.0079525 },
              output_total: { tokens: 241, price: 0.001205 },
            },
          },
        },
      },
    },
  };

  test("maps a real charging payload onto a ledger row", async () => {
    const { ctx, written } = captureCtx();
    await recordAgentConversationUsage(
      ctx,
      { clerkOrgId: "org_1", entityId: "conv_1" },
      { elevenlabsConversationId: "conv_abc", metadata: METADATA, startedAt: 50 },
    );

    expect(written).toHaveLength(1);
    const row = written[0]!;
    expect(row.operation).toBe("agent-conversation");
    expect(row.provider).toBe("elevenlabs");
    expect(row.model).toBe("claude-haiku-4-5");
    // The agent's LLM is a different bill from our synthesis models.
    expect(row.tokenClass).toBe("agent-llm");
    expect(row.unit).toBe("seconds");
    expect(row.seconds).toBe(5);
    expect(row.inputTokens).toBe(12_877);
    expect(row.cacheWriteTokens).toBe(6_362);
    expect(row.outputTokens).toBe(241);
    expect(row.costSource).toBe("provider");
    // No allowance consumed, so notional == what was actually charged.
    expect(row.costMicroUsd).toBe(25_035);
    expect(row.providerReportedCostMicroUsd).toBe(25_035);
    expect(row.llmCostMicroUsd).toBe(22_035);
    expect(row.platformCostMicroUsd).toBe(3_000);
  });

  test("keys idempotency on the conversation, not the clock", async () => {
    // Re-fetching a conversation re-reads the SAME immutable bill, so the two
    // writes must collapse onto one row rather than double-charging.
    const a = captureCtx();
    const b = captureCtx();
    await recordAgentConversationUsage(a.ctx, { clerkOrgId: "org_1" }, {
      elevenlabsConversationId: "conv_abc",
      metadata: METADATA,
      startedAt: 1,
    });
    await recordAgentConversationUsage(b.ctx, { clerkOrgId: "org_1" }, {
      elevenlabsConversationId: "conv_abc",
      metadata: METADATA,
      startedAt: 999_999,
    });
    expect(a.written[0]!.idempotencyKey).toBe(b.written[0]!.idempotencyKey);
  });

  test("adds consumed plan allowance back into the notional cost", async () => {
    const { ctx, written } = captureCtx();
    await recordAgentConversationUsage(
      ctx,
      { clerkOrgId: "org_1" },
      {
        elevenlabsConversationId: "conv_free",
        metadata: {
          ...METADATA,
          charging: { ...METADATA.charging, free_minutes_consumed: 10 },
        },
      },
    );
    // $0.0250345 charged + 10 free minutes at $0.08 = $0.8250345 notional.
    expect(written[0]!.costMicroUsd).toBe(825_035);
    expect(written[0]!.providerReportedCostMicroUsd).toBe(25_035);
  });

  test("still writes a row when the payload does not reconcile", async () => {
    // A vendor schema change must not break conversation ingest.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, written } = captureCtx();
    await recordAgentConversationUsage(
      ctx,
      { clerkOrgId: "org_1" },
      { elevenlabsConversationId: "conv_bad", metadata: { nonsense: true } },
    );
    expect(written).toHaveLength(1);
    expect(written[0]!.costMicroUsd).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("resolveDeploymentLabel", () => {
  test("uses the configured label", () => {
    process.env.USAGE_DEPLOYMENT_LABEL = "prod";
    expect(resolveDeploymentLabel()).toBe("prod");
  });

  test("defaults to dev when unset, and says so once", () => {
    // Under-reporting prod announces itself (prod totals read empty); polluting
    // prod with mislabelled dev rows does not.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveDeploymentLabel()).toBe("dev");
    resolveDeploymentLabel();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
