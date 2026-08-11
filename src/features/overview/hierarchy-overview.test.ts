import { Children, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Id } from "../../../convex/_generated/dataModel";
import type {
  DepartmentOverviewArtifactV2,
  FunctionOverviewArtifactV2,
  SummaryOverviewResponse,
} from "../../../convex/summaryV2";
import {
  HierarchyOverviewCompactContent,
  HierarchyOverviewContent,
  type HierarchyChildSummary,
} from "./hierarchy-overview";
import { SourceChips } from "./overview-primitives";

const departmentId = "department-1" as Id<"departments">;
const functionId = "function-1" as Id<"functions">;
const processId = "process-1" as Id<"processes">;
const generatedAt = Date.UTC(2026, 7, 5, 11, 0);

const findingBase = {
  body: "The relationship is described consistently across the available child overviews.",
  evidenceLevel: "corroborated" as const,
  supportCount: 2,
};

const departmentArtifact: DepartmentOverviewArtifactV2 = {
  schemaVersion: "v2",
  sourceMode: "interview_evidence",
  headline: "Generated department headline that should not repeat the header",
  executiveBrief:
    "The department coordinates intake and fulfilment through shared verification practices.",
  crossProcessDependencies: [
    {
      ...findingBase,
      id: "dependency-1",
      title: "Fulfilment depends on verified intake",
      sources: [
        { kind: "process", processId, label: "Request intake" },
      ],
    },
  ],
  sharedPatterns: [
    {
      ...findingBase,
      id: "pattern-1",
      title: "Teams verify before progressing work",
      sources: [
        { kind: "process", processId, label: "Request intake" },
      ],
    },
  ],
  variationsAndTensions: [],
  gaps: [],
  notable: [],
  coverage: {
    includedSources: 4,
    totalEligibleSources: 6,
    uniqueContributors: 8,
    complete: false,
  },
  provenance: {
    sourceSnapshotHash: "department-snapshot",
    generatedAt,
    promptVersion: "department-overview-v1",
    provider: "test",
    model: "test",
  },
};

const functionArtifact: FunctionOverviewArtifactV2 = {
  schemaVersion: "v2",
  sourceMode: "interview_evidence",
  headline: "Generated function headline",
  executiveBrief:
    "The function relies on shared governance while departments retain local operating practices.",
  crossDepartmentDependencies: [
    {
      ...findingBase,
      id: "function-dependency-1",
      title: "Operations supplies verified demand",
      sources: [
        { kind: "department", departmentId, label: "Operations" },
      ],
    },
  ],
  strategicPatterns: [
    {
      ...findingBase,
      id: "strategy-1",
      title: "Governance is shared across departments",
      sources: [
        { kind: "department", departmentId, label: "Operations" },
      ],
    },
  ],
  variationsAndTensions: [],
  gaps: [],
  notable: [],
  coverage: {
    includedSources: 2,
    totalEligibleSources: 2,
    uniqueContributors: 8,
    complete: true,
  },
  provenance: {
    sourceSnapshotHash: "function-snapshot",
    generatedAt,
    promptVersion: "function-overview-v1",
    provider: "test",
    model: "test",
  },
};

function overview(
  entity: SummaryOverviewResponse["entity"],
  artifact: DepartmentOverviewArtifactV2 | FunctionOverviewArtifactV2,
  state: SummaryOverviewResponse["state"] = "partial",
): SummaryOverviewResponse {
  return {
    entity,
    refreshKey: `${entity.kind}-${state}`,
    state,
    content: {
      format: "v2",
      artifact,
      markdown: "# Deterministic hierarchy projection",
    },
    coverage: artifact.coverage,
    lastSuccessfulGenerationAt: generatedAt,
    progress:
      state === "refreshing"
        ? { stage: "rollup_reduce", completed: 2, total: 4 }
        : null,
    error:
      state === "failed"
        ? {
            code: "generation_failed",
            message: "The hierarchy rollup could not be completed.",
            retryable: true,
          }
        : null,
    flow: null,
    insights: null,
  };
}

