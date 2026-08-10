import { describe, expect, test } from "vitest";
import {
  buildDepartmentOverviewRequest,
  buildFunctionOverviewRequest,
  classifyHierarchyChild,
  DEPARTMENT_OVERVIEW_V2_SCHEMA,
  DEPARTMENT_OVERVIEW_V2_TOOL,
  finishHierarchySnapshotHash,
  FUNCTION_OVERVIEW_V2_SCHEMA,
  FUNCTION_OVERVIEW_V2_TOOL,
  initialHierarchySnapshotHashState,
  updateHierarchySnapshotHashState,
} from "./hierarchyOverviewV2";
import {
  SUMMARY_V2_AI_BUDGETS,
  SUMMARY_V2_PROMPT_VERSIONS,
  type DepartmentOverviewArtifactV2,
  type ProcessOverviewArtifactV2,
} from "../summaryV2";

const provenance = {
  sourceSnapshotHash: "snapshot",
  generatedAt: 1,
  promptVersion: SUMMARY_V2_PROMPT_VERSIONS.processOverview,
  provider: "test",
  model: "test",
};

const processArtifact: ProcessOverviewArtifactV2 = {
  schemaVersion: "v2",
  sourceMode: "interview_evidence",
  headline: "Request handling",
  executiveBrief: "Requests are checked and approved.",
  scope: [],
  consensus: [],
  variations: [],
  gaps: [],
  notable: [],
  coverage: {
    includedSources: 1,
    totalEligibleSources: 1,
    uniqueContributors: 1,
    complete: true,
  },
  provenance,
};

const departmentArtifact: DepartmentOverviewArtifactV2 = {
  schemaVersion: "v2",
  sourceMode: "interview_evidence",
  headline: "Service operations",
  executiveBrief: "Service teams coordinate request handling.",
  crossProcessDependencies: [],
  sharedPatterns: [],
  variationsAndTensions: [],
  gaps: [],
  notable: [],
  coverage: { includedSources: 1, totalEligibleSources: 1, complete: true },
  provenance: {
    ...provenance,
    promptVersion: SUMMARY_V2_PROMPT_VERSIONS.departmentOverview,
  },
};

describe("Hierarchy Overview V2 contracts", () => {
  test("department and function schemas expose only their owned fields", () => {
    expect(DEPARTMENT_OVERVIEW_V2_SCHEMA.additionalProperties).toBe(false);
    expect(Object.keys(DEPARTMENT_OVERVIEW_V2_SCHEMA.properties ?? {})).toEqual([
      "headline",
      "executiveBrief",
      "crossProcessDependencies",
      "sharedPatterns",
      "variationsAndTensions",
      "gaps",
      "notable",
    ]);
    expect(FUNCTION_OVERVIEW_V2_SCHEMA.additionalProperties).toBe(false);
    expect(Object.keys(FUNCTION_OVERVIEW_V2_SCHEMA.properties ?? {})).toEqual([
      "headline",
      "executiveBrief",
      "crossDepartmentDependencies",
      "strategicPatterns",
      "variationsAndTensions",
      "gaps",
      "notable",
    ]);
  });

  test("both final reducers use the locked deterministic budget", () => {
    const department = buildDepartmentOverviewRequest({
      departmentName: "Service",
      sources: [
        { key: "P1", label: "Handle request", state: "current", artifact: processArtifact },
      ],
    });
    const fn = buildFunctionOverviewRequest({
      functionName: "Operations",
      sources: [
        { key: "D1", label: "Service", state: "current", artifact: departmentArtifact },
      ],
    });
    for (const [request, toolName] of [
      [department, DEPARTMENT_OVERVIEW_V2_TOOL],
      [fn, FUNCTION_OVERVIEW_V2_TOOL],
    ] as const) {
      expect(request).toMatchObject({
        maxTokens: SUMMARY_V2_AI_BUDGETS.finalReduce.maxTokens,
        timeoutMs: SUMMARY_V2_AI_BUDGETS.finalReduce.timeoutMs,
        maxRetries: SUMMARY_V2_AI_BUDGETS.finalReduce.maxRetries,
        temperature: 0,
        tool: { name: toolName },
      });
    }
  });

  test("prompt projections never expose persisted source IDs", () => {
    const sensitiveId = "process_database_id_must_not_leave_fabric";
    const artifact: ProcessOverviewArtifactV2 = {
      ...processArtifact,
      notable: [
        {
          id: "finding",
          title: "Manual check",
          body: "A manual check is reported.",
          evidenceLevel: "single_source",
          supportCount: 1,
          sources: [
            {
              kind: "conversation",
              conversationId: sensitiveId as never,
              label: "Contributor",
            },
          ],
        },
      ],
    };
    const request = buildDepartmentOverviewRequest({
      departmentName: "Service",
      sources: [
        { key: "P1", label: "Handle request", state: "current", artifact },
      ],
    });
    expect(request.user).not.toContain(sensitiveId);
    expect(request.user).toContain("P1");
  });

  test("snapshots change with child identity, label, state, artifact, and order", () => {
    const source = {
      childId: "child-1",
      label: "Service",
      state: "current",
      artifactSnapshotHash: "artifact-1",
      artifactPromptVersion: "prompt-1",
      artifactGeneratedAt: 1,
    };
    const hash = (sources: typeof source[]) => {
      let state = initialHierarchySnapshotHashState();
      for (const item of sources) {
        state = updateHierarchySnapshotHashState(state, item);
      }
      return finishHierarchySnapshotHash(state);
    };
    const baseline = hash([source]);
    for (const changed of [
      { ...source, childId: "child-2" },
      { ...source, label: "Renamed" },
      { ...source, state: "stale" },
      { ...source, artifactSnapshotHash: "artifact-2" },
      { ...source, artifactPromptVersion: "prompt-2" },
      { ...source, artifactGeneratedAt: 2 },
    ]) {
      expect(hash([changed])).not.toBe(baseline);
    }
    expect(hash([source, { ...source, childId: "child-2" }])).not.toBe(
      hash([{ ...source, childId: "child-2" }, source]),
    );
  });

  test("child classification distinguishes refresh, partial, stale, missing, and failure", () => {
    expect(classifyHierarchyChild({ hasArtifact: true, refreshing: true })).toBe(
      "refreshing",
    );
    expect(
      classifyHierarchyChild({ hasArtifact: true, artifactComplete: false }),
    ).toBe("partial");
    expect(
      classifyHierarchyChild({
        hasArtifact: true,
        sourceRevisionMatches: false,
      }),
    ).toBe("stale");
    expect(classifyHierarchyChild({ hasArtifact: false })).toBe("missing");
    expect(
      classifyHierarchyChild({ hasArtifact: false, lastRunFailed: true }),
    ).toBe("failed");
  });
});
