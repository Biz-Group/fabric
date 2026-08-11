import { describe, expect, test } from "vitest";
import { Id } from "./_generated/dataModel";
import {
  conversationEvidenceMaxOutputTokens,
  CONVERSATION_EVIDENCE_CAP_BUDGET_RATIO,
  getSummaryListMetadata,
  hierarchyOverviewMaxOutputTokens,
  HIERARCHY_OVERVIEW_CAP_BUDGET_RATIO,
  normalizeDepartmentOverviewArtifactV2,
  normalizeFunctionOverviewArtifactV2,
  normalizeProcessOverviewArtifactV2,
  readCompatibleSummary,
  renderSummaryV2AsLegacyMarkdown,
  SUMMARY_V2_AI_BUDGETS,
  SUMMARY_V2_CAPS,
  SUMMARY_V2_PROMPT_VERSIONS,
  type SummaryNormalizationContext,
  type SummarySourceKeyMap,
} from "./summaryV2";
import { isWithinTimeBudget } from "./lib/aiProvider";
import { normalizeProcessSummaryEvidenceV2 } from "./lib/conversationEvidenceV2";
import {
  longProcessFixture,
  summaryV2BaselineFixtures,
  summaryV2ScenarioFixtures,
  uncertaintyFixture,
} from "./testFixtures/summaryV2";

const sourceByKey: SummarySourceKeyMap = {
  C1: {
    kind: "conversation",
    conversationId: "conversation-1" as Id<"conversations">,
    label: "Contributor A · Interview 1",
  },
  C2: {
    kind: "conversation",
    conversationId: "conversation-2" as Id<"conversations">,
    label: "Contributor B · Interview 2",
  },
  P1: {
    kind: "process",
    processId: "process-1" as Id<"processes">,
    label: "Request intake",
  },
  D1: {
    kind: "department",
    departmentId: "department-1" as Id<"departments">,
    label: "Operations",
  },
};

function context(
  overrides: Partial<SummaryNormalizationContext> = {},
): SummaryNormalizationContext {
  return {
    sourceByKey,
    coverage: {
      includedSources: 2,
      totalEligibleSources: 2,
      uniqueContributors: 2,
      complete: true,
    },
    provenance: {
      sourceSnapshotHash: "sha256:synthetic",
      generatedAt: 1_786_000_000_000,
      promptVersion: SUMMARY_V2_PROMPT_VERSIONS.processOverview,
      provider: "fabric-foundry",
      model: "test-model",
    },
    ...overrides,
  };
}

function rawFinding(
  title: string,
  sourceKeys: string[] = ["C1"],
  evidenceLevel: "corroborated" | "single_source" | "inferred_gap" =
    "single_source",
) {
  return {
    title,
    body: `${title} is described in the synthetic evidence.`,
    sourceKeys,
    evidenceLevel,
  };
}

function processPayload(overrides: Record<string, unknown> = {}) {
  return {
    headline: "Requests are checked before approval",
    executiveBrief:
      "Contributors describe a short intake and approval process with explicit evidence boundaries.",
    scope: [rawFinding("Requests arrive from the shared queue")],
    consensus: [],
    variations: [],
    gaps: [],
    notable: [],
    ...overrides,
  };
}

