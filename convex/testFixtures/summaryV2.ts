/**
 * Synthetic, tenant-neutral fixtures for Summary V2 contract and golden-set
 * tests. They describe evidence shapes only; they contain no copied customer
 * transcripts, tenant IDs, email addresses, or real contributor names.
 */

export type SummaryV2SourceFixture = {
  key: string;
  kind: "conversation" | "process" | "department";
  label: string;
};

/**
 * Phase 10 release-gate expectations. Optional so the Phase 0 baseline
 * fixtures keep the shape they were locked with.
 */
export type SummaryV2ScenarioEvaluation = {
  /** Facts that must survive normalization into the reader-visible artifact. */
  criticalFacts?: string[];
  /** Finding titles the normalizer must drop entirely. */
  rejectedFindingTitles?: string[];
  /** Keys the payload cites that must not resolve to any source. */
  invalidSourceKeys?: string[];
  /**
   * Whether the measured-language gate is expected to fire. Only the
   * deliberately non-compliant fixture sets this to `true`.
   */
  expectsMeasuredLanguage?: boolean;
  /** Exact coverage the artifact must report. */
  coverage?: {
    includedSources: number;
    totalEligibleSources: number;
    uniqueContributors?: number;
  };
};

export type SummaryV2ScenarioFixture = {
  id: string;
  purpose: string;
  sources: SummaryV2SourceFixture[];
  payload: Record<string, unknown>;
  expected: Record<string, unknown>;
  evaluation?: SummaryV2ScenarioEvaluation;
};

function finding(
  title: string,
  body: string,
  sourceKeys: string[],
  evidenceLevel: "corroborated" | "single_source" | "inferred_gap",
) {
  return { title, body, sourceKeys, evidenceLevel };
}

export const oneContributorFixture: SummaryV2ScenarioFixture = {
  id: "one-contributor",
  purpose: "A valid process overview supported by one interview.",
  sources: [
    { key: "C1", kind: "conversation", label: "Contributor A · Interview 1" },
  ],
  payload: {
    headline: "Requests are reviewed before work begins",
    executiveBrief:
      "A coordinator receives each request, checks the required details, and routes it for approval.",
    scope: [
      finding(
        "What starts the process",
        "A request reaching the shared queue starts the work.",
        ["C1"],
        "single_source",
      ),
      finding(
        "Systems the work runs on",
        "The shared request queue is the only system named.",
        ["C1"],
        "single_source",
      ),
    ],
    consensus: [],
    variations: [],
    gaps: [],
    notable: [],
  },
  expected: { includedSources: 1, evidenceLevel: "single_source" },
};

export const agreeingContributorsFixture: SummaryV2ScenarioFixture = {
  id: "agreeing-contributors",
  purpose: "Independent interviews corroborate the same operating step.",
  sources: [
    { key: "C1", kind: "conversation", label: "Contributor A · Interview 1" },
    { key: "C2", kind: "conversation", label: "Contributor B · Interview 2" },
  ],
  payload: {
    headline: "Every request receives an eligibility check",
    executiveBrief:
      "Both contributors describe the same initial eligibility review before an approver is selected.",
    scope: [
      finding(
        "Who runs the work",
        "The coordination team performs the eligibility review in both accounts.",
        ["C1", "C2"],
        "corroborated",
      ),
    ],
    consensus: [
      finding(
        "Eligibility is always reviewed",
        "Both contributors describe an eligibility review on every request.",
        ["C1", "C2"],
        "corroborated",
      ),
    ],
    variations: [],
    gaps: [],
    notable: [],
  },
  expected: { includedSources: 2, supportCount: 2 },
};

