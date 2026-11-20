// T68: design sizes are integer u; one standard key is 120 × 120u.
// Measured containers and theme gaps can be fractional u. Only the final boundary converts to CSS px.
export const STANDARD_KEY_U = 120;
export interface SizeU { readonly w: number; readonly h: number }
export interface RectU extends SizeU { readonly x: number; readonly y: number }
export const PRESET_SIZES = {
  S: { w: 120, h: 120 }, M: { w: 240, h: 120 }, L: { w: 240, h: 240 },
  XL: { w: 480, h: 240 }, Tall: { w: 120, h: 240 }, Wide: { w: 480, h: 120 },
} as const satisfies Readonly<Record<string, SizeU>>;
export type SizeTier = keyof typeof PRESET_SIZES;
export const sizeTiers = Object.keys(PRESET_SIZES) as SizeTier[];
// Custom sizes are declared per component; Pages currently exposes both axes.
export type CustomSizing = false | { readonly axes: "both" | "width" | "height"; readonly min: SizeU; readonly max: SizeU; readonly aspectRatio?: number };
export type SizingDefinition =
  | { readonly policy: "grid-preset" | "exact"; readonly presets: Readonly<Record<SizeTier, SizeU>>; readonly defaultPreset: SizeTier; readonly offeredPresets: readonly SizeTier[]; readonly custom: CustomSizing }
  | { readonly policy: "fill-container"; readonly custom: CustomSizing }
  | { readonly policy: "theme-slot"; readonly defaultSize: SizeU; readonly custom: false };
const grid = (defaultPreset: SizeTier, offeredPresets: readonly SizeTier[]): SizingDefinition => ({ policy: "grid-preset", presets: PRESET_SIZES, defaultPreset, offeredPresets, custom: false });
// Theme forms have integer-u defaults; each theme may supply its own integer-u slot preset.
export const SYSTEM_FORM_SIZES: Readonly<Record<string, SizeU>> = {
  segmented: { w: 148, h: 44 }, icon: { w: 44, h: 44 }, gear: { w: 44, h: 44 },
  capsule: { w: 200, h: 40 }, dot: { w: 24, h: 24 }, "dot-button": { w: 44, h: 44 },
};
const theme = (form: string): SizingDefinition => ({ policy: "theme-slot", defaultSize: SYSTEM_FORM_SIZES[form]!, custom: false });
export const PAGES_SIZE_BOUNDS = { min: { w: 1, h: 1 }, max: { w: 3840, h: 3840 } } as const;
export type PagesWidth = { mode: "fixed"; u: number } | { mode: "fill"; min: number } | { mode: "percent"; pct: number };
export type PagesHeight = { mode: "fixed"; u: number } | { mode: "fill"; min: number };
export interface PagesSize { w: PagesWidth; h: PagesHeight }
export const DEFAULT_PAGES_SIZE: PagesSize = { w: { mode: "fill", min: 240 }, h: { mode: "fill", min: 240 } };
export const COMPONENT_SIZING: Readonly<Record<string, SizingDefinition>> = {
  key: grid("S", ["S", "M", "L", "Tall", "Wide"]),
  // T88: a blank keeps the place of whatever left it, so it takes every size; Edit never offers it as a new item.
  blank: grid("S", ["S", "M", "L", "XL", "Tall", "Wide"]),
  pages: { policy: "fill-container", custom: { axes: "both", ...PAGES_SIZE_BOUNDS } },
  "clock/time": grid("M", ["M"]),
  "codex-usage/quota": grid("L", ["M", "L"]), "claude-usage/quota": grid("L", ["M", "L"]),
  "text/title": grid("M", ["M", "Wide", "XL"]), "text/note": grid("M", ["M", "L", "Wide"]), "refresh/button": grid("M", ["S", "M"]),
  "connection/capsule": theme("capsule"), "connection/dot": theme("dot"), "connection/dot-button": theme("dot-button"),
  "mode-switch/segmented": theme("segmented"), "mode-switch/icon": theme("icon"), "settings/gear": theme("gear"),
};
export function sizingFor(kind: string, form?: string): SizingDefinition {
  const definition = COMPONENT_SIZING[form ? `${kind}/${form}` : kind];
  if (!definition) throw new Error(`No sizing definition for ${kind}${form ? `/${form}` : ""}.`);
  return definition;
}
export function themeSizingFor(form: string): Extract<SizingDefinition, { policy: "theme-slot" }> {
  const found = Object.entries(COMPONENT_SIZING).find(([key, definition]) => key.endsWith(`/${form}`) && definition.policy === "theme-slot")?.[1];
  if (!found || found.policy !== "theme-slot") throw new Error(`No theme sizing definition for ${form}.`);
  return found;
}
export function designSizeU(size: SizeU): SizeU {
  if (![size.w, size.h].every(value => Number.isSafeInteger(value) && value >= 1)) throw new Error("Design sizes must be positive integer u.");
  return { w: size.w, h: size.h };
}
export interface SizingContext { readonly pxPerU: number; readonly gapU: number; readonly availableU: SizeU }
export function sizingContext(pxPerU: number, gapPx = 0, availablePx: SizeU = { w: 0, h: 0 }): SizingContext {
  if (!Number.isFinite(pxPerU) || pxPerU <= 0 || !Number.isFinite(gapPx) || gapPx < 0 || ![availablePx.w, availablePx.h].every(value => Number.isFinite(value) && value >= 0)) throw new Error("Invalid sizing context.");
  return { pxPerU, gapU: gapPx / pxPerU, availableU: { w: availablePx.w / pxPerU, h: availablePx.h / pxPerU } };
}
// Percentages divide the content width together with one inter-widget gap.
export const pagesPercentWidth = (content: number, gap: number, pct: number): number => Math.max(0, (content + gap) * pct / 100 - gap);
export const pagesWidthPercent = (width: number, content: number, gap: number): number => (width + gap) / (content + gap) * 100;
// Theme slots use their integer-u design values at a fixed 1 CSS px/u, independent of Grid size.
export const THEME_CONTEXT = sizingContext(1);
export type SizeRequest =
  | { readonly policy: "grid-preset"; readonly size: SizeU }
  | { readonly policy: "exact" | "theme-slot"; readonly size: SizeU }
  | { readonly policy: "fill-container" };