describe("Summary V2 contracts and normalizers", () => {
  test("locks prompt versions and configured caps", () => {
    expect(SUMMARY_V2_PROMPT_VERSIONS).toEqual({
      // v2: the output budget is stated in the prompt and the caps were cut to
      // fit it. Bumped because every v1 extraction of a substantial interview
      // truncated and stored nothing.
      conversationEvidence: "summary-v2-conversation-evidence-v2",
      // v2: the ordered stage timeline became non-sequential scope findings.
      // v3: the brief emphasizes its load-bearing facts with `**bold**`.
      processOverview: "summary-v2-process-overview-v3",
      // v2: the rollups moved off the process caps and onto their own, and the
      // output budget is stated in the prompt. Bumped because every department
      // with more than one child process truncated under v1.
      // v3: same brief emphasis instruction as the process overview.
      departmentOverview: "summary-v2-department-overview-v3",
      functionOverview: "summary-v2-function-overview-v3",
      legacyMarkdown: "summary-v2-legacy-markdown-v2",
    });
    expect(SUMMARY_V2_CAPS).toMatchObject({
      findingGroup: 8,
      sourcesPerFinding: 8,
      findingTitleChars: 120,
      findingBodyChars: 1_200,
      executiveBriefChars: 1_800,
      hierarchyFindingGroup: 5,
      hierarchyFindingBodyChars: 700,
      hierarchyExecutiveBriefChars: 1_600,
      conversationSteps: 18,
      conversationEvidenceGroup: 10,
      conversationStepBodyChars: 400,
      conversationEvidenceItemChars: 200,
      reduceChunkSources: 20,
    });
  });

  test("keeps the evidence contract inside the budget that has to hold it", () => {
    const budget = SUMMARY_V2_AI_BUDGETS.conversationEvidence;

    // The regression this pins: 1,536 tokens against a ~28k-token contract, so
    // any interview with real content came back `stop_reason: "max_tokens"` and
    // was discarded. Widening a cap now fails here instead of in production.
    expect(conversationEvidenceMaxOutputTokens()).toBeLessThanOrEqual(
      budget.maxTokens * CONVERSATION_EVIDENCE_CAP_BUDGET_RATIO,
    );

    // And the budget must still be spendable inside its own timeout: the two
    // ceilings are independent, and raising tokens to fix truncation is only a
    // fix if the call can generate them before the clock runs out.
    expect(isWithinTimeBudget(budget.maxTokens, budget.timeoutMs)).toBe(true);
  });

  test("keeps the rollup contract inside the budget that has to hold it", () => {
    const budget = SUMMARY_V2_AI_BUDGETS.hierarchyFinalReduce;

    // The regression this pins: the rollups reused the process caps — five
    // sections of eight 1,200-character findings, ~17.9k tokens — against
    // `finalReduce`'s 3,072. Compensation (5 processes) and Talent Development
    // (10) both truncated on both attempts and stored nothing, while the two
    // departments that succeeded had one child each and still spent 76-83% of
    // the budget. Widening a hierarchy cap now fails here instead of in prod.
    expect(hierarchyOverviewMaxOutputTokens()).toBeLessThanOrEqual(
      budget.maxTokens * HIERARCHY_OVERVIEW_CAP_BUDGET_RATIO,
    );

    expect(isWithinTimeBudget(budget.maxTokens, budget.timeoutMs)).toBe(true);

    // The rollup timeout is the one long enough to collide with the 10-minute
    // Convex action ceiling, and the timeout is per attempt. Prompt paging and
    // the save mutation share the same action, so leave real headroom.
    expect((1 + budget.maxRetries) * budget.timeoutMs).toBeLessThanOrEqual(
      480_000,
    );

    // A rollup carries the widest schema of the three reduce stages, so it must
    // never again be the one with the smallest budget.
    expect(budget.maxTokens).toBeGreaterThan(
      SUMMARY_V2_AI_BUDGETS.finalReduce.maxTokens,
    );
    expect(budget.maxTokens).toBeGreaterThan(
      SUMMARY_V2_AI_BUDGETS.chunkReduce.maxTokens,
    );
  });

  test("rejects malformed artifacts and keeps empty sections explicit", () => {
    expect(normalizeProcessOverviewArtifactV2(null, context())).toBeNull();
    expect(
      normalizeProcessOverviewArtifactV2(
        processPayload({ headline: "   " }),
        context(),
      ),
    ).toBeNull();

    const artifact = normalizeProcessOverviewArtifactV2(
      processPayload({ scope: [] }),
      context(),
    );
    expect(artifact).not.toBeNull();
    expect(artifact?.scope).toEqual([]);
    expect(artifact?.gaps).toEqual([]);
  });

  test("resolves only supplied keys and rejects unsupported factual claims", () => {
    const artifact = normalizeProcessOverviewArtifactV2(
      processPayload({
        scope: [
          rawFinding("Known source", ["C1", "UNKNOWN"]),
          rawFinding("Unknown source", ["UNKNOWN"]),
        ],
      }),
      context(),
    );

    expect(artifact?.scope).toHaveLength(1);
    expect(artifact?.scope[0].title).toBe("Known source");
    expect(artifact?.scope[0].sources).toHaveLength(1);
    expect(artifact?.scope[0].supportCount).toBe(1);
  });

  test("allows a sourceless inferred gap only when wording says evidence is missing", () => {
    const payload = uncertaintyFixture.payload;
    const artifact = normalizeProcessOverviewArtifactV2(payload, context());
    expect(artifact?.gaps).toHaveLength(1);
    expect(artifact?.gaps[0]).toMatchObject({
      title: "Final confirmation is not documented",
      evidenceLevel: "inferred_gap",
      supportCount: 0,
      sources: [],
    });

    const unsupported = normalizeProcessOverviewArtifactV2(
      processPayload({
        gaps: [
          rawFinding(
            "A manager approves every request",
            [],
            "inferred_gap",
          ),
        ],
      }),
      context(),
    );
    expect(unsupported?.gaps).toEqual([]);
  });

  test("deduplicates findings and source keys using normalized identity", () => {
    const artifact = normalizeProcessOverviewArtifactV2(
      processPayload({
        scope: [
          {
            ...rawFinding("Check eligibility", ["C1", "C1"]),
            unsupportedField: "discard me",
          },
          rawFinding("  CHECK   ELIGIBILITY ", ["C1"]),
        ],
      }),
      context(),
    );
    expect(artifact?.scope).toHaveLength(1);
    expect(artifact?.scope[0].sources).toHaveLength(1);
    expect(artifact?.scope[0]).not.toHaveProperty("unsupportedField");
  });

  test("caps output arrays and strings before persistence", () => {
    const oversized = "x".repeat(3_000);
    const artifact = normalizeProcessOverviewArtifactV2(
      processPayload({
        headline: oversized,
        executiveBrief: oversized,
        scope: Array.from({ length: 20 }, (_, index) => ({
          ...rawFinding(`Stage ${index}`),
          title: `${index}-${oversized}`,
          body: oversized,
        })),
        notable: Array.from({ length: 20 }, (_, index) =>
          rawFinding(`Notable ${index}`),
        ),
      }),
      context(),
    );

    expect(artifact?.headline).toHaveLength(SUMMARY_V2_CAPS.headlineChars);
    expect(artifact?.executiveBrief).toHaveLength(
      SUMMARY_V2_CAPS.executiveBriefChars,
    );
    expect(artifact?.scope).toHaveLength(SUMMARY_V2_CAPS.findingGroup);
    expect(artifact?.scope[0].title.length).toBeLessThanOrEqual(
      SUMMARY_V2_CAPS.findingTitleChars,
    );
    expect(artifact?.scope[0].body).toHaveLength(
      SUMMARY_V2_CAPS.findingBodyChars,
    );
    expect(artifact?.notable).toHaveLength(SUMMARY_V2_CAPS.findingGroup);
  });

  test("keeps brief emphasis renderable and strips it everywhere else", () => {
    const artifact = normalizeProcessOverviewArtifactV2(
      processPayload({
        headline: "Requests are **checked** before approval",
        executiveBrief:
          "Intake runs on **the shared queue** and approval needs **two signatures**.",
        scope: [
          {
            ...rawFinding("Requests arrive from the **shared queue**"),
            body: "The **queue** is the system of record for intake.",
          },
        ],
      }),
      context(),
    );

    // The brief is the one field a reader sees emphasized.
    expect(artifact?.executiveBrief).toBe(
      "Intake runs on **the shared queue** and approval needs **two signatures**.",
    );
    // Everywhere else renders as plain text, so markers are removed, not shown.
    expect(artifact?.headline).toBe("Requests are checked before approval");
    expect(artifact?.scope[0].title).toBe(
      "Requests arrive from the shared queue",
    );
    expect(artifact?.scope[0].body).toBe(
      "The queue is the system of record for intake.",
    );
  });

  test("drops emphasis the character cap cut in half", () => {
    const filler = "y".repeat(SUMMARY_V2_CAPS.executiveBriefChars - 12);
    const artifact = normalizeProcessOverviewArtifactV2(
      processPayload({
        // The closing marker falls beyond the cap, so the opening one would be
        // left rendering as literal asterisks.
        executiveBrief: `${filler} **truncated emphasis**`,
      }),
      context(),
    );
    const empty = normalizeProcessOverviewArtifactV2(
      processPayload({ executiveBrief: "An **** empty span is not emphasis." }),
      context(),
    );

    expect(artifact?.executiveBrief).not.toContain("**");
    expect(artifact?.executiveBrief).toContain("truncated");
    expect(empty?.executiveBrief).toBe("An empty span is not emphasis.");
  });

  test("derives evidence strength from unique resolved sources", () => {
    const artifact = normalizeProcessOverviewArtifactV2(
      processPayload({
        scope: [
          rawFinding("Actually corroborated", ["C1", "C2"]),
          rawFinding("Actually single source", ["C1"], "corroborated"),
        ],
      }),
      context(),
    );
    expect(artifact?.scope.map((item) => item.evidenceLevel)).toEqual([
      "corroborated",
      "single_source",
    ]);
  });

  test("normalizes department and function level-specific sections", () => {
    const department = normalizeDepartmentOverviewArtifactV2(
      {
        headline: "Department overview",
        executiveBrief: "A bounded department brief.",
        crossProcessDependencies: [rawFinding("Dependency", ["P1"])],
        sharedPatterns: [],
        variationsAndTensions: [],
        gaps: [],
        notable: [],
      },
      context({
        sourceByKey,
        provenance: {
          ...context().provenance,
          promptVersion: SUMMARY_V2_PROMPT_VERSIONS.departmentOverview,
        },
      }),
    );
    const fn = normalizeFunctionOverviewArtifactV2(
      {
        headline: "Function overview",
        executiveBrief: "A bounded function brief.",
        crossDepartmentDependencies: [rawFinding("Dependency", ["D1"])],
        strategicPatterns: [],
        variationsAndTensions: [],
        gaps: [],
        notable: [],
      },
      context({
        sourceByKey,
        provenance: {
          ...context().provenance,
          promptVersion: SUMMARY_V2_PROMPT_VERSIONS.functionOverview,
        },
      }),
    );

    expect(department?.crossProcessDependencies[0].sources[0].kind).toBe(
      "process",
    );
    expect(fn?.crossDepartmentDependencies[0].sources[0].kind).toBe(
      "department",
    );
  });

  test("clamps rollup artifacts to the rollup caps, not the process caps", () => {
    const oversized = "x".repeat(4_000);
    const overfilled = Array.from({ length: 20 }, (_, index) => ({
      ...rawFinding(`Dependency ${index}`, ["P1"]),
      body: oversized,
    }));
    const department = normalizeDepartmentOverviewArtifactV2(
      {
        headline: oversized,
        executiveBrief: oversized,
        crossProcessDependencies: overfilled,
        sharedPatterns: [],
        variationsAndTensions: [],
        gaps: [],
        notable: Array.from({ length: 20 }, (_, index) =>
          rawFinding(`Notable ${index}`, ["P1"]),
        ),
      },
      context({
        provenance: {
          ...context().provenance,
          promptVersion: SUMMARY_V2_PROMPT_VERSIONS.departmentOverview,
        },
      }),
    );

    // A model that ignores the schema must still land inside the persisted
    // contract, and inside the *rollup* one — the process caps would let five
    // sections of eight 1,200-character findings through.
    expect(department?.executiveBrief).toHaveLength(
      SUMMARY_V2_CAPS.hierarchyExecutiveBriefChars,
    );
    expect(department?.crossProcessDependencies).toHaveLength(
      SUMMARY_V2_CAPS.hierarchyFindingGroup,
    );
    expect(department?.crossProcessDependencies[0].body).toHaveLength(
      SUMMARY_V2_CAPS.hierarchyFindingBodyChars,
    );
    expect(department?.notable).toHaveLength(
      SUMMARY_V2_CAPS.hierarchyFindingGroup,
    );

    // And the process overview keeps its own wider caps.
    const process = normalizeProcessOverviewArtifactV2(
      processPayload({
        executiveBrief: oversized,
        scope: Array.from({ length: 20 }, (_, index) => ({
          ...rawFinding(`Stage ${index}`),
          body: oversized,
        })),
      }),
      context(),
    );
    expect(process?.executiveBrief).toHaveLength(
      SUMMARY_V2_CAPS.executiveBriefChars,
    );
    expect(process?.scope).toHaveLength(SUMMARY_V2_CAPS.findingGroup);
    expect(process?.scope[0].body).toHaveLength(
      SUMMARY_V2_CAPS.findingBodyChars,
    );
  });

  test("normalizes structured conversation evidence with bounded groups", () => {
    const evidence = normalizeProcessSummaryEvidenceV2(
      {
        sourceKey: "C-test",
        steps: Array.from({ length: 45 }, (_, index) => ({
          title: `Step ${index}`,
          body: "A synthetic step.",
          ignored: true,
        })),
        actors: [
          ...Array.from({ length: 25 }, (_, index) => `Actor ${index}`),
          "Actor 0",
        ],
        tools: [],
        handoffsAndDependencies: [],
        reportedVariations: [],
        frictionPoints: [],
        uncertainties: [],
      },
      "C-test",
      {
        transcriptHash: "sha256:transcript",
        promptVersion: SUMMARY_V2_PROMPT_VERSIONS.conversationEvidence,
        generatedAt: 1_786_000_000_000,
        provider: "fabric-foundry",
        model: "test-model",
      },
    );
    expect(evidence?.steps).toHaveLength(SUMMARY_V2_CAPS.conversationSteps);
    expect(evidence?.actors).toHaveLength(
      SUMMARY_V2_CAPS.conversationEvidenceGroup,
    );
    expect(evidence?.steps[0]).not.toHaveProperty("ignored");
  });
});

