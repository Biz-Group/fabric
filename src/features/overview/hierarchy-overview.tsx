"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowUpRight, Building2, FileText, GitBranch } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Skeleton } from "@/components/ui/skeleton";
import {
  EmphasizedText,
  FindingRows,
  OverviewGeneratedTime,
  OverviewLead,
  OverviewSection,
  OverviewStateBadge,
  type OverviewCopyState,
  type OverviewFinding,
} from "@/features/overview/overview-primitives";
import {
  legacyPreviewText,
  overviewCopyText,
  type OverviewState,
} from "@/features/overview/overview-view-model";
import { MarkdownSummary } from "@/features/workbench/markdown-summary";
import {
  type HierarchySummaryEntity,
  useSummaryOverview,
} from "@/features/workbench/use-summary-overview";

type OverviewResponse = FunctionReturnType<typeof api.summaries.getOverview>;
type StructuredArtifact = Extract<
  OverviewResponse["content"],
  { format: "v2" }
>["artifact"];
type DepartmentArtifact = Extract<
  StructuredArtifact,
  { crossProcessDependencies: unknown[] }
>;
type FunctionArtifact = Extract<
  StructuredArtifact,
  { crossDepartmentDependencies: unknown[] }
>;
type HierarchyArtifact = DepartmentArtifact | FunctionArtifact;

export type HierarchyChildSummary =
  | {
      kind: "process";
      id: Id<"processes">;
      name: string;
      state: OverviewState;
      format: "v2" | "legacy" | "none";
      generatedAt: number | null;
      coverage: {
        includedSources: number;
        totalEligibleSources: number;
        complete: boolean;
      } | null;
    }
  | {
      kind: "department";
      id: Id<"departments">;
      name: string;
      state: OverviewState;
      format: "v2" | "legacy" | "none";
      generatedAt: number | null;
      coverage: {
        includedSources: number;
        totalEligibleSources: number;
        complete: boolean;
      } | null;
    };

type HierarchyOverviewProps = {
  entity: HierarchySummaryEntity;
  description?: string | null;
  childSummaries: HierarchyChildSummary[] | undefined;
  canRefresh: boolean;
  onOpenProcess?: (processId: Id<"processes">) => void;
  onOpenDepartment?: (departmentId: Id<"departments">) => void;
};

function isDepartmentArtifact(
  artifact: StructuredArtifact,
): artifact is DepartmentArtifact {
  return "crossProcessDependencies" in artifact;
}

function isFunctionArtifact(
  artifact: StructuredArtifact,
): artifact is FunctionArtifact {
  return "crossDepartmentDependencies" in artifact;
}

function hierarchyArtifactFor(
  kind: HierarchySummaryEntity["kind"],
  artifact: StructuredArtifact,
): HierarchyArtifact | null {
  if (kind === "department" && isDepartmentArtifact(artifact)) return artifact;
  if (kind === "function" && isFunctionArtifact(artifact)) return artifact;
  return null;
}

function HierarchyOverviewLoading() {
  return (
    <div
      className="mx-auto w-full max-w-5xl space-y-8 px-4 py-8 sm:px-6 lg:px-8"
      aria-label="Loading hierarchy overview"
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-9 w-36 sm:h-7" />
        </div>
        <Skeleton className="h-6 w-64 rounded-full" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-5 w-full max-w-3xl" />
        <Skeleton className="h-5 w-4/5 max-w-2xl" />
      </div>
      <div className="space-y-3 border-y py-8">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-5 w-full max-w-2xl" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-16 w-full rounded-none" />
        ))}
      </div>
    </div>
  );
}

function childEvidenceText(child: HierarchyChildSummary): string {
  if (child.coverage) {
    return `${child.coverage.includedSources} of ${child.coverage.totalEligibleSources} sources`;
  }
  if (child.format === "legacy") return "Legacy overview";
  return "No structured coverage";
}

