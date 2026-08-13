import dagre from "@dagrejs/dagre";
import { createRequire } from "node:module";
import type {
  ElkEdgeSection,
  ElkExtendedEdge,
  ElkNode,
  ElkPoint,
} from "elkjs/lib/elk-api.js";
import {
  FLOW_NODE_HEIGHT,
  FLOW_NODE_WIDTH,
  directionToDagreRank,
  flowNodeHeight,
  resolveDecisionSourceHandle,
  type FlowDirection,
  type FlowLayoutEdgeInput,
  type FlowLayoutNodeInput,
} from "./flow-layout";

// The comparison harness is Node-only. Loading ELK through Node's native
// CommonJS boundary avoids bundler worker shims and keeps it out of the app.
const require = createRequire(import.meta.url);
const ELK = require("elkjs") as typeof import("elkjs/lib/elk-api.js").default;

export type LayoutSpikeEdge = FlowLayoutEdgeInput & { label?: string };

export type LayoutSpikeFixture = {
  name: string;
  nodes: FlowLayoutNodeInput[];
  edges: LayoutSpikeEdge[];
};

type Route = {
  id: string;
  source: string;
  target: string;
  points: ElkPoint[];
};

type Geometry = {
  nodes: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  routes: Route[];
  width: number;
  height: number;
};

export type LayoutSpikeMetric = {
  fixture: string;
  direction: FlowDirection;
  engine: "dagre" | "elk";
  nodeIntersections: number;
  edgeCrossings: number;
  area: number;
  durationMs: number;
};

function now() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function measureBounds(nodes: Geometry["nodes"]) {
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  return { width: maxX - minX, height: maxY - minY };
}

export function runDagreSpike(
  fixture: LayoutSpikeFixture,
  direction: FlowDirection,
): Geometry {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: directionToDagreRank(direction),
    nodesep: direction === "horizontal" ? 80 : 96,
    ranksep: direction === "horizontal" ? 140 : 110,
    edgesep: 28,
    marginx: 48,
    marginy: 48,
  });

  for (const node of fixture.nodes) {
    graph.setNode(node.id, {
      width: FLOW_NODE_WIDTH,
      height: flowNodeHeight(node.category),
    });
  }
  for (const edge of fixture.edges) {
    graph.setEdge(
      edge.source,
      edge.target,
      edge.label
        ? { width: Math.min(160, edge.label.length * 6), height: 20 }
        : {},
      edge.id,
    );
  }
  dagre.layout(graph);

  const nodes = fixture.nodes.map((node) => {
    const point = graph.node(node.id);
    const height = flowNodeHeight(node.category);
    return {
      id: node.id,
      x: point.x - FLOW_NODE_WIDTH / 2,
      y: point.y - height / 2,
      width: FLOW_NODE_WIDTH,
      height,
    };
  });
  const routes = fixture.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    points: graph.edge({ v: edge.source, w: edge.target, name: edge.id })
      .points,
  }));
  return { nodes, routes, ...measureBounds(nodes) };
}

function port(id: string, side: "NORTH" | "EAST" | "SOUTH" | "WEST") {
  return {
    id,
    width: 1,
    height: 1,
    layoutOptions: { "elk.port.side": side },
  };
}

