import { describe, expect, test } from "vitest";
import {
  buildProcessOverviewChunkRequest,
  buildProcessOverviewFinalRequest,
  finishSnapshotHash,
  initialSnapshotHashState,
  PROCESS_OVERVIEW_V2_SCHEMA,
  PROCESS_OVERVIEW_V2_TOOL_NAME,
  updateSnapshotHashState,
} from "./processOverviewV2";
import {
  SUMMARY_V2_AI_BUDGETS,
  SUMMARY_V2_CAPS,
} from "../summaryV2";

const EVIDENCE = {
  schemaVersion: "v2" as const,
  sourceMode: "interview_evidence" as const,
  steps: [{ id: "step-1", title: "Receive", body: "Receive the request." }],
  actors: ["Operations"],
  tools: ["Form"],
  handoffsAndDependencies: ["Finance approves"],
  reportedVariations: [],
  frictionPoints: [],
  uncertainties: [],
  transcriptHash: "hash-a",
  promptVersion: "summary-v2-conversation-evidence-v1",
  generatedAt: 1,
  provider: "fabric-foundry",
  model: "test-model",
};

const SOURCE = {
  key: "C1",
  conversationId: "conversation-1",
  label: "Contributor A",
  transcriptHash: "hash-a",
  promptVersion: "summary-v2-conversation-evidence-v1",
  evidence: EVIDENCE,
};

describe("process overview V2 contract", () => {
  test("defines only the seven owned overview fields with a strict schema", () => {
    expect(PROCESS_OVERVIEW_V2_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [
        "headline",
        "executiveBrief",
        "scope",
        "consensus",
        "variations",
        "gaps",
        "notable",
      ],
    });
    expect(Object.keys(PROCESS_OVERVIEW_V2_SCHEMA.properties as object)).toEqual(
      [
        "headline",
        "executiveBrief",
        "scope",
        "consensus",
        "variations",
        "gaps",
        "notable",
      ],
    );
  });

  test("locks deterministic chunk and final request budgets", () => {
    const chunk = buildProcessOverviewChunkRequest({
      processName: "Handle request",
      sources: [SOURCE],
    });
    const final = buildProcessOverviewFinalRequest({
      processName: "Handle request",
      directSources: [SOURCE],
    });
    expect(chunk).toMatchObject({
      temperature: 0,
      maxTokens: SUMMARY_V2_AI_BUDGETS.chunkReduce.maxTokens,
      timeoutMs: SUMMARY_V2_AI_BUDGETS.chunkReduce.timeoutMs,
      maxRetries: SUMMARY_V2_AI_BUDGETS.chunkReduce.maxRetries,
      tool: { name: PROCESS_OVERVIEW_V2_TOOL_NAME },
    });
    expect(final).toMatchObject({
      temperature: 0,
      maxTokens: SUMMARY_V2_AI_BUDGETS.finalReduce.maxTokens,
      timeoutMs: SUMMARY_V2_AI_BUDGETS.finalReduce.timeoutMs,
      maxRetries: SUMMARY_V2_AI_BUDGETS.finalReduce.maxRetries,
      tool: { name: PROCESS_OVERVIEW_V2_TOOL_NAME },
    });
    expect(chunk.user).toContain('"sourceKey":"C1"');
    expect(chunk.user).not.toContain("conversation-1");
  });

  test("snapshot hashing is ordered and includes every required cache field", () => {
    const first = updateSnapshotHashState(initialSnapshotHashState(), {
      conversationId: "a",
      transcriptHash: "hash-a",
      promptVersion: "prompt-a",
    });
    const baseline = finishSnapshotHash(
      updateSnapshotHashState(first, {
        conversationId: "b",
        transcriptHash: "hash-b",
        promptVersion: "prompt-b",
      }),
    );
    const repeat = finishSnapshotHash(
      updateSnapshotHashState(
        updateSnapshotHashState(initialSnapshotHashState(), {
          conversationId: "a",
          transcriptHash: "hash-a",
          promptVersion: "prompt-a",
        }),
        {
          conversationId: "b",
          transcriptHash: "hash-b",
          promptVersion: "prompt-b",
        },
      ),
    );
    expect(repeat).toBe(baseline);
    expect(
      finishSnapshotHash(
        updateSnapshotHashState(first, {
          conversationId: "b",
          transcriptHash: "changed",
          promptVersion: "prompt-b",
        }),
      ),
    ).not.toBe(baseline);
    expect(
      finishSnapshotHash(
        updateSnapshotHashState(first, {
          conversationId: "b",
          transcriptHash: "hash-b",
          promptVersion: "changed",
        }),
      ),
    ).not.toBe(baseline);
    expect(
      finishSnapshotHash(
        updateSnapshotHashState(initialSnapshotHashState(), {
          conversationId: "b",
          transcriptHash: "hash-b",
          promptVersion: "prompt-b",
        }),
      ),
    ).not.toBe(baseline);
  });

  test("schema caps align with persisted artifact caps", () => {
    const properties = PROCESS_OVERVIEW_V2_SCHEMA.properties as Record<
      string,
      { maxItems?: number }
    >;
    expect(properties.scope.maxItems).toBe(SUMMARY_V2_CAPS.findingGroup);
    for (const key of ["consensus", "variations", "gaps", "notable"]) {
      expect(properties[key].maxItems).toBe(SUMMARY_V2_CAPS.findingGroup);
    }
  });
});
