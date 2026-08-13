import { describe, expect, it } from "vitest";
import {
  directionToDagreRank,
  layoutProcessFlow,
  resolveDecisionSourceHandle,
  resolveOwnerLane,
  toggleOwnerGrouping,
  type FlowLayoutEdgeInput,
  type FlowLayoutNodeInput,
} from "./flow-layout";

const nodes: FlowLayoutNodeInput[] = [
  { id: "start", category: "start", actors: ["Operations"] },
  { id: "decide", category: "decision", actors: ["Operations"] },
  { id: "approve", category: "action", actors: ["Finance"] },
  { id: "revise", category: "action", actors: ["Finance", "Operations"] },
  { id: "finish", category: "end", actors: [] },
];

const edges: FlowLayoutEdgeInput[] = [
  { id: "start-decide", source: "start", target: "decide", isHappyPath: true },
  {
    id: "decide-approve",
    source: "decide",
    target: "approve",
    isHappyPath: true,
  },
  {
    id: "decide-revise",
    source: "decide",
    target: "revise",
    isHappyPath: false,
  },
  {
    id: "revise-decide",
    source: "revise",
    target: "decide",
    isHappyPath: false,
  },
  {
    id: "approve-finish",
    source: "approve",
    target: "finish",
    isHappyPath: true,
  },
];

describe("process-flow layout adapter", () => {
  it("turns the owner-lane control on and off", () => {
    expect(toggleOwnerGrouping("process")).toBe("owner");
    expect(toggleOwnerGrouping("owner")).toBe("process");
  });

  it("maps view direction to Dagre rank direction", () => {
    expect(directionToDagreRank("horizontal")).toBe("LR");
    expect(directionToDagreRank("vertical")).toBe("TB");
  });

  it("lays a linear direction along the requested primary axis", () => {
    const horizontal = layoutProcessFlow({
      nodes,
      edges,
      direction: "horizontal",
      grouping: "process",
    });
    const vertical = layoutProcessFlow({
      nodes,
      edges,
      direction: "vertical",
      grouping: "process",
    });

    const horizontalStart = horizontal.nodes.find(
      (node) => node.id === "start",
    )!;
    const horizontalFinish = horizontal.nodes.find(
      (node) => node.id === "finish",
    )!;
    const verticalStart = vertical.nodes.find((node) => node.id === "start")!;
    const verticalFinish = vertical.nodes.find((node) => node.id === "finish")!;

    expect(horizontalFinish.position.x).toBeGreaterThan(
      horizontalStart.position.x,
    );
    expect(verticalFinish.position.y).toBeGreaterThan(verticalStart.position.y);
  });

  it("assigns stable explicit ports to decision branches", () => {
    expect(resolveDecisionSourceHandle(edges[1]!, nodes, edges)).toBe(
      "source-primary",
    );
    expect(resolveDecisionSourceHandle(edges[2]!, nodes, edges)).toBe(
      "source-alternate-start",
    );
    expect(
      resolveDecisionSourceHandle(edges[0]!, nodes, edges),
    ).toBeUndefined();
  });

  it("does not imply a single owner for shared or unfinished steps", () => {
    expect(resolveOwnerLane(nodes[2]!)).toMatchObject({
      label: "Finance",
      kind: "actor",
    });
    expect(resolveOwnerLane(nodes[3]!)).toEqual({
      id: "shared",
      label: "Shared · multiple actors",
      kind: "shared",
    });
    expect(
      resolveOwnerLane({
        id: "pending",
        category: "action",
        actors: [],
        detailStatus: "pending",
      }),
    ).toMatchObject({ label: "Awaiting details", kind: "pending" });
  });

  it("assigns every node to exactly one deterministic owner lane", () => {
    const first = layoutProcessFlow({
      nodes,
      edges,
      direction: "horizontal",
      grouping: "owner",
    });
    const second = layoutProcessFlow({
      nodes,
      edges,
      direction: "horizontal",
      grouping: "owner",
    });
    const laneMembers = first.lanes.flatMap((lane) => lane.nodeIds);

    expect(laneMembers).toHaveLength(nodes.length);
    expect(new Set(laneMembers).size).toBe(nodes.length);
    expect(first).toEqual(second);
    expect(first.lanes.map((lane) => lane.label)).toEqual([
      "Operations",
      "Finance",
      "Shared · multiple actors",
      "Unassigned",
    ]);
  });

  it("reserves a footer for repeated labels in vertical owner lanes", () => {
    const layout = layoutProcessFlow({
      nodes,
      edges,
      direction: "vertical",
      grouping: "owner",
    });
    const positions = new Map(
      layout.nodes.map((node) => [node.id, node.position]),
    );
    const inputs = new Map(nodes.map((node) => [node.id, node]));

    for (const lane of layout.lanes) {
      const finalNodeBottom = Math.max(
        ...lane.nodeIds.map((id) => {
          const node = inputs.get(id)!;
          return (
            positions.get(id)!.y + (node.category === "decision" ? 100 : 120)
          );
        }),
      );
      expect(
        lane.position.y + lane.height - finalNodeBottom,
      ).toBeGreaterThanOrEqual(60);
    }
  });
});
