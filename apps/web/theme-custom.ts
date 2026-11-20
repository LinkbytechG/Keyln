import { keyColors, type CustomTheme, type KeyColor, type ThemeFont, type ThemeName, type ThemeRadius, type ThemeSpacing } from "../../packages/contracts/index.js";
import { contrast, mixHex } from "./presentation.js";
import { themeColors } from "./themes.js";

// T42: a custom theme is a built-in theme (its base) with a few overrides. Everything the theme does not name (status display, the key fill
// colors --c-*/--i-*/--s-*/--t-*, state colors, the Metro lines…) comes from the base. This file turns the overrides into CSS custom properties and
// checks them for contrast; it draws nothing and touches no DOM, so the Mac layout only ever holds the six small choices of CustomTheme.

// The values each built-in theme has for the tokens a custom theme can override. tests/t42.test.mjs keeps these identical to style.css.
export interface Basics {
  accent: string; background: string; keyBody: string; text: string; muted: string; dim: string; detail: string;
  radius: ThemeRadius; gap: number; font: ThemeFont;
}
export const themeBasics: Record<ThemeName, Basics> = {
  braun: { accent: "#F26B1D", background: "#1A1917", keyBody: "#2A2926", text: "#ECE7DC", muted: "#B8B4AB", dim: "#AEAAA2", detail: "#939088", radius: "rounded", gap: 12, font: "braun" },
  metro: { accent: "#5EB6E4", background: "#1E2124", keyBody: "#2A2E33", text: "#F4F4F2", muted: "#BBBDBD", dim: "#AFB1B1", detail: "#959798", radius: "square", gap: 10, font: "metro" },
  midnight: { accent: "#F2A900", background: "#0E1A33", keyBody: "#15244A", text: "#F1EFE8", muted: "#ADB0B7", dim: "#A2A6AF", detail: "#878E9C", radius: "rounded", gap: 12, font: "midnight" },
  standard: { accent: "#0A84FF", background: "#000000", keyBody: "#1C1C1E", text: "#FFFFFF", muted: "#A9A9A9", dim: "#A0A0A0", detail: "#848485", radius: "round", gap: 12, font: "standard" },
  classic: { accent: "#7CF2B4", background: "#0D0E10", keyBody: "#1A1C21", text: "#EEEFF1", muted: "#A6A7AA", dim: "#9B9DA0", detail: "#848589", radius: "round", gap: 14, font: "classic" },
  widget: { accent: "#5B9CFF", background: "#101216", keyBody: "#1B1E24", text: "#F3F4F6", muted: "#B2B4B7", dim: "#9A9CA0", detail: "#84868A", radius: "round", gap: 12, font: "system" },
};

// Local font stacks only: the page's CSP forbids web fonts. The advances are the average glyph and label widths the key-name fitting uses.
export const fontStacks: Record<ThemeFont, { name: string; stack: string; glyphAdv: string; labelAdv: string }> = {
  braun: { name: "Helvetica Neue", stack: '"Helvetica Neue",Helvetica,Arial,"Segoe UI",sans-serif', glyphAdv: ".55", labelAdv: ".58" },
  metro: { name: "Bahnschrift", stack: '"Bahnschrift","DIN Alternate","Helvetica Neue",Arial,"Segoe UI",sans-serif', glyphAdv: ".52", labelAdv: ".54" },
  midnight: { name: "Segoe UI", stack: '"Segoe UI","Gill Sans","Gill Sans MT","Helvetica Neue",Arial,sans-serif', glyphAdv: ".76", labelAdv: ".6" },
  standard: { name: "San Francisco", stack: '-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif', glyphAdv: ".55", labelAdv: ".56" },
  classic: { name: "Geist", stack: '"Geist",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', glyphAdv: ".6", labelAdv: ".56" },
  system: { name: "System UI", stack: 'system-ui,-apple-system,"Segoe UI","Helvetica Neue",Arial,sans-serif', glyphAdv: ".56", labelAdv: ".58" },
};
export const baseNames: Record<ThemeName, string> = { braun: "Braun", metro: "Metro", midnight: "Midnight", standard: "Standard", classic: "Classic", widget: "Widget" };
export const radiusTokens: Record<ThemeRadius, { key: number; ctl: number; panel: number }> = {
  square: { key: 0, ctl: 0, panel: 0 }, small: { key: 4, ctl: 3, panel: 4 }, rounded: { key: 10, ctl: 8, panel: 10 }, round: { key: 16, ctl: 12, panel: 16 },
};
export const spacingGap = { tight: 6, loose: 16 } as const;
export const accentSwatches = ["#F26B1D", "#E9B93A", "#5EB6E4", "#0A84FF", "#7CF2B4", "#30D158", "#B48CFF", "#E2231A"] as const;

