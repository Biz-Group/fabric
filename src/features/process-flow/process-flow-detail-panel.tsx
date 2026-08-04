"use client";

import {
  X,
  AlertTriangle,
  KeyRound,
  Bot,
  Clock,
  Users,
  Monitor,
  MessageSquareWarning,
  ShieldAlert,
  ArrowRight,
  ArrowLeft,
  Loader2,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CATEGORY_CONFIG } from "./process-flow-nodes";
import type { ReadFlowNode } from "./use-process-flow-layout";
import type { Doc } from "../../../convex/_generated/dataModel";

type FlowEdge = Doc<"processFlows">["edges"][number];
type FlowNode = ReadFlowNode;

interface ProcessFlowDetailPanelProps {
  node: FlowNode;
  edges: FlowEdge[];
  allNodes: FlowNode[];
  onClose: () => void;
  onNavigate: (nodeId: string) => void;
  /** Re-requests this step's description. Absent for viewers. */
  onRetryDetail?: () => void | Promise<void>;
  isRetryingDetail?: boolean;
}

const AUTOMATION_LABELS = {
  high: {
    label: "High",
    className:
      "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
  },
  medium: {
    label: "Medium",
    className:
      "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20",
  },
  low: {
    label: "Low",
    className:
      "bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20",
  },
  none: {
    label: "None",
    className: "bg-muted text-muted-foreground border-border",
  },
} as const;

const CONFIDENCE_LABELS = {
  high: {
    label: "High — confirmed by multiple sources",
    className: "text-green-600 dark:text-green-400",
  },
  medium: {
    label: "Medium — single clear source",
    className: "text-yellow-600 dark:text-yellow-400",
  },
  low: {
    label: "Low — inferred or vague",
    className: "text-red-600 dark:text-red-400",
  },
} as const;

