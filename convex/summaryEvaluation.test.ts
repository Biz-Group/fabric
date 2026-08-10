import { describe, expect, test } from "vitest";
import type { Id } from "./_generated/dataModel";
import {
  detectMeasuredLanguage,
  evaluateSummaryArtifact,
  listArtifactFindings,
  MEASURED_LANGUAGE_RULES,
  scoreCoverageIntegrity,
  scoreCriticalFactRecall,
  scoreMeasuredLanguage,
  scoreSourceValidity,
  summarySourceIdentity,
} from "./lib/summaryEvaluation";
import {
  normalizeDepartmentOverviewArtifactV2,
  normalizeFunctionOverviewArtifactV2,
  normalizeProcessOverviewArtifactV2,
  SUMMARY_V2_CAPS,
  SUMMARY_V2_PROMPT_VERSIONS,
  type ProcessOverviewArtifactV2,
  type SummaryArtifactV2,
  type SummaryCoverage,
  type SummaryNormalizationContext,
  type SummarySourceKeyMap,
} from "./summaryV2";
import {
  malformedSourceKeysFixture,
  measuredLanguageRejectionFixture,
  overFiftyConversationsFixture,
  overlappingAccountsFixture,
  sourceKeyMapForFixture,
  summaryV2BaselineFixtures,
  summaryV2GoldenSetExtensionFixtures,
  summaryV2ScenarioFixtures,
  unevenRollupCoverageFixture,
  type SummaryV2ScenarioFixture,
} from "./testFixtures/summaryV2";
import { PROCESS_OVERVIEW_SYSTEM_PROMPT } from "./lib/processOverviewV2";
import { HIERARCHY_OVERVIEW_SYSTEM_PROMPT } from "./lib/hierarchyOverviewV2";

function sourceMapFor(fixture: SummaryV2ScenarioFixture): SummarySourceKeyMap {
  return sourceKeyMapForFixture(fixture) as unknown as SummarySourceKeyMap;
}

function coverageFor(fixture: SummaryV2ScenarioFixture): SummaryCoverage {
  const declared = fixture.evaluation?.coverage;
  const includedSources = declared?.includedSources ?? fixture.sources.length;
  const totalEligibleSources =
    declared?.totalEligibleSources ?? fixture.sources.length;
  return {
    includedSources,
    totalEligibleSources,
    ...(declared?.uniqueContributors === undefined
      ? {}
      : { uniqueContributors: declared.uniqueContributors }),
    complete: includedSources === totalEligibleSources,
  };
}

function contextFor(
  fixture: SummaryV2ScenarioFixture,
  promptVersion = SUMMARY_V2_PROMPT_VERSIONS.processOverview,
): SummaryNormalizationContext {
  return {
    sourceByKey: sourceMapFor(fixture),
    coverage: coverageFor(fixture),
    provenance: {
      sourceSnapshotHash: `sha256:${fixture.id}`,
      generatedAt: 1_786_000_000_000,
      promptVersion,
      provider: "fabric-foundry",
      model: "test-model",
    },
  };
}

function allowedIdentities(fixture: SummaryV2ScenarioFixture): Set<string> {
  return new Set(
    Object.values(sourceKeyMapForFixture(fixture)).map((source) =>
      summarySourceIdentity(source as never),
    ),
  );
}

/** Normalizes a fixture the way the pipeline would, for scoring. */
function normalizeFixture(
  fixture: SummaryV2ScenarioFixture,
): SummaryArtifactV2[] {
  const context = contextFor(fixture);
  const payload = fixture.payload;
  if ("department" in payload || "function" in payload) {
    const artifacts: SummaryArtifactV2[] = [];
    if (payload.department) {
      const department = normalizeDepartmentOverviewArtifactV2(
        payload.department,
        { ...context, ...{} },
      );
      expect(department).not.toBeNull();
      artifacts.push(department!);
    }
    if (payload.function) {
      const fn = normalizeFunctionOverviewArtifactV2(payload.function, context);
      expect(fn).not.toBeNull();
      artifacts.push(fn!);
    }
    return artifacts;
  }
  const process = normalizeProcessOverviewArtifactV2(payload, context);
  expect(process).not.toBeNull();
  return [process!];
}

