import { themes, type KeyColor, type RunStatus, type ThemeName } from "../../packages/contracts/index.js";

// The six themes change colors, type and how a key shows its state. They never change the layout, the controls or what a tap does.
export const themeInfo: Record<ThemeName, { name: string; note: string }> = {
  braun: { name: "Braun", note: "Graphite, status lamps" },
  metro: { name: "Metro", note: "Line colors, status bars" },
  midnight: { name: "Midnight", note: "Enamel blue, station lines" },
  standard: { name: "Standard", note: "System colors, badges" },
  classic: { name: "Classic", note: "The original look" },
  widget: { name: "Widget", note: "Rounded cards, content first" },
};

// Mirrors the --bg, --c-* and --t-* tokens in style.css: the ground color is used for the browser chrome, fill and tone for icons that are
// drawn once (a one-color SVG gets its color when it is converted). tests/themes.test.mjs keeps the two copies identical.
type Swatch = { fill: string; tone: string };
export const themeColors: Record<ThemeName, { ground: string; colors: Record<KeyColor, Swatch> }> = {
  braun: { ground: "#1A1917", colors: { orange: { fill: "#F26B1D", tone: "#F26B1D" }, yellow: { fill: "#E9B93A", tone: "#E9B93A" }, green: { fill: "#5E9B63", tone: "#5E9B63" }, blue: { fill: "#4F6D8A", tone: "#617C96" }, purple: { fill: "#7A5C8E", tone: "#876C99" }, red: { fill: "#B5483B", tone: "#BC5A4F" }, gray: { fill: "#8C877C", tone: "#8C877C" } } },
  metro: { ground: "#1E2124", colors: { orange: { fill: "#F7943E", tone: "#F7943E" }, yellow: { fill: "#FFD100", tone: "#FFD100" }, green: { fill: "#00A040", tone: "#00A040" }, blue: { fill: "#0075C2", tone: "#1A83C8" }, purple: { fill: "#7E3C93", tone: "#9E6DAE" }, red: { fill: "#E2231A", tone: "#E53931" }, gray: { fill: "#8B939B", tone: "#8B939B" } } },
  midnight: { ground: "#0E1A33", colors: { orange: { fill: "#E8742C", tone: "#E8742C" }, yellow: { fill: "#F2A900", tone: "#F2A900" }, green: { fill: "#2E9E5B", tone: "#2E9E5B" }, blue: { fill: "#2F5DD0", tone: "#4E75D7" }, purple: { fill: "#7B4FC2", tone: "#8861C8" }, red: { fill: "#D7263D", tone: "#D93147" }, gray: { fill: "#8E98B0", tone: "#8E98B0" } } },
  standard: { ground: "#000000", colors: { orange: { fill: "#FF9F0A", tone: "#FF9F0A" }, yellow: { fill: "#FFD60A", tone: "#FFD60A" }, green: { fill: "#30D158", tone: "#30D158" }, blue: { fill: "#0A84FF", tone: "#0A84FF" }, purple: { fill: "#BF5AF2", tone: "#BF5AF2" }, red: { fill: "#FF453A", tone: "#FF453A" }, gray: { fill: "#8E8E93", tone: "#8E8E93" } } },
  classic: { ground: "#0D0E10", colors: { orange: { fill: "#FF9548", tone: "#FF9548" }, yellow: { fill: "#FFD25A", tone: "#FFD25A" }, green: { fill: "#7CF2B4", tone: "#7CF2B4" }, blue: { fill: "#5AA9FF", tone: "#5AA9FF" }, purple: { fill: "#B48CFF", tone: "#B48CFF" }, red: { fill: "#FF5C6C", tone: "#FF5C6C" }, gray: { fill: "#C9CDD4", tone: "#C9CDD4" } } },
  widget: { ground: "#101216", colors: { orange: { fill: "#FF9F43", tone: "#FF9F43" }, yellow: { fill: "#FFD24A", tone: "#FFD24A" }, green: { fill: "#4CCB7C", tone: "#4CCB7C" }, blue: { fill: "#4F8CF5", tone: "#4F8CF5" }, purple: { fill: "#9B80F5", tone: "#9B80F5" }, red: { fill: "#F2646A", tone: "#F2646A" }, gray: { fill: "#9BA3B2", tone: "#9BA3B2" } } },
};
// The color of a key in a theme: its fill on a filled key, its tone (a lighter shade where the fill is too dark) on a dark key body.
export const themeColor = (theme: ThemeName, color: KeyColor, role: keyof Swatch = "fill") => themeColors[theme].colors[color][role];

