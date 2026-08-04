/**
 * Measurements for the quality-parity gate.
 *
 * The staged pipeline is bounded where the single call was not, but boundedness
 * is not allowed to silently cost fidelity — a flow that always completes and
 * always says less is a regression. Regenerating overwrites the row it replaces,
 * so the old flow has to be measured BEFORE the new one is generated; these
 * reports are what gets captured and compared.
 *
 * The numbers do not replace reading the two flows side by side. They separate
 * the objectively checkable (dangling edges, missing start, empty descriptions)
 * from the judgement call (is this granularity better), so the human only has to
 * spend judgement on the second.
 */

type FlowNodeLike = {
  id: string;
  label: string;
  category: string;
  description?: string;
  actors?: string[];
  tools?: string[];
  painPoints?: string[];
  riskIndicators?: string[];
  sources?: string[];
  detailStatus?: string;
};

type FlowEdgeLike = {
  source: string;
  target: string;
};

export type FlowQualitySnapshot = {
  processName: string;
  generationVersion: string | null;
  status: string;
  detailsStatus: string | null;
  conversationCount: number;
  nodes: FlowNodeLike[];
  edges: FlowEdgeLike[];
  criticalPath: string[];
  automationOpportunities: string[];
  automationOpportunityDetails?: Array<{
    kind: string;
    nodeIds: string[];
  }>;
  automationOpportunitiesSource: string | null;
  topBottlenecks: string[];
  rollingSummary: string | null;
};

export type FlowQualityReport = {
  processName: string;
  generationVersion: string | null;
  status: string;
  detailsStatus: string | null;
  conversationCount: number;

  nodeCount: number;
  edgeCount: number;
  startNodeCount: number;
  endNodeCount: number;
  /** Edges pointing at a node that does not exist. Should always be 0. */
  danglingEdgeCount: number;
  /** Nodes with no edge in or out — a step disconnected from the process. */
  orphanNodeCount: number;
  criticalPathLength: number;

  /** Nodes carrying a non-empty description. */
  describedNodeCount: number;
  meanDescriptionChars: number;
  nodesWithActors: number;
  nodesWithTools: number;
  nodesWithPainPoints: number;
  nodesWithSources: number;
  failedDetailNodeCount: number;

  automationOpportunityCount: number;
  automationOpportunitiesSource: string | null;
  /** Opportunities covering more than one step — the cross-step reasoning. */
  multiStepOpportunityCount: number;
  opportunityKinds: Record<string, number>;
  bottleneckCount: number;

  summaryChars: number;
  summarySections: string[];
  summaryCitationCount: number;
};

const SUMMARY_SECTION_PATTERN = /^##\s+(.+)$/gm;
const CITATION_PATTERN = /\[[^\]]+,\s*Conv\.\s*\d+\]/g;

function nonEmpty(values: string[] | undefined): boolean {
  return (values ?? []).some((value) => value.trim().length > 0);
}

export function buildFlowQualityReport(
  snapshot: FlowQualitySnapshot,
): FlowQualityReport {
  const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
  const connected = new Set<string>();
  let danglingEdgeCount = 0;

  for (const edge of snapshot.edges) {
    const sourceKnown = nodeIds.has(edge.source);
    const targetKnown = nodeIds.has(edge.target);
    if (!sourceKnown || !targetKnown) danglingEdgeCount++;
    if (sourceKnown) connected.add(edge.source);
    if (targetKnown) connected.add(edge.target);
  }

  const described = snapshot.nodes.filter(
    (node) => (node.description ?? "").trim().length > 0,
  );
  const totalDescriptionChars = described.reduce(
    (sum, node) => sum + (node.description ?? "").trim().length,
    0,
  );

  const opportunityKinds: Record<string, number> = {};
  for (const opportunity of snapshot.automationOpportunityDetails ?? []) {
    opportunityKinds[opportunity.kind] =
      (opportunityKinds[opportunity.kind] ?? 0) + 1;
  }

  const summary = snapshot.rollingSummary ?? "";

  return {
    processName: snapshot.processName,
    generationVersion: snapshot.generationVersion,
    status: snapshot.status,
    detailsStatus: snapshot.detailsStatus,
    conversationCount: snapshot.conversationCount,

    nodeCount: snapshot.nodes.length,
    edgeCount: snapshot.edges.length,
    startNodeCount: snapshot.nodes.filter((n) => n.category === "start").length,
    endNodeCount: snapshot.nodes.filter((n) => n.category === "end").length,
    danglingEdgeCount,
    orphanNodeCount: snapshot.nodes.filter((n) => !connected.has(n.id)).length,
    criticalPathLength: snapshot.criticalPath.length,

    describedNodeCount: described.length,
    meanDescriptionChars:
      described.length === 0
        ? 0
        : Math.round(totalDescriptionChars / described.length),
    nodesWithActors: snapshot.nodes.filter((n) => nonEmpty(n.actors)).length,
    nodesWithTools: snapshot.nodes.filter((n) => nonEmpty(n.tools)).length,
    nodesWithPainPoints: snapshot.nodes.filter((n) => nonEmpty(n.painPoints))
      .length,
    nodesWithSources: snapshot.nodes.filter((n) => nonEmpty(n.sources)).length,
    failedDetailNodeCount: snapshot.nodes.filter(
      (n) => n.detailStatus === "failed",
    ).length,

    automationOpportunityCount: snapshot.automationOpportunities.length,
    automationOpportunitiesSource: snapshot.automationOpportunitiesSource,
    multiStepOpportunityCount: (
      snapshot.automationOpportunityDetails ?? []
    ).filter((o) => o.nodeIds.length > 1).length,
    opportunityKinds,
    bottleneckCount: snapshot.topBottlenecks.length,

    summaryChars: summary.length,
    summarySections: [...summary.matchAll(SUMMARY_SECTION_PATTERN)].map((m) =>
      m[1].trim(),
    ),
    summaryCitationCount: (summary.match(CITATION_PATTERN) ?? []).length,
  };
}

