/**
 * Phase 10 release-gate scorers.
 *
 * These are deterministic, side-effect-free checks over a *normalized* Summary
 * V2 artifact. They exist so the golden set and stored production artifacts are
 * judged by exactly the same rules: the golden-set suite runs them over
 * fixtures, and `summaryOps.auditStoredArtifacts` runs them over real rows.
 *
 * They deliberately re-derive their verdicts from the artifact alone rather
 * than trusting the generation pipeline that produced it — a normalizer bug
 * that silently accepts an unsourced factual finding must be caught here, not
 * masked by reusing the normalizer's own opinion.
 */

import {
  isExplicitMissingEvidenceFinding,
  stripEmphasisMarkers,
  type SummaryArtifactV2,
  type SummaryCoverage,
  type SummaryFinding,
  type SummarySourceRef,
} from "../summaryV2";

export type SummaryFindingLocation = {
  /** The artifact group the finding was rendered in, e.g. `scope`. */
  section: string;
  finding: SummaryFinding;
};

/** Stable identity for a resolved source, matching the normalizer's rule. */
export function summarySourceIdentity(source: SummarySourceRef): string {
  if (source.kind === "conversation") {
    return `conversation:${source.conversationId}`;
  }
  if (source.kind === "process") return `process:${source.processId}`;
  return `department:${source.departmentId}`;
}

const PROCESS_SECTIONS = [
  "scope",
  "consensus",
  "variations",
  "gaps",
  "notable",
] as const;
const DEPARTMENT_SECTIONS = [
  "crossProcessDependencies",
  "sharedPatterns",
  "variationsAndTensions",
  "gaps",
  "notable",
] as const;
const FUNCTION_SECTIONS = [
  "crossDepartmentDependencies",
  "strategicPatterns",
  "variationsAndTensions",
  "gaps",
  "notable",
] as const;

function artifactSections(artifact: SummaryArtifactV2): readonly string[] {
  if ("scope" in artifact) return PROCESS_SECTIONS;
  if ("crossProcessDependencies" in artifact) return DEPARTMENT_SECTIONS;
  return FUNCTION_SECTIONS;
}

export function listArtifactFindings(
  artifact: SummaryArtifactV2,
): SummaryFindingLocation[] {
  const located: SummaryFindingLocation[] = [];
  for (const section of artifactSections(artifact)) {
    const group = (artifact as unknown as Record<string, unknown>)[section];
    if (!Array.isArray(group)) continue;
    for (const finding of group as SummaryFinding[]) {
      located.push({ section, finding });
    }
  }
  return located;
}

/** Every string a reader can see, in one buffer, for text-level gates. */
export function artifactText(artifact: SummaryArtifactV2): string {
  const parts = [artifact.headline, artifact.executiveBrief];
  for (const { finding } of listArtifactFindings(artifact)) {
    parts.push(finding.title, finding.body);
  }
  return parts.join("\n");
}

// --------------------------------------------------------------------------
// Gate 1 and 2: source validity and support
// --------------------------------------------------------------------------

export type SourceValidityViolation = {
  code:
    | "factual_finding_without_source"
    | "source_outside_snapshot"
    | "support_count_mismatch"
    | "evidence_level_mismatch"
    | "gap_not_phrased_as_missing_evidence"
    | "duplicate_source_in_finding";
  section: string;
  findingId: string;
  findingTitle: string;
  detail: string;
};

export type SourceValidityReport = {
  totalFindings: number;
  factualFindings: number;
  gapFindings: number;
  /** Factual findings carrying at least one resolvable in-scope source. */
  supportedFactualFindings: number;
  violations: SourceValidityViolation[];
  passed: boolean;
};

/**
 * `allowedSourceIdentities` is the exact source snapshot the artifact was
 * generated from. Passing it turns this into a cross-org leak check as well:
 * a source that is not in the owning entity's own snapshot fails, whether it
 * was invented by the model or belongs to another organization.
 */