describe("Summary V2 compatibility reads", () => {
  test("prefers V2 and generates deterministic legacy Markdown", () => {
    const artifact = normalizeProcessOverviewArtifactV2(
      processPayload(),
      context(),
    );
    expect(artifact).not.toBeNull();
    const first = readCompatibleSummary({
      summaryV2: artifact!,
      legacyMarkdown: "Old summary",
    });
    const second = renderSummaryV2AsLegacyMarkdown(artifact!);
    expect(first.format).toBe("v2");
    expect(first.markdown).toBe(second);
    expect(first.markdown).toContain("## Scope and participants");
    expect(first.markdown).not.toContain("Old summary");
  });

  test("falls back for legacy function, department, and process fields", () => {
    const legacyRows = [
      { summary: "## Function\n\nLegacy function brief" },
      { summary: "## Department\n\nLegacy department brief" },
      { rollingSummary: "## Process\n\nLegacy process brief" },
    ];
    expect(
      legacyRows.map((row) =>
        readCompatibleSummary({
          legacyMarkdown: row.summary ?? row.rollingSummary,
        }),
      ),
    ).toEqual([
      {
        format: "legacy",
        artifact: null,
        markdown: "## Function\n\nLegacy function brief",
      },
      {
        format: "legacy",
        artifact: null,
        markdown: "## Department\n\nLegacy department brief",
      },
      {
        format: "legacy",
        artifact: null,
        markdown: "## Process\n\nLegacy process brief",
      },
    ]);
    expect(readCompatibleSummary({})).toEqual({
      format: "none",
      artifact: null,
      markdown: null,
    });
  });

  test("returns only lightweight state and coverage metadata for lists", () => {
    const artifact = normalizeProcessOverviewArtifactV2(
      processPayload(),
      context({
        coverage: {
          includedSources: 1,
          totalEligibleSources: 2,
          complete: false,
        },
      }),
    );
    expect(
      getSummaryListMetadata({ summaryV2: artifact!, stale: false }),
    ).toMatchObject({
      format: "v2",
      state: "partial",
      coverage: {
        includedSources: 1,
        totalEligibleSources: 2,
        complete: false,
      },
    });
    expect(
      getSummaryListMetadata({
        legacyMarkdown: "Legacy",
        legacyGeneratedAt: 100,
        stale: true,
      }),
    ).toEqual({
      format: "legacy",
      state: "stale",
      generatedAt: 100,
      coverage: null,
    });

    expect(
      getSummaryListMetadata({
        summaryV2: artifact!,
        refreshScheduledAt: 1_000,
        now: 1_500,
      }).state,
    ).toBe("refreshing");
    expect(
      getSummaryListMetadata({
        summaryV2: artifact!,
        lastRunState: "failed",
        lastRunCompletedAt: artifact!.provenance.generatedAt + 1,
      }).state,
    ).toBe("failed");
    expect(
      getSummaryListMetadata({
        summaryV2: artifact!,
        lastRunState: "failed",
        lastRunCompletedAt: artifact!.provenance.generatedAt - 1,
      }).state,
    ).toBe("partial");
    expect(getSummaryListMetadata({}).state).toBe("missing");
    expect(
      getSummaryListMetadata({ summaryV2: artifact!, stale: true }).state,
    ).toBe("stale");
    expect(
      getSummaryListMetadata({
        summaryV2: normalizeProcessOverviewArtifactV2(
          processPayload(),
          context(),
        )!,
      }).state,
    ).toBe("current");
  });
});

