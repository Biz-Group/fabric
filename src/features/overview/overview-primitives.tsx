import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Copy,
  Loader2,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  evidenceStrengthLabel,
  formatGeneratedTime,
  OVERVIEW_STATE_META,
  overviewActionHint,
  refreshActionLabel,
  type EvidenceLevel,
  type OverviewState,
} from "@/features/overview/overview-view-model";

export type OverviewSource =
  | {
      kind: "conversation";
      conversationId: Id<"conversations">;
      label: string;
    }
  | { kind: "process"; processId: Id<"processes">; label: string }
  | {
      kind: "department";
      departmentId: Id<"departments">;
      label: string;
    };

export type OverviewFinding = {
  id: string;
  title: string;
  body: string;
  evidenceLevel: EvidenceLevel;
  supportCount: number;
  sources: OverviewSource[];
};

export type OverviewCopyState = "idle" | "copying" | "copied" | "failed";

const STATE_STYLES: Record<OverviewState, string> = {
  missing: "border-border bg-muted/60 text-muted-foreground",
  current:
    "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200",
  stale:
    "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200",
  refreshing:
    "border-org-accent-border bg-org-accent-subtle text-org-accent-selected-foreground",
  partial:
    "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200",
  failed:
    "border-destructive/30 bg-destructive/10 text-destructive dark:border-destructive/40",
};

const STATE_ICONS = {
  missing: CircleDashed,
  current: CheckCircle2,
  stale: AlertTriangle,
  refreshing: Loader2,
  partial: AlertTriangle,
  failed: AlertTriangle,
} satisfies Record<OverviewState, typeof CircleDashed>;

export function OverviewStateBadge({ state }: { state: OverviewState }) {
  const Icon = STATE_ICONS[state];
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        STATE_STYLES[state],
      )}
      aria-label={`Overview status: ${OVERVIEW_STATE_META[state].label}`}
    >
      <Icon
        className={cn(
          "size-3.5",
          state === "refreshing" && "animate-spin motion-reduce:animate-none",
        )}
        aria-hidden="true"
      />
      {OVERVIEW_STATE_META[state].label}
    </span>
  );
}

export function OverviewGeneratedTime({ value }: { value: number | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Clock3 className="size-3.5" aria-hidden="true" />
      {value === null ? (
        "Not generated yet"
      ) : (
        <time dateTime={new Date(value).toISOString()}>
          {formatGeneratedTime(value)}
        </time>
      )}
    </span>
  );
}

export function OverviewProvenance({
  sourceMode,
  generatedAt,
}: {
  sourceMode: string;
  generatedAt: number | null;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground"
      aria-label="Overview provenance"
    >
      <span className="inline-flex min-h-6 items-center rounded-full border px-2.5 py-1 font-medium">
        {sourceMode}
      </span>
      <OverviewGeneratedTime value={generatedAt} />
    </div>
  );
}

export function OverviewControlHeader({
  state,
  hasContent,
  sourceMode,
  generatedAt,
  progress,
  progressUnit,
  canRefresh,
  refreshPending,
  copyState,
  onCopy,
  onRefresh,
}: {
  state: OverviewState;
  hasContent: boolean;
  sourceMode: string;
  generatedAt: number | null;
  progress?: { completed: number; total: number } | null;
  progressUnit?: string;
  canRefresh: boolean;
  refreshPending: boolean;
  copyState: OverviewCopyState;
  onCopy: () => void;
  onRefresh: () => void;
}) {
  const progressText =
    state === "refreshing" && progress
      ? `${Math.min(progress.completed, progress.total)} of ${progress.total}${
          progressUnit ? ` ${progressUnit}` : ""
        } complete`
      : null;

  return (
    <header className={cn("pb-5", generatedAt !== null && "sm:pb-7")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex min-w-0 flex-wrap items-center gap-2.5"
          role={state === "refreshing" ? "status" : undefined}
          aria-live={state === "refreshing" ? "polite" : undefined}
        >
          <OverviewStateBadge state={state} />
          {progressText && (
            <span className="text-xs text-muted-foreground">
              {progressText}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {hasContent && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="org-focus-ring gap-1.5"
              disabled={copyState === "copying"}
              onClick={onCopy}
            >
              {copyState === "copied" ? (
                <Check className="size-3.5" aria-hidden="true" />
              ) : (
                <Copy className="size-3.5" aria-hidden="true" />
              )}
              {copyState === "copied"
                ? "Copied"
                : copyState === "failed"
                  ? "Copy failed"
                  : "Copy"}
            </Button>
          )}
          {canRefresh && state !== "refreshing" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="org-focus-ring gap-1.5"
              disabled={refreshPending}
              onClick={onRefresh}
            >
              {refreshPending ? (
                <Loader2
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <RefreshCw className="size-3.5" aria-hidden="true" />
              )}
              {refreshActionLabel(state, hasContent)}
            </Button>
          )}
        </div>
      </div>
      {generatedAt !== null && (
        <div className="mt-4">
          <OverviewProvenance sourceMode={sourceMode} generatedAt={generatedAt} />
        </div>
      )}
    </header>
  );
}

export function OverviewLifecycleNotice({
  state,
  progress,
  error,
  progressUnit,
  canRefresh = false,
}: {
  state: OverviewState;
  progress: { completed: number; total: number } | null;
  error: { message: string; retryable: boolean } | null;
  progressUnit?: string;
  canRefresh?: boolean;
}) {
  if (state === "current" || state === "refreshing") return null;
  const actionHint = overviewActionHint(state, canRefresh);
  const progressText = progress
    ? `${Math.min(progress.completed, progress.total)} of ${progress.total}${
        progressUnit ? ` ${progressUnit}` : ""
      } complete`
    : null;
  const role = state === "failed" ? "alert" : "status";

  return (
    <div
      role={role}
      aria-live="polite"
      className={cn(
        "mb-8 flex items-start gap-3 border-l-2 px-4 py-3 text-sm",
        (state === "stale" || state === "partial") &&
          "border-amber-500 bg-amber-50/70 text-amber-950 dark:bg-amber-500/10 dark:text-amber-100",
        state === "failed" &&
          "border-destructive bg-destructive/10 text-foreground",
        state === "missing" &&
          "border-border bg-muted/50 text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "mt-1 size-2 shrink-0 rounded-full",
          state === "failed" ? "bg-destructive" : "bg-amber-500",
          state === "missing" && "bg-muted-foreground",
        )}
        aria-hidden="true"
      />
      <div>
        <p className="font-medium">{OVERVIEW_STATE_META[state].label}</p>
        <p className="mt-0.5 leading-6 text-current/75">
          {OVERVIEW_STATE_META[state].description}
          {progressText ? ` ${progressText}.` : ""}
          {actionHint ? ` ${actionHint}` : ""}
        </p>
        {state === "failed" && error && (
          <p className="mt-1 text-xs text-current/70">
            {error.message}
            {error.retryable
              ? " A contributor can retry this refresh."
              : ""}
          </p>
        )}
      </div>
    </div>
  );
}

export function EvidenceStrength({
  level,
  supportCount,
}: {
  level: EvidenceLevel;
  supportCount: number;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        level === "corroborated" &&
          "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200",
        level === "single_source" &&
          "border-border bg-muted/50 text-muted-foreground",
        level === "inferred_gap" &&
          "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200",
      )}
    >
      <ShieldCheck className="size-3" aria-hidden="true" />
      {evidenceStrengthLabel(level, supportCount)}
    </span>
  );
}

