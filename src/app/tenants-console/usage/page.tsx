"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { UsageBreakdownTable } from "@/features/tenants-console/usage-breakdown-table";
import { UsageCostChart } from "@/features/tenants-console/usage-cost-chart";
import {
  resolveUsageRange,
  utcRangeEndingToday,
} from "@/features/tenants-console/usage-format";
import {
  UsageCaveats,
  UsageFilters,
  UsageLedgerNote,
  UsageStatTiles,
  rangePreset,
  toBreakdownRow,
  type DeploymentFilter,
  type RangeKey,
} from "@/features/tenants-console/usage-shared";

export default function UsageOverviewPage() {
  const [range, setRange] = useState<RangeKey>("30d");
  const [custom, setCustom] = useState(() => utcRangeEndingToday(30));
  // Prod by default — dev usage is real but should never quietly inflate the
  // production picture.
  const [deployment, setDeployment] = useState<DeploymentFilter>("prod");

  const availability = useQuery(api.aiUsage.usageDataRange, {});

  const { from, to } = useMemo(
    () => resolveUsageRange(rangePreset(range), custom, availability ?? null),
    [range, custom, availability],
  );

  const data = useQuery(api.aiUsage.usageOverview, {
    from,
    to,
    ...(deployment === "all" ? {} : { deployment }),
  });

  if (data === undefined || availability === undefined) {
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
          custom={custom}
          onCustomChange={setCustom}
          availability={availability}
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
        rows={data.byTenant.map((row) => {
          const clerkOrgId = row.clerkOrgId as string;
          const name = row.tenantName as string | undefined;
          return toBreakdownRow(row, name ?? clerkOrgId, {
            // An unresolvable name is itself information: the tenant was
            // deleted, or the row came from a deployment on a different Clerk
            // instance. Say so instead of showing a bare id.
            sublabel: name ? clerkOrgId : `${clerkOrgId} · not in tenant registry`,
            href: `/usage/${clerkOrgId}`,
          });
        })}
      />

      <UsageBreakdownTable
        title="By action"
        description="Which pipeline stage the spend went to."
        labelHeader="Operation"
        totalCostMicroUsd={data.totals.costMicroUsd}
        rows={data.byOperation.map((row) =>
          // No deployment column here: an operation runs on both deployments by
          // definition, so the column would read "prod dev" on every row.
          toBreakdownRow({ ...row, deployments: undefined }, row.operation as string),
        )}
      />

      <UsageBreakdownTable
        title="By model"
        description="Provider and model actually billed."
        labelHeader="Model"
        totalCostMicroUsd={data.totals.costMicroUsd}
        rows={data.byModel.map((row) =>
          toBreakdownRow({ ...row, deployments: undefined }, row.model as string, {
            sublabel: row.provider as string,
          }),
        )}
      />

      <UsageLedgerNote />
    </div>
  );
}
