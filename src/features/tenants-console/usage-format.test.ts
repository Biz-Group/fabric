import { describe, expect, test } from "vitest";
import {
  formatDuration,
  formatPeriod,
  formatShare,
  formatTokens,
  formatUsd,
  formatUsdCompact,
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
