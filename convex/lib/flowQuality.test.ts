import { describe, expect, test } from "vitest";
import {
  buildFlowQualityReport,
  compareFlowQualityReports,
  type FlowQualitySnapshot,
} from "./flowQuality";

function snapshot(
  overrides: Partial<FlowQualitySnapshot> = {},
): FlowQualitySnapshot {
  return {
    processName: "Ticket triage",
    generationVersion: null,
    status: "ready",
    detailsStatus: null,
    conversationCount: 4,
    nodes: [
      {
        id: "intake",
        label: "Intake",
        category: "start",
        description: "A ticket arrives in the queue.",
        actors: ["Requester"],
        tools: ["Portal"],
        painPoints: [],
        sources: ["Alice, Conv. 1"],
        detailStatus: "ready",
      },
      {
        id: "triage",
        label: "Triage",
        category: "handoff",
        description: "The lead reads and routes it.",
        actors: ["Team lead"],
        tools: ["Jira"],
        painPoints: ["Checked by hand"],
        sources: ["Alice, Conv. 1"],
        detailStatus: "ready",
      },
      {
        id: "resolve",
        label: "Resolve",
        category: "end",
        description: "The owner closes the ticket.",
        actors: ["Owner"],
        tools: ["Jira"],
        painPoints: [],
        sources: ["Bob, Conv. 2"],
        detailStatus: "ready",
      },
    ],
    edges: [
      { source: "intake", target: "triage" },
      { source: "triage", target: "resolve" },
    ],
    criticalPath: ["intake", "triage", "resolve"],
    automationOpportunities: ["Triage assistant: reads every ticket by hand"],
    automationOpportunityDetails: [
      { kind: "agent", nodeIds: ["intake", "triage"] },
    ],
    automationOpportunitiesSource: "ai",
    topBottlenecks: ["Triage"],
    rollingSummary:
      "## Overview\nTickets flow through triage.\n\n## Consensus\nBoth agree [Alice, Conv. 1] and [Bob, Conv. 2].\n\n## Tensions & Gaps\nNone.",
    ...overrides,
  };
}

describe("buildFlowQualityReport", () => {
  test("measures structure, detail coverage, and the summary", () => {
    const report = buildFlowQualityReport(snapshot());

    expect(report.nodeCount).toBe(3);
    expect(report.startNodeCount).toBe(1);
    expect(report.endNodeCount).toBe(1);
    expect(report.danglingEdgeCount).toBe(0);
    expect(report.orphanNodeCount).toBe(0);
    expect(report.describedNodeCount).toBe(3);
    expect(report.nodesWithPainPoints).toBe(1);
    expect(report.nodesWithSources).toBe(3);
    expect(report.multiStepOpportunityCount).toBe(1);
    expect(report.opportunityKinds).toEqual({ agent: 1 });
    expect(report.summarySections).toEqual([
      "Overview",
      "Consensus",
      "Tensions & Gaps",
    ]);
    expect(report.summaryCitationCount).toBe(2);
  });

  test("counts a step nothing connects to as an orphan", () => {
    const report = buildFlowQualityReport(
      snapshot({
        nodes: [
          ...snapshot().nodes,
          { id: "stranded", label: "Stranded", category: "action" },
        ],
      }),
    );

    expect(report.orphanNodeCount).toBe(1);
    // And it drags coverage down, because it has no description.
    expect(report.describedNodeCount).toBe(3);
    expect(report.nodeCount).toBe(4);
  });

  test("counts edges pointing at steps that do not exist", () => {
    const report = buildFlowQualityReport(
      snapshot({
        edges: [
          { source: "intake", target: "triage" },
          { source: "triage", target: "ghost" },
        ],
      }),
    );

    expect(report.danglingEdgeCount).toBe(1);
  });

  test("treats an ungenerated flow as empty rather than throwing", () => {
    const report = buildFlowQualityReport(
      snapshot({
        nodes: [],
        edges: [],
        criticalPath: [],
        automationOpportunities: [],
        automationOpportunityDetails: undefined,
        automationOpportunitiesSource: null,
        topBottlenecks: [],
        rollingSummary: null,
      }),
    );

    expect(report.nodeCount).toBe(0);
    expect(report.meanDescriptionChars).toBe(0);
    expect(report.summaryChars).toBe(0);
    expect(report.summarySections).toEqual([]);
  });
});

