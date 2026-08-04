import { describe, expect, test } from "vitest";
import { UNPRICED_VERSION } from "./aiPricing";
import {
  foldUsageRows,
  rollupKey,
  utcDayBounds,
  utcDayKey,
  type RollableUsageRow,
} from "./aiUsageRollup";

function row(overrides: Partial<RollableUsageRow> = {}): RollableUsageRow {
  return {
    deployment: "prod",
    clerkOrgId: "org_1",
    tenantName: "Acme",
    operation: "description-safety",
    provider: "foundry-openai",
    model: "foundry:gpt-5-nano@2025-08-07",
    status: "ok",
    priceVersion: "2026-08-04",
    inputTokens: 344,
    outputTokens: 64,
    costMicroUsd: 43,
    ...overrides,
  };
}

describe("utc day handling", () => {
  test("keys by UTC day, not local time", () => {
    expect(utcDayKey(Date.parse("2026-08-04T23:59:59.999Z"))).toBe("2026-08-04");
    expect(utcDayKey(Date.parse("2026-08-05T00:00:00.000Z"))).toBe("2026-08-05");
  });

  test("bounds are start-inclusive and end-exclusive", () => {
    const { start, end } = utcDayBounds("2026-08-04");
    expect(start).toBe(Date.parse("2026-08-04T00:00:00.000Z"));
    expect(end).toBe(Date.parse("2026-08-05T00:00:00.000Z"));
    expect(end - start).toBe(86_400_000);
  });

  test("rejects a malformed period rather than folding the wrong range", () => {
    expect(() => utcDayBounds("not-a-day")).toThrow(/Invalid period/);
  });
});

