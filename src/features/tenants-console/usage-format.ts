/**
 * Formatting for the usage console.
 *
 * Cost is stored and summed as integer micro-USD (1e-6 USD) so a month of rows
 * adds up exactly. The division by 1e6 happens **here and nowhere else** — the
 * moment a float enters the accumulation path the totals stop being reproducible.
 */

const MICRO_USD_PER_USD = 1_000_000;

/**
 * Money, at a precision that matches the magnitude.
 *
 * Single AI calls cost fractions of a cent (a description-safety check is 43
 * micro-USD, i.e. $0.000043), so a fixed 2dp format would render most of this
 * dataset as "$0.00" and make the page look broken.
 */
export function formatUsd(microUsd: number): string {
  if (!Number.isFinite(microUsd)) return "—";
  const usd = microUsd / MICRO_USD_PER_USD;
  if (usd === 0) return "$0.00";
  if (usd >= 1) {
    return `$${usd.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  // Below a cent, show enough digits to be a number rather than a rounding
  // artefact.
  return `$${usd.toFixed(6)}`;
}

/** Compact money for axis ticks, where width matters more than precision. */
export function formatUsdCompact(microUsd: number): string {
  if (!Number.isFinite(microUsd)) return "—";
  const usd = microUsd / MICRO_USD_PER_USD;
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`;
  if (usd >= 1) return `$${usd.toFixed(0)}`;
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd === 0) return "$0";
  return `$${usd.toFixed(4)}`;
}

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return "—";
  if (tokens === 0) return "0";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return tokens.toLocaleString("en-US");
}

/** Voice/audio duration. Seconds are the stored unit; minutes are how it bills. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

export function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : "—";
}

/** Share of a total, guarding the empty-range case. */
export function formatShare(part: number, total: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return "—";
  const pct = (part / total) * 100;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct.toFixed(1)}%`;
}

/** `YYYY-MM-DD` (a UTC day key) → a short axis/table label. */
export function formatPeriod(period: string): string {
  const parsed = Date.parse(`${period}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return period;
  return new Date(parsed).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Current UTC day as `YYYY-MM-DD`, matching the server's `utcDayKey`. */
export function utcDayKey(ms: number = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Inclusive range ending today, `days` wide. */
export function utcRangeEndingToday(days: number): {
  from: string;
  to: string;
} {
  const to = utcDayKey();
  const from = utcDayKey(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  return { from, to };
}
