import { Children, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Id } from "../../../convex/_generated/dataModel";
import type {
  ProcessOverviewArtifactV2,
  SummaryOverviewResponse,
} from "../../../convex/summaryV2";
import { SourceChips } from "./overview-primitives";
import { ProcessOverviewContent } from "./process-overview";

const processId = "process-1" as Id<"processes">;
const conversationId = "conversation-1" as Id<"conversations">;
const generatedAt = Date.UTC(2026, 7, 5, 9, 30);

const artifact: ProcessOverviewArtifactV2 = {
  schemaVersion: "v2",
  sourceMode: "interview_evidence",
  headline: "Customer requests move from intake to verified resolution",
  executiveBrief:
    "Teams describe a shared intake and verification sequence, with one reported variation in escalation handling.",
  coverage: {
    includedSources: 3,
    totalEligibleSources: 4,
    uniqueContributors: 3,
    complete: false,
  },
  provenance: {
    sourceSnapshotHash: "snapshot-1",
    generatedAt,
    promptVersion: "process-overview-v1",
    provider: "test",
    model: "test",
  },
  scope: [
    {
      id: "scope-trigger",
      title: "What starts the process",
      body: "A customer request arriving in the service inbox starts the work.",
      evidenceLevel: "corroborated",
      supportCount: 3,
      sources: [
        {
          kind: "conversation",
          conversationId,
          label: "Operations interview",
        },
      ],
    },
    {
      id: "scope-systems",
      title: "Systems the work runs on",
      body: "Cases are tracked in the service desk tool; approvals live in a shared sheet.",
      evidenceLevel: "single_source",
      supportCount: 1,
      sources: [
        {
          kind: "conversation",
          conversationId,
          label: "Operations interview",
        },
      ],
    },
  ],
  consensus: [
    {
      id: "consensus-verify",
      title: "Verification happens before closure",
      body: "Contributors agree that the request is checked before the case is closed.",
      evidenceLevel: "corroborated",
      supportCount: 2,
      sources: [
        {
          kind: "conversation",
          conversationId,
          label: "Operations interview",
        },
      ],
    },
  ],
  variations: [
    {
      id: "variation-escalation",
      title: "Escalation ownership varies",
      body: "One contributor assigns escalation to the service lead; another described regional ownership.",
      evidenceLevel: "corroborated",
      supportCount: 2,
      sources: [
        {
          kind: "conversation",
          conversationId,
          label: "Operations interview",
        },
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

function overview(
  state: SummaryOverviewResponse["state"] = "partial",
): SummaryOverviewResponse {
  return {
    entity: { kind: "process", processId },
    refreshKey: `refresh-${state}`,
    state,
    content: {
      format: "v2",
      artifact,
      markdown: "# Customer request resolution\n\nDeterministic projection.",
    },
    coverage: artifact.coverage,
    lastSuccessfulGenerationAt: generatedAt,
    progress:
      state === "refreshing"
        ? { stage: "final_reduce", completed: 3, total: 4 }
        : null,
    error:
      state === "failed"
        ? {
            code: "generation_failed",
            message: "The generation provider was unavailable.",
            retryable: true,
          }
        : null,
    flow: { available: true, stale: false, generationStatus: "ready" },
    insights: { available: true, stale: true, generationStatus: "ready" },
  };
}

function renderOverview(
  value: SummaryOverviewResponse,
  canRefresh = true,
): string {
  return renderToStaticMarkup(
    createElement(ProcessOverviewContent, {
      overview: value,
      canRefresh,
      refreshPending: false,
      refreshError: null,
      onRefresh: () => undefined,
      onOpenConversation: () => undefined,
      onOpenFlow: () => undefined,
      onOpenInsights: () => undefined,
    }),
  );
}

describe("ProcessOverviewContent", () => {
  it.each([
    ["current", "Current"],
    ["stale", "New evidence"],
    ["refreshing", "Refreshing"],
    ["partial", "Partial coverage"],
    ["failed", "Refresh failed"],
  ] as const)("renders the %s lifecycle without hiding prior content", (state, label) => {
    const html = renderOverview(overview(state));

    expect(html).toContain(label);
    expect(html).toContain("What starts the process");
    if (state === "refreshing") expect(html).toContain("3 of 4 complete");
    if (state === "failed") expect(html).toContain("provider was unavailable");
  });

  it("presents evidence coverage, scope, variations, agreement, and gaps", () => {
    const html = renderOverview(overview());

    expect(html).toContain("Conversations included");
    expect(html).toContain("Unique contributors");
    expect(html).toContain("who runs it, and what it depends on");
    expect(html).toContain("Different ways the work is described");
    expect(html).toContain("Agreements and open questions");
    expect(html).toContain("Notable context");
    expect(html).toContain("Corroborated · 3 sources");
    expect(html).toContain("Evidence gap");
    expect(html).toContain(
      '<h2 id="process-scope" class="text-xl font-semibold tracking-tight sm:text-2xl">Scope and participants</h2>',
    );
    expect(html).toContain(
      '<h2 id="process-variations" class="text-xl font-semibold tracking-tight sm:text-2xl">Reported practice</h2>',
    );
    expect(html).not.toContain("PROCESS OVERVIEW");
  });

  it("states no sequence of its own and routes to the Flow for step order", () => {
    const html = renderOverview(overview());

    expect(html).toContain("open the Process Flow");
    expect(html).toContain("The Process Flow owns the order");
    // No numbered timeline: an ordered list here would compete with the graph.
    expect(html).not.toContain("<ol");
    expect(html).not.toContain("Ordered process stages");
    expect(html).not.toContain("The operating sequence");
  });

  it("omits the Flow pointer until a flow exists to open", () => {
    const withoutFlow: SummaryOverviewResponse = {
      ...overview(),
      flow: { available: false, stale: false, generationStatus: "generating" },
    };

    expect(renderOverview(withoutFlow)).not.toContain("open the Process Flow");
  });

  it("renders conversation sources as keyboard-native buttons", () => {
    const html = renderOverview(overview());

    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-label="Open conversation: Operations interview"');
    expect(html).not.toContain('tabindex="-1"');
  });

  it("routes an activated source chip to its owning conversation", () => {
    let openedConversationId: Id<"conversations"> | null = null;
    const chips = SourceChips({
      sources: [
        {
          kind: "conversation",
          conversationId,
          label: "Operations interview",
        },
      ],
      onOpenConversation: (id) => {
        openedConversationId = id;
      },
    }) as ReactElement<{ children: ReactElement<{ onClick: () => void }>[] }>;
    const [button] = Children.toArray(chips.props.children) as ReactElement<{
      onClick: () => void;
    }>[];

    button.props.onClick();
    expect(openedConversationId).toBe(conversationId);
  });

  it("shows rebuild only to roles allowed to refresh", () => {
    expect(renderOverview(overview("current"), true)).toContain(
      "Rebuild overview",
    );
    expect(renderOverview(overview("current"), false)).not.toContain(
      "Rebuild overview",
    );
  });

  it("shows one compact refresh indicator without repeating the action or notice", () => {
    const html = renderOverview(overview("refreshing"));

    expect(html.match(/animate-spin/g)).toHaveLength(1);
    expect(html).toContain("3 of 4 complete");
    expect(html).not.toContain("New evidence is being synthesized");
    expect(html).not.toContain(">Refreshing</button>");
  });

  it("keeps Flow and Insights complementary and navigation-only", () => {
    const html = renderOverview(overview());

    expect(html).toContain("Open the map and step detail");
    expect(html).toContain("Open diagnosis and improvement analysis");
    expect(html).not.toContain("Bottleneck score");
    expect(html).not.toContain("Automation recommendation");
    expect(html).not.toContain("Node detail");
  });

  it("keeps a readable legacy compatibility view", () => {
    const value: SummaryOverviewResponse = {
      ...overview("current"),
      content: {
        format: "legacy",
        artifact: null,
        markdown: "## Existing narrative\n\nThe original summary remains available.",
      },
      coverage: null,
    };
    const html = renderOverview(value);

    expect(html).toContain("Compatibility view");
    expect(html).toContain("Existing narrative");
    expect(html).toContain("predates structured evidence links");
    expect(html).not.toContain("Existing process narrative");
  });

  it("explains the missing state and exposes a build action to contributors", () => {
    const value: SummaryOverviewResponse = {
      ...overview("missing"),
      content: { format: "none", artifact: null, markdown: null },
      coverage: null,
      lastSuccessfulGenerationAt: null,
    };
    const html = renderOverview(value);

    expect(html).toContain("No overview yet");
    expect(html).toContain("Build overview");
    expect(html).not.toContain("Not generated yet");
  });

  it("does not repeat legacy provenance already explained by Compatibility view", () => {
    const value: SummaryOverviewResponse = {
      ...overview("current"),
      content: {
        format: "legacy",
        artifact: null,
        markdown: "## Existing narrative\n\nThe original summary remains available.",
      },
      coverage: null,
      lastSuccessfulGenerationAt: null,
    };
    const html = renderOverview(value);

    expect(html).toContain("Compatibility view");
    expect(html).not.toContain("Legacy summary");
    expect(html).not.toContain("Not generated yet");
  });

  it("renders the maximum finding count and long bounded content without truncating meaning", () => {
    const longBody = "Operational detail ".repeat(60).trim();
    const stressedArtifact: ProcessOverviewArtifactV2 = {
      ...artifact,
      headline: "H".repeat(120),
      executiveBrief: "Executive context ".repeat(80).trim(),
      scope: Array.from({ length: 8 }, (_, index) => ({
        ...artifact.scope[0],
        id: `scope-${index}`,
        title: `Scope claim ${index + 1} ${"with context ".repeat(6)}`,
        body: longBody,
      })),
    };
    const html = renderOverview({
      ...overview(),
      content: {
        format: "v2",
        artifact: stressedArtifact,
        markdown: "stress projection",
      },
      coverage: stressedArtifact.coverage,
    });

    expect(html).toContain("Scope claim 8");
    expect(html).toContain("Executive context");
    expect(html).not.toContain("H".repeat(120));
    expect(html).toContain("Operational detail");
  });

  it("includes dark-theme and organization-accent styling hooks", () => {
    const html = renderOverview(overview());

    expect(html).toContain("dark:");
    expect(html).toContain("org-accent");
    expect(html).toContain('aria-live="polite"');
  });
});
