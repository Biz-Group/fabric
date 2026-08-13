import { describe, expect, it } from "vitest";
import {
  resolveFlowEntryNodeId,
  resolveInitialViewportNodeIds,
} from "./flow-viewport";

describe("process-flow initial viewport", () => {
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

