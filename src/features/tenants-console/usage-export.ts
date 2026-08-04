import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api";

type LogRow = FunctionReturnType<typeof api.aiUsage.usageLog>["page"][number];

/**
 * Cost is exported in BOTH micro-USD (exact, as stored) and USD (readable).
 * A spreadsheet that only has the rounded dollar column cannot be re-summed to
 * match the console, which defeats the point of exporting it.
 */
const CSV_COLUMNS = [
  "created_at",
  "deployment",
  "clerk_org_id",
  "tenant_name",
  "operation",
  "provider",
  "model",
  "status",
  "unit",
  "token_class",
  "input_tokens",
  "output_tokens",
  "cached_read_tokens",
  "cache_write_tokens",
  "seconds",
  "cost_micro_usd",
  "cost_usd",
  "provider_reported_cost_micro_usd",
  "price_version",
  "cost_source",
  "latency_ms",
  "finish_reason",
  "entity_type",
  "entity_id",
  "entity_label",
  "actor_user_id",
  "run_id",
  "request_id",
  "error_type",
] as const;

function escape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowToCsv(r: LogRow): string {
  return [
    escape(new Date(r.createdAt).toISOString()),
    escape(r.deployment),
    escape(r.clerkOrgId),
    escape(r.tenantName ?? ""),
    escape(r.operation),
    escape(r.provider),
    escape(r.model),
    escape(r.status),
    escape(r.unit),
    escape(r.tokenClass ?? ""),
    escape(r.inputTokens ?? ""),
    escape(r.outputTokens ?? ""),
    escape(r.cachedReadTokens ?? ""),
    escape(r.cacheWriteTokens ?? ""),
    escape(r.seconds ?? ""),
    escape(r.costMicroUsd),
    escape((r.costMicroUsd / 1_000_000).toFixed(6)),
    escape(r.providerReportedCostMicroUsd ?? ""),
    escape(r.priceVersion),
    escape(r.costSource),
    escape(r.latencyMs ?? ""),
    escape(r.finishReason ?? ""),
    escape(r.entityType ?? ""),
    escape(r.entityId ?? ""),
    escape(r.entityLabel ?? ""),
    escape(r.actorUserId ?? ""),
    escape(r.runId ?? ""),
    escape(r.requestId ?? ""),
    escape(r.errorType ?? ""),
  ].join(",");
}

export function buildUsageCsv(rows: LogRow[]): string {
  const header = CSV_COLUMNS.join(",");
  const body = rows.map(rowToCsv).join("\n");
  return `${header}\n${body}\n`;
}
