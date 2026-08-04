"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { UsageBreakdownTable } from "@/features/tenants-console/usage-breakdown-table";
import { UsageCostChart } from "@/features/tenants-console/usage-cost-chart";
import { utcRangeEndingToday } from "@/features/tenants-console/usage-format";
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

export default function UsageOverviewPage() {
  const [range, setRange] = useState<RangeKey>("30d");
  // Prod by default — dev usage is real but should never quietly inflate the
  // production picture.
  const [deployment, setDeployment] = useState<DeploymentFilter>("prod");

  const { from, to } = useMemo(
    () => utcRangeEndingToday(RANGE_DAYS[range]),
    [range],
  );

  const data = useQuery(api.aiUsage.usageOverview, {
    from,
    to,
    ...(deployment === "all" ? {} : { deployment }),
  });

  if (data === undefined) {
    return <LoadingScreen message="Loading usage..." />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Usage</h1>
          <p className="text-sm text-muted-foreground">
            AI and voice spend across every tenant, {from} to {to} (UTC).
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
        <div>
          <h2 className="text-sm font-semibold">Daily cost</h2>
          <p className="text-xs text-muted-foreground">
            List-rate cost per UTC day. Today is folded live from the ledger;
            earlier days come from rollups.
          </p>
        </div>
        <UsageCostChart
          points={data.byDay.map((day) => ({
            period: String(day.period),
            costMicroUsd: day.costMicroUsd,
            callCount: day.callCount,
          }))}
        />
      </section>

      <UsageBreakdownTable
        title="By tenant"
        description="Highest spend first. Select a tenant for its per-call log."
        labelHeader="Tenant"
        totalCostMicroUsd={data.totals.costMicroUsd}
        rows={data.byTenant.map((row) =>
          toBreakdownRow(
            row,
            (row.tenantName as string | undefined) ??
              (row.clerkOrgId as string),
            {
              sublabel: row.tenantName
                ? (row.clerkOrgId as string)
                : undefined,
              href: `/usage/${row.clerkOrgId as string}`,
            },
          ),
        )}
      />

      <UsageBreakdownTable
        title="By action"
        description="Which pipeline stage the spend went to."
        labelHeader="Operation"
        totalCostMicroUsd={data.totals.costMicroUsd}
        rows={data.byOperation.map((row) =>
          toBreakdownRow(row, row.operation as string),
        )}
      />

      <UsageBreakdownTable
        title="By model"
        description="Provider and model actually billed."
        labelHeader="Model"
        totalCostMicroUsd={data.totals.costMicroUsd}
        rows={data.byModel.map((row) =>
          toBreakdownRow(row, row.model as string, {
            sublabel: row.provider as string,
          }),
        )}
      />

      <UsageLedgerNote />
    </div>
  );
}
