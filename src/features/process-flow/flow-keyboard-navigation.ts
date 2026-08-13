export type FlowNavigationKey =
  "ArrowUp" | "ArrowRight" | "ArrowDown" | "ArrowLeft";

type PositionedFlowNode = {
  id: string;
  position: { x: number; y: number };
};

type ConnectedFlowEdge = {
  source: string;
  target: string;
};

const DIRECTION_VECTORS: Record<FlowNavigationKey, { x: number; y: number }> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowRight: { x: 1, y: 0 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
};

/**
 * Finds the closest directly connected step in the pressed visual direction.
 * This stays independent of layout orientation: the same arrow always means
 * the same direction on screen, including around split and merge branches.
 */
export function resolveConnectedNodeInDirection({
  currentNodeId,
  key,
  nodes,
  edges,
}: {
  currentNodeId: string;
  key: FlowNavigationKey;
  nodes: readonly PositionedFlowNode[];
  edges: readonly ConnectedFlowEdge[];
}): string | null {
  const currentNode = nodes.find((node) => node.id === currentNodeId);
  if (!currentNode) return null;

  const connectedNodeIds = new Set<string>();
  for (const edge of edges) {
    if (edge.source === currentNodeId && edge.target !== currentNodeId) {
      connectedNodeIds.add(edge.target);
    }
    if (edge.target === currentNodeId && edge.source !== currentNodeId) {
      connectedNodeIds.add(edge.source);
    }
  }

  const direction = DIRECTION_VECTORS[key];
  const candidates = nodes.flatMap((node) => {
    if (!connectedNodeIds.has(node.id)) return [];

    const deltaX = node.position.x - currentNode.position.x;
    const deltaY = node.position.y - currentNode.position.y;
    const forwardDistance = deltaX * direction.x + deltaY * direction.y;
    if (forwardDistance <= 0) return [];

    const crossDistance = Math.abs(deltaX * direction.y - deltaY * direction.x);
    return [
      {
        id: node.id,
        // Prefer the connection closest to the arrow's bearing, then the
        // nearest card. This makes branch choice predictable without relying
        // on generated edge order.
        bearingError: crossDistance / forwardDistance,
        distance: Math.hypot(deltaX, deltaY),
      },
    ];
  });

  candidates.sort(
    (left, right) =>
      left.bearingError - right.bearingError ||
      left.distance - right.distance ||
      left.id.localeCompare(right.id),
  );

  return candidates[0]?.id ?? null;
}

export function isFlowNavigationKey(key: string): key is FlowNavigationKey {
  return key in DIRECTION_VECTORS;
}
