import { paginationOptsValidator } from "convex/server";
import { type Infer, v } from "convex/values";
import {
  env,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { requireSuperAdmin } from "./lib/orgAuth";
import {
  foldUsageRows,
  utcDayBounds,
  utcDayKey,
  type RollableUsageRow,
  type UsageRollupGroup,
} from "./lib/aiUsageRollup";

/**
 * Write side of the AI usage ledger.
 *
 * Reads live in the platform tenant console (super-admin only) — usage data is
 * cross-tenant cost data, so it is deliberately NOT exposed to any
 * tenant-scoped function. See docs/ai-usage-metering-plan.md.
 */

/**
 * Mirrors the `aiUsageEvents` table. Declared once and reused so the ledger
 * mutation and the (Phase 2) cross-deployment ingest endpoint cannot drift
 * apart — a forwarded row must be accepted on exactly the same terms as a
 * locally recorded one.
 */
export const aiUsageEventFields = {
  deployment: v.union(v.literal("prod"), v.literal("dev")),
  idempotencyKey: v.string(),
  // Passed in rather than derived from Date.now(): a forwarded dev row must keep
  // its ORIGINAL timestamp, or it lands in the wrong day's rollup on the sink.
  createdAt: v.number(),

  clerkOrgId: v.string(),
  tenantName: v.optional(v.string()),

  unit: v.union(v.literal("tokens"), v.literal("seconds")),
  operation: v.string(),
  provider: v.string(),
  model: v.string(),
  providerDeployment: v.optional(v.string()),
  status: v.union(
    v.literal("ok"),
    v.literal("truncated"),
    v.literal("failed"),
  ),

  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  cachedReadTokens: v.optional(v.number()),
  cacheWriteTokens: v.optional(v.number()),
  seconds: v.optional(v.number()),
  tokenClass: v.optional(
    v.union(v.literal("fabric-synthesis"), v.literal("agent-llm")),
  ),

  costMicroUsd: v.number(),
  priceVersion: v.string(),
  costSource: v.union(v.literal("computed"), v.literal("provider")),
  providerReportedCostMicroUsd: v.optional(v.number()),
  llmCostMicroUsd: v.optional(v.number()),
  callCostMicroUsd: v.optional(v.number()),
  platformCostMicroUsd: v.optional(v.number()),

  entityType: v.optional(v.string()),
  entityId: v.optional(v.string()),
  entityLabel: v.optional(v.string()),
  actorUserId: v.optional(v.string()),
  actorName: v.optional(v.string()),
  runId: v.optional(v.string()),

  latencyMs: v.optional(v.number()),
  finishReason: v.optional(v.string()),
  requestId: v.optional(v.string()),
  errorType: v.optional(v.string()),
} as const;

export const aiUsageEventValidator = v.object(aiUsageEventFields);

/**
 * The shape callers must produce. Derived from the validator so the runtime
 * contract and the compile-time one cannot diverge — `internal` is `anyApi`, so
 * a `runMutation` argument is not otherwise type-checked.
 */
export type AiUsageEvent = Infer<typeof aiUsageEventValidator>;

/**
 * Records one metered call.
 *
 * Upserts on `idempotencyKey` rather than blindly inserting, because two paths
 * legitimately present the same row twice: the Phase 2 dev→prod forwarding
 * retry, and an ElevenLabs conversation re-fetch, which re-reads the same
 * immutable billing metadata. Both must converge on one row.
 */
export const record = internalMutation({
  args: aiUsageEventFields,
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("aiUsageEvents")
      .withIndex("by_idempotencyKey", (q) =>
        q.eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();

    // Prod is the forwarding sink, so a row born there is already at its
    // destination — stamping it here keeps it out of the forwarding sweep
    // instead of relying on the sweep to recognise and skip it.
    const forwardedAt = args.deployment === "prod" ? args.createdAt : undefined;

    if (existing) {
      await ctx.db.patch(existing._id, { ...args, forwardedAt });
      return existing._id;
    }
    return await ctx.db.insert("aiUsageEvents", { ...args, forwardedAt });
  },
});

// ---------------------------------------------------------------------------
// Console reads (platform super-admin only)
//
// History comes from `aiUsageRollups`, which is O(groups) rather than
// O(calls). The current UTC day has no rollup yet, so it is folded live from the
// ledger through the SAME `foldUsageRows` — using a second code path there would
// let today's numbers drift from yesterday's.
// ---------------------------------------------------------------------------

const deploymentFilterValidator = v.optional(
  v.union(v.literal("prod"), v.literal("dev")),
);

/** Caps the history read; a range wider than this reports itself as partial. */
const MAX_ROLLUP_ROWS = 8_000;

/** Caps the live fold of today. */
const MAX_LIVE_ROWS = 4_000;

export type UsageTotals = {
  costMicroUsd: number;
  providerReportedCostMicroUsd: number;
  callCount: number;
  failedCount: number;
  truncatedCount: number;
  unpricedCount: number;
  seconds: number;
  /** Split by tokenClass — never a single blended token total (§4.3). */
  synthesisInputTokens: number;
  synthesisOutputTokens: number;
  synthesisCachedReadTokens: number;
  synthesisCacheWriteTokens: number;
  agentInputTokens: number;
  agentOutputTokens: number;
  agentCachedReadTokens: number;
  agentCacheWriteTokens: number;
};

function emptyUsageTotals(): UsageTotals {
  return {
    costMicroUsd: 0,
    providerReportedCostMicroUsd: 0,
    callCount: 0,
    failedCount: 0,
    truncatedCount: 0,
    unpricedCount: 0,
    seconds: 0,
    synthesisInputTokens: 0,
    synthesisOutputTokens: 0,
    synthesisCachedReadTokens: 0,
    synthesisCacheWriteTokens: 0,
    agentInputTokens: 0,
    agentOutputTokens: 0,
    agentCachedReadTokens: 0,
    agentCacheWriteTokens: 0,
  };
}

type GroupLike = UsageRollupGroup;

function addGroup(totals: UsageTotals, group: GroupLike): void {
  totals.costMicroUsd += group.costMicroUsd;
  totals.providerReportedCostMicroUsd += group.providerReportedCostMicroUsd;
  totals.callCount += group.callCount;
  totals.failedCount += group.failedCount;
  totals.truncatedCount += group.truncatedCount;
  totals.unpricedCount += group.unpricedCount;
  totals.seconds += group.seconds;

  if (group.tokenClass === "agent-llm") {
    totals.agentInputTokens += group.inputTokens;
    totals.agentOutputTokens += group.outputTokens;
    totals.agentCachedReadTokens += group.cachedReadTokens;
    totals.agentCacheWriteTokens += group.cacheWriteTokens;
  } else {
    totals.synthesisInputTokens += group.inputTokens;
    totals.synthesisOutputTokens += group.outputTokens;
    totals.synthesisCachedReadTokens += group.cachedReadTokens;
    totals.synthesisCacheWriteTokens += group.cacheWriteTokens;
  }
}

/** Every UTC day in an inclusive `YYYY-MM-DD` range. */
function periodsBetween(from: string, to: string): string[] {
  const days: string[] = [];
  let cursor = utcDayBounds(from).start;
  const last = utcDayBounds(to).start;
  while (cursor <= last && days.length <= 400) {
    days.push(utcDayKey(cursor));
    cursor += 24 * 60 * 60 * 1000;
  }
  return days;
}

/**
 * Collects the groups covering a range: rollups for closed days, a live fold for
 * today. Also reports which requested days have neither — a stalled fold then
 * shows up as a visible gap instead of a quietly low total.
 */
async function collectUsageGroups(
  ctx: QueryCtx,
  args: { from: string; to: string; deployment?: "prod" | "dev"; clerkOrgId?: string },
): Promise<{
  groups: UsageRollupGroup[];
  missingPeriods: string[];
  partial: boolean;
}> {
  const today = utcDayKey(Date.now());
  let partial = false;

  const rollupRows = args.clerkOrgId
    ? await ctx.db
        .query("aiUsageRollups")
        .withIndex("by_clerkOrgId_and_period", (q) =>
          q
            .eq("clerkOrgId", args.clerkOrgId!)
            .gte("period", args.from)
            .lte("period", args.to),
        )
        .take(MAX_ROLLUP_ROWS)
    : await ctx.db
        .query("aiUsageRollups")
        .withIndex("by_period", (q) =>
          q.gte("period", args.from).lte("period", args.to),
        )
        .take(MAX_ROLLUP_ROWS);

  if (rollupRows.length === MAX_ROLLUP_ROWS) partial = true;

  const groups: UsageRollupGroup[] = rollupRows
    .filter((row) => !args.deployment || row.deployment === args.deployment)
    .map((row) => ({
      period: row.period,
      deployment: row.deployment,
      clerkOrgId: row.clerkOrgId,
      tenantName: row.tenantName,
      operation: row.operation,
      provider: row.provider,
      model: row.model,
      tokenClass: row.tokenClass,
      callCount: row.callCount,
      failedCount: row.failedCount,
      truncatedCount: row.truncatedCount,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedReadTokens: row.cachedReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      seconds: row.seconds,
      costMicroUsd: row.costMicroUsd,
      providerReportedCostMicroUsd: row.providerReportedCostMicroUsd,
      unpricedCount: row.unpricedCount,
    }));

  // Today, folded live.
  if (args.from <= today && today <= args.to) {
    const { start, end } = utcDayBounds(today);
    const live = await ctx.db
      .query("aiUsageEvents")
      .withIndex("by_createdAt", (q) =>
        q.gte("createdAt", start).lt("createdAt", end),
      )
      .take(MAX_LIVE_ROWS);
    if (live.length === MAX_LIVE_ROWS) partial = true;

    const scoped = live.filter(
      (row) =>
        (!args.deployment || row.deployment === args.deployment) &&
        (!args.clerkOrgId || row.clerkOrgId === args.clerkOrgId),
    );
    groups.push(...foldUsageRows(today, scoped));
  }

  const covered = new Set(groups.map((group) => group.period));
  const missingPeriods = periodsBetween(args.from, args.to).filter(
    // Days with no usage at all are indistinguishable from un-rolled-up days
    // here; only days after the newest rollup are genuinely suspect.
    (period) => period !== today && !covered.has(period),
  );

  return { groups, missingPeriods, partial };
}

/**
 * Resolves tenant display names for a set of org ids.
 *
 * A read-time join rather than a value stamped onto every ledger row: it costs
 * nothing on the AI call path, and a renamed tenant is reflected immediately
 * instead of leaving old rows labelled with a stale name.
 *
 * One lookup per DISTINCT org in the result, not per row — the callers pass an
 * already-grouped id list.
 *
 * Forwarded dev rows are the case this cannot serve: their `clerkOrgId` may
 * belong to a different Clerk instance and have no local `tenants` row, which is
 * exactly what the denormalized `tenantName` on the event is for. Callers fall
 * back to it.
 */
async function resolveTenantNames(
  ctx: QueryCtx,
  clerkOrgIds: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const clerkOrgId of new Set(clerkOrgIds)) {
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", clerkOrgId))
      .unique();
    if (tenant) names.set(clerkOrgId, tenant.name);
  }
  return names;
}

