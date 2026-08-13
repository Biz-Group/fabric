import {
  deriveAutomationCandidates,
  deriveBottlenecks,
  deriveHandoffs,
  deriveToolUsage,
  type ProcessFlow,
} from "@/features/insights/insights-derivations";

export type FlowSpotlightMode =
  "bottlenecks" | "handoffs" | "automation" | "tools";

export type FlowSpotlight = {
  mode: FlowSpotlightMode;
  label: string;
  metricCount: number;
  metricLabel: string;
  nodeIds: Set<string>;
  edgeIds: Set<string>;
};

export type FlowSpotlightMap = Record<FlowSpotlightMode, FlowSpotlight>;

function relatedEdgeIds(edges: ProcessFlow["edges"], nodeIds: Set<string>) {
  return new Set(
    edges
      .filter((edge) => nodeIds.has(edge.source) || nodeIds.has(edge.target))
      .map((edge) => edge.id),
  );
}

function createSpotlight(
  mode: FlowSpotlightMode,
  label: string,
  metricCount: number,
  metricLabel: string,
  nodeIds: Set<string>,
  edges: ProcessFlow["edges"],
  edgeIds = relatedEdgeIds(edges, nodeIds),
): FlowSpotlight {
  return {
    mode,
    label,
    metricCount,
    metricLabel,
    nodeIds,
    edgeIds,
  };
}

/**
 * Maps only findings that can be located in the existing graph. Flow-level
 * recommendation prose deliberately stays outside this mapping because it
 * does not carry node ids and must not pretend to be spatially precise.
 */
export function deriveFlowSpotlights(flow: ProcessFlow): FlowSpotlightMap {
  const bottlenecks = deriveBottlenecks(flow);
  const handoffs = deriveHandoffs(flow.nodes, flow.edges);
  const automationCandidates = deriveAutomationCandidates(flow.nodes);
  const toolUsage = deriveToolUsage(flow.nodes);

  const bottleneckNodeIds = new Set(bottlenecks.map((node) => node.id));
  const handoffNodeIds = new Set<string>();
  for (const item of handoffs) {
    handoffNodeIds.add(item.source.id);
    handoffNodeIds.add(item.target.id);
  }
  for (const node of flow.nodes) {
    if (node.category === "handoff") handoffNodeIds.add(node.id);
  }
  const automationNodeIds = new Set(
    automationCandidates.map((node) => node.id),
  );
  const toolNodeIds = new Set(
    toolUsage.flatMap((usage) => usage.steps.map((node) => node.id)),
  );

  return {
    bottlenecks: createSpotlight(
      "bottlenecks",
      "Bottlenecks",
      bottlenecks.length,
      bottlenecks.length === 1 ? "bottleneck" : "bottlenecks",
      bottleneckNodeIds,
      flow.edges,
    ),
    handoffs: createSpotlight(
      "handoffs",
      "Handoffs",
      handoffs.length,
      handoffs.length === 1 ? "handoff" : "handoffs",
      handoffNodeIds,
      flow.edges,
      new Set(handoffs.flatMap((item) => (item.edge ? [item.edge.id] : []))),
    ),
    automation: createSpotlight(
      "automation",
      "Automation candidates",
      automationCandidates.length,
      automationCandidates.length === 1
        ? "automation candidate"
        : "automation candidates",
      automationNodeIds,
      flow.edges,
    ),
    tools: createSpotlight(
      "tools",
      "Tools",
      toolUsage.length,
      toolUsage.length === 1 ? "tool" : "tools",
      toolNodeIds,
      flow.edges,
    ),
  };
}

export function spotlightStatusText(spotlight: FlowSpotlight) {
  const stepCount = spotlight.nodeIds.size;
  if (stepCount === 0) {
    return `No steps match the ${spotlight.label.toLocaleLowerCase()} spotlight. The full process remains visible.`;
  }

  return `Spotlighting ${stepCount} ${stepCount === 1 ? "step" : "steps"} related to ${spotlight.label.toLocaleLowerCase()}. Other steps remain visible.`;
}
