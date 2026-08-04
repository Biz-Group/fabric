import { describe, expect, test } from "vitest";
import { agentModelLabel, parseAgentCharging } from "./elevenLabsCharging";

/**
 * Verbatim `metadata` from a real conversation (conv_1601kz632c9hfyevs9h3vzw9gz6s),
 * captured with `npm run elevenlabs:charging`. Kept exact — the point of this
 * fixture is that it is not an idealised shape.
 *
 * Note `text_only: true`: this was a chat, so `tts_usage` / `asr_usage` are
 * zeroed and no voice minutes were billed. The voice-populated variant is still
 * unverified — see the plan's open items.
 */
const REAL_METADATA = {
  call_duration_secs: 5,
  cost: 126,
  cost_fiat: 0.0250345,
  start_time_unix_secs: 1785837203,
  termination_reason: "end_call tool was called.",
  text_only: true,
  charging: {
    dev_discount: false,
    is_burst: false,
    tier: "pro",
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
      initiated_generation: {
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
    llm_price: 0.022034500000000002,
    llm_charge: 111,
    call_charge: 15,
    platform_charge: 15,
    platform_usage: {
      category_usage: {
        text_message: { credits: 15, price: 0.003, quantity: 1 },
      },
    },
    platform_price: 0.003,
    free_minutes_consumed: 0,
    free_llm_dollars_consumed: 0,
    tts_usage: {
      primary_tts_model: "eleven_v3_conversational",
      total_audio_output_seconds: 0,
      total_characters: 0,
      per_voice_usage: [],
    },
    asr_usage: {
      asr_model: "scribe_realtime",
      total_transcription_calls: 0,
      total_audio_input_seconds: 0,
    },
    analysis: null,
  },
};

describe("parseAgentCharging on a real payload", () => {
  test("reads the exact provider cost from cost_fiat", () => {
    const parsed = parseAgentCharging(REAL_METADATA);
    expect(parsed.providerCostUsd).toBe(0.0250345);
    expect(parsed.billedSeconds).toBe(5);
    expect(parsed.warnings).toEqual([]);
  });

  test("counts ONE generation block, not both", () => {
    // The two blocks are identical; summing them would double every count.
    const parsed = parseAgentCharging(REAL_METADATA);
    expect(parsed.inputTokens).toBe(12_877);
    expect(parsed.cacheWriteTokens).toBe(6_362);
    expect(parsed.cachedReadTokens).toBe(0);
    expect(parsed.outputTokens).toBe(241);
  });

  test("itemised USD reconciles to the total", () => {
    // llm_price + platform_price == cost_fiat exactly, leaving no voice residual
    // on a text-only call.
    const parsed = parseAgentCharging(REAL_METADATA);
    expect(parsed.llmCostUsd).toBeCloseTo(0.0220345, 10);
    expect(parsed.platformCostUsd).toBe(0.003);
    expect(parsed.callCostUsd).toBeCloseTo(0, 9);
    expect(
      (parsed.llmCostUsd ?? 0) +
        (parsed.platformCostUsd ?? 0) +
        (parsed.callCostUsd ?? 0),
    ).toBeCloseTo(parsed.providerCostUsd ?? 0, 9);
  });

  test("notional equals provider cost when no allowance was consumed", () => {
    const parsed = parseAgentCharging(REAL_METADATA);
    expect(parsed.freeMinutesConsumed).toBe(0);
    expect(parsed.notionalCostUsd).toBe(parsed.providerCostUsd);
  });

  test("captures the plan and burst flags", () => {
    const parsed = parseAgentCharging(REAL_METADATA);
    expect(parsed.tier).toBe("pro");
    expect(parsed.isBurst).toBe(false);
    expect(parsed.devDiscount).toBe(false);
    expect(parsed.textOnly).toBe(true);
    expect(parsed.models).toEqual(["claude-haiku-4-5"]);
  });
});

describe("allowance and burst reconstruction", () => {
  function withCharging(overrides: Record<string, unknown>) {
    return {
      ...REAL_METADATA,
      charging: { ...REAL_METADATA.charging, ...overrides },
    };
  }

  test("adds consumed free minutes back at the list rate", () => {
    // 10 free minutes absorbed => notional is $0.80 higher than what we paid.
    const parsed = parseAgentCharging(
      withCharging({ free_minutes_consumed: 10 }),
    );
    expect(parsed.notionalCostUsd).toBeCloseTo(0.0250345 + 0.8, 9);
  });

  test("adds consumed free LLM dollars back at face value", () => {
    const parsed = parseAgentCharging(
      withCharging({ free_llm_dollars_consumed: 0.5 }),
    );
    expect(parsed.notionalCostUsd).toBeCloseTo(0.0250345 + 0.5, 9);
  });

  test("prices free minutes at the burst rate when the call bursted", () => {
    // is_burst is reported, so a bursted call is priced correctly rather than
    // under-reported at the standard rate.
    const parsed = parseAgentCharging(
      withCharging({ is_burst: true, free_minutes_consumed: 10 }),
    );
    expect(parsed.isBurst).toBe(true);
    expect(parsed.notionalCostUsd).toBeCloseTo(0.0250345 + 1.6, 9);
  });
});

describe("resilience to an upstream schema we do not control", () => {
  test("returns zeroed totals and a warning when charging is absent", () => {
    const parsed = parseAgentCharging({ call_duration_secs: 42 });
    expect(parsed.billedSeconds).toBe(42);
    expect(parsed.inputTokens).toBe(0);
    expect(parsed.providerCostUsd).toBeUndefined();
    expect(parsed.warnings).toContain("metadata.charging is absent");
  });

  test("survives null, a string, and an array", () => {
    for (const input of [null, undefined, "nope", [1, 2, 3], 7]) {
      const parsed = parseAgentCharging(input);
      expect(parsed.inputTokens).toBe(0);
      expect(parsed.warnings.length).toBeGreaterThan(0);
    }
  });

  test("sums across several models and labels them all", () => {
    const parsed = parseAgentCharging({
      cost_fiat: 0.01,
      charging: {
        llm_usage: {
          irreversible_generation: {
            model_usage: {
              "claude-haiku-4-5": {
                input: { tokens: 100, price: 0.0001 },
                output_total: { tokens: 10, price: 0.00005 },
              },
              "gpt-5-nano": {
                input: { tokens: 200, price: 0.00001 },
                output_total: { tokens: 20, price: 0.000008 },
              },
            },
          },
        },
      },
    });

    expect(parsed.inputTokens).toBe(300);
    expect(parsed.outputTokens).toBe(30);
    expect(parsed.models).toEqual(["claude-haiku-4-5", "gpt-5-nano"]);
    expect(agentModelLabel(parsed.models)).toBe("claude-haiku-4-5+gpt-5-nano");
  });

  test("warns when the two generation blocks disagree", () => {
    const parsed = parseAgentCharging({
      cost_fiat: 0.01,
      charging: {
        llm_usage: {
          irreversible_generation: {
            model_usage: { m: { input: { tokens: 10, price: 0.001 } } },
          },
          initiated_generation: {
            model_usage: { m: { input: { tokens: 99, price: 0.009 } } },
          },
        },
      },
    });
    // The committed block wins.
    expect(parsed.inputTokens).toBe(10);
    expect(parsed.warnings.join(" ")).toContain("disagree");
  });

  test("falls back to initiated_generation when irreversible is missing", () => {
    const parsed = parseAgentCharging({
      cost_fiat: 0.01,
      charging: {
        llm_usage: {
          initiated_generation: {
            model_usage: { m: { input: { tokens: 55, price: 0.001 } } },
          },
        },
      },
    });
    expect(parsed.inputTokens).toBe(55);
  });

  test("warns rather than going negative when itemised exceeds the total", () => {
    const parsed = parseAgentCharging({
      cost_fiat: 0.001,
      charging: { llm_price: 5, platform_price: 1 },
    });
    expect(parsed.callCostUsd).toBe(0);
    expect(parsed.warnings.join(" ")).toContain("exceeds cost_fiat");
  });

  test("warns when llm_price disagrees with the summed buckets", () => {
    const parsed = parseAgentCharging({
      cost_fiat: 1,
      charging: {
        llm_price: 0.5,
        llm_usage: {
          irreversible_generation: {
            model_usage: { m: { input: { tokens: 10, price: 0.001 } } },
          },
        },
      },
    });
    expect(parsed.warnings.join(" ")).toContain("does not match");
  });

  test("derives the voice residual when a call bills minutes", () => {
    const parsed = parseAgentCharging({
      call_duration_secs: 120,
      cost_fiat: 0.2,
      charging: { llm_price: 0.04, platform_price: 0.0 },
    });
    // $0.20 total − $0.04 LLM = $0.16 of voice minutes (2 min at $0.08).
    expect(parsed.callCostUsd).toBeCloseTo(0.16, 9);
  });
});
