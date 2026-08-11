import { describe, expect, it } from "vitest";
import {
  evidenceStrengthLabel,
  legacyPreviewText,
  OVERVIEW_STATE_META,
  overviewActionHint,
  overviewCopyText,
  overviewProgressText,
  overviewStatusDetail,
  refreshActionLabel,
  refreshUnavailableReason,
  surfaceReadinessLabel,
} from "./overview-view-model";

describe("overview presentation rules", () => {
  it("defines a visible label and explanation for every lifecycle state", () => {
    expect(Object.keys(OVERVIEW_STATE_META)).toEqual([
      "missing",
      "current",
      "stale",
      "refreshing",
      "partial",
      "failed",
    ]);

    for (const meta of Object.values(OVERVIEW_STATE_META)) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(20);
    }
  });

  it("uses non-numeric labels for evidence strength", () => {
    expect(evidenceStrengthLabel("corroborated", 2)).toBe(
      "Corroborated · 2 sources",
    );
    expect(evidenceStrengthLabel("single_source", 1)).toBe("Single source");
    expect(evidenceStrengthLabel("inferred_gap", 0)).toBe("Evidence gap");
  });

  it("keeps Flow and Insights status descriptive and navigation-only", () => {
    expect(surfaceReadinessLabel(null)).toBe("Not available");
    expect(
      surfaceReadinessLabel({
        available: true,
        stale: false,
        generationStatus: "ready",
      }),
    ).toBe("Ready");
    expect(
      surfaceReadinessLabel({
        available: true,
        stale: true,
        generationStatus: "ready",
      }),
    ).toBe("New evidence available");
    expect(
      surfaceReadinessLabel({
        available: false,
        stale: false,
        generationStatus: "generating",
      }),
    ).toBe("Generating");
  });

  it("tells the reader who can act on a state that needs a human", () => {
    expect(overviewActionHint("stale", true)).toBe(
      "Rebuild the overview when you are ready.",
    );
    expect(overviewActionHint("stale", false)).toBe(
      "A contributor or admin can rebuild the overview.",
    );
    expect(overviewActionHint("missing", true)).toBe(
      "Build the overview when you are ready.",
    );
    // Nothing to prompt for while work is running, done, or already failed with
    // its own retry guidance.
    expect(overviewActionHint("current", true)).toBeNull();
    expect(overviewActionHint("refreshing", true)).toBeNull();
    expect(overviewActionHint("failed", true)).toBeNull();
  });

  it("discloses a status explanation only for states a reader can act on", () => {
    expect(
      overviewStatusDetail("partial", { completed: 1, total: 1 }, "processes", true),
    ).toBe(
      "The overview is useful, but not every eligible source was included. 1 of 1 processes complete. Rebuild the overview when you are ready.",
    );
    expect(overviewStatusDetail("stale", null, undefined, false)).toBe(
      "New evidence has been recorded since this overview was generated. The previous overview is shown until it is rebuilt. A contributor or admin can rebuild the overview.",
    );
    // Current and refreshing explain themselves; failed keeps its own visible
    // alert rather than hiding an error behind a chip.
    expect(overviewStatusDetail("current", null, undefined, true)).toBeNull();
    expect(overviewStatusDetail("refreshing", null, undefined, true)).toBeNull();
    expect(overviewStatusDetail("failed", null, undefined, true)).toBeNull();
  });

  it("formats rollup progress against the unit being rolled up", () => {
    expect(overviewProgressText({ completed: 2, total: 4 }, "processes")).toBe(
      "2 of 4 processes complete",
    );
    expect(overviewProgressText({ completed: 3, total: 4 })).toBe(
      "3 of 4 complete",
    );
    expect(overviewProgressText({ completed: 9, total: 4 })).toBe(
      "4 of 4 complete",
    );
    expect(overviewProgressText(null)).toBeNull();
  });

  it("chooses an action label from state and content availability", () => {
    expect(refreshActionLabel("missing", false)).toBe("Build overview");
    expect(refreshActionLabel("refreshing", true)).toBe("Refreshing");
    expect(refreshActionLabel("stale", true)).toBe("Refresh overview");
    expect(refreshActionLabel("current", true)).toBe("Rebuild overview");
  });

  it("explains an inert rebuild instead of leaving a dead control", () => {
    const reason = refreshUnavailableReason("current", false);

    expect(reason).toContain("already covers every source available to it");
    expect(reason).toContain("Rebuild becomes available");
    // A live control needs no excuse, and a refreshing one is hidden already.
    expect(refreshUnavailableReason("current", true)).toBeNull();
    expect(refreshUnavailableReason("stale", true)).toBeNull();
    expect(refreshUnavailableReason("refreshing", false)).toBeNull();
  });

  it("sends a partial rollup to the children it could not read", () => {
    expect(refreshUnavailableReason("partial", false, "processes")).toBe(
      "Some processes have no overview of their own yet. Rebuild becomes available once they are built.",
    );
    expect(refreshUnavailableReason("partial", false, "departments")).toContain(
      "Some departments",
    );
    // A process rebuild does retry its own excluded sources, so it stays live.
    expect(refreshUnavailableReason("partial", true)).toBeNull();
  });

  it("copies the deterministic projection for both content formats", () => {
    const markdown = "# Headline\n\nBrief.\n\n## How the process works\n\n1. **Intake** — described.";

    expect(overviewCopyText({ format: "v2", markdown })).toBe(markdown);
    expect(overviewCopyText({ format: "legacy", markdown })).toBe(markdown);
    expect(overviewCopyText({ format: "v2", markdown })).toBe(
      overviewCopyText({ format: "v2", markdown }),
    );
  });

  it("has nothing to copy when no overview exists", () => {
    expect(overviewCopyText({ format: "none", markdown: null })).toBeNull();
    expect(overviewCopyText({ format: "legacy", markdown: "  \n " })).toBeNull();
  });

  it("creates a bounded plain-text preview from legacy markdown", () => {
    const preview = legacyPreviewText(
      `# Heading\n\n**Important** [source](https://example.com) ${"detail ".repeat(80)}`,
    );

    expect(preview).not.toContain("#");
    expect(preview).not.toContain("**");
    expect(preview).not.toContain("https://");
    expect(preview.length).toBeLessThanOrEqual(280);
  });
});
