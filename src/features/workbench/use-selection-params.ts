import type { useSearchParams } from "next/navigation";
import type { Id } from "../../../convex/_generated/dataModel";

// --- URL selection params ---
// The committed selection is mirrored into the `/[org]` query string so the
// view is refresh-safe, shareable, and traversable with the Back button.

export const PARAM = {
  fn: "fn",
  dept: "dept",
  proc: "proc",
  tab: "tab",
  node: "node",
} as const;

export type SelectionParams = {
  fn: Id<"functions"> | null;
  dept: Id<"departments"> | null;
  proc: Id<"processes"> | null;
  tab: number;
  node: string | null;
};

// Tab index <-> URL token. Only the default Overview tab is omitted.
export function tabToParam(tab: number): string | null {
  if (tab === 1) return "conversations";
  if (tab === 2) return "flow";
  if (tab === 3) return "insights";
  return null;
}
export function paramToTab(value: string | null): number {
  // `summary` was the original public token. Both it and the explicit
  // `overview` alias continue to land on the renamed default surface.
  if (value === null || value === "overview" || value === "summary") return 0;
  if (value === "conversations") return 1;
  if (value === "flow") return 2;
  if (value === "insights") return 3;
  return 0;
}

export function readSelectionParams(
  searchParams: URLSearchParams | ReturnType<typeof useSearchParams>,
): SelectionParams {
  const fn = searchParams.get(PARAM.fn);
  const dept = searchParams.get(PARAM.dept);
  const proc = searchParams.get(PARAM.proc);
  const tab = paramToTab(searchParams.get(PARAM.tab));
  return {
    fn: fn ? (fn as Id<"functions">) : null,
    dept: dept ? (dept as Id<"departments">) : null,
    proc: proc ? (proc as Id<"processes">) : null,
    tab,
    node: proc && tab === 2 ? searchParams.get(PARAM.node) : null,
  };
}

// Build a query string from the committed selection, deleting descendant keys
// when a parent is absent so the URL can never describe an impossible path
// (e.g. a process with no function). Starts from the current params to stay
// forward-compatible with any unrelated keys.
export function buildSelectionQuery(
  current: URLSearchParams | ReturnType<typeof useSearchParams>,
  sel: SelectionParams,
): string {
  const params = new URLSearchParams(current.toString());

  const setOrDelete = (key: string, value: string | null) => {
    if (value) params.set(key, value);
    else params.delete(key);
  };

  setOrDelete(PARAM.fn, sel.fn);
  setOrDelete(PARAM.dept, sel.fn ? sel.dept : null);
  setOrDelete(PARAM.proc, sel.fn && sel.dept ? sel.proc : null);
  setOrDelete(
    PARAM.tab,
    sel.fn && sel.dept && sel.proc ? tabToParam(sel.tab) : null,
  );
  setOrDelete(
    PARAM.node,
    sel.fn && sel.dept && sel.proc && sel.tab === 2 ? sel.node : null,
  );

  return params.toString();
}