type SummarizedRow = { key: string } & Record<string, unknown> & UsageTotals;

function summarizeBy(
  groups: readonly UsageRollupGroup[],
  key: (group: UsageRollupGroup) => string,
  label: (group: UsageRollupGroup) => Record<string, string | undefined>,
): Array<SummarizedRow & { deployments: string[] }> {
  const map = new Map<
    string,
    { entry: SummarizedRow; deployments: Set<string> }
  >();
  for (const group of groups) {
    const id = key(group);
    let bucket = map.get(id);
    if (!bucket) {
      bucket = {
        entry: { key: id, ...label(group), ...emptyUsageTotals() },
        deployments: new Set<string>(),
      };
      map.set(id, bucket);
    }
    // Which deployments a row spans is a property of the group, not of any one
    // row, so it has to be collected here rather than read off a sample.
    bucket.deployments.add(group.deployment);
    addGroup(bucket.entry, group);
  }
  return [...map.values()]
    .map(({ entry, deployments }) => ({
      ...entry,
      deployments: [...deployments].sort(),
    }))
    .sort((a, b) => b.costMicroUsd - a.costMicroUsd);
}

/**
 * The UTC days for which any usage exists, for bounding the range picker.
 *
 * Checks both tables because they cover different windows: rollups hold closed
 * days (and outlive the ledger's 180-day retention), the ledger holds today and
 * anything not yet folded. Four indexed `.first()` reads, no scan.
 */
