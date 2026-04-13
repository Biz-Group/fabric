"use client";

import { useState, useCallback, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQuery } from "convex/react";
import { useAction } from "convex/react";
import {
  GitBranch,
  Loader2,
  AlertCircle,
  Maximize2,
  Minimize2,
  Sparkles,
  RefreshCw,
  BarChart3,
  Bot,
  ArrowRightLeft,
  Wrench,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { nodeTypes } from "./process-flow-nodes";
import { useProcessFlowLayout } from "@/hooks/use-process-flow-layout";
import { ProcessFlowDetailPanel } from "./process-flow-detail-panel";

interface ProcessFlowProps {
  processId: Id<"processes">;
  conversationCount: number;
}

function ProcessFlowInner({ processId, conversationCount }: ProcessFlowProps) {
  const isMobile = useIsMobile();
  const flow = useQuery(api.processFlows.getProcessFlow, { processId });
  const generateFlow = useAction(api.processFlows.generateProcessFlow);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const { nodes, edges } = useProcessFlowLayout(flow, selectedNodeId);
  const { fitView, setCenter } = useReactFlow();

  const [isGenerating, setIsGenerating] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedNode = selectedNodeId
    ? flow?.nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;

  const handleGenerate = useCallback(async () => {
    setIsGenerating(true);
    setError(null);
    try {
      await generateFlow({ processId });
    } catch (e) {
      setError("Failed to start flow generation. Please try again.");
    } finally {
      setIsGenerating(false);
    }
  }, [generateFlow, processId]);

  const handleNodeClick = useCallback((_event: React.MouseEvent, node: { id: string }) => {
    setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
  }, []);

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  const handleNavigateToNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    const targetNode = nodes.find((n) => n.id === nodeId);
    if (targetNode) {
      setCenter(targetNode.position.x + 140, targetNode.position.y + 60, { zoom: 1, duration: 400 });
    }
  }, [nodes, setCenter]);

  const isStale = flow?.status === "ready" && flow.stale;
  const hasNewerConversations = flow?.status === "ready" && conversationCount > flow.conversationCount;

  // Empty state: no flow generated yet
  if (!flow || flow === undefined) {
    // Still loading from Convex
    if (flow === undefined) {
      return (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      );
    }
    return <EmptyState onGenerate={handleGenerate} isGenerating={isGenerating} hasConversations={conversationCount > 0} />;
  }

  // Generating state
  if (flow.status === "generating") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <GitBranch className="h-10 w-10 text-muted-foreground/40" />
            <Loader2 className="absolute -bottom-1 -right-1 h-5 w-5 animate-spin text-primary" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium">Generating process flow...</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Analyzing conversations and mapping the process structure
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Failed state
  if (flow.status === "failed") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
        <div className="flex flex-col items-center gap-3">
          <AlertCircle className="h-10 w-10 text-muted-foreground/40" />
          <div className="text-center">
            <p className="text-sm font-medium">Flow generation failed</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {flow.errorMessage ?? "An unexpected error occurred."}
            </p>
          </div>
          <Button size="sm" onClick={handleGenerate} disabled={isGenerating} className="gap-2">
            {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Try Again
          </Button>
        </div>
      </div>
    );
  }

  // No flow data returned
  if (!flow) {
    return <EmptyState onGenerate={handleGenerate} isGenerating={isGenerating} hasConversations={conversationCount > 0} />;
  }

  // Ready state: render the flow
  const Wrapper = isFullscreen ? FullscreenWrapper : PassthroughWrapper;

  return (
    <Wrapper onClose={() => setIsFullscreen(false)}>
      <div className="relative flex flex-1">
        {/* Staleness banner */}
        {(isStale || hasNewerConversations) && (
          <div className="absolute left-3 top-3 z-10">
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs dark:border-amber-800 dark:bg-amber-950">
              <span className="text-amber-700 dark:text-amber-400">New data available</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                onClick={handleGenerate}
                disabled={isGenerating}
              >
                {isGenerating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Refresh
              </Button>
            </div>
          </div>
        )}

        {/* Fullscreen toggle */}
        <div className="absolute right-3 top-3 z-10">
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setIsFullscreen(!isFullscreen)}
          >
            {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </Button>
        </div>

        {/* React Flow canvas */}
        <div className={cn("flex-1", selectedNode && !isMobile && "mr-[320px]")}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={handleNodeClick}
            onPaneClick={handlePaneClick}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.3}
            maxZoom={2}
            nodesDraggable={false}
            nodesConnectable={false}
            panOnDrag
            zoomOnScroll={!isMobile}
            zoomOnPinch
            selectNodesOnDrag={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} size={1} className="!bg-background" />
            {!isMobile && (
              <MiniMap
                nodeColor={(n) => {
                  const colors: Record<string, string> = {
                    start: "#10b981",
                    end: "#64748b",
                    action: "#3b82f6",
                    decision: "#f59e0b",
                    handoff: "#8b5cf6",
                    wait: "#f97316",
                  };
                  return colors[n.type ?? "action"] ?? "#3b82f6";
                }}
                className="!bg-muted/50 !border-border"
                maskColor="rgba(0,0,0,0.1)"
              />
            )}
            <Controls
              showInteractive={false}
              className="!bg-background !border-border !shadow-sm [&>button]:!bg-background [&>button]:!border-border [&>button]:!text-foreground"
            />
          </ReactFlow>
        </div>

        {/* Detail panel (desktop) */}
        {selectedNode && !isMobile && (
          <div className="absolute right-0 top-0 h-full overflow-hidden">
            <ProcessFlowDetailPanel
              node={selectedNode}
              edges={flow.edges}
              allNodes={flow.nodes}
              onClose={() => setSelectedNodeId(null)}
              onNavigate={handleNavigateToNode}
            />
          </div>
        )}

        {/* Detail panel (mobile — bottom Sheet) */}
        {isMobile && (
          <Sheet open={!!selectedNode} onOpenChange={(open) => { if (!open) setSelectedNodeId(null); }}>
            <SheetContent side="bottom" className="h-[60vh] p-0" showCloseButton={false}>
              <SheetTitle className="sr-only">Node details</SheetTitle>
              {selectedNode && (
                <ProcessFlowDetailPanel
                  node={selectedNode}
                  edges={flow.edges}
                  allNodes={flow.nodes}
                  onClose={() => setSelectedNodeId(null)}
                  onNavigate={handleNavigateToNode}
                />
              )}
            </SheetContent>
          </Sheet>
        )}
      </div>

      {/* Insights bar at bottom */}
      {flow.insights && (
        <InsightsBar insights={flow.insights} nodeCount={flow.nodes.length} />
      )}
    </Wrapper>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function EmptyState({
  onGenerate,
  isGenerating,
  hasConversations,
}: {
  onGenerate: () => void;
  isGenerating: boolean;
  hasConversations: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted/60">
        <GitBranch className="h-8 w-8 text-muted-foreground/50" />
      </div>
      <div className="text-center">
        <p className="text-sm font-medium">No process flow yet</p>
        <p className="mt-1 max-w-[280px] text-xs text-muted-foreground">
          Generate a visual flow diagram from this process&apos;s conversations.
        </p>
      </div>
      <Button
        size="sm"
        onClick={onGenerate}
        disabled={isGenerating || !hasConversations}
        className="gap-2"
      >
        {isGenerating ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Generating...
          </>
        ) : (
          <>
            <Sparkles className="h-4 w-4" />
            Generate Process Flow
          </>
        )}
      </Button>
      {!hasConversations && (
        <p className="text-[11px] text-muted-foreground">
          Record at least one conversation first.
        </p>
      )}
    </div>
  );
}

