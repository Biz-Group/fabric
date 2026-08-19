import type { ActionCtx } from "../_generated/server";
import { env } from "../_generated/server";
import { internal } from "../_generated/api";
import type { AiUsageEvent } from "../aiUsage";
import {
  AIRequestError,
  generateAICompletion,
  isTokenLimitFinishReason,
  type AICompletion,
  type AIRequest,
} from "./aiProvider";
import {
  PRICE_VERSION,
  microUsdFromUsd,
  priceTokenUsage,
  priceVoiceUsage,
} from "./aiPricing";
import { agentModelLabel, parseAgentCharging } from "./elevenLabsCharging";

/**
 * Metering wrapper around `generateAICompletion`.
 *
 * `generateAICompletion` stays a pure function with no `ctx` — the provider
 * adapter has no business knowing about the database, and keeping it pure is
 * what lets `aiProvider.test.ts` exercise it without a Convex harness. All
 * ledger concerns live here instead.
 *
 * The event-building logic is a separate pure function from the recording, so
 * the part with the decisions in it (status, cost source, token class) is
 * testable without mocking a Convex context.
 */

export type UsageAttribution = {
  clerkOrgId: string;
  tenantName?: string;
  /** "process" | "department" | "conversation" | "function" */
  entityType?: string;
  /** Absent when the entity does not exist yet — e.g. validating a description on create. */
  entityId?: string;
  entityLabel?: string;
  actorUserId?: string;
  actorName?: string;
  /** Groups every call in one pipeline run. */
  runId?: string;
};

export type DeploymentLabel = "prod" | "dev";

/** Recorded as the price version when the provider priced the call for us. */
export const PROVIDER_REPORTED_VERSION = "provider";

let warnedMissingLabel = false;

/**
 * Defaults to "dev" when unset. See the note on `USAGE_DEPLOYMENT_LABEL` in
 * `convex.config.ts`: an unconfigured deployment is by definition not the one we
 * set up, and under-reporting prod is self-announcing where polluting it is not.
 */
export function resolveDeploymentLabel(): DeploymentLabel {
  const label = env.USAGE_DEPLOYMENT_LABEL;
  if (label === "prod" || label === "dev") return label;
  if (!warnedMissingLabel) {
    warnedMissingLabel = true;
    console.warn(
      "USAGE_DEPLOYMENT_LABEL is not set; AI usage rows will be tagged 'dev'",
    );
  }
  return "dev";
}

/**
 * Test seam. The warn-once flag is module state, so any earlier test that
 * happens to resolve a label would otherwise consume it and make the
 * warning test fail depending on execution order.
 */
export function resetDeploymentLabelWarning(): void {
  warnedMissingLabel = false;
}

type CompletionEventInput = {
  attribution: UsageAttribution;
  request: AIRequest;
  deployment: DeploymentLabel;
  idempotencyKey: string;
  startedAt: number;
  endedAt: number;
  /** Present when the call returned. */
  completion?: AICompletion;
  /** Present when the call threw. */
  error?: unknown;
};

function costFor(completion: AICompletion | undefined): {
  costMicroUsd: number;
  priceVersion: string;
  costSource: "computed" | "provider";
  providerReportedCostMicroUsd?: number;
} {
  // A provider that prices the request itself wins over our rate table.
  if (completion?.costUsd !== undefined) {
    const micro = microUsdFromUsd(completion.costUsd);
    return {
      costMicroUsd: micro,
      priceVersion: PROVIDER_REPORTED_VERSION,
      costSource: "provider",
      providerReportedCostMicroUsd: micro,
    };
  }

  // A failed call reports no usage. Zero cost is the honest answer — the tokens
  // it burned before failing are invisible to us (see the retry undercount in
  // docs/ai-usage-metering-plan.md), not free.
  if (!completion?.usage) {
    return {
      costMicroUsd: 0,
      priceVersion: PRICE_VERSION,
      costSource: "computed",
    };
  }

  const priced = priceTokenUsage(
    completion.provider,
    completion.model,
    completion.usage,
  );
  return { ...priced, costSource: "computed" };
}

function errorDetails(error: unknown): {
  errorType: string;
  requestId?: string;
} {
  if (error instanceof AIRequestError) {
    return {
      errorType: error.name,
      requestId: error.requestId ?? undefined,
    };
  }
  return {
    errorType: error instanceof Error ? error.name : "UnknownError",
  };
}

