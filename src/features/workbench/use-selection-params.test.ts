import { describe, expect, it } from "vitest";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  buildSelectionQuery,
  paramToTab,
  readSelectionParams,
  tabToParam,
} from "./use-selection-params";

const selection = {
  fn: "function-1" as Id<"functions">,
  dept: "department-1" as Id<"departments">,
  proc: "process-1" as Id<"processes">,
  node: null,
};

describe("overview tab URL compatibility", () => {
  it.each([null, "overview", "summary"])(
    "maps the %s token to Overview",
    (token) => {
      expect(paramToTab(token)).toBe(0);
    },
  );

  it("keeps Overview as the canonical omitted token", () => {
    expect(tabToParam(0)).toBeNull();
    expect(
      buildSelectionQuery(new URLSearchParams("tab=summary&campaign=review"), {
        ...selection,
        tab: 0,
      }),
    ).toBe("campaign=review&fn=function-1&dept=department-1&proc=process-1");
  });

  it("restores legacy summary deep links without losing hierarchy selection", () => {
    const params = readSelectionParams(
      new URLSearchParams(
        "fn=function-1&dept=department-1&proc=process-1&tab=summary",
      ),
    );

    expect(params).toEqual({ ...selection, tab: 0 });
  });

  it.each([
    ["conversations", 1],
    ["flow", 2],
    ["insights", 3],
  ])("preserves the %s tab mapping", (token, tab) => {
    expect(paramToTab(token)).toBe(tab);
    expect(tabToParam(tab as number)).toBe(token);
  });

  it("round-trips a Flow node deep link", () => {
    const query = buildSelectionQuery(new URLSearchParams("campaign=review"), {
      ...selection,
      tab: 2,
      node: "approve-request",
    });

    expect(query).toBe(
      "campaign=review&fn=function-1&dept=department-1&proc=process-1&tab=flow&node=approve-request",
    );
    expect(readSelectionParams(new URLSearchParams(query))).toEqual({
      ...selection,
      tab: 2,
      node: "approve-request",
    });
  });

  it("drops node tokens outside the Flow tab or without a complete process path", () => {
    expect(
      buildSelectionQuery(new URLSearchParams("node=old-node"), {
        ...selection,
        tab: 3,
        node: "old-node",
      }),
    ).not.toContain("node=");

    expect(
      readSelectionParams(
        new URLSearchParams("proc=process-1&tab=insights&node=old-node"),
      ).node,
    ).toBeNull();
  });
});