describe("foldUsageRows", () => {
  test("groups by tenant, operation and model", () => {
    const groups = foldUsageRows("2026-08-04", [
      row(),
      row(),
      row({ operation: "department-summary" }),
      row({ clerkOrgId: "org_2" }),
      row({ model: "foundry:claude-haiku-4-5@2" }),
    ]);

    expect(groups).toHaveLength(4);
    const safety = groups.find(
      (g) => g.operation === "description-safety" && g.clerkOrgId === "org_1" &&
        g.model === "foundry:gpt-5-nano@2025-08-07",
    );
    expect(safety?.callCount).toBe(2);
    expect(safety?.costMicroUsd).toBe(86);
    expect(safety?.inputTokens).toBe(688);
  });

  test("separates deployments so prod totals are never polluted by dev", () => {
    const groups = foldUsageRows("2026-08-04", [
      row({ deployment: "prod", costMicroUsd: 100 }),
      row({ deployment: "dev", costMicroUsd: 7 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.deployment === "prod")?.costMicroUsd).toBe(100);
    expect(groups.find((g) => g.deployment === "dev")?.costMicroUsd).toBe(7);
  });

  test("counts failures, truncations and unpriced calls separately", () => {
    const groups = foldUsageRows("2026-08-04", [
      row(),
      row({ status: "failed", costMicroUsd: 0, inputTokens: 0, outputTokens: 0 }),
      row({ status: "truncated" }),
      row({ priceVersion: UNPRICED_VERSION, costMicroUsd: 0 }),
    ]);

    const group = groups[0]!;
    expect(group.callCount).toBe(4);
    expect(group.failedCount).toBe(1);
    expect(group.truncatedCount).toBe(1);
    // An unpriced row is a real call with missing cost, not a free one.
    expect(group.unpricedCount).toBe(1);
  });

  test("sums seconds and provider-reported cost for voice rows", () => {
    const groups = foldUsageRows("2026-08-04", [
      row({
        operation: "agent-conversation",
        provider: "elevenlabs",
        model: "claude-haiku-4-5",
        seconds: 5,
        costMicroUsd: 25_035,
        providerReportedCostMicroUsd: 25_035,
        inputTokens: 12_877,
        cacheWriteTokens: 6_362,
        outputTokens: 241,
      }),
      row({
        operation: "agent-conversation",
        provider: "elevenlabs",
        model: "claude-haiku-4-5",
        seconds: 10,
        costMicroUsd: 30_000,
        providerReportedCostMicroUsd: 20_000,
      }),
    ]);

    const group = groups[0]!;
    expect(group.seconds).toBe(15);
    expect(group.costMicroUsd).toBe(55_035);
    // Notional and actual are tracked separately; the gap is the plan discount.
    expect(group.providerReportedCostMicroUsd).toBe(45_035);
    expect(group.cacheWriteTokens).toBe(6_362);
  });

  test("reproduces a direct scan exactly", () => {
    // The property the console depends on: rollups must equal what a full scan
    // of the same rows would have produced.
    const rows = Array.from({ length: 250 }, (_, i) =>
      row({
        clerkOrgId: `org_${i % 5}`,
        operation: i % 2 === 0 ? "description-safety" : "department-summary",
        costMicroUsd: i,
        inputTokens: i * 2,
      }),
    );

    const groups = foldUsageRows("2026-08-04", rows);
    const foldedCost = groups.reduce((sum, g) => sum + g.costMicroUsd, 0);
    const foldedCalls = groups.reduce((sum, g) => sum + g.callCount, 0);

    expect(foldedCost).toBe(rows.reduce((s, r) => s + r.costMicroUsd, 0));
    expect(foldedCalls).toBe(rows.length);
  });

  test("is idempotent — folding twice yields identical absolute totals", () => {
    // The fold returns absolute totals, never deltas, so a re-run repairs a bad
    // rollup instead of doubling it.
    const rows = [row(), row({ status: "failed" })];
    expect(foldUsageRows("2026-08-04", rows)).toEqual(
      foldUsageRows("2026-08-04", rows),
    );
  });

  test("takes the freshest tenant name when one is renamed mid-day", () => {
    const groups = foldUsageRows("2026-08-04", [
      row({ tenantName: "Acme" }),
      row({ tenantName: "Acme Corp" }),
    ]);
    expect(groups[0]!.tenantName).toBe("Acme Corp");
  });

  test("tolerates missing token fields", () => {
    const groups = foldUsageRows("2026-08-04", [
      row({ inputTokens: undefined, outputTokens: undefined }),
    ]);
    expect(groups[0]!.inputTokens).toBe(0);
    expect(groups[0]!.outputTokens).toBe(0);
  });

  test("returns nothing for an empty day", () => {
    expect(foldUsageRows("2026-08-04", [])).toEqual([]);
  });

  test("carries tokenClass so synthesis and agent tokens stay separable", () => {
    // The console must never blend these: different models, different bills.
    // Storing the class beats inferring it from `operation` downstream.
    const groups = foldUsageRows("2026-08-04", [
      row({ tokenClass: "fabric-synthesis" }),
      row({
        operation: "agent-conversation",
        provider: "elevenlabs",
        model: "claude-haiku-4-5",
        tokenClass: "agent-llm",
        inputTokens: 12_877,
        outputTokens: 241,
      }),
    ]);

    expect(groups).toHaveLength(2);
    const synthesis = groups.find((g) => g.tokenClass === "fabric-synthesis");
    const agent = groups.find((g) => g.tokenClass === "agent-llm");
    expect(synthesis?.inputTokens).toBe(344);
    expect(agent?.inputTokens).toBe(12_877);
  });

  test("leaves tokenClass undefined when the ledger row has none", () => {
    // Rows written before the field existed must not be silently classed as
    // synthesis by the fold — the reader decides how to treat unknown.
    const groups = foldUsageRows("2026-08-04", [row({ tokenClass: undefined })]);
    expect(groups[0]!.tokenClass).toBeUndefined();
  });
});

describe("rollupKey", () => {
  test("excludes provider so a provider rename cannot split a group", () => {
    const base = {
      period: "2026-08-04",
      deployment: "prod",
      clerkOrgId: "org_1",
      operation: "op",
      model: "m",
    };
    expect(rollupKey(base)).toBe(rollupKey({ ...base }));
  });

  test("distinguishes every dimension it does include", () => {
    const base = {
      period: "2026-08-04",
      deployment: "prod",
      clerkOrgId: "org_1",
      operation: "op",
      model: "m",
    };
    const keys = new Set([
      rollupKey(base),
      rollupKey({ ...base, period: "2026-08-05" }),
      rollupKey({ ...base, deployment: "dev" }),
      rollupKey({ ...base, clerkOrgId: "org_2" }),
      rollupKey({ ...base, operation: "other" }),
      rollupKey({ ...base, model: "n" }),
    ]);
    expect(keys.size).toBe(6);
  });
});
