import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api";

// Pure, presentation-agnostic derivations over a generated process flow.
// Shared by the Insights tab (web cards) and the process PDF export so both
// surfaces compute handoffs, tools, bottlenecks, automation candidates, etc.
// from a single source of truth.

export type ProcessFlow = NonNullable<
  FunctionReturnType<typeof api.processFlows.getProcessFlow>
>;
export type FlowNode = ProcessFlow["nodes"][number];
export type FlowEdge = ProcessFlow["edges"][number];
export type Confidence = FlowNode["confidence"];
export type AutomationPotential = FlowNode["automationPotential"];

export type HandoffItem = {
  id: string;
  source: FlowNode;
  target: FlowNode;
  edge: FlowEdge | null;
  actors: string[];
};

export type ToolUsage = {
  name: string;
  steps: FlowNode[];
};

export type HeavyArea = {
  node: FlowNode;
  toolCount: number;
  handoffSignals: number;
};

/** Sort weight for automation potential (higher = better candidate). */
export const AUTOMATION_RANK: Record<AutomationPotential, number> = {
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

export function normalizeText(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function uniqueStrings(values: string[]) {
  const byKey = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = normalizeText(trimmed);
    if (!byKey.has(key)) byKey.set(key, trimmed);
  }
  return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b));
}

export function pluralize(
  count: number,
  singular: string,
  plural = `${singular}s`,
) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function actorList(node: FlowNode) {
  return uniqueStrings(node.actors).join(", ") || "Actor not specified";
}

export function getNodeMap(nodes: FlowNode[]) {
  return new Map(nodes.map((node) => [node.id, node]));
}

/**
 * Whether this node's step has actually been described.
 *
 * A node awaiting (or failed out of) enrichment carries placeholder values —
 * `automationPotential: "low"`, `confidence: "medium"`, `isBottleneck: false`.
 * Those are indistinguishable from real assessments once they reach a
 * derivation, so anything reading them would report findings nobody made:
 * automation candidates that were never assessed, a confidence breakdown that
 * calls half the process "medium". Absent status means a legacy flow, whose
 * nodes were described inline.
 */
export function isNodeDescribed(node: {
  id: string;
  detailStatus?: string;
}): boolean {
  return (node.detailStatus ?? "ready") === "ready";
}

/**
 * The nodes a detail-derived metric may look at. Graph-level derivations
 * (handoffs, decision branches) use the full set — topology is settled as soon
 * as the graph lands.
 *
 * Structural and generic rather than `FlowNode[]`: the PDF builder reaches these
 * nodes through its own input type, and a legacy flow read from anywhere other
 * than `getProcessFlow` may carry no status at all.
 */
export function describedNodes<T extends { id: string; detailStatus?: string }>(
  nodes: T[],
): T[] {
  return nodes.filter(isNodeDescribed);
}

export function actorsChanged(source: FlowNode, target: FlowNode) {
  const sourceActors = uniqueStrings(source.actors).map(normalizeText);
  const targetActors = uniqueStrings(target.actors).map(normalizeText);
  if (sourceActors.length === 0 || targetActors.length === 0) return false;
  if (sourceActors.length !== targetActors.length) return true;
  return sourceActors.some((actor) => !targetActors.includes(actor));
}

