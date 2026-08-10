import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "../../../convex/_generated/dataModel";
import { FlowNodeLink, ProcessInsightsTab } from "./process-insights-tab";

const { flowFixture } = vi.hoisted(() => ({
  flowFixture: {
    status: "ready",
    stale: false,
    generatedAt: 1_786_000_000_000,
    conversationCount: 2,
    detailsStatus: "ready",
    nodes: [
      {
        id: "handoff",
        label: "Manual handoff",
        category: "handoff",
        description: "FULL FLOW DESCRIPTION SHOULD STAY IN FLOW",
        actors: ["Coordinator", "Approver"],
        tools: ["Email", "Tracker"],
        painPoints: ["The handoff waits for a manual check."],
        automationPotential: "high",
        confidence: "low",
        isBottleneck: true,
        isTribalKnowledge: true,
        riskIndicators: ["Only one coordinator knows the routing rule."],
        sources: ["Alice, Conv. 1"],
        detailStatus: "ready",
      },
      {
        id: "decision",
        label: "Approval decision",
        category: "decision",
        description: "ANOTHER FULL NODE DESCRIPTION",
        actors: ["Approver"],
        tools: [],
        painPoints: [],
        automationPotential: "none",
        confidence: "medium",
        isBottleneck: false,
        isTribalKnowledge: false,
        riskIndicators: [],
        sources: ["Bob, Conv. 2"],
        detailStatus: "ready",
      },
      {
        id: "complete",
        label: "Complete request",
        category: "end",
        description: "FINAL FULL NODE DESCRIPTION",
        actors: ["Coordinator"],
        tools: ["Tracker"],
        painPoints: [],
        automationPotential: "none",
        confidence: "high",
        isBottleneck: false,
        isTribalKnowledge: false,
        riskIndicators: [],
        sources: ["Alice, Conv. 1"],
        detailStatus: "ready",
      },
    ],
    edges: [
      {
        id: "handoff-decision",
        source: "handoff",
        target: "decision",
        type: "sequential",
        isHappyPath: true,
      },
      {
        id: "decision-complete",
        source: "decision",
        target: "complete",
        type: "conditional",
        label: "Approved",
        isHappyPath: true,
      },
    ],
    insights: {
      criticalPath: ["handoff", "decision", "complete"],
      handoffCount: 1,
      toolCount: 2,
      automationOpportunities: ["Automate the routing handoff"],
      automationOpportunityDetails: [
        {
          title: "Automate the routing handoff",
          kind: "workflow",
          nodeIds: ["handoff"],
          rationale: "The routing rule is manual and repeatable.",
          prerequisites: [],
          confidence: "high",
        },
      ],
      automationOpportunitiesSource: "ai",
      topBottlenecks: ["handoff"],
    },
  },
}));

vi.mock("convex/react", () => ({
  useQuery: () => flowFixture,
  useAction: () => async () => ({ message: null }),
}));

describe("Process Insights flow navigation", () => {
  it("carries owning node ids across diagnostic findings", () => {
    const html = renderToStaticMarkup(
      createElement(ProcessInsightsTab, {
        processId: "process-1" as Id<"processes">,
        completedConversationCount: 2,
        canGenerate: true,
        isActive: true,
        onOpenProcessFlow: () => undefined,
      }),
    );

    for (const nodeId of ["handoff", "decision", "complete"]) {
      expect(html).toContain(`data-flow-node-id="${nodeId}"`);
    }
    expect(html).toContain("Open Manual handoff in Process Flow");
    expect(html).toContain("Open Approval decision in Process Flow");
    expect(html).not.toContain("FULL FLOW DESCRIPTION SHOULD STAY IN FLOW");
    expect(html).not.toContain("ANOTHER FULL NODE DESCRIPTION");
  });

  it("opens the exact node owned by the selected finding", () => {
    let openedNodeId: string | null = null;
    const link = FlowNodeLink({
      nodeId: "decision",
      label: "Approval decision",
      onOpenNode: (nodeId) => {
        openedNodeId = nodeId;
      },
    }) as ReactElement<{ onClick: () => void }>;

    link.props.onClick();
    expect(openedNodeId).toBe("decision");
  });
});
