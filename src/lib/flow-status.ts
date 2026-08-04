/**
 * Shared reading of how far a process-flow generation has got.
 *
 * Staged generation flips `status` to "ready" the moment the *graph* lands,
 * minutes before the step details do. Anything that renders step content — the
 * diagram, the insights tab, the PDF — has to wait on `detailsStatus` instead,
 * or it presents a finished-looking process whose steps are all blank.
 *
 * Structurally typed on purpose: the three call sites reach the flow through
 * different types, and none of them should have to care.
 */

type FlowLike = {
  status: "generating" | "ready" | "failed";
  detailsStatus?: "pending" | "generating" | "ready" | "partial" | "failed";
  detailNodeCount?: number;
  detailCompletedCount?: number;
  detailFailedCount?: number;
};

export type FlowStage =
  /** Mapping the process — no diagram exists yet. */
  | "graph"
  /** Diagram exists; steps are still being described. */
  | "details"
  /** Renderable. Includes partial detail coverage: the graph is still usable. */
  | "ready"
  | "failed";

export function flowStage(flow: FlowLike): FlowStage {
  if (flow.status === "failed") return "failed";
  if (flow.status === "generating") return "graph";

  // A legacy single-call flow has no staged metadata and its nodes are already
  // detailed; `getProcessFlow` reports those as "ready".
  if (flow.detailsStatus === "pending" || flow.detailsStatus === "generating") {
    return "details";
  }

  return "ready";
}

/** True while generation is still in flight, at either stage. */
export function isFlowGenerating(flow: FlowLike): boolean {
  const stage = flowStage(flow);
  return stage === "graph" || stage === "details";
}

/**
 * True once the topology exists, whether or not the steps are described yet.
 *
 * This is the gate for the diagram: the graph is the thing the user is waiting
 * for, and it lands minutes before the descriptions do. Individual nodes report
 * their own `detailStatus`, so the diagram can show which steps are still being
 * written rather than hiding all of them.
 */
export function canRenderGraph(flow: FlowLike): boolean {
  const stage = flowStage(flow);
  return stage === "details" || stage === "ready";
}

/**
 * True when every step has been described.
 *
 * The gate for anything that aggregates across steps — the PDF, and any metric
 * that would read as complete. A count computed while half the nodes are still
 * blank is not a partial answer, it is a wrong one.
 */
export function isFlowRenderable(flow: FlowLike): boolean {
  return flowStage(flow) === "ready";
}

/**
 * How much of the enrichment is done, for a wait measured in minutes. Null when
 * there is nothing meaningful to report yet.
 */
export function flowDetailProgress(
  flow: FlowLike,
): { completed: number; total: number } | null {
  const total = flow.detailNodeCount;
  if (!total) return null;
  const completed =
    (flow.detailCompletedCount ?? 0) + (flow.detailFailedCount ?? 0);
  return { completed: Math.min(completed, total), total };
}

/** Set when the flow is usable but some steps were never described. */
export function flowHasIncompleteDetails(flow: FlowLike): boolean {
  return flow.detailsStatus === "partial" || flow.detailsStatus === "failed";
}

/**
 * True when a generation failed but the flow it was replacing is still there.
 *
 * A run that fails at the graph stage leaves `nodes`, `edges`, `insights`,
 * `conversationCount` and `generatedAt` untouched, so the previous version
 * survives whole. Showing it beats showing an error page: the user came to read
 * their process, and the failure only means today's refresh did not land.
 *
 * Only the graph stage can reach this. Once a new graph saves it has already
 * replaced the old one — but at that point there is a new graph to show, and a
 * detail-stage failure leaves it usable.
 */
export function hasRetainedPreviousFlow(
  flow: FlowLike,
  nodeCount: number,
): boolean {
  return flowStage(flow) === "failed" && nodeCount > 0;
}
