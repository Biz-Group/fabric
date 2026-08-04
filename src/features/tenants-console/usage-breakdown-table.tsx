"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatCount,
  formatShare,
  formatTokens,
  formatUsd,
} from "./usage-format";

/**
 * Ranked magnitude, as a table with an in-row bar.
 *
 * This IS the bar chart for these breakdowns — ranked magnitude with long
 * categorical labels reads better as rows than as a rotated-label bar chart, and
 * it doubles as the table view that keeps the page readable without colour.
 * The bar is one hue (sequential/magnitude), never a per-row colour: rank is not
 * identity, so colouring by position would be the classic mistake.
 */

export type BreakdownRow = {
  key: string;
  label: string;
  sublabel?: string;
  href?: string;
  costMicroUsd: number;
  callCount: number;
  failedCount: number;
  unpricedCount: number;
  synthesisTokens: number;
  agentTokens: number;
  /**
   * Which deployments contributed. A row can span both when the filter is
   * "prod + dev", so this is a list rather than a single value.
   */
  deployments?: string[];
};

/** Renders as text, not colour alone — a badge with a word in it. */
function DeploymentCell({ deployments }: { deployments: string[] }) {
  if (deployments.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {deployments.map((deployment) => (
        <Badge
          key={deployment}
          variant={deployment === "prod" ? "secondary" : "outline"}
        >
          {deployment}
        </Badge>
      ))}
    </div>
  );
}

export function UsageBreakdownTable({
  title,
  description,
  rows,
  totalCostMicroUsd,
  labelHeader,
  emptyMessage = "Nothing recorded in this range.",
}: {
  title: string;
  description?: string;
  rows: BreakdownRow[];
  totalCostMicroUsd: number;
  labelHeader: string;
  emptyMessage?: string;
}) {
  const max = Math.max(...rows.map((r) => r.costMicroUsd), 1);
  // Only shown where it carries information — the caller supplies deployments.
  const showDeployment = rows.some((row) => row.deployments !== undefined);

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border px-3 py-6 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      ) : (
        <div className="usage-bars overflow-x-auto rounded-lg border border-border">
          <style>{`
            .usage-bars { --series-1: #2a78d6; }
            @media (prefers-color-scheme: dark) {
              :root:where(:not([data-theme="light"])) .usage-bars { --series-1: #3987e5; }
            }
            :root[data-theme="dark"] .usage-bars { --series-1: #3987e5; }
            .dark .usage-bars { --series-1: #3987e5; }
          `}</style>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{labelHeader}</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="w-[140px]">Share</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">
                  Synthesis tokens
                </TableHead>
                <TableHead className="text-right">Agent LLM tokens</TableHead>
                {showDeployment && (
                  <TableHead className="text-right">Deployment</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell className="max-w-[280px]">
                    <div className="truncate font-medium">
                      {row.href ? (
                        <Link
                          href={row.href}
                          className="underline-offset-4 hover:underline"
                        >
                          {row.label}
                        </Link>
                      ) : (
                        row.label
                      )}
                    </div>
                    {row.sublabel && (
                      <div className="truncate text-xs text-muted-foreground">
                        {row.sublabel}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatUsd(row.costMicroUsd)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {/* 4px rounded data-end, anchored to the baseline. */}
                      <div
                        className="h-2 rounded-[4px]"
                        style={{
                          width: `${Math.max((row.costMicroUsd / max) * 100, 1.5)}%`,
                          background: "var(--series-1)",
                        }}
                      />
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatShare(row.costMicroUsd, totalCostMicroUsd)}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCount(row.callCount)}
                    {/* Status never rides on colour alone — label + count. */}
                    {row.failedCount > 0 && (
                      <span className="ml-1 text-xs text-destructive">
                        ({row.failedCount} failed)
                      </span>
                    )}
                    {row.unpricedCount > 0 && (
                      <span
                        className="ml-1 text-xs text-muted-foreground"
                        title="Model has no rate in the price table, so its cost is missing rather than zero."
                      >
                        ({row.unpricedCount} unpriced)
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatTokens(row.synthesisTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatTokens(row.agentTokens)}
                  </TableCell>
                  {showDeployment && (
                    <TableCell className="text-right">
                      <DeploymentCell deployments={row.deployments ?? []} />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
