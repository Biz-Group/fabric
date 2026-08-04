import { describe, expect, test } from "vitest";
import {
  describedNodes,
  deriveAutomationCandidates,
  deriveBottlenecks,
  deriveConfidenceCounts,
  deriveHandoffs,
  deriveToolUsage,
  isNodeDescribed,
  type FlowNode,
  type ProcessFlow,
} from "./insights-derivations";

/**
 * These guard the hazard the staged pipeline introduces: a node awaiting or
 * failed out of enrichment carries placeholder values that are
 * indistinguishable from real assessments. Anything that reads them reports
 * findings nobody made.
 */
function node(overrides: Partial<FlowNode> & { id: string }): FlowNode {
  return {
    label: overrides.id,
    category: "action",
    description: "",
    actors: [],
    tools: [],
    painPoints: [],
    // The placeholders a node carries before its batch runs.
    automationPotential: "low",
    confidence: "medium",
    isBottleneck: false,
    isTribalKnowledge: false,
    riskIndicators: [],
    sources: [],
    detailStatus: "ready",
    ...overrides,
  } as FlowNode;
}

const described = node({
  id: "triage",
  label: "Triage",
  description: "The lead routes it.",
  tools: ["Jira"],
  actors: ["Team lead"],
  automationPotential: "high",
  confidence: "high",
  isBottleneck: true,
  detailStatus: "ready",
});

const pending = node({
  id: "waiting",
  label: "Waiting",
  detailStatus: "pending",
});
const failed = node({ id: "broken", label: "Broken", detailStatus: "failed" });

describe("isNodeDescribed", () => {
  test("only a ready node counts as described", () => {
    expect(isNodeDescribed(described)).toBe(true);
    expect(isNodeDescribed(pending)).toBe(false);
    expect(isNodeDescribed(failed)).toBe(false);
    expect(
      isNodeDescribed(node({ id: "generating", detailStatus: "generating" })),
    ).toBe(false);
  });

  test("a node with no status at all counts as described", () => {
    // `getProcessFlow` always sets the status, but the PDF builder reaches
    // nodes through its own type and a legacy flow read elsewhere may carry
    // none. Absent must mean described, or a single-call flow would render as
    // if nothing in it had been analysed.
    expect(isNodeDescribed({ id: "legacy" })).toBe(true);
    expect(describedNodes([{ id: "legacy" }])).toHaveLength(1);
  });
});

describe("detail-derived metrics ignore un-described steps", () => {
  const nodes = [described, pending, failed];

  test("automation candidates exclude steps nobody assessed", () => {
    // The placeholder is "low", which is a candidate — so without filtering,
    // every unfinished step would appear as an automation opportunity.
    const candidates = deriveAutomationCandidates(nodes);
    expect(candidates.map((n) => n.id)).toEqual(["triage"]);
  });

  test("confidence counts only cover described steps", () => {
    // Placeholder confidence is "medium"; counting it would put a verdict on
    // the process that no analysis produced. The total intentionally does not
    // reach the node count.
    expect(deriveConfidenceCounts(nodes)).toEqual({
      high: 1,
      medium: 0,
      low: 0,
    });
  });

  test("bottlenecks exclude steps whose assessment never ran", () => {
    const flow = {
      nodes,
      edges: [],
      insights: { topBottlenecks: ["Broken"] },
    } as unknown as ProcessFlow;

    // "Broken" is named in the stored rollup but was never described, so it is
    // not asserted as a bottleneck.
    expect(deriveBottlenecks(flow).map((n) => n.id)).toEqual(["triage"]);
  });

  test("tool usage excludes steps with no described tools", () => {
    const usage = deriveToolUsage(nodes);
    expect(usage).toHaveLength(1);
    expect(usage[0].steps.map((n) => n.id)).toEqual(["triage"]);
  });
});

describe("graph-derived metrics use every step", () => {
  test("handoffs are topology, so they do not wait for descriptions", () => {
    // The graph is settled the moment it lands; a handoff is a fact about the
    // shape of the process, not an assessment of a step.
    const nodes = [
      node({ id: "a", label: "A", detailStatus: "ready" }),
      node({
        id: "b",
        label: "B",
        category: "handoff",
        detailStatus: "pending",
      }),
    ];
    const edges = [
      {
        id: "a-b",
        source: "a",
        target: "b",
        type: "sequential",
        isHappyPath: true,
      },
    ] as unknown as ProcessFlow["edges"];

    const handoffs = deriveHandoffs(nodes, edges);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].target.id).toBe("b");
  });
});