export function ProcessFlowDetailPanel({
  node,
  edges,
  allNodes,
  onClose,
  onNavigate,
  onRetryDetail,
  isRetryingDetail = false,
}: ProcessFlowDetailPanelProps) {
  const config = CATEGORY_CONFIG[node.category];
  const { Icon } = config;

  // Absent means a legacy flow, detailed inline by the single call.
  const detailStatus = node.detailStatus ?? "ready";
  const isDetailed = detailStatus === "ready";
  const detailPending =
    detailStatus === "pending" || detailStatus === "generating";

  // Find connected nodes
  const incomingEdges = edges.filter((e) => e.target === node.id);
  const outgoingEdges = edges.filter((e) => e.source === node.id);
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

  const automationInfo = AUTOMATION_LABELS[node.automationPotential];
  const confidenceInfo = CONFIDENCE_LABELS[node.confidence];

  return (
    <div className="flex h-full w-full flex-col overflow-hidden border-l border-border bg-background md:w-[320px]">
      {/* Header */}
      <div className="flex items-start gap-2 border-b border-border p-4">
        <div
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            config.iconBg,
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-sm font-medium leading-tight">
            {node.label}
          </h3>
          <div className="mt-1 flex flex-wrap gap-1">
            <span
              className={cn(
                "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                config.badgeClass,
              )}
            >
              {config.label}
            </span>
            {/* Withheld until described: these flags are assessments, and a
                node still being written carries defaults nobody assessed. */}
            {isDetailed && node.isBottleneck && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
                <AlertTriangle className="h-2.5 w-2.5" />
                Bottleneck
              </span>
            )}
            {isDetailed && node.isTribalKnowledge && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                <KeyRound className="h-2.5 w-2.5" />
                Tribal Knowledge
              </span>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 shrink-0 p-0"
          onClick={onClose}
          aria-label="Close node details"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 p-4">
          {/* Description, or why there isn't one yet. The connections below stay
              available in every state — the topology is settled even while the
              descriptions are still being written. */}
          {isDetailed ? (
            <div>
              <p className="break-words text-sm leading-relaxed text-muted-foreground">
                {node.description}
              </p>
            </div>
          ) : detailPending ? (
            <div className="text-muted-foreground flex items-start gap-2 text-sm">
              <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
              <p>Describing this step from what contributors said…</p>
            </div>
          ) : (
            <div className="border-border bg-muted/40 space-y-2 rounded-lg border p-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">No description</p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {node.detailErrorMessage ??
                      "This step could not be described."}
                  </p>
                </div>
              </div>
              {onRetryDetail && (
                // One step, not the whole flow: regenerating to recover a
                // single description would re-describe every other step and
                // re-run the automation analysis.
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-full gap-1.5 text-xs"
                  onClick={() => void onRetryDetail()}
                  disabled={isRetryingDetail}
                >
                  {isRetryingDetail ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3" />
                  )}
                  {isRetryingDetail ? "Retrying" : "Retry this step"}
                </Button>
              )}
            </div>
          )}

          {/* Actors */}
          {node.actors.length > 0 && (
            <Section icon={Users} title="Actors">
              <div className="flex flex-wrap gap-1">
                {node.actors.map((actor) => (
                  <Badge
                    key={actor}
                    variant="secondary"
                    className="h-auto max-w-full whitespace-normal break-words text-xs"
                  >
                    {actor}
                  </Badge>
                ))}
              </div>
            </Section>
          )}

          {/* Tools */}
          {node.tools.length > 0 && (
            <Section icon={Monitor} title="Tools & Systems">
              <div className="flex flex-wrap gap-1">
                {node.tools.map((tool) => (
                  <Badge
                    key={tool}
                    variant="outline"
                    className="h-auto max-w-full whitespace-normal break-words text-xs"
                  >
                    {tool}
                  </Badge>
                ))}
              </div>
            </Section>
          )}

          {/* Duration */}
          {node.estimatedDuration && (
            <Section icon={Clock} title="Estimated Duration">
              <p className="text-sm">{node.estimatedDuration}</p>
            </Section>
          )}

          {/* Automation Potential. Hidden until described — these two render a
              value for every node, so a placeholder would read as an assessment
              rather than an absence. */}
          {isDetailed && (
            <Section icon={Bot} title="Automation Potential">
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                  automationInfo.className,
                )}
              >
                {automationInfo.label}
              </span>
            </Section>
          )}

          {/* Confidence */}
          {isDetailed && (
            <Section icon={Users} title="Confidence">
              <p className={cn("text-xs", confidenceInfo.className)}>
                {confidenceInfo.label}
              </p>
            </Section>
          )}

          {/* Pain Points */}
          {node.painPoints.length > 0 && (
            <Section icon={MessageSquareWarning} title="Pain Points">
              <ul className="space-y-1">
                {node.painPoints.map((pp, i) => (
                  <li
                    key={i}
                    className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground"
                  >
                    <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />
                    <span className="min-w-0 break-words">{pp}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Risk Indicators */}
          {node.riskIndicators.length > 0 && (
            <Section icon={ShieldAlert} title="Risk Indicators">
              <ul className="space-y-1">
                {node.riskIndicators.map((risk, i) => (
                  <li
                    key={i}
                    className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground"
                  >
                    <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                    <span className="min-w-0 break-words">{risk}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Sources */}
          {node.sources.length > 0 && (
            <Section icon={Users} title="Sources">
              <ul className="space-y-0.5">
                {node.sources.map((src, i) => (
                  <li
                    key={i}
                    className="break-words text-xs text-muted-foreground"
                  >
                    {src}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Connections */}
          {(incomingEdges.length > 0 || outgoingEdges.length > 0) && (
            <div className="space-y-2 border-t border-border pt-4">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Connections
              </h4>
              {incomingEdges.map((edge) => {
                const sourceNode = nodeMap.get(edge.source);
                if (!sourceNode) return null;
                return (
                  <button
                    key={edge.id}
                    onClick={() => onNavigate(edge.source)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-org-accent-subtle focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-org-accent-ring/35"
                    aria-label={`Navigate to source node ${sourceNode.label}`}
                  >
                    <ArrowLeft className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      From: {sourceNode.label}
                    </span>
                    {edge.label && (
                      <span className="ml-auto max-w-24 shrink-0 truncate text-[10px] italic text-muted-foreground">
                        {edge.label}
                      </span>
                    )}
                  </button>
                );
              })}
              {outgoingEdges.map((edge) => {
                const targetNode = nodeMap.get(edge.target);
                if (!targetNode) return null;
                return (
                  <button
                    key={edge.id}
                    onClick={() => onNavigate(edge.target)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-org-accent-subtle focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-org-accent-ring/35"
                    aria-label={`Navigate to target node ${targetNode.label}`}
                  >
                    <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      To: {targetNode.label}
                    </span>
                    {edge.label && (
                      <span className="ml-auto max-w-24 shrink-0 truncate text-[10px] italic text-muted-foreground">
                        {edge.label}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Small helper for consistent section rendering
function Section({
  icon: IconComp,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <h4 className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <IconComp className="h-3 w-3 shrink-0" />
        <span className="min-w-0 break-words">{title}</span>
      </h4>
      {children}
    </div>
  );
}
