/**
 * Rates for the AI usage ledger.
 *
 * Every cost in this codebase is an **integer of micro-USD** (1e-6 USD). Floats
 * accumulate drift across thousands of rows, and per-token rates are 1e-6-scale
 * to begin with — so the natural unit and the storage unit are the same thing.
 *
 * Convenient consequence: **USD per million tokens is numerically identical to
 * micro-USD per token** ($1/MTok = 1e-6 USD/token = 1 µUSD/token). The token
 * rates below therefore read exactly as the providers publish them.
 *
 * Rates are versioned, not mutated. A ledger row keeps the `priceVersion` it
 * was priced at, so re-pricing history is a deliberate migration rather than a
 * silent restatement. When a rate changes: bump `PRICE_VERSION`, edit the
 * table, and leave existing rows alone.
 */

/** Bump on any rate change. Rows record the version they were priced at. */
export const PRICE_VERSION = "2026-08-04";

/**
 * Recorded instead of a version when no rate is known for a model. Such rows
 * carry `costMicroUsd: 0` — deliberately, and visibly. A wrong number in a
 * billing ledger is worse than an obviously missing one, and the console can
 * filter on this marker to show "N calls unpriced" rather than quietly
 * understating spend.
 */
export const UNPRICED_VERSION = "unpriced";

export type TokenRate = {
  /** Micro-USD per uncached input token. */
  readonly input: number;
  /** Micro-USD per output token. */
  readonly output: number;
  /** Micro-USD per input token served from the prompt cache. */
  readonly cachedRead: number;
  /** Micro-USD per input token written to the prompt cache. */
  readonly cacheWrite: number;
  /**
   * Whether the provider's reported input-token count already contains the
   * cached tokens.
   *
   * This is the single most expensive detail in this file to get wrong.
   * Anthropic reports three **disjoint** buckets (`input_tokens`,
   * `cache_read_input_tokens`, `cache_creation_input_tokens`), whereas OpenAI
   * reports `prompt_tokens` as the **total** with
   * `prompt_tokens_details.cached_tokens` as a subset of it. Treating the
   * OpenAI shape as disjoint charges every cached token twice — once at the
   * full input rate and once at the cached rate.
   */
  readonly inputIncludesCached: boolean;
};

/**
 * Keyed `${provider}:${model}` using the exact `AICompletion.provider` and
 * `AICompletion.model` values (see the model constants in `aiProvider.ts`), so
 * a rename there fails to resolve loudly rather than silently mispricing.
 */
export const TOKEN_RATES: Readonly<Record<string, TokenRate>> = {
  // Claude on Microsoft Foundry bills at Anthropic's standard first-party API
  // rates through the Microsoft Marketplace — NOT at partner rates the way
  // Bedrock and Vertex do. Haiku 4.5: $1.00 / $5.00 per MTok, cache reads
  // ~0.1x, cache writes 1.25x (5-minute TTL).
  "foundry-claude:foundry:claude-haiku-4-5@2": {
    input: 1.0,
    output: 5.0,
    cachedRead: 0.1,
    cacheWrite: 1.25,
    inputIncludesCached: false,
  },

  // Azure Global Standard.
  "foundry-openai:foundry:gpt-5-nano@2025-08-07": {
    input: 0.05,
    output: 0.4,
    cachedRead: 0.005,
    // Azure's automatic prompt caching carries no separate write charge.
    cacheWrite: 0,
    inputIncludesCached: true,
  },

  // `foundry:gpt-5-mini@2025-08-07` is deliberately ABSENT until the Azure
  // Global Standard rate is confirmed. It is reachable only via
  // FOUNDRY_SYNTHESIS_BACKEND=gpt5mini, so until then those rows land as
  // `unpriced` rather than carrying a guessed rate.

};

const MICRO_USD_PER_USD = 1_000_000;

const usdPerMinute = (usd: number): number => (usd * MICRO_USD_PER_USD) / 60;
const usdPerHour = (usd: number): number => (usd * MICRO_USD_PER_USD) / 3600;

/**
 * Micro-USD **per second**. Voice is billed per minute or per hour upstream;
 * normalising to seconds here means the ledger never has to round a duration.
 */
