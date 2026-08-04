"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { usePaginatedQuery, useQuery } from "convex/react";
import { ArrowLeft, Download } from "lucide-react";
import { api } from "../../../../../convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingScreen } from "@/components/ui/loading-screen";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { downloadCsv } from "@/features/admin/conversations-export";
import { UsageBreakdownTable } from "@/features/tenants-console/usage-breakdown-table";
import { UsageCostChart } from "@/features/tenants-console/usage-cost-chart";
import { buildUsageCsv } from "@/features/tenants-console/usage-export";
import {
  formatDuration,
  formatTimestamp,
  formatTokens,
  formatUsd,
  utcRangeEndingToday,
} from "@/features/tenants-console/usage-format";
import {
  RANGE_DAYS,
  UsageCaveats,
  UsageFilters,
  UsageLedgerNote,
  UsageStatTiles,
  toBreakdownRow,
  type DeploymentFilter,
  type RangeKey,
} from "@/features/tenants-console/usage-shared";

const LOG_PAGE_SIZE = 50;

function StatusBadge({ status }: { status: string }) {
  if (status === "ok") return <Badge variant="secondary">OK</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  return <Badge variant="outline">Truncated</Badge>;
}

export default function TenantUsagePage() {
  const params = useParams<{ clerkOrgId: string }>();
  const clerkOrgId = params.clerkOrgId;

  const [range, setRange] = useState<RangeKey>("30d");
  const [deployment, setDeployment] = useState<DeploymentFilter>("prod");

  const { from, to } = useMemo(
    () => utcRangeEndingToday(RANGE_DAYS[range]),
    [range],
  );

  const deploymentArg = deployment === "all" ? {} : { deployment };

  const data = useQuery(api.aiUsage.usageForTenant, {
    clerkOrgId,
    from,
    to,
    ...deploymentArg,
  });

  const log = usePaginatedQuery(
    api.aiUsage.usageLog,
    { clerkOrgId, ...deploymentArg },
    { initialNumItems: LOG_PAGE_SIZE },
  );

  if (data === undefined) {
    return <LoadingScreen message="Loading tenant usage..." />;
  }

  return (
    <div className="space-y-6">
      <Link
        href="/usage"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        All tenants
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            {data.tenantName ?? clerkOrgId}
          </h1>
          <p className="text-sm text-muted-foreground">
            {data.tenantName ? `${clerkOrgId} · ` : ""}
            {from} to {to} (UTC)
          </p>
        </div>
        <UsageFilters
          range={range}
          onRangeChange={setRange}
          deployment={deployment}
          onDeploymentChange={setDeployment}
        />
      </div>

      <UsageCaveats
        partial={data.partial}
        missingPeriods={data.missingPeriods}
        unpricedCount={data.totals.unpricedCount}
      />

      <UsageStatTiles totals={data.totals} />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Daily cost</h2>
        <UsageCostChart
          points={data.byDay.map((day) => ({
            period: String(day.period),
            costMicroUsd: day.costMicroUsd,
            callCount: day.callCount,
          }))}
        />
      </section>

      <UsageBreakdownTable
        title="By action"
        labelHeader="Operation"
        totalCostMicroUsd={data.totals.costMicroUsd}
        rows={data.byOperation.map((row) =>
          toBreakdownRow(row, row.operation as string),
        )}
      />

      <UsageBreakdownTable
        title="By model"
        labelHeader="Model"
        totalCostMicroUsd={data.totals.costMicroUsd}
        rows={data.byModel.map((row) =>
          toBreakdownRow(row, row.model as string, {
            sublabel: row.provider as string,
          }),
        )}
      />

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Call log</h2>
            <p className="text-xs text-muted-foreground">
              Every metered call, newest first. Not limited to the date range
              above.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={log.results.length === 0}
            onClick={() =>
              downloadCsv(
                `usage-${clerkOrgId}-${to}.csv`,
                buildUsageCsv(log.results),
              )
            }
          >
            <Download className="size-3.5" aria-hidden />
            Export loaded rows
          </Button>
        </div>

        {log.results.length === 0 ? (
          <div className="rounded-lg border border-border px-3 py-6 text-center text-sm text-muted-foreground">
            {log.isLoading ? "Loading..." : "No metered calls for this tenant."}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Operation</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">In</TableHead>
                  <TableHead className="text-right">Out</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead>Entity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {log.results.map((row) => (
                  <TableRow key={row._id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatTimestamp(row.createdAt)}
                      {row.deployment === "dev" && (
                        <Badge variant="outline" className="ml-1.5">
                          dev
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">{row.operation}</TableCell>
                    <TableCell className="max-w-[180px] truncate text-xs">
                      {row.model}
                      {/* Says which bill the tokens belong to, so nobody adds
                          agent LLM tokens to synthesis tokens. */}
                      {row.tokenClass === "agent-llm" && (
                        <span className="ml-1 text-muted-foreground">
                          (agent)
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={row.status} />
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {row.inputTokens === undefined
                        ? "—"
                        : formatTokens(row.inputTokens)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {row.outputTokens === undefined
                        ? "—"
                        : formatTokens(row.outputTokens)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {row.seconds === undefined
                        ? "—"
                        : formatDuration(row.seconds)}
                    </TableCell>
                    <TableCell className="text-right text-xs font-medium tabular-nums">
                      {formatUsd(row.costMicroUsd)}
                      {row.priceVersion === "unpriced" && (
                        <span
                          className="ml-1 text-muted-foreground"
                          title="No rate for this model; cost is missing, not zero."
                        >
                          ?
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {row.latencyMs === undefined
                        ? "—"
                        : `${row.latencyMs.toLocaleString("en-US")}ms`}
                    </TableCell>
                    <TableCell className="max-w-[160px] truncate text-xs text-muted-foreground">
                      {row.entityLabel ?? row.entityType ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {log.status === "CanLoadMore" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => log.loadMore(LOG_PAGE_SIZE)}
          >
            Load more
          </Button>
        )}
      </section>

      <UsageLedgerNote />
    </div>
  );
}