export async function runElkSpike(
  fixture: LayoutSpikeFixture,
  direction: FlowDirection,
): Promise<Geometry> {
  const horizontal = direction === "horizontal";
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": horizontal ? "RIGHT" : "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": horizontal ? "80" : "96",
      "elk.layered.spacing.nodeNodeBetweenLayers": horizontal ? "140" : "110",
      "elk.spacing.edgeNode": "28",
      "elk.layered.spacing.edgeNodeBetweenLayers": "28",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
      "elk.padding": "[top=48,left=48,bottom=48,right=48]",
    },
    children: fixture.nodes.map((node) => ({
      id: node.id,
      width: FLOW_NODE_WIDTH,
      height: flowNodeHeight(node.category),
      layoutOptions: { "elk.portConstraints": "FIXED_SIDE" },
      ports: [
        port(`${node.id}:target`, horizontal ? "WEST" : "NORTH"),
        port(`${node.id}:source-primary`, horizontal ? "EAST" : "SOUTH"),
        ...(node.category === "decision"
          ? [
              port(
                `${node.id}:source-alternate-start`,
                horizontal ? "NORTH" : "WEST",
              ),
              port(
                `${node.id}:source-alternate-end`,
                horizontal ? "SOUTH" : "EAST",
              ),
            ]
          : []),
      ],
    })),
    edges: fixture.edges.map((edge): ElkExtendedEdge => ({
      id: edge.id,
      sources: [
        `${edge.source}:${resolveDecisionSourceHandle(edge, fixture.nodes, fixture.edges) ?? "source-primary"}`,
      ],
      targets: [`${edge.target}:target`],
      labels: edge.label
        ? [
            {
              text: edge.label,
              width: Math.min(160, edge.label.length * 6),
              height: 20,
            },
          ]
        : undefined,
    })),
  };

  const result = await new ELK().layout(graph);
  const nodes = (result.children ?? []).map((node) => ({
    id: node.id,
    x: node.x ?? 0,
    y: node.y ?? 0,
    width: node.width ?? FLOW_NODE_WIDTH,
    height: node.height ?? FLOW_NODE_HEIGHT,
  }));
  const routes = (result.edges ?? []).map((edge) => ({
    id: edge.id,
    source:
      fixture.edges.find((candidate) => candidate.id === edge.id)?.source ?? "",
    target:
      fixture.edges.find((candidate) => candidate.id === edge.id)?.target ?? "",
    points: (edge.sections ?? []).flatMap((section: ElkEdgeSection, index) => [
      ...(index === 0 ? [section.startPoint] : []),
      ...(section.bendPoints ?? []),
      section.endPoint,
    ]),
  }));
  return { nodes, routes, ...measureBounds(nodes) };
}

function cross(a: ElkPoint, b: ElkPoint, c: ElkPoint) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentIntersectsSegment(
  a: ElkPoint,
  b: ElkPoint,
  c: ElkPoint,
  d: ElkPoint,
) {
  const first = cross(a, b, c);
  const second = cross(a, b, d);
  const third = cross(c, d, a);
  const fourth = cross(c, d, b);
  return first * second < 0 && third * fourth < 0;
}

function segmentIntersectsNode(
  start: ElkPoint,
  end: ElkPoint,
  node: Geometry["nodes"][number],
) {
  const left = node.x + 1;
  const top = node.y + 1;
  const right = node.x + node.width - 1;
  const bottom = node.y + node.height - 1;
  if (
    (start.x > left && start.x < right && start.y > top && start.y < bottom) ||
    (end.x > left && end.x < right && end.y > top && end.y < bottom)
  ) {
    return true;
  }
  const topLeft = { x: left, y: top };
  const topRight = { x: right, y: top };
  const bottomLeft = { x: left, y: bottom };
  const bottomRight = { x: right, y: bottom };
  return (
    segmentIntersectsSegment(start, end, topLeft, topRight) ||
    segmentIntersectsSegment(start, end, topRight, bottomRight) ||
    segmentIntersectsSegment(start, end, bottomRight, bottomLeft) ||
    segmentIntersectsSegment(start, end, bottomLeft, topLeft)
  );
}

