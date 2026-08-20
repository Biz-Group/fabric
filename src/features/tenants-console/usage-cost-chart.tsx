"use client";

import { useId, useMemo, useState } from "react";
import { formatPeriod, formatUsd, formatUsdCompact } from "./usage-format";

/**
 * Cost over time — either the per-day figure or the running total.
 *
 * Form: change-over-time on a single measure → a line with a soft area fill.
 * Deliberately ONE series and ONE y-axis per chart: cost and token counts are
 * different scales, so tokens live in their own tiles and tables rather than a
 * second axis. Daily and cumulative are different scales for the same reason, so
 * they are two charts side by side rather than two lines sharing an axis.
 * A single series needs no legend — the heading names it.
 *
 * Colour: categorical slot 1 (blue) for daily, slot 2 (orange) for cumulative,
 * both validated against the light and dark chart surfaces (lightness band,
 * chroma floor, 3:1 contrast). Text stays on ink tokens throughout; the mark
 * alone carries identity.
 */

export type UsageDayPoint = {
  period: string;
  costMicroUsd: number;
  callCount: number;
};

/** `daily` plots each day on its own; `cumulative` plots the running total. */
export type UsageCostChartMode = "daily" | "cumulative";

// Sized for a half-width column: the previous 900-wide viewBox shrank the 11px
// labels below legibility once two of these sit side by side.
const WIDTH = 480;
const HEIGHT = 220;
const PAD = { top: 16, right: 16, bottom: 28, left: 52 };

const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

/**
 * Rounded "nice" ceiling plus the gridline count that keeps every tick round.
 *
 * The division count has to come from the same choice as the ceiling: a fixed
 * four gridlines under a $5 max puts ticks at $1.25/$2.50/$3.75, which the
 * compact money format renders "$1 $3 $4" — unevenly spaced labels that read as
 * a rounding bug rather than as a scale. Five divisions on the 5 and 10 steps,
 * four on the 1 and 2 steps, leaves every tick exact.
 */
function niceScale(value: number): { max: number; divisions: number } {
  if (value <= 0) return { max: 1, divisions: 4 };
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const [step, divisions] =
    normalized <= 1
      ? [1, 4]
      : normalized <= 2
        ? [2, 4]
        : normalized <= 5
          ? [5, 5]
          : [10, 5];
  return { max: step * magnitude, divisions };
}

/**
 * Running totals across the range shown.
 *
 * Deliberately scoped to the selected window rather than to all time: the stat
 * tiles and breakdown tables report that same window, so a curve carrying an
 * off-screen opening balance would end at a number nothing else on the page
 * agrees with. Summing micro-USD integers keeps the last point exactly equal to
 * the totals tile.
 */
function accumulate(points: UsageDayPoint[]): UsageDayPoint[] {
  let costMicroUsd = 0;
  let callCount = 0;
  return points.map((point) => {
    costMicroUsd += point.costMicroUsd;
    callCount += point.callCount;
    return { period: point.period, costMicroUsd, callCount };
  });
}

