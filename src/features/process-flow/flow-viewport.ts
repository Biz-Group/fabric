type ViewportNode = {
  id: string;
  type?: string;
  data?: {
    category?: string;
  };
};

type ViewportEdge = {
  source: string;
  target: string;
  data?: {
    isHappyPath?: boolean;
  };
};

type EntryViewportDirection = "horizontal" | "vertical";

type EntryViewportNode = {
  position: { x: number; y: number };
  width: number;
  height: number;
};

type EntryViewportSize = {
  width: number;
  height: number;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Places the entry card at the natural reading origin rather than centring a
 * large graph's bounds. Horizontal flows begin centre-left; vertical flows
 * begin top-centre. The transform is independent of live node detail updates.
 */
export function resolveEntryViewportTransform({
  node,
  viewport,
  direction,
  zoom = 0.92,
}: {
  node: EntryViewportNode;
  viewport: EntryViewportSize;
  direction: EntryViewportDirection;
  zoom?: number;
}) {
  const nodeCenterX = node.position.x + node.width / 2;
  const nodeCenterY = node.position.y + node.height / 2;
  const narrow = viewport.width < 640;

  const targetX =
    direction === "horizontal" && !narrow
      ? clamp(
          viewport.width * 0.22,
          (node.width * zoom) / 2 + 48,
          Math.min(360, viewport.width * 0.34),
        )
      : viewport.width / 2;
  const targetY =
    direction === "vertical"
      ? clamp(
          viewport.height * 0.2,
          (node.height * zoom) / 2 + 48,
          Math.min(220, viewport.height * 0.35),
        )
      : viewport.height / 2;

  return {
    x: targetX - nodeCenterX * zoom,
    y: targetY - nodeCenterY * zoom,
    zoom,
  };
}

/**
 * Finds the most useful entry point for opening a read-only process map.
 * Generated flows normally contain a start node; the zero-incoming fallback
 * also keeps legacy and partially generated flows navigable.
 */
export function resolveFlowEntryNodeId(
  nodes: ViewportNode[],
  edges: ViewportEdge[],
) {
  const explicitStart = nodes.find(
    (node) => node.type === "start" || node.data?.category === "start",
  );
  if (explicitStart) return explicitStart.id;

  const targets = new Set(edges.map((edge) => edge.target));
  return (
    nodes.find((node) => !targets.has(node.id))?.id ?? nodes[0]?.id ?? null
  );
}

/**
 * Returns a small entry-path window for the initial viewport of a large graph.
 * Happy-path edges win where available, while stable input ordering keeps the
 * result deterministic for branches and older flow rows.
 */
export function resolveInitialViewportNodeIds(
  nodes: ViewportNode[],
  edges: ViewportEdge[],
  limit = 4,
) {
  const entryNodeId = resolveFlowEntryNodeId(nodes, edges);
  if (!entryNodeId || limit <= 0) return [];

  const nodeIds = new Set(nodes.map((node) => node.id));
  const orderedOutgoing = new Map<string, ViewportEdge[]>();

  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const outgoing = orderedOutgoing.get(edge.source) ?? [];
    outgoing.push(edge);
    orderedOutgoing.set(edge.source, outgoing);
  }

  for (const outgoing of orderedOutgoing.values()) {
    outgoing.sort(
      (a, b) =>
        Number(Boolean(b.data?.isHappyPath)) -
        Number(Boolean(a.data?.isHappyPath)),
    );
  }

  const result: string[] = [];
  const queued = new Set([entryNodeId]);
  const queue = [entryNodeId];

  while (queue.length > 0 && result.length < limit) {
    const nodeId = queue.shift();
    if (!nodeId) break;
    result.push(nodeId);

    for (const edge of orderedOutgoing.get(nodeId) ?? []) {
      if (queued.has(edge.target)) continue;
      queued.add(edge.target);
      queue.push(edge.target);
    }
  }

  return result;
}
