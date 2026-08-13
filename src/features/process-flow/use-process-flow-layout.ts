import { useMemo } from "react";
import { Position, type Edge, type Node } from "@xyflow/react";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import {
  deriveFlowFocus,
  FLOW_LAYER_Z_INDEX,
  resolveFlowElementEmphasis,
  type FlowElementEmphasis,
  type FlowFocusMode,
} from "./flow-focus";
import type { FlowSpotlight } from "./flow-spotlight";
import {
  layoutProcessFlow,
  resolveDecisionSourceHandle,
  type FlowDirection,
  type FlowGrouping,
  type FlowLayoutLane,
} from "./flow-layout";

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
  sourceConversations?: Array<{
    source: string;
    conversationId: Id<"conversations">;
    contributorName: string;
  }>;
};

type ReadFlow = Omit<FlowDoc, "nodes"> & { nodes: ReadFlowNode[] };

export type ProcessFlowNodeData = ReadFlowNode & {
  dimmed: boolean;
  emphasis: FlowElementEmphasis;
  isFocusAnchor: boolean;
  spotlighted: boolean;
};

export type ProcessFlowNode = Node<ProcessFlowNodeData>;

export type ProcessFlowEdgeData = {
  flowType: FlowEdge["type"];
  isHappyPath: boolean;
  emphasis: FlowElementEmphasis;
  focusMode: FlowFocusMode;
  animateFlow: boolean;
  spotlighted: boolean;
};

export type ProcessFlowEdge = Edge<ProcessFlowEdgeData, "process">;

type LayoutResult = {
  nodes: ProcessFlowNode[];
  edges: ProcessFlowEdge[];
  lanes: FlowLayoutLane[];
};

const EMPTY_LAYOUT: LayoutResult = { nodes: [], edges: [], lanes: [] };

function markerColorFor(emphasis: FlowElementEmphasis, isHappyPath: boolean) {
  if (emphasis === "active") return "var(--org-accent)";
  if (emphasis === "muted") return "var(--color-border)";
  return isHappyPath
    ? "var(--color-foreground)"
    : "var(--color-muted-foreground)";
}

/**
 * Converts Convex process-flow data into positioned React Flow nodes and edges.
 * Dagre owns stable geometry; selection and hover add presentation-only focus
 * without changing or persisting the generated graph.
 */
export function useProcessFlowLayout(
  flow: ReadFlow | null | undefined,
  selectedNodeId: string | null = null,
  reduceMotion = false,
  spotlight: FlowSpotlight | null = null,
  direction: FlowDirection = "horizontal",
  grouping: FlowGrouping = "process",
) {
  const layout = useMemo<LayoutResult>(() => {
    // Keyed on there being nodes, not on status: a failed refresh retains the
    // previous flow's nodes, and the caller decides whether to show them.
    if (!flow || flow.nodes.length === 0) return EMPTY_LAYOUT;

    const geometry = layoutProcessFlow({
      nodes: flow.nodes,
      edges: flow.edges,
      direction,
      grouping,
    });
    const positions = new Map(
      geometry.nodes.map((node) => [node.id, node.position]),
    );
    const nodeLabels = new Map(flow.nodes.map((node) => [node.id, node.label]));
    const nodes: ProcessFlowNode[] = flow.nodes.map((node) => {
      return {
        id: node.id,
        type: node.category,
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        sourcePosition:
          direction === "horizontal" ? Position.Right : Position.Bottom,
        targetPosition:
          direction === "horizontal" ? Position.Left : Position.Top,
        ariaLabel: `${node.category} step: ${node.label}. Use arrow keys for connected steps. Press Enter for details.`,
        data: {
          ...node,
          dimmed: false,
          emphasis: "default",
          isFocusAnchor: false,
          spotlighted: false,
        },
      };
    });

    const edges: ProcessFlowEdge[] = flow.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle:
        resolveDecisionSourceHandle(edge, flow.nodes, flow.edges) ??
        "source-primary",
      targetHandle: "target",
      type: "process",
      animated: false,
      selectable: false,
      focusable: true,
      interactionWidth: 32,
      label: edge.label ?? undefined,
      ariaLabel: `${edge.type} path from ${nodeLabels.get(edge.source) ?? edge.source} to ${nodeLabels.get(edge.target) ?? edge.target}${edge.label ? `: ${edge.label}` : ""}`,
      markerEnd: {
        type: "arrowclosed" as const,
        width: 18,
        height: 18,
        color: markerColorFor("default", edge.isHappyPath),
      },
      data: {
        flowType: edge.type,
        isHappyPath: edge.isHappyPath,
        emphasis: "default",
        focusMode: "none",
        animateFlow: false,
        spotlighted: false,
      },
    }));

    return { nodes, edges, lanes: geometry.lanes };
  }, [direction, flow, grouping]);

  return useMemo<LayoutResult>(() => {
    if (layout.nodes.length === 0) return layout;

    const focus = deriveFlowFocus({
      edges: layout.edges,
      selectedNodeId,
    });
    const hasSpotlight = spotlight !== null;

    const nodes = layout.nodes.map((node) => {
      const focused = focus.nodeIds.has(node.id);
      const spotlighted = spotlight?.nodeIds.has(node.id) ?? false;
      const emphasis: FlowElementEmphasis = resolveFlowElementEmphasis({
        focusMode: focus.mode,
        focused,
        hasSpotlight,
        spotlighted,
      });
      const isSelected = node.id === selectedNodeId;
      const isFocusAnchor = node.id === focus.anchorNodeId;

      return {
        ...node,
        selected: isSelected,
        // Keep this stable during hover. Re-layering the whole node set lets a
        // widened edge hit target rise above cards and causes pointer churn.
        zIndex: isSelected
          ? FLOW_LAYER_Z_INDEX.selectedNode
          : FLOW_LAYER_Z_INDEX.node,
        data: {
          ...node.data,
          dimmed: emphasis === "muted",
          emphasis,
          isFocusAnchor,
          spotlighted,
        },
      };
    });

    const edges = layout.edges.map((edge) => {
      const focused = focus.edgeIds.has(edge.id);
      const spotlighted = spotlight?.edgeIds.has(edge.id) ?? false;
      const emphasis: FlowElementEmphasis = resolveFlowElementEmphasis({
        focusMode: focus.mode,
        focused,
        hasSpotlight,
        spotlighted,
      });
      const edgeData: ProcessFlowEdgeData = edge.data ?? {
        flowType: "sequential",
        isHappyPath: true,
        emphasis: "default",
        focusMode: "none",
        animateFlow: false,
        spotlighted: false,
      };

      return {
        ...edge,
        zIndex:
          emphasis === "active"
            ? FLOW_LAYER_Z_INDEX.focusedEdge
            : FLOW_LAYER_Z_INDEX.edge,
        markerEnd: {
          type: "arrowclosed" as const,
          width: 18,
          height: 18,
          color: spotlighted
            ? "var(--org-accent)"
            : markerColorFor(emphasis, edgeData.isHappyPath),
        },
        data: {
          ...edgeData,
          emphasis,
          focusMode: focus.mode,
          animateFlow:
            !reduceMotion &&
            focus.mode === "selected-route" &&
            emphasis === "active",
          spotlighted,
        },
      };
    });

    return { nodes, edges, lanes: layout.lanes };
  }, [layout, reduceMotion, selectedNodeId, spotlight]);
}
