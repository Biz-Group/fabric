import { describe, expect, it } from "vitest";
import { resolveFlowNodeId } from "./flow-navigation";

const nodes = [{ id: "intake" }, { id: "approve" }];

describe("resolveFlowNodeId", () => {
  it("restores a valid deep-linked node", () => {
    expect(resolveFlowNodeId(nodes, "approve")).toBe("approve");
  });

  it("fails safely for missing and invalid node ids", () => {
    expect(resolveFlowNodeId(nodes, null)).toBeNull();
    expect(resolveFlowNodeId(nodes, "deleted-node")).toBeNull();
  });
});
