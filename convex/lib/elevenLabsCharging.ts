/**
 * Parser for `metadata.charging` on an ElevenLabs agent conversation.
 *
 * This is an upstream schema we do not control — the same reason
 * `conversations.analysis` is stored as `v.any()` (`schema.ts`). Every field is
 * therefore treated as absent-by-default, and anything that looks wrong is
 * reported in `warnings` rather than thrown: a billing row that is partially
 * populated beats a conversation ingest that fails because a vendor added a
 * field.
 *
 * Three traps this encodes, all found by probing a real payload
 * (`npm run elevenlabs:charging`) rather than from the API reference, which
 * documents `charging`'s members but not their internals:
 *
 *  1. `llm_usage` contains TWO sibling blocks — `irreversible_generation` and
 *     `initiated_generation` — with identical contents, and `llm_price` equals
 *     ONE of them. Summing both doubles every token count.
 *  2. The `*_charge` fields are integer CREDITS (~$0.0002 each, rounded up) and
 *     they do not reconcile: on a text-only call, `cost` = `llm_charge` +
 *     `platform_charge` and `call_charge` is excluded from both totals. The
 *     `*_price` fields are exact USD and DO reconcile, so only those are used.
 *  3. `model_usage` is a map keyed by model name, so one conversation can bill
 *     several models. Never assume a single entry.
 */

export type ParsedAgentCharging = {
  /** `metadata.call_duration_secs` — the billed connection duration. */
  billedSeconds: number;
  /** `metadata.cost_fiat`: exact USD actually charged, after any allowance. */
  providerCostUsd: number | undefined;
  /**
   * What the call would have cost at list price, i.e. with the plan allowance
   * added back. This is the figure worth attributing to a tenant — included
   * minutes are a workspace-wide pool, so marginal cost depends on which tenant
   * happened to call first this period. Computable exactly (not estimated)
   * because the payload reports how much allowance the call consumed.
   */
  notionalCostUsd: number | undefined;
  llmCostUsd: number | undefined;
  platformCostUsd: number | undefined;
  /** Voice-minutes portion, derived as the residual — there is no `call_price`. */
  callCostUsd: number | undefined;
  /** Model ids seen in `model_usage`, sorted. */
  models: string[];
  inputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  isBurst: boolean;
  devDiscount: boolean;
  tier: string | undefined;
  freeMinutesConsumed: number;
  freeLlmDollarsConsumed: number;
  textOnly: boolean;
  ttsAudioOutputSeconds: number;
  asrAudioInputSeconds: number;
  /** Anything that did not reconcile. Surfaced, never thrown. */
  warnings: string[];
};

/** List rate for agent call minutes; burst is double. */
const USD_PER_CALL_MINUTE = 0.08;
const USD_PER_BURST_CALL_MINUTE = 0.16;

/** Tolerance when checking that itemised USD reconciles to the total. */
const RECONCILE_EPSILON_USD = 0.000001;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function nonNegative(value: unknown): number {
  const parsed = num(value);
  return parsed !== undefined && parsed > 0 ? parsed : 0;
}

function bool(value: unknown): boolean {
  return value === true;
}

type TokenTotals = {
  inputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  priceUsd: number;
  models: string[];
};

const EMPTY_TOTALS: TokenTotals = {
  inputTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  priceUsd: 0,
  models: [],
};

/** Sums one generation block across every model it billed. */
function sumGenerationBlock(block: unknown): TokenTotals {
  const modelUsage = record(record(block)?.model_usage);
  if (!modelUsage) return EMPTY_TOTALS;

  const totals: TokenTotals = { ...EMPTY_TOTALS, models: [] };

  for (const [model, rawUsage] of Object.entries(modelUsage)) {
    const usage = record(rawUsage);
    if (!usage) continue;
    totals.models.push(model);

    const bucket = (name: string) => record(usage[name]);
    const add = (name: string): { tokens: number; price: number } => {
      const entry = bucket(name);
      return {
        tokens: nonNegative(entry?.tokens),
        price: nonNegative(entry?.price),
      };
    };

    const input = add("input");
    const cacheRead = add("input_cache_read");
    const cacheWrite = add("input_cache_write");
    const output = add("output_total");

    totals.inputTokens += input.tokens;
    totals.cachedReadTokens += cacheRead.tokens;
    totals.cacheWriteTokens += cacheWrite.tokens;
    totals.outputTokens += output.tokens;
    totals.priceUsd +=
      input.price + cacheRead.price + cacheWrite.price + output.price;
  }

  totals.models.sort();
  return totals;
}

