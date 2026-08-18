import { describe, expect, test } from "vitest";
import {
  type AutomationOpportunity,
  type BriefInput,
  composeOpportunityBrief,
  findInterstitialNodeIds,
} from "./opportunity-brief";
import type {
  FlowEdge,
  FlowNode,
} from "@/features/insights/insights-derivations";

/**
 * Fixtures mirror the shape of the real `Product Building` flow read out of the
 * dev deployment while designing this: a linear stretch with a conditional
 * branch in the middle, details living behind `detailStatus`, and pain points
 * empty while risk indicators are populated.
 */
function node(overrides: Partial<FlowNode> & { id: string }): FlowNode {
  return {
    label: overrides.id,
    category: "action",
    description: "",
    actors: [],
    tools: [],
    painPoints: [],
    // The placeholders a node carries before its enrichment batch runs.
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

function edge(
  source: string,
  target: string,
  overrides: Partial<FlowEdge> = {},
): FlowEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: "sequential",
    isHappyPath: true,
    ...overrides,
  } as FlowEdge;
}

const NODES: FlowNode[] = [
  node({ id: "start", label: "Start App Build", category: "start" }),
  node({
    id: "configure-database",
    label: "Configure Database Provider",
    description:
      "The development team configures a database provider to store the application data",
    actors: ["Development team"],
    tools: ["Convex", "Supabase"],
    riskIndicators: ["Schema incompatibilities with chosen provider"],
    confidence: "high",
  }),
  node({
    id: "configure-hosting",
    label: "Configure Hosting",
    description: "The development team configures hosting infrastructure using Vercel",
    actors: ["Development team"],
    tools: ["Vercel"],
    riskIndicators: ["Misconfiguration of hosting environment"],
  }),
  node({
    id: "use-ai-model",
    label: "Use AI Model?",
    category: "decision",
    description: "The team decides whether to integrate an AI model",
    actors: ["Development team"],
  }),
  node({
    id: "integrate-ai-model",
    label: "Integrate AI Model",
    description: "The development team integrates an AI model into the application",
    actors: ["Development team"],
    tools: ["Microsoft Foundry", "OpenRouter"],
    riskIndicators: ["API integration failures"],
  }),
  node({
    id: "purchase-domain",
    label: "Purchase Domain",
    description: "The development team purchases a domain name",
    actors: ["Development team"],
    riskIndicators: ["DNS configuration errors"],
  }),
  node({ id: "deploy-testing", label: "Deploy For Testing", description: "Deployed to testing" }),
];

const EDGES: FlowEdge[] = [
  edge("start", "configure-database"),
  edge("configure-database", "configure-hosting"),
  edge("configure-hosting", "use-ai-model"),
  edge("use-ai-model", "integrate-ai-model", { type: "conditional", label: "Yes" }),
  edge("use-ai-model", "purchase-domain", {
    type: "conditional",
    label: "No",
    isHappyPath: false,
  }),
  edge("integrate-ai-model", "purchase-domain"),
  edge("purchase-domain", "deploy-testing"),
];

const CRITICAL_PATH = [
  "start",
  "configure-database",
  "configure-hosting",
  "use-ai-model",
  "integrate-ai-model",
  "purchase-domain",
  "deploy-testing",
];

function opportunity(
  overrides: Partial<AutomationOpportunity> = {},
): AutomationOpportunity {
  return {
    title: "Automated Infrastructure Configuration Pipeline",
    kind: "workflow",
    nodeIds: ["configure-database", "configure-hosting", "purchase-domain"],
    rationale: "The team manually configures three separate infrastructure components",
    expectedBenefit: "Reduced configuration time and human error",
    prerequisites: ["Vercel API access"],
    confidence: "high",
    ...overrides,
  } as AutomationOpportunity;
}

function input(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    opportunity: opportunity(),
    nodes: NODES,
    edges: EDGES,
    criticalPath: CRITICAL_PATH,
    processName: "Product Building",
    departmentName: "AI Transformation",
    overview: {
      executiveBrief: "Product Building creates a new application.",
      gaps: [],
    },
    coverage: {
      includedSources: 1,
      totalEligibleSources: 1,
      uniqueContributors: 1,
      complete: true,
    },
    ...overrides,
  };
}

describe("findInterstitialNodeIds", () => {
  test("finds steps sitting inside the span that the automation does not cover", () => {
    const interstitial = findInterstitialNodeIds(
      ["configure-database", "configure-hosting", "purchase-domain"],
      EDGES,
    );
    expect(interstitial.sort()).toEqual(["integrate-ai-model", "use-ai-model"]);
  });

  test("a contiguous span has no holes", () => {
    expect(
      findInterstitialNodeIds(["configure-database", "configure-hosting"], EDGES),
    ).toEqual([]);
  });

  test("a single covered step has no holes", () => {
    expect(findInterstitialNodeIds(["deploy-testing"], EDGES)).toEqual([]);
  });

  test("terminates on a cycle", () => {
    const cyclic = [edge("a", "b"), edge("b", "c"), edge("c", "b")];
    expect(findInterstitialNodeIds(["a", "c"], cyclic)).toEqual(["b"]);
  });
});

