import { describe, expect, test } from "vitest";
import {
  formatDuration,
  formatPeriod,
  formatShare,
  formatTokens,
  formatUsd,
  formatUsdCompact,
  resolveUsageRange,
  utcDayKey,
  utcRangeEndingToday,
} from "./usage-format";

describe("formatUsd", () => {
  test("renders sub-cent amounts as real numbers, not $0.00", () => {
    // A description-safety call costs 43 micro-USD. A fixed 2dp format would
    // render most of this dataset as zero and make the page look broken.
    expect(formatUsd(43)).toBe("$0.000043");
    expect(formatUsd(1)).toBe("$0.000001");
  });

  test("an agent conversation reads at cent scale", () => {
    // The probed conversation cost $0.0250345 — above a cent, so it takes the
    // 4dp branch rather than the 6dp one.
    expect(formatUsd(25_035)).toBe("$0.0250");
  });

  test("switches to 2dp once amounts pass a dollar", () => {
    expect(formatUsd(1_000_000)).toBe("$1.00");
    expect(formatUsd(1_234_567)).toBe("$1.23");
  });

  test("keeps 4dp between a cent and a dollar", () => {
    expect(formatUsd(50_000)).toBe("$0.0500");
  });

  test("renders exact zero plainly and rejects non-finite input", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(Number.NaN)).toBe("—");
  });

  test("thousands separators on large totals", () => {
    expect(formatUsd(12_345_678_901)).toBe("$12,345.68");
  });
});

describe("formatUsdCompact", () => {
  test("abbreviates for axis ticks", () => {
    expect(formatUsdCompact(0)).toBe("$0");
    expect(formatUsdCompact(2_500_000)).toBe("$3");
    expect(formatUsdCompact(4_500_000_000)).toBe("$4.5k");
  });
});

describe("formatTokens", () => {
  test("abbreviates at thousand and million scale", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(344)).toBe("344");
    expect(formatTokens(12_877)).toBe("12.9k");
    expect(formatTokens(2_500_000)).toBe("2.50M");
  });
});

describe("formatDuration", () => {
  test("scales seconds to minutes and hours", () => {
    expect(formatDuration(5)).toBe("5s");
    expect(formatDuration(150)).toBe("2.5m");
    expect(formatDuration(7_200)).toBe("2.0h");
  });

  test("treats zero and negative as absent", () => {
    expect(formatDuration(0)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
  });
});

describe("formatShare", () => {
  test("guards divide-by-zero on an empty range", () => {
    expect(formatShare(5, 0)).toBe("—");
  });

  test("does not round a real share down to 0.0%", () => {
    expect(formatShare(1, 100_000)).toBe("<0.1%");
    expect(formatShare(25, 100)).toBe("25.0%");
  });
});

describe("utc helpers", () => {
  test("day key matches the server's UTC bucketing", () => {
    expect(utcDayKey(Date.parse("2026-08-04T23:59:59Z"))).toBe("2026-08-04");
    expect(utcDayKey(Date.parse("2026-08-05T00:00:00Z"))).toBe("2026-08-05");
  });

  test("a 7-day range is inclusive of both ends", () => {
    const { from, to } = utcRangeEndingToday(7);
    const days =
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000;
    expect(days).toBe(6); // 6 gaps == 7 inclusive days
  });

  test("period labels render in UTC, not the viewer's zone", () => {
    // A local-time render would shift the label by a day for negative offsets.
    expect(formatPeriod("2026-08-04")).toBe("Aug 4");
  });

  test("passes through an unparseable period rather than showing NaN", () => {
    expect(formatPeriod("not-a-day")).toBe("not-a-day");
  });
});

describe("resolveUsageRange", () => {
  const today = utcDayKey();
  const custom = { from: "2026-07-01", to: "2026-07-15" };

  test("clamps a preset start to the first day that has data", () => {
    // Without this a 90-day preset on a young ledger flags ~76 days as
    // "no rollup yet", which reads as a broken fold rather than as a ledger
    // that did not exist then.
    const availability = { earliest: "2026-08-01", latest: today };
    expect(resolveUsageRange(90, custom, availability).from).toBe("2026-08-01");
  });

  test("leaves a preset start alone when data reaches further back", () => {
    const availability = { earliest: "2020-01-01", latest: today };
    const range = resolveUsageRange(7, custom, availability);
    expect(range.from).toBe(utcRangeEndingToday(7).from);
  });

  test("always ends the window at today, even if data is older", () => {
    // A gap between the newest data and today is a signal (nothing recorded, or
    // the fold has stalled) and must stay visible rather than being hidden by
    // shrinking the range.
    const availability = { earliest: "2026-07-01", latest: "2026-07-20" };
    expect(resolveUsageRange(30, custom, availability).to).toBe(today);
  });

  test("falls back to the raw preset when there is no data at all", () => {
    expect(resolveUsageRange(30, custom, null)).toEqual(
      utcRangeEndingToday(30),
    );
  });

  test("clamps a custom range into the available window", () => {
    const availability = { earliest: "2026-07-05", latest: "2026-07-10" };
    expect(
      resolveUsageRange("custom", { from: "2026-01-01", to: "2026-12-31" }, availability),
    ).toEqual({ from: "2026-07-05", to: "2026-07-10" });
  });

  test("swaps a reversed custom range instead of querying an empty window", () => {
    expect(
      resolveUsageRange("custom", { from: "2026-07-15", to: "2026-07-01" }, null),
    ).toEqual({ from: "2026-07-01", to: "2026-07-15" });
  });

  test("pulls a wholly out-of-range custom selection back to the data", () => {
    const availability = { earliest: "2026-07-05", latest: "2026-07-10" };
    const range = resolveUsageRange(
      "custom",
      { from: "2030-01-01", to: "2030-02-01" },
      availability,
    );
    expect(range.from).toBe("2026-07-10");
    expect(range.to).toBe("2026-07-10");
  });

  test("leaves a valid custom range untouched", () => {
    const availability = { earliest: "2026-06-01", latest: "2026-08-01" };
    expect(resolveUsageRange("custom", custom, availability)).toEqual(custom);
  });
});