export const usageDataRange = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ earliest: string; latest: string } | null> => {
    await requireSuperAdmin(ctx);

    const [firstRollup, lastRollup, firstEvent, lastEvent] = await Promise.all([
      ctx.db.query("aiUsageRollups").withIndex("by_period").order("asc").first(),
      ctx.db.query("aiUsageRollups").withIndex("by_period").order("desc").first(),
      ctx.db.query("aiUsageEvents").withIndex("by_createdAt").order("asc").first(),
      ctx.db.query("aiUsageEvents").withIndex("by_createdAt").order("desc").first(),
    ]);

    const candidates = [
      firstRollup?.period,
      lastRollup?.period,
      firstEvent ? utcDayKey(firstEvent.createdAt) : undefined,
      lastEvent ? utcDayKey(lastEvent.createdAt) : undefined,
    ].filter((period): period is string => period !== undefined);

    if (candidates.length === 0) return null;
    // `YYYY-MM-DD` sorts lexicographically, so string compare is date compare.
    candidates.sort();
    return {
      earliest: candidates[0]!,
      latest: candidates[candidates.length - 1]!,
    };
  },
});

/** Platform-wide usage for a date range. */
export const usageOverview = query({
  args: {
    from: v.string(),
    to: v.string(),
    deployment: deploymentFilterValidator,
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const { groups, missingPeriods, partial } = await collectUsageGroups(
      ctx,
      args,
    );

    const totals = emptyUsageTotals();
    for (const group of groups) addGroup(totals, group);

    // Ascending by day for the time series.
    const byDay = summarizeBy(
      groups,
      (g) => g.period,
      (g) => ({ period: g.period }),
    ).sort((a, b) => String(a.key).localeCompare(String(b.key)));

    const byTenant = summarizeBy(
      groups,
      (g) => g.clerkOrgId,
      (g) => ({ clerkOrgId: g.clerkOrgId, tenantName: g.tenantName }),
    );
    // Live name wins; the row's stored name covers forwarded dev tenants that
    // have no local `tenants` row; the org id is the last resort.
    const tenantNames = await resolveTenantNames(
      ctx,
      byTenant.map((row) => row.clerkOrgId as string),
    );
    for (const row of byTenant) {
      row.tenantName =
        tenantNames.get(row.clerkOrgId as string) ?? row.tenantName;
    }

    return {
      totals,
      byDay,
      byTenant,
      byOperation: summarizeBy(
        groups,
        (g) => g.operation,
        (g) => ({ operation: g.operation }),
      ),
      byModel: summarizeBy(
        groups,
        (g) => `${g.provider}:${g.model}`,
        (g) => ({ provider: g.provider, model: g.model }),
      ),
      missingPeriods,
      partial,
    };
  },
});

