import dagre from "@dagrejs/dagre";

export const FLOW_NODE_WIDTH = 280;
export const FLOW_NODE_HEIGHT = 120;
export const FLOW_DECISION_NODE_HEIGHT = 100;

const LANE_GAP = 24;
const LANE_LABEL_SIZE = 40;
const LANE_NODE_GAP = 36;
const LANE_OUTER_PADDING = 32;

export type FlowDirection = "horizontal" | "vertical";
export type FlowGrouping = "process" | "owner";

export function toggleOwnerGrouping(grouping: FlowGrouping): FlowGrouping {
  return grouping === "owner" ? "process" : "owner";
}

export type FlowLayoutNodeInput = {
  id: string;
  category: string;
  actors?: string[];
  detailStatus?: "pending" | "generating" | "ready" | "failed";
};

export type FlowLayoutEdgeInput = {
  id: string;
  source: string;
  target: string;
  isHappyPath?: boolean;
};

export type FlowLayoutPosition = {
  id: string;
  position: { x: number; y: number };
};

export type FlowLayoutLane = {
  id: string;
  label: string;
  kind: "actor" | "shared" | "unassigned" | "pending";
  position: { x: number; y: number };
  width: number;
  height: number;
  nodeIds: string[];
};

export type FlowLayoutResult = {
  engine: "dagre";
  direction: FlowDirection;
  nodes: FlowLayoutPosition[];
  lanes: FlowLayoutLane[];
};

type OwnerLaneAssignment = Pick<FlowLayoutLane, "id" | "label" | "kind">;

export type DecisionSourceHandle =
  "source-primary" | "source-alternate-start" | "source-alternate-end";

export function flowNodeHeight(category: string) {
  return category === "decision" ? FLOW_DECISION_NODE_HEIGHT : FLOW_NODE_HEIGHT;
}

export function directionToDagreRank(direction: FlowDirection) {
  return direction === "horizontal" ? "LR" : "TB";
}

export function resolveOwnerLane(
  node: FlowLayoutNodeInput,
): OwnerLaneAssignment {
  if (node.detailStatus === "pending" || node.detailStatus === "generating") {
    return {
      id: "pending",
      label: "Awaiting details",
      kind: "pending",
    };
  }

  const actors = new Map<string, string>();
  for (const actor of node.actors ?? []) {
    const label = actor.trim();
    if (!label) continue;
    const key = label.toLocaleLowerCase();
    if (!actors.has(key)) actors.set(key, label);
  }

  if (actors.size === 0) {
    return { id: "unassigned", label: "Unassigned", kind: "unassigned" };
  }

  if (actors.size > 1) {
    return {
      id: "shared",
      label: "Shared · multiple actors",
      kind: "shared",
    };
  }

  const [key, label] = actors.entries().next().value as [string, string];
  return { id: `actor:${key}`, label, kind: "actor" };
}

/**
 * Assigns every decision route to one of three stable ports. The happy path
 * owns the primary direction when present; alternate routes fan out in source
 * order without inventing any branch semantics.
 */
export function resolveDecisionSourceHandle(
  edge: FlowLayoutEdgeInput,
  nodes: FlowLayoutNodeInput[],
  edges: FlowLayoutEdgeInput[],
): DecisionSourceHandle | undefined {
  if (nodes.find((node) => node.id === edge.source)?.category !== "decision") {
    return undefined;
  }

  const outgoing = edges.filter(
    (candidate) => candidate.source === edge.source,
  );
  const happyPath = outgoing.find((candidate) => candidate.isHappyPath);
  if (
    happyPath?.id === edge.id ||
    (!happyPath && outgoing[0]?.id === edge.id)
  ) {
    return "source-primary";
  }

  const alternateIndex = outgoing
    .filter((candidate) => candidate.id !== happyPath?.id)
    .findIndex((candidate) => candidate.id === edge.id);
  return alternateIndex % 2 === 0
    ? "source-alternate-start"
    : "source-alternate-end";
}

function dagrePositions(
  nodes: FlowLayoutNodeInput[],
  edges: FlowLayoutEdgeInput[],
  direction: FlowDirection,
) {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: directionToDagreRank(direction),
    nodesep: direction === "horizontal" ? 80 : 96,
    ranksep: direction === "horizontal" ? 140 : 110,
    marginx: 48,
    marginy: 48,
  });

  for (const node of nodes) {
    graph.setNode(node.id, {
      width: FLOW_NODE_WIDTH,
      height: flowNodeHeight(node.category),
    });
  }
  for (const edge of edges) {
    graph.setEdge(edge.source, edge.target, {}, edge.id);
  }

  dagre.layout(graph);
  return nodes.map((node, index) => {
    const point = graph.node(node.id);
    return {
      id: node.id,
      index,
      category: node.category,
      center: { x: point?.x ?? 0, y: point?.y ?? 0 },
      position: {
        x: (point?.x ?? 0) - FLOW_NODE_WIDTH / 2,
        y: (point?.y ?? 0) - flowNodeHeight(node.category) / 2,
      },
    };
  });
}