type Look = Pick<CustomTheme, "base" | "accent" | "background" | "keyBody" | "radius" | "spacing" | "font">;
// The properties a custom theme may set on the page. A theme that is not custom clears all of them.
export const customVariables = ["--accent", "--focus", "--accent-ink", "--accent-bg", "--sel", "--bg", "--bar-bg", "--key", "--surface", "--surface-2", "--hair", "--line",
  "--muted", "--dim", "--detail", "--radius-key", "--radius-ctl", "--radius-panel", "--tile-gap", "--font-ui", "--glyph-adv", "--label-adv"] as const;

// 3-digit or 6-digit hex, with or without "#", to #RRGGBB in capitals; anything else is undefined.
export function normalizeHex(input: string): string | undefined {
  const text = input.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(text)) return "#" + Array.from(text).map(char => char + char).join("").toUpperCase();
  return /^[0-9a-fA-F]{6}$/.test(text) ? "#" + text.toUpperCase() : undefined;
}
// The quietest mix of ink toward ground that still reads on every ground at the floor (the way T35 chose the action line): counting down from
// nearly all the way to the ground. An ink that cannot reach the floor is returned as it is.
function quiet(ink: string, ground: string, grounds: readonly string[], floor: number): string {
  for (let share = .98; share >= .02; share -= .02) {
    const mixed = mixHex(ink, ground, share);
    if (grounds.every(on => contrast(mixed, on) >= floor)) return mixed;
  }
  return ink;
}
// Text on the accent (buttons, the "In use" tag): black or white, whichever reads better. No color has less than 4.58:1 with the better of the two.
export const accentInk = (accent: string) => contrast(accent, "#000000") >= contrast(accent, "#FFFFFF") ? "#000000" : "#FFFFFF";
export interface Derived {
  vars: Record<string, string>;
  names: number; pageText: number; detail: number; icons: number; weakGlyphs: KeyColor[];
  blockers: string[]; warnings: string[];
}
// A ratio as the person reads it: cut, never rounded up to a threshold it does not meet.
export const ratioText = (value: number) => `${(Math.floor(value * 10) / 10).toFixed(1)}:1`;