export function scoreSourceValidity(
  artifact: SummaryArtifactV2,
  options: { allowedSourceIdentities?: ReadonlySet<string> } = {},
): SourceValidityReport {
  const violations: SourceValidityViolation[] = [];
  const findings = listArtifactFindings(artifact);
  let factualFindings = 0;
  let gapFindings = 0;
  let supportedFactualFindings = 0;

  for (const { section, finding } of findings) {
    const isGap = finding.evidenceLevel === "inferred_gap";
    if (isGap) gapFindings += 1;
    else factualFindings += 1;

    const seen = new Set<string>();
    for (const source of finding.sources) {
      const identity = summarySourceIdentity(source);
      if (seen.has(identity)) {
        violations.push({
          code: "duplicate_source_in_finding",
          section,
          findingId: finding.id,
          findingTitle: finding.title,
          detail: identity,
        });
      }
      seen.add(identity);
      if (
        options.allowedSourceIdentities &&
        !options.allowedSourceIdentities.has(identity)
      ) {
        violations.push({
          code: "source_outside_snapshot",
          section,
          findingId: finding.id,
          findingTitle: finding.title,
          detail: identity,
        });
      }
    }

    if (finding.supportCount !== finding.sources.length) {
      violations.push({
        code: "support_count_mismatch",
        section,
        findingId: finding.id,
        findingTitle: finding.title,
        detail: `supportCount ${finding.supportCount} but ${finding.sources.length} sources`,
      });
    }

    if (isGap) {
      // A sourceless gap is the one permitted unsupported statement, and only
      // when it says out loud that the evidence is missing.
      if (
        finding.sources.length === 0 &&
        !isExplicitMissingEvidenceFinding(finding.title, finding.body)
      ) {
        violations.push({
          code: "gap_not_phrased_as_missing_evidence",
          section,
          findingId: finding.id,
          findingTitle: finding.title,
          detail: "sourceless gap does not state that evidence is missing",
        });
      }
      continue;
    }

    if (finding.sources.length === 0) {
      violations.push({
        code: "factual_finding_without_source",
        section,
        findingId: finding.id,
        findingTitle: finding.title,
        detail: `${finding.evidenceLevel} finding cites no resolved source`,
      });
    } else {
      supportedFactualFindings += 1;
    }

    const expectedLevel =
      finding.sources.length >= 2 ? "corroborated" : "single_source";
    if (finding.evidenceLevel !== expectedLevel) {
      violations.push({
        code: "evidence_level_mismatch",
        section,
        findingId: finding.id,
        findingTitle: finding.title,
        detail: `${finding.evidenceLevel} with ${finding.sources.length} sources`,
      });
    }
  }

  return {
    totalFindings: findings.length,
    factualFindings,
    gapFindings,
    supportedFactualFindings,
    violations,
    passed: violations.length === 0,
  };
}

// --------------------------------------------------------------------------
// Gate 3: measured process-mining language
// --------------------------------------------------------------------------

/**
 * Interview evidence is reported knowledge. These rules catch the language of
 * event-log analysis, which would claim a measurement the product never made.
 *
 * Rules are deliberately anchored on the *quantified* form. Reported hedges
 * ("usually", "most requests", "a couple of days") are legitimate contributor
 * accounts and must not trip the gate; "38% of cases" and "average cycle time
 * of 3.2 days" must.
 */
export const MEASURED_LANGUAGE_RULES: ReadonlyArray<{
  id: string;
  label: string;
  pattern: RegExp;
}> = [
  {
    id: "measured_frequency",
    label: "Quantified frequency or share",
    pattern:
      /\b\d{1,3}(?:\.\d+)?\s*(?:%|per ?cent\b)|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:out\s+of|in)\s+(?:every\s+)?\d+\b/gi,
  },
  {
    id: "process_mining_metric",
    label: "Process-mining metric or artifact",
    pattern:
      /\b(?:event log|process mining|case frequency|case count|variant (?:frequency|coverage|analysis)|conformance (?:check(?:ing)?|rate|score)|fitness score|happy[- ]path coverage)\b/gi,
  },
  {
    id: "throughput",
    label: "Throughput or cycle-time claim",
    pattern:
      /\b(?:throughput|cycle time|lead time|takt time|processing rate|(?:cases|requests|tickets|orders|items)\s+per\s+(?:hour|day|week|month|year))\b/gi,
  },
  {
    id: "rework_rate",
    label: "Rate-of-failure claim",
    pattern:
      /\b(?:rework|error|failure|defect|escalation|rejection|exception)\s+rate\b|\bfirst[- ]pass yield\b|\bSLA (?:attainment|compliance|breach rate)\b/gi,
  },
  {
    id: "statistical_claim",
    label: "Statistical summary",
    // The quantity may sit on either side of the word, so both orders are
    // matched: "average cycle time is 3.2 days" and "3 days on average".
    pattern:
      /\b(?:median|p50|p90|p95|p99|standard deviation|percentile)\b|\b(?:average|mean)\b[^.]{0,40}?\d|\d[^.]{0,40}?\b(?:on average|average)\b/gi,
  },
  {
    id: "quantified_duration",
    label: "Quantified duration presented as fact",
    pattern:
      /\b(?:takes|took|lasts|lasted|runs for|completes? in|completed in|turnaround (?:time )?of|within)\s+(?:about|approximately|roughly|around|up to)?\s*\d+(?:\.\d+)?\s*(?:second|minute|hour|day|week|month|year)s?\b/gi,
  },
  {
    id: "measurement_claim",
    label: "Claim of measurement or instrumentation",
    pattern:
      /\b(?:we measured|measured at|instrumented|telemetry|system logs? (?:show|indicate)|the data (?:shows?|indicates?)|analytics (?:shows?|indicate))\b/gi,
  },
];

