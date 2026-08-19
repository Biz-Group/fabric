import { describe, expect, test } from "vitest";
import { parseFlowResponsePayload } from "./processFlows";
import { isTokenLimitFinishReason, isWithinTimeBudget } from "./lib/aiProvider";
import {
  buildFlowInsightsAIRequest,
  buildGraphAIRequest,
  buildNodeDetailsAIRequest,
  deriveFlowInsights,
  normalizeAutomationOpportunities,
  GRAPH_MAX_TOKENS,
  GRAPH_MAX_RETRIES,
  GRAPH_TIMEOUT_MS,
  NODE_DETAILS_MAX_RETRIES,
  NODE_DETAILS_MAX_TOKENS,
  NODE_DETAILS_TIMEOUT_MS,
  normalizeGraphResponse,
  normalizeNodeDetailsResponse,
  placeholderNodeDetail,
} from "./lib/flowStages";

const sampleGraphPayload = {
  nodes: [
    { id: "start-request", label: "Start Request", category: "start" },
    { id: "approve-request", label: "Approve Request", category: "handoff" },
  ],
  edges: [
    {
      id: "start-request-approve-request",
      source: "start-request",
      target: "approve-request",
      type: "sequential",
      isHappyPath: true,
    },
  ],
  insights: { criticalPath: ["start-request", "approve-request"] },
};

describe("flow-stage request budgets", () => {
  test("every stage request satisfies the time-budget rule", () => {
    // The rule these numbers exist to satisfy: a call must be able to finish
    // inside its timeout at the WORST measured throughput. If the measured
    // constants are refreshed and a stage stops fitting, this fails here
    // rather than in production.
    const stages = [
      { stage: "graph", request: buildGraphAIRequest("evidence") },
      { stage: "details", request: buildNodeDetailsAIRequest("evidence") },
    ];

    for (const { stage, request } of stages) {
      expect({
        stage,
        fits: isWithinTimeBudget(request.maxTokens, request.timeoutMs),
      }).toEqual({ stage, fits: true });
    }
  });

  test("each stage's full retry budget fits inside one Convex action", () => {
    // One LLM call per scheduled action is only safe if all of that call's
    // attempts fit the 10-minute action ceiling.
    const graphWorstCase = (1 + GRAPH_MAX_RETRIES) * GRAPH_TIMEOUT_MS;
    const detailsWorstCase =
      (1 + NODE_DETAILS_MAX_RETRIES) * NODE_DETAILS_TIMEOUT_MS;

    expect(graphWorstCase).toBeLessThan(600_000);
    expect(detailsWorstCase).toBeLessThan(600_000);
  });

  test("the graph pass asks for far less than the old single call", () => {
    // The retired single call requested 32,768 tokens, which is what made
    // truncation a live failure mode.
    expect(GRAPH_MAX_TOKENS).toBeLessThan(32_768 / 4);
    expect(NODE_DETAILS_MAX_TOKENS).toBeLessThan(GRAPH_MAX_TOKENS);
  });

  test("both stages force a structured tool response", () => {
    expect(buildGraphAIRequest("x").tool.name).toBe("return_process_graph");
    expect(buildGraphAIRequest("x").tool.inputSchema.required).toEqual([
      "nodes",
      "edges",
      "insights",
    ]);
    expect(buildNodeDetailsAIRequest("x").tool.name).toBe(
      "return_node_details",
    );
  });
});

describe("graph normalization", () => {
  test("keeps only well-formed nodes and edges between them", () => {
    const graph = normalizeGraphResponse({
      nodes: [
        ...sampleGraphPayload.nodes,
        { id: "no-label", label: "", category: "action" },
        { id: "odd-category", label: "Odd", category: "nonsense" },
      ],
      edges: [
        ...sampleGraphPayload.edges,
        {
          id: "dangling",
          source: "start-request",
          target: "does-not-exist",
          type: "sequential",
          isHappyPath: true,
        },
      ],
      insights: { criticalPath: ["start-request", "does-not-exist"] },
    });

    expect(graph.nodes.map((n) => n.id)).toEqual([
      "start-request",
      "approve-request",
      "odd-category",
    ]);
    // Unknown category degrades to "action" rather than dropping the step.
    expect(graph.nodes[2].category).toBe("action");
    // An edge to a node that does not exist would render as a broken diagram.
    expect(graph.edges).toHaveLength(1);
    expect(graph.criticalPath).toEqual(["start-request"]);
  });

  test("drops duplicate node ids, which would make detail rows ambiguous", () => {
    const graph = normalizeGraphResponse({
      nodes: [
        { id: "triage", label: "Triage", category: "action" },
        { id: "triage", label: "Triage Again", category: "decision" },
      ],
      edges: [],
      insights: { criticalPath: [] },
    });

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].label).toBe("Triage");
  });

  test("survives a response with nothing usable in it", () => {
    const graph = normalizeGraphResponse({});
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.criticalPath).toEqual([]);
  });
});

