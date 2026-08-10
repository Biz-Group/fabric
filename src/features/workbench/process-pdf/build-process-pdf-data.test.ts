import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { ProcessOverviewArtifactV2 } from "../../../../convex/summaryV2";
import type { ProcessFlow } from "@/features/insights/insights-derivations";
import {
  buildProcessPdfData,
  type ProcessOverviewInput,
  type ProcessPdfInput,
} from "./build-process-pdf-data";
import { ProcessPdfDocument } from "./process-pdf-document";

const conversationId = "conversation-1" as Id<"conversations">;
const generatedAt = Date.UTC(2026, 7, 5, 9, 30);

// react-pdf primitives are uppercase strings ("PAGE", "VIEW"), so react-dom
// renders the document tree as markup and warns about the casing. The tree is
// exactly what the PDF renderer consumes, which makes it the honest thing to
// assert on; the warnings are noise.
let consoleError: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => {
  consoleError.mockRestore();
});

const STEP_DESCRIPTION =
  "The service desk records the request and confirms the minimum details are present.";
const SCOPE_BODY =
  "Contributors describe one intake queue that every request arrives through.";

const artifact: ProcessOverviewArtifactV2 = {
  schemaVersion: "v2",
  sourceMode: "interview_evidence",
  headline: "Requests move from intake to verified resolution",
  executiveBrief:
    "Two contributors describe a shared intake and verification sequence, with one reported variation in escalation ownership.",
  coverage: {
    includedSources: 3,
    totalEligibleSources: 4,
    uniqueContributors: 2,
    complete: false,
  },
  provenance: {
    sourceSnapshotHash: "snapshot-1",
    generatedAt,
    promptVersion: "summary-v2-process-overview-v2",
    provider: "fabric-foundry",
    model: "test-model",
  },
  scope: [
    {
      id: "scope-trigger",
      title: "What starts the process",
      body: SCOPE_BODY,
      evidenceLevel: "corroborated",
      supportCount: 3,
      sources: [
        { kind: "conversation", conversationId, label: "Operations interview" },
      ],
    },
    {
      id: "scope-systems",
      title: "Systems the work runs on",
      body: "Cases are tracked in the service desk tool and approvals in a shared sheet.",
      evidenceLevel: "single_source",
      supportCount: 1,
      sources: [
        { kind: "conversation", conversationId, label: "Service lead interview" },
      ],
    },
  ],
  consensus: [
    {
      id: "consensus-verify",
      title: "Verification precedes closure",
      body: "Both contributors place verification before closure.",
      evidenceLevel: "corroborated",
      supportCount: 2,
      sources: [
        { kind: "conversation", conversationId, label: "Operations interview" },
      ],
    },
  ],
  variations: [
    {
      id: "variation-escalation",
      title: "Escalation ownership varies",
      body: "One contributor assigns escalation to the service lead; another described regional ownership.",
      evidenceLevel: "single_source",
      supportCount: 1,
      sources: [
        { kind: "conversation", conversationId, label: "Service lead interview" },
      ],
    },
  ],
  gaps: [
    {
      id: "gap-threshold",
      title: "Escalation threshold is unconfirmed",
      body: "The available evidence does not establish a shared escalation threshold.",
      evidenceLevel: "inferred_gap",
      supportCount: 0,
      sources: [],
    },
  ],
  notable: [],
};

function overviewInput(
  overrides: Partial<ProcessOverviewInput> = {},
): ProcessOverviewInput {
  return {
    state: "partial",
    content: {
      format: "v2",
      artifact,
      markdown: "# Requests move from intake to verified resolution",
    },
    lastSuccessfulGenerationAt: generatedAt,
    flow: { available: true, stale: false, generationStatus: "ready" },
    insights: { available: true, stale: false, generationStatus: "ready" },
    ...overrides,
  };
}

function flowFixture(overrides: Partial<ProcessFlow> = {}): ProcessFlow {
  return {
    _id: "flow-1",
    _creationTime: generatedAt,
    processId: "process-1",
    clerkOrgId: "org_test",
    status: "ready",
    detailsStatus: "ready",
    stale: false,
    generatedAt,
    conversationCount: 3,
    nodes: [
      {
        id: "node-intake",
        label: "Record the request",
        category: "action",
        description: STEP_DESCRIPTION,
        actors: ["Service desk"],
        tools: ["Ticketing system"],
        painPoints: ["Duplicate tickets are created by phone requests"],
        riskIndicators: ["One person knows the exception path"],
        automationPotential: "high",
        confidence: "high",
        isBottleneck: true,
        isTribalKnowledge: true,
        estimatedDuration: "10 minutes",
        sources: ["Operations interview"],
        detailStatus: "ready",
      },
      {
        id: "node-close",
        label: "Close the case",
        category: "end",
        description: "The case is closed once verification passes.",
        actors: ["Service lead"],
        tools: [],
        painPoints: [],
        riskIndicators: [],
        automationPotential: "none",
        confidence: "medium",
        isBottleneck: false,
        isTribalKnowledge: false,
        sources: ["Service lead interview"],
        detailStatus: "ready",
      },
    ],
    edges: [
      {
        id: "edge-1",
        source: "node-intake",
        target: "node-close",
        type: "sequence",
        label: "Verified",
        isHappyPath: true,
      },
    ],
    insights: {
      criticalPath: ["node-intake", "node-close"],
      handoffCount: 1,
      toolCount: 1,
      automationOpportunities: ["Auto-create tickets from inbound email"],
      topBottlenecks: ["node-intake"],
      totalEstimatedDuration: "2 days",
    },
    ...overrides,
  } as unknown as ProcessFlow;
}

