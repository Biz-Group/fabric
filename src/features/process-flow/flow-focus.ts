export type FlowFocusMode = "none" | "selected-route" | "hover-preview";

export type FocusableFlowEdge = {
  id: string;
  source: string;
  target: string;
};

export type FlowFocus = {
  mode: FlowFocusMode;
  anchorNodeId: string | null;
  nodeIds: Set<string>;
  edgeIds: Set<string>;
};

type FlowFocusInput = {
  edges: FocusableFlowEdge[];
  selectedNodeId?: string | null;
  hoveredNodeId?: string | null;
  hoveredEdgeId?: string | null;
};

function emptyFocus(): FlowFocus {
  return {
    mode: "none",
    anchorNodeId: null,
    nodeIds: new Set(),
    edgeIds: new Set(),
  };
}

function deriveNodeNeighborhood(
  edges: FocusableFlowEdge[],
  nodeId: string,
): FlowFocus {
  const nodeIds = new Set([nodeId]);
  const edgeIds = new Set<string>();

  for (const edge of edges) {
    if (edge.source !== nodeId && edge.target !== nodeId) continue;
    edgeIds.add(edge.id);
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  }

  return {
    mode: "hover-preview",
    anchorNodeId: nodeId,
    nodeIds,
    edgeIds,
  };
}

function deriveEdgeNeighborhood(
  edges: FocusableFlowEdge[],
  edgeId: string,
): FlowFocus {
  const edge = edges.find((candidate) => candidate.id === edgeId);
  if (!edge) return emptyFocus();

  return {
    mode: "hover-preview",
    anchorNodeId: null,
    nodeIds: new Set([edge.source, edge.target]),
    edgeIds: new Set([edge.id]),
  };
}

function traverseFromNode(
  startNodeId: string,
  adjacency: Map<string, FocusableFlowEdge[]>,
) {
  const nodeIds = new Set([startNodeId]);
  const edgeIds = new Set<string>();
  const queue = [startNodeId];

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId) break;

    for (const edge of adjacency.get(nodeId) ?? []) {
      edgeIds.add(edge.id);
      const nextNodeId = edge.source === nodeId ? edge.target : edge.source;
      if (nodeIds.has(nextNodeId)) continue;
      nodeIds.add(nextNodeId);
      queue.push(nextNodeId);
    }
  }

  return { nodeIds, edgeIds };
}

/**
 * Derives presentation-only graph focus from existing topology.
 *
 * Selection follows every directed predecessor and successor of the selected
 * node. A sibling branch is therefore excluded unless it can actually reach or
 * be reached from that step. Hover is intentionally shallower: it previews one
 * node's immediate connections (or one edge's endpoints) without changing the
 * persistent selection.
 */
export function deriveFlowFocus({
  edges,
  selectedNodeId = null,
  hoveredNodeId = null,
  hoveredEdgeId = null,
}: FlowFocusInput): FlowFocus {
  if (hoveredNodeId) return deriveNodeNeighborhood(edges, hoveredNodeId);
  if (hoveredEdgeId) return deriveEdgeNeighborhood(edges, hoveredEdgeId);
  if (!selectedNodeId) return emptyFocus();

  const incoming = new Map<string, FocusableFlowEdge[]>();
  const outgoing = new Map<string, FocusableFlowEdge[]>();

  for (const edge of edges) {
    const incomingEdges = incoming.get(edge.target) ?? [];
    incomingEdges.push(edge);
    incoming.set(edge.target, incomingEdges);

    const outgoingEdges = outgoing.get(edge.source) ?? [];
    outgoingEdges.push(edge);
    outgoing.set(edge.source, outgoingEdges);
  }

  const upstream = traverseFromNode(selectedNodeId, incoming);
  const downstream = traverseFromNode(selectedNodeId, outgoing);

  return {
    mode: "selected-route",
    anchorNodeId: selectedNodeId,
    nodeIds: new Set([...upstream.nodeIds, ...downstream.nodeIds]),
    edgeIds: new Set([...upstream.edgeIds, ...downstream.edgeIds]),
  };
}

export type FlowEdgeType =
  "sequential" | "conditional" | "parallel" | "fallback";

export type FlowElementEmphasis = "default" | "active" | "muted";

/**
 * Nodes must always remain above the widened edge interaction paths. If a
 * focused edge rises above an unrelated node, the edge can steal the pointer
 * from that node and make hover focus oscillate between both elements.
 */
export const FLOW_LAYER_Z_INDEX = {
  edge: 0,
  focusedEdge: 4,
  node: 10,
  selectedNode: 20,
} as const;

/**
 * Hover is additive: it strengthens a local neighborhood without fading the
 * rest of a large graph. Persistent selection and explicit spotlights retain
 * the stronger foreground/background separation users intentionally invoked.
 */
export function resolveFlowElementEmphasis({
  focusMode,
  focused,
  hasSpotlight,
  spotlighted,
}: {
  focusMode: FlowFocusMode;
  focused: boolean;
  hasSpotlight: boolean;
  spotlighted: boolean;
}): FlowElementEmphasis {
  if (focusMode === "hover-preview") {
    return focused ? "active" : "default";
  }
  if (focusMode === "selected-route") {
    return focused ? "active" : "muted";
  }
  if (hasSpotlight) {
    return spotlighted ? "active" : "muted";
  }
  return "default";
}

export type EdgeVisualTokens = {
  dashArray?: string;
  lineCap: "butt" | "round";
  opacity: number;
  strokeWidth: number;
};

/** Distinguishes edge meaning through line pattern as well as emphasis/color. */
export function resolveEdgeVisualTokens({
  type,
  isHappyPath,
  emphasis,
}: {
  type: FlowEdgeType;
  isHappyPath: boolean;
  emphasis: FlowElementEmphasis;
}): EdgeVisualTokens {
  const patterns: Record<
    FlowEdgeType,
    Pick<EdgeVisualTokens, "dashArray" | "lineCap">
  > = {
    sequential: { dashArray: undefined, lineCap: "round" },
    conditional: { dashArray: "10 3", lineCap: "round" },
    parallel: { dashArray: "2 5", lineCap: "round" },
    fallback: { dashArray: "7 5", lineCap: "butt" },
  };

  if (emphasis === "active") {
    return {
      ...patterns[type],
      opacity: 1,
      strokeWidth: 2.8,
    };
  }

  if (emphasis === "muted") {
    return {
      ...patterns[type],
      opacity: 0.26,
      strokeWidth: 1.4,
    };
  }

  return {
    ...patterns[type],
    opacity: isHappyPath ? 0.62 : 0.48,
    strokeWidth: isHappyPath ? 2 : 1.6,
  };
}