/** The same shape, scoped to one tenant. */
export const usageForTenant = query({
  args: {
    clerkOrgId: v.string(),
    from: v.string(),
    to: v.string(),
    deployment: deploymentFilterValidator,
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const { groups, missingPeriods, partial } = await collectUsageGroups(
      ctx,
      args,
    );

    const totals = emptyUsageTotals();
    for (const group of groups) addGroup(totals, group);

    const liveName = (
      await resolveTenantNames(ctx, [args.clerkOrgId])
    ).get(args.clerkOrgId);

    return {
      totals,
      tenantName: liveName ?? groups.find((g) => g.tenantName)?.tenantName,
      byDay: summarizeBy(
        groups,
        (g) => g.period,
        (g) => ({ period: g.period }),
      ).sort((a, b) => String(a.key).localeCompare(String(b.key))),
      byOperation: summarizeBy(
        groups,
        (g) => g.operation,
        (g) => ({ operation: g.operation }),
      ),
      byModel: summarizeBy(
        groups,
        (g) => `${g.provider}:${g.model}`,
        (g) => ({ provider: g.provider, model: g.model }),
      ),
      missingPeriods,
      partial,
    };
  },
});

/** Paginated raw ledger, newest first — the per-call log. */
export const usageLog = query({
  args: {
    clerkOrgId: v.optional(v.string()),
    deployment: deploymentFilterValidator,
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const base = args.clerkOrgId
      ? ctx.db
          .query("aiUsageEvents")
          .withIndex("by_clerkOrgId_and_createdAt", (q) =>
            q.eq("clerkOrgId", args.clerkOrgId!),
          )
      : ctx.db.query("aiUsageEvents").withIndex("by_createdAt");

    const page = await base.order("desc").paginate(args.paginationOpts);
    if (!args.deployment) return page;
    return {
      ...page,
      page: page.page.filter((row) => row.deployment === args.deployment),
    };
  },
});