export const VOICE_RATES: Readonly<Record<string, number>> = {
  // ElevenAgents call minutes, $0.08/min list rate.
  //
  // Only a fallback: an agent conversation's real cost comes from the provider
  // itself (`metadata.charging` — see `elevenLabsCharging.ts`), which reports
  // exact USD, whether the call bursted, and how much plan allowance it
  // absorbed. Use this rate only when that payload is unavailable.
  //
  // ElevenLabs applies a 95% discount to silence periods over 10 seconds, which
  // is already reflected in the billed duration they report — so feed this rate
  // their `call_duration_secs`, never a wall-clock duration.
  "elevenlabs:agent-call": usdPerMinute(0.08),

  // Scribe v2 speech-to-text, $0.22/hour. Our request sends diarize,
  // tag_audio_events, word timestamps and no_verbatim — none of which are
  // metered add-ons, so the base rate applies. If entity detection
  // (+$0.070/hr) or keyterm prompting (+$0.050/hr) is ever enabled, add a
  // distinct key rather than editing this one.
  "elevenlabs:scribe_v2": usdPerHour(0.22),
};

export type PricedCost = {
  costMicroUsd: number;
  priceVersion: string;
};

const UNPRICED: PricedCost = {
  costMicroUsd: 0,
  priceVersion: UNPRICED_VERSION,
};

/**
 * One warning per unknown key per isolate. Unbounded warning on a hot path
 * (description-safety runs on every description edit) would bury the signal it
 * exists to raise.
 */
const warnedKeys = new Set<string>();

function warnUnpriced(kind: string, key: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn("AI usage priced at zero: no rate for this key", {
    kind,
    key,
    priceVersion: PRICE_VERSION,
    hint: "Add the rate to convex/lib/aiPricing.ts and bump PRICE_VERSION.",
  });
}

function tokenRateKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

export type TokenUsageForPricing = {
  /** As reported by the provider — see `TokenRate.inputIncludesCached`. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedReadTokens?: number;
  readonly cacheWriteTokens?: number;
};

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** Converts a provider-reported USD amount into micro-USD. */
export function microUsdFromUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.round(usd * MICRO_USD_PER_USD);
}

/**
 * Prices token usage from our own rate table.
 *
 * Returns `UNPRICED` for an unknown model rather than falling back to a
 * "similar" rate — a silently mispriced ledger cannot be distinguished from a
 * correct one after the fact, whereas an unpriced row announces itself.
 */
export function priceTokenUsage(
  provider: string,
  model: string,
  usage: TokenUsageForPricing,
): PricedCost {
  const key = tokenRateKey(provider, model);
  const rate = TOKEN_RATES[key];
  if (!rate) {
    warnUnpriced("tokens", key);
    return UNPRICED;
  }

  const cachedRead = finite(usage.cachedReadTokens);
  const cacheWrite = finite(usage.cacheWriteTokens);
  const reportedInput = finite(usage.inputTokens);
  // Never let a provider quirk produce a negative billable count.
  const uncachedInput = rate.inputIncludesCached
    ? Math.max(0, reportedInput - cachedRead)
    : reportedInput;

  const costMicroUsd = Math.round(
    uncachedInput * rate.input +
      cachedRead * rate.cachedRead +
      cacheWrite * rate.cacheWrite +
      finite(usage.outputTokens) * rate.output,
  );

  return { costMicroUsd, priceVersion: PRICE_VERSION };
}

/**
 * Prices a duration-billed call. `key` is a `VOICE_RATES` key; `seconds` must
 * be the provider's **billed** duration, not a wall-clock measurement.
 */
export function priceVoiceUsage(key: string, seconds: number): PricedCost {
  const rate = VOICE_RATES[key];
  if (rate === undefined) {
    warnUnpriced("seconds", key);
    return UNPRICED;
  }
  return {
    costMicroUsd: Math.round(finite(seconds) * rate),
    priceVersion: PRICE_VERSION,
  };
}

/** Test seam — the per-isolate warning dedupe would otherwise leak between tests. */
export function resetUnpricedWarnings(): void {
  warnedKeys.clear();
}