describe("Summary V2 clipboard and export projection", () => {
  const richPayload = {
    headline: "Requests are checked before approval",
    executiveBrief:
      "Contributors describe a short intake and approval process with explicit evidence boundaries.",
    scope: [
      rawFinding("Who owns the process", ["C1", "C2"], "corroborated"),
      rawFinding("Systems the work runs on", ["C2"]),
    ],
    consensus: [rawFinding("Approval precedes payment", ["C1", "C2"], "corroborated")],
    variations: [rawFinding("Escalation ownership differs", ["C2"])],
    gaps: [
      {
        title: "Escalation threshold is unconfirmed",
        body: "No evidence establishes a shared escalation threshold.",
        sourceKeys: [],
        evidenceLevel: "inferred_gap" as const,
      },
    ],
    notable: [rawFinding("Month end concentrates volume", ["C1"])],
  };

  test("projects identical Markdown for identical artifacts, every time", () => {
    const artifact = normalizeProcessOverviewArtifactV2(richPayload, context())!;
    const twin = normalizeProcessOverviewArtifactV2(richPayload, context())!;

    const projections = [
      renderSummaryV2AsLegacyMarkdown(artifact),
      renderSummaryV2AsLegacyMarkdown(artifact),
      renderSummaryV2AsLegacyMarkdown(twin),
      readCompatibleSummary({ summaryV2: artifact }).markdown,
      readCompatibleSummary({
        summaryV2: artifact,
        legacyMarkdown: "A stored projection that must not be preferred",
      }).markdown,
    ];
    expect(new Set(projections).size).toBe(1);
  });

  test("carries every artifact section, finding, and source into the copied Markdown", () => {
    const artifact = normalizeProcessOverviewArtifactV2(richPayload, context())!;
    const markdown = renderSummaryV2AsLegacyMarkdown(artifact);

    expect(markdown.startsWith(`# ${artifact.headline}`)).toBe(true);
    expect(markdown).toContain(artifact.executiveBrief);
    for (const finding of [
      ...artifact.scope,
      ...artifact.consensus,
      ...artifact.variations,
      ...artifact.gaps,
      ...artifact.notable,
    ]) {
      expect(markdown).toContain(finding.title);
      expect(markdown).toContain(finding.body);
      for (const source of finding.sources) {
        expect(markdown).toContain(source.label);
      }
    }
    // Coverage travels with the content so a pasted overview cannot imply more
    // evidence than was used.
    expect(markdown).toContain(
      "2 of 2 eligible sources included across 2 contributors. Coverage is complete.",
    );
    expect(markdown.indexOf("## Scope and participants")).toBeLessThan(
      markdown.indexOf("## Evidence coverage"),
    );
  });

  test("never numbers a section, so the copy cannot imply a step order", () => {
    const artifact = normalizeProcessOverviewArtifactV2(richPayload, context())!;
    const markdown = renderSummaryV2AsLegacyMarkdown(artifact);

    expect(markdown).toContain("- **Who owns the process**");
    expect(markdown).not.toMatch(/^\d+\.\s/m);
    expect(markdown).not.toContain("## How the process works");
  });

  test("projects department and function rollups with their own section names", () => {
    const departmentMarkdown = renderSummaryV2AsLegacyMarkdown(
      normalizeDepartmentOverviewArtifactV2(
        {
          headline: "Service depends on two upstream processes",
          executiveBrief: "Departments share one intake queue.",
          crossProcessDependencies: [rawFinding("Intake feeds approval", ["P1"])],
          sharedPatterns: [],
          variationsAndTensions: [],
          gaps: [],
          notable: [],
        },
        context(),
      )!,
    );
    const functionMarkdown = renderSummaryV2AsLegacyMarkdown(
      normalizeFunctionOverviewArtifactV2(
        {
          headline: "Operations runs on one shared platform",
          executiveBrief: "Both departments report the same constraint.",
          crossDepartmentDependencies: [rawFinding("Shared platform", ["D1"])],
          strategicPatterns: [],
          variationsAndTensions: [],
          gaps: [],
          notable: [],
        },
        context(),
      )!,
    );

    expect(departmentMarkdown).toContain("## Cross-process dependencies");
    expect(departmentMarkdown).toContain("Request intake");
    expect(functionMarkdown).toContain("## Cross-department dependencies");
    expect(functionMarkdown).toContain("Operations");
    expect(departmentMarkdown).not.toContain("## How the process works");
  });

  test("copies a V1-only row byte for byte", () => {
    const legacy = "## Existing narrative\n\nThe original summary remains.";
    expect(readCompatibleSummary({ legacyMarkdown: legacy }).markdown).toBe(
      legacy,
    );
    expect(readCompatibleSummary({ legacyMarkdown: "   " }).markdown).toBeNull();
  });
});