function InsightsBar({
  insights,
  nodeCount,
}: {
  insights: {
    totalEstimatedDuration?: string;
    handoffCount: number;
    toolCount: number;
    automationOpportunities: string[];
    topBottlenecks: string[];
  };
  nodeCount: number;
}) {
  return (
    <div className="shrink-0 border-t border-border bg-muted/30 px-4 py-2">
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <BarChart3 className="h-3 w-3" />
          {nodeCount} steps
        </span>
        {insights.totalEstimatedDuration && (
          <span className="flex items-center gap-1">
            <Wrench className="h-3 w-3" />
            {insights.totalEstimatedDuration}
          </span>
        )}
        <span className="flex items-center gap-1">
          <ArrowRightLeft className="h-3 w-3" />
          {insights.handoffCount} handoff{insights.handoffCount !== 1 ? "s" : ""}
        </span>
        <span className="flex items-center gap-1">
          <Wrench className="h-3 w-3" />
          {insights.toolCount} tool{insights.toolCount !== 1 ? "s" : ""}
        </span>
        {insights.topBottlenecks.length > 0 && (
          <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
            <AlertTriangle className="h-3 w-3" />
            {insights.topBottlenecks.length} bottleneck{insights.topBottlenecks.length !== 1 ? "s" : ""}
          </span>
        )}
        {insights.automationOpportunities.length > 0 && (
          <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
            <Bot className="h-3 w-3" />
            {insights.automationOpportunities.length} automation opportunit{insights.automationOpportunities.length !== 1 ? "ies" : "y"}
          </span>
        )}
      </div>
    </div>
  );
}

function FullscreenWrapper({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {children}
    </div>
  );
}

function PassthroughWrapper({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col overflow-hidden">{children}</div>;
}

// ---------------------------------------------------------------------------
// Exported wrapper with ReactFlowProvider
// ---------------------------------------------------------------------------

export function ProcessFlow(props: ProcessFlowProps) {
  return (
    <ReactFlowProvider>
      <ProcessFlowInner {...props} />
    </ReactFlowProvider>
  );
}
