import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark";

export interface ChartTheme {
  ink: string;
  muted: string;
  line: string;
  surface: string;
}

const LIGHT: ChartTheme = { ink: "#1b2739", muted: "#596a7e", line: "#dfe6ed", surface: "#ffffff" };
const DARK: ChartTheme = { ink: "#edf2fa", muted: "#b1c0d2", line: "#39485c", surface: "#1c293a" };

export function chartTheme(mode: ThemeMode): ChartTheme {
  return mode === "dark" ? DARK : LIGHT;
}

const STORAGE_KEY = "theme";

// The effective mode is an explicit user choice, or the OS preference when unset.
export function resolveTheme(stored: string | null, prefersDark: boolean): ThemeMode {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

export function useThemeMode(): [ThemeMode, () => void] {
  const [mode, setMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "light";
    return resolveTheme(window.localStorage.getItem(STORAGE_KEY), window.matchMedia("(prefers-color-scheme: dark)").matches);
  });

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    const followSystem = (event: MediaQueryListEvent) => {
      if (!window.localStorage.getItem(STORAGE_KEY)) setMode(event.matches ? "dark" : "light");
    };
    preference.addEventListener("change", followSystem);
    return () => preference.removeEventListener("change", followSystem);
  }, []);

  const toggle = () => {
    const next: ThemeMode = mode === "dark" ? "light" : "dark";
    window.localStorage.setItem(STORAGE_KEY, next);
    setMode(next);
  };
  return [mode, toggle];
}

// Chart colours follow the active theme. The hook re-reads the mode from the DOM
// attribute set by useThemeMode, so charts restyle without a page reload.
export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState<ChartTheme>(() => chartTheme(readMode()));
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(chartTheme(readMode())));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

function readMode(): ThemeMode {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