describe("Summary V2 bounded fixtures", () => {
  test("fixtures are synthetic and cover every locked baseline scenario", () => {
    // The Phase 0 lock is on the baseline six. The Phase 10 golden-set
    // extension is asserted separately in summaryEvaluation.test.ts.
    expect(summaryV2BaselineFixtures.map((fixture) => fixture.id)).toEqual([
      "one-contributor",
      "agreeing-contributors",
      "contradicting-contributors",
      "explicit-uncertainty",
      "long-process",
      "stale-rollup",
    ]);
    const serialized = JSON.stringify(summaryV2ScenarioFixtures);
    expect(serialized).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
    expect(serialized).not.toMatch(/org_[A-Za-z0-9]/);
  });

  test("the long fixture requires three deterministic reduce chunks", () => {
    expect(longProcessFixture.sources).toHaveLength(45);
    expect(
      Math.ceil(
        longProcessFixture.sources.length / SUMMARY_V2_CAPS.reduceChunkSources,
      ),
    ).toBe(3);
  });

  test("maximum normalized artifacts stay comfortably below 1 MB", () => {
    const maximumSources = Object.fromEntries(
      Array.from({ length: SUMMARY_V2_CAPS.sourcesPerFinding }, (_, index) => [
        `C${index + 1}`,
        {
          kind: "conversation" as const,
          conversationId: `conversation-${index + 1}` as Id<"conversations">,
          label: `Synthetic source ${index + 1} ${"s".repeat(100)}`,
        },
      ]),
    );
    const sourceKeys = Object.keys(maximumSources);
    const makeMaximumGroup = (
      count: number,
      prefix: string,
      keys = sourceKeys,
    ) =>
      Array.from({ length: count }, (_, index) => ({
        title: `${prefix} ${index} ${"t".repeat(150)}`,
        body: `${index} ${"b".repeat(1_500)}`,
        sourceKeys: keys,
        evidenceLevel: keys.length > 1 ? "corroborated" : "single_source",
      }));
    const process = normalizeProcessOverviewArtifactV2(
      processPayload({
        scope: makeMaximumGroup(20, "Scope"),
        consensus: makeMaximumGroup(20, "Consensus"),
        variations: makeMaximumGroup(20, "Variation"),
        gaps: makeMaximumGroup(20, "Gap"),
        notable: makeMaximumGroup(20, "Notable"),
      }),
      context({ sourceByKey: maximumSources }),
    );
    const department = normalizeDepartmentOverviewArtifactV2(
      {
        headline: "Maximum department artifact",
        executiveBrief: "b".repeat(2_000),
        crossProcessDependencies: makeMaximumGroup(20, "Dependency", ["P1"]),
        sharedPatterns: makeMaximumGroup(20, "Pattern", ["P1"]),
        variationsAndTensions: makeMaximumGroup(20, "Variation", ["P1"]),
        gaps: makeMaximumGroup(20, "Gap", ["P1"]),
        notable: makeMaximumGroup(20, "Notable", ["P1"]),
      },
      context(),
    );
    const fn = normalizeFunctionOverviewArtifactV2(
      {
        headline: "Maximum function artifact",
        executiveBrief: "b".repeat(2_000),
        crossDepartmentDependencies: makeMaximumGroup(20, "Dependency", [
          "D1",
        ]),
        strategicPatterns: makeMaximumGroup(20, "Pattern", ["D1"]),
        variationsAndTensions: makeMaximumGroup(20, "Variation", ["D1"]),
        gaps: makeMaximumGroup(20, "Gap", ["D1"]),
        notable: makeMaximumGroup(20, "Notable", ["D1"]),
      },
      context(),
    );
    for (const artifact of [process, department, fn]) {
      expect(artifact).not.toBeNull();
      const bytes = new TextEncoder().encode(
        JSON.stringify(artifact),
      ).byteLength;
      expect(bytes).toBeLessThan(256 * 1_024);
    }
  });
});
