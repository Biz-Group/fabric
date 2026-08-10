"use client";

import { useCallback, useState } from "react";
import { useAction, useQuery } from "convex/react";
import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  ArrowRight,
  ArrowRightLeft,
  ArrowUpRight,
  BarChart3,
  Bot,
  Clock,
  FileWarning,
  GitBranch,
  KeyRound,
  Loader2,
  Monitor,
  RefreshCw,
  ShieldAlert,
  Split,
  Timer,
  Users,
  Workflow,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  flowDetailProgress,
  flowHasIncompleteDetails,
  flowStage,
  hasRetainedPreviousFlow,
} from "@/lib/flow-status";
import {
  type FlowNode,
  type FlowEdge,
  type ProcessFlow,
  type Confidence,
  type AutomationPotential,
  type HandoffItem,
  type ToolUsage,
  type HeavyArea,
  actorList,
  deriveAutomationCandidates,
  deriveBottlenecks,
  deriveConfidenceCounts,
  deriveDecisionBranches,
  deriveHandoffs,
  deriveHeavyAreas,
  deriveToolUsage,
  getNodeMap,
  pluralize,
  uniqueStrings,
} from "@/features/insights/insights-derivations";

type ProcessInsightsTabProps = {
  processId: Id<"processes">;
  completedConversationCount: number;
  canGenerate: boolean;
  isActive: boolean;
  onOpenProcessFlow: (nodeId?: string) => void;
};

type AutomationOpportunity = NonNullable<
  ProcessFlow["insights"]["automationOpportunityDetails"]
>[number];

const CATEGORY_LABELS: Record<FlowNode["category"], string> = {
  start: "Start",
  end: "End",
  action: "Action",
  decision: "Decision",
  handoff: "Handoff",
  wait: "Wait",
};

const AUTOMATION_LABELS: Record<
  AutomationPotential,
  { label: string; className: string; rank: number }
> = {
  high: {
    label: "High",
    className:
      "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200",
    rank: 3,
  },
  medium: {
    label: "Medium",
    className:
      "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200",
    rank: 2,
  },
  low: {
    label: "Low",
    className:
      "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-500/30 dark:bg-slate-500/10 dark:text-slate-200",
    rank: 1,
  },
  none: {
    label: "None",
    className: "border-border bg-muted text-muted-foreground",
    rank: 0,
  },
};

const CONFIDENCE_LABELS: Record<
  Confidence,
  { label: string; detail: string; className: string }
> = {
  high: {
    label: "High",
    detail: "confirmed",
    className:
      "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200",
  },
  medium: {
    label: "Medium",
    detail: "single clear source",
    className:
      "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200",
  },
  low: {
    label: "Low",
    detail: "inferred or weak",
    className:
      "border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200",
  },
};

function formatGeneratedAt(epochMs: number | null | undefined) {
  if (!epochMs) return "Not generated";
  return new Date(epochMs).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function MetricTile({
  icon: Icon,
  label,
  value,
  detail,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  value: number | string;
  detail?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-h-24 rounded-lg border bg-background p-4",
        accent && "border-org-accent-border bg-org-accent-selected",
      )}
    >
      <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">{label}</span>
      </div>
      <p className="mt-2 break-words text-2xl font-semibold tabular-nums">
        {value}
      </p>
      {detail && (
        <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
          {detail}
        </p>
      )}
    </div>
  );
}

function LoadingInsights() {
  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="grid gap-3 md:grid-cols-3">
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-64 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    </div>
  );
}

function InlineNotice({
  icon: Icon,
  title,
  children,
  action,
  tone = "amber",
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  tone?: "amber" | "destructive";
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border p-3 text-sm sm:flex-row sm:items-start sm:justify-between",
        tone === "amber" &&
          "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100",
        tone === "destructive" &&
          "border-destructive/30 bg-destructive/10 text-destructive",
      )}
      role={tone === "destructive" ? "alert" : "status"}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium">{title}</p>
          <div className="mt-1 text-xs leading-5 opacity-90">{children}</div>
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function GenerateFlowButton({
  canGenerate,
  hasCompletedConversations,
  isGenerating,
  label,
  onGenerate,
  onOpenProcessFlow,
}: {
  canGenerate: boolean;
  hasCompletedConversations: boolean;
  isGenerating: boolean;
  label: string;
  onGenerate: () => void;
  onOpenProcessFlow: () => void;
}) {
  if (!canGenerate) {
    return (
      <Button variant="outline" className="gap-2" onClick={onOpenProcessFlow}>
        <GitBranch className="size-4" aria-hidden />
        View Flow
      </Button>
    );
  }

  return (
    <Button
      className="gap-2"
      onClick={onGenerate}
      disabled={isGenerating || !hasCompletedConversations}
    >
      {isGenerating ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <RefreshCw className="size-4" aria-hidden />
      )}
      {isGenerating ? "Starting..." : label}
    </Button>
  );
}

