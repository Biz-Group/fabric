import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLOW_VIEW_PREFERENCES,
  parseFlowViewPreferences,
} from "./flow-view-preferences";

describe("process-flow view preferences", () => {
  it("uses the stable default for missing or invalid storage", () => {
    expect(parseFlowViewPreferences(null)).toEqual(
      DEFAULT_FLOW_VIEW_PREFERENCES,
    );
    expect(parseFlowViewPreferences("not-json")).toEqual(
      DEFAULT_FLOW_VIEW_PREFERENCES,
    );
  });

  it("restores supported direction and grouping choices", () => {
    expect(
      parseFlowViewPreferences(
        JSON.stringify({ direction: "vertical", grouping: "owner" }),
      ),
    ).toEqual({ direction: "vertical", grouping: "owner" });
  });

  it("normalizes unsupported stored values", () => {
    expect(
      parseFlowViewPreferences(
        JSON.stringify({ direction: "diagonal", grouping: "department" }),
      ),
    ).toEqual(DEFAULT_FLOW_VIEW_PREFERENCES);
  });
});