// ---------------------------------------------------------------------------
// Cross-deployment forwarding (dev → prod)
//
// Convex dev and prod are separate deployments with separate databases, so a
// merged console view needs an explicit bridge. Each deployment writes its own
// rows locally (staying self-sufficient and debuggable); dev additionally
// forwards them to prod, which is the sink.
//
// Forwarding is a cron sweep rather than an inline call: putting a network
// request to another deployment on the AI pipeline's critical path is the exact
// failure mode docs/pipeline-reliability-and-scale-plan.md exists to prevent.
// ---------------------------------------------------------------------------

/** Rows per sweep. Bounds both the outbound request and the mutation's writes. */
const FORWARD_BATCH_SIZE = 100;

/** Attempts past which a row is logged as an error every sweep. */
const FORWARD_ATTEMPT_ALARM = 5;

/**
 * Host + path of the sink, safe to log. The secret is sent as a header and never
 * appears here; a URL could still carry a query string, so it is dropped.
 */
function sinkHostAndPath(sinkUrl: string): string {
  try {
    const url = new URL(sinkUrl);
    return `${url.host}${url.pathname}`;
  } catch {
    return "<unparseable USAGE_SINK_URL>";
  }
}

/**
 * Projects a stored row down to exactly the fields the sink accepts.
 *
 * Derived from `aiUsageEventFields` rather than by destructuring away the
 * known extras (`_id`, `forwardedAt`, ...): an allowlist cannot leak a
 * bookkeeping field added later, whereas a denylist silently would.
 */
function toForwardableEvent(row: Doc<"aiUsageEvents">): AiUsageEvent {
  const source = row as unknown as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(aiUsageEventFields)) {
    const value = source[key];
    // Omit rather than send explicit undefined — Convex validators reject it
    // for an optional field.
    if (value !== undefined) projected[key] = value;
  }
  return projected as unknown as AiUsageEvent;
}

export const listUnforwarded = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("aiUsageEvents")
      .withIndex("by_forwardedAt", (q) => q.eq("forwardedAt", undefined))
      .take(Math.min(args.limit ?? FORWARD_BATCH_SIZE, FORWARD_BATCH_SIZE));
  },
});

export const tenantNamesForOrgs = internalQuery({
  args: { clerkOrgIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<Record<string, string>> => {
    const names = await resolveTenantNames(ctx, args.clerkOrgIds);
    return Object.fromEntries(names);
  },
});

export const markForwarded = internalMutation({
  args: { ids: v.array(v.id("aiUsageEvents")), forwardedAt: v.number() },
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      await ctx.db.patch(id, { forwardedAt: args.forwardedAt });
    }
  },
});

export const recordForwardFailure = internalMutation({
  args: { ids: v.array(v.id("aiUsageEvents")) },
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      const row = await ctx.db.get(id);
      if (!row) continue;
      await ctx.db.patch(id, {
        forwardAttempts: (row.forwardAttempts ?? 0) + 1,
      });
    }
  },
});