describe("golden set composition", () => {
  test("keeps the Phase 0 baseline frozen and adds the reference-plan scenarios", () => {
    expect(summaryV2BaselineFixtures.map((fixture) => fixture.id)).toEqual([
      "one-contributor",
      "agreeing-contributors",
      "contradicting-contributors",
      "explicit-uncertainty",
      "long-process",
      "stale-rollup",
    ]);
    expect(
      summaryV2GoldenSetExtensionFixtures.map((fixture) => fixture.id),
    ).toEqual([
      "overlapping-accounts",
      "over-fifty-conversations",
      "malformed-source-keys",
      "uneven-rollup-coverage",
      "measured-language-rejection",
    ]);
    expect(summaryV2ScenarioFixtures).toHaveLength(11);
  });

  test("every fixture stays synthetic and tenant-neutral", () => {
    const serialized = JSON.stringify(summaryV2ScenarioFixtures);
    expect(serialized).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
    expect(serialized).not.toMatch(/org_[A-Za-z0-9]/);
    expect(serialized).not.toMatch(/\bclerk\b/i);
  });

  test("the over-fifty fixture exceeds the retired 50-source cap", () => {
    expect(overFiftyConversationsFixture.sources.length).toBeGreaterThan(50);
    expect(
      Math.ceil(
        overFiftyConversationsFixture.sources.length /
          SUMMARY_V2_CAPS.reduceChunkSources,
      ),
    ).toBe(3);
  });
});

describe("release gate: every factual finding has a valid in-scope source", () => {
  test.each(
    summaryV2ScenarioFixtures.map((fixture) => [fixture.id, fixture] as const),
  )("%s", (_id, fixture) => {
    for (const artifact of normalizeFixture(fixture)) {
      const report = scoreSourceValidity(artifact, {
        allowedSourceIdentities: allowedIdentities(fixture),
      });
      expect(report.violations).toEqual([]);
      expect(report.supportedFactualFindings).toBe(report.factualFindings);
    }
  });

  test("an invented source key is reported rather than silently resolved", () => {
    const artifact = normalizeFixture(malformedSourceKeysFixture)[0];
    const findingTitles = listArtifactFindings(artifact).map(
      ({ finding }) => finding.title,
    );
    for (const rejected of malformedSourceKeysFixture.evaluation
      ?.rejectedFindingTitles ?? []) {
      expect(findingTitles).not.toContain(rejected);
    }
    expect(findingTitles).toHaveLength(
      malformedSourceKeysFixture.expected.acceptedFindings as number,
    );
    // Every surviving source came from the supplied map, so no invented key
    // reached the artifact.
    const allowed = allowedIdentities(malformedSourceKeysFixture);
    for (const { finding } of listArtifactFindings(artifact)) {
      for (const source of finding.sources) {
        expect(allowed.has(summarySourceIdentity(source))).toBe(true);
      }
    }
  });

  test("a source outside the entity's own snapshot fails the gate", () => {
    const artifact = normalizeFixture(overlappingAccountsFixture)[0];
    const report = scoreSourceValidity(artifact, {
      allowedSourceIdentities: new Set<string>(),
    });
    expect(report.passed).toBe(false);
    expect(
      report.violations.every(
        (violation) => violation.code === "source_outside_snapshot",
      ),
    ).toBe(true);
  });

  test("a hand-built unsupported factual finding is caught", () => {
    const artifact: ProcessOverviewArtifactV2 = {
      ...(normalizeFixture(overlappingAccountsFixture)[0] as ProcessOverviewArtifactV2),
      notable: [
        {
          id: "notable-hand-built",
          title: "A manager approves every request",
          body: "Stated as fact with no source at all.",
          evidenceLevel: "single_source",
          supportCount: 0,
          sources: [],
        },
      ],
    };
    const report = scoreSourceValidity(artifact);
    expect(report.passed).toBe(false);
    expect(report.violations.map((violation) => violation.code)).toContain(
      "factual_finding_without_source",
    );
  });

  test("a corroborated label on a single source is caught", () => {
    const base = normalizeFixture(
      overlappingAccountsFixture,
    )[0] as ProcessOverviewArtifactV2;
    const single = base.variations[0];
    const artifact: ProcessOverviewArtifactV2 = {
      ...base,
      variations: [{ ...single, evidenceLevel: "corroborated" }],
    };
    expect(
      scoreSourceValidity(artifact).violations.map(
        (violation) => violation.code,
      ),
    ).toContain("evidence_level_mismatch");
  });
});

