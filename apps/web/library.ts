import { sizingFor, widgetPresetU, widgetPresetSpan, sizingContext, resolveWidgetSizeU, sizeToPx, presetSummary, type SizeTier, type Span, type PagesSize, type Action, type AppInfo, type AppRecent, type WindowInfo } from "../../packages/contracts/index.js";
import { createAppLibrary } from "./library-apps.js";
import { clockWidget, textWidget } from "./widgets/display.js";
import { codexUsageWidget, claudeUsageWidget } from "./widgets/subscription.js";
import { refreshWidget } from "./widgets/refresh.js";
import type { WidgetContext, WidgetInstance } from "./widgets/registry.js";
import { setIcon, type SymbolName } from "./presentation.js";
import { watchPress } from "./touch-hold.js";

// T63 (ADR-064): the component library at the foot of Edit. The types, the sizes each may use, and the panel that shows them.
// Sizes and forms follow the retained component definitions.
// The format itself accepts every tier (T62); these limits are what Edit offers.
export interface LibraryType { key: string; name: string; note: string; symbol: SymbolName; keywords: string; forms?: Array<{ form: string; name: string }> }
export const LIBRARY_TYPES: readonly LibraryType[] = [
  { key: "app", name: "App", note: "Open a Mac application", symbol: "app-window", keywords: "app application" },
  { key: "other", name: "Other Key", note: "Shortcuts, scripts and workflows", symbol: "keyboard", keywords: "shortcut shell script mac workflow" },
  { key: "pages", name: "Pages", note: "Pages of components", symbol: "layout-grid", keywords: "pages page" },
  { key: "widget", name: "Widget", note: "Clock, text and subscription quota", symbol: "sun", keywords: "widget clock text refresh subscription quota" },
];
export const OTHER_KEY_TABS = [
  { name: "Shortcut", action: "keyboard.shortcut" }, { name: "Shell script", action: "shell.run" },
  { name: "Mac shortcut", action: "shortcuts.run" }, { name: "Workflow", action: "workflow.run" },
] as const;
const WIDGET_TYPES: readonly LibraryType[] = [
  { key: "clock", name: "Clock", note: "Time and date", symbol: "sun", keywords: "" },
  { key: "text", name: "Text", note: "A title or note", symbol: "type", keywords: "", forms: [{ form: "title", name: "Title" }, { form: "note", name: "Note" }] },
  { key: "refresh", name: "Refresh", note: "Reload this page", symbol: "refresh", keywords: "", forms: [{ form: "button", name: "Button" }] },
  { key: "codex-usage", name: "Codex", note: "Subscription remaining quota", symbol: "keyboard", keywords: "", forms: [{ form: "quota", name: "Subscription" }] },
  { key: "claude-usage", name: "Claude Code", note: "Subscription remaining quota", symbol: "keyboard", keywords: "", forms: [{ form: "quota", name: "Subscription" }] },
];
// The definition owns both the preset dimensions and the choices offered by Edit.
export function tiersFor(kind: string, form?: string): readonly SizeTier[] {
  const definition = sizingFor(kind, form);
  return "offeredPresets" in definition ? definition.offeredPresets : [];
}
export function defaultTier(kind: string, form?: string): SizeTier {
  const definition = sizingFor(kind, form);
  return "offeredPresets" in definition ? definition.defaultPreset : "M";
}
// When a form changes, the size stays if the new form allows it, else the allowed size nearest in area.
export function tierAfterFormChange(kind: string, form: string, current: SizeTier): SizeTier {
  const allowed = tiersFor(kind, form);
  if (!allowed.length || allowed.includes(current)) return current;
  const area = (tier: SizeTier) => { const size = widgetPresetU({ kind, form, size: tier }); return size.w * size.h; }, want = area(current);
  return [...allowed].sort((a, b) => Math.abs(area(a) - want) - Math.abs(area(b) - want))[0]!;
}