export const contradictingContributorsFixture: SummaryV2ScenarioFixture = {
  id: "contradicting-contributors",
  purpose: "Reported ways of working disagree without choosing a winner.",
  sources: [
    { key: "C1", kind: "conversation", label: "Contributor A · Interview 1" },
    { key: "C2", kind: "conversation", label: "Contributor B · Interview 2" },
  ],
  payload: {
    headline: "Approval routing differs by contributor",
    executiveBrief:
      "The interviews agree on intake but describe two different approval owners that need reconciliation.",
    scope: [],
    consensus: [],
    variations: [
      finding(
        "Different approval owners",
        "One contributor routes requests to a team lead, while another routes them directly to a manager.",
        ["C1", "C2"],
        "corroborated",
      ),
    ],
    gaps: [],
    notable: [],
  },
  expected: { preservesTension: true, choosesCanonicalVariant: false },
};

export const uncertaintyFixture: SummaryV2ScenarioFixture = {
  id: "explicit-uncertainty",
  purpose: "A sourceless inference is allowed only as an explicit evidence gap.",
  sources: [
    { key: "C1", kind: "conversation", label: "Contributor A · Interview 1" },
  ],
  payload: {
    headline: "The request path is documented until final confirmation",
    executiveBrief:
      "The available interview describes intake and review, but who confirms completion is not captured.",
    scope: [],
    consensus: [],
    variations: [],
    gaps: [
      finding(
        "Final confirmation is not documented",
        "The available evidence does not specify who confirms completion.",
        [],
        "inferred_gap",
      ),
      finding(
        "Unsupported factual claim",
        "A manager always confirms every completed request.",
        ["UNKNOWN"],
        "corroborated",
      ),
    ],
    notable: [],
  },
  expected: { acceptedGaps: 1, rejectedUnsupportedFindings: 1 },
};

const longProcessSources: SummaryV2SourceFixture[] = Array.from(
  { length: 45 },
  (_, index) => ({
    key: `C${index + 1}`,
    kind: "conversation" as const,
    label: `Contributor ${index + 1} · Interview ${index + 1}`,
  }),
);

export const longProcessFixture: SummaryV2ScenarioFixture = {
  id: "long-process",
  purpose: "More interviews than one reduce chunk can contain.",
  sources: longProcessSources,
  payload: {
    headline: "A long-running request process has broad interview coverage",
    executiveBrief:
      "The evidence set is deliberately large enough to exercise deterministic chunking and final reduction.",
    scope: Array.from({ length: 18 }, (_, index) =>
      finding(
        `Scope claim ${index + 1}`,
        `Synthetic scope statement ${index + 1} about ownership or systems.`,
        [`C${(index % longProcessSources.length) + 1}`],
        "single_source",
      ),
    ),
    consensus: [],
    variations: [],
    gaps: [],
    notable: [],
  },
  expected: { sourceCount: 45, reduceChunkCount: 3, persistedFindingCap: 8 },
};

export const staleRollupFixture: SummaryV2ScenarioFixture = {
  id: "stale-rollup",
  purpose: "Department and function rollups expose stale and missing children.",
  sources: [
    { key: "P1", kind: "process", label: "Request intake" },
    { key: "P2", kind: "process", label: "Request approval" },
    { key: "D1", kind: "department", label: "Operations" },
  ],
  payload: {
    department: {
      headline: "Two processes form the request lifecycle",
      executiveBrief:
        "Request intake is current; request approval is documented but stale.",
      crossProcessDependencies: [],
      sharedPatterns: [],
      variationsAndTensions: [],
      gaps: [],
      notable: [],
    },
    function: {
      headline: "Function coverage remains partial",
      executiveBrief:
        "One department is represented and another has no current overview.",
      crossDepartmentDependencies: [],
      strategicPatterns: [],
      variationsAndTensions: [],
      gaps: [],
      notable: [],
    },
  },
  expected: {
    childStates: ["current", "stale", "missing"],
    departmentCoverageComplete: false,
    functionCoverageComplete: false,
  },
};

/**
 * The Phase 0 contract-lock set. Frozen: these six shapes are what the
 * baseline, caps, and prompt versions were reviewed against.
 */
export const summaryV2BaselineFixtures = [
  oneContributorFixture,
  agreeingContributorsFixture,
  contradictingContributorsFixture,
  uncertaintyFixture,
  longProcessFixture,
  staleRollupFixture,
] as const;

