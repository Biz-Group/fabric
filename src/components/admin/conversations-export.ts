import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api";

type Page = FunctionReturnType<typeof api.conversations.listAllForOrg>["page"];
type Row = Page[number];

const CSV_COLUMNS = [
  "id",
  "created_at",
  "contributor",
  "function",
  "department",
  "process",
  "status",
  "duration_seconds",
  "message_count",
  "summary",
] as const;

function escape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowToCsv(r: Row): string {
  return [
    escape(r._id),
    escape(new Date(r._creationTime).toISOString()),
    escape(r.contributorName),
    escape(r.functionName),
    escape(r.departmentName),
    escape(r.processName),
    escape(r.status),
    escape(r.durationSeconds ?? ""),
    escape(r.transcript?.length ?? 0),
    escape(r.summary ?? ""),
  ].join(",");
}

export function buildConversationsCsv(rows: Row[]): string {
  const header = CSV_COLUMNS.join(",");
  const body = rows.map(rowToCsv).join("\n");
  return `${header}\n${body}\n`;
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