// What one preview card puts on the canvas.
export interface LibrarySpec { type: string; form?: string; tier?: SizeTier; action?: Action; label?: string; editAction?: Action["type"]; preset?: PagesPreset }
// T91 (ADR-084): the two Pages presets of the Library. Key pages fills the width and height and fits 8 keys to a row (4 on a narrow screen); an Info panel is a fixed 480u wide
// column that fills the height and fits 2 (a Clock is 2 wide).
export type PagesPreset = "keys" | "info";
export const PAGES_PRESETS: Readonly<Record<PagesPreset, { name: string; size: PagesSize; columns: { wide: number; narrow: number } }>> = {
  keys: { name: "Key pages", size: { w: { mode: "fill", min: 240 }, h: { mode: "fill", min: 240 } }, columns: { wide: 8, narrow: 4 } },
  info: { name: "Info panel", size: { w: { mode: "fixed", u: 480 }, h: { mode: "fill", min: 240 } }, columns: { wide: 2, narrow: 2 } },
};
export const specSpan = (spec: LibrarySpec): Span => spec.type === "pages" ? { cols: 4, rows: 2 } : widgetPresetSpan({ kind: spec.type, form: spec.form, size: spec.tier ?? "S" });
export function previewsFor(type: LibraryType): Array<{ spec: LibrarySpec; caption: string }> {
  if (type.key === "pages") return (Object.keys(PAGES_PRESETS) as PagesPreset[]).map(preset => ({ spec: { type: type.key, preset }, caption: PAGES_PRESETS[preset].name }));
  if (type.key === "clock") return [{ spec: { type: "clock", form: "time", tier: "M" }, caption: "Clock" }];
  if (type.forms) return type.forms.flatMap(form => tiersFor(type.key, form.form).map(tier => ({ spec: { type: type.key, form: form.form, tier },
    caption: `${form.name} · ${presetSummary(tier, { kind: type.key, form: form.form }).replace(" · ", " ")}` })));
  return tiersFor(type.key).map(tier => ({ spec: { type: type.key, tier }, caption: presetSummary(tier, { kind: type.key }) }));
}

interface Options {
  apps: () => AppInfo[];
  recent?: () => Promise<AppRecent>;
  online: () => boolean;
  windows: (appId: string) => Promise<WindowInfo[]>;
  // Edit is on and the draft can change.
  editable: () => boolean;
  // A click on a card: append it in shared order (the current page; Pages append to the canvas). Returns the reason when it cannot.
  place: (spec: LibrarySpec) => string | undefined;
  // The finger moved on a card: carry it over the canvas (console.ts). `preview` is the floating copy.
  drag: (source: HTMLElement, spec: LibrarySpec, span: Span, pointer: { pointerId: number; x: number; y: number; touch: boolean }, preview?: HTMLElement) => boolean;
  // A component file (T57): read and checked, then placed.
  inspectFile: (file: File) => Promise<{ info: { name: string; kind: string; componentKind?: string; size: SizeTier; workflows: number }; issues: string[] }>;
  placeFile: (size?: SizeTier) => string | undefined;
  changed: () => void;
}
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => { const made = document.createElement(tag); if (className) made.className = className; if (text) made.textContent = text; return made; };

// Keep navigation local to its horizontal scroller; focusing a rebuilt tab must not move the page or restore the previous tab.
export function revealLibraryTab(tabs: HTMLElement, tab: HTMLElement, focus: boolean) {
  if (focus) tab.focus({ preventScroll: true });
  const frame = tabs.getBoundingClientRect(), box = tab.getBoundingClientRect();
  if (box.left < frame.left) tabs.scrollLeft += box.left - frame.left;
  else if (box.right > frame.right) tabs.scrollLeft += box.right - frame.right;
}

