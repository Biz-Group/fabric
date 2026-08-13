import { describe, expect, it } from "vitest";
import type { ProcessFlow } from "@/features/insights/insights-derivations";
import { deriveFlowSpotlights, spotlightStatusText } from "./flow-spotlight";

function createFlow(): ProcessFlow {
  const nodes = [
    {
      id: "intake",
      label: "Intake",
      category: "start" as const,
      description: "Starts the process",
      actors: ["Operations"],
      tools: ["Forms"],
      estimatedDuration: "5 minutes",
      painPoints: [],
      automationPotential: "low" as const,
      confidence: "high" as const,
      sources: [],
      isBottleneck: false,
      isTribalKnowledge: false,
      risks: [],
      detailStatus: "ready" as const,
    },
    {
      id: "review",
      label: "Manual review",
      category: "action" as const,
      description: "Reviews the request",
      actors: ["Analyst"],
      tools: ["CRM", "Forms"],
      estimatedDuration: "2 hours",
      painPoints: ["Queue"],
      automationPotential: "high" as const,
      confidence: "high" as const,
      sources: [],
      isBottleneck: true,
      isTribalKnowledge: false,
      risks: [],
      detailStatus: "ready" as const,
    },
    {
      id: "archive",
      label: "Archive",
      category: "end" as const,
      description: "Archives the request",
      actors: ["Analyst"],
      tools: [],
      estimatedDuration: "1 minute",
      painPoints: [],
      automationPotential: "none" as const,
      confidence: "high" as const,
      sources: [],
      isBottleneck: false,
      isTribalKnowledge: false,
      risks: [],
      detailStatus: "ready" as const,
    },
  ];
  const edges = [
    {
      id: "intake-review",
      source: "intake",
      target: "review",
      type: "sequential" as const,
      isHappyPath: true,
    },
    {
      id: "review-archive",
      source: "review",
      target: "archive",
      type: "sequential" as const,
      isHappyPath: true,
    },
  ];

  return {
    _id: "flow-id" as ProcessFlow["_id"],
    _creationTime: 1,
    processId: "process-id" as ProcessFlow["processId"],
    clerkOrgId: "org-id",
    status: "ready",
    stale: false,
    generatedAt: 1,
    conversationCount: 1,
    nodes,
    edges,
    insights: {
      criticalPath: ["intake", "review", "archive"],
      handoffCount: 1,
      toolCount: 2,
      automationOpportunities: ["Automate review"],
      topBottlenecks: ["Manual review"],
    },
  } as ProcessFlow;
}

describe("deriveFlowSpotlights", () => {
  it("maps bottleneck and automation findings to described nodes", () => {
    const spotlights = deriveFlowSpotlights(createFlow());

    expect(spotlights.bottlenecks.nodeIds).toEqual(new Set(["review"]));
    expect(spotlights.automation.nodeIds).toEqual(
      new Set(["review", "intake"]),
    );
    expect(spotlights.bottlenecks.edgeIds).toEqual(
      new Set(["intake-review", "review-archive"]),
    );
  });

  it("maps handoff edges to both visible endpoints", () => {
    const spotlights = deriveFlowSpotlights(createFlow());

    expect(spotlights.handoffs.metricCount).toBe(1);
    expect(spotlights.handoffs.nodeIds).toEqual(new Set(["intake", "review"]));
    expect(spotlights.handoffs.edgeIds).toContain("intake-review");
    expect(spotlights.handoffs.edgeIds).not.toContain("review-archive");
  });

  it("counts unique tools while locating every step that uses one", () => {
    const spotlights = deriveFlowSpotlights(createFlow());

    expect(spotlights.tools.metricCount).toBe(2);
    expect(spotlights.tools.nodeIds).toEqual(new Set(["intake", "review"]));
  });

  it("does not treat unfinished detail placeholders as findings", () => {
    const flow = createFlow();
    flow.nodes[1]!.detailStatus = "pending";

    const spotlights = deriveFlowSpotlights(flow);

    expect(spotlights.bottlenecks.nodeIds).toEqual(new Set());
    expect(spotlights.automation.nodeIds).toEqual(new Set(["intake"]));
    expect(spotlights.tools.metricCount).toBe(1);
  });
});

describe("spotlightStatusText", () => {
  it("explains matching and empty spotlight states", () => {
    const spotlight = deriveFlowSpotlights(createFlow()).bottlenecks;
    expect(spotlightStatusText(spotlight)).toBe(
      "Spotlighting 1 step related to bottlenecks. Other steps remain visible.",
    );

    expect(spotlightStatusText({ ...spotlight, nodeIds: new Set() })).toBe(
      "No steps match the bottlenecks spotlight. The full process remains visible.",
    );
  });
});