/** Pure: turns one completed-or-failed AI call into a ledger row. */
export function buildCompletionUsageEvent(
  input: CompletionEventInput,
): AiUsageEvent {
  const { attribution, request, completion, error } = input;

  const status: AiUsageEvent["status"] =
    error !== undefined
      ? "failed"
      : // The call succeeded and was billed, but hit the output ceiling, so its
        // content is unusable and will be discarded by the call site's
        // `assertCompletionNotTruncated`. Billed work that produced nothing.
        isTokenLimitFinishReason(completion?.finishReason ?? null)
        ? "truncated"
        : "ok";

  const failure = error === undefined ? undefined : errorDetails(error);

  return {
    deployment: input.deployment,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.startedAt,

    clerkOrgId: attribution.clerkOrgId,
    tenantName: attribution.tenantName,

    unit: "tokens",
    operation: request.operation,
    // On failure there is no completion to read the resolved backend from, so
    // fall back to the capability — enough to tell a safety call from synthesis.
    provider: completion?.provider ?? `unresolved:${request.capability}`,
    model: completion?.model ?? "unknown",
    providerDeployment: completion?.deployment,
    status,

    inputTokens: completion?.usage?.inputTokens,
    outputTokens: completion?.usage?.outputTokens,
    cachedReadTokens: completion?.usage?.cachedReadTokens,
    cacheWriteTokens: completion?.usage?.cacheWriteTokens,
    tokenClass: "fabric-synthesis",

    ...costFor(completion),

    entityType: attribution.entityType,
    entityId: attribution.entityId,
    entityLabel: attribution.entityLabel,
    actorUserId: attribution.actorUserId,
    actorName: attribution.actorName,
    runId: attribution.runId,

    latencyMs: input.endedAt - input.startedAt,
    finishReason: completion?.finishReason ?? undefined,
    requestId: completion?.requestId ?? failure?.requestId,
    errorType: failure?.errorType,
  };
}

/**
 * Records a row without ever letting the attempt surface to the caller.
 *
 * A billing ledger must not be able to take down process-flow generation. This
 * is the only place that guarantee is enforced, so the try/catch is load-bearing
 * rather than defensive.
 *
 * Deliberately awaited rather than fired and forgotten: Convex does not
 * guarantee that a dangling promise settles before its action returns, so
 * not awaiting would silently drop rows under exactly the conditions we most
 * want measured.
 */
async function recordSafely(
  ctx: ActionCtx,
  event: AiUsageEvent,
): Promise<void> {
  try {
    await ctx.runMutation(internal.aiUsage.record, event);
  } catch (error) {
    console.error("AI usage metering failed", {
      operation: event.operation,
      clerkOrgId: event.clerkOrgId,
      errorType: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : undefined,
    });
  }
}

type VoiceEventInput = {
  attribution: UsageAttribution;
  deployment: DeploymentLabel;
  idempotencyKey: string;
  createdAt: number;
  operation: string;
  provider: string;
  model: string;
  /** A `VOICE_RATES` key. */
  rateKey: string;
  /** The provider's BILLED duration, not a wall-clock measurement. */
  seconds: number;
  status: AiUsageEvent["status"];
  latencyMs?: number;
  errorType?: string;
};

/** Pure: turns one duration-billed call into a ledger row. */
export function buildVoiceUsageEvent(input: VoiceEventInput): AiUsageEvent {
  const { attribution } = input;
  const priced = priceVoiceUsage(input.rateKey, input.seconds);

  return {
    deployment: input.deployment,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.createdAt,

    clerkOrgId: attribution.clerkOrgId,
    tenantName: attribution.tenantName,

    unit: "seconds",
    operation: input.operation,
    provider: input.provider,
    model: input.model,
    status: input.status,

    seconds: input.seconds,
    // No tokenClass: transcription consumes no tokens at all, and tagging it
    // would put it in a token bucket it does not belong to.

    costMicroUsd: priced.costMicroUsd,
    priceVersion: priced.priceVersion,
    costSource: "computed",

    entityType: attribution.entityType,
    entityId: attribution.entityId,
    entityLabel: attribution.entityLabel,
    actorUserId: attribution.actorUserId,
    actorName: attribution.actorName,
    runId: attribution.runId,

    latencyMs: input.latencyMs,
    errorType: input.errorType,
  };
}

/**
 * Records a duration-billed call (today: Scribe transcription).
 *
 * Note the idempotency contract differs from the agent-conversation path. A
 * re-transcription is a genuinely NEW charge — ElevenLabs bills the second
 * request too — so the key includes the attempt's timestamp and a retry
 * correctly produces a second row. Re-reading a conversation's billing metadata
 * is the opposite case: same immutable charge, so that key must be stable.
 */
export async function recordVoiceUsage(
  ctx: ActionCtx,
  attribution: UsageAttribution,
  args: {
    operation: string;
    provider: string;
    model: string;
    rateKey: string;
    seconds: number;
    status?: AiUsageEvent["status"];
    startedAt: number;
    errorType?: string;
  },
): Promise<void> {
  const deployment = resolveDeploymentLabel();
  await recordSafely(
    ctx,
    buildVoiceUsageEvent({
      attribution,
      deployment,
      idempotencyKey: `${deployment}:${args.operation}:${
        attribution.entityId ?? attribution.clerkOrgId
      }:${args.startedAt}`,
      createdAt: args.startedAt,
      operation: args.operation,
      provider: args.provider,
      model: args.model,
      rateKey: args.rateKey,
      seconds: args.seconds,
      status: args.status ?? "ok",
      latencyMs: Date.now() - args.startedAt,
      errorType: args.errorType,
    }),
  );
}