export function createLibrary(options: Options) {
  let shown = false, selected = LIBRARY_TYPES[0]!.key, importing = false;
  const panel = el("shelf-panel"), types = el("shelf-types"), previews = el("shelf-previews"), message = el("shelf-message");
  const importButton = el<HTMLButtonElement>("shelf-import"), fileInput = el<HTMLInputElement>("shelf-import-file");
  const say = (value: string) => { message.textContent = value; };

  let other = 0, widgetType = 0, serial = 0;
  const invalidate = () => { serial++; };
  const appsShelf = createAppLibrary({ ...options, say,
    recent: options.recent ?? (async () => ({ status: "unavailable", appIds: [], message: "Mac app usage observation is unavailable. Apps use name order." })),
    drag: (source, spec, pointer) => options.drag(source, spec, specSpan(spec), pointer) });
  let widgetPreviews: WidgetInstance[] = [];
  function clearWidgetPreviews() { for (const instance of widgetPreviews) instance.destroy(); widgetPreviews = []; }
  const previewContext = (form: string): WidgetContext => ({ form, standalone: true, preview: true,
    intents: { refresh() {}, reconnect() {}, setMode() {} }, create() { throw new Error("Nested preview is unavailable."); } });
  function widgetSample(spec: LibrarySpec): HTMLElement {
    const sample = node("span", "shelf-widget-sample canvas-widget"), size = widgetPresetU({ kind: spec.type, form: spec.form, size: spec.tier ?? "S" });
    const scale = Math.min(84 / 120, 224 / size.w);
    sample.style.width = `${size.w * scale}px`; sample.style.height = `${size.h * scale}px`;
    sample.setAttribute("aria-hidden", "true");
    const context = previewContext(spec.form ?? "");
    if (spec.type === "clock" || spec.type === "text") {
      const instance = (spec.type === "clock" ? clockWidget : textWidget).create(context);
      if (spec.type === "text") instance.words?.(spec.form === "title" ? "Title" : "A note");
      widgetPreviews.push(instance); sample.append(instance.element);
    } else if (spec.type === "codex-usage" || spec.type === "claude-usage") {
      const instance = (spec.type === "codex-usage" ? codexUsageWidget : claudeUsageWidget).create(context);
      // Render the actual preset, then scale the whole preview. Shrinking its layout would hide quota rows in the non-scrollable Library card.
      instance.element.style.width = `${size.w}px`; instance.element.style.height = `${size.h}px`;
      instance.element.style.flex = "none"; instance.element.style.transform = `scale(${scale})`; instance.element.style.transformOrigin = "top left";
      instance.preset?.(spec.tier ?? "L"); widgetPreviews.push(instance); sample.append(instance.element);
    } else if (spec.type === "refresh") {
      // Reuse the Refresh renderer's visual children, but never nest a button or retain its handler/id.
      const instance = refreshWidget.create(context), visual = node("span", "quiet page-refresh");
      visual.append(...Array.from(instance.element.children)); instance.destroy();
      const icon = visual.querySelector?.(".ui-icon"); if (icon) setIcon(icon, "refresh");
      sample.append(visual);
    } else {
      throw new Error(`No library preview renderer for widget "${spec.type}".`);
    }
    return sample;
  }
  // A small drawing of what a Pages preset puts on the canvas: its tab strip and a grid of keys with the preset's own number of columns.
  function pagesSample(preset: PagesPreset): HTMLElement {
    const { columns } = PAGES_PRESETS[preset], frame = node("span", "shelf-pages"), grid = node("span", "shelf-pages-grid");
    frame.dataset.preset = preset; frame.setAttribute("aria-hidden", "true"); grid.style.setProperty("--cols", String(columns.wide));
    for (let index = 0; index < columns.wide * 3; index++) grid.append(node("span", "shelf-pages-key"));
    frame.append(node("span", "shelf-pages-tab"), grid);
    return frame;
  }
  function cards(type: LibraryType) {
    return previewsFor(type).map(({ spec, caption }) => {
      if (selected === "other") spec.editAction = OTHER_KEY_TABS[other]!.action;
      const card = node("button", "shelf-card"), span = specSpan(spec), sample = selected === "widget" ? widgetSample(spec) : node("span", "shelf-sample"), box = node("span", "shelf-box"), glyph = node("span", "shelf-glyph");
      card.type = "button"; card.dataset.libraryType = type.key; card.dataset.span = `${span.cols}x${span.rows}`;
      if (spec.form) card.dataset.form = spec.form;
      if (spec.tier) card.dataset.tier = spec.tier;
      card.setAttribute("aria-label", spec.type === "clock" ? "Add Clock" : `Add ${type.name}, ${caption}`);
      const context = sizingContext(22 / 120, 0, { w: 88, h: 44 });
      const size = sizeToPx(resolveWidgetSizeU({ kind: spec.type, form: spec.form, size: spec.tier ?? "S" }, context), context);
      if (selected === "widget") card.className += " shelf-widget-card";
      else if (spec.type === "pages" && spec.preset) { card.dataset.preset = spec.preset; sample.append(pagesSample(spec.preset)); }
      else {
      box.style.width = `${size.w}px`; box.style.height = `${size.h}px`;
      glyph.setAttribute("aria-hidden", "true"); setIcon(glyph, type.symbol); box.append(glyph); sample.append(box);
      }
      card.append(sample, node("span", "shelf-caption", caption + (spec.type === "codex-usage" || spec.type === "claude-usage" ? " · Sample data" : "")));
      // A press that moves carries a copy over the canvas (by touch, after a hold: T85); a click (or Enter) appends the component in shared order.
      watchPress(card, { enabled: options.editable,
        drag: pointer => options.drag(card, spec, span, pointer, typeof sample.cloneNode === "function" ? sample.cloneNode(true) as HTMLElement : undefined),
        click: () => { if (!options.editable()) return; say(options.place(spec) ?? ""); } });
      return card;
    });
  }
  let rendered = "";
  function render() {
    const focusedTab = (document.activeElement as HTMLElement | null)?.dataset?.libraryTab;
    panel.hidden = !shown;
    appsShelf.render(shown && selected === "app" && !importing);
    if (!shown) { clearWidgetPreviews(); rendered = ""; return; }
    const online = options.online();
    // App heartbeat/connection paints must not detach a pressed or focused card when its visible inputs did not change.
    const next = JSON.stringify([shown, selected, other, widgetType, importing, options.editable(), online, options.apps(), serial]);
    if (next === rendered) return;
    rendered = next;
    clearWidgetPreviews();
    const list = LIBRARY_TYPES;
    if (!list.some(type => type.key === selected) && list[0] && !importing) selected = list[0].key;
    const none = !list.length;
    types.replaceChildren(...list.map(type => {
      const button = node("button", "shelf-type"), name = node("strong", "", type.name), note = node("span", "", type.note);
      button.type = "button"; button.dataset.libraryType = type.key; button.setAttribute("aria-pressed", String(!importing && type.key === selected));
      button.append(name, note);
      button.addEventListener("click", () => { selected = type.key; importing = false; invalidate(); appsShelf.close(); say(""); render(); });
      return button;
    }));
    importButton.setAttribute("aria-pressed", String(importing));
    if (importing) return;
    const type = none ? undefined : LIBRARY_TYPES.find(item => item.key === selected);
    if (selected === "app") return;
    if (selected === "other" || selected === "widget") {
      const tabs = node("div", "shelf-tabs"); tabs.setAttribute("role", "tablist");
      const names = selected === "other" ? OTHER_KEY_TABS.map(tab => tab.name) : WIDGET_TYPES.map(type => type.name);
      names.forEach((name, index) => {
        const tab = node("button", "quiet", name); tab.type = "button"; tab.setAttribute("role", "tab");
        tab.dataset.libraryTab = String(index); tab.setAttribute("aria-selected", String(index === (selected === "other" ? other : widgetType))); tab.tabIndex = index === (selected === "other" ? other : widgetType) ? 0 : -1;
        tab.addEventListener("keydown", event => {
          const key = event.key; if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return; event.preventDefault();
          const next = key === "Home" ? 0 : key === "End" ? names.length - 1 : (index + (key === "ArrowRight" ? 1 : -1) + names.length) % names.length;
          if (selected === "other") other = next; else widgetType = next; render();
          const currentTabs = previews.children[0] as HTMLElement | undefined, active = currentTabs?.children[next] as HTMLElement | undefined;
          if (currentTabs && active) revealLibraryTab(currentTabs, active, true);
        });
        tab.addEventListener("click", () => { if (selected === "other") other = index; else widgetType = index; render(); }); tabs.append(tab);
      });
      const content = selected === "other" ? { key: "key", name: OTHER_KEY_TABS[other]!.name, note: "", symbol: "keyboard" as const, keywords: "" } : WIDGET_TYPES[widgetType]!;
      previews.replaceChildren(tabs, ...cards(content));
      const activeTab = tabs.children[selected === "other" ? other : widgetType] as HTMLElement | undefined;
      if (activeTab) revealLibraryTab(tabs, activeTab, focusedTab !== undefined);
      return;
    }
    previews.replaceChildren(...(type ? cards(type) : []));
  }
  // ---- Import from file…: the file is read and checked first; only then is it added to the draft ----
  importButton.addEventListener("click", () => { if (options.editable()) fileInput.click(); });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0]; fileInput.value = "";
    if (!file || !options.editable()) return;
    importing = true; const ticket = ++serial; say("Reading the file…"); render();
    try {
      const { info, issues } = await options.inspectFile(file);
      if (ticket !== serial || !shown || !importing || !options.editable()) return;
      const box = node("div", "shelf-import"), title = node("strong", "", `${info.kind} “${info.name}” · ${presetSummary(info.size, info.componentKind ? { kind: info.componentKind } : undefined)}`);
      box.append(title);
      if (info.workflows) box.append(node("p", "", `${info.workflows} workflow${info.workflows === 1 ? "" : "s"}`));
      if (issues.length) { const list = node("ul", "shelf-issues"); for (const issue of issues) list.append(node("li", "", issue)); box.append(node("p", "", "Fix these after adding:"), list); }
      const add = node("button", "solid", "Add to the draft"), cancel = node("button", "quiet", "Cancel");
      add.type = "button"; cancel.type = "button"; add.dataset.shelfImportAdd = "true";
      add.addEventListener("click", () => { const problem = options.placeFile(); if (problem) { say(problem); return; } importing = false; say("Added to the draft."); render(); options.changed(); });
      cancel.addEventListener("click", () => { importing = false; say(""); render(); });
      box.append(add, cancel);
      previews.replaceChildren(box); say("");
    } catch (error) { if (ticket !== serial || !shown || !importing || !options.editable()) return; importing = false; say((error as Error).message); render(); }
  });
  render();
  return {
    get open() { return shown; },
    toggle(force?: boolean) { shown = force ?? !shown; if (!shown) invalidate(); render(); options.changed(); },
    render,
    // The panel closes with Edit.
    reset() { if (shown || importing) { shown = false; importing = false; invalidate(); say(""); render(); } },
    say,
  };
}