// --------------------------------------------------------------------------
// Phase 10 golden-set extension (reference plan §11.3)
// --------------------------------------------------------------------------

export const overlappingAccountsFixture: SummaryV2ScenarioFixture = {
  id: "overlapping-accounts",
  purpose:
    "Three contributors overlap partially: two corroborate intake, one adds a step only they perform.",
  sources: [
    { key: "C1", kind: "conversation", label: "Contributor A · Interview 1" },
    { key: "C2", kind: "conversation", label: "Contributor B · Interview 2" },
    { key: "C3", kind: "conversation", label: "Contributor C · Interview 3" },
  ],
  payload: {
    headline: "Intake is shared; the credit hold is one contributor's step",
    executiveBrief:
      "Two contributors describe the same intake into the shared request queue. A third also places a credit hold that the other accounts never mention, so the overlap is partial rather than contradictory.",
    scope: [
      finding(
        "Systems the work runs on",
        "The shared request queue is the system of record in every account.",
        ["C1", "C2", "C3"],
        "corroborated",
      ),
      finding(
        "Roles that do the work",
        "Coordinators own intake; one account adds a credit reviewer.",
        ["C1", "C3"],
        "corroborated",
      ),
    ],
    consensus: [
      finding(
        "Intake enters the shared request queue",
        "Contributors A and C both describe intake landing in the shared request queue before any review.",
        ["C1", "C3"],
        "corroborated",
      ),
    ],
    variations: [
      finding(
        "A credit hold is applied by one contributor only",
        "Contributor B places a credit hold before review. The other two accounts describe no such hold, so it may be role-specific rather than universal.",
        ["C2"],
        "single_source",
      ),
    ],
    gaps: [
      finding(
        "Whether the credit hold applies to every request is unknown",
        "No account establishes whether the credit hold is required for all requests or only some.",
        [],
        "inferred_gap",
      ),
    ],
    notable: [],
  },
  expected: {
    includedSources: 3,
    corroboratedFindings: 3,
    singleSourceFindings: 1,
  },
  evaluation: {
    criticalFacts: ["shared request queue", "credit hold"],
    coverage: {
      includedSources: 3,
      totalEligibleSources: 3,
      uniqueContributors: 3,
    },
  },
};

const overFiftySources: SummaryV2SourceFixture[] = Array.from(
  { length: 52 },
  (_, index) => ({
    key: `C${index + 1}`,
    kind: "conversation" as const,
    label: `Contributor ${index + 1} · Interview ${index + 1}`,
  }),
);

export const overFiftyConversationsFixture: SummaryV2ScenarioFixture = {
  id: "over-fifty-conversations",
  purpose:
    "More than fifty conversations, proving the pipeline no longer stops at the retired 50-row cap.",
  sources: overFiftySources,
  payload: {
    headline: "A widely interviewed process retains exact coverage",
    executiveBrief:
      "Fifty-two interviews were eligible and all fifty-two were included, so the coverage claim is complete rather than sampled.",
    scope: [
      finding(
        "What starts the process",
        "A customer request arriving in the intake channel starts the work.",
        ["C1", "C2", "C51", "C52"],
        "corroborated",
      ),
    ],
    consensus: [
      finding(
        "Every request is acknowledged before routing",
        "Contributors across the full interview set describe an acknowledgement before any routing decision.",
        ["C1", "C20", "C40", "C52"],
        "corroborated",
      ),
    ],
    variations: [],
    gaps: [],
    notable: [],
  },
  expected: {
    sourceCount: 52,
    reduceChunkCount: 3,
    exactCoverage: true,
  },
  evaluation: {
    criticalFacts: ["intake channel", "acknowledgement"],
    coverage: {
      includedSources: 52,
      totalEligibleSources: 52,
      uniqueContributors: 52,
    },
  },
};