export function resolveSizeU(request: SizeRequest, context: SizingContext): SizeU {
  if (request.policy === "fill-container") return { ...context.availableU };
  const size = designSizeU(request.size);
  if (request.policy !== "grid-preset") return size;
  if (size.w % STANDARD_KEY_U || size.h % STANDARD_KEY_U) throw new Error("Grid presets must occupy whole standard keys.");
  // A grid preset's logical occupancy includes the gaps between the standard keys it crosses.
  return { w: size.w + (size.w / STANDARD_KEY_U - 1) * context.gapU, h: size.h + (size.h / STANDARD_KEY_U - 1) * context.gapU };
}
export function resolveWidgetSizeU(widget: { kind: string; form?: string; size?: SizeTier | PagesSize }, context: SizingContext): SizeU {
  const definition = sizingFor(widget.kind, widget.form);
  if ((definition.policy === "grid-preset" || definition.policy === "exact")) {
    if (!widget.size || typeof widget.size !== "string") throw new Error("Choose a size preset.");
    return resolveSizeU({ policy: definition.policy, size: definition.presets[widget.size] }, context);
  }
  if (definition.policy === "fill-container") {
    if (!widget.size || typeof widget.size === "string") return resolveSizeU({ policy: "fill-container" }, context);
    const { w, h } = widget.size;
    return { w: w.mode === "fixed" ? Math.min(w.u, context.availableU.w) : w.mode === "percent" ? Math.max(1e-6, pagesPercentWidth(context.availableU.w, context.gapU, w.pct)) : Math.min(w.min, context.availableU.w), h: h.mode === "fixed" ? h.u : Math.max(h.min, context.availableU.h) };
  }
  throw new Error("A theme component needs its theme slot size.");
}
// Remove round-trip noise at integer CSS boundaries without quantizing fractional-u layout.
const cssPx = (value: number): number => Math.abs(value - Math.round(value)) < 1e-9 ? Math.round(value) : value;
export const sizeToPx = (size: SizeU, context: SizingContext): SizeU => ({ w: cssPx(size.w * context.pxPerU), h: cssPx(size.h * context.pxPerU) });
export const rectToPx = (rect: RectU, context: SizingContext): RectU => ({ x: cssPx(rect.x * context.pxPerU), y: cssPx(rect.y * context.pxPerU), ...sizeToPx(rect, context) });
export function widgetPresetU(widget: { kind: string; form?: string; size?: SizeTier }): SizeU {
  const definition = sizingFor(widget.kind, widget.form);
  if ((definition.policy !== "grid-preset" && definition.policy !== "exact") || !widget.size) throw new Error("This component has no grid preset.");
  return definition.presets[widget.size];
}
export const widgetPresetSpan = (widget: { kind: string; form?: string; size?: SizeTier }) => {
  const size = widgetPresetU(widget);
  return { cols: size.w / STANDARD_KEY_U, rows: size.h / STANDARD_KEY_U };
};
export const presetSpan = (tier: SizeTier) => ({ cols: PRESET_SIZES[tier].w / STANDARD_KEY_U, rows: PRESET_SIZES[tier].h / STANDARD_KEY_U });
// Compatibility projections for old imports/migration. The integer-u presets above are the only hand-written dimensions.
export const TIER_SPAN = Object.fromEntries(sizeTiers.map(tier => [tier, presetSpan(tier)])) as Readonly<Record<SizeTier, Readonly<{ cols: number; rows: number }>>>;
export const presetSummary = (tier: SizeTier, component?: { kind: string; form?: string }): string => {
  const span = component ? widgetPresetSpan({ ...component, size: tier }) : presetSpan(tier);
  return `${tier} · ${span.cols}×${span.rows}`;
};
