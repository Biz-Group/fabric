import { useMemo } from "react";
import dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";
import type { Doc } from "../../../convex/_generated/dataModel";

// Node dimensions used by dagre for layout calculation
const NODE_WIDTH = 280;
const NODE_HEIGHT_BASE = 120;
const NODE_HEIGHT_DECISION = 100;

type FlowDoc = Doc<"processFlows">;
type FlowNode = FlowDoc["nodes"][number];
type FlowEdge = FlowDoc["edges"][number];

/**
 * Per-node enrichment state, added by `getProcessFlow` rather than stored.
 * Absent on a legacy flow, whose nodes were always fully detailed.
 */
export type NodeDetailStatus = "pending" | "generating" | "ready" | "failed";

/** A node as the read path returns it: graph fields plus its detail state. */
export type ReadFlowNode = FlowNode & {
  detailStatus?: NodeDetailStatus;
  detailErrorMessage?: string;
};

type ReadFlow = Omit<FlowDoc, "nodes"> & { nodes: ReadFlowNode[] };

export type ProcessFlowNodeData = ReadFlowNode & { dimmed: boolean };
export type ProcessFlowNode = Node<ProcessFlowNodeData>;
export type ProcessFlowEdge = Edge<{
  flowType: FlowEdge["type"];
  isHappyPath: boolean;
}>;

/**
 * Converts Convex processFlows data into positioned React Flow nodes/edges
 * using dagre for automatic top-to-bottom layout.
 */
export function useProcessFlowLayout(
  flow: ReadFlow | null | undefined,
  selectedNodeId: string | null = null,
) {
  return useMemo(() => {
    // Keyed on there being nodes, not on status: a failed refresh retains the
    // previous flow's nodes, and the caller decides whether to show them.
    if (!flow || flow.nodes.length === 0) {
      return { nodes: [] as ProcessFlowNode[], edges: [] as ProcessFlowEdge[] };
    }

    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({
      rankdir: "LR",
      nodesep: 80,
      ranksep: 140,
      marginx: 48,
      marginy: 48,
    });

    // Add nodes to dagre graph
    for (const node of flow.nodes) {
      const height =
        node.category === "decision" ? NODE_HEIGHT_DECISION : NODE_HEIGHT_BASE;
      g.setNode(node.id, { width: NODE_WIDTH, height });
    }

    // Add edges to dagre graph
    for (const edge of flow.edges) {
      g.setEdge(edge.source, edge.target);
    }

    dagre.layout(g);

    // Convert to React Flow format
    const isSelected = (id: string) => selectedNodeId === id;
    const nodes: ProcessFlowNode[] = flow.nodes.map((node) => {
      const pos = g.node(node.id);
      return {
        id: node.id,
        type: node.category,
        zIndex: isSelected(node.id) ? 10 : 0,
        position: {
          x: (pos?.x ?? 0) - NODE_WIDTH / 2,
          y:
            (pos?.y ?? 0) -
            (node.category === "decision"
              ? NODE_HEIGHT_DECISION
              : NODE_HEIGHT_BASE) /
              2,
        },
        data: {
          ...node,
          dimmed: selectedNodeId !== null && !isSelected(node.id),
        },
      };
    });

    // When a node is selected, dim edges not connected to it
    const connectedEdgeIds = selectedNodeId
      ? new Set(
          flow.edges
            .filter(
              (e) => e.source === selectedNodeId || e.target === selectedNodeId,
            )
            .map((e) => e.id),
        )
      : null;

    const edges: ProcessFlowEdge[] = flow.edges.map((edge) => {
      const isConnected =
        connectedEdgeIds === null || connectedEdgeIds.has(edge.id);
      const dimEdge = connectedEdgeIds !== null && !isConnected;

      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "smoothstep",
        animated: false,
        label: edge.label ?? undefined,
        markerEnd: {
          type: "arrowclosed" as const,
          width: 16,
          height: 16,
          color: edge.isHappyPath
            ? "var(--color-foreground)"
            : "var(--color-muted-foreground)",
        },
        style: {
          strokeWidth: edge.isHappyPath ? 2 : 1.5,
          stroke: edge.isHappyPath
            ? "var(--color-foreground)"
            : "var(--color-muted-foreground)",
          opacity: dimEdge ? 0.1 : edge.isHappyPath ? 0.5 : 0.3,
          strokeDasharray: edge.isHappyPath ? undefined : "6 4",
        },
        pathOptions: {
          offset: 15,
        },
        data: {
          flowType: edge.type,
          isHappyPath: edge.isHappyPath,
        },
      };
    });

    return { nodes, edges };
  }, [flow, selectedNodeId]);
}