/**
 * Sweeps unforwarded rows to the sink deployment.
 *
 * Failures are retried indefinitely, deliberately. A persistently failing sink
 * means unforwarded rows accumulate — which is the correct signal ("go fix the
 * sink") rather than silently abandoning billing data. The batch is bounded, so
 * a broken sink costs one small request per sweep and nothing else.
 */
export const forwardPendingUsage = internalAction({
  args: {},
  handler: async (ctx): Promise<{ forwarded: number; pending: number }> => {
    const sinkUrl = env.USAGE_SINK_URL?.trim();
    const sinkSecret = env.USAGE_SINK_SECRET?.trim();
    // Unset on the sink deployment itself — nothing to forward, not an error.
    if (!sinkUrl || !sinkSecret) return { forwarded: 0, pending: 0 };

    const rows = await ctx.runQuery(internal.aiUsage.listUnforwarded, {});
    if (rows.length === 0) return { forwarded: 0, pending: 0 };

    const stuck = rows.filter(
      (row) => (row.forwardAttempts ?? 0) >= FORWARD_ATTEMPT_ALARM,
    );
    if (stuck.length > 0) {
      console.error("AI usage rows repeatedly failing to forward", {
        count: stuck.length,
        oldestCreatedAt: stuck[0]?.createdAt,
        attempts: stuck[0]?.forwardAttempts,
        sink: sinkHostAndPath(sinkUrl),
        // The rejection logged immediately after this says why.
        hint: "See the sink response logged below for the cause.",
      });
    }

    // Stamp the tenant name on the way out. The sink cannot resolve it: a dev
    // `clerkOrgId` may belong to a different Clerk instance and have no row in
    // prod's `tenants` table, so without this the merged console can only show
    // dev tenants as raw org ids.
    const localNames: Record<string, string> = await ctx.runQuery(
      internal.aiUsage.tenantNamesForOrgs,
      { clerkOrgIds: [...new Set(rows.map((row) => row.clerkOrgId))] },
    );
    const events = rows.map((row) => {
      const event = toForwardableEvent(row);
      const name = event.tenantName ?? localNames[row.clerkOrgId];
      return name === undefined ? event : { ...event, tenantName: name };
    });

    let response: Response;
    try {
      response = await fetch(sinkUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sinkSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events }),
      });
    } catch (error) {
      await ctx.runMutation(internal.aiUsage.recordForwardFailure, {
        ids: rows.map((row) => row._id),
      });
      console.error("AI usage forwarding request failed", {
        count: rows.length,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return { forwarded: 0, pending: rows.length };
    }

    if (!response.ok) {
      // Read the body: it is what distinguishes the failure modes, and each one
      // has a different fix.
      const detail = await response.text().catch(() => "");
      await ctx.runMutation(internal.aiUsage.recordForwardFailure, {
        ids: rows.map((row) => row._id),
      });

      const diagnosis =
        response.status === 503
          ? "The sink deployment is reachable but has no USAGE_SINK_SECRET set."
          : response.status === 404
            ? "Nothing is serving this path. Check USAGE_SINK_URL against the " +
              "sink's 'HTTP Actions URL' in its dashboard: it must be " +
              ".convex.site (not .convex.cloud) AND must include the region " +
              "segment for a regionalized deployment (e.g. " +
              "<deployment>.eu-west-1.convex.site). A missing region resolves " +
              "to a different host that returns a bare 404."
            : response.status === 401
              ? "USAGE_SINK_SECRET does not match the sink's."
              : "Unexpected sink response.";

      console.error("AI usage sink rejected a batch", {
        status: response.status,
        count: rows.length,
        // Host and path only — the secret travels in a header and is never logged.
        sink: sinkHostAndPath(sinkUrl),
        detail: detail.slice(0, 200),
        diagnosis,
      });
      return { forwarded: 0, pending: rows.length };
    }
    // A 2xx is NOT sufficient: `ingestBatch` returns {accepted, rejected} and
    // rejects rows whose deployment matches the sink's own label — which is what
    // happens if USAGE_SINK_URL points at this deployment. Marking those
    // forwarded would silently discard billing rows while reporting success, so
    // the batch is only cleared when the sink accepted all of it.
    const body: unknown = await response.json().catch(() => null);
    const rejected =
      typeof (body as { rejected?: unknown })?.rejected === "number"
        ? (body as { rejected: number }).rejected
        : 0;

    if (rejected > 0) {
      await ctx.runMutation(internal.aiUsage.recordForwardFailure, {
        ids: rows.map((row) => row._id),
      });
      console.error("AI usage sink accepted the request but rejected rows", {
        rejected,
        count: rows.length,
        sink: sinkHostAndPath(sinkUrl),
        diagnosis:
          "The sink rejected rows labelled with its own deployment. " +
          "USAGE_SINK_URL is almost certainly pointing at this deployment " +
          "instead of the other one.",
      });
      return { forwarded: 0, pending: rows.length };
    }

    await ctx.runMutation(internal.aiUsage.markForwarded, {
      ids: rows.map((row) => row._id),
      forwardedAt: Date.now(),
    });
    return { forwarded: rows.length, pending: 0 };
  },
});