export function deriveHandoffs(nodes: FlowNode[], edges: FlowEdge[]) {
  const nodeMap = getNodeMap(nodes);
  const seen = new Set<string>();
  const representedHandoffNodes = new Set<string>();
  const items: HandoffItem[] = [];

  for (const edge of edges) {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) continue;

    const isHandoff =
      source.category === "handoff" ||
      target.category === "handoff" ||
      actorsChanged(source, target);

    if (!isHandoff) continue;

    const id = `edge:${edge.id}`;
    seen.add(id);
    if (source.category === "handoff") representedHandoffNodes.add(source.id);
    if (target.category === "handoff") representedHandoffNodes.add(target.id);
    items.push({
      id,
      source,
      target,
      edge,
      actors: uniqueStrings([...source.actors, ...target.actors]),
    });
  }

  for (const node of nodes) {
    if (node.category !== "handoff") continue;

    const incoming = edges.find((edge) => edge.target === node.id);
    const outgoing = edges.find((edge) => edge.source === node.id);
    const source = incoming ? nodeMap.get(incoming.source) : undefined;
    const target = outgoing ? nodeMap.get(outgoing.target) : undefined;
    const id = `node:${node.id}`;

    if (seen.has(id)) continue;
    if (representedHandoffNodes.has(node.id)) continue;
    items.push({
      id,
      source: source ?? node,
      target: target ?? node,
      edge: outgoing ?? incoming ?? null,
      actors: uniqueStrings([
        ...(source?.actors ?? []),
        ...node.actors,
        ...(target?.actors ?? []),
      ]),
    });
  }

  return items;
}

export function deriveToolUsage(nodes: FlowNode[]) {
  const byTool = new Map<string, ToolUsage>();

  // Tools come from the detail pass, so an un-described node has none and would
  // silently read as a step that uses no tools.
  for (const node of describedNodes(nodes)) {
    for (const tool of uniqueStrings(node.tools)) {
      const key = normalizeText(tool);
      const current = byTool.get(key);
      if (current) {
        current.steps.push(node);
      } else {
        byTool.set(key, { name: tool, steps: [node] });
      }
    }
  }

  return Array.from(byTool.values()).sort(
    (a, b) => b.steps.length - a.steps.length || a.name.localeCompare(b.name),
  );
}

export function deriveHeavyAreas(nodes: FlowNode[], handoffs: HandoffItem[]) {
  const handoffCountByNode = new Map<string, number>();

  for (const item of handoffs) {
    handoffCountByNode.set(
      item.source.id,
      (handoffCountByNode.get(item.source.id) ?? 0) + 1,
    );
    handoffCountByNode.set(
      item.target.id,
      (handoffCountByNode.get(item.target.id) ?? 0) + 1,
    );
  }

  return nodes
    .map((node): HeavyArea => ({
      node,
      toolCount: uniqueStrings(node.tools).length,
      handoffSignals:
        (handoffCountByNode.get(node.id) ?? 0) +
        (node.category === "handoff" ? 1 : 0),
    }))
    .filter((area) => area.toolCount >= 2 || area.handoffSignals > 0)
    .sort(
      (a, b) =>
        b.toolCount + b.handoffSignals - (a.toolCount + a.handoffSignals) ||
        a.node.label.localeCompare(b.node.label),
    );
}

export function deriveBottlenecks(flow: ProcessFlow) {
  const topBottleneckKeys = new Set(
    flow.insights.topBottlenecks.map(normalizeText),
  );

  // `isBottleneck` defaults to false before enrichment, so an un-described step
  // would quietly count as "not a bottleneck" — a conclusion nobody reached.
  return describedNodes(flow.nodes).filter(
    (node) =>
      node.isBottleneck ||
      topBottleneckKeys.has(normalizeText(node.id)) ||
      topBottleneckKeys.has(normalizeText(node.label)),
  );
}

export function deriveAutomationCandidates(nodes: FlowNode[]) {
  return describedNodes(nodes)
    .filter((node) => node.automationPotential !== "none")
    .sort(
      (a, b) =>
        AUTOMATION_RANK[b.automationPotential] -
          AUTOMATION_RANK[a.automationPotential] ||
        a.label.localeCompare(b.label),
    );
}

export function deriveDecisionBranches(node: FlowNode, edges: FlowEdge[]) {
  return edges.filter((edge) => edge.source === node.id);
}

/**
 * Confidence breakdown over described steps only. The totals will not add up to
 * the node count on a partial flow — which is correct: a step nobody described
 * has no confidence, and counting it as "medium" (its placeholder) would put a
 * verdict on the process that no analysis produced.
 */
export function deriveConfidenceCounts(nodes: FlowNode[]) {
  const counts: Record<Confidence, number> = {
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const node of describedNodes(nodes)) counts[node.confidence] += 1;
  return counts;
}
