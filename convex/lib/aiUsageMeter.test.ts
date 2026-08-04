import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AIRequestError, type AICompletion, type AIRequest } from "./aiProvider";
import { PRICE_VERSION } from "./aiPricing";
import {
  PROVIDER_REPORTED_VERSION,
  buildCompletionUsageEvent,
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
    const event = build({
      completion: completion({
        provider: "openrouter",
        model: "openrouter:google/gemma-4-26b-a4b-it",
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
