"use client";

import type { FunctionReturnType } from "convex/server";
import { AlertTriangle, Info } from "lucide-react";
import type { api } from "../../../convex/_generated/api";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  formatCount,
  formatDuration,
  formatTokens,
  formatUsd,
  type DataAvailability,
  type UsageRange,
} from "./usage-format";
import type { BreakdownRow } from "./usage-breakdown-table";

export type DeploymentFilter = "prod" | "dev" | "all";
export type RangeKey = "7d" | "30d" | "60d" | "90d" | "custom";

export const RANGE_DAYS: Record<Exclude<RangeKey, "custom">, number> = {
  "7d": 7,
  "30d": 30,
  "60d": 60,
  "90d": 90,
};

/** The `preset` argument `resolveUsageRange` expects. */
export function rangePreset(range: RangeKey): number | "custom" {
  return range === "custom" ? "custom" : RANGE_DAYS[range];
}

/**
 * Derived from the query's return type rather than restated.
 *
 * It was declared by hand here and again in `convex/aiUsage.ts`, which meant
 * adding a totals field silently left the UI's copy stale. Deriving it makes that
 * a compile error instead.
 */
export type UsageTotals = FunctionReturnType<
  typeof api.aiUsage.usageOverview
>["totals"];

/** Maps a summarize-by row from the server onto the breakdown table's shape. */
export function toBreakdownRow(
  row: UsageTotals & { key: string; deployments?: string[] },
  label: string,
  extras: { sublabel?: string; href?: string } = {},
): BreakdownRow {
  return {
    key: row.key,
    label,
    sublabel: extras.sublabel,
    href: extras.href,
    deployments: row.deployments,
    costMicroUsd: row.costMicroUsd,
    callCount: row.callCount,
    failedCount: row.failedCount,
    unpricedCount: row.unpricedCount,
    synthesisTokens: row.synthesisInputTokens + row.synthesisOutputTokens,
    agentTokens: row.agentInputTokens + row.agentOutputTokens,
  };
}

export function UsageFilters({
  range,
  onRangeChange,
  custom,
  onCustomChange,
  availability,
  deployment,
  onDeploymentChange,
}: {
  range: RangeKey;
  onRangeChange: (value: RangeKey) => void;
  custom: UsageRange;
  onCustomChange: (value: UsageRange) => void;
  availability: DataAvailability;
  deployment: DeploymentFilter;
  onDeploymentChange: (value: DeploymentFilter) => void;
}) {
  // Bounds come from the data, so the picker cannot select a window that is
  // guaranteed to be empty.
  const min = availability?.earliest;
  const max = availability?.latest;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={range} onValueChange={(v) => onRangeChange(v as RangeKey)}>
        <SelectTrigger className="w-[150px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="7d">Last 7 days</SelectItem>
          <SelectItem value="30d">Last 30 days</SelectItem>
          <SelectItem value="60d">Last 60 days</SelectItem>
          <SelectItem value="90d">Last 90 days</SelectItem>
          <SelectItem value="custom" disabled={!availability}>
            Custom range
          </SelectItem>
        </SelectContent>
      </Select>

      {range === "custom" && (
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            aria-label="Range start"
            className="w-[150px]"
            value={custom.from}
            min={min}
            max={max}
            onChange={(e) =>
              onCustomChange({ ...custom, from: e.target.value })
            }
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            aria-label="Range end"
            className="w-[150px]"
            value={custom.to}
            min={min}
            max={max}
            onChange={(e) => onCustomChange({ ...custom, to: e.target.value })}
          />
        </div>
      )}

      <Select
        value={deployment}
        onValueChange={(v) => onDeploymentChange(v as DeploymentFilter)}
      >
        <SelectTrigger className="w-[170px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {/* Prod is the default; dev is opt-in so it can't quietly inflate
              production numbers. */}
          <SelectItem value="prod">Production only</SelectItem>
          <SelectItem value="dev">Dev only</SelectItem>
          <SelectItem value="all">Prod + dev</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "warning";
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      {/* Hero number: the tile's whole job is this figure. */}
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && (
        <div
          className={
            tone === "warning"
              ? "mt-1 flex items-center gap-1 text-xs text-muted-foreground"
              : "mt-1 text-xs text-muted-foreground"
          }
        >
          {tone === "warning" && (
            <AlertTriangle className="size-3 shrink-0" aria-hidden />
          )}
          {hint}
        </div>
      )}
    </div>
  );
}

export function UsageStatTiles({ totals }: { totals: UsageTotals }) {
  const discount =
    totals.costMicroUsd - totals.providerReportedCostMicroUsd;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        label="Cost (list rate)"
        value={formatUsd(totals.costMicroUsd)}
        hint={
          discount > 0
            ? `${formatUsd(totals.providerReportedCostMicroUsd)} actually billed — the difference is plan allowance`
            : "At list rate, so tenants stay comparable"
        }
      />
      <Tile
        label="Calls"
        value={formatCount(totals.callCount)}
        hint={
          totals.failedCount > 0 || totals.truncatedCount > 0
            ? `${formatCount(totals.failedCount)} failed · ${formatCount(totals.truncatedCount)} truncated`
            : "All succeeded"
        }
        tone={totals.failedCount > 0 ? "warning" : "default"}
      />
      <Tile
        label="Synthesis tokens"
        value={formatTokens(
          totals.synthesisInputTokens + totals.synthesisOutputTokens,
        )}
        hint={`${formatTokens(totals.synthesisInputTokens)} in · ${formatTokens(totals.synthesisOutputTokens)} out`}
      />
      {/* Kept separate from synthesis on purpose: a different provider's model on
          a different bill. Blending them yields a meaningless number. */}
      <Tile
        label="Agent LLM tokens"
        value={formatTokens(
          totals.agentInputTokens + totals.agentOutputTokens,
        )}
        hint={
          totals.seconds > 0
            ? `${formatDuration(totals.seconds)} of voice/agent time`
            : `${formatTokens(totals.agentInputTokens)} in · ${formatTokens(totals.agentOutputTokens)} out`
        }
      />
    </div>
  );
}

/**
 * Says out loud when the numbers are incomplete. A dashboard that silently
 * under-reports is worse than one that admits a gap.
 */
export function UsageCaveats({
  partial,
  missingPeriods,
  unpricedCount,
}: {
  partial: boolean;
  missingPeriods: string[];
  unpricedCount: number;
}) {
  const notes: string[] = [];
  if (partial) {
    notes.push(
      "This range hit the read cap, so totals are partial. Narrow the range for exact figures.",
    );
  }
  if (missingPeriods.length > 0) {
    notes.push(
      `${missingPeriods.length} day(s) in this range have no rollup yet (${missingPeriods.slice(0, 3).join(", ")}${missingPeriods.length > 3 ? "…" : ""}). Either nothing was recorded, or the daily fold has not run.`,
    );
  }
  if (unpricedCount > 0) {
    notes.push(
      `${unpricedCount} call(s) ran on a model with no rate in the price table — their cost is missing from these totals, not zero.`,
    );
  }

  if (notes.length === 0) return null;

  return (
    <div className="space-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2">
      {notes.map((note) => (
        <div
          key={note}
          className="flex items-start gap-2 text-xs text-muted-foreground"
        >
          <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>{note}</span>
        </div>
      ))}
    </div>
  );
}

/** Ledger start disclosure — there is no historical backfill. */
export function UsageLedgerNote() {
  return (
    <p className="text-xs text-muted-foreground">
      Metering began when the usage ledger shipped; earlier activity was never
      recorded, so these are not lifetime totals.
    </p>
  );
}
