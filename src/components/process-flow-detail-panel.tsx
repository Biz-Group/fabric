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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CATEGORY_CONFIG } from "./process-flow-nodes";
import type { Doc } from "../../convex/_generated/dataModel";

type FlowNode = Doc<"processFlows">["nodes"][number];
type FlowEdge = Doc<"processFlows">["edges"][number];

interface ProcessFlowDetailPanelProps {
  node: FlowNode;
  edges: FlowEdge[];
  allNodes: FlowNode[];
  onClose: () => void;
  onNavigate: (nodeId: string) => void;
}

const AUTOMATION_LABELS = {
  high: { label: "High", className: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20" },
  medium: { label: "Medium", className: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20" },
  low: { label: "Low", className: "bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20" },
  none: { label: "None", className: "bg-muted text-muted-foreground border-border" },
} as const;

const CONFIDENCE_LABELS = {
  high: { label: "High — confirmed by multiple sources", className: "text-green-600 dark:text-green-400" },
  medium: { label: "Medium — single clear source", className: "text-yellow-600 dark:text-yellow-400" },
  low: { label: "Low — inferred or vague", className: "text-red-600 dark:text-red-400" },
} as const;

export function ProcessFlowDetailPanel({
  node,
  edges,
  allNodes,
  onClose,
  onNavigate,
}: ProcessFlowDetailPanelProps) {
  const config = CATEGORY_CONFIG[node.category];
  const { Icon } = config;

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
        <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", config.iconBg)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium leading-tight">{node.label}</h3>
          <div className="mt-1 flex flex-wrap gap-1">
            <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium", config.badgeClass)}>
              {config.label}
            </span>
            {node.isBottleneck && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
                <AlertTriangle className="h-2.5 w-2.5" />
                Bottleneck
              </span>
            )}
            {node.isTribalKnowledge && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                <KeyRound className="h-2.5 w-2.5" />
                Tribal Knowledge
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="sm" className="h-6 w-6 shrink-0 p-0" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 p-4">
          {/* Description */}
          <div>
            <p className="text-sm text-muted-foreground leading-relaxed">{node.description}</p>
          </div>

          {/* Actors */}
          {node.actors.length > 0 && (
            <Section icon={Users} title="Actors">
              <div className="flex flex-wrap gap-1">
                {node.actors.map((actor) => (
                  <Badge key={actor} variant="secondary" className="text-xs">{actor}</Badge>
                ))}
              </div>
            </Section>
          )}

          {/* Tools */}
          {node.tools.length > 0 && (
            <Section icon={Monitor} title="Tools & Systems">
              <div className="flex flex-wrap gap-1">
                {node.tools.map((tool) => (
                  <Badge key={tool} variant="outline" className="text-xs">{tool}</Badge>
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

          {/* Automation Potential */}
          <Section icon={Bot} title="Automation Potential">
            <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", automationInfo.className)}>
              {automationInfo.label}
            </span>
          </Section>

          {/* Confidence */}
          <Section icon={Users} title="Confidence">
            <p className={cn("text-xs", confidenceInfo.className)}>{confidenceInfo.label}</p>
          </Section>

          {/* Pain Points */}
          {node.painPoints.length > 0 && (
            <Section icon={MessageSquareWarning} title="Pain Points">
              <ul className="space-y-1">
                {node.painPoints.map((pp, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />
                    {pp}
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
                  <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                    {risk}
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
                  <li key={i} className="text-xs text-muted-foreground">{src}</li>
                ))}
              </ul>
            </Section>
          )}

          {/* Connections */}
          {(incomingEdges.length > 0 || outgoingEdges.length > 0) && (
            <div className="space-y-2 border-t border-border pt-4">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Connections</h4>
              {incomingEdges.map((edge) => {
                const sourceNode = nodeMap.get(edge.source);
                if (!sourceNode) return null;
                return (
                  <button
                    key={edge.id}
                    onClick={() => onNavigate(edge.source)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted transition-colors text-left"
                  >
                    <ArrowLeft className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">From: {sourceNode.label}</span>
                    {edge.label && (
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground italic">
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
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted transition-colors text-left"
                  >
                    <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">To: {targetNode.label}</span>
                    {edge.label && (
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground italic">
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
      <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <IconComp className="h-3 w-3" />
        {title}
      </h4>
      {children}
    </div>
  );
}
