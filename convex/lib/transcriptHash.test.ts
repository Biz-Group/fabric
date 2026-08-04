import { describe, expect, test } from "vitest";
import { hashTranscript } from "./transcriptHash";

const transcript = [
  { role: "user", content: "First we log the ticket", speakerName: "Alice" },
  { role: "ai", content: "And then?" },
];

describe("hashTranscript", () => {
  test("is stable for the same content", () => {
    expect(hashTranscript(transcript)).toBe(hashTranscript([...transcript]));
  });

  test("changes when the words change", () => {
    const edited = [
      { ...transcript[0], content: "First we log the request" },
      transcript[1],
    ];
    expect(hashTranscript(edited)).not.toBe(hashTranscript(transcript));
  });

  test("changes when a line is attributed to someone else", () => {
    // Relabelling a recording means the same words are now a different
    // person's account, which is a different piece of evidence.
    const relabelled = [
      { ...transcript[0], speakerName: "Blake" },
      transcript[1],
    ];
    expect(hashTranscript(relabelled)).not.toBe(hashTranscript(transcript));
  });

  test("distinguishes reordered lines", () => {
    const reordered = [transcript[1], transcript[0]];
    expect(hashTranscript(reordered)).not.toBe(hashTranscript(transcript));
  });

  test("treats missing and empty transcripts alike", () => {
    expect(hashTranscript(null)).toBe("empty");
    expect(hashTranscript(undefined)).toBe("empty");
    expect(hashTranscript([])).toBe("empty");
  });
});