export function measureGeometry(geometry: Geometry) {
  let nodeIntersections = 0;
  for (const route of geometry.routes) {
    for (const node of geometry.nodes) {
      if (node.id === route.source || node.id === route.target) continue;
      if (
        route.points.some((point, index) => {
          const next = route.points[index + 1];
          return next ? segmentIntersectsNode(point, next, node) : false;
        })
      ) {
        nodeIntersections += 1;
      }
    }
  }

  let edgeCrossings = 0;
  for (
    let firstIndex = 0;
    firstIndex < geometry.routes.length;
    firstIndex += 1
  ) {
    const first = geometry.routes[firstIndex]!;
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < geometry.routes.length;
      secondIndex += 1
    ) {
      const second = geometry.routes[secondIndex]!;
      if (
        first.source === second.source ||
        first.source === second.target ||
        first.target === second.source ||
        first.target === second.target
      ) {
        continue;
      }
      const crosses = first.points.some((point, index) => {
        const next = first.points[index + 1];
        if (!next) return false;
        return second.points.some((otherPoint, otherIndex) => {
          const otherNext = second.points[otherIndex + 1];
          return otherNext
            ? segmentIntersectsSegment(point, next, otherPoint, otherNext)
            : false;
        });
      });
      if (crosses) edgeCrossings += 1;
    }
  }

  return {
    nodeIntersections,
    edgeCrossings,
    area: Math.round(geometry.width * geometry.height),
  };
}

export async function compareLayoutEngines(
  fixtures: LayoutSpikeFixture[],
): Promise<LayoutSpikeMetric[]> {
  const metrics: LayoutSpikeMetric[] = [];
  for (const fixture of fixtures) {
    for (const direction of ["horizontal", "vertical"] as const) {
      const dagreStart = now();
      const dagreGeometry = runDagreSpike(fixture, direction);
      metrics.push({
        fixture: fixture.name,
        direction,
        engine: "dagre",
        ...measureGeometry(dagreGeometry),
        durationMs: Math.round((now() - dagreStart) * 10) / 10,
      });

      const elkStart = now();
      const elkGeometry = await runElkSpike(fixture, direction);
      metrics.push({
        fixture: fixture.name,
        direction,
        engine: "elk",
        ...measureGeometry(elkGeometry),
        durationMs: Math.round((now() - elkStart) * 10) / 10,
      });
    }
  }
  return metrics;
}

function layeredFixture(
  name: string,
  layerSizes: number[],
): LayoutSpikeFixture {
  const layers: FlowLayoutNodeInput[][] = layerSizes.map((size, layerIndex) =>
    Array.from({ length: size }, (_, index) => ({
      id: `${name}-${layerIndex}-${index}`,
      category:
        layerIndex === 0
          ? "start"
          : layerIndex === layerSizes.length - 1
            ? "end"
            : index % 4 === 0
              ? "decision"
              : "action",
    })),
  );
  const edges: LayoutSpikeEdge[] = [];
  for (let layerIndex = 0; layerIndex < layers.length - 1; layerIndex += 1) {
    const current = layers[layerIndex]!;
    const next = layers[layerIndex + 1]!;
    current.forEach((source, index) => {
      const targets = new Set([index % next.length]);
      if (
        source.category === "decision" ||
        layerSizes.reduce((sum, size) => sum + size, 0) >= 40
      ) {
        targets.add((index + 1) % next.length);
      }
      for (const targetIndex of targets) {
        edges.push({
          id: `${source.id}-${next[targetIndex]!.id}`,
          source: source.id,
          target: next[targetIndex]!.id,
          isHappyPath: targetIndex === index % next.length,
        });
      }
    });
  }
  return { name, nodes: layers.flat(), edges };
}

export const LAYOUT_SPIKE_FIXTURES: LayoutSpikeFixture[] = [
  layeredFixture("small-linear", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
  layeredFixture("typical-branched", [1, 4, 6, 7, 6, 4]),
  layeredFixture("dense-50", [2, 8, 11, 11, 10, 8]),
  layeredFixture("split-merge", [1, 5, 8, 5, 1]),
  {
    ...layeredFixture("long-label", [1, 3, 5, 3, 1]),
    edges: layeredFixture("long-label", [1, 3, 5, 3, 1]).edges.map(
      (edge, index) => ({
        ...edge,
        label:
          index % 3 === 0
            ? "Requires additional compliance review before proceeding"
            : undefined,
      }),
    ),
  },
];