function InsightSection({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: LucideIcon;
  title: string;
  count?: string;
  children: React.ReactNode;
}) {
  const headingId = `insights-${title
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")}`;

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border bg-background"
    >
      <div className="flex min-w-0 items-center justify-between gap-3 border-b px-4 py-3">
        <h3
          id={headingId}
          className="flex min-w-0 items-center gap-2 text-sm font-semibold"
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 break-words">{title}</span>
        </h3>
        {count && (
          <Badge
            variant="outline"
            className="h-auto max-w-[58%] shrink-0 whitespace-normal text-right leading-4"
          >
            {count}
          </Badge>
        )}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function SectionEmpty({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function PillList({
  values,
  variant = "secondary",
}: {
  values: string[];
  variant?: "secondary" | "outline";
}) {
  if (values.length === 0) {
    return <span className="text-xs text-muted-foreground">None listed</span>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <Badge
          key={value}
          variant={variant}
          className="h-auto min-h-5 max-w-full whitespace-normal break-words text-left"
        >
          {value}
        </Badge>
      ))}
    </div>
  );
}

function NodeBadge({ node }: { node: FlowNode }) {
  return (
    <Badge variant="outline" className="h-auto whitespace-normal break-words">
      {CATEGORY_LABELS[node.category]}
    </Badge>
  );
}

export function FlowNodeLink({
  nodeId,
  label,
  onOpenNode,
  compact = false,
}: {
  nodeId: string;
  label: string;
  onOpenNode: (nodeId: string) => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "org-focus-ring group inline-flex max-w-full items-center gap-1.5 text-left font-medium text-foreground transition-colors hover:text-org-accent",
        compact
          ? "min-h-7 rounded-full border px-2.5 py-1 text-xs"
          : "min-h-8 rounded-md -ml-1 px-1 text-sm",
      )}
      onClick={() => onOpenNode(nodeId)}
      aria-label={`Open ${label} in Process Flow`}
      data-flow-node-id={nodeId}
    >
      <span className="min-w-0 break-words">{label}</span>
      <ArrowUpRight
        className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 motion-reduce:transform-none"
        aria-hidden="true"
      />
    </button>
  );
}