/**
 * Records an ElevenLabs agent conversation from the `metadata` object the
 * conversation-fetch handlers already hold — no extra network call.
 *
 * Idempotency is keyed on the conversation id and NOT on a timestamp, the
 * opposite of `recordVoiceUsage`: re-fetching a conversation re-reads the same
 * immutable bill, so a retry must converge on one row rather than adding a
 * second charge.
 *
 * `unit` is "seconds" because the call is the billed thing, but the row also
 * carries the agent LLM's token counts under `tokenClass: "agent-llm"` — a
 * different provider's model on a different bill from our synthesis tokens, so
 * the console must never add the two together.
 */
export async function recordAgentConversationUsage(
  ctx: ActionCtx,
  attribution: UsageAttribution,
  args: {
    elevenlabsConversationId: string;
    metadata: unknown;
    startedAt?: number;
  },
): Promise<void> {
  const deployment = resolveDeploymentLabel();
  const parsed = parseAgentCharging(args.metadata);

  if (parsed.warnings.length > 0) {
    // Never fatal — a vendor schema change must not break conversation ingest.
    console.warn("ElevenLabs charging payload did not fully reconcile", {
      elevenlabsConversationId: args.elevenlabsConversationId,
      warnings: parsed.warnings,
    });
  }

  const notional =
    parsed.notionalCostUsd ?? parsed.providerCostUsd ?? undefined;

  await recordSafely(ctx, {
    deployment,
    idempotencyKey: `${deployment}:agent-conversation:${args.elevenlabsConversationId}`,
    createdAt: args.startedAt ?? Date.now(),

    clerkOrgId: attribution.clerkOrgId,
    tenantName: attribution.tenantName,

    unit: "seconds",
    operation: "agent-conversation",
    provider: "elevenlabs",
    model: agentModelLabel(parsed.models),
    status: "ok",

    seconds: parsed.billedSeconds,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    cachedReadTokens: parsed.cachedReadTokens,
    cacheWriteTokens: parsed.cacheWriteTokens,
    tokenClass: "agent-llm",

    // Notional, so tenants stay comparable regardless of who drew down the
    // shared plan allowance first. `costSource: "provider"` because every input
    // to it came from the provider — including how much allowance it absorbed —
    // rather than from our own rate table.
    costMicroUsd: notional === undefined ? 0 : microUsdFromUsd(notional),
    priceVersion: PROVIDER_REPORTED_VERSION,
    costSource: "provider",
    providerReportedCostMicroUsd:
      parsed.providerCostUsd === undefined
        ? undefined
        : microUsdFromUsd(parsed.providerCostUsd),
    llmCostMicroUsd:
      parsed.llmCostUsd === undefined
        ? undefined
        : microUsdFromUsd(parsed.llmCostUsd),
    callCostMicroUsd:
      parsed.callCostUsd === undefined
        ? undefined
        : microUsdFromUsd(parsed.callCostUsd),
    platformCostMicroUsd:
      parsed.platformCostUsd === undefined
        ? undefined
        : microUsdFromUsd(parsed.platformCostUsd),

    entityType: attribution.entityType ?? "conversation",
    entityId: attribution.entityId,
    entityLabel: attribution.entityLabel,
    actorUserId: attribution.actorUserId,
    actorName: attribution.actorName,
    runId: attribution.runId,

    requestId: args.elevenlabsConversationId,
  });
}

/**
 * Drop-in replacement for `generateAICompletion` that records a ledger row for
 * both outcomes and re-throws failures unchanged.
 *
 * Metering happens here rather than at the call sites, which means it lands
 * *before* a call site runs `assertCompletionNotTruncated` — so a
 * truncated-but-billed call is captured instead of vanishing into the throw.
 */
export async function meteredCompletion(
  ctx: ActionCtx,
  attribution: UsageAttribution,
  request: AIRequest,
): Promise<AICompletion> {
  const deployment = resolveDeploymentLabel();
  const startedAt = Date.now();

  const key = (requestId: string | null | undefined) =>
    `${deployment}:${request.operation}:${startedAt}:${
      requestId ?? crypto.randomUUID()
    }`;

  let completion: AICompletion;
  try {
    completion = await generateAICompletion(request);
  } catch (error) {
    await recordSafely(
      ctx,
      buildCompletionUsageEvent({
        attribution,
        request,
        deployment,
        idempotencyKey: key(
          error instanceof AIRequestError ? error.requestId : null,
        ),
        startedAt,
        endedAt: Date.now(),
        error,
      }),
    );
    throw error;
  }

  await recordSafely(
    ctx,
    buildCompletionUsageEvent({
      attribution,
      request,
      deployment,
      idempotencyKey: key(completion.requestId),
      startedAt,
      endedAt: Date.now(),
      completion,
    }),
  );

  return completion;
}