/**
 * Sink-side batch insert, called by the HTTP ingest route.
 *
 * Every row goes through the same `record` upsert as a local write, so a
 * forwarding retry converges instead of double-counting. Rows whose
 * `deployment` equals this deployment's own label are rejected, which makes a
 * self-ingest loop impossible rather than merely unlikely.
 */
export const ingestBatch = internalMutation({
  args: {
    events: v.array(aiUsageEventValidator),
    localDeployment: v.union(v.literal("prod"), v.literal("dev")),
    /**
     * Validates auth, routing and every row's shape, then writes nothing.
     *
     * Exists because diagnosing this endpoint otherwise means POSTing real rows
     * into a production billing ledger — which is exactly the mistake that
     * prompted it. Convex validates `events` against the validator before the
     * handler runs, so a malformed row still fails here.
     */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ accepted: number; rejected: number; dryRun?: boolean }> => {
    let accepted = 0;
    let rejected = 0;

    for (const event of args.events) {
      if (event.deployment === args.localDeployment) {
        rejected += 1;
        continue;
      }
      if (args.dryRun) {
        accepted += 1;
        continue;
      }
      const existing = await ctx.db
        .query("aiUsageEvents")
        .withIndex("by_idempotencyKey", (q) =>
          q.eq("idempotencyKey", event.idempotencyKey),
        )
        .unique();
      // Forwarded rows arrive at their destination, so they are not queued again.
      const row = { ...event, forwardedAt: event.createdAt };
      if (existing) {
        await ctx.db.patch(existing._id, row);
      } else {
        await ctx.db.insert("aiUsageEvents", row);
      }
      accepted += 1;
    }

    if (rejected > 0) {
      console.error("AI usage ingest rejected self-labelled rows", {
        rejected,
        localDeployment: args.localDeployment,
      });
    }
    return args.dryRun
      ? { accepted, rejected, dryRun: true }
      : { accepted, rejected };
  },
});

// ---------------------------------------------------------------------------
// Daily rollups
// ---------------------------------------------------------------------------

export const pageUsageForDay = internalQuery({
  args: {
    start: v.number(),
    end: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("aiUsageEvents")
      .withIndex("by_createdAt", (q) =>
        q.gte("createdAt", args.start).lt("createdAt", args.end),
      )
      .paginate(args.paginationOpts);
  },
});