describe("release gate: no unsupported measured language", () => {
  test.each(
    summaryV2ScenarioFixtures
      .filter((fixture) => !fixture.evaluation?.expectsMeasuredLanguage)
      .map((fixture) => [fixture.id, fixture] as const),
  )("%s is free of measured process-mining language", (_id, fixture) => {
    for (const artifact of normalizeFixture(fixture)) {
      expect(scoreMeasuredLanguage(artifact).matches).toEqual([]);
    }
  });

  test("the negative control trips every measured-language family", () => {
    const artifact = normalizeFixture(measuredLanguageRejectionFixture)[0];
    const report = scoreMeasuredLanguage(artifact);
    expect(report.passed).toBe(false);
    const tripped = new Set(report.matches.map((match) => match.ruleId));
    expect(tripped).toContain("measured_frequency");
    expect(tripped).toContain("process_mining_metric");
    expect(tripped).toContain("throughput");
    expect(tripped).toContain("rework_rate");
    expect(tripped).toContain("statistical_claim");
  });

  test("reported hedges and unquantified accounts stay clean", () => {
    for (const phrase of [
      "Most requests are acknowledged the same working day.",
      "Contributors usually route urgent work straight to the team lead.",
      "It takes a couple of days when the approver is away.",
      "One contributor described a credit hold; two did not.",
      "Two of four processes are current in this rollup.",
      "The team means to document the final sign-off.",
    ]) {
      expect(detectMeasuredLanguage(phrase)).toEqual([]);
    }
  });

  test("quantified measurement claims are caught in every family", () => {
    const cases: Array<[string, string]> = [
      ["measured_frequency", "38% of cases are reworked."],
      ["measured_frequency", "Three out of every 10 requests are escalated."],
      ["process_mining_metric", "The event log shows two variants."],
      ["throughput", "Cycle time held steady last quarter."],
      ["throughput", "The team clears 40 requests per day."],
      ["rework_rate", "The rework rate is stable."],
      ["statistical_claim", "The median approval finished sooner."],
      ["statistical_claim", "Approvals clear in 3 days on average."],
      ["quantified_duration", "Review takes 2 hours."],
      ["measurement_claim", "Telemetry confirms the handoff."],
    ];
    for (const [ruleId, phrase] of cases) {
      const matches = detectMeasuredLanguage(phrase);
      expect(
        matches.map((match) => match.ruleId),
        `${ruleId} should fire on: ${phrase}`,
      ).toContain(ruleId);
    }
  });

  test("rules are stateless across calls", () => {
    const phrase = "38% of cases are reworked.";
    expect(detectMeasuredLanguage(phrase)).toEqual(
      detectMeasuredLanguage(phrase),
    );
    expect(MEASURED_LANGUAGE_RULES.every((rule) => rule.pattern.global)).toBe(
      true,
    );
  });

  test("every generation prompt forbids measured language up front", () => {
    for (const prompt of [
      PROCESS_OVERVIEW_SYSTEM_PROMPT,
      // Departments and functions share one hierarchy prompt.
      HIERARCHY_OVERVIEW_SYSTEM_PROMPT,
    ]) {
      expect(prompt).toMatch(/measured/i);
      expect(prompt).toMatch(/frequency/i);
      expect(prompt).toMatch(/throughput/i);
      expect(prompt).toMatch(/conformance/i);
    }
  });
});

describe("release gate: no critical labelled fact is lost", () => {
  test.each(
    summaryV2ScenarioFixtures
      .filter((fixture) => (fixture.evaluation?.criticalFacts ?? []).length > 0)
      .map((fixture) => [fixture.id, fixture] as const),
  )("%s retains every critical fact", (_id, fixture) => {
    const facts = fixture.evaluation?.criticalFacts ?? [];
    const artifacts = normalizeFixture(fixture);
    // A rollup fixture spreads its facts over two artifacts, so a fact counts
    // as recalled when any artifact in the scenario carries it.
    const missing = facts.filter((fact) =>
      artifacts.every(
        (artifact) => !scoreCriticalFactRecall(artifact, [fact]).passed,
      ),
    );
    expect(missing).toEqual([]);
  });

  test("recall matching ignores case, punctuation, and rewrapping", () => {
    const artifact = normalizeFixture(overlappingAccountsFixture)[0];
    expect(
      scoreCriticalFactRecall(artifact, ["SHARED   request-queue!"]).passed,
    ).toBe(true);
    const dropped = scoreCriticalFactRecall(artifact, [
      "a fact that was never written",
    ]);
    expect(dropped.passed).toBe(false);
    expect(dropped.recallRate).toBe(0);
  });

  test("an empty expectation never fails the gate", () => {
    const artifact = normalizeFixture(overlappingAccountsFixture)[0];
    const report = scoreCriticalFactRecall(artifact, []);
    expect(report.passed).toBe(true);
    expect(report.recallRate).toBe(1);
  });
});

