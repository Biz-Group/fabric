import { useState, useCallback } from "react";

type ColumnKey = "functions" | "departments" | "processes";
type CollapseState = Record<ColumnKey, boolean>;

const STORAGE_KEY = "fabric:miller-collapsed";
const DEFAULT_STATE: CollapseState = {
  functions: false,
  departments: false,
  processes: false,
};

function readStorage(): CollapseState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_STATE, ...parsed };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_STATE };
}

function writeStorage(state: CollapseState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

export function useColumnCollapse() {
  const [collapsed, setCollapsed] = useState<CollapseState>(readStorage);

  const toggle = useCallback((column: ColumnKey) => {
    setCollapsed((prev) => {
      const next = { ...prev, [column]: !prev[column] };
      writeStorage(next);
      return next;
    });
  }, []);

  return { collapsed, toggle } as const;
}
