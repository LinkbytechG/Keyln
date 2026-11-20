import { DEFAULT_THEME, shortcutLabel, type AppInfo, type Component, type KeyColor, type ScriptInfo, type ShortcutInfo, type ThemeName, type Workflow } from "../../packages/contracts/index.js";
import { iconPaths } from "./icon-paths.js";
import { appIconReference, loadAppIcon } from "./app-icons.js";
import { themeColor } from "./themes.js";

export type SymbolName = keyof typeof iconPaths;
const symbols: Record<Component["icon"], SymbolName> = { app: "app-window", spark: "search", play: "play", bolt: "command",
  calculator: "calculator", scan: "scan", code: "code", lock: "lock", moon: "moon", volume: "volume-2",
  link: "link", keyboard: "keyboard", text: "type", mic: "mic-off", folder: "folder", star: "star", heart: "heart",
  home: "home", mail: "mail", camera: "camera", terminal: "purpose-terminal", monitor: "monitor", globe: "globe",
  headphones: "headphones", coffee: "coffee", check: "check", download: "download", upload: "upload", refresh: "refresh", sun: "sun" };
const colors: Record<Component["icon"], KeyColor> = { app: "blue", spark: "purple", play: "green", bolt: "blue",
  calculator: "orange", scan: "blue", code: "blue", lock: "gray", moon: "purple", volume: "green",
  link: "yellow", keyboard: "gray", text: "purple", mic: "red", folder: "yellow", star: "yellow", heart: "red",
  home: "green", mail: "blue", camera: "purple", terminal: "gray", monitor: "blue", globe: "blue",
  headphones: "purple", coffee: "orange", check: "green", download: "green", upload: "blue", refresh: "green", sun: "yellow" };

