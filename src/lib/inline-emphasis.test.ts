import { describe, expect, it } from "vitest";
import { splitEmphasisRuns, stripEmphasisMarkers } from "./inline-emphasis";

describe("inline emphasis", () => {
  it("splits a brief into plain and emphasized runs", () => {
    expect(
      splitEmphasisRuns(
        "Training runs on **SuccessFactors** against a **40-hour** KPI.",
      ),
    ).toEqual([
      { text: "Training runs on ", emphasized: false },
      { text: "SuccessFactors", emphasized: true },
      { text: " against a ", emphasized: false },
      { text: "40-hour", emphasized: true },
      { text: " KPI.", emphasized: false },
    ]);
  });

  it("keeps text without emphasis in a single run", () => {
    expect(splitEmphasisRuns("Plain prose only.")).toEqual([
      { text: "Plain prose only.", emphasized: false },
    ]);
    expect(splitEmphasisRuns("")).toEqual([{ text: "", emphasized: false }]);
  });

  it("emphasizes adjacent spans independently", () => {
    expect(splitEmphasisRuns("**one** **two**")).toEqual([
      { text: "one", emphasized: true },
      { text: " ", emphasized: false },
      { text: "two", emphasized: true },
    ]);
  });

  it("leaves an unpaired marker as text instead of guessing a span", () => {
    expect(splitEmphasisRuns("Truncated **mid span")).toEqual([
      { text: "Truncated **mid span", emphasized: false },
    ]);
  });

  it("is stateless across calls", () => {
    const value = "**Vendor selection** is centralized.";
    expect(splitEmphasisRuns(value)).toEqual(splitEmphasisRuns(value));
  });

  it("strips markers for plain-text surfaces", () => {
    expect(
      stripEmphasisMarkers("Learning hours roll up from **five platforms**."),
    ).toBe("Learning hours roll up from five platforms.");
    expect(stripEmphasisMarkers("Truncated **mid span")).toBe(
      "Truncated mid span",
    );
  });
});
