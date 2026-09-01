import { describe, expect, it } from "vitest";
import {
  resolveEntryViewportTransform,
  resolveFlowEntryNodeId,
  resolveInitialViewportNodeIds,
} from "./flow-viewport";

describe("process-flow initial viewport", () => {
  it("places a horizontal entry card in the centre-left reading position", () => {
    const transform = resolveEntryViewportTransform({
      node: {
        position: { x: 1000, y: 600 },
        width: 280,
        height: 120,
      },
      viewport: { width: 1600, height: 800 },
      direction: "horizontal",
    });

    expect(transform.zoom).toBe(0.92);
    expect(1000 * transform.zoom + transform.x).toBeCloseTo(223.2);
    expect(600 * transform.zoom + transform.y).toBeCloseTo(344.8);
  });

  it("uses a top-centre origin for vertical and narrow flows", () => {
    const vertical = resolveEntryViewportTransform({
      node: { position: { x: 400, y: 500 }, width: 280, height: 120 },
      viewport: { width: 1200, height: 800 },
      direction: "vertical",
      zoom: 1,
    });
    const narrow = resolveEntryViewportTransform({
      node: { position: { x: 400, y: 500 }, width: 280, height: 120 },
      viewport: { width: 500, height: 700 },
      direction: "horizontal",
      zoom: 1,
    });

    expect(540 + vertical.x).toBe(600);
    expect(560 + vertical.y).toBe(160);
    expect(540 + narrow.x).toBe(250);
    expect(560 + narrow.y).toBe(350);
  });

  it("prefers the explicit start node", () => {
    const nodes = [
      { id: "orphan", type: "action" },
      { id: "begin", type: "start" },
      { id: "work", type: "action" },
    ];
    const edges = [{ source: "begin", target: "work" }];

    expect(resolveFlowEntryNodeId(nodes, edges)).toBe("begin");
  });

  it("falls back to a node with no incoming edge", () => {
    const nodes = [{ id: "intake" }, { id: "review" }, { id: "finish" }];
    const edges = [
      { source: "intake", target: "review" },
      { source: "review", target: "finish" },
    ];

    expect(resolveFlowEntryNodeId(nodes, edges)).toBe("intake");
  });

  it("builds a bounded entry window and prioritizes the happy path", () => {
    const nodes = [
      { id: "start", type: "start" },
      { id: "fallback" },
      { id: "primary" },
      { id: "next" },
      { id: "later" },
    ];
    const edges = [
      {
        source: "start",
        target: "fallback",
        data: { isHappyPath: false },
      },
      {
        source: "start",
        target: "primary",
        data: { isHappyPath: true },
      },
      { source: "primary", target: "next", data: { isHappyPath: true } },
      { source: "next", target: "later", data: { isHappyPath: true } },
    ];

    expect(resolveInitialViewportNodeIds(nodes, edges, 4)).toEqual([
      "start",
      "primary",
      "fallback",
      "next",
    ]);
  });

  it("handles empty, cyclic, and dangling graph data safely", () => {
    expect(resolveInitialViewportNodeIds([], [])).toEqual([]);
    expect(
      resolveInitialViewportNodeIds(
        [{ id: "a" }, { id: "b" }],
        [
          { source: "a", target: "b" },
          { source: "b", target: "a" },
          { source: "missing", target: "a" },
        ],
      ),
    ).toEqual(["a", "b"]);
  });
});