function sameTotals(a: TokenTotals, b: TokenTotals): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.cachedReadTokens === b.cachedReadTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens &&
    a.outputTokens === b.outputTokens
  );
}

export function parseAgentCharging(metadata: unknown): ParsedAgentCharging {
  const warnings: string[] = [];
  const meta = record(metadata) ?? {};
  const charging = record(meta.charging);

  if (!charging) {
    warnings.push("metadata.charging is absent");
  }

  const billedSeconds = nonNegative(meta.call_duration_secs);
  const providerCostUsd = num(meta.cost_fiat);
  const isBurst = bool(charging?.is_burst);
  const freeMinutesConsumed = nonNegative(charging?.free_minutes_consumed);
  const freeLlmDollarsConsumed = nonNegative(
    charging?.free_llm_dollars_consumed,
  );

  // --- tokens: pick ONE generation block, never sum the two ----------------
  const llmUsage = record(charging?.llm_usage);
  const irreversible = sumGenerationBlock(llmUsage?.irreversible_generation);
  const initiated = sumGenerationBlock(llmUsage?.initiated_generation);

  // `irreversible_generation` is the work that was committed, so it is the
  // billable one. When the blocks disagree the semantics are not something we
  // can settle from a single sample — record it and learn from production.
  const hasIrreversible = irreversible.models.length > 0;
  const tokens = hasIrreversible ? irreversible : initiated;
  if (
    hasIrreversible &&
    initiated.models.length > 0 &&
    !sameTotals(irreversible, initiated)
  ) {
    warnings.push(
      "llm_usage.irreversible_generation and initiated_generation disagree; " +
        "used irreversible",
    );
  }

  // --- costs: USD fields only ---------------------------------------------
  const llmPrice = num(charging?.llm_price);
  const platformPrice = num(charging?.platform_price);
  // Prefer the reported aggregate; fall back to the per-bucket sum.
  const llmCostUsd =
    llmPrice ?? (tokens.priceUsd > 0 ? tokens.priceUsd : undefined);

  if (
    llmPrice !== undefined &&
    tokens.priceUsd > 0 &&
    Math.abs(llmPrice - tokens.priceUsd) > RECONCILE_EPSILON_USD
  ) {
    warnings.push(
      `llm_price (${llmPrice}) does not match summed bucket prices ` +
        `(${tokens.priceUsd})`,
    );
  }

  // There is no `call_price`, so the voice-minutes portion is the residual of
  // the exact total minus the two itemised USD figures.
  let callCostUsd: number | undefined;
  if (providerCostUsd !== undefined) {
    const itemised = (llmCostUsd ?? 0) + (platformPrice ?? 0);
    const residual = providerCostUsd - itemised;
    if (residual < -RECONCILE_EPSILON_USD) {
      // Itemised parts exceed the total: our model of the payload is wrong.
      warnings.push(
        `itemised cost (${itemised}) exceeds cost_fiat (${providerCostUsd})`,
      );
      callCostUsd = 0;
    } else {
      callCostUsd = Math.max(0, residual);
    }
  }

  // --- notional: add the consumed allowance back ---------------------------
  let notionalCostUsd: number | undefined;
  if (providerCostUsd !== undefined) {
    const minuteRate = isBurst
      ? USD_PER_BURST_CALL_MINUTE
      : USD_PER_CALL_MINUTE;
    notionalCostUsd =
      providerCostUsd +
      freeMinutesConsumed * minuteRate +
      freeLlmDollarsConsumed;
  }

  const tts = record(charging?.tts_usage);
  const asr = record(charging?.asr_usage);

  return {
    billedSeconds,
    providerCostUsd,
    notionalCostUsd,
    llmCostUsd,
    platformCostUsd: platformPrice,
    callCostUsd,
    models: tokens.models,
    inputTokens: tokens.inputTokens,
    cachedReadTokens: tokens.cachedReadTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
    outputTokens: tokens.outputTokens,
    isBurst,
    devDiscount: bool(charging?.dev_discount),
    tier: typeof charging?.tier === "string" ? charging.tier : undefined,
    freeMinutesConsumed,
    freeLlmDollarsConsumed,
    textOnly: bool(meta.text_only),
    ttsAudioOutputSeconds: nonNegative(tts?.total_audio_output_seconds),
    asrAudioInputSeconds: nonNegative(asr?.total_audio_input_seconds),
    warnings,
  };
}

/**
 * The model label for the ledger row. A conversation can bill several models,
 * and collapsing that to the first one would misattribute cost.
 */
export function agentModelLabel(models: string[]): string {
  if (models.length === 0) return "unknown";
  if (models.length === 1) return models[0]!;
  return models.join("+");
}
