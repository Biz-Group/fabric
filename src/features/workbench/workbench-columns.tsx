import type { ComponentType, ReactNode } from "react";
import { ChevronRight, Plus, SquarePen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Presentational building blocks for the mobile process navigation columns
// (functions → departments → processes) and the workbench detail surface.
// These are pure, prop-driven components with no app/query state.

// --- Column Item ---

export type RowStatus = "attention" | "stale" | "knowledge";

const ROW_STATUS_META: Record<RowStatus, { title: string; tone: string }> = {
  attention: { title: "A conversation needs speaker labels", tone: "bg-amber-500" },
  stale: { title: "Summary is out of date", tone: "bg-amber-500" },
  knowledge: { title: "Has a summary", tone: "bg-emerald-500/70" },
};

export function ColumnItem({
  label,
  selected,
  indicator,
  count,
  status,
  onClick,
  onNavigate,
  navigateLabel,
  onEdit,
  onDelete,
  mobile,
}: {
  label: string;
  selected: boolean;
  indicator: "arrow" | "dot";
  /** Child count for parent rows; suppresses the drill chevron when 0. */
  count?: number;
  /** Always-visible status dot conveying scent. */
  status?: RowStatus;
  onClick: () => void;
  onNavigate?: () => void;
  navigateLabel?: string;
  onEdit?: () => void;
  onDelete?: () => void;
  mobile?: boolean;
}) {
  const actionButtonClass = cn(
    "inline-flex items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-org-accent-ring/35",
    mobile ? "size-10" : "size-6",
    "hover:bg-org-accent-subtle"
  );
  // Edit/Delete reveal on hover/focus (desktop); always shown on mobile.
  const revealClass = mobile
    ? undefined
    : selected
      ? "opacity-100"
      : "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100";
  // Parent rows show a chevron only when they actually have children.
  const showChevron = indicator === "arrow" && (count === undefined || count > 0);

  return (
    <div
      className={cn(
        "group flex w-full items-center overflow-hidden rounded-lg border border-transparent transition-all",
        mobile && "min-h-14",
        selected
          ? "border border-org-accent-border bg-org-accent-selected text-org-accent-selected-foreground shadow-sm ring-1 ring-org-accent-border"
          : "text-foreground hover:bg-org-accent-subtle hover:text-foreground"
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex min-w-0 flex-1 items-center text-left font-medium outline-none",
          "focus-visible:ring-3 focus-visible:ring-org-accent-ring/35",
          mobile ? "min-h-14 px-4 py-3 text-base" : "px-3 py-2.5 text-sm"
        )}
      >
        <span className="truncate" title={label}>
          {label}
        </span>
      </button>
      <div
        className={cn(
          "flex shrink-0 items-center",
          mobile ? "gap-1.5 px-1.5" : "gap-0.5 pr-2"
        )}
      >
        {onEdit && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className={cn(actionButtonClass, revealClass)}
            title={`Edit ${label}`}
            aria-label={`Edit ${label}`}
          >
            <SquarePen className={mobile ? "h-4 w-4" : "h-3 w-3"} />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className={cn(actionButtonClass, revealClass)}
            title="Delete"
            aria-label={`Delete ${label}`}
          >
            <Trash2 className={mobile ? "h-4 w-4" : "h-3 w-3"} />
          </button>
        )}
        {/* Always-visible scent: status dot + child count */}
        {status && (
          <span
            className={cn(
              "inline-block h-2 w-2 shrink-0 rounded-full",
              ROW_STATUS_META[status].tone
            )}
            title={ROW_STATUS_META[status].title}
            aria-label={ROW_STATUS_META[status].title}
          />
        )}
        {count !== undefined && count > 0 && (
          <span
            className={cn(
              "ml-0.5 tabular-nums",
              mobile ? "text-sm" : "text-[11px]",
              selected ? "text-org-accent-selected-foreground/70" : "text-muted-foreground"
            )}
          >
            {count}
          </span>
        )}
        {onNavigate ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onNavigate();
            }}
            className={cn(
              actionButtonClass,
              mobile && "ml-1 border-l border-current/10 pl-1"
            )}
            aria-label={navigateLabel ?? `Open ${label}`}
            title={navigateLabel ?? `Open ${label}`}
          >
            <ChevronRight className={mobile ? "h-5 w-5" : "h-4 w-4"} />
          </button>
        ) : showChevron ? (
          <ChevronRight
            className={cn(
              "h-4 w-4 shrink-0",
              selected ? "opacity-80" : "opacity-40"
            )}
          />
        ) : null}
      </div>
    </div>
  );
}

// --- Overview Actions ---
// Edit/Delete were moved off the column rows (where they crowded and truncated
// long names) onto the function/department/process overview headers.
export function OverviewActions({
  entityLabel,
  onEdit,
  onDelete,
}: {
  entityLabel: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={onEdit}
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-org-accent-subtle hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-org-accent-ring/35"
        title={`Edit ${entityLabel}`}
        aria-label={`Edit ${entityLabel}`}
      >
        <SquarePen className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-org-accent-ring/35"
        title={`Delete ${entityLabel}`}
        aria-label={`Delete ${entityLabel}`}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

// --- Empty State ---

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="rounded-xl bg-muted/60 p-4">
        <Icon className="h-7 w-7 text-muted-foreground/70" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <p className="max-w-[200px] text-xs leading-relaxed text-muted-foreground/70">
          {description}
        </p>
      </div>
      {actionLabel && onAction && (
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onAction}>
          <Plus className="h-3.5 w-3.5" />
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

// --- Column Header ---

export function ColumnHeader({
  title,
  count,
  onAdd,
  mobile,
  actions,
}: {
  title: string;
  count?: number;
  onAdd?: () => void;
  mobile?: boolean;
  /** Right-aligned action buttons (e.g. overview edit/delete). */
  actions?: ReactNode;
}) {
  return (
    <div className={cn("shrink-0 border-b bg-muted/30 px-4 py-3", mobile && "bg-background py-3.5")}>
      <div className="flex items-center justify-between">
        <h2 className={cn("text-xs font-semibold uppercase tracking-wider text-muted-foreground", mobile && "text-[0.8rem] tracking-[0.16em]")}>
          {title}
        </h2>
        <div className={cn("flex items-center gap-1 min-h-[1.625rem]", mobile && "min-h-9 gap-2")}>
          {actions}
          {count !== undefined && (
            <span className={cn("rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground", mobile && "flex h-8 min-w-8 items-center justify-center px-2 text-xs")}>
              {count}
            </span>
          )}
          {onAdd && (
            <button
              type="button"
              onClick={onAdd}
              className={cn("rounded-md p-1 text-muted-foreground transition-colors hover:bg-org-accent-subtle hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-org-accent-ring/35", mobile && "flex size-9 items-center justify-center rounded-lg p-0")}
              title={`Add ${title.slice(0, -1)}`}
              aria-label={`Add ${title.slice(0, -1)}`}
            >
              <Plus className={mobile ? "h-4 w-4" : "h-3.5 w-3.5"} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Loading Spinner ---

export function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-org-accent/30 border-t-org-accent" />
    </div>
  );
}
