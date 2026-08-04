import { describe, expect, test } from "vitest";
import {
  canRenderGraph,
  flowDetailProgress,
  flowHasIncompleteDetails,
  flowStage,
  hasRetainedPreviousFlow,
  isFlowGenerating,
  isFlowRenderable,
} from "./flow-status";

describe("flowStage", () => {
  test("reports the graph stage while the topology is still being built", () => {
    expect(flowStage({ status: "generating" })).toBe("graph");
    expect(flowStage({ status: "generating", detailsStatus: "pending" })).toBe(
      "graph",
    );
  });

  test("reports the detail stage once the graph has landed", () => {
    // This is the case the whole helper exists for: `status` is already "ready"
    // but every step is still blank, so nothing may render yet.
    expect(flowStage({ status: "ready", detailsStatus: "pending" })).toBe(
      "details",
    );
    expect(flowStage({ status: "ready", detailsStatus: "generating" })).toBe(
      "details",
    );
    expect(
      isFlowRenderable({ status: "ready", detailsStatus: "generating" }),
    ).toBe(false);
  });

  test("treats a legacy flow with no staged metadata as ready", () => {
    // Single-call flows wrote their details inline; getProcessFlow reports them
    // as ready, and they must not be held back by a stage they never had.
    expect(flowStage({ status: "ready" })).toBe("ready");
    expect(isFlowRenderable({ status: "ready" })).toBe(true);
  });

  test("renders a flow whose details are only partial", () => {
    // The graph is usable even when some steps were never described — that is
    // the difference between "partial" and "failed" in the pipeline.
    expect(flowStage({ status: "ready", detailsStatus: "partial" })).toBe(
      "ready",
    );
    expect(flowStage({ status: "ready", detailsStatus: "failed" })).toBe(
      "ready",
    );
    expect(isFlowRenderable({ status: "ready", detailsStatus: "failed" })).toBe(
      true,
    );
  });

  test("a failed graph is failed regardless of the detail status", () => {
    expect(flowStage({ status: "failed" })).toBe("failed");
    expect(flowStage({ status: "failed", detailsStatus: "generating" })).toBe(
      "failed",
    );
    expect(isFlowGenerating({ status: "failed" })).toBe(false);
    expect(isFlowRenderable({ status: "failed" })).toBe(false);
  });

  test("the diagram unblocks at the graph stage, aggregates wait for details", () => {
    const enriching = {
      status: "ready" as const,
      detailsStatus: "generating" as const,
    };
    // The whole point of the progressive change: topology is showable while the
    // descriptions land, but anything that totals across steps is not.
    expect(canRenderGraph(enriching)).toBe(true);
    expect(isFlowRenderable(enriching)).toBe(false);
    expect(canRenderGraph({ status: "generating" })).toBe(false);
    expect(canRenderGraph({ status: "failed" })).toBe(false);
  });

  test("isFlowGenerating covers both stages", () => {
    expect(isFlowGenerating({ status: "generating" })).toBe(true);
    expect(
      isFlowGenerating({ status: "ready", detailsStatus: "generating" }),
    ).toBe(true);
    expect(isFlowGenerating({ status: "ready", detailsStatus: "ready" })).toBe(
      false,
    );
  });
});

describe("flowDetailProgress", () => {
  test("counts finished steps, successes and failures alike", () => {
    // A step that failed is done being waited on, so it counts as progress.
    expect(
      flowDetailProgress({
        status: "ready",
        detailsStatus: "generating",
        detailNodeCount: 10,
        detailCompletedCount: 4,
        detailFailedCount: 2,
      }),
    ).toEqual({ completed: 6, total: 10 });
  });

  test("never reports more progress than there is work", () => {
    expect(
      flowDetailProgress({
        status: "ready",
        detailNodeCount: 3,
        detailCompletedCount: 5,
      }),
    ).toEqual({ completed: 3, total: 3 });
  });

  test("has nothing to report before the nodes are counted", () => {
    expect(flowDetailProgress({ status: "generating" })).toBeNull();
    expect(
      flowDetailProgress({ status: "ready", detailNodeCount: 0 }),
    ).toBeNull();
  });
});

describe("hasRetainedPreviousFlow", () => {
  test("a failed refresh with nodes underneath keeps showing them", () => {
    // The graph stage leaves nodes/edges/insights untouched on failure, so the
    // user's previous flow survives whole. Showing an error page instead would
    // hide a flow that is still perfectly good.
    expect(hasRetainedPreviousFlow({ status: "failed" }, 12)).toBe(true);
  });

  test("a first-ever generation that fails has nothing to fall back to", () => {
    expect(hasRetainedPreviousFlow({ status: "failed" }, 0)).toBe(false);
  });

  test("only a failed run is ever showing a retained flow", () => {
    expect(hasRetainedPreviousFlow({ status: "generating" }, 12)).toBe(false);
    expect(
      hasRetainedPreviousFlow({ status: "ready", detailsStatus: "ready" }, 12),
    ).toBe(false);
    // Mid-enrichment the nodes are the NEW graph's, not a retained one.
    expect(
      hasRetainedPreviousFlow(
        { status: "ready", detailsStatus: "generating" },
        12,
      ),
    ).toBe(false);
  });
});

describe("flowHasIncompleteDetails", () => {
  test("is set only once a run has landed short", () => {
    expect(
      flowHasIncompleteDetails({ status: "ready", detailsStatus: "partial" }),
    ).toBe(true);
    expect(
      flowHasIncompleteDetails({ status: "ready", detailsStatus: "failed" }),
    ).toBe(true);
    // Mid-run is not "incomplete" — it is unfinished, which reads differently.
    expect(
      flowHasIncompleteDetails({
        status: "ready",
        detailsStatus: "generating",
      }),
    ).toBe(false);
    expect(
      flowHasIncompleteDetails({ status: "ready", detailsStatus: "ready" }),
    ).toBe(false);
  });
});
