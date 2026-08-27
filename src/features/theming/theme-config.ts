export const THEME_STORAGE_KEY = "fabric:color-theme";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

// This runs in the document head so a persisted theme is visible on the first
// paint. Keep it dependency-free and in sync with ThemeProvider.
export const THEME_INITIALIZATION_SCRIPT = `
(function () {
  var preference = "system";
  try {
    var key = ${JSON.stringify(THEME_STORAGE_KEY)};
    var stored = window.localStorage.getItem(key);
    preference = stored === "light" || stored === "dark" || stored === "system"
      ? stored
      : preference;
  } catch (error) {
    // Storage can be unavailable in private browsing; system mode still works.
  }
  var dark = preference === "dark" || (
    preference === "system" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  var root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.themePreference = preference;
  root.style.colorScheme = dark ? "dark" : "light";
})();
`;
