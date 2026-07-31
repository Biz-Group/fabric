import { describe, expect, test } from "vitest";
import {
  conversationTitle,
  normalizeSummaryTitle,
  summaryTitleFromAnalysis,
} from "./conversationTitle";

describe("normalizeSummaryTitle", () => {
  test("collapses whitespace and unwraps quotes", () => {
    expect(normalizeSummaryTitle('  "Monthly payroll\n  close"  ')).toBe(
      "Monthly payroll close",
    );
  });

  test("treats blank and non-string values as absent", () => {
    expect(normalizeSummaryTitle("   ")).toBeUndefined();
    expect(normalizeSummaryTitle(null)).toBeUndefined();
    expect(normalizeSummaryTitle(undefined)).toBeUndefined();
    expect(normalizeSummaryTitle(42)).toBeUndefined();
  });

  // A provider returning a paragraph would otherwise blow out the row layout.
  test("clips an overlong title at a word boundary", () => {
    const long = "Contributor walked through the payroll close ".repeat(10);
    const result = normalizeSummaryTitle(long)!;

    expect(result.length).toBeLessThanOrEqual(121);
    expect(result.endsWith("…")).toBe(true);
    expect(result).not.toMatch(/\s…$/);
  });
});

describe("summaryTitleFromAnalysis", () => {
  test("reads call_summary_title from a provider payload", () => {
    expect(
      summaryTitleFromAnalysis({
        call_summary_title: "Invoice approval routing",
        transcript_summary: "Long paragraph…",
      }),
    ).toBe("Invoice approval routing");
  });

  test("tolerates payloads without a title", () => {
    expect(summaryTitleFromAnalysis(null)).toBeUndefined();
    expect(summaryTitleFromAnalysis({})).toBeUndefined();
    expect(summaryTitleFromAnalysis({ call_summary_title: null })).toBeUndefined();
    expect(summaryTitleFromAnalysis("not an object")).toBeUndefined();
  });
});

describe("conversationTitle", () => {
  test("prefers the stored column", () => {
    expect(
      conversationTitle({
        title: "Stored title",
        analysis: { call_summary_title: "Analysis title" },
      }),
    ).toBe("Stored title");
  });

  // Rows written before the column existed, plus rows the tenant migration
  // copied, only carry the title inside the analysis blob.
  test("falls back to the analysis blob for legacy rows", () => {
    expect(
      conversationTitle({ analysis: { call_summary_title: "Analysis title" } }),
    ).toBe("Analysis title");
  });

  test("returns undefined when neither source has a title", () => {
    expect(conversationTitle({})).toBeUndefined();
    expect(conversationTitle({ title: "  ", analysis: {} })).toBeUndefined();
  });
});