export function SourceChips({
  sources,
  onOpenConversation,
  onOpenProcess,
  onOpenDepartment,
}: {
  sources: OverviewSource[];
  onOpenConversation?: (conversationId: Id<"conversations">) => void;
  onOpenProcess?: (processId: Id<"processes">) => void;
  onOpenDepartment?: (departmentId: Id<"departments">) => void;
}) {
  if (sources.length === 0) {
    return (
      <span className="text-xs italic text-muted-foreground">
        No direct source—identified as an evidence gap
      </span>
    );
  }

  return (
    <div className="flex flex-wrap gap-2" aria-label="Finding sources">
      {sources.map((source) => {
        const key =
          source.kind === "conversation"
            ? `${source.kind}:${source.conversationId}`
            : source.kind === "process"
              ? `${source.kind}:${source.processId}`
              : `${source.kind}:${source.departmentId}`;
        const open =
          source.kind === "conversation" && onOpenConversation
            ? () => onOpenConversation(source.conversationId)
            : source.kind === "process" && onOpenProcess
              ? () => onOpenProcess(source.processId)
              : source.kind === "department" && onOpenDepartment
                ? () => onOpenDepartment(source.departmentId)
                : null;

        return open ? (
          <button
            type="button"
            key={key}
            className="org-focus-ring inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border border-org-accent-border bg-org-accent-subtle px-3 py-1.5 text-left text-xs font-medium text-org-accent-selected-foreground transition-colors hover:bg-org-accent-selected"
            onClick={open}
            aria-label={`Open ${source.kind}: ${source.label}`}
            title={source.label}
          >
            {source.kind === "conversation" ? (
              <MessageSquareText
                className="size-3.5 shrink-0 text-org-accent"
                aria-hidden="true"
              />
            ) : (
              <ArrowUpRight
                className="size-3.5 shrink-0 text-org-accent"
                aria-hidden="true"
              />
            )}
            <span className="truncate">{source.label}</span>
          </button>
        ) : (
          <span
            key={key}
            className="inline-flex min-h-8 max-w-full items-center rounded-full border bg-muted/40 px-3 py-1 text-xs text-muted-foreground"
            title={source.label}
          >
            <span className="truncate">{source.label}</span>
          </span>
        );
      })}
    </div>
  );
}

export function OverviewSection({
  id,
  title,
  description,
  children,
  className,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className={cn("border-t border-border/80 py-8 sm:py-10", className)}
    >
      <div className="mb-6 max-w-2xl">
        <h2 id={id} className="text-xl font-semibold tracking-tight sm:text-2xl">
          {title}
        </h2>
        {description && (
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

export function FindingRows({
  findings,
  onOpenConversation,
  onOpenProcess,
  onOpenDepartment,
  emptyText,
}: {
  findings: OverviewFinding[];
  onOpenConversation?: (conversationId: Id<"conversations">) => void;
  onOpenProcess?: (processId: Id<"processes">) => void;
  onOpenDepartment?: (departmentId: Id<"departments">) => void;
  emptyText: string;
}) {
  if (findings.length === 0) {
    return (
      <p className="border-l-2 border-border pl-4 text-sm leading-6 text-muted-foreground">
        {emptyText}
      </p>
    );
  }

  return (
    <div className="divide-y divide-border/80">
      {findings.map((finding) => (
        <article key={finding.id} className="py-5 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h3 className="min-w-0 text-base font-semibold leading-6">
              {finding.title}
            </h3>
            <EvidenceStrength
              level={finding.evidenceLevel}
              supportCount={finding.supportCount}
            />
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-7 text-foreground/80">
            {finding.body}
          </p>
          <div className="mt-4">
            <SourceChips
              sources={finding.sources}
              onOpenConversation={onOpenConversation}
              onOpenProcess={onOpenProcess}
              onOpenDepartment={onOpenDepartment}
            />
          </div>
        </article>
      ))}
    </div>
  );
}