describe("composeOpportunityBrief", () => {
  test("leads with what to build, the process, and evidence confidence", () => {
    const { title, body } = composeOpportunityBrief(input());
    expect(title).toBe("Automated Infrastructure Configuration Pipeline");
    expect(body).toContain("# Automated Infrastructure Configuration Pipeline");
    expect(body).toContain(
      "Build an automated workflow that supports the **Product Building** process (AI Transformation department).",
    );
    expect(body).toContain("1 recorded conversation with 1 contributor");
    expect(body).toContain("Evidence confidence for this opportunity: **high**");
  });

  test("orders covered steps by the critical path, not by nodeIds order", () => {
    const { body } = composeOpportunityBrief(
      input({
        opportunity: opportunity({
          nodeIds: ["purchase-domain", "configure-database", "configure-hosting"],
        }),
      }),
    );
    const order = ["Configure Database Provider", "Configure Hosting", "Purchase Domain"].map(
      (label) => body.indexOf(`**${label}**`),
    );
    expect(order.every((index) => index > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("reports a non-contiguous span instead of misreporting its boundary", () => {
    const { body } = composeOpportunityBrief(input());
    expect(body).toContain("**Not one continuous stretch.**");
    expect(body).toContain("Integrate AI Model, Use AI Model?");
    // The steps inside the hole must not be reported as the span's boundary.
    expect(body).toContain("**Runs after:** Start App Build.");
    expect(body).toContain("**Hands off to:** Deploy For Testing.");
    expect(body).not.toContain("**Runs after:** Integrate AI Model");
  });

  test("a contiguous span says nothing about holes", () => {
    const { body } = composeOpportunityBrief(
      input({
        opportunity: opportunity({
          nodeIds: ["configure-database", "configure-hosting"],
        }),
      }),
    );
    expect(body).not.toContain("Not one continuous stretch");
    expect(body).toContain("**Hands off to:** Use AI Model?.");
  });

  test("spells out conditional branches with their labels", () => {
    const { body } = composeOpportunityBrief(
      input({
        opportunity: opportunity({
          kind: "agent",
          nodeIds: ["use-ai-model", "integrate-ai-model"],
        }),
      }),
    );
    expect(body).toContain('At "Use AI Model?": if **Yes**, go to "Integrate AI Model".');
    expect(body).toContain('At "Use AI Model?": if **No**, go to "Purchase Domain".');
  });

  test("never reads detail from a step that has not been described", () => {
    const nodes = NODES.map((flowNode) =>
      flowNode.id === "configure-hosting"
        ? node({
            id: "configure-hosting",
            label: "Configure Hosting",
            // Placeholder values a pending node carries — must not surface.
            description: "",
            tools: ["Placeholder System"],
            detailStatus: "pending",
          })
        : flowNode,
    );
    const { body } = composeOpportunityBrief(input({ nodes }));
    expect(body).not.toContain("Placeholder System");
    expect(body).toContain("1 covered step not yet described by the analysis: Configure Hosting.");
  });

  test("omits sections with no data rather than printing an empty heading", () => {
    const { body } = composeOpportunityBrief(input());
    // Pain points are empty throughout the real sample.
    expect(body).not.toContain("## Friction reported today");
    expect(body).toContain("## Risks it has to handle");
  });

  test("states absence of owners and systems instead of dropping it", () => {
    const bare = node({ id: "solo", label: "Solo Step", description: "A step." });
    const { body } = composeOpportunityBrief(
      input({
        nodes: [bare],
        edges: [],
        criticalPath: ["solo"],
        opportunity: opportunity({ nodeIds: ["solo"] }),
      }),
    );
    expect(body).toContain("**People:** not named in the evidence");
    expect(body).toContain("**Systems named by contributors:** none named");
    expect(body).toContain("No owner is named for these steps.");
    expect(body).toContain("No systems are named for these steps.");
  });

  test("never claims a named system is available in the tenant", () => {
    const { body } = composeOpportunityBrief(input());
    expect(body).toContain(
      "Fabric records what people said they use, not what is connected or licensed in your tenant.",
    );
  });

  test("surfaces partial coverage, overview gaps, and low confidence", () => {
    const { body } = composeOpportunityBrief(
      input({
        opportunity: opportunity({ confidence: "low" }),
        overview: {
          executiveBrief: "Brief.",
          gaps: [{ title: "Handoff owner", body: "Nobody named who approves" }],
        },
        coverage: {
          includedSources: 2,
          totalEligibleSources: 5,
          uniqueContributors: 2,
          complete: false,
        },
      }),
    );
    expect(body).toContain("Handoff owner: Nobody named who approves.");
    expect(body).toContain("Evidence is partial — 2 of 5 eligible conversations are included.");
    expect(body).toContain("identified with low confidence");
  });

  test("ignores nodeIds that are not in the flow", () => {
    const { body } = composeOpportunityBrief(
      input({
        opportunity: opportunity({ nodeIds: ["configure-hosting", "ghost-step"] }),
      }),
    );
    expect(body).toContain("**Configure Hosting**");
    expect(body).not.toContain("ghost-step");
  });

  test("works without an overview or coverage", () => {
    const { body } = composeOpportunityBrief(
      input({ overview: null, coverage: null }),
    );
    expect(body).toContain("## What to build");
    expect(body).not.toContain("recorded conversation");
  });

  test("puts who-does-this and the unknowns above the process context", () => {
    const { body } = composeOpportunityBrief(
      input({
        coverage: {
          includedSources: 2,
          totalEligibleSources: 5,
          uniqueContributors: 2,
          complete: false,
        },
      }),
    );
    const order = [
      "## What to build",
      "**Expected benefit.**",
      "## Who does this today, and with what",
      "## What the evidence does not tell us",
      "## Where this sits in the process",
      "## Risks it has to handle",
      "## Prerequisites before building",
    ].map((heading) => body.indexOf(heading));
    expect(order.every((index) => index > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("carries no Fabric source line", () => {
    const { body } = composeOpportunityBrief(input());
    expect(body).not.toContain("Source: Fabric");
    expect(body).not.toContain("flow generation");
  });
});
