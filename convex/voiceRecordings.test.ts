import { describe, expect, test } from "vitest";
import {
  coerceAnalysisPayload,
  normalizeScribeTranscript,
} from "./voiceRecordings";

describe("voice recording helpers", () => {
  test("normalizes Scribe word timestamps into transcript chunks", () => {
    const transcript = normalizeScribeTranscript({
      text: "Pull the report. Validate totals.",
      words: [
        { text: "Pull", start: 0, end: 0.2, type: "word" },
        { text: "the", start: 0.25, end: 0.4, type: "word" },
        { text: "report", start: 0.45, end: 0.8, type: "word" },
        { text: ".", start: 0.8, end: 0.85, type: "spacing" },
        { text: "[noise]", start: 0.9, end: 1.1, type: "audio_event" },
        { text: "Validate", start: 2, end: 2.3, type: "word" },
        { text: "totals", start: 2.35, end: 2.8, type: "word" },
        { text: ".", start: 2.8, end: 2.85, type: "spacing" },
      ],
    });

    expect(transcript).toEqual([
      {
        role: "user",
        content: "Pull the report. Validate totals.",
        time_in_call_secs: 0,
      },
    ]);
  });

  test("coerces analysis fields into the process-flow compatible shape", () => {
    const analysis = coerceAnalysisPayload(
      {
        transcript_summary: "Contributor described monthly payroll checks.",
        data_collection: {
          process_steps: [{ id: "pull-report", name: "Pull report" }],
          step_connections: "[]",
          step_issues: [{ step_id: "pull-report", is_bottleneck: false }],
          dependencies: "HRIS export",
          frequency: "Monthly",
        },
        success_evaluation: {
          described_specific_steps: true,
          mentioned_tools_or_systems: true,
          identified_dependencies: true,
        },
      },
      "Fallback",
    );

    expect(analysis.transcript_summary).toBe(
      "Contributor described monthly payroll checks.",
    );
    expect(JSON.parse(analysis.data_collection.process_steps)).toHaveLength(1);
    expect(JSON.parse(analysis.data_collection.step_connections)).toEqual([]);
    expect(JSON.parse(analysis.data_collection.step_issues)).toHaveLength(1);
    expect(analysis.data_collection.dependencies).toBe("HRIS export");
    expect(analysis.success_evaluation.identified_dependencies).toBe(true);
  });
});