describe("node detail normalization", () => {
  const requested = ["intake", "triage"];

  test("returns details keyed by node id", () => {
    const details = normalizeNodeDetailsResponse(
      {
        details: [
          {
            nodeId: "intake",
            description: "Request arrives",
            actors: ["Requester"],
            tools: ["Portal"],
            painPoints: [],
            automationPotential: "high",
            confidence: "high",
            isBottleneck: false,
            isTribalKnowledge: false,
            riskIndicators: [],
            sources: ["Alice, Conv. 1"],
          },
        ],
      },
      requested,
    );

    expect(details.get("intake")?.description).toBe("Request arrives");
    expect(details.has("triage")).toBe(false);
  });

  test("ignores details for nodes it did not ask about", () => {
    // A model answering about another batch's node would otherwise overwrite
    // that batch's work.
    const details = normalizeNodeDetailsResponse(
      {
        details: [
          { nodeId: "somewhere-else", description: "Not mine" },
          { nodeId: "triage", description: "Mine" },
        ],
      },
      requested,
    );

    expect([...details.keys()]).toEqual(["triage"]);
  });

  test("defaults unknown automation potential to low, never none", () => {
    // "none" means "already automated" in this taxonomy, so coercing to it
    // would hide the step from the Insights tab's automation candidates.
    const details = normalizeNodeDetailsResponse(
      { details: [{ nodeId: "intake", description: "x" }] },
      requested,
    );

    expect(details.get("intake")?.automationPotential).toBe("low");
    expect(details.get("intake")?.confidence).toBe("medium");
    expect(details.get("intake")?.actors).toEqual([]);
  });
});

describe("insight derivation", () => {
  const nodes = [
    { id: "intake", label: "Intake", category: "start" as const },
    { id: "triage", label: "Triage", category: "handoff" as const },
    { id: "resolve", label: "Resolve", category: "action" as const },
  ];

  test("prefers the analysed opportunities and marks them as such", () => {
    // The product exists to surface where work can be transformed, and
    // downstream tooling builds from these — so an analysed opportunity must
    // win over the fallback, and the source must say which one you have.
    const insights = deriveFlowInsights(nodes, new Map(), {
      criticalPath: [],
      automationOpportunityDetails: [
        {
          title: "Triage assistant",
          kind: "agent",
          nodeIds: ["triage"],
          rationale: "The lead reads every ticket by hand before routing it.",
          prerequisites: ["Jira API access"],
          confidence: "high",
        },
      ],
    });

    expect(insights.automationOpportunitiesSource).toBe("ai");
    expect(insights.automationOpportunityDetails).toHaveLength(1);
    expect(insights.automationOpportunityDetails?.[0].kind).toBe("agent");
    expect(insights.automationOpportunities[0]).toBe(
      "Triage assistant: The lead reads every ticket by hand before routing it.",
    );
  });

  test("falls back to flagging automatable steps, and says it did", () => {
    const details = new Map([
      [
        "triage",
        {
          ...placeholderNodeDetail(),
          automationPotential: "high" as const,
          painPoints: ["Queue is checked by hand"],
        },
      ],
    ]);

    const insights = deriveFlowInsights(nodes, details, { criticalPath: [] });

    // "derived" is the signal that the insights stage failed and these are
    // placeholders for a human, not analysed opportunities to build from.
    expect(insights.automationOpportunitiesSource).toBe("derived");
    expect(insights.automationOpportunityDetails).toBeUndefined();
    expect(insights.automationOpportunities).toEqual([
      "Triage: Queue is checked by hand",
    ]);
  });

  test("rolls up tools, bottlenecks, and automation candidates from details", () => {
    const details = new Map([
      [
        "triage",
        {
          ...placeholderNodeDetail(),
          tools: ["Jira", "Email"],
          isBottleneck: true,
          automationPotential: "high" as const,
          painPoints: ["Queue is checked by hand"],
        },
      ],
      [
        "resolve",
        {
          ...placeholderNodeDetail(),
          tools: ["Jira"],
          automationPotential: "none" as const,
        },
      ],
    ]);

    const insights = deriveFlowInsights(nodes, details, {
      criticalPath: ["intake", "triage"],
    });

    // Deduplicated across nodes.
    expect(insights.toolCount).toBe(2);
    expect(insights.topBottlenecks).toEqual(["Triage"]);
    // Grounded in the contributor's own pain point rather than invented prose.
    expect(insights.automationOpportunities).toEqual([
      "Triage: Queue is checked by hand",
    ]);
    // Derived from the graph, so it holds even before details land.
    expect(insights.handoffCount).toBe(1);
    expect(insights.criticalPath).toEqual(["intake", "triage"]);
  });

  test("yields empty rollups when no details landed", () => {
    const insights = deriveFlowInsights(nodes, new Map(), {
      criticalPath: [],
    });

    expect(insights.toolCount).toBe(0);
    expect(insights.automationOpportunities).toEqual([]);
    expect(insights.topBottlenecks).toEqual([]);
    expect(insights.handoffCount).toBe(1);
  });
});