export function setIcon(target: Element, name: SymbolName) {
  if (target.getAttribute("data-symbol") === name) return;
  const shape: { viewBox: string; paths: readonly string[]; stroke?: boolean } = iconPaths[name], svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", shape.viewBox); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
  for (const geometry of shape.paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", geometry); path.setAttribute("fill", shape.stroke ? "none" : "currentColor");
    if (shape.stroke) { path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.8"); path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round"); }
    svg.append(path);
  }
  target.replaceChildren(svg); target.setAttribute("data-symbol", name);
}
const glyphKeys = new WeakMap<Element, string>();
export function setKeyIcon(target: HTMLElement, button: Component, signal?: AbortSignal) {
  const glyph = button.appearance?.glyph, id = appIconReference(button), symbol = appearance(button).symbol;
  const fallback = () => { target.removeAttribute("data-glyph"); target.style.removeProperty("--glyph-chars"); setIcon(target, symbol); };
  if (id) {
    if (signal?.aborted) return;
    const key = `app:${id}:${symbol}`; if (glyphKeys.get(target) === key) return;
    glyphKeys.set(target, key); fallback();
    const cancelled = () => { if (glyphKeys.get(target) === key) glyphKeys.delete(target); };
    signal?.addEventListener("abort",cancelled,{once:true});
    void loadAppIcon(id,signal).then(data => {
      // A failed icon forgets its key so the next render (or the tile scrolling back into view) tries again; the loader's cooldown limits the asking.
      if (!data) { if (glyphKeys.get(target) === key) glyphKeys.delete(target); return; }
      if (glyphKeys.get(target) !== key || !target.isConnected) return;
      const image = document.createElement("img"); image.alt = ""; image.draggable = false;
      image.addEventListener("error", () => { if (glyphKeys.get(target) === key) { target.removeAttribute("data-symbol"); fallback(); } });
      image.src = data; target.removeAttribute("data-symbol"); target.setAttribute("data-glyph", "app"); target.replaceChildren(image);
    }).finally(() => signal?.removeEventListener("abort",cancelled));
    return;
  }
  if (!glyph || glyph.type === "builtin" || glyph.type === "app") { glyphKeys.delete(target); target.removeAttribute("data-symbol"); fallback(); return; }
  const key = JSON.stringify(glyph);
  if (glyphKeys.get(target) === key) return;
  glyphKeys.set(target, key); target.removeAttribute("data-symbol"); target.setAttribute("data-glyph", glyph.type);
  if (glyph.type === "text") {
    target.textContent = glyph.text;
    const count = typeof Intl.Segmenter === "function" ? [...new Intl.Segmenter(undefined,{granularity:"grapheme"}).segment(glyph.text)].length : Array.from(glyph.text).length;
    target.style.setProperty("--glyph-chars", String(Math.max(1,count)));
  }
  else {
    const image = document.createElement("img"); image.src = glyph.data; image.alt = ""; image.draggable = false;
    target.replaceChildren(image);
  }
}
// Classic's colors. Other themes have their own (see themes.ts); this table keeps the original values for the Classic look.
export const palette: Record<KeyColor, string> = { orange: "#FF9548", yellow: "#FFD25A", green: "#7CF2B4", blue: "#5AA9FF", purple: "#B48CFF", red: "#FF5C6C", gray: "#C9CDD4" };
// The theme the page is showing; a one-color icon is converted with colors that suit it.
let activeTheme: ThemeName = DEFAULT_THEME;
export const setActiveTheme = (theme: ThemeName) => { activeTheme = theme; };
export const getActiveTheme = () => activeTheme;
const channel = (hex: string, offset: number) => { const value = parseInt(hex.slice(offset, offset + 2), 16) / 255; return value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; };
export const luminance = (hex: string) => .2126 * channel(hex, 1) + .7152 * channel(hex, 3) + .0722 * channel(hex, 5);
// WCAG contrast ratio of two six-digit colors.
export function contrast(first: string, second: string): number {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
export const mixHex = (from: string, to: string, share: number) => "#" + [1, 3, 5].map(offset =>
  Math.round(parseInt(from.slice(offset, offset + 2), 16) * (1 - share) + parseInt(to.slice(offset, offset + 2), 16) * share).toString(16).padStart(2, "0")).join("").toUpperCase();
const INK_DARK = "#141414", INK_LIGHT = "#EEEFF1";
// Readable ink on a custom color block: the darker or the lighter of two inks, whichever contrasts more with that color.
export function tintInk(tint: string): string {
  return contrast(tint, INK_DARK) >= contrast(tint, INK_LIGHT) ? INK_DARK : INK_LIGHT;
}
// A quieter ink for the action line on a custom color block: the nearest to the block's color that still reads at 4.55:1 (the floor is 4.5:1).
// Contrast only falls as the mix moves toward the block, so the first share that passes, counting down from nearly all the way, is the quietest.
export function tintSoftInk(tint: string, ink = tintInk(tint)): string {
  for (let share = .98; share >= .02; share -= .02) { const soft = mixHex(ink, tint, share); if (contrast(soft, tint) >= 4.55) return soft; }
  return ink;
}
// Which kind of glyph a key shows: a Mac app's own icon, an uploaded or library image, short text, or a built-in symbol.
export function glyphKind(button?: Component): "app" | "image" | "text" | "builtin" {
  if (!button) return "builtin";
  if (appIconReference(button)) return "app";
  const type = button.appearance?.glyph?.type;
  return type === "image" || type === "text" ? type : "builtin";
}
// Built-in symbols and text fill the whole key with its color; app icons and images, and every key with no color (T43), sit on the dark key body.
export const keyFill = (button?: Component): "solid" | "body" =>
  button && button.color !== "none" && (glyphKind(button) === "builtin" || glyphKind(button) === "text") && (button.appearance?.style ?? "tile") === "tile" ? "solid" : "body";
// The default color for a one-color icon that is converted to a key image (an uploaded SVG or an Icon library icon). Images sit on the
// dark key body, so the default is a light neutral, the key color for outline and plain keys, or the custom color as chosen. In Classic the
// image sits on the colored plate and keeps today's rule: dark ink on a color block.
export const BODY_INK = "#F1EFE8";
export function iconInk(button?: Component, theme: ThemeName = activeTheme): string {
  if (!button) return "#FFFFFF";
  const look = button.appearance, tile = (look?.style ?? "tile") === "tile";
  // No color (T43): the dark key body with a neutral light glyph; a custom icon color still colors the glyph.
  if (button.color === "none") return look?.tint ?? BODY_INK;
  if (theme === "classic") return tile ? (look?.tint ? tintInk(look.tint) : "#141414") : look?.tint ?? palette[appearance(button).color];
  return look?.tint ?? (tile ? BODY_INK : themeColor(theme, appearance(button).color, "tone"));
}
const keyVariables = ["--key-color", "--fill", "--ink", "--ink-2", "--tone"];
export function styleKey(target: HTMLElement, button?: Component) {
  const look = button?.appearance;
  target.dataset.iconStyle = look?.style ?? "tile"; target.dataset.iconShape = look?.shape ?? "rounded";
  target.dataset.iconScale = look?.scale ?? "medium"; target.dataset.contentLayout = look?.layout ?? "stacked";
  target.dataset.appDefault = String(!!button && !!appIconReference(button) && !button.color && !look?.tint && !look?.style && !look?.shape);
  target.dataset.glyphKind = glyphKind(button); target.dataset.fill = keyFill(button);
  if (look?.tint && button?.color === "none") {
    // No fill: a custom color only colors the glyph and the outline on the dark body; the neutral inks of the "none" color stay.
    for (const name of keyVariables) target.style.removeProperty(name);
    target.style.setProperty("--tone", look.tint); target.style.setProperty("--key-color", look.tint);
  } else if (look?.tint) {
    const ink = tintInk(look.tint);
    // A custom color is used as chosen: it fills the key (ink chosen by contrast) or draws the glyph and outline on the dark body.
    target.style.setProperty("--key-color", look.tint); target.style.setProperty("--fill", look.tint); target.style.setProperty("--tone", look.tint);
    target.style.setProperty("--ink", ink); target.style.setProperty("--ink-2", tintSoftInk(look.tint, ink));
  } else for (const name of keyVariables) target.style.removeProperty(name);
}
// color is always a real key color (a key with no color still has the default of its icon, which a custom color or a later choice may use);
// shown is what the key is drawn with: that color, or "none" (T43), which the stylesheet draws on the dark key body in neutral inks.
export function appearance(button: Pick<Component, "icon" | "action" | "color">): { symbol: SymbolName; color: KeyColor; shown: KeyColor | "none" } {
  const icon = Object.hasOwn(symbols, button.icon) ? button.icon : "app";
  const calculator = button.icon === "app" && button.action?.type === "app.open" && button.action.appId.toLowerCase() === "com.apple.calculator";
  const color = button.color && button.color !== "none" ? button.color : calculator ? "orange" : colors[icon];
  return { symbol: calculator ? "calculator" : symbols[icon], color, shown: button.color === "none" ? "none" : color };
}
export function actionMeta(button: Component): string {
  return !button.action ? "No action assigned" : button.action.type === "app.open" ? "Open app" :
    button.action.type === "window.activate" ? "Activate window" :
    button.action.type === "shell.run" ? "Run approved script" : button.action.type === "shortcuts.run" ? "Run Mac shortcut" : button.action.type === "workflow.run" ? "Run workflow" : shortcutLabel(button.action);
}
export function actionDescription(button: Component, apps: AppInfo[], scripts: ScriptInfo[] = [], shortcuts:ShortcutInfo[]=[],workflows:Workflow[]=[]): string {
  const action = button.action;
  return action?.type === "app.open" ? apps.find(app => app.id === action.appId)?.name || "Application unavailable" :
    action?.type === "window.activate" ? `${apps.find(app => app.id === action.appId)?.name || "Application unavailable"} · ${action.title}` :
    action?.type === "shell.run" ? scripts.find(script => script.id === action.scriptId && script.version === action.version)?.name || "Script unavailable — select an approved version" :
    action?.type === "shortcuts.run" ? shortcuts.find(shortcut=>shortcut.id===action.shortcutId)?.name||"Mac shortcut unavailable" :
    action?.type === "workflow.run" ? workflows.find(workflow=>workflow.id===action.workflowId)?.name||"Workflow unavailable" :
    action ? `${actionMeta(button)} · Current Mac app` : "No action assigned";
}
export function hydrateIcons() {
  for (const node of document.querySelectorAll<HTMLElement>("[data-ui-icon]")) {
    const name = node.dataset.uiIcon as SymbolName;
    if (Object.hasOwn(iconPaths, name)) setIcon(node, name);
  }
}

// Whether a message from the Mac only repeats the state phrase shown above it (so the readout shows it once): true when every
// word of the message is already in the phrase. Short filler words do not count.
const filler = new Set(["the", "a", "an", "on", "by", "to", "of", "in", "is", "was", "and", "for", "your"]);
const significant = (value: string) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word && !filler.has(word));
export function repeatsPhrase(phrase: string, message: string): boolean {
  const known = new Set(significant(phrase));
  return significant(message).every(word => known.has(word));
}