export const malformedSourceKeysFixture: SummaryV2ScenarioFixture = {
  id: "malformed-source-keys",
  purpose:
    "Invented, duplicated, and non-string source keys must never reach a persisted artifact.",
  sources: [
    { key: "C1", kind: "conversation", label: "Contributor A · Interview 1" },
    { key: "C2", kind: "conversation", label: "Contributor B · Interview 2" },
  ],
  payload: {
    headline: "Only resolvable source keys survive normalization",
    executiveBrief:
      "This payload cites keys that were never supplied, repeats one that was, and mixes in values that are not strings at all.",
    scope: [
      finding(
        "Duplicate keys collapse to one source",
        "The same conversation is cited three times and must count once.",
        ["C1", "C1", "C1"],
        "corroborated",
      ),
      finding(
        "Unsupplied keys are dropped from an otherwise valid finding",
        "One real key and several invented ones are cited together.",
        ["C1", "C99", "C100", "CONVERSATION_2"],
        "corroborated",
      ),
    ],
    consensus: [
      {
        title: "Wholly invented sources reject the finding",
        body: "Every key on this finding was invented by the model.",
        sourceKeys: ["C42", "C43"],
        evidenceLevel: "corroborated",
      },
      {
        title: "Non-string keys reject the finding",
        body: "This finding cites values that are not source keys.",
        sourceKeys: [7, null, { key: "C1" }],
        evidenceLevel: "single_source",
      },
    ],
    variations: [],
    gaps: [
      finding(
        "A factual claim disguised as a gap is rejected",
        "A manager signs off on every request without exception.",
        ["C77"],
        "inferred_gap",
      ),
      finding(
        "Who owns the final sign-off is not documented",
        "No supplied interview establishes the final sign-off owner.",
        [],
        "inferred_gap",
      ),
    ],
    notable: [],
  },
  expected: {
    acceptedFindings: 3,
    rejectedFindings: 3,
  },
  evaluation: {
    invalidSourceKeys: [
      "C99",
      "C100",
      "CONVERSATION_2",
      "C42",
      "C43",
      "C77",
    ],
    rejectedFindingTitles: [
      "Wholly invented sources reject the finding",
      "Non-string keys reject the finding",
      "A factual claim disguised as a gap is rejected",
    ],
    criticalFacts: ["final sign-off"],
    coverage: {
      includedSources: 2,
      totalEligibleSources: 2,
      uniqueContributors: 2,
    },
  },
};

export const unevenRollupCoverageFixture: SummaryV2ScenarioFixture = {
  id: "uneven-rollup-coverage",
  purpose:
    "A department and a function whose children are in different states must report partial coverage, not a clean roll-up.",
  sources: [
    { key: "P1", kind: "process", label: "Request intake" },
    { key: "P2", kind: "process", label: "Request approval" },
    { key: "D1", kind: "department", label: "Operations" },
    { key: "D2", kind: "department", label: "Finance" },
  ],
  payload: {
    department: {
      headline: "Two of four processes are current",
      executiveBrief:
        "Request intake and request approval are current and analyzed here. A third process is stale and a fourth failed to generate, so neither is represented in these findings.",
      crossProcessDependencies: [
        finding(
          "Approval depends on intake completing",
          "Request approval cannot start until request intake records the request.",
          ["P1", "P2"],
          "corroborated",
        ),
      ],
      sharedPatterns: [
        finding(
          "Both current processes use the shared request queue",
          "The shared request queue is the system of record for both analyzed processes.",
          ["P1", "P2"],
          "corroborated",
        ),
      ],
      variationsAndTensions: [],
      gaps: [
        finding(
          "Two processes are not represented in this department view",
          "One process summary is stale and one failed to generate, so their content is unknown to this rollup.",
          [],
          "inferred_gap",
        ),
      ],
      notable: [],
    },
    function: {
      headline: "One department of three is current",
      executiveBrief:
        "Operations is current and Finance is explicitly partial. A third department has no overview at all, so this function view covers one department fully and one in part.",
      crossDepartmentDependencies: [
        finding(
          "Finance depends on Operations for approved requests",
          "Approved requests reach Finance only after Operations completes approval.",
          ["D1", "D2"],
          "corroborated",
        ),
      ],
      strategicPatterns: [
        finding(
          "Shared queue tooling spans both represented departments",
          "Both represented departments run their work on the shared request queue.",
          ["D1", "D2"],
          "corroborated",
        ),
      ],
      variationsAndTensions: [],
      gaps: [
        finding(
          "A third department is missing from this view",
          "One eligible department has no overview, so its operation is not captured here.",
          [],
          "inferred_gap",
        ),
      ],
      notable: [],
    },
  },
  expected: {
    departmentChildStates: ["current", "current", "stale", "failed"],
    functionChildStates: ["current", "partial", "missing"],
    departmentCoverageComplete: false,
    functionCoverageComplete: false,
  },
  evaluation: {
    criticalFacts: ["shared request queue"],
    coverage: {
      includedSources: 2,
      totalEligibleSources: 4,
    },
  },
};