describe("automation opportunity normalization", () => {
  const knownNodeIds = ["intake", "triage", "resolve"];

  const wellFormed = {
    title: "Triage assistant",
    kind: "agent",
    nodeIds: ["triage"],
    rationale: "The lead reads every ticket by hand.",
    expectedBenefit: "Saves ~2 hours a day",
    prerequisites: ["Jira API access"],
    confidence: "high",
  };

  test("keeps well-formed opportunities with their structure intact", () => {
    const [opportunity] = normalizeAutomationOpportunities(
      { opportunities: [wellFormed] },
      knownNodeIds,
    );

    expect(opportunity).toEqual({
      title: "Triage assistant",
      kind: "agent",
      nodeIds: ["triage"],
      rationale: "The lead reads every ticket by hand.",
      expectedBenefit: "Saves ~2 hours a day",
      prerequisites: ["Jira API access"],
      confidence: "high",
    });
  });

  test("spans multiple steps, because one opportunity often is several steps", () => {
    const [opportunity] = normalizeAutomationOpportunities(
      {
        opportunities: [
          { ...wellFormed, nodeIds: ["intake", "triage", "resolve"] },
        ],
      },
      knownNodeIds,
    );

    expect(opportunity.nodeIds).toEqual(["intake", "triage", "resolve"]);
  });

  test("drops node ids that are not in the graph", () => {
    // An opportunity pointing at an invented step cannot be built from.
    const [opportunity] = normalizeAutomationOpportunities(
      { opportunities: [{ ...wellFormed, nodeIds: ["triage", "invented"] }] },
      knownNodeIds,
    );

    expect(opportunity.nodeIds).toEqual(["triage"]);
  });

  test("discards an opportunity left pointing at nothing", () => {
    const opportunities = normalizeAutomationOpportunities(
      { opportunities: [{ ...wellFormed, nodeIds: ["invented"] }] },
      knownNodeIds,
    );

    expect(opportunities).toEqual([]);
  });

  test("discards opportunities with no title or no rationale", () => {
    const opportunities = normalizeAutomationOpportunities(
      {
        opportunities: [
          { ...wellFormed, title: "  " },
          { ...wellFormed, rationale: "" },
        ],
      },
      knownNodeIds,
    );

    expect(opportunities).toEqual([]);
  });

  test("coerces an unknown kind rather than dropping the opportunity", () => {
    const [opportunity] = normalizeAutomationOpportunities(
      { opportunities: [{ ...wellFormed, kind: "wizardry" }] },
      knownNodeIds,
    );

    expect(opportunity.kind).toBe("other");
    expect(opportunity.title).toBe("Triage assistant");
  });

  test("treats an empty list as a valid answer", () => {
    expect(
      normalizeAutomationOpportunities({ opportunities: [] }, knownNodeIds),
    ).toEqual([]);
    expect(normalizeAutomationOpportunities({}, knownNodeIds)).toEqual([]);
  });

  test("the insights request fits its time budget", () => {
    const request = buildFlowInsightsAIRequest("enriched process");
    expect(isWithinTimeBudget(request.maxTokens, request.timeoutMs)).toBe(true);
    expect(request.tool.name).toBe("return_automation_opportunities");
  });
});

describe("response payload parsing", () => {
  test("detects provider token-limit finish reasons before parsing", () => {
    expect(isTokenLimitFinishReason("length")).toBe(true);
    expect(isTokenLimitFinishReason("max_tokens")).toBe(true);
    expect(isTokenLimitFinishReason("stop")).toBe(false);
  });

  test("parses fenced and prose-wrapped JSON content as a fallback", () => {
    const parsed = parseFlowResponsePayload(
      `Here is the flow:\n\n\`\`\`json\n${JSON.stringify(sampleGraphPayload)}\n\`\`\`\n`,
    );

    expect(parsed.nodes).toHaveLength(2);
  });

  test("parses Claude content block arrays", () => {
    const parsed = parseFlowResponsePayload([
      { type: "text", text: JSON.stringify(sampleGraphPayload) },
    ]);

    expect(parsed.edges).toHaveLength(1);
  });

  test("rejects content with no JSON object", () => {
    expect(() => parseFlowResponsePayload("No JSON here.")).toThrow();
  });
});