function HandoffsSection({
  items,
  reportedCount,
  onOpenNode,
}: {
  items: HandoffItem[];
  reportedCount: number;
  onOpenNode: (nodeId: string) => void;
}) {
  return (
    <InsightSection
      icon={ArrowRightLeft}
      title="Handoffs"
      count={pluralize(reportedCount, "signal")}
    >
      {items.length === 0 ? (
        <SectionEmpty message="No handoff steps or actor-change edges are present in this generated flow." />
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.id} className="rounded-lg border bg-muted/10 p-3">
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-start">
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    Source step
                  </p>
                  <FlowNodeLink
                    nodeId={item.source.id}
                    label={item.source.label}
                    onOpenNode={onOpenNode}
                  />
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {actorList(item.source)}
                  </p>
                </div>
                <ArrowRight className="hidden size-4 text-muted-foreground md:block" />
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    Target step
                  </p>
                  <FlowNodeLink
                    nodeId={item.target.id}
                    label={item.target.label}
                    onOpenNode={onOpenNode}
                  />
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {actorList(item.target)}
                  </p>
                </div>
              </div>
              <div className="mt-3 space-y-2 border-t pt-3">
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                    Actors involved
                  </p>
                  <PillList values={item.actors} />
                </div>
                {item.edge?.label && (
                  <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                    <Badge
                      variant="outline"
                      className="h-auto whitespace-normal"
                    >
                      {item.edge.label}
                    </Badge>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </InsightSection>
  );
}

function ToolsSection({
  tools,
  heavyAreas,
  reportedToolCount,
  onOpenNode,
}: {
  tools: ToolUsage[];
  heavyAreas: HeavyArea[];
  reportedToolCount: number;
  onOpenNode: (nodeId: string) => void;
}) {
  return (
    <InsightSection
      icon={Monitor}
      title="Tools And Systems"
      count={pluralize(reportedToolCount, "tool")}
    >
      <div className="space-y-4">
        {tools.length === 0 ? (
          <SectionEmpty message="No tools or systems are attached to the generated flow nodes." />
        ) : (
          <div className="space-y-3">
            {tools.map((tool) => (
              <div
                key={tool.name}
                className="border-b pb-3 last:border-b-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="break-words text-sm font-medium">{tool.name}</p>
                  <Badge variant="secondary">
                    {pluralize(tool.steps.length, "step")}
                  </Badge>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {tool.steps.map((step) => (
                    <FlowNodeLink
                      key={`${tool.name}-${step.id}`}
                      nodeId={step.id}
                      label={step.label}
                      onOpenNode={onOpenNode}
                      compact
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="rounded-lg border bg-muted/10 p-3">
          <p className="text-xs font-medium uppercase text-muted-foreground">
            Tool-heavy or handoff-heavy areas
          </p>
          {heavyAreas.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              No concentrated tool or handoff areas were detected.
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              {heavyAreas.slice(0, 6).map((area) => (
                <div key={area.node.id} className="min-w-0">
                  <FlowNodeLink
                    nodeId={area.node.id}
                    label={area.node.label}
                    onOpenNode={onOpenNode}
                  />
                  <p className="text-xs text-muted-foreground">
                    {pluralize(area.toolCount, "tool")} and{" "}
                    {pluralize(area.handoffSignals, "handoff signal")}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </InsightSection>
  );
}

function BottlenecksSection({
  nodes,
  onOpenNode,
}: {
  nodes: FlowNode[];
  onOpenNode: (nodeId: string) => void;
}) {
  return (
    <InsightSection
      icon={FileWarning}
      title="Bottlenecks"
      count={pluralize(nodes.length, "step")}
    >
      {nodes.length === 0 ? (
        <SectionEmpty message="No bottleneck nodes are marked in this generated flow." />
      ) : (
        <div className="space-y-3">
          {nodes.map((node) => (
            <div key={node.id} className="rounded-lg border bg-muted/10 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <FlowNodeLink
                  nodeId={node.id}
                  label={node.label}
                  onOpenNode={onOpenNode}
                />
                <NodeBadge node={node} />
                <Badge
                  variant="outline"
                  className={CONFIDENCE_LABELS[node.confidence].className}
                >
                  {CONFIDENCE_LABELS[node.confidence].label} confidence
                </Badge>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <DetailBlock label="Pain points">
                  <BulletList
                    items={node.painPoints}
                    empty="No pain point text attached"
                  />
                </DetailBlock>
                <DetailBlock label="Duration signals">
                  <p className="break-words text-sm text-muted-foreground">
                    {node.estimatedDuration ?? "No duration signal attached"}
                  </p>
                </DetailBlock>
                <DetailBlock label="Sources">
                  <PillList values={node.sources} variant="outline" />
                </DetailBlock>
              </div>
            </div>
          ))}
        </div>
      )}
    </InsightSection>
  );
}

function AutomationSection({
  opportunities,
  opportunityDetails,
  flowLevelCount,
  candidates,
  allNodes,
  onOpenNode,
}: {
  opportunities: string[];
  opportunityDetails?: AutomationOpportunity[];
  /** Same value the Automation tile and the Process Flow bottom bar show. */
  flowLevelCount: number;
  candidates: FlowNode[];
  allNodes: FlowNode[];
  onOpenNode: (nodeId: string) => void;
}) {
  const nodeMap = getNodeMap(allNodes);
  // Reported apart, never summed: a flow-level recommendation cites the steps it
  // covers, so most of them are already counted among the node-level candidates.
  // Adding the two produced a total larger than the number of distinct findings.
  return (
    <InsightSection
      icon={Bot}
      title="Automation Opportunities"
      count={`${flowLevelCount} recommended · ${pluralize(candidates.length, "candidate")}`}
    >
      <div className="space-y-4">
        <div className="rounded-lg border bg-muted/10 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Recommended automations
            </p>
            <Badge variant="outline">Recommendation-only</Badge>
          </div>
          {opportunityDetails && opportunityDetails.length > 0 ? (
            <div className="mt-3 space-y-3">
              {opportunityDetails.map((opportunity) => (
                <article
                  key={`${opportunity.kind}:${opportunity.title}`}
                  className="border-t pt-3 first:border-t-0 first:pt-0"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{opportunity.title}</p>
                    <Badge variant="outline" className="capitalize">
                      {opportunity.kind}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                    {opportunity.rationale}
                  </p>
                  {opportunity.expectedBenefit && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Expected benefit: {opportunity.expectedBenefit}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {opportunity.nodeIds.map((nodeId) => {
                      const node = nodeMap.get(nodeId);
                      return node ? (
                        <FlowNodeLink
                          key={nodeId}
                          nodeId={nodeId}
                          label={node.label}
                          onOpenNode={onOpenNode}
                          compact
                        />
                      ) : null;
                    })}
                  </div>
                </article>
              ))}
            </div>
          ) : opportunities.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              No automation recommendations are listed.
            </p>
          ) : (
            <BulletList items={opportunities} className="mt-2" />
          )}
        </div>

        {candidates.length === 0 ? (
          <SectionEmpty message="No node-level automation potential is marked above none." />
        ) : (
          <div className="space-y-3">
            {candidates.map((node) => (
              <div key={node.id} className="rounded-lg border bg-muted/10 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <FlowNodeLink
                    nodeId={node.id}
                    label={node.label}
                    onOpenNode={onOpenNode}
                  />
                  <Badge
                    variant="outline"
                    className={
                      AUTOMATION_LABELS[node.automationPotential].className
                    }
                  >
                    {AUTOMATION_LABELS[node.automationPotential].label}{" "}
                    potential
                  </Badge>
                </div>
                {(node.tools.length > 0 || node.sources.length > 0) && (
                  <div className="mt-3 space-y-2">
                    {node.tools.length > 0 && (
                      <PillList values={node.tools} variant="outline" />
                    )}
                    {node.sources.length > 0 && (
                      <PillList values={node.sources} variant="outline" />
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </InsightSection>
  );
}

function TribalKnowledgeSection({
  nodes,
  onOpenNode,
}: {
  nodes: FlowNode[];
  onOpenNode: (nodeId: string) => void;
}) {
  return (
    <InsightSection
      icon={KeyRound}
      title="Tribal Knowledge Risk"
      count={pluralize(nodes.length, "step")}
    >
      {nodes.length === 0 ? (
        <SectionEmpty message="No flow nodes are marked as tribal knowledge risks." />
      ) : (
        <div className="space-y-3">
          {nodes.map((node) => (
            <div key={node.id} className="rounded-lg border bg-muted/10 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <FlowNodeLink
                  nodeId={node.id}
                  label={node.label}
                  onOpenNode={onOpenNode}
                />
                <Badge
                  variant="outline"
                  className={CONFIDENCE_LABELS[node.confidence].className}
                >
                  {CONFIDENCE_LABELS[node.confidence].label} confidence
                </Badge>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <DetailBlock label="Risk indicators">
                  <BulletList
                    items={node.riskIndicators}
                    empty="No risk indicator text attached"
                  />
                </DetailBlock>
                <DetailBlock label="Sources">
                  <PillList values={node.sources} variant="outline" />
                </DetailBlock>
              </div>
            </div>
          ))}
        </div>
      )}
    </InsightSection>
  );
}

function DecisionPointsSection({
  nodes,
  edges,
  onOpenNode,
}: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  onOpenNode: (nodeId: string) => void;
}) {
  const nodeMap = getNodeMap(nodes);
  const decisionNodes = nodes.filter((node) => node.category === "decision");

  return (
    <InsightSection
      icon={Split}
      title="Decision Points"
      count={pluralize(decisionNodes.length, "decision")}
    >
      {decisionNodes.length === 0 ? (
        <SectionEmpty message="No decision nodes are present in this generated flow." />
      ) : (
        <div className="space-y-3">
          {decisionNodes.map((node) => {
            const branches = deriveDecisionBranches(node, edges);
            return (
              <div key={node.id} className="rounded-lg border bg-muted/10 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <FlowNodeLink
                    nodeId={node.id}
                    label={node.label}
                    onOpenNode={onOpenNode}
                  />
                  <Badge
                    variant="outline"
                    className={CONFIDENCE_LABELS[node.confidence].className}
                  >
                    {CONFIDENCE_LABELS[node.confidence].label} confidence
                  </Badge>
                </div>
                {branches.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    No branch edges are attached to this decision.
                  </p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {branches.map((edge) => {
                      const target = nodeMap.get(edge.target);
                      return (
                        <div
                          key={edge.id}
                          className="flex min-w-0 flex-col gap-1 rounded-lg border bg-background p-2 text-sm md:flex-row md:items-center md:justify-between"
                        >
                          <div className="min-w-0">
                            <p className="break-words font-medium">
                              {edge.label ?? edge.type}
                            </p>
                            {target ? (
                              <FlowNodeLink
                                nodeId={target.id}
                                label={`To ${target.label}`}
                                onOpenNode={onOpenNode}
                                compact
                              />
                            ) : (
                              <p className="break-words text-xs text-muted-foreground">
                                To {edge.target}
                              </p>
                            )}
                          </div>
                          <Badge variant="outline" className="w-fit">
                            {edge.isHappyPath ? "Happy path" : "Exception path"}
                          </Badge>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </InsightSection>
  );
}

function EvidenceCoverageSection({
  nodes,
  completedConversationCount,
  flowConversationCount,
  onOpenNode,
}: {
  nodes: FlowNode[];
  completedConversationCount: number;
  flowConversationCount: number;
  onOpenNode: (nodeId: string) => void;
}) {
  const counts = deriveConfidenceCounts(nodes);
  const allSources = uniqueStrings(nodes.flatMap((node) => node.sources));
  const lowConfidenceNodes = nodes.filter((node) => node.confidence === "low");
  const totalNodes = Math.max(nodes.length, 1);

  return (
    <InsightSection
      icon={ShieldAlert}
      title="Evidence Coverage"
      count={`${flowConversationCount} of ${completedConversationCount} completed conversations`}
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="space-y-4">
          <div>
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Confidence distribution
            </p>
            <div className="mt-3 space-y-3">
              {(["high", "medium", "low"] as const).map((confidence) => {
                const count = counts[confidence];
                const percent = Math.round((count / totalNodes) * 100);
                return (
                  <div key={confidence}>
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span>{CONFIDENCE_LABELS[confidence].label}</span>
                      <span className="text-muted-foreground">
                        {count} nodes, {percent}%
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-org-accent"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-lg border bg-muted/10 p-3">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Low-confidence nodes
            </p>
            {lowConfidenceNodes.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                No low-confidence nodes are marked.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {lowConfidenceNodes.map((node) => (
                  <div key={node.id} className="min-w-0">
                    <FlowNodeLink
                      nodeId={node.id}
                      label={node.label}
                      onOpenNode={onOpenNode}
                    />
                    <p className="break-words text-xs text-muted-foreground">
                      {node.sources.length > 0
                        ? node.sources.join(", ")
                        : "No source citation attached"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div>
          <p className="text-xs font-medium uppercase text-muted-foreground">
            Source citations
          </p>
          <div className="mt-3">
            {allSources.length === 0 ? (
              <SectionEmpty message="No source citations are attached to the generated nodes." />
            ) : (
              <PillList values={allSources} variant="outline" />
            )}
          </div>
        </div>
      </div>
    </InsightSection>
  );
}

function DetailBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-xs font-medium uppercase text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function BulletList({
  items,
  empty,
  className,
}: {
  items: string[];
  empty?: string;
  className?: string;
}) {
  const values = uniqueStrings(items);

  if (values.length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        {empty ?? "None listed"}
      </p>
    );
  }

  return (
    <ul className={cn("space-y-1.5", className)}>
      {values.map((item) => (
        <li
          key={item}
          className="flex min-w-0 items-start gap-2 text-sm text-muted-foreground"
        >
          <span className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
          <span className="min-w-0 break-words">{item}</span>
        </li>
      ))}
    </ul>
  );
}

function FlowPendingState({
  title,
  description,
  icon: Icon,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
}) {
  return (
    <div className="p-4 md:p-6">
      <EmptyState
        icon={Icon}
        title={title}
        description={description}
        className="min-h-[22rem]"
      />
    </div>
  );
}

export function ProcessInsightsTab({
  processId,
  completedConversationCount,
  canGenerate,
  isActive,
  onOpenProcessFlow,
}: ProcessInsightsTabProps) {
  const flow = useQuery(
    api.processFlows.getProcessFlow,
    isActive ? { processId } : "skip",
  );
  const generateFlow = useAction(api.processFlows.generateProcessFlow);
  const [isGenerating, setIsGenerating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const hasCompletedConversations = completedConversationCount > 0;
  const handleGenerate = useCallback(async () => {
    if (!canGenerate || !hasCompletedConversations) return;

    setIsGenerating(true);
    setActionError(null);
    try {
      await generateFlow({ processId });
    } catch {
      setActionError("Failed to start flow generation. Please try again.");
    } finally {
      setIsGenerating(false);
    }
  }, [canGenerate, generateFlow, hasCompletedConversations, processId]);

  if (flow === undefined) return <LoadingInsights />;

  if (flow === null) {
    return (
      <div className="p-4 md:p-6">
        <EmptyState
          icon={GitBranch}
          title="No flow data yet"
          description="Generate the process flow before reviewing process-level insights."
          className="min-h-[22rem]"
          action={
            <div className="flex flex-col items-center gap-2">
              <GenerateFlowButton
                canGenerate={canGenerate}
                hasCompletedConversations={hasCompletedConversations}
                isGenerating={isGenerating}
                label="Generate Process Flow"
                onGenerate={handleGenerate}
                onOpenProcessFlow={onOpenProcessFlow}
              />
              {!hasCompletedConversations && canGenerate && (
                <p className="text-xs text-muted-foreground">
                  Record at least one completed conversation first.
                </p>
              )}
              {actionError && (
                <p className="max-w-sm text-xs text-destructive" role="alert">
                  {actionError}
                </p>
              )}
            </div>
          }
        />
      </div>
    );
  }

  // Both stages, not just `status`. Insights are computed from step details —
  // tools, bottlenecks, automation opportunities — none of which exist until the
  // detail batches and the automation pass have run, so rendering when the graph
  // lands would show a tab full of zeroes.
  const stage = flowStage(flow);
  if (stage === "graph" || stage === "details") {
    const progress = flowDetailProgress(flow);
    return (
      <FlowPendingState
        icon={Loader2}
        title="Generating process insights"
        description={
          stage === "graph"
            ? "The flow is being generated from completed conversations. Insights will appear once the flow is ready."
            : progress
              ? `Describing each step and identifying automation opportunities — ${progress.completed} of ${progress.total} steps done.`
              : "Describing each step and identifying automation opportunities."
        }
      />
    );
  }

  // A failed refresh keeps the previous flow, and its insights are a complete
  // earlier generation rather than a half-built one — so fall through and render
  // them under a banner. Only a first-ever failure has nothing to show.
  const showingRetained = hasRetainedPreviousFlow(flow, flow.nodes.length);
  if (stage === "failed" && !showingRetained) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        <EmptyState
          icon={AlertCircle}
          title="Flow generation failed"
          description={
            flow.errorMessage ??
            "The generated flow is required before process insights can be shown."
          }
          className="min-h-[22rem]"
          action={
            <div className="flex flex-col items-center gap-2">
              <GenerateFlowButton
                canGenerate={canGenerate}
                hasCompletedConversations={hasCompletedConversations}
                isGenerating={isGenerating}
                label="Try Again"
                onGenerate={handleGenerate}
                onOpenProcessFlow={onOpenProcessFlow}
              />
              {actionError && (
                <p className="max-w-sm text-xs text-destructive" role="alert">
                  {actionError}
                </p>
              )}
            </div>
          }
        />
      </div>
    );
  }

  if (flow.nodes.length === 0) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        <EmptyState
          icon={Workflow}
          title="Flow has no mapped steps"
          description="Regenerate the process flow to build insights from nodes, edges, and flow-level recommendations."
          className="min-h-[22rem]"
          action={
            <GenerateFlowButton
              canGenerate={canGenerate}
              hasCompletedConversations={hasCompletedConversations}
              isGenerating={isGenerating}
              label="Regenerate Flow"
              onGenerate={handleGenerate}
              onOpenProcessFlow={onOpenProcessFlow}
            />
          }
        />
      </div>
    );
  }

  const isStale =
    flow.stale || completedConversationCount > flow.conversationCount;
  const handoffs = deriveHandoffs(flow.nodes, flow.edges);
  const tools = deriveToolUsage(flow.nodes);
  const heavyAreas = deriveHeavyAreas(flow.nodes, handoffs);
  const bottlenecks = deriveBottlenecks(flow);
  const automationCandidates = deriveAutomationCandidates(flow.nodes);
  // The flow-level count the Process Flow bottom bar shows, computed once here so
  // the tile and the section badge cannot drift from each other or from the bar.
  // `automationOpportunities` is the field to read: `deriveFlowInsights` fills it
  // 1:1 from `automationOpportunityDetails` when the analysis ran, and from the
  // automatable-looking steps when it did not, so it is always populated.
  const flowLevelAutomationCount = flow.insights.automationOpportunities.length;
  const automationUnreviewed =
    flow.insights.automationOpportunitiesSource === "derived";
  const tribalKnowledgeNodes = flow.nodes.filter(
    (node) => node.isTribalKnowledge,
  );
  const decisionCount = flow.nodes.filter(
    (node) => node.category === "decision",
  ).length;
  const lowConfidenceCount = flow.nodes.filter(
    (node) => node.confidence === "low",
  ).length;
  const uniquePainPoints = uniqueStrings(
    flow.nodes.flatMap((node) => node.painPoints),
  );
  const nodeMap = getNodeMap(flow.nodes);
  const criticalPathNodes = flow.insights.criticalPath.flatMap((nodeId) => {
    const node = nodeMap.get(nodeId);
    return node ? [node] : [];
  });

  return (
    <div className="min-h-full bg-muted/20">
      <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
        <header className="rounded-lg border bg-background p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <BarChart3
                  className="size-4 text-muted-foreground"
                  aria-hidden
                />
                <h2 className="text-base font-semibold">Process Insights</h2>
                <Badge variant="outline" className="capitalize">
                  {flow.status}
                </Badge>
                {isStale && (
                  <Badge
                    variant="outline"
                    className="border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
                  >
                    Stale
                  </Badge>
                )}
              </div>
              <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 break-words">
                  Generated {formatGeneratedAt(flow.generatedAt)}
                </span>
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {isStale && (
                <GenerateFlowButton
                  canGenerate={canGenerate}
                  hasCompletedConversations={hasCompletedConversations}
                  isGenerating={isGenerating}
                  label="Refresh Insights"
                  onGenerate={handleGenerate}
                  onOpenProcessFlow={onOpenProcessFlow}
                />
              )}
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => onOpenProcessFlow()}
              >
                <GitBranch className="size-4" aria-hidden />
                View Flow
              </Button>
            </div>
          </div>
        </header>

        {showingRetained && (
          <InlineNotice
            icon={AlertCircle}
            title="Couldn't refresh — showing the previous version"
            action={
              <GenerateFlowButton
                canGenerate={canGenerate}
                hasCompletedConversations={hasCompletedConversations}
                isGenerating={isGenerating}
                label="Try Again"
                onGenerate={handleGenerate}
                onOpenProcessFlow={onOpenProcessFlow}
              />
            }
          >
            {flow.errorMessage ?? "The last generation did not complete."} These
            insights come from the previous generation, which covered{" "}
            {flow.conversationCount} completed conversations.
          </InlineNotice>
        )}

        {!showingRetained && flowHasIncompleteDetails(flow) && (
          <InlineNotice
            icon={FileWarning}
            title="Some steps could not be described"
            action={
              <GenerateFlowButton
                canGenerate={canGenerate}
                hasCompletedConversations={hasCompletedConversations}
                isGenerating={isGenerating}
                label="Regenerate"
                onGenerate={handleGenerate}
                onOpenProcessFlow={onOpenProcessFlow}
              />
            }
          >
            {flow.detailErrorMessage ??
              "Not every step in this flow has a description."}{" "}
            The diagram and the metrics below cover only the steps that were
            described, so treat the counts as a floor rather than a total.
            {flow.insights.automationOpportunitiesSource === "derived" && (
              <>
                {" "}
                Automation opportunities were not analysed for this run — what
                is listed is the steps that looked automatable, not reviewed
                opportunities.
              </>
            )}
          </InlineNotice>
        )}

        {isStale && (
          <InlineNotice
            icon={AlertCircle}
            title="Insights may be based on stale flow data"
            action={
              <GenerateFlowButton
                canGenerate={canGenerate}
                hasCompletedConversations={hasCompletedConversations}
                isGenerating={isGenerating}
                label="Refresh"
                onGenerate={handleGenerate}
                onOpenProcessFlow={onOpenProcessFlow}
              />
            }
          >
            {/* Two different reasons reach this notice, and asserting the
                count one when the counts are equal reads as a bug. Say which
                one it actually is. */}
            {completedConversationCount === flow.conversationCount
              ? "This process has been updated since the flow was generated. Refresh the flow before using these insights for review."
              : `The generated flow includes ${flow.conversationCount} completed conversations, while this process currently has ${completedConversationCount}. Refresh the flow before using these insights for review.`}
          </InlineNotice>
        )}

        {actionError && (
          <InlineNotice
            icon={AlertCircle}
            title="Refresh did not start"
            tone="destructive"
          >
            {actionError}
          </InlineNotice>
        )}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile
            icon={Users}
            label="Evidence"
            value={flow.conversationCount}
            detail={`${flow.conversationCount} of ${completedConversationCount} completed conversations`}
            accent
          />
          <MetricTile
            icon={Workflow}
            label="Mapped Steps"
            value={flow.nodes.length}
            detail={`${pluralize(flow.edges.length, "connection")} mapped`}
          />
          <MetricTile
            icon={ArrowRightLeft}
            label="Handoffs"
            value={flow.insights.handoffCount}
            detail={`${handoffs.length} related edges or nodes shown`}
          />
          <MetricTile
            icon={Monitor}
            label="Tools"
            value={flow.insights.toolCount}
            detail={`${pluralize(tools.length, "unique tool")} derived from nodes`}
          />
          <MetricTile
            icon={Split}
            label="Decisions"
            value={decisionCount}
            detail="Branching or conditional nodes"
          />
          <MetricTile
            icon={FileWarning}
            label="Bottlenecks"
            value={bottlenecks.length}
            detail={`${pluralize(uniquePainPoints.length, "pain point")} attached`}
          />
          <MetricTile
            icon={Bot}
            label="Automations"
            value={flowLevelAutomationCount}
            detail={
              automationUnreviewed
                ? "Possible only — not analysed"
                : "Recommended automations"
            }
          />
          <MetricTile
            icon={ShieldAlert}
            label="Low Confidence"
            value={lowConfidenceCount}
            detail="Nodes marked inferred or weak"
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <HandoffsSection
            items={handoffs}
            reportedCount={flow.insights.handoffCount}
            onOpenNode={onOpenProcessFlow}
          />
          <ToolsSection
            tools={tools}
            heavyAreas={heavyAreas}
            reportedToolCount={flow.insights.toolCount}
            onOpenNode={onOpenProcessFlow}
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <BottlenecksSection
            nodes={bottlenecks}
            onOpenNode={onOpenProcessFlow}
          />
          <AutomationSection
            opportunities={flow.insights.automationOpportunities}
            opportunityDetails={flow.insights.automationOpportunityDetails}
            flowLevelCount={flowLevelAutomationCount}
            candidates={automationCandidates}
            allNodes={flow.nodes}
            onOpenNode={onOpenProcessFlow}
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <TribalKnowledgeSection
            nodes={tribalKnowledgeNodes}
            onOpenNode={onOpenProcessFlow}
          />
          <DecisionPointsSection
            nodes={flow.nodes}
            edges={flow.edges}
            onOpenNode={onOpenProcessFlow}
          />
        </div>

        <EvidenceCoverageSection
          nodes={flow.nodes}
          completedConversationCount={completedConversationCount}
          flowConversationCount={flow.conversationCount}
          onOpenNode={onOpenProcessFlow}
        />

        {flow.insights.totalEstimatedDuration && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-background p-3 text-sm text-muted-foreground">
            <Timer className="size-4 shrink-0" aria-hidden />
            <span className="font-medium text-foreground">
              Estimated duration:
            </span>
            <span className="break-words">
              {flow.insights.totalEstimatedDuration}
            </span>
          </div>
        )}

        {criticalPathNodes.length > 0 && (
          <div className="rounded-lg border bg-background p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <Workflow className="size-4 text-muted-foreground" aria-hidden />
              Critical path
            </div>
            <div className="flex flex-wrap gap-2">
              {criticalPathNodes.map((node) => (
                <FlowNodeLink
                  key={node.id}
                  nodeId={node.id}
                  label={node.label}
                  onOpenNode={onOpenProcessFlow}
                  compact
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