export function UsageCostChart({
  points,
  mode = "daily",
}: {
  points: UsageDayPoint[];
  mode?: UsageCostChartMode;
}) {
  const gradientId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const series = useMemo(
    () => (mode === "cumulative" ? accumulate(points) : points),
    [points, mode],
  );

  const { max, divisions } = useMemo(
    () => niceScale(Math.max(...series.map((p) => p.costMicroUsd), 0)),
    [series],
  );

  const geometry = useMemo(() => {
    if (series.length === 0) return null;
    const x = (i: number) =>
      series.length === 1
        ? PAD.left + PLOT_W / 2
        : PAD.left + (i / (series.length - 1)) * PLOT_W;
    const y = (v: number) => PAD.top + PLOT_H - (v / max) * PLOT_H;

    const line = series
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.costMicroUsd)}`)
      .join(" ");
    const area =
      `${line} L${x(series.length - 1)},${PAD.top + PLOT_H}` +
      ` L${x(0)},${PAD.top + PLOT_H} Z`;
    return { x, y, line, area };
  }, [series, max]);

  if (series.length === 0 || !geometry) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-lg border border-border text-sm text-muted-foreground">
        No usage recorded in this range.
      </div>
    );
  }

  const stroke = mode === "cumulative" ? "var(--series-2)" : "var(--series-1)";
  const hovered = hoverIndex === null ? null : series[hoverIndex];
  // Show at most ~6 x labels so they never collide at half width.
  const labelEvery = Math.max(1, Math.ceil(series.length / 6));
  const measure = mode === "cumulative" ? "Cumulative" : "Daily";
  const axisLabel =
    `${measure} AI cost from ${formatPeriod(series[0]!.period)}` +
    ` to ${formatPeriod(series[series.length - 1]!.period)}`;

  return (
    <div className="usage-chart relative">
      <style>{`
        .usage-chart { --series-1: #2a78d6; --series-2: #eb6834; }
        @media (prefers-color-scheme: dark) {
          :root:where(:not([data-theme="light"])) .usage-chart { --series-1: #3987e5; --series-2: #d95926; }
        }
        :root[data-theme="dark"] .usage-chart { --series-1: #3987e5; --series-2: #d95926; }
        .dark .usage-chart { --series-1: #3987e5; --series-2: #d95926; }
      `}</style>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        aria-label={axisLabel}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Recessive gridlines and axis labels — chrome, not data. */}
        {Array.from({ length: divisions + 1 }, (_, i) => i / divisions).map((t) => {
          const y = PAD.top + PLOT_H - t * PLOT_H;
          return (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeWidth="1"
                className="text-border"
              />
              <text
                x={PAD.left - 8}
                y={y + 4}
                textAnchor="end"
                className="fill-muted-foreground text-[11px]"
              >
                {formatUsdCompact(max * t)}
              </text>
            </g>
          );
        })}

        <path d={geometry.area} fill={`url(#${gradientId})`} />
        {/* 2px line, per the mark spec. */}
        <path
          d={geometry.line}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {series.map((point, i) => (
          <text
            key={`x-${point.period}`}
            x={geometry.x(i)}
            y={HEIGHT - 8}
            textAnchor="middle"
            className="fill-muted-foreground text-[11px]"
          >
            {i % labelEvery === 0 ? formatPeriod(point.period) : ""}
          </text>
        ))}

        {/* Crosshair + marker on hover. */}
        {hoverIndex !== null && hovered && (
          <g pointerEvents="none">
            <line
              x1={geometry.x(hoverIndex)}
              x2={geometry.x(hoverIndex)}
              y1={PAD.top}
              y2={PAD.top + PLOT_H}
              stroke="currentColor"
              strokeWidth="1"
              className="text-muted-foreground"
            />
            {/* 2px surface ring so the marker reads against the line. */}
            <circle
              cx={geometry.x(hoverIndex)}
              cy={geometry.y(hovered.costMicroUsd)}
              r="5"
              fill={stroke}
              stroke="var(--card)"
              strokeWidth="2"
            />
          </g>
        )}

        {/* Hit targets wider than the marks. */}
        {series.map((point, i) => (
          <rect
            key={`hit-${point.period}`}
            x={geometry.x(i) - PLOT_W / (2 * Math.max(series.length - 1, 1))}
            y={PAD.top}
            width={Math.max(PLOT_W / Math.max(series.length - 1, 1), 12)}
            height={PLOT_H}
            fill="transparent"
            onMouseEnter={() => setHoverIndex(i)}
          />
        ))}
      </svg>

      {hovered && (
        <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-sm">
          <div className="font-medium">
            {mode === "cumulative" ? `Through ${formatPeriod(hovered.period)}` : formatPeriod(hovered.period)}
          </div>
          <div className="text-muted-foreground">
            {formatUsd(hovered.costMicroUsd)} ·{" "}
            {hovered.callCount.toLocaleString("en-US")} calls
          </div>
        </div>
      )}
    </div>
  );
}