function input(overrides: Partial<ProcessPdfInput> = {}): ProcessPdfInput {
  return {
    processName: "Customer request resolution",
    functionName: "Operations",
    departmentName: "Service",
    overview: overviewInput(),
    contributorName: "Contributor A",
    submittedByName: null,
    lastUpdatedAt: generatedAt,
    completedConversationCount: 4,
    flow: flowFixture(),
    generatedAt: generatedAt + 60_000,
    ...overrides,
  };
}

function render(overrides: Partial<ProcessPdfInput> = {}): string {
  const data = buildProcessPdfData(input(overrides));
  return renderToStaticMarkup(createElement(ProcessPdfDocument, { data }));
}

describe("process report data", () => {
  it("prefers the structured artifact and drops the Markdown fallback", () => {
    const data = buildProcessPdfData(input());

    expect(data.overview.structured).not.toBeNull();
    expect(data.overview.legacyMarkdown).toBeNull();
    expect(data.overview.sourceMode).toBe("Interview evidence");
    expect(data.overview.stateLabel).toBe("Partial coverage");
    expect(data.overview.generatedAt).toBe(generatedAt);
    expect(data.overview.structured?.coverage).toEqual({
      includedSources: 3,
      totalEligibleSources: 4,
      uniqueContributors: 2,
      complete: false,
    });
    expect(data.overview.structured?.sections.map((s) => s.key)).toEqual([
      "scope",
      "variations",
      "consensus",
      "gaps",
      "notable",
    ]);
  });

  it("labels evidence strength exactly as the app does and resolves sources", () => {
    const scope = buildProcessPdfData(input()).overview.structured?.sections[0];

    expect(scope?.title).toBe("Scope and participants");
    expect(scope?.findings[0].evidenceLabel).toBe("Corroborated · 3 sources");
    expect(scope?.findings[0].sources).toEqual(["Operations interview"]);
    expect(scope?.findings[1].evidenceLabel).toBe("Single source");

    const gaps = buildProcessPdfData(input()).overview.structured?.sections[3];
    expect(gaps?.findings[0].evidenceLabel).toBe("Evidence gap");
    expect(gaps?.findings[0].sources).toEqual([]);
  });

  it("keeps the Markdown projection for a V1-only row", () => {
    const data = buildProcessPdfData(
      input({
        overview: overviewInput({
          state: "current",
          content: {
            format: "legacy",
            artifact: null,
            markdown: "## Existing narrative\n\nThe original summary remains.",
          },
        }),
      }),
    );

    expect(data.overview.structured).toBeNull();
    expect(data.overview.legacyMarkdown).toContain("Existing narrative");
    expect(data.overview.sourceMode).toBe("Legacy summary");
  });

  it("reports an ungenerated overview without inventing content", () => {
    const data = buildProcessPdfData(
      input({
        overview: overviewInput({
          state: "missing",
          content: { format: "none", artifact: null, markdown: null },
          lastSuccessfulGenerationAt: null,
        }),
      }),
    );

    expect(data.overview.structured).toBeNull();
    expect(data.overview.legacyMarkdown).toBeNull();
    expect(data.overview.sourceMode).toBe("Awaiting evidence");
    expect(data.overview.generatedAt).toBeNull();
  });

  it("carries Flow and Insights readiness as navigation labels only", () => {
    const stale = buildProcessPdfData(
      input({
        overview: overviewInput({
          flow: { available: true, stale: true, generationStatus: "ready" },
          insights: { available: false, stale: false, generationStatus: "generating" },
        }),
      }),
    );

    expect(stale.overview.flowReadiness).toBe("New evidence available");
    expect(stale.overview.insightsReadiness).toBe("Generating");
    expect(buildProcessPdfData(input({ flow: null })).overview.flowReadiness).toBe(
      "Ready",
    );
  });
});