/**
 * The negative control for the measured-language gate. Nothing in the write
 * path strips this wording — the normalizer bounds and sources text, it does
 * not police claims — so the gate has to catch it in evaluation and in the
 * stored-artifact audit.
 */
export const measuredLanguageRejectionFixture: SummaryV2ScenarioFixture = {
  id: "measured-language-rejection",
  purpose:
    "Interview evidence stated as event-log measurement must fail the measured-language gate.",
  sources: [
    { key: "C1", kind: "conversation", label: "Contributor A · Interview 1" },
    { key: "C2", kind: "conversation", label: "Contributor B · Interview 2" },
  ],
  payload: {
    headline: "Approvals clear in 3 days on average",
    executiveBrief:
      "The event log shows 38% of cases are reworked, and average cycle time is 3.2 days across the measured period.",
    scope: [
      finding(
        "Throughput of the approval step",
        "The approval step sustains a throughput of 40 requests per day with a rework rate of 12%.",
        ["C1", "C2"],
        "corroborated",
      ),
    ],
    consensus: [
      finding(
        "Requests are reviewed before approval",
        "Both contributors describe a review preceding approval.",
        ["C1", "C2"],
        "corroborated",
      ),
    ],
    variations: [],
    gaps: [],
    notable: [],
  },
  expected: { measuredLanguageViolations: true },
  evaluation: {
    expectsMeasuredLanguage: true,
    coverage: {
      includedSources: 2,
      totalEligibleSources: 2,
      uniqueContributors: 2,
    },
  },
};

/** Phase 10 additions only. */
export const summaryV2GoldenSetExtensionFixtures = [
  overlappingAccountsFixture,
  overFiftyConversationsFixture,
  malformedSourceKeysFixture,
  unevenRollupCoverageFixture,
  measuredLanguageRejectionFixture,
] as const;

/** The complete golden set scored by the Phase 10 release gates. */
export const summaryV2ScenarioFixtures = [
  ...summaryV2BaselineFixtures,
  ...summaryV2GoldenSetExtensionFixtures,
] as const;

/**
 * Deterministic synthetic IDs so a fixture can be normalized exactly the way
 * the pipeline normalizes a real payload. IDs are positional and stable, which
 * keeps derived finding IDs stable across runs.
 */
export function sourceKeyMapForFixture(
  fixture: SummaryV2ScenarioFixture,
): Record<
  string,
  | { kind: "conversation"; conversationId: string; label: string }
  | { kind: "process"; processId: string; label: string }
  | { kind: "department"; departmentId: string; label: string }
> {
  const map: Record<
    string,
    | { kind: "conversation"; conversationId: string; label: string }
    | { kind: "process"; processId: string; label: string }
    | { kind: "department"; departmentId: string; label: string }
  > = {};
  fixture.sources.forEach((source, index) => {
    const id = `${fixture.id}-${source.kind}-${index + 1}`;
    if (source.kind === "conversation") {
      map[source.key] = {
        kind: "conversation",
        conversationId: id,
        label: source.label,
      };
    } else if (source.kind === "process") {
      map[source.key] = {
        kind: "process",
        processId: id,
        label: source.label,
      };
    } else {
      map[source.key] = {
        kind: "department",
        departmentId: id,
        label: source.label,
      };
    }
  });
  return map;
}