export type MeasuredLanguageMatch = {
  ruleId: string;
  label: string;
  match: string;
  /** Where in the artifact the phrase appeared. */
  location: string;
};

export function detectMeasuredLanguage(
  rawText: string,
  location = "text",
): MeasuredLanguageMatch[] {
  const matches: MeasuredLanguageMatch[] = [];
  // Scored on what the reader reads. The executive brief may carry `**bold**`,
  // and a marker dropped inside a phrase ("cycle **time** of 3 days") would
  // otherwise split it out of every pattern below.
  const text = stripEmphasisMarkers(rawText);
  for (const rule of MEASURED_LANGUAGE_RULES) {
    // A fresh RegExp per call keeps the shared `g` rules free of `lastIndex`
    // carry-over between artifacts.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const found of text.matchAll(pattern)) {
      matches.push({
        ruleId: rule.id,
        label: rule.label,
        match: found[0].trim(),
        location,
      });
    }
  }
  return matches;
}

export type MeasuredLanguageReport = {
  matches: MeasuredLanguageMatch[];
  passed: boolean;
};

export function scoreMeasuredLanguage(
  artifact: SummaryArtifactV2,
): MeasuredLanguageReport {
  const matches = [
    ...detectMeasuredLanguage(artifact.headline, "headline"),
    ...detectMeasuredLanguage(artifact.executiveBrief, "executiveBrief"),
  ];
  for (const { section, finding } of listArtifactFindings(artifact)) {
    matches.push(
      ...detectMeasuredLanguage(
        `${finding.title}\n${finding.body}`,
        `${section}:${finding.id}`,
      ),
    );
  }
  return { matches, passed: matches.length === 0 };
}

// --------------------------------------------------------------------------
// Gate 4: critical-fact recall
// --------------------------------------------------------------------------

function comparableText(value: string): string {
  return (
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.join(" ") ?? ""
  );
}

export type CriticalFactRecallReport = {
  expected: number;
  recalled: number;
  missing: string[];
  /** 1 when nothing was expected, so an empty expectation never fails a gate. */
  recallRate: number;
  passed: boolean;
};

/**
 * A critical fact is recalled when its comparable form appears anywhere the
 * reader can see it. Matching ignores punctuation, case, and whitespace so a
 * fact survives a normalizer that re-wraps or re-punctuates the sentence.
 */
export function scoreCriticalFactRecall(
  artifact: SummaryArtifactV2,
  criticalFacts: readonly string[],
): CriticalFactRecallReport {
  const haystack = comparableText(artifactText(artifact));
  const missing = criticalFacts.filter(
    (fact) => !haystack.includes(comparableText(fact)),
  );
  const recalled = criticalFacts.length - missing.length;
  return {
    expected: criticalFacts.length,
    recalled,
    missing,
    recallRate: criticalFacts.length === 0 ? 1 : recalled / criticalFacts.length,
    passed: missing.length === 0,
  };
}

// --------------------------------------------------------------------------
// Gate 5: coverage integrity
// --------------------------------------------------------------------------

export type CoverageIntegrityReport = {
  coverage: SummaryCoverage;
  violations: string[];
  passed: boolean;
};