describe("process report rendering", () => {
  it("renders the structured overview with evidence labels and sources", () => {
    const html = render();

    expect(html).toContain("Requests move from intake to verified resolution");
    expect(html).toContain("shared intake and verification sequence");
    expect(html).toContain("Scope and participants");
    expect(html).toContain("Reported ways of working");
    expect(html).toContain("Agreements");
    expect(html).toContain("Knowledge gaps and tensions");
    expect(html).toContain("Corroborated · 3 sources");
    expect(html).toContain("Single source");
    expect(html).toContain("Evidence gap");
    expect(html).toContain("Operations interview");
    expect(html).toContain("No direct source — identified as an evidence gap");
    // Coverage is reported as evidence, never as measured execution.
    expect(html).toContain("of 4 eligible conversations included");
    expect(html).toContain("Partial coverage");
    expect(html).not.toContain("Process Summary");
  });

  it("states no sequence of its own and says where the order lives", () => {
    const html = render();

    expect(html).toContain("The order these activities happen in");
    expect(html).toContain("Scope and participants");
    // The overview page carries no numbered timeline; step numbers belong to
    // Process Steps and the cross-references into Flow Insights.
    const overviewPage = html.slice(0, html.indexOf("Mapped Steps"));
    expect(overviewPage).not.toContain("How the process works");
    expect(overviewPage).not.toContain("#1");
  });

  it("tells a flowless report that it has no sequence at all", () => {
    const html = render({
      flow: null,
      overview: overviewInput({
        flow: { available: false, stale: false, generationStatus: "idle" },
        insights: { available: false, stale: false, generationStatus: "idle" },
      }),
    });

    expect(html).toContain("not the order the work happens in");
    expect(html).toContain("Scope and participants");
  });

  it("orders sections overview, flow, steps, then insights", () => {
    const html = render();
    // Anchored on content unique to each page: the cover's navigation block
    // names all three destinations up front.
    const order = [
      "Reported process knowledge",
      "Mapped Steps",
      "Step numbers are used as cross-references",
      "Confidence distribution",
    ].map((label) => html.indexOf(label));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("keeps every detailed fact in one owning section", () => {
    const html = render();
    const occurrences = (needle: string) => html.split(needle).length - 1;

    // Step detail is owned by Process Steps; the overview narrative and the
    // insight cards cross-reference steps by number instead of repeating them.
    expect(occurrences(STEP_DESCRIPTION)).toBe(1);
    expect(occurrences("The case is closed once verification passes.")).toBe(1);
    expect(occurrences(SCOPE_BODY)).toBe(1);
    expect(html).toContain("Assessed on step #1");
    expect(html).toContain("Step numbers are used as cross-references");
    // Flow analysis stays out of the overview page.
    const overviewPage = html.slice(0, html.indexOf("Process Flow"));
    expect(overviewPage).not.toContain("Bottleneck");
    expect(overviewPage).not.toContain("Mapped Steps");
    expect(overviewPage).not.toContain("Automation");
  });

  it("renders the legacy Markdown export for a V1-only row", () => {
    const html = render({
      overview: overviewInput({
        state: "current",
        content: {
          format: "legacy",
          artifact: null,
          markdown:
            "## Existing narrative\n\nThe original summary remains readable.\n\n- One recorded detail",
        },
      }),
    });

    expect(html).toContain("Existing narrative");
    expect(html).toContain("The original summary remains readable.");
    expect(html).toContain("One recorded detail");
    expect(html).toContain("Legacy summary");
    // No structured scaffolding is implied for content that has no artifact.
    expect(html).not.toContain("Corroborated");
    expect(html).not.toContain("eligible conversations included");
  });

  it("renders an overview-only report when no flow exists", () => {
    const html = render({
      flow: null,
      overview: overviewInput({
        flow: { available: false, stale: false, generationStatus: "idle" },
        insights: { available: false, stale: false, generationStatus: "idle" },
      }),
    });

    expect(html).toContain("Reported process knowledge");
    expect(html).toContain("No flow generated yet");
    expect(html).toContain("Not included in this report");
    // The flow and insight sections are absent; only the cover's navigation
    // block names them.
    expect(html).not.toContain("Step numbers are used as cross-references");
    expect(html).not.toContain("Confidence distribution");
    expect(html).not.toContain("Mapped Steps");
  });

  it("still renders step and insight detail for a stale flow", () => {
    const html = render({
      flow: flowFixture({ stale: true }),
      overview: overviewInput({
        flow: { available: true, stale: true, generationStatus: "ready" },
        insights: { available: true, stale: true, generationStatus: "ready" },
      }),
    });

    expect(html).toContain("New evidence available");
    expect(html).toContain("Step numbers are used as cross-references");
    expect(html).toContain(STEP_DESCRIPTION);
    expect(html).toContain("Confidence distribution");
  });

  it("omits step and insight sections while the flow is still being described", () => {
    const html = render({
      flow: flowFixture({
        detailsStatus: "generating",
        generationVersion: "v3",
        generationId: "generation-1",
      }),
    });

    expect(html).toContain("step details are still being written");
    expect(html).toContain("Not included in this report");
    expect(html).not.toContain("Step numbers are used as cross-references");
    expect(html).not.toContain(STEP_DESCRIPTION);
  });

  it("reports a failed refresh without hiding the retained overview", () => {
    const html = render({
      overview: overviewInput({ state: "failed" }),
    });

    expect(html).toContain("Refresh failed");
    expect(html).toContain("What starts the process");
    expect(html).toContain(SCOPE_BODY);
  });
});
