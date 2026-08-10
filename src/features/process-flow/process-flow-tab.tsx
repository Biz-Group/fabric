"use client";

import { lazy, Suspense } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Clock, Loader2 } from "lucide-react";
import type { FlowConversationForSources } from "./flow-sources";

const ProcessFlow = lazy(() =>
  import("@/features/process-flow/process-flow").then((module) => ({
    default: module.ProcessFlow,
  })),
);

type ProcessWorkbench = NonNullable<
  FunctionReturnType<typeof api.processes.getWorkbench>
>;
type FlowSummary = ProcessWorkbench["flow"];

type ProcessFlowTabProps = {
  processId: Id<"processes">;
  conversationCount: number;
  flow: FlowSummary | undefined;
  selectedNodeId: string | null;
  onSelectedNodeChange: (nodeId: string | null) => void;
  onOpenConversation: (conversationId: Id<"conversations">) => void;
  onOpenInsights: () => void;
  conversations: FlowConversationForSources[];
};

function formatGeneratedAt(epochMs: number | null | undefined) {
  if (!epochMs) return "Not generated";
  return new Date(epochMs).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function FlowCanvasFallback() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading process flow
      </div>
    </div>
  );
}

export function ProcessFlowTab({
  processId,
  conversationCount,
  flow,
  selectedNodeId,
  onSelectedNodeChange,
  onOpenConversation,
  onOpenInsights,
  conversations,
}: ProcessFlowTabProps) {
  const generatedLabel =
    flow === undefined
      ? "Generated ..."
      : flow === null
        ? "Not generated"
        : `Generated ${formatGeneratedAt(flow.generatedAt)}`;

  return (
    <section className="flex h-full min-h-[34rem] min-w-0 flex-col overflow-hidden bg-muted/20 md:min-h-0">
      <div className="flex h-8 shrink-0 items-center justify-end border-b bg-background px-4 md:px-6">
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{generatedLabel}</span>
        </p>
      </div>

      <div className="flex min-h-0 flex-1 p-3 md:p-4">
        <div className="relative flex h-full min-h-[29rem] min-w-0 flex-1 overflow-hidden rounded-lg border bg-background shadow-xs md:min-h-0">
          <Suspense fallback={<FlowCanvasFallback />}>
            <ProcessFlow
              processId={processId}
              conversationCount={conversationCount}
              selectedNodeId={selectedNodeId}
              onSelectedNodeChange={onSelectedNodeChange}
              onOpenConversation={onOpenConversation}
              onOpenInsights={onOpenInsights}
              conversations={conversations}
            />
          </Suspense>
        </div>
      </div>
    </section>
  );
}
