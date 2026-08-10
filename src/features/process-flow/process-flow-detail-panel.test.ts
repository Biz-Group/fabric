import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Id } from "../../../convex/_generated/dataModel";
import { ProcessFlowDetailPanel } from "./process-flow-detail-panel";
import type { ReadFlowNode } from "./use-process-flow-layout";

const conversationId = "conversation-1" as Id<"conversations">;
const node: ReadFlowNode = {
  id: "triage",
  label: "Triage request",
  category: "action",
  description: "The coordinator checks the request.",
  actors: ["Coordinator"],
  tools: ["Queue"],
  painPoints: [],
  automationPotential: "medium",
  confidence: "medium",
  isBottleneck: false,
  isTribalKnowledge: false,
  riskIndicators: [],
  sources: ["Alice, Conv. 1", "Unresolved source"],
  sourceConversations: [
    {
      source: "Alice, Conv. 1",
      conversationId,
      contributorName: "Alice",
    },
  ],
  detailStatus: "ready",
};

describe("ProcessFlowDetailPanel", () => {
  it("links only resolved source citations and leaves the rest readable", () => {
    const html = renderToStaticMarkup(
      createElement(ProcessFlowDetailPanel, {
        node,
        edges: [],
        allNodes: [node],
        onClose: () => undefined,
        onNavigate: () => undefined,
        onOpenConversation: () => undefined,
      }),
    );

    expect(html).toContain(
      'aria-label="Open source conversation: Alice, Conv. 1"',
    );
    expect(html).toContain("Unresolved source");
    expect(html).not.toContain(
      'aria-label="Open source conversation: Unresolved source"',
    );
  });
});
