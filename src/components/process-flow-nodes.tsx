"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Play,
  Square,
  Zap,
  GitBranch,
  ArrowRightLeft,
  Clock,
  AlertTriangle,
  KeyRound,
  Bot,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ProcessFlowNodeData } from "@/hooks/use-process-flow-layout";

// Category config: color, icon, label
const CATEGORY_CONFIG = {
  start: {
    color: "border-l-emerald-500",
    iconBg: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    badgeClass: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    Icon: Play,
    label: "Start",
  },
  end: {
    color: "border-l-slate-500",
    iconBg: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
    badgeClass: "bg-slate-500/10 text-slate-700 dark:text-slate-400",
    Icon: Square,
    label: "End",
  },
  action: {
    color: "border-l-blue-500",
    iconBg: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    badgeClass: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
    Icon: Zap,
    label: "Action",
  },
  decision: {
    color: "border-l-amber-500",
    iconBg: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    badgeClass: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    Icon: GitBranch,
    label: "Decision",
  },
  handoff: {
    color: "border-l-violet-500",
    iconBg: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    badgeClass: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
    Icon: ArrowRightLeft,
    label: "Handoff",
  },
  wait: {
    color: "border-l-orange-500",
    iconBg: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
    badgeClass: "bg-orange-500/10 text-orange-700 dark:text-orange-400",
    Icon: Clock,
    label: "Wait",
  },
} as const;

const AUTOMATION_COLORS = {
  high: "bg-green-500/10 text-green-700 dark:text-green-400",
  medium: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
  low: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  none: "",
} as const;

function FlowNodeBase({ data, selected }: NodeProps & { data: ProcessFlowNodeData }) {
  const config = CATEGORY_CONFIG[data.category];
  const { Icon } = config;

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-border !w-2 !h-2" />
      <div
        className={cn(
          "w-[280px] rounded-lg border border-border bg-card/80 backdrop-blur-sm text-card-foreground shadow-sm border-l-[3px] transition-all duration-200",
          config.color,
          selected && "ring-2 ring-primary shadow-lg scale-[1.02]",
          !selected && !data.dimmed && "hover:shadow-md",
          data.dimmed && "opacity-40",
        )}
      >
        {/* Header */}
        <div className="flex items-start gap-2 p-3 pb-1">
          <div className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md", config.iconBg)}>
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium leading-tight">{data.label}</div>
          </div>
        </div>

        {/* Badges row */}
        <div className="flex flex-wrap items-center gap-1 px-3 pb-1">
          <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium", config.badgeClass)}>
            {config.label}
          </span>
          {data.confidence !== "high" && (
            <span className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {data.confidence} conf.
            </span>
          )}
          {data.automationPotential !== "none" && (
            <span className={cn("inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium", AUTOMATION_COLORS[data.automationPotential])}>
              <Bot className="h-2.5 w-2.5" />
              {data.automationPotential}
            </span>
          )}
        </div>

        {/* Description */}
        <div className="px-3 pb-2">
          <p className="line-clamp-2 text-xs text-muted-foreground leading-relaxed">
            {data.description}
          </p>
        </div>

        {/* Indicator icons row */}
        {(data.isBottleneck || data.isTribalKnowledge || data.estimatedDuration) && (
          <div className="flex items-center gap-2 border-t border-border/50 px-3 py-1.5">
            {data.isBottleneck && (
              <span className="flex items-center gap-0.5 text-[10px] text-red-600 dark:text-red-400">
                <AlertTriangle className="h-2.5 w-2.5" />
                bottleneck
              </span>
            )}
            {data.isTribalKnowledge && (
              <span className="flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                <KeyRound className="h-2.5 w-2.5" />
                tribal
              </span>
            )}
            {data.estimatedDuration && (
              <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground ml-auto">
                <Clock className="h-2.5 w-2.5" />
                {data.estimatedDuration}
              </span>
            )}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-border !w-2 !h-2" />
      {/* Decision nodes get left/right handles for conditional branches */}
      {data.category === "decision" && (
        <>
          <Handle type="source" position={Position.Left} id="left" className="!bg-border !w-2 !h-2" />
          <Handle type="source" position={Position.Right} id="right" className="!bg-border !w-2 !h-2" />
        </>
      )}
    </>
  );
}

// Create memoized node components for each category
// React Flow requires stable nodeTypes — each registered type maps to a component
const StartNode = memo((props: NodeProps) => <FlowNodeBase {...props} data={props.data as unknown as ProcessFlowNodeData} />);
StartNode.displayName = "StartNode";

const EndNode = memo((props: NodeProps) => <FlowNodeBase {...props} data={props.data as unknown as ProcessFlowNodeData} />);
EndNode.displayName = "EndNode";

const ActionNode = memo((props: NodeProps) => <FlowNodeBase {...props} data={props.data as unknown as ProcessFlowNodeData} />);
ActionNode.displayName = "ActionNode";

const DecisionNode = memo((props: NodeProps) => <FlowNodeBase {...props} data={props.data as unknown as ProcessFlowNodeData} />);
DecisionNode.displayName = "DecisionNode";

const HandoffNode = memo((props: NodeProps) => <FlowNodeBase {...props} data={props.data as unknown as ProcessFlowNodeData} />);
HandoffNode.displayName = "HandoffNode";

const WaitNode = memo((props: NodeProps) => <FlowNodeBase {...props} data={props.data as unknown as ProcessFlowNodeData} />);
WaitNode.displayName = "WaitNode";

/**
 * Node types registry — must be defined outside of render to avoid re-creating on every render.
 * Matches the `category` values in the processFlows schema.
 */
export const nodeTypes = {
  start: StartNode,
  end: EndNode,
  action: ActionNode,
  decision: DecisionNode,
  handoff: HandoffNode,
  wait: WaitNode,
} as const;

export { CATEGORY_CONFIG };