export const writeRollups = internalMutation({
  args: {
    groups: v.array(
      v.object({
        period: v.string(),
        deployment: v.union(v.literal("prod"), v.literal("dev")),
        clerkOrgId: v.string(),
        tenantName: v.optional(v.string()),
        operation: v.string(),
        provider: v.string(),
        model: v.string(),
        tokenClass: v.optional(
          v.union(v.literal("fabric-synthesis"), v.literal("agent-llm")),
        ),
        callCount: v.number(),
        failedCount: v.number(),
        truncatedCount: v.number(),
        inputTokens: v.number(),
        outputTokens: v.number(),
        cachedReadTokens: v.number(),
        cacheWriteTokens: v.number(),
        seconds: v.number(),
        costMicroUsd: v.number(),
        providerReportedCostMicroUsd: v.number(),
        unpricedCount: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const updatedAt = Date.now();
    for (const group of args.groups) {
      const existing = await ctx.db
        .query("aiUsageRollups")
        .withIndex("by_rollupKey", (q) =>
          q
            .eq("period", group.period)
            .eq("deployment", group.deployment)
            .eq("clerkOrgId", group.clerkOrgId)
            .eq("operation", group.operation)
            .eq("model", group.model),
        )
        .unique();

      // Replace rather than add: the fold produces absolute totals, so a re-run
      // repairs instead of doubling.
      if (existing) {
        await ctx.db.patch(existing._id, { ...group, updatedAt });
      } else {
        await ctx.db.insert("aiUsageRollups", { ...group, updatedAt });
      }
    }
  },
});

/**
 * Folds one UTC day of the ledger into `aiUsageRollups`.
 *
 * Pages through the ledger from an action rather than reading it in one
 * mutation: a busy day can exceed a single transaction's read limit, and this
 * job must not start failing precisely when usage grows.
 */
export const foldUsageDay = internalAction({
  args: { period: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ period: string; groups: number }> => {
    // Default to yesterday — today is still accumulating, and the console reads
    // the live ledger for the current day.
    const period =
      args.period ?? utcDayKey(Date.now() - 24 * 60 * 60 * 1000);
    const { start, end } = utcDayBounds(period);

    const rows: RollableUsageRow[] = [];
    let cursor: string | null = null;
    for (;;) {
      // Annotated explicitly: `internal` is `anyApi`, so inferring this from the
      // call while `cursor` feeds back into it is circular.
      const page: {
        page: Array<Doc<"aiUsageEvents">>;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.aiUsage.pageUsageForDay, {
        start,
        end,
        paginationOpts: { numItems: 500, cursor },
      });
      rows.push(...page.page);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    const groups = foldUsageRows(period, rows);
    // Chunked so one day with very many (tenant, operation, model) combinations
    // cannot exceed a single mutation's write limit.
    for (let i = 0; i < groups.length; i += 100) {
      await ctx.runMutation(internal.aiUsage.writeRollups, {
        groups: groups.slice(i, i + 100),
      });
    }

    console.info("AI usage day folded", {
      period,
      rows: rows.length,
      groups: groups.length,
    });
    return { period, groups: groups.length };
  },
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Raw ledger rows are kept this long; rollups are kept indefinitely. */
const LEDGER_RETENTION_DAYS = 180;

/** Bounds deletions per run so the cron cannot hit a transaction limit. */
const RETENTION_BATCH_SIZE = 500;

/**
 * Deletes ledger rows past the retention window.
 *
 * Refuses to delete a row whose day has not been rolled up — otherwise a fold
 * that silently stopped running would turn into permanent data loss instead of
 * a growing table.
 */
export const pruneOldUsageEvents = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deleted: number; skipped: number }> => {
    const cutoff = Date.now() - LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("aiUsageEvents")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(RETENTION_BATCH_SIZE);

    let deleted = 0;
    let skipped = 0;
    const rolledUpPeriods = new Map<string, boolean>();

    for (const row of rows) {
      const period = utcDayKey(row.createdAt);
      let rolledUp = rolledUpPeriods.get(period);
      if (rolledUp === undefined) {
        const sample = await ctx.db
          .query("aiUsageRollups")
          .withIndex("by_period", (q) => q.eq("period", period))
          .first();
        rolledUp = sample !== null;
        rolledUpPeriods.set(period, rolledUp);
      }
      if (!rolledUp) {
        skipped += 1;
        continue;
      }
      await ctx.db.delete(row._id);
      deleted += 1;
    }

    if (skipped > 0) {
      console.warn("Skipped pruning usage rows for un-rolled-up days", {
        skipped,
      });
    }
    return { deleted, skipped };
  },
});
