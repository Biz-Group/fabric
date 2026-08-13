import { describe, expect, it } from "vitest";
import { resolveConnectedNodeInDirection } from "./flow-keyboard-navigation";

const nodes = [
  { id: "start", position: { x: 0, y: 100 } },
  { id: "upper", position: { x: 300, y: 0 } },
  { id: "lower", position: { x: 300, y: 220 } },
  { id: "finish", position: { x: 600, y: 100 } },
  { id: "nearby-but-unconnected", position: { x: 40, y: 100 } },
];

const edges = [
  { source: "start", target: "upper" },
  { source: "start", target: "lower" },
  { source: "upper", target: "finish" },
  { source: "lower", target: "finish" },
];

describe("process-flow connected keyboard navigation", () => {
  it("uses the arrow's visual direction across incoming and outgoing edges", () => {
    expect(
      resolveConnectedNodeInDirection({
        currentNodeId: "start",
        key: "ArrowDown",
        nodes,
        edges,
      }),
    ).toBe("lower");

    expect(
      resolveConnectedNodeInDirection({
        currentNodeId: "finish",
        key: "ArrowLeft",
        nodes,
        edges,
      }),
    ).toBe("upper");
  });

  it("prefers the connected node closest to the arrow's bearing", () => {
    expect(
      resolveConnectedNodeInDirection({
        currentNodeId: "start",
        key: "ArrowRight",
        nodes,
        edges,
      }),
    ).toBe("upper");
  });

  it("ignores unconnected, self-loop, dangling, and opposite-side nodes", () => {
    expect(
      resolveConnectedNodeInDirection({
        currentNodeId: "start",
        key: "ArrowLeft",
        nodes,
        edges: [
          ...edges,
          { source: "start", target: "start" },
          { source: "start", target: "missing" },
        ],
      }),
    ).toBeNull();
  });

  it("returns null when the current step is unavailable", () => {
    expect(
      resolveConnectedNodeInDirection({
        currentNodeId: "missing",
        key: "ArrowRight",
        nodes,
        edges,
      }),
    ).toBeNull();
  });
});