function ChildCoverageLedger({
  entityKind,
  coverage,
  childSummaries,
  onOpenProcess,
  onOpenDepartment,
}: {
  entityKind: HierarchySummaryEntity["kind"];
  coverage: OverviewResponse["coverage"];
  childSummaries: HierarchyChildSummary[] | undefined;
  onOpenProcess?: (processId: Id<"processes">) => void;
  onOpenDepartment?: (departmentId: Id<"departments">) => void;
}) {
  const childLabel = entityKind === "department" ? "processes" : "departments";
  const percentage = coverage
    ? coverage.totalEligibleSources === 0
      ? 100
      : Math.min(
          100,
          Math.round(
            (coverage.includedSources / coverage.totalEligibleSources) * 100,
          ),
        )
    : null;

  return (
    <section
      className="border-y border-border py-8 sm:py-10"
      aria-labelledby={`${entityKind}-child-coverage`}
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2
            id={`${entityKind}-child-coverage`}
            className="text-xl font-semibold tracking-tight sm:text-2xl"
          >
            Process Coverage
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            {coverage
              ? `${coverage.includedSources} of ${coverage.totalEligibleSources} eligible ${childLabel} were included when this overview was generated. Row status reflects their current state.`
              : `This overview does not record exact child inclusion. Current ${childLabel} are shown below.`}
          </p>
        </div>
        {coverage && (
          <p className="text-sm font-medium tabular-nums">
            {percentage}% covered
          </p>
        )}
      </div>

      {coverage && (
        <div
          className="mt-5 h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={`${childLabel} included`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentage ?? 0}
        >
          <div
            className="h-full rounded-full bg-org-accent transition-[width] motion-reduce:transition-none"
            style={{ width: `${percentage}%` }}
          />
        </div>
      )}

      <div className="mt-6 border-t border-border" role="list">
        {childSummaries === undefined ? (
          <div className="space-y-px py-2" aria-label={`Loading ${childLabel}`}>
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-16 rounded-none" />
            ))}
          </div>
        ) : childSummaries.length === 0 ? (
          <p className="py-8 text-sm text-muted-foreground">
            No {childLabel} are currently defined.
          </p>
        ) : (
          childSummaries.map((child) => {
            const open =
              child.kind === "process" && onOpenProcess
                ? () => onOpenProcess(child.id)
                : child.kind === "department" && onOpenDepartment
                  ? () => onOpenDepartment(child.id)
                  : null;
            const Icon = child.kind === "process" ? GitBranch : Building2;
            const content = (
              <>
                <span className="flex min-w-0 items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {child.name}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {childEvidenceText(child)}
                    </span>
                  </span>
                </span>
                <span className="flex flex-wrap items-center justify-end gap-3">
                  <OverviewStateBadge state={child.state} />
                  <span className="hidden sm:inline-flex">
                    <OverviewGeneratedTime value={child.generatedAt} />
                  </span>
                  {open && (
                    <ArrowUpRight
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                </span>
              </>
            );

            return open ? (
              <div role="listitem" key={`${child.kind}:${child.id}`}>
                <button
                  type="button"
                  onClick={open}
                  className="org-focus-ring grid min-h-16 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border px-2 py-3 text-left transition-colors hover:bg-org-accent-subtle"
                  aria-label={`Open ${child.kind}: ${child.name}`}
                >
                  {content}
                </button>
              </div>
            ) : (
              <div
                role="listitem"
                key={`${child.kind}:${child.id}`}
                className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border px-2 py-3"
              >
                {content}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function HierarchyFindingSection({
  id,
  title,
  description,
  findings,
  emptyText,
  onOpenProcess,
  onOpenDepartment,
}: {
  id: string;
  title: string;
  description?: string;
  findings: OverviewFinding[];
  emptyText: string;
  onOpenProcess?: (processId: Id<"processes">) => void;
  onOpenDepartment?: (departmentId: Id<"departments">) => void;
}) {
  return (
    <OverviewSection id={id} title={title} description={description}>
      <FindingRows
        findings={findings}
        onOpenProcess={onOpenProcess}
        onOpenDepartment={onOpenDepartment}
        emptyText={emptyText}
      />
    </OverviewSection>
  );
}

export function HierarchyOverviewContent({
  overview,
  entity,
  description,
  childSummaries,
  canRefresh,
  refreshPending,
  refreshError,
  onRefresh,
  onOpenProcess,
  onOpenDepartment,
}: HierarchyOverviewProps & {
  overview: OverviewResponse;
  refreshPending: boolean;
  refreshError: string | null;
  onRefresh: () => void;
}) {
  const [copyState, setCopyState] = useState<OverviewCopyState>("idle");
  const hasContent = overview.content.format !== "none";
  const artifact =
    overview.content.format === "v2"
      ? hierarchyArtifactFor(entity.kind, overview.content.artifact)
      : null;
  const entityLabel = entity.kind === "department" ? "department" : "function";
  const childLabel = entity.kind === "department" ? "processes" : "departments";

  const handleCopy = async () => {
    const text = overviewCopyText(overview.content);
    if (!text) return;
    setCopyState("copying");
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    } finally {
      window.setTimeout(() => setCopyState("idle"), 1_800);
    }
  };

  return (
    <article
      className="mx-auto w-full max-w-5xl px-4 pb-6 pt-7 sm:px-6 sm:pt-10 lg:px-8"
      aria-label={`${entityLabel} overview`}
    >
      <OverviewLead
        id={`${entity.kind}-overview-brief`}
        state={overview.state}
        hasContent={hasContent}
        generatedAt={overview.lastSuccessfulGenerationAt}
        progress={overview.progress}
        progressUnit={childLabel}
        canRefresh={canRefresh}
        refreshAvailable={overview.refreshAvailable}
        hasEvidenceSource={overview.hasEvidenceSource}
        refreshPending={refreshPending}
        refreshError={refreshError}
        error={overview.error}
        copyState={copyState}
        onCopy={() => void handleCopy()}
        onRefresh={onRefresh}
      >
        {artifact ? (
          <p className="max-w-3xl text-base leading-8 text-foreground/75 sm:text-lg">
            <EmphasizedText value={artifact.executiveBrief} />
          </p>
        ) : hasContent ? (
          <div className="max-w-3xl">
            <p className="mb-5 text-xs leading-5 text-muted-foreground">
              Compatibility view · This overview predates structured child
              coverage and evidence links. It remains readable while Fabric
              transitions to the evidence-backed format.
            </p>
            <div className="border-l-2 border-border pl-5 sm:pl-7">
              <MarkdownSummary content={overview.content.markdown ?? ""} />
            </div>
          </div>
        ) : (
          <div className="border-y py-14 text-center">
            <FileText
              className="mx-auto size-7 text-muted-foreground"
              aria-hidden="true"
            />
            <h3 className="mt-4 text-lg font-semibold">
              {overview.state === "refreshing"
                ? `Building the first ${entityLabel} overview`
                : `No ${entityLabel} overview yet`}
            </h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              {overview.state === "refreshing"
                ? `Fabric is rolling up the available ${childLabel}. You can leave this page while it runs.`
                : `Current child overviews will be combined here when sufficient ${childLabel} are documented.`}
            </p>
          </div>
        )}
      </OverviewLead>

      {artifact ? (
        <>
          <ChildCoverageLedger
            entityKind={entity.kind}
            coverage={artifact.coverage}
            childSummaries={childSummaries}
            onOpenProcess={onOpenProcess}
            onOpenDepartment={onOpenDepartment}
          />

          {entity.kind === "department" && isDepartmentArtifact(artifact) ? (
            <>
              <HierarchyFindingSection
                id="department-dependencies"
                title="Cross-process dependencies"
                description="Connections contributors report between processes in this department."
                findings={artifact.crossProcessDependencies}
                emptyText="No cross-process dependency is established in the current evidence."
                onOpenProcess={onOpenProcess}
              />
              <HierarchyFindingSection
                id="department-patterns"
                title="Shared patterns"
                findings={artifact.sharedPatterns}
                emptyText="No shared operating pattern is established yet."
                onOpenProcess={onOpenProcess}
              />
              <HierarchyFindingSection
                id="department-variations"
                title="Variations and tensions"
                findings={artifact.variationsAndTensions}
                emptyText="No material variation or tension is recorded."
                onOpenProcess={onOpenProcess}
              />
            </>
          ) : entity.kind === "function" && isFunctionArtifact(artifact) ? (
            <>
              <HierarchyFindingSection
                id="function-dependencies"
                title="Cross-department dependencies"
                description="Connections contributors report between departments in this function."
                findings={artifact.crossDepartmentDependencies}
                emptyText="No cross-department dependency is established in the current evidence."
                onOpenDepartment={onOpenDepartment}
              />
              <HierarchyFindingSection
                id="function-patterns"
                title="Strategic patterns"
                findings={artifact.strategicPatterns}
                emptyText="No strategic pattern is established yet."
                onOpenDepartment={onOpenDepartment}
              />
              <HierarchyFindingSection
                id="function-variations"
                title="Variations and tensions"
                findings={artifact.variationsAndTensions}
                emptyText="No material variation or tension is recorded."
                onOpenDepartment={onOpenDepartment}
              />
            </>
          ) : null}

          <HierarchyFindingSection
            id={`${entity.kind}-gaps`}
            title="Knowledge gaps"
            findings={artifact.gaps}
            emptyText="No explicit knowledge gap is recorded in the current overview."
            onOpenProcess={onOpenProcess}
            onOpenDepartment={onOpenDepartment}
          />
          <HierarchyFindingSection
            id={`${entity.kind}-notable`}
            title="Context worth carrying forward"
            findings={artifact.notable}
            emptyText="No additional context has been elevated from the current evidence."
            onOpenProcess={onOpenProcess}
            onOpenDepartment={onOpenDepartment}
          />
        </>
      ) : (
        <ChildCoverageLedger
          entityKind={entity.kind}
          coverage={null}
          childSummaries={childSummaries}
          onOpenProcess={onOpenProcess}
          onOpenDepartment={onOpenDepartment}
        />
      )}

      {description && (
        <section
          className="border-t border-border/80 py-8 sm:py-10"
          aria-labelledby={`${entity.kind}-description`}
        >
          <h2
            id={`${entity.kind}-description`}
            className="text-base font-semibold tracking-tight"
          >
            {entity.kind === "department"
              ? "Department description"
              : "Function description"}
          </h2>
          <p className="mt-3 max-w-3xl whitespace-pre-wrap text-sm leading-7 text-muted-foreground">
            {description}
          </p>
        </section>
      )}
    </article>
  );
}

export function HierarchyOverview({
  entity,
  description,
  childSummaries,
  canRefresh,
  onOpenProcess,
  onOpenDepartment,
}: HierarchyOverviewProps) {
  const overview = useSummaryOverview(entity);
  const forceRefresh = useMutation(api.summaries.forceRefresh);
  const [refreshPending, setRefreshPending] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  if (overview === undefined) return <HierarchyOverviewLoading />;

  const handleRefresh = async () => {
    setRefreshPending(true);
    setRefreshError(null);
    try {
      const result = await forceRefresh({ entity });
      if (result.status === "disabled") {
        setRefreshError("Structured overview generation is not enabled yet.");
      }
    } catch {
      setRefreshError("The overview refresh could not be started. Please try again.");
    } finally {
      setRefreshPending(false);
    }
  };

  return (
    <HierarchyOverviewContent
      overview={overview}
      entity={entity}
      description={description}
      childSummaries={childSummaries}
      canRefresh={canRefresh}
      refreshPending={refreshPending}
      refreshError={refreshError}
      onRefresh={() => void handleRefresh()}
      onOpenProcess={onOpenProcess}
      onOpenDepartment={onOpenDepartment}
    />
  );
}

export function HierarchyOverviewCompactPreview({
  entity,
}: {
  entity: HierarchySummaryEntity;
}) {
  const overview = useSummaryOverview(entity);

  if (overview === undefined) {
    return (
      <div className="space-y-3 rounded-xl border p-4">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }

  return (
    <HierarchyOverviewCompactContent
      overview={overview}
      entityKind={entity.kind}
    />
  );
}

export function HierarchyOverviewCompactContent({
  overview,
  entityKind,
}: {
  overview: OverviewResponse;
  entityKind: HierarchySummaryEntity["kind"];
}) {
  const artifact =
    overview.content.format === "v2"
      ? hierarchyArtifactFor(entityKind, overview.content.artifact)
      : null;
  const preview =
    artifact?.executiveBrief ?? legacyPreviewText(overview.content.markdown);
  const childLabel = entityKind === "department" ? "processes" : "departments";

  return (
    <section
      className="rounded-xl border bg-background p-4"
      aria-label={`${entityKind} overview preview`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <OverviewStateBadge state={overview.state} />
        {artifact && (
          <span className="text-xs text-muted-foreground">
            {artifact.coverage.includedSources} of {artifact.coverage.totalEligibleSources}{" "}
            {childLabel}
          </span>
        )}
      </div>
      <p className="mt-4 line-clamp-5 text-sm leading-6 text-muted-foreground">
        <EmphasizedText value={preview} />
      </p>
      <div className="mt-4">
        <OverviewGeneratedTime value={overview.lastSuccessfulGenerationAt} />
      </div>
    </section>
  );
}
