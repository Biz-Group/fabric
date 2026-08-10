export function resolveFlowNodeId(
  nodes: readonly { id: string }[],
  requestedNodeId: string | null,
): string | null {
  if (!requestedNodeId) return null;
  return nodes.some((node) => node.id === requestedNodeId)
    ? requestedNodeId
    : null;
}
