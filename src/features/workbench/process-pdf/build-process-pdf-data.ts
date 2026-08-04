import dagre from "@dagrejs/dagre";
import {
  type ProcessFlow,
  type FlowNode,
  type FlowEdge,
  type Confidence,
  deriveAutomationCandidates,
  deriveBottlenecks,
  deriveConfidenceCounts,
  deriveHandoffs,
  deriveHeavyAreas,
  deriveToolUsage,
  getNodeMap,
  uniqueStrings,
  type HandoffItem,
  type ToolUsage,
  type HeavyArea,
} from "@/features/insights/insights-derivations";
import { isFlowRenderable } from "@/lib/flow-status";

// Node dimensions / layout params mirror use-process-flow-layout.ts so the PDF
// diagram matches what users see in the app.
const NODE_WIDTH = 280;
const NODE_HEIGHT_BASE = 120;
const NODE_HEIGHT_DECISION = 100;

export type NodeBox = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type StepNode = FlowNode & { number: number };

export type ProcessPdfInput = {
  processName: string;
  functionName: string;
  departmentName: string;
  summary: string | null;
  contributorName: string | null;
  /** Set only when the latest conversation was recorded on the contributor's behalf. */
  submittedByName: string | null;
  lastUpdatedAt: number | null;
  completedConversationCount: number;
  /** Full flow document, or null when none has been generated. */
  flow: ProcessFlow | null;
  /** Epoch ms the report was generated (supplied by the browser handler). */
  generatedAt: number;
};

export type Metric = { label: string; value: string; detail: string };

export type ProcessPdfData = {
  processName: string;
  functionName: string;
  departmentName: string;
  contributorName: string | null;
  /** Set only when the latest conversation was recorded on the contributor's behalf. */
  submittedByName: string | null;
  lastUpdatedAt: number | null;
  generatedAt: number;
  summary: string | null;

  flowStatus: "ready" | "generating" | "failed" | "none";
  flowGeneratedAt: number | null;
  flowStale: boolean;
  flowConversationCount: number;
  completedConversationCount: number;
  flowErrorMessage: string | null;
  /** True only when there is a usable, mapped flow to render. */
  hasFlow: boolean;

  metrics: Metric[];

  steps: StepNode[];
  nodeNumber: Record<string, number>;
  edges: FlowEdge[];

  handoffs: HandoffItem[];
  toolUsage: ToolUsage[];
  heavyAreas: HeavyArea[];
  bottlenecks: StepNode[];
  automationCandidates: StepNode[];
  tribalKnowledge: StepNode[];
  decisionNodes: StepNode[];

  confidenceCounts: Record<Confidence, number>;
  allSources: string[];
  uniquePainPoints: string[];

  automationOpportunities: string[];
  criticalPathLabels: string[];
  totalEstimatedDuration: string | null;
};

/**
 * Runs dagre purely to derive a stable left-to-right reading order for the
 * nodes (its rank assignment ≈ topological order). Returns node positions so
 * the caller can number steps in flow order.
 */
function computeNodeOrder(nodes: FlowNode[], edges: FlowEdge[]): NodeBox[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "LR",
    nodesep: 80,
    ranksep: 140,
    marginx: 24,
    marginy: 24,
  });

  for (const node of nodes) {
    const height =
      node.category === "decision" ? NODE_HEIGHT_DECISION : NODE_HEIGHT_BASE;
    g.setNode(node.id, { width: NODE_WIDTH, height });
  }
  for (const edge of edges) {
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    const height =
      node.category === "decision" ? NODE_HEIGHT_DECISION : NODE_HEIGHT_BASE;
    return {
      id: node.id,
      x: pos?.x ?? 0,
      y: pos?.y ?? 0,
      width: NODE_WIDTH,
      height,
    };
  });
}