export type FlowQualityComparison = {
  /** Objective losses. Any entry here blocks the gate until explained. */
  regressions: string[];
  /** Differences a human has to judge rather than a rule. */
  judgementCalls: string[];
  /** Things that improved, so the gate is not only a list of complaints. */
  improvements: string[];
  before: FlowQualityReport;
  after: FlowQualityReport;
};

function describeChange(label: string, before: number, after: number): string {
  const direction = after > before ? "up" : "down";
  return `${label}: ${before} → ${after} (${direction} ${Math.abs(after - before)})`;
}

export function compareFlowQualityReports(
  before: FlowQualityReport,
  after: FlowQualityReport,
): FlowQualityComparison {
  const regressions: string[] = [];
  const judgementCalls: string[] = [];
  const improvements: string[] = [];

  // --- Structural health: pass/fail, no judgement involved ---
  if (after.danglingEdgeCount > 0) {
    regressions.push(
      `The new flow has ${after.danglingEdgeCount} edge(s) pointing at a step that does not exist.`,
    );
  }
  if (after.startNodeCount !== 1) {
    regressions.push(
      `The new flow has ${after.startNodeCount} start steps; a process should have exactly one.`,
    );
  }
  if (after.endNodeCount === 0) {
    regressions.push("The new flow has no end step.");
  }
  if (after.orphanNodeCount > before.orphanNodeCount) {
    regressions.push(
      describeChange(
        "Disconnected steps",
        before.orphanNodeCount,
        after.orphanNodeCount,
      ),
    );
  }

  // --- Detail coverage: the thing staging could plausibly cost us ---
  const beforeCoverage = before.nodeCount
    ? before.describedNodeCount / before.nodeCount
    : 0;
  const afterCoverage = after.nodeCount
    ? after.describedNodeCount / after.nodeCount
    : 0;
  if (afterCoverage < beforeCoverage - 0.01) {
    regressions.push(
      `Described steps fell from ${Math.round(beforeCoverage * 100)}% to ${Math.round(afterCoverage * 100)}%.`,
    );
  }
  if (after.failedDetailNodeCount > 0) {
    regressions.push(
      `${after.failedDetailNodeCount} step(s) have no description because their detail batch failed.`,
    );
  }
  for (const [label, b, a] of [
    ["Steps naming actors", before.nodesWithActors, after.nodesWithActors],
    ["Steps naming tools", before.nodesWithTools, after.nodesWithTools],
    [
      "Steps with pain points",
      before.nodesWithPainPoints,
      after.nodesWithPainPoints,
    ],
    ["Steps citing sources", before.nodesWithSources, after.nodesWithSources],
  ] as const) {
    if (a < b) regressions.push(describeChange(label, b, a));
    else if (a > b) improvements.push(describeChange(label, b, a));
  }

  // --- Automation opportunities: the product's actual output ---
  if (after.automationOpportunitiesSource === "derived") {
    regressions.push(
      "Automation opportunities were not analysed — these are fallback placeholders, not opportunities.",
    );
  }
  if (
    after.automationOpportunityCount === 0 &&
    before.automationOpportunityCount > 0
  ) {
    regressions.push(
      `Automation opportunities went from ${before.automationOpportunityCount} to none.`,
    );
  } else if (
    after.automationOpportunityCount < before.automationOpportunityCount
  ) {
    // Fewer is not automatically worse: the new pass merges steps that belong to
    // one buildable thing, where the old one listed them separately.
    judgementCalls.push(
      `${describeChange("Automation opportunities", before.automationOpportunityCount, after.automationOpportunityCount)} — check whether the new ones consolidate the old ones or drop them.`,
    );
  }
  if (after.multiStepOpportunityCount > 0) {
    improvements.push(
      `${after.multiStepOpportunityCount} opportunity/opportunities span multiple steps (the old single call could not do this).`,
    );
  }

  // --- Granularity and prose: for the human ---
  if (after.nodeCount !== before.nodeCount) {
    judgementCalls.push(
      `${describeChange("Step count", before.nodeCount, after.nodeCount)} — read both flows and decide whether the new granularity is better or whether steps were lost.`,
    );
  }
  if (after.meanDescriptionChars < before.meanDescriptionChars * 0.75) {
    judgementCalls.push(
      `${describeChange("Mean description length", before.meanDescriptionChars, after.meanDescriptionChars)} — shorter is fine if it is denser, not if it is thinner.`,
    );
  }

  // --- Rolling summary ---
  const lostSections = before.summarySections.filter(
    (section) => !after.summarySections.includes(section),
  );
  if (lostSections.length > 0) {
    regressions.push(
      `The rolling summary lost section(s): ${lostSections.join(", ")}.`,
    );
  }
  if (after.summaryCitationCount < before.summaryCitationCount) {
    judgementCalls.push(
      `${describeChange("Summary citations", before.summaryCitationCount, after.summaryCitationCount)} — consensus and tension detail is what the rebuild exists to preserve.`,
    );
  }

  return { regressions, judgementCalls, improvements, before, after };
}