describe("release gate: coverage counts match the source snapshot", () => {
  test.each(
    summaryV2ScenarioFixtures.map((fixture) => [fixture.id, fixture] as const),
  )("%s reports coverage consistent with its snapshot", (_id, fixture) => {
    const snapshot = coverageFor(fixture);
    for (const artifact of normalizeFixture(fixture)) {
      const report = scoreCoverageIntegrity(artifact, {
        includedSources: snapshot.includedSources,
        totalEligibleSources: snapshot.totalEligibleSources,
        ...(snapshot.uniqueContributors === undefined
          ? {}
          : { uniqueContributors: snapshot.uniqueContributors }),
      });
      expect(report.violations).toEqual([]);
    }
  });

  test("uneven rollups never claim complete coverage", () => {
    for (const artifact of normalizeFixture(unevenRollupCoverageFixture)) {
      expect(artifact.coverage.complete).toBe(false);
      expect(artifact.coverage.includedSources).toBeLessThan(
        artifact.coverage.totalEligibleSources,
      );
      expect(scoreCoverageIntegrity(artifact).passed).toBe(true);
    }
  });

  test("a complete claim over partial coverage fails", () => {
    const base = normalizeFixture(
      overlappingAccountsFixture,
    )[0] as ProcessOverviewArtifactV2;
    const artifact: ProcessOverviewArtifactV2 = {
      ...base,
      coverage: { ...base.coverage, includedSources: 2, complete: true },
    };
    const report = scoreCoverageIntegrity(artifact);
    expect(report.passed).toBe(false);
    expect(report.violations.join(" ")).toContain("complete=true");
  });

  test("coverage drifting from the snapshot fails", () => {
    const artifact = normalizeFixture(overFiftyConversationsFixture)[0];
    expect(artifact.coverage.includedSources).toBe(52);
    const report = scoreCoverageIntegrity(artifact, {
      includedSources: 51,
      totalEligibleSources: 52,
    });
    expect(report.passed).toBe(false);
    expect(report.violations.join(" ")).toContain("does not match snapshot");
  });
});

describe("composite release-gate report", () => {
  test("every golden scenario except the negative control passes all gates", () => {
    for (const fixture of summaryV2ScenarioFixtures) {
      const snapshot = coverageFor(fixture);
      for (const artifact of normalizeFixture(fixture)) {
        const report = evaluateSummaryArtifact(artifact, {
          allowedSourceIdentities: allowedIdentities(fixture),
          snapshot: {
            includedSources: snapshot.includedSources,
            totalEligibleSources: snapshot.totalEligibleSources,
          },
        });
        if (fixture.evaluation?.expectsMeasuredLanguage) {
          expect(report.passed, fixture.id).toBe(false);
          expect(
            report.failures.some((failure) =>
              failure.startsWith("measured_language"),
            ),
            fixture.id,
          ).toBe(true);
          // The only failing gate is measured language: sources, coverage, and
          // recall are all sound in this fixture.
          expect(report.sourceValidity.passed, fixture.id).toBe(true);
          expect(report.coverageIntegrity.passed, fixture.id).toBe(true);
        } else {
          expect(report.failures, fixture.id).toEqual([]);
          expect(report.passed, fixture.id).toBe(true);
        }
      }
    }
  });

  test("failures read as actionable one-line reasons", () => {
    const artifact = normalizeFixture(measuredLanguageRejectionFixture)[0];
    const report = evaluateSummaryArtifact(artifact, {
      criticalFacts: ["a fact nobody wrote"],
    });
    expect(report.failures.length).toBeGreaterThan(1);
    expect(report.failures).toContain(
      'critical_fact_missing: "a fact nobody wrote"',
    );
    for (const failure of report.failures) {
      expect(failure.length).toBeLessThan(400);
    }
  });

  test("scoring is deterministic for one artifact", () => {
    const artifact = normalizeFixture(overlappingAccountsFixture)[0];
    expect(JSON.stringify(evaluateSummaryArtifact(artifact))).toBe(
      JSON.stringify(evaluateSummaryArtifact(artifact)),
    );
  });

  test("a conversation source keeps its typed identity", () => {
    expect(
      summarySourceIdentity({
        kind: "conversation",
        conversationId: "conversation-1" as Id<"conversations">,
        label: "Contributor A",
      }),
    ).toBe("conversation:conversation-1");
  });
});
