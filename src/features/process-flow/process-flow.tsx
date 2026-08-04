"use client";

import { useState, useCallback, useEffect } from "react";
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
import { cn } from "@/lib/utils";
import {
  flowDetailProgress,
  flowStage,
  hasRetainedPreviousFlow,
} from "@/lib/flow-status";
import { useIsMobile } from "@/hooks/use-mobile";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { nodeTypes } from "./process-flow-nodes";
import { useProcessFlowLayout } from "@/features/process-flow/use-process-flow-layout";
import { ProcessFlowDetailPanel } from "./process-flow-detail-panel";

interface ProcessFlowProps {
  processId: Id<"processes">;
  conversationCount: number;
}

function ProcessFlowInner({ processId, conversationCount }: ProcessFlowProps) {
  const isMobile = useIsMobile();
  const flow = useQuery(api.processFlows.getProcessFlow, { processId });
  const generateFlow = useAction(api.processFlows.generateProcessFlow);
  const retryNodeDetail = useAction(api.processFlows.retryNodeDetail);
  const [retryingNodeId, setRetryingNodeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const { nodes, edges } = useProcessFlowLayout(flow, selectedNodeId);
  const { fitView, setCenter } = useReactFlow();

  const [isGenerating, setIsGenerating] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const selectedNode = selectedNodeId
    ? (flow?.nodes.find((n) => n.id === selectedNodeId) ?? null)
    : null;

  const handleGenerate = useCallback(async () => {
    setIsGenerating(true);
    setActionError(null);
    try {
      await generateFlow({ processId });
    } catch {
      setActionError("Failed to start flow generation. Please try again.");
    } finally {
      setIsGenerating(false);
    }
  }, [generateFlow, processId]);

  const handleRetryNodeDetail = useCallback(
    async (nodeId: string) => {
      setRetryingNodeId(nodeId);
      setActionError(null);
      try {
        await retryNodeDetail({ processId, nodeId });
      } catch {
        setActionError("Could not retry this step. Please try again.");
      } finally {
        // The node's own status carries the spinner from here; this only covers
        // the round trip that queues the work.
        setRetryingNodeId(null);
      }
    },
    [processId, retryNodeDetail],
  );

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: { id: string }) => {
      setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
    },
    [],
  );

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  const handleNavigateToNode = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId);
      const targetNode = nodes.find((n) => n.id === nodeId);
      if (targetNode) {
        setCenter(targetNode.position.x + 140, targetNode.position.y + 60, {
          zoom: 1,
          duration: 400,
        });
      }
    },
    [nodes, setCenter],
  );

  const isStale = flow?.status === "ready" && flow.stale;
  const hasNewerConversations =
    flow?.status === "ready" && conversationCount > flow.conversationCount;

  useEffect(() => {
    if (nodes.length === 0) return;
    const timeout = window.setTimeout(() => {
      void fitView({ padding: 0.15, duration: 250 });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [fitView, flow?.generatedAt, flow?.status, isFullscreen, nodes.length]);

  // Empty state: no flow generated yet
  if (flow === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (flow === null) {
    return (
      <EmptyState
        onGenerate={handleGenerate}
        isGenerating={isGenerating}
        hasConversations={conversationCount > 0}
        actionError={actionError}
      />
    );
  }

  // Only the graph stage blocks. Once the topology exists there is a diagram
  // worth looking at, and each node reports its own progress — so the wait
  // happens with the process on screen instead of behind a spinner.
  const stage = flowStage(flow);
  const detailProgress = flowDetailProgress(flow);
  if (stage === "graph") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <GitBranch className="h-10 w-10 text-muted-foreground/40" />
            <Loader2 className="text-org-accent absolute -right-1 -bottom-1 h-5 w-5 animate-spin" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium">Generating process flow...</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Analyzing conversations and mapping the process structure
            </p>
          </div>
        </div>
      </div>
    );
  }

  // A failed refresh keeps whatever flow was there before, so fall through and
  // render it with a banner. Only a first-ever generation that fails has nothing
  // underneath, and that is the one case that gets the error page.
  const showingRetained = hasRetainedPreviousFlow(flow, flow.nodes.length);
  if (stage === "failed" && !showingRetained) {
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
          {actionError && (
            <p
              className="max-w-sm text-center text-xs text-destructive"
              role="alert"
            >
              {actionError}
            </p>
          )}
          <Button
            size="sm"
            onClick={handleGenerate}
            disabled={isGenerating}
            className="gap-2"
          >
            {isGenerating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Try Again
          </Button>
        </div>
      </div>
    );
  }

  // Ready state: render the flow
  const Wrapper = isFullscreen ? FullscreenWrapper : PassthroughWrapper;

  return (
    <Wrapper>
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* Detail progress. Non-blocking by design: the diagram is usable while
            the descriptions land, and this says how much is still coming so an
            unfinished step reads as unfinished rather than empty. */}
        {stage === "details" && (
          <div className="absolute top-3 left-3 right-12 z-10 md:right-auto">
            <div className="border-border bg-card/90 flex max-w-full flex-wrap items-center gap-2 rounded-lg border px-3 py-1.5 text-xs backdrop-blur-sm">
              <Loader2 className="text-org-accent h-3 w-3 animate-spin" />
              <span className="text-muted-foreground">
                {detailProgress
                  ? `Describing steps — ${detailProgress.completed} of ${detailProgress.total}`
                  : "Describing steps"}
              </span>
            </div>
          </div>
        )}

        {/* A refresh that failed. Louder than the staleness banner because the
            user asked for something and did not get it — but the flow below is
            their real previous version, not a broken one. */}
        {showingRetained && (
          <div className="absolute top-3 left-3 right-12 z-10 md:right-auto">
            <div className="flex max-w-full flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs dark:border-amber-800 dark:bg-amber-950">
              <AlertCircle className="h-3 w-3 shrink-0 text-amber-700 dark:text-amber-400" />
              <span className="text-amber-700 dark:text-amber-400">
                Couldn&apos;t refresh — showing the previous version
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                onClick={handleGenerate}
                disabled={isGenerating}
              >
                {isGenerating ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                Try Again
              </Button>
            </div>
          </div>
        )}

        {/* Staleness banner */}
        {stage !== "details" &&
          !showingRetained &&
          (isStale || hasNewerConversations) && (
            <div className="absolute left-3 right-12 top-3 z-10 md:right-auto">
              <div className="flex max-w-full flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs dark:border-amber-800 dark:bg-amber-950">
                <span className="text-amber-700 dark:text-amber-400">
                  New data available
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-xs"
                  onClick={handleGenerate}
                  disabled={isGenerating}
                >
                  {isGenerating ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
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
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {isFullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>

        {actionError && (
          <div
            className="absolute left-3 top-14 z-10 max-w-sm rounded-lg border border-destructive/30 bg-background px-3 py-2 text-xs text-destructive shadow-sm"
            role="alert"
          >
            {actionError}
          </div>
        )}

        {/* React Flow canvas */}
        <div
          className={cn(
            "h-full min-h-0 min-w-0 flex-1",
            selectedNode && !isMobile && "mr-[320px]",
          )}
        >
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
              className="!bg-background !border-border !shadow-sm [&>button]:!bg-background [&>button]:!border-border [&>button]:!text-foreground [&>button:hover]:!bg-org-accent-subtle [&>button:focus-visible]:!outline-org-accent-ring"
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
              onRetryDetail={() => handleRetryNodeDetail(selectedNode.id)}
              isRetryingDetail={retryingNodeId === selectedNode.id}
            />
          </div>
        )}

        {/* Detail panel (mobile — bottom Sheet) */}
        {isMobile && (
          <Sheet
            open={!!selectedNode}
            onOpenChange={(open) => {
              if (!open) setSelectedNodeId(null);
            }}
          >
            <SheetContent
              side="bottom"
              className="h-[60vh] p-0"
              showCloseButton={false}
            >
              <SheetTitle className="sr-only">Node details</SheetTitle>
              {selectedNode && (
                <ProcessFlowDetailPanel
                  node={selectedNode}
                  edges={flow.edges}
                  allNodes={flow.nodes}
                  onClose={() => setSelectedNodeId(null)}
                  onNavigate={handleNavigateToNode}
                  onRetryDetail={() => handleRetryNodeDetail(selectedNode.id)}
                  isRetryingDetail={retryingNodeId === selectedNode.id}
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
  actionError,
}: {
  onGenerate: () => void;
  isGenerating: boolean;
  hasConversations: boolean;
  actionError: string | null;
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
      {actionError && (
        <p className="max-w-sm text-xs text-destructive" role="alert">
          {actionError}
        </p>
      )}
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
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
          {insights.handoffCount} handoff
          {insights.handoffCount !== 1 ? "s" : ""}
        </span>
        <span className="flex items-center gap-1">
          <Wrench className="h-3 w-3" />
          {insights.toolCount} tool{insights.toolCount !== 1 ? "s" : ""}
        </span>
        {insights.topBottlenecks.length > 0 && (
          <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
            <AlertTriangle className="h-3 w-3" />
            {insights.topBottlenecks.length} bottleneck
            {insights.topBottlenecks.length !== 1 ? "s" : ""}
          </span>
        )}
        {insights.automationOpportunities.length > 0 && (
          <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
            <Bot className="h-3 w-3" />
            {insights.automationOpportunities.length} automation opportunit
            {insights.automationOpportunities.length !== 1 ? "ies" : "y"}
          </span>
        )}
      </div>
    </div>
  );
}

function FullscreenWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {children}
    </div>
  );
}

function PassthroughWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {children}
    </div>
  );
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