describe("compareFlowQualityReports", () => {
  const before = buildFlowQualityReport(snapshot());

  test("passes a like-for-like regeneration", () => {
    const after = buildFlowQualityReport(
      snapshot({ generationVersion: "v3", detailsStatus: "ready" }),
    );
    const comparison = compareFlowQualityReports(before, after);

    expect(comparison.regressions).toEqual([]);
  });

  test("flags steps that lost their description", () => {
    // The failure staging could plausibly introduce: the flow completes, and
    // says less than the single call did.
    const after = buildFlowQualityReport(
      snapshot({
        nodes: snapshot().nodes.map((node) =>
          node.id === "triage"
            ? { ...node, description: "", detailStatus: "failed" }
            : node,
        ),
      }),
    );
    const comparison = compareFlowQualityReports(before, after);

    expect(comparison.regressions).toContainEqual(
      expect.stringContaining("Described steps fell"),
    );
    expect(comparison.regressions).toContainEqual(
      expect.stringContaining("detail batch failed"),
    );
  });

  test("flags a structurally broken graph", () => {
    const after = buildFlowQualityReport(
      snapshot({
        nodes: snapshot().nodes.map((n) =>
          n.id === "resolve" ? { ...n, category: "action" } : n,
        ),
        edges: [
          { source: "intake", target: "triage" },
          { source: "triage", target: "ghost" },
        ],
      }),
    );
    const comparison = compareFlowQualityReports(before, after);

    expect(comparison.regressions).toContainEqual(
      expect.stringContaining("does not exist"),
    );
    expect(comparison.regressions).toContainEqual(
      expect.stringContaining("no end step"),
    );
  });

  test("flags fallback automation opportunities as a regression", () => {
    // The product output the whole thing exists for. Placeholders are not it.
    const after = buildFlowQualityReport(
      snapshot({
        automationOpportunitiesSource: "derived",
        automationOpportunityDetails: undefined,
      }),
    );
    const comparison = compareFlowQualityReports(before, after);

    expect(comparison.regressions).toContainEqual(
      expect.stringContaining("not analysed"),
    );
  });

  test("flags a summary that lost a section", () => {
    const after = buildFlowQualityReport(
      snapshot({
        rollingSummary: "## Overview\nTickets flow through triage.",
      }),
    );
    const comparison = compareFlowQualityReports(before, after);

    expect(comparison.regressions).toContainEqual(
      expect.stringContaining("Consensus"),
    );
  });

  test("treats a changed step count as a judgement call, not a verdict", () => {
    // Fewer steps can mean better consolidation or lost work, and only a human
    // reading both flows can tell which.
    const after = buildFlowQualityReport(
      snapshot({ nodes: snapshot().nodes.slice(0, 2) }),
    );
    const comparison = compareFlowQualityReports(before, after);

    expect(comparison.judgementCalls).toContainEqual(
      expect.stringContaining("Step count"),
    );
  });

  test("treats fewer opportunities as a judgement call, but none as a regression", () => {
    const fewer = buildFlowQualityReport(
      snapshot({
        automationOpportunities: [],
        automationOpportunityDetails: [],
        automationOpportunitiesSource: "ai",
      }),
    );
    const comparison = compareFlowQualityReports(before, fewer);

    // Zero is a real loss; merely fewer is a consolidation question.
    expect(comparison.regressions).toContainEqual(
      expect.stringContaining("to none"),
    );
  });

  test("credits what improved", () => {
    const after = buildFlowQualityReport(
      snapshot({
        nodes: snapshot().nodes.map((n) => ({
          ...n,
          painPoints: ["Something slow"],
        })),
      }),
    );
    const comparison = compareFlowQualityReports(before, after);

    expect(comparison.improvements).toContainEqual(
      expect.stringContaining("Steps with pain points"),
    );
    expect(comparison.improvements).toContainEqual(
      expect.stringContaining("span multiple steps"),
    );
  });
});
