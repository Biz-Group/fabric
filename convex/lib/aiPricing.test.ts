import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  PRICE_VERSION,
  UNPRICED_VERSION,
  microUsdFromUsd,
  priceTokenUsage,
  priceVoiceUsage,
  resetUnpricedWarnings,
} from "./aiPricing";

const FOUNDRY_CLAUDE = "foundry-claude";
const CLAUDE_MODEL = "foundry:claude-haiku-4-5@2";
const FOUNDRY_OPENAI = "foundry-openai";
const NANO_MODEL = "foundry:gpt-5-nano@2025-08-07";

beforeEach(() => {
  resetUnpricedWarnings();
});

describe("token pricing", () => {
  test("prices a plain call at the published per-MTok rate", () => {
    // Haiku 4.5 on Foundry: $1.00 in / $5.00 out per MTok.
    // 10,000 in + 2,000 out = $0.01 + $0.01 = $0.02 = 20,000 micro-USD.
    expect(
      priceTokenUsage(FOUNDRY_CLAUDE, CLAUDE_MODEL, {
        inputTokens: 10_000,
        outputTokens: 2_000,
      }),
    ).toEqual({ costMicroUsd: 20_000, priceVersion: PRICE_VERSION });
  });

  test("treats Anthropic's cache buckets as disjoint from input", () => {
    // 1,000 uncached in ($0.001) + 5,000 cache reads at 0.1x ($0.0005)
    // + 2,000 cache writes at 1.25x ($0.0025) + 100 out ($0.0005).
    expect(
      priceTokenUsage(FOUNDRY_CLAUDE, CLAUDE_MODEL, {
        inputTokens: 1_000,
        outputTokens: 100,
        cachedReadTokens: 5_000,
        cacheWriteTokens: 2_000,
      }).costMicroUsd,
    ).toBe(1_000 * 1 + 5_000 * 0.1 + 2_000 * 1.25 + 100 * 5);
  });

  test("subtracts cached tokens from input on the OpenAI convention", () => {
    // OpenAI folds cached tokens INTO prompt_tokens. Of 1,000 input tokens,
    // 400 were cached, so only 600 bill at the full rate.
    const priced = priceTokenUsage(FOUNDRY_OPENAI, NANO_MODEL, {
      inputTokens: 1_000,
      outputTokens: 200,
      cachedReadTokens: 400,
    });
    expect(priced.costMicroUsd).toBe(
      Math.round(600 * 0.05 + 400 * 0.005 + 200 * 0.4),
    );
  });

  test("does not double-charge cached input on the OpenAI convention", () => {
    // The regression this guards: treating the OpenAI shape as disjoint charges
    // every cached token twice — once at the input rate, once at the cached rate.
    const withCache = priceTokenUsage(FOUNDRY_OPENAI, NANO_MODEL, {
      inputTokens: 1_000,
      outputTokens: 0,
      cachedReadTokens: 1_000,
    });
    const naivelyDisjoint = Math.round(1_000 * 0.05 + 1_000 * 0.005);
    expect(withCache.costMicroUsd).toBeLessThan(naivelyDisjoint);
    // All 1,000 input tokens were cached, so nothing bills at the full rate.
    expect(withCache.costMicroUsd).toBe(Math.round(1_000 * 0.005));
  });

  test("never produces a negative cost when cached exceeds reported input", () => {
    expect(
      priceTokenUsage(FOUNDRY_OPENAI, NANO_MODEL, {
        inputTokens: 100,
        outputTokens: 0,
        cachedReadTokens: 500,
      }).costMicroUsd,
    ).toBeGreaterThanOrEqual(0);
  });

  test("ignores non-finite and negative token counts", () => {
    expect(
      priceTokenUsage(FOUNDRY_CLAUDE, CLAUDE_MODEL, {
        inputTokens: Number.NaN,
        outputTokens: -50,
      }).costMicroUsd,
    ).toBe(0);
  });

  test("marks an unknown model unpriced rather than guessing a rate", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const priced = priceTokenUsage(FOUNDRY_OPENAI, "foundry:gpt-5-mini@2025-08-07", {
      inputTokens: 5_000,
      outputTokens: 5_000,
    });
    expect(priced).toEqual({
      costMicroUsd: 0,
      priceVersion: UNPRICED_VERSION,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test("warns once per unknown key, not once per call", () => {
    // description-safety runs on every description edit; an unbounded warning
    // would bury the signal it exists to raise.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 5; i++) {
      priceTokenUsage("made-up", "model", { inputTokens: 1, outputTokens: 1 });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test("does not drift when summed across many rows", () => {
    // Integer micro-USD exists so that a month of rows adds up exactly.
    let total = 0;
    for (let i = 0; i < 10_000; i++) {
      total += priceTokenUsage(FOUNDRY_CLAUDE, CLAUDE_MODEL, {
        inputTokens: 1_234,
        outputTokens: 567,
      }).costMicroUsd;
    }
    expect(total).toBe(10_000 * (1_234 * 1 + 567 * 5));
    expect(Number.isInteger(total)).toBe(true);
  });
});

describe("voice pricing", () => {
  test("prices agent minutes at the $0.08/min list rate", () => {
    // 600 billed seconds = 10 minutes = $0.80.
    expect(priceVoiceUsage("elevenlabs:agent-call", 600)).toEqual({
      costMicroUsd: 800_000,
      priceVersion: PRICE_VERSION,
    });
  });

  test("prices Scribe at the $0.22/hour rate", () => {
    expect(priceVoiceUsage("elevenlabs:scribe_v2", 3_600).costMicroUsd).toBe(
      220_000,
    );
  });

  test("marks an unknown voice key unpriced", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(priceVoiceUsage("elevenlabs:unknown-thing", 60)).toEqual({
      costMicroUsd: 0,
      priceVersion: UNPRICED_VERSION,
    });
    warn.mockRestore();
  });
});

describe("microUsdFromUsd", () => {
  test("converts and rounds to whole micro-USD", () => {
    expect(microUsdFromUsd(0.0123456)).toBe(12_346);
    expect(microUsdFromUsd(1)).toBe(1_000_000);
  });

  test("floors absent or nonsensical values at zero", () => {
    expect(microUsdFromUsd(-1)).toBe(0);
    expect(microUsdFromUsd(Number.NaN)).toBe(0);
  });
});
