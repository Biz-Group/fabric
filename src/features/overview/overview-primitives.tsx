"use client";

import { Fragment, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
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
import { splitEmphasisRuns } from "@/lib/inline-emphasis";
import { cn } from "@/lib/utils";
import {
  evidenceStrengthLabel,
  formatGeneratedTime,
  OVERVIEW_STATE_META,
  overviewProgressText,
  overviewStatusDetail,
  refreshActionLabel,
  refreshUnavailableReason,
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

/**
 * The lifecycle chip. When the state carries an explanation it becomes a
 * disclosure button instead of growing into a banner — the detail stays one tap
 * away rather than pushing the overview itself down the page.
 */
export function OverviewStateBadge({
  state,
  expandable = false,
  expanded = false,
  controls,
  onToggle,
}: {
  state: OverviewState;
  expandable?: boolean;
  expanded?: boolean;
  controls?: string;
  onToggle?: () => void;
}) {
  const Icon = STATE_ICONS[state];
  const label = OVERVIEW_STATE_META[state].label;
  const chipClass = cn(
    "inline-flex min-h-6 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
    STATE_STYLES[state],
  );
  const body = (
    <>
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          state === "refreshing" && "animate-spin motion-reduce:animate-none",
        )}
        aria-hidden="true"
      />
      {label}
      {expandable && (
        <ChevronDown
          className={cn(
            "size-3 shrink-0 opacity-70 transition-transform motion-reduce:transition-none",
            expanded && "rotate-180",
          )}
          aria-hidden="true"
        />
      )}
    </>
  );

  if (!expandable) {
    return (
      <span className={chipClass} aria-label={`Overview status: ${label}`}>
        {body}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={controls}
      aria-label={`Overview status: ${label}`}
      title={expanded ? "Hide status detail" : "Show status detail"}
      className={cn(
        chipClass,
        "org-focus-ring min-h-8 cursor-pointer transition-opacity hover:opacity-80 sm:min-h-7",
      )}
    >
      {body}
    </button>
  );
}

/**
 * Generated prose with its load-bearing facts emphasized. The generator marks
 * the spans — a reader scanning the brief sees the systems, roles, and
 * thresholds it turns on without reading every sentence. Emphasis inherits the
 * surrounding size and only lifts weight and colour, so it reads as stress
 * inside the paragraph rather than a second heading level.
 */
export function EmphasizedText({ value }: { value: string }) {
  return (
    <>
      {splitEmphasisRuns(value).map((run, index) =>
        run.emphasized ? (
          <strong key={index} className="font-semibold text-foreground">
            {run.text}
          </strong>
        ) : (
          <Fragment key={index}>{run.text}</Fragment>
        ),
      )}
    </>
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

function OverviewAlert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="mt-4 border-l-2 border-destructive bg-destructive/10 px-4 py-3 text-sm leading-6"
    >
      {children}
    </p>
  );
}

/**
 * The top of every overview surface: the overview itself leads, and the
 * lifecycle chip, provenance, and actions ride one compact line under the
 * heading. Everything that used to sit above the content as chips, a banner,
 * and a button row is either in that line or disclosed from the chip, so the
 * reader reaches the actual overview in the first screen on any viewport.
 */
export function OverviewLead({
  id,
  title = "Overview",
  state,
  hasContent,
  generatedAt,
  progress,
  progressUnit,
  canRefresh,
  refreshAvailable,
  hasEvidenceSource = true,
  refreshPending,
  refreshError,
  error,
  copyState,
  onCopy,
  onRefresh,
  children,
}: {
  id: string;
  title?: string;
  state: OverviewState;
  hasContent: boolean;
  generatedAt: number | null;
  progress?: { completed: number; total: number } | null;
  progressUnit?: string;
  canRefresh: boolean;
  refreshAvailable: boolean;
  /** False only on a process with no completed conversation to build from. */
  hasEvidenceSource?: boolean;
  refreshPending: boolean;
  refreshError?: string | null;
  error: { message: string; retryable: boolean } | null;
  copyState: OverviewCopyState;
  onCopy: () => void;
  onRefresh: () => void;
  children: ReactNode;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const detailId = `${id}-status-detail`;
  const detail = overviewStatusDetail(
    state,
    progress,
    progressUnit,
    canRefresh,
    hasEvidenceSource,
  );
  // The timestamp only says something once an overview has been generated.
  const liveProgress =
    state === "refreshing" ? overviewProgressText(progress, progressUnit) : null;
  const showRefresh = canRefresh && state !== "refreshing";
  const actionLabel = refreshActionLabel(state, hasContent);
  // Kept visible but inert: a rebuild that would spend a full generation on
  // evidence the overview already contains says so where it is pressed, rather
  // than disappearing and leaving the reader to wonder where it went.
  const unavailableReason = refreshUnavailableReason(
    state,
    refreshAvailable,
    progressUnit,
    hasEvidenceSource,
  );

  return (
    <section aria-labelledby={id} className="pb-8 sm:pb-10">
      <div className="flex items-center justify-between gap-3">
        <h2
          id={id}
          className="min-w-0 text-2xl font-semibold tracking-tight sm:text-3xl"
        >
          {title}
        </h2>
        {(hasContent || showRefresh) && (
          <div className="flex shrink-0 items-center gap-1.5">
            {hasContent && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="org-focus-ring h-9 px-3 sm:h-7 sm:px-2.5"
                disabled={copyState === "copying"}
                onClick={onCopy}
                aria-label={
                  copyState === "copied" ? "Overview copied" : "Copy overview"
                }
              >
                {copyState === "copied" ? (
                  <Check className="size-4 sm:size-3.5" aria-hidden="true" />
                ) : (
                  <Copy className="size-4 sm:size-3.5" aria-hidden="true" />
                )}
                <span className="hidden sm:inline">
                  {copyState === "copied"
                    ? "Copied"
                    : copyState === "failed"
                      ? "Copy failed"
                      : "Copy"}
                </span>
              </Button>
            )}
            {showRefresh && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="org-focus-ring h-9 px-3 sm:h-7 sm:px-2.5"
                disabled={refreshPending || !refreshAvailable}
                onClick={onRefresh}
                title={unavailableReason ?? undefined}
                aria-label={
                  unavailableReason
                    ? `${actionLabel}. ${unavailableReason}`
                    : actionLabel
                }
              >
                {refreshPending ? (
                  <Loader2
                    className="size-4 animate-spin motion-reduce:animate-none sm:size-3.5"
                    aria-hidden="true"
                  />
                ) : (
                  <RefreshCw className="size-4 sm:size-3.5" aria-hidden="true" />
                )}
                {/* An empty overview needs a legible call to action, so its
                    label survives on narrow viewports. */}
                <span className={cn(hasContent && "hidden sm:inline")}>
                  {actionLabel}
                </span>
              </Button>
            )}
          </div>
        )}
      </div>

      <div
        role="status"
        aria-live="polite"
        className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2"
      >
        <OverviewStateBadge
          state={state}
          expandable={detail !== null}
          expanded={detailOpen}
          controls={detailId}
          onToggle={() => setDetailOpen((open) => !open)}
        />
        {(liveProgress || generatedAt !== null) && (
          <p className="min-w-0 text-xs text-muted-foreground">
            {liveProgress}
            {liveProgress && generatedAt !== null && (
              <span aria-hidden="true"> · </span>
            )}
            {generatedAt !== null && (
              <time dateTime={new Date(generatedAt).toISOString()}>
                {formatGeneratedTime(generatedAt)}
              </time>
            )}
          </p>
        )}
      </div>

      {detail && (
        <p
          id={detailId}
          hidden={!detailOpen}
          className={cn(
            "mt-3 max-w-2xl border-l-2 px-4 py-2 text-sm leading-6 text-muted-foreground",
            state === "missing" ? "border-border" : "border-amber-500",
          )}
        >
          {detail}
        </p>
      )}

      {state === "failed" && (
        <OverviewAlert>
          {OVERVIEW_STATE_META.failed.description}
          {error ? ` ${error.message}` : ""}
          {error?.retryable ? " A contributor can retry this refresh." : ""}
        </OverviewAlert>
      )}
      {refreshError && <OverviewAlert>{refreshError}</OverviewAlert>}

      {children ? <div className="mt-6 sm:mt-7">{children}</div> : null}
    </section>
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
