"use client";

import { useId, useMemo, useState } from "react";
import { formatPeriod, formatUsd, formatUsdCompact } from "./usage-format";

/**
 * Daily cost over time.
 *
 * Form: change-over-time on a single measure → a line with a soft area fill.
 * Deliberately ONE series and ONE y-axis: cost and token counts are different
 * scales, so tokens live in their own tiles and tables rather than a second axis.
 * A single series needs no legend — the heading names it.
 *
 * Colour: categorical slot 1 (blue), validated against both the light and dark
 * chart surfaces (lightness band, chroma floor, 3:1 contrast). Text stays on ink
 * tokens throughout; the mark alone carries identity.
 */

export type UsageDayPoint = {
  period: string;
  costMicroUsd: number;
  callCount: number;
};

const WIDTH = 900;
const HEIGHT = 220;
const PAD = { top: 16, right: 16, bottom: 28, left: 56 };

const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

/** Rounded "nice" ceiling so gridline labels are readable numbers. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

export function UsageCostChart({ points }: { points: UsageDayPoint[] }) {
  const gradientId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const max = useMemo(
    () => niceMax(Math.max(...points.map((p) => p.costMicroUsd), 0)),
    [points],
  );

  const geometry = useMemo(() => {
    if (points.length === 0) return null;
    const x = (i: number) =>
      points.length === 1
        ? PAD.left + PLOT_W / 2
        : PAD.left + (i / (points.length - 1)) * PLOT_W;
    const y = (v: number) => PAD.top + PLOT_H - (v / max) * PLOT_H;

    const line = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.costMicroUsd)}`)
      .join(" ");
    const area =
      `${line} L${x(points.length - 1)},${PAD.top + PLOT_H}` +
      ` L${x(0)},${PAD.top + PLOT_H} Z`;
    return { x, y, line, area };
  }, [points, max]);

  if (points.length === 0 || !geometry) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-lg border border-border text-sm text-muted-foreground">
        No usage recorded in this range.
      </div>
    );
  }

  const hovered = hoverIndex === null ? null : points[hoverIndex];
  // Show at most ~8 x labels so they never collide.
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));

  return (
    <div className="usage-chart relative">
      <style>{`
        .usage-chart { --series-1: #2a78d6; }
        @media (prefers-color-scheme: dark) {
          :root:where(:not([data-theme="light"])) .usage-chart { --series-1: #3987e5; }
        }
        :root[data-theme="dark"] .usage-chart { --series-1: #3987e5; }
        .dark .usage-chart { --series-1: #3987e5; }
      `}</style>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        aria-label={`Daily AI cost from ${formatPeriod(points[0]!.period)} to ${formatPeriod(points[points.length - 1]!.period)}`}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--series-1)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--series-1)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Recessive gridlines and axis labels — chrome, not data. */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
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
          stroke="var(--series-1)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {points.map((point, i) => (
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
              fill="var(--series-1)"
              stroke="var(--card)"
              strokeWidth="2"
            />
          </g>
        )}

        {/* Hit targets wider than the marks. */}
        {points.map((point, i) => (
          <rect
            key={`hit-${point.period}`}
            x={geometry.x(i) - PLOT_W / (2 * Math.max(points.length - 1, 1))}
            y={PAD.top}
            width={Math.max(PLOT_W / Math.max(points.length - 1, 1), 12)}
            height={PLOT_H}
            fill="transparent"
            onMouseEnter={() => setHoverIndex(i)}
          />
        ))}
      </svg>

      {hovered && (
        <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-sm">
          <div className="font-medium">{formatPeriod(hovered.period)}</div>
          <div className="text-muted-foreground">
            {formatUsd(hovered.costMicroUsd)} ·{" "}
            {hovered.callCount.toLocaleString("en-US")} calls
          </div>
        </div>
      )}
    </div>
  );
}