export function scoreCoverageIntegrity(
  artifact: SummaryArtifactV2,
  snapshot?: {
    includedSources: number;
    totalEligibleSources: number;
    uniqueContributors?: number;
  },
): CoverageIntegrityReport {
  const coverage = artifact.coverage;
  const violations: string[] = [];

  if (!Number.isInteger(coverage.includedSources) || coverage.includedSources < 0) {
    violations.push(`includedSources is not a count: ${coverage.includedSources}`);
  }
  if (
    !Number.isInteger(coverage.totalEligibleSources) ||
    coverage.totalEligibleSources < 0
  ) {
    violations.push(
      `totalEligibleSources is not a count: ${coverage.totalEligibleSources}`,
    );
  }
  if (coverage.includedSources > coverage.totalEligibleSources) {
    violations.push(
      `includedSources ${coverage.includedSources} exceeds eligible ${coverage.totalEligibleSources}`,
    );
  }
  // `complete` is the claim the UI, PDF, and clipboard all repeat. It must
  // never be true while a source was left out.
  if (
    coverage.complete !==
    (coverage.includedSources === coverage.totalEligibleSources)
  ) {
    violations.push(
      `complete=${coverage.complete} with ${coverage.includedSources}/${coverage.totalEligibleSources} included`,
    );
  }
  if (
    coverage.uniqueContributors !== undefined &&
    coverage.uniqueContributors > coverage.includedSources
  ) {
    violations.push(
      `uniqueContributors ${coverage.uniqueContributors} exceeds included ${coverage.includedSources}`,
    );
  }

  if (snapshot) {
    if (coverage.includedSources !== snapshot.includedSources) {
      violations.push(
        `includedSources ${coverage.includedSources} does not match snapshot ${snapshot.includedSources}`,
      );
    }
    if (coverage.totalEligibleSources !== snapshot.totalEligibleSources) {
      violations.push(
        `totalEligibleSources ${coverage.totalEligibleSources} does not match snapshot ${snapshot.totalEligibleSources}`,
      );
    }
    if (
      snapshot.uniqueContributors !== undefined &&
      coverage.uniqueContributors !== undefined &&
      coverage.uniqueContributors !== snapshot.uniqueContributors
    ) {
      violations.push(
        `uniqueContributors ${coverage.uniqueContributors} does not match snapshot ${snapshot.uniqueContributors}`,
      );
    }
  }

  return { coverage, violations, passed: violations.length === 0 };
}

// --------------------------------------------------------------------------
// Composite release-gate report
// --------------------------------------------------------------------------

export type SummaryReleaseGateReport = {
  sourceValidity: SourceValidityReport;
  measuredLanguage: MeasuredLanguageReport;
  criticalFactRecall: CriticalFactRecallReport;
  coverageIntegrity: CoverageIntegrityReport;
  /** Short, human-readable reasons, ready for a runbook table or a log line. */
  failures: string[];
  passed: boolean;
};

export function evaluateSummaryArtifact(
  artifact: SummaryArtifactV2,
  options: {
    allowedSourceIdentities?: ReadonlySet<string>;
    criticalFacts?: readonly string[];
    snapshot?: {
      includedSources: number;
      totalEligibleSources: number;
      uniqueContributors?: number;
    };
  } = {},
): SummaryReleaseGateReport {
  const sourceValidity = scoreSourceValidity(artifact, {
    allowedSourceIdentities: options.allowedSourceIdentities,
  });
  const measuredLanguage = scoreMeasuredLanguage(artifact);
  const criticalFactRecall = scoreCriticalFactRecall(
    artifact,
    options.criticalFacts ?? [],
  );
  const coverageIntegrity = scoreCoverageIntegrity(artifact, options.snapshot);

  const failures: string[] = [];
  for (const violation of sourceValidity.violations) {
    failures.push(
      `${violation.code} in ${violation.section} "${violation.findingTitle}": ${violation.detail}`,
    );
  }
  for (const match of measuredLanguage.matches) {
    failures.push(
      `measured_language (${match.ruleId}) in ${match.location}: "${match.match}"`,
    );
  }
  for (const fact of criticalFactRecall.missing) {
    failures.push(`critical_fact_missing: "${fact}"`);
  }
  for (const violation of coverageIntegrity.violations) {
    failures.push(`coverage_integrity: ${violation}`);
  }

  return {
    sourceValidity,
    measuredLanguage,
    criticalFactRecall,
    coverageIntegrity,
    failures,
    passed: failures.length === 0,
  };
}
