import { describe, expect, test } from "vitest";
import { extractDataCollection } from "./conversationAnalysis";

/**
 * The envelope shape ElevenLabs actually returns, trimmed to the fields that
 * matter. Copied from a real agent conversation rather than invented: the bug
 * this guards against was reading `data_collection` on a payload that only ever
 * had `data_collection_results`, so a fixture that drifts toward the convenient
 * shape would stop testing anything.
 */
function envelope(id: string, value: unknown) {
  return {
    data_collection_id: id,
    json_schema: {
      description: `Extract ${id}`,
      type: "string",
      enum: null,
      is_omitted: false,
    },
    rationale: `The contributor described ${id}.`,
    value,
  };
}

const PROCESS_STEPS = JSON.stringify([
  { id: "identify-critical-roles", name: "Identify critical roles", type: "action" },
  { id: "determine-readiness", name: "Determine readiness", type: "decision" },
]);

const AGENT_ANALYSIS = {
  call_summary_title: "Succession Planning Process",
  transcript_summary: "The contributor walked through succession planning.",
  data_collection_results: {
    process_steps: envelope("process_steps", PROCESS_STEPS),
    step_connections: envelope(
      "step_connections",
      '[{"from":"identify-critical-roles","to":"determine-readiness"}]',
    ),
    dependencies: envelope("dependencies", "Organization Development team"),
    frequency: envelope("frequency", "quarterly"),
    // ElevenLabs' three ways of saying "nothing found", one per declared type.
    compliance_or_approvals: envelope("compliance_or_approvals", "null"),
    edge_cases: envelope("edge_cases", null),
    total_process_duration: envelope("total_process_duration", ""),
  },
};

describe("extractDataCollection", () => {
  test("unwraps the ElevenLabs keyed envelopes an agent conversation carries", () => {
    const dc = extractDataCollection(AGENT_ANALYSIS);

    expect(dc).not.toBeNull();
    expect(dc?.process_steps).toBe(PROCESS_STEPS);
    expect(dc?.dependencies).toBe("Organization Development team");
    expect(dc?.frequency).toBe("quarterly");
  });

  test("drops the three spellings of absent rather than forwarding them", () => {
    const dc = extractDataCollection(AGENT_ANALYSIS);

    // A literal "null" reaching a prompt reads as content, which is worse than
    // an omitted key — the flow's evidence block tests each field for truthiness.
    expect(dc).not.toHaveProperty("compliance_or_approvals");
    expect(dc).not.toHaveProperty("edge_cases");
    expect(dc).not.toHaveProperty("total_process_duration");
  });

  test("passes Fabric's own flat analysis through untouched", () => {
    // Voice recordings and uploads are analysed by Fabric and already coerced.
    const flat = {
      data_collection: {
        process_steps: PROCESS_STEPS,
        dependencies: "Talent team",
      },
    };

    expect(extractDataCollection(flat)).toEqual(flat.data_collection);
  });

  test("prefers the flat shape when a payload somehow carries both", () => {
    const both = {
      data_collection: { process_steps: "[]", frequency: "daily" },
      data_collection_results: {
        frequency: envelope("frequency", "quarterly"),
      },
    };

    expect(extractDataCollection(both)?.frequency).toBe("daily");
  });

  test("reads the list form when only that is populated", () => {
    // ElevenLabs returns both the keyed map and the list, and has changed which
    // one it fills before now.
    const listOnly = {
      data_collection_results_list: [
        envelope("process_steps", PROCESS_STEPS),
        envelope("frequency", "monthly"),
        envelope("edge_cases", null),
      ],
    };

    const dc = extractDataCollection(listOnly);
    expect(dc?.process_steps).toBe(PROCESS_STEPS);
    expect(dc?.frequency).toBe("monthly");
    expect(dc).not.toHaveProperty("edge_cases");
  });

  test("reports genuinely empty extraction as null, not as an empty object", () => {
    // Callers render null as an explicit gap in the evidence, so "nothing was
    // extracted" must not arrive looking like a populated record.
    expect(
      extractDataCollection({
        data_collection_results: {
          process_steps: envelope("process_steps", null),
          frequency: envelope("frequency", "null"),
        },
      }),
    ).toBeNull();
  });

  test("survives a missing, empty, or wrongly typed analysis", () => {
    expect(extractDataCollection(null)).toBeNull();
    expect(extractDataCollection(undefined)).toBeNull();
    expect(extractDataCollection({})).toBeNull();
    expect(extractDataCollection("not an object")).toBeNull();
    expect(extractDataCollection({ data_collection: [] })).toBeNull();
    expect(
      extractDataCollection({ data_collection_results: "unexpected" }),
    ).toBeNull();
  });
});