export function deriveTheme(theme: Look): Derived {
  const base = themeBasics[theme.base], vars: Record<string, string> = {};
  const accentChanged = theme.accent !== base.accent, backgroundChanged = theme.background !== base.background, keyChanged = theme.keyBody !== base.keyBody;
  if (accentChanged || backgroundChanged) {
    if (accentChanged) { vars["--accent"] = theme.accent; vars["--focus"] = theme.accent; vars["--accent-ink"] = accentInk(theme.accent); }
    vars["--accent-bg"] = mixHex(theme.background, theme.accent, .14); vars["--sel"] = mixHex(theme.background, theme.accent, .42);
  }
  if (backgroundChanged) { vars["--bg"] = theme.background; vars["--bar-bg"] = mixHex(theme.background, "#000000", .08); }
  const text = base.text;
  let muted = base.muted, dim = base.dim, detail = base.detail;
  if (backgroundChanged || keyChanged) {
    const grounds = [theme.background, theme.keyBody];
    muted = quiet(text, theme.keyBody, grounds, 7); dim = quiet(text, theme.keyBody, grounds, 6); detail = quiet(text, theme.keyBody, grounds, 4.55);
    vars["--muted"] = muted; vars["--dim"] = dim; vars["--detail"] = detail;
  }
  if (keyChanged) {
    vars["--key"] = theme.keyBody; vars["--surface"] = theme.keyBody;
    vars["--surface-2"] = mixHex(theme.keyBody, text, .1); vars["--hair"] = mixHex(theme.keyBody, text, .09);
    // The line must stay visible against both the ground and the key (3:1, the floor for a boundary).
    let line = mixHex(theme.keyBody, text, .38);
    for (let share = .38; share <= 1 && (contrast(line, theme.background) < 3 || contrast(line, theme.keyBody) < 3); share += .04) line = mixHex(theme.keyBody, text, Math.min(1, share));
    vars["--line"] = line;
  }
  if (theme.radius !== base.radius) {
    const radius = radiusTokens[theme.radius];
    vars["--radius-key"] = `${radius.key}px`; vars["--radius-ctl"] = `${radius.ctl}px`; vars["--radius-panel"] = `${radius.panel}px`;
  }
  if (theme.spacing !== "normal") vars["--tile-gap"] = `${spacingGap[theme.spacing]}px`;
  if (theme.font !== base.font) {
    const font = fontStacks[theme.font];
    vars["--font-ui"] = font.stack; vars["--glyph-adv"] = font.glyphAdv; vars["--label-adv"] = font.labelAdv;
  }
  const names = contrast(text, theme.keyBody), pageText = contrast(text, theme.background), detailRatio = contrast(detail, theme.keyBody);
  const glyphs = keyColors.map(color => [color, contrast(themeColors[theme.base].colors[color].tone, theme.keyBody)] as const);
  const weakGlyphs = glyphs.filter(([, ratio]) => ratio < 3).map(([color]) => color);
  const icons = Math.min(...glyphs.map(([, ratio]) => ratio));
  const blockers: string[] = [];
  if (names < 4.5) blockers.push(`Key names would read at ${ratioText(names)} on this key body; they need 4.5:1. Make the key body darker.`);
  if (pageText < 4.5) blockers.push(`Page text would read at ${ratioText(pageText)} on this background; it needs 4.5:1. Make the background darker.`);
  if (names >= 4.5 && detailRatio < 4.5) blockers.push(`The action line would read at ${ratioText(detailRatio)} on this key body; it needs 4.5:1. Make the key body darker.`);
  const warnings = weakGlyphs.length ? [`Some icon colors are faint on this key body (${weakGlyphs.join(", ")}). You can still save.`] : [];
  return { vars, names, pageText, detail: detailRatio, icons, weakGlyphs, blockers, warnings };
}
// The row under the editor: green when readable (with the three ratios), danger-styled when not, always saying what to change.
export function contrastSummary(theme: Look, derived = deriveTheme(theme)): { ok: boolean; text: string } {
  if (derived.blockers.length) return { ok: false, text: derived.blockers.join(" ") };
  const line = `Readable: names ${ratioText(derived.names)}, action line ${ratioText(derived.detail)}, icons ${ratioText(derived.icons)}. Status lamps and bars keep ${baseNames[theme.base]}'s colors.`;
  return { ok: true, text: derived.warnings.length ? `${line} ${derived.warnings.join(" ")}` : line };
}
// A copy of a built-in theme (the starting point of "New theme from this"), or of a custom one.
export function lookOf(source: ThemeName | CustomTheme): Look {
  if (typeof source !== "string") return { base: source.base, accent: source.accent, background: source.background, keyBody: source.keyBody, radius: source.radius, spacing: source.spacing, font: source.font };
  const basics = themeBasics[source];
  return { base: source, accent: basics.accent, background: basics.background, keyBody: basics.keyBody, radius: basics.radius, spacing: "normal" as ThemeSpacing, font: basics.font };
}
// Puts a custom theme's properties on an element (the page, or the preview inside the theme window) and clears the ones an earlier theme set.
export function paintVariables(target: HTMLElement | null | undefined, vars: Record<string, string>) {
  if (!target) return;
  for (const name of customVariables) target.style.removeProperty(name);
  for (const [name, value] of Object.entries(vars)) target.style.setProperty(name, value);
}