export function buildProcessPdfData(input: ProcessPdfInput): ProcessPdfData {
  const { flow } = input;
  // `isFlowRenderable` rather than `status === "ready"`: the graph lands minutes
  // before the step details, and exporting in that window would produce a
  // document whose steps have no descriptions, actors, or tools — the parts a
  // reader of the PDF is actually there for.
  const hasFlow = !!flow && isFlowRenderable(flow) && flow.nodes.length > 0;

  const base: Omit<
    ProcessPdfData,
    | "metrics"
    | "steps"
    | "nodeNumber"
    | "edges"
    | "handoffs"
    | "toolUsage"
    | "heavyAreas"
    | "bottlenecks"
    | "automationCandidates"
    | "tribalKnowledge"
    | "decisionNodes"
    | "confidenceCounts"
    | "allSources"
    | "uniquePainPoints"
    | "automationOpportunities"
    | "criticalPathLabels"
    | "totalEstimatedDuration"
  > = {
    processName: input.processName,
    functionName: input.functionName,
    departmentName: input.departmentName,
    contributorName: input.contributorName,
    submittedByName: input.submittedByName,
    lastUpdatedAt: input.lastUpdatedAt,
    generatedAt: input.generatedAt,
    summary: input.summary,
    flowStatus: flow?.status ?? "none",
    flowGeneratedAt: flow?.generatedAt ?? null,
    flowStale: flow?.stale ?? false,
    flowConversationCount: flow?.conversationCount ?? 0,
    completedConversationCount: input.completedConversationCount,
    flowErrorMessage: flow?.errorMessage ?? null,
    hasFlow,
  };

  if (!hasFlow || !flow) {
    return {
      ...base,
      metrics: [],
      steps: [],
      nodeNumber: {},
      edges: [],
      handoffs: [],
      toolUsage: [],
      heavyAreas: [],
      bottlenecks: [],
      automationCandidates: [],
      tribalKnowledge: [],
      decisionNodes: [],
      confidenceCounts: { high: 0, medium: 0, low: 0 },
      allSources: [],
      uniquePainPoints: [],
      automationOpportunities: [],
      criticalPathLabels: [],
      totalEstimatedDuration: null,
    };
  }

  const boxes = computeNodeOrder(flow.nodes, flow.edges);

  // Number nodes in left-to-right reading order (the flow direction) so the
  // flowchart, step cards, and cross-references all line up.
  const orderedIds = [...boxes]
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .map((b) => b.id);
  const nodeNumber: Record<string, number> = {};
  orderedIds.forEach((id, i) => {
    nodeNumber[id] = i + 1;
  });

  const numberOf = (node: FlowNode): StepNode => ({
    ...node,
    number: nodeNumber[node.id] ?? 0,
  });

  const steps: StepNode[] = flow.nodes
    .map(numberOf)
    .sort((a, b) => a.number - b.number);

  const handoffs = deriveHandoffs(flow.nodes, flow.edges);
  const toolUsage = deriveToolUsage(flow.nodes);
  const heavyAreas = deriveHeavyAreas(flow.nodes, handoffs);
  const bottlenecks = deriveBottlenecks(flow).map(numberOf);
  const automationCandidates = deriveAutomationCandidates(flow.nodes).map(
    numberOf,
  );
  const tribalKnowledge = flow.nodes
    .filter((n) => n.isTribalKnowledge)
    .map(numberOf);
  const decisionNodes = flow.nodes
    .filter((n) => n.category === "decision")
    .map(numberOf);
  const confidenceCounts = deriveConfidenceCounts(flow.nodes);
  const allSources = uniqueStrings(flow.nodes.flatMap((n) => n.sources));
  const uniquePainPoints = uniqueStrings(
    flow.nodes.flatMap((n) => n.painPoints),
  );

  const nodeMap = getNodeMap(flow.nodes);
  const criticalPathLabels = flow.insights.criticalPath.map(
    (id) => nodeMap.get(id)?.label ?? id,
  );

  const decisionCount = decisionNodes.length;
  const lowConfidenceCount = confidenceCounts.low;

  const metrics: Metric[] = [
    {
      label: "Evidence",
      value: String(flow.conversationCount),
      detail: `of ${input.completedConversationCount} completed conversations`,
    },
    {
      label: "Mapped Steps",
      value: String(flow.nodes.length),
      detail: `${flow.edges.length} connection${flow.edges.length === 1 ? "" : "s"} mapped`,
    },
    {
      label: "Handoffs",
      value: String(flow.insights.handoffCount),
      detail: `${handoffs.length} related edges or nodes`,
    },
    {
      label: "Tools",
      value: String(flow.insights.toolCount),
      detail: `${toolUsage.length} unique tool${toolUsage.length === 1 ? "" : "s"}`,
    },
    {
      label: "Decisions",
      value: String(decisionCount),
      detail: "Branching or conditional nodes",
    },
    {
      label: "Bottlenecks",
      value: String(bottlenecks.length),
      detail: `${uniquePainPoints.length} pain point${uniquePainPoints.length === 1 ? "" : "s"} attached`,
    },
    {
      label: "Automation",
      value: String(automationCandidates.length),
      detail: "Node-level candidates above none",
    },
    {
      label: "Low Confidence",
      value: String(lowConfidenceCount),
      detail: "Nodes marked inferred or weak",
    },
  ];

  return {
    ...base,
    metrics,
    steps,
    nodeNumber,
    edges: flow.edges,
    handoffs,
    toolUsage,
    heavyAreas,
    bottlenecks,
    automationCandidates,
    tribalKnowledge,
    decisionNodes,
    confidenceCounts,
    allSources,
    uniquePainPoints,
    automationOpportunities: flow.insights.automationOpportunities,
    criticalPathLabels,
    totalEstimatedDuration: flow.insights.totalEstimatedDuration ?? null,
  };
}