// "notice" (T99): the Mac did something else on purpose, such as showing the Connection Center for a Windows App session that is not connected.
export type TileStatus = RunStatus | "notice" | "sending" | "rejected" | "ready" | "busy" | "offline" | "connecting" | "unconfigured";
const base: Record<TileStatus, string> = { ready: "Ready", sending: "Sending…", accepted: "Received by Mac", running: "Executing…", succeeded: "Done",
  failed: "Failed", notice: "Not connected", rejected: "Rejected", unknown: "Result unknown", busy: "Mac busy", offline: "Offline", connecting: "Connecting…", unconfigured: "No action" };
// Metro prints these in capitals on a status bar; Midnight words them like a service board.
const wording: Partial<Record<ThemeName, Partial<Record<TileStatus, string>>>> = {
  metro: { sending: "Sending", accepted: "Accepted", running: "Running", unknown: "Unknown" },
  midnight: { sending: "In progress", accepted: "In progress", running: "In progress", succeeded: "Arrived · done", failed: "Delayed · failed", rejected: "Delayed · rejected", unknown: "Delayed · unknown" },
};
export const tileStatus = (theme: ThemeName, status: TileStatus): string => wording[theme]?.[status] ?? base[status];
// Midnight's service-board words are too long for the status bar of a small key, which shows these instead.
const brief: Partial<Record<ThemeName, Partial<Record<TileStatus, string>>>> = {
  midnight: { sending: "Sending", accepted: "Received", running: "Running", succeeded: "Done", failed: "Failed", rejected: "Rejected", unknown: "Unknown" },
};
export const shortStatus = (theme: ThemeName, status: TileStatus): string | undefined => brief[theme]?.[status];

// A small cosmetic copy of the last theme this browser saw, so the page does not flash the default theme before the Mac answers.
// The Mac layout stays the only source of truth.
const cacheKey = "keyln.theme";
export function cachedTheme(): ThemeName | undefined {
  try {
    const value = globalThis.localStorage?.getItem(cacheKey);
    return themes.includes(value as ThemeName) ? value as ThemeName : undefined;
  } catch { return undefined; }
}
function remember(theme: ThemeName) {
  try { globalThis.localStorage?.setItem(cacheKey, theme); } catch { /* The cache is optional. */ }
}
// ground is the page color of a custom theme; without it the browser chrome takes the built-in theme's.
export function paintTheme(theme: ThemeName, ground?: string) {
  const root = globalThis.document?.documentElement;
  if (root) root.dataset.theme = theme;
  const meta = typeof document.querySelector === "function" ? document.querySelector("meta[name=theme-color]") : null;
  meta?.setAttribute("content", ground ?? themeColors[theme].ground);
  remember(theme);
}

interface PickerOptions { container: HTMLElement; choose: (theme: ThemeName) => void }
// Five toggle buttons (one is always pressed), each with a small preview drawn from the theme's own tokens (the preview carries data-theme).
export function createThemePicker(options: PickerOptions) {
  const buttons = new Map<ThemeName, HTMLButtonElement>();
  for (const theme of themes) {
    const button = document.createElement("button"), preview = document.createElement("span"), name = document.createElement("span"), note = document.createElement("span");
    button.type = "button"; button.className = "theme-option"; button.dataset.themeChoice = theme;
    button.setAttribute("aria-pressed", "false");
    preview.className = "theme-preview"; preview.dataset.theme = theme; preview.setAttribute("aria-hidden", "true");
    for (const color of ["orange", "blue", "green"] satisfies KeyColor[]) {
      const chip = document.createElement("span"); chip.className = "tp-chip"; chip.dataset.color = color; preview.append(chip);
    }
    const state = document.createElement("span"); state.className = "tp-state"; preview.append(state);
    name.className = "theme-name"; name.textContent = themeInfo[theme].name;
    note.className = "theme-note-line"; note.textContent = themeInfo[theme].note;
    button.append(preview, name, note);
    button.addEventListener("click", () => { if (!button.disabled) options.choose(theme); });
    buttons.set(theme, button); options.container.append(button);
  }
  return {
    // current is undefined while a custom theme is in use: none of the five is then pressed.
    render(current: ThemeName | undefined, enabled: boolean) {
      for (const [theme, button] of buttons) {
        button.setAttribute("aria-pressed", String(theme === current));
        button.disabled = !enabled;
      }
    },
  };
}
