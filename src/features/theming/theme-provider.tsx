"use client";

import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  isThemePreference,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from "@/features/theming/theme-config";

type ThemeContextValue = {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const THEME_CHANGE_EVENT = "fabric:color-theme-change";
const SERVER_THEME_SNAPSHOT = "system:light";

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function readDocumentPreference(): ThemePreference {
  const value = document.documentElement.dataset.themePreference;
  return isThemePreference(value) ? value : readStoredPreference();
}

function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  const root = document.documentElement;

  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;

  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"]',
  )) {
    meta.content = resolved === "dark" ? "#191A1D" : "#F7F5F0";
  }

  return resolved;
}

function getThemeSnapshot() {
  const root = document.documentElement;
  const preference = readDocumentPreference();
  const resolved = root.dataset.theme === "dark" ? "dark" : "light";
  return `${preference}:${resolved}`;
}

function getServerThemeSnapshot() {
  return SERVER_THEME_SNAPSHOT;
}

function subscribeToTheme(onStoreChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  const onThemeChange = () => onStoreChange();
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    const next = isThemePreference(event.newValue) ? event.newValue : "system";
    applyTheme(next);
    onStoreChange();
  };
  const onSystemThemeChange = () => {
    if (readDocumentPreference() !== "system") return;
    applyTheme("system");
    onStoreChange();
  };

  window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
  window.addEventListener("storage", onStorage);
  media.addEventListener("change", onSystemThemeChange);

  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
    window.removeEventListener("storage", onStorage);
    media.removeEventListener("change", onSystemThemeChange);
  };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // useSyncExternalStore supplies a stable server snapshot for hydration, then
  // reads the theme that the head script applied before the first paint.
  const snapshot = useSyncExternalStore(
    subscribeToTheme,
    getThemeSnapshot,
    getServerThemeSnapshot,
  );
  const [preferenceValue, resolvedValue] = snapshot.split(":");
  const preference = isThemePreference(preferenceValue)
    ? preferenceValue
    : "system";
  const resolvedTheme: ResolvedTheme =
    resolvedValue === "dark" ? "dark" : "light";

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private browsing modes can make localStorage unavailable. The theme
      // still works for the current page in that case.
    }
    applyTheme(next);
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }, []);

  return (
    <ThemeContext.Provider
      value={{ preference, resolvedTheme, setPreference }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
