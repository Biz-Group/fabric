import { describe, expect, it } from "vitest";
import {
  deriveFlowFocus,
  FLOW_LAYER_Z_INDEX,
  resolveEdgeVisualTokens,
  resolveFlowElementEmphasis,
} from "./flow-focus";

const edges = [
  { id: "start-review", source: "start", target: "review" },
  { id: "review-a", source: "review", target: "branch-a" },
  { id: "review-b", source: "review", target: "branch-b" },
  { id: "a-merge", source: "branch-a", target: "merge" },
  { id: "b-merge", source: "branch-b", target: "merge" },
  { id: "merge-end", source: "merge", target: "end" },
];

describe("deriveFlowFocus", () => {
  it("traces directed routes into and out of a selected node", () => {
    const focus = deriveFlowFocus({ edges, selectedNodeId: "branch-a" });

    expect(focus.mode).toBe("selected-route");
    expect([...focus.nodeIds]).toEqual([
      "branch-a",
      "review",
      "start",
      "merge",
      "end",
    ]);
    expect([...focus.edgeIds]).toEqual([
      "review-a",
      "start-review",
      "a-merge",
      "merge-end",
    ]);
    expect(focus.nodeIds.has("branch-b")).toBe(false);
    expect(focus.edgeIds.has("review-b")).toBe(false);
  });

  it("handles cycles without revisiting nodes indefinitely", () => {
    const focus = deriveFlowFocus({
      selectedNodeId: "a",
      edges: [
        { id: "a-b", source: "a", target: "b" },
        { id: "b-a", source: "b", target: "a" },
      ],
    });

    expect(focus.nodeIds).toEqual(new Set(["a", "b"]));
    expect(focus.edgeIds).toEqual(new Set(["a-b", "b-a"]));
  });

  it("uses a hovered node as a temporary one-hop preview", () => {
    const focus = deriveFlowFocus({
      edges,
      selectedNodeId: "branch-a",
      hoveredNodeId: "branch-b",
    });

    expect(focus.mode).toBe("hover-preview");
    expect(focus.anchorNodeId).toBe("branch-b");
    expect(focus.nodeIds).toEqual(new Set(["branch-b", "review", "merge"]));
    expect(focus.edgeIds).toEqual(new Set(["review-b", "b-merge"]));
  });

  it("previews only the endpoints of a hovered edge", () => {
    const focus = deriveFlowFocus({ edges, hoveredEdgeId: "a-merge" });

    expect(focus.nodeIds).toEqual(new Set(["branch-a", "merge"]));
    expect(focus.edgeIds).toEqual(new Set(["a-merge"]));
  });

  it("returns no emphasis when nothing is selected or hovered", () => {
    const focus = deriveFlowFocus({ edges });
    expect(focus.mode).toBe("none");
    expect(focus.nodeIds.size).toBe(0);
    expect(focus.edgeIds.size).toBe(0);
  });
});

describe("resolveEdgeVisualTokens", () => {
  it("keeps every node above widened edge hover targets", () => {
    expect(FLOW_LAYER_Z_INDEX.node).toBeGreaterThan(
      FLOW_LAYER_Z_INDEX.focusedEdge,
    );
    expect(FLOW_LAYER_Z_INDEX.selectedNode).toBeGreaterThan(
      FLOW_LAYER_Z_INDEX.node,
    );
  });

  it("uses distinct non-color line patterns for semantic edge types", () => {
    const patterns = (
      ["sequential", "conditional", "parallel", "fallback"] as const
    ).map(
      (type) =>
        resolveEdgeVisualTokens({
          type,
          isHappyPath: false,
          emphasis: "default",
        }).dashArray ?? "solid",
    );

    expect(new Set(patterns).size).toBe(4);
  });

  it("keeps focused edges strongest and unrelated edges readable", () => {
    const active = resolveEdgeVisualTokens({
      type: "sequential",
      isHappyPath: true,
      emphasis: "active",
    });
    const muted = resolveEdgeVisualTokens({
      type: "sequential",
      isHappyPath: true,
      emphasis: "muted",
    });

    expect(active.strokeWidth).toBeGreaterThan(muted.strokeWidth);
    expect(active.opacity).toBeGreaterThan(muted.opacity);
    expect(muted.opacity).toBeGreaterThan(0.2);
  });
});

describe("resolveFlowElementEmphasis", () => {
  it("keeps unrelated elements stable during hover preview", () => {
    expect(
      resolveFlowElementEmphasis({
        focusMode: "hover-preview",
        focused: false,
        hasSpotlight: false,
        spotlighted: false,
      }),
    ).toBe("default");
    expect(
      resolveFlowElementEmphasis({
        focusMode: "hover-preview",
        focused: true,
        hasSpotlight: false,
        spotlighted: false,
      }),
    ).toBe("active");
  });

  it("still mutes unrelated elements for deliberate persistent focus", () => {
    expect(
      resolveFlowElementEmphasis({
        focusMode: "selected-route",
        focused: false,
        hasSpotlight: false,
        spotlighted: false,
      }),
    ).toBe("muted");
    expect(
      resolveFlowElementEmphasis({
        focusMode: "none",
        focused: false,
        hasSpotlight: true,
        spotlighted: false,
      }),
    ).toBe("muted");
  });
});
