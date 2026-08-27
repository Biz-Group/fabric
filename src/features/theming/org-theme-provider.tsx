"use client";

import { useQuery } from "convex/react";
import { ReactNode, useEffect, useMemo, useState } from "react";
import { api } from "../../../convex/_generated/api";

type ThemeTokens = {
  accent: string;
  accentForeground: string;
  subtle: string;
  border: string;
  ring: string;
  selected: string;
  selectedForeground: string;
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  chart5: string;
};

const THEME_VARIABLES = [
  "--org-accent",
  "--org-accent-foreground",
  "--org-accent-subtle",
  "--org-accent-border",
  "--org-accent-ring",
  "--org-accent-selected",
  "--org-accent-selected-foreground",
  "--primary",
  "--primary-foreground",
  "--ring",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--sidebar-primary",
  "--sidebar-ring",
];

const RESTRAINED_SUBTLE_SURFACE =
  "color-mix(in oklch, var(--org-accent) 7%, var(--background))";
const RESTRAINED_SELECTED_SURFACE =
  "color-mix(in oklch, var(--org-accent) 11%, var(--background))";
const RESTRAINED_ACCENT_BORDER =
  "color-mix(in oklch, var(--org-accent) 34%, var(--border))";

function getIsDarkMode() {
  if (typeof document === "undefined") return false;
  const resolvedTheme = document.documentElement.dataset.theme;
  if (resolvedTheme === "dark") return true;
  if (resolvedTheme === "light") return false;
  return document.documentElement.classList.contains("dark");
}

function applyThemeTokens(tokens: ThemeTokens | null) {
  const style = document.documentElement.style;
  for (const variable of THEME_VARIABLES) {
    style.removeProperty(variable);
  }

  if (!tokens) return;

  style.setProperty("--org-accent", tokens.accent);
  style.setProperty("--org-accent-foreground", tokens.accentForeground);
  style.setProperty("--org-accent-subtle", RESTRAINED_SUBTLE_SURFACE);
  style.setProperty("--org-accent-border", RESTRAINED_ACCENT_BORDER);
  style.setProperty("--org-accent-ring", tokens.ring);
  style.setProperty("--org-accent-selected", RESTRAINED_SELECTED_SURFACE);
  style.setProperty("--org-accent-selected-foreground", "var(--foreground)");
  style.setProperty("--primary", tokens.accent);
  style.setProperty("--primary-foreground", tokens.accentForeground);
  style.setProperty("--ring", tokens.ring);
  style.setProperty("--chart-1", tokens.chart1);
  style.setProperty("--chart-2", tokens.chart2);
  style.setProperty("--chart-3", tokens.chart3);
  style.setProperty("--chart-4", tokens.chart4);
  style.setProperty("--chart-5", tokens.chart5);
  style.setProperty("--sidebar-primary", tokens.accent);
  style.setProperty("--sidebar-ring", tokens.ring);
}

export function OrgThemeProvider({ children }: { children: ReactNode }) {
  const theme = useQuery(api.orgThemes.getForCurrentOrg);
  const [isDark, setIsDark] = useState(getIsDarkMode);

  const activeTokens = useMemo<ThemeTokens | null>(() => {
    if (!theme) return null;
    const tokens = isDark ? theme.darkTokens : theme.lightTokens;
    return tokens ?? null;
  }, [isDark, theme]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const updateDarkMode = () => setIsDark(getIsDarkMode());
    media?.addEventListener("change", updateDarkMode);

    const observer = new MutationObserver(updateDarkMode);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      media?.removeEventListener("change", updateDarkMode);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    applyThemeTokens(activeTokens);
    return () => applyThemeTokens(null);
  }, [activeTokens]);

  return <>{children}</>;
}