function ownerLaneLayout(
  nodes: FlowLayoutNodeInput[],
  baseNodes: ReturnType<typeof dagrePositions>,
  direction: FlowDirection,
): Pick<FlowLayoutResult, "nodes" | "lanes"> {
  const nodeInput = new Map(nodes.map((node) => [node.id, node]));
  const orderedBaseNodes = [...baseNodes].sort((a, b) => {
    const primaryDifference =
      direction === "horizontal"
        ? a.center.x - b.center.x
        : a.center.y - b.center.y;
    return primaryDifference || a.index - b.index;
  });
  const laneById = new Map<
    string,
    OwnerLaneAssignment & {
      firstProcessPosition: number;
      members: typeof baseNodes;
    }
  >();

  for (const baseNode of orderedBaseNodes) {
    const assignment = resolveOwnerLane(nodeInput.get(baseNode.id)!);
    const processPosition =
      direction === "horizontal" ? baseNode.center.x : baseNode.center.y;
    const lane = laneById.get(assignment.id);
    if (lane) {
      lane.members.push(baseNode);
    } else {
      laneById.set(assignment.id, {
        ...assignment,
        firstProcessPosition: processPosition,
        members: [baseNode],
      });
    }
  }

  const ownerLanes = Array.from(laneById.values()).sort(
    (a, b) =>
      a.firstProcessPosition - b.firstProcessPosition ||
      a.label.localeCompare(b.label),
  );
  const primaryPositions = baseNodes.map((node) =>
    direction === "horizontal" ? node.position.x : node.position.y,
  );
  const primaryEnds = baseNodes.map((node) =>
    direction === "horizontal"
      ? node.position.x + FLOW_NODE_WIDTH
      : node.position.y + flowNodeHeight(node.category),
  );
  const primaryStart = Math.min(...primaryPositions);
  const primaryEnd = Math.max(...primaryEnds);
  const processExtent =
    primaryEnd -
    primaryStart +
    LANE_OUTER_PADDING * 2 +
    // Vertical lanes repeat their label below the final rank, so reserve a
    // footer rather than letting that navigation aid overlap the last node.
    (direction === "vertical" ? LANE_LABEL_SIZE : 0);
  const positions = new Map<string, { x: number; y: number }>();
  const lanes: FlowLayoutLane[] = [];
  let laneCursor = 0;

  for (const lane of ownerLanes) {
    const byRank = new Map<number, typeof baseNodes>();
    for (const member of lane.members) {
      const rank = Math.round(
        direction === "horizontal" ? member.center.x : member.center.y,
      );
      const bucket = byRank.get(rank) ?? [];
      bucket.push(member);
      byRank.set(rank, bucket);
    }
    for (const bucket of byRank.values()) {
      bucket.sort((a, b) => {
        const crossDifference =
          direction === "horizontal"
            ? a.center.y - b.center.y
            : a.center.x - b.center.x;
        return crossDifference || a.index - b.index;
      });
    }
    const slots = Math.max(
      1,
      ...Array.from(byRank.values(), (items) => items.length),
    );
    const laneCrossSize =
      LANE_LABEL_SIZE +
      LANE_OUTER_PADDING +
      slots *
        ((direction === "horizontal" ? FLOW_NODE_HEIGHT : FLOW_NODE_WIDTH) +
          LANE_NODE_GAP) -
      LANE_NODE_GAP;

    for (const bucket of byRank.values()) {
      bucket.forEach((member, slot) => {
        const primary =
          (direction === "horizontal" ? member.position.x : member.position.y) -
          primaryStart +
          LANE_OUTER_PADDING;
        const cross =
          laneCursor +
          LANE_LABEL_SIZE +
          slot *
            ((direction === "horizontal" ? FLOW_NODE_HEIGHT : FLOW_NODE_WIDTH) +
              LANE_NODE_GAP);
        positions.set(
          member.id,
          direction === "horizontal"
            ? { x: primary, y: cross }
            : { x: cross, y: primary },
        );
      });
    }

    lanes.push({
      id: lane.id,
      label: lane.label,
      kind: lane.kind,
      position:
        direction === "horizontal"
          ? { x: 0, y: laneCursor }
          : { x: laneCursor, y: 0 },
      width: direction === "horizontal" ? processExtent : laneCrossSize,
      height: direction === "horizontal" ? laneCrossSize : processExtent,
      nodeIds: lane.members.map((member) => member.id),
    });
    laneCursor += laneCrossSize + LANE_GAP;
  }

  return {
    nodes: baseNodes.map((node) => ({
      id: node.id,
      position: positions.get(node.id) ?? node.position,
    })),
    lanes,
  };
}

/** Pure synchronous adapter used by the React Flow integration. */
export function layoutProcessFlow({
  nodes,
  edges,
  direction,
  grouping,
}: {
  nodes: FlowLayoutNodeInput[];
  edges: FlowLayoutEdgeInput[];
  direction: FlowDirection;
  grouping: FlowGrouping;
}): FlowLayoutResult {
  if (nodes.length === 0) {
    return { engine: "dagre", direction, nodes: [], lanes: [] };
  }

  const baseNodes = dagrePositions(nodes, edges, direction);
  const layout =
    grouping === "owner"
      ? ownerLaneLayout(nodes, baseNodes, direction)
      : {
          nodes: baseNodes.map(({ id, position }) => ({ id, position })),
          lanes: [],
        };

  return { engine: "dagre", direction, ...layout };
}