const mixedProcessChildren: HierarchyChildSummary[] = [
  "current",
  "stale",
  "refreshing",
  "partial",
  "missing",
  "failed",
].map((state, index) => ({
  kind: "process" as const,
  id: `process-${index}` as Id<"processes">,
  name: `Process ${index + 1}`,
  state: state as HierarchyChildSummary["state"],
  format: state === "missing" ? ("none" as const) : ("v2" as const),
  generatedAt: state === "missing" ? null : generatedAt,
  coverage:
    state === "missing"
      ? null
      : { includedSources: 2, totalEligibleSources: 3, complete: false },
}));

function renderDepartment(
  value = overview(
    { kind: "department", departmentId },
    departmentArtifact,
  ),
  childSummaries: HierarchyChildSummary[] | undefined = mixedProcessChildren,
  canRefresh = true,
): string {
  return renderToStaticMarkup(
    createElement(HierarchyOverviewContent, {
      overview: value,
      entity: { kind: "department", departmentId },
      description: "Handles operational requests across the region.",
      childSummaries,
      canRefresh,
      refreshPending: false,
      refreshError: null,
      onRefresh: () => undefined,
      onOpenProcess: () => undefined,
    }),
  );
}

describe("HierarchyOverviewContent", () => {
  it("renders a department rollup ledger and hierarchy-specific findings", () => {
    const html = renderDepartment();

    expect(html).toContain("Overview");
    expect(html).toContain("Process Coverage");
    expect(html).toContain("4 of 6 eligible processes");
    expect(html).toContain("67% covered");
    expect(html).toContain("Cross-process dependencies");
    expect(html).toContain("Shared patterns");
    expect(html).toContain("Variations and tensions");
    expect(html).toContain("Knowledge gaps");
    expect(html).toContain("Context worth carrying forward");
    expect(html).toContain("Department description");
    expect(html).not.toContain(departmentArtifact.headline);
  });

  it("leads with the overview and keeps status detail one tap away", () => {
    const html = renderDepartment();
    const heading = html.indexOf('id="department-overview-brief"');
    const statusChip = html.indexOf("Partial coverage");
    const brief = html.indexOf(departmentArtifact.executiveBrief);
    const ledger = html.indexOf("Process Coverage");

    // Heading, then a single status line, then the overview itself — no banner,
    // chip stack, or button row in front of the content.
    expect(heading).toBeGreaterThan(-1);
    expect(heading).toBeLessThan(statusChip);
    expect(statusChip).toBeLessThan(brief);
    expect(brief).toBeLessThan(ledger);
    expect(html).toContain(
      'id="department-overview-brief-status-detail" hidden=""',
    );
    expect(html).toContain('aria-expanded="false"');
    // Icon-only controls on narrow viewports still name themselves.
    expect(html).toContain('aria-label="Copy overview"');
    expect(html).toContain('aria-label="Refresh overview"');
  });

  it("emphasizes the load-bearing facts the generator marked in the brief", () => {
    const html = renderDepartment(
      overview({ kind: "department", departmentId }, {
        ...departmentArtifact,
        executiveBrief:
          "Intake runs on **the shared queue** and fulfilment needs **two approvals**.",
      }),
    );

    expect(html).toContain(
      '<strong class="font-semibold text-foreground">the shared queue</strong>',
    );
    expect(html).toContain(
      '<strong class="font-semibold text-foreground">two approvals</strong>',
    );
    // Markers are formatting, never content.
    expect(html).not.toContain("**");
  });

  it("shows every current child state without pretending missing children were included", () => {
    const html = renderDepartment();

    for (const label of [
      "Current",
      "New evidence",
      "Refreshing",
      "Partial coverage",
      "Not documented",
      "Refresh failed",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("No structured coverage");
    expect(html).toContain('role="progressbar"');
  });

  it("renders function dependencies, strategy, and department navigation", () => {
    const child: HierarchyChildSummary = {
      kind: "department",
      id: departmentId,
      name: "Operations",
      state: "current",
      format: "v2",
      generatedAt,
      coverage: { includedSources: 4, totalEligibleSources: 4, complete: true },
    };
    const html = renderToStaticMarkup(
      createElement(HierarchyOverviewContent, {
        overview: overview(
          { kind: "function", functionId },
          functionArtifact,
          "current",
        ),
        entity: { kind: "function", functionId },
        childSummaries: [child],
        canRefresh: true,
        refreshPending: false,
        refreshError: null,
        onRefresh: () => undefined,
        onOpenDepartment: () => undefined,
      }),
    );

    expect(html).toContain("Cross-department dependencies");
    expect(html).toContain("Strategic patterns");
    expect(html).toContain('aria-label="Open department: Operations"');
    expect(html).not.toContain("Cross-process dependencies");
  });

  it("retains previous content and reports child progress during refresh", () => {
    const html = renderDepartment(
      overview(
        { kind: "department", departmentId },
        departmentArtifact,
        "refreshing",
      ),
    );

    expect(html).toContain("2 of 4 processes complete");
    expect(html).toContain("Fulfilment depends on verified intake");
    expect(html).toContain('aria-live="polite"');
  });

  it("keeps manual rebuild contributor-only", () => {
    expect(renderDepartment(undefined, mixedProcessChildren, true)).toContain(
      "Refresh overview",
    );
    expect(renderDepartment(undefined, mixedProcessChildren, false)).not.toContain(
      "Refresh overview",
    );
  });

  it("renders a legacy fallback and an honest current-child ledger", () => {
    const value: SummaryOverviewResponse = {
      ...overview(
        { kind: "department", departmentId },
        departmentArtifact,
        "current",
      ),
      content: {
        format: "legacy",
        artifact: null,
        markdown: "## Existing department narrative\n\nLegacy knowledge remains visible.",
      },
      coverage: null,
    };
    const html = renderDepartment(value, []);

    expect(html).toContain("Compatibility view");
    expect(html).toContain("Existing department narrative");
    expect(html).toContain("does not record exact child inclusion");
    expect(html).toContain("No processes are currently defined");
  });

  it("renders missing and failed states with actionable context", () => {
    const missing: SummaryOverviewResponse = {
      ...overview(
        { kind: "department", departmentId },
        departmentArtifact,
        "missing",
      ),
      content: { format: "none", artifact: null, markdown: null },
      coverage: null,
      lastSuccessfulGenerationAt: null,
    };
    const failed: SummaryOverviewResponse = {
      ...missing,
      state: "failed",
      error: {
        code: "generation_failed",
        message: "The hierarchy rollup could not be completed.",
        retryable: true,
      },
    };

    expect(renderDepartment(missing, [])).toContain("No department overview yet");
    expect(renderDepartment(failed, [])).toContain(
      "The hierarchy rollup could not be completed",
    );
  });

  it("supports large hierarchies and bounded long names", () => {
    const childSummaries: HierarchyChildSummary[] = Array.from(
      { length: 80 },
      (_, index) => ({
        kind: "process" as const,
        id: `large-process-${index}` as Id<"processes">,
        name: `Process ${index + 1} ${"with a long operating name ".repeat(5)}`,
        state: "current" as const,
        format: "v2" as const,
        generatedAt,
        coverage: {
          includedSources: 5,
          totalEligibleSources: 5,
          complete: true,
        },
      }),
    );
    const html = renderDepartment(undefined, childSummaries);

    expect(html).toContain("Process 80");
    expect(html).toContain("with a long operating name");
  });

  it("renders a compact mobile preview with state, brief, coverage, and time", () => {
    const html = renderToStaticMarkup(
      createElement(HierarchyOverviewCompactContent, {
        overview: overview(
          { kind: "function", functionId },
          functionArtifact,
          "current",
        ),
        entityKind: "function",
      }),
    );

    expect(html).toContain("Current");
    expect(html).toContain("2 of 2 departments");
    expect(html).toContain(functionArtifact.executiveBrief);
    expect(html).toContain("2026");
    expect(html).not.toContain(functionArtifact.headline);
  });

  it("routes process and department source buttons to their owners", () => {
    let openedProcess: Id<"processes"> | null = null;
    let openedDepartment: Id<"departments"> | null = null;
    const chips = SourceChips({
      sources: [
        { kind: "process", processId, label: "Request intake" },
        { kind: "department", departmentId, label: "Operations" },
      ],
      onOpenProcess: (id) => {
        openedProcess = id;
      },
      onOpenDepartment: (id) => {
        openedDepartment = id;
      },
    }) as ReactElement<{
      children: ReactElement<{ onClick: () => void }>[];
    }>;
    const buttons = Children.toArray(chips.props.children) as ReactElement<{
      onClick: () => void;
    }>[];

    buttons[0].props.onClick();
    buttons[1].props.onClick();
    expect(openedProcess).toBe(processId);
    expect(openedDepartment).toBe(departmentId);
  });
});
