import { NARROW_MAX_WIDTH, isBlank, isPages, locate, widgetSpan, widgetPresetSpan, GRID_CELL, STANDARD_KEY_U, DEFAULT_PAGES_SIZE, pagesPercentWidth, pagesWidthPercent, sizingContext, resolveWidgetSizeU, sizeToPx, type AppInfo, type GridSize, type Component, type Config, type PagesWidget, type PagesSize, type RunStatus, type ScriptInfo, type ShortcutInfo, type Span, type ThemeName, type Widget } from "../../packages/contracts/index.js";
import { actionDescription, actionMeta, appearance, setKeyIcon, styleKey } from "./presentation.js";
import { shortStatus, tileStatus } from "./themes.js";
import { draggedPagesSize, flowLayout, fractionalContentSize, insertionAt, isSmallKey, snapPagesGridU, type Box, type PagesResizeAxis } from "./page-view.js";
import { moveWidget, swapWidgets, planEmptyDrop, containerWidgets, type Container } from "./page-layout.js";
import type { MoveMode } from "./move-mode.js";
import type { DeskState } from "./widgets/state.js";
import type { WidgetInstance } from "./widgets/registry.js";

export type TileFeedback = RunStatus | "notice" | "sending" | "rejected";
interface ViewState {
  config: Config; apps: AppInfo[]; scripts?: ScriptInfo[]; shortcuts?: ShortcutInfo[];
  // The page each Pages widget shows (widget id -> page id); a widget that is not listed shows its first page.
  pageOf: ReadonlyMap<string, string>;
  availability: "ready" | "connecting" | "offline";
  busy: boolean; sending: boolean; pendingComponentId?: string; hasPending: boolean; unknown: boolean;
  feedback: ReadonlyMap<string, TileFeedback>; details?: ReadonlyMap<string, string>;
  editing: boolean; selectedId?: string; theme: ThemeName;
}
// T63: what a long press or a right click in Edit points at: a widget, or one page tab of a Pages widget.
export type MenuTarget = { kind: "widget"; id: string } | { kind: "tab"; pagesId: string; pageId: string };
// T65: an insertion boundary in a container, a page tab, a forbidden destination, or nothing.
// T88 (ADR-083): in Swap mode a drop can also name the component or blank to trade places with, or an empty cell: the component goes to order index `index` after `fills`
// S blanks and lands on cell (x, y), in grid-index units (T89: exactly there, with nothing after it moving).
export type DropTarget = { container: Container; index: number } | { tab: { pagesId: string; pageId: string } } | { refused: string }
  | { swap: { container: Container; id: string } } | { empty: { container: Container; index: number; fills: number; x: number; y: number } };
interface Options {
  // The responsive canvas surface and its actual theme content viewport.
  grid: HTMLElement; frame: HTMLElement;
  // The room the zones give the canvas (px), when the zones are drawn; undefined: the frame's own box.
  area?: () => { width: number; height: number } | undefined;
  // A display widget (latest result, activity, clock, text, Refresh) made standalone by the page's registry.
  // `standalone` is false for the first view of a kind and form on the canvas: that one carries the element ids other code finds (#result-card, #activity-panel); the rest carry none.
  createWidget: (kind: string, form: string, standalone: boolean) => WidgetInstance | undefined;
  onPage: (pagesId: string, pageId: string) => void;
  onRun: (componentId: string, revision: number) => void;
  // Edit mode: a tap on a component selects it (and opens its popup). Use mode: letting go of a lifted component without moving it does the same.
  onSelect: (componentId: string) => void;
  onEdit: (componentId: string) => void;
  // Use mode. onLift checks whether a component may be lifted now. onDrop gets the insertion boundary or page tab it was
  // dropped on, or nothing for a drop outside. canDropOnPage checks destination rules.
  onLift: (componentId: string) => boolean;
  onDrop: (componentId: string, target: DropTarget | undefined) => void;
  canDropOnPage: (componentId: string, pagesId: string, pageId: string) => boolean;
  // T40: a lift that did not end by the person letting go (the browser took the touch, a second finger, Esc). reason is the event type.
  onLiftStopped?: (componentId: string, reason: string) => void;
  // T63 (ADR-064), Edit mode. The "−" of a widget; a tap on empty canvas; a long press or right click (the quick menu); the "+" after the page tabs;
  // a preview card of the component library dropped on the canvas (target undefined: dropped outside everything).
  onRemove: (componentId: string) => void;
  onBlank: () => void;
  onMenu: (target: MenuTarget, x: number, y: number) => void;
  // The press that opened the menu moved on: the menu goes and the drag begins.
  onMenuDrag: () => void;
  onAddPage: (pagesId: string) => void;
  onDropNew: (spec: unknown, target: DropTarget | undefined) => void;
  onPagesResizeStart?: (id: string) => boolean;
  onPagesResizePreview?: (id: string, size: PagesSize) => void;
  onPagesResizeEnd?: (commit: boolean) => void;
  // T88: how a dragged component lands (this device's setting). Absent: Insert.
  moveMode?: () => MoveMode;
  // True while the screen is being edited by something else. A key then does nothing: no press, no long press, no swipe.
  locked?: () => boolean;
}
type TileNode = HTMLElement & { disabled?: boolean };
// One responsive container and its ephemeral rendered rectangles.
// T89: a run is a stretch of a container laid out as one flow: a page, or the widgets of the canvas between two full-width Pages groups. A drag simulates the same layout
// (`widgets`, `available`, `gap`, `inset`, `height`, `offset` are what fit() gave flowLayout), so an empty cell under the pointer is judged exactly as it is drawn.
// `start` is the run's first index in the container's order; the run covers the vertical range [offset, until) of the container.
interface Run { start: number; widgets: Widget[]; offset: number; until: number; available: number; gap: number; inset: number; insetTop?: number; height: number; pitch: number; columns: number; requested?: number }
// T91: what a Pages widget's "keys per row" did on this screen, for the settings card: the side that applies, the number asked for, and whether it was lifted or held at 44px.
export interface PagesColumnsInfo { side: "wide" | "narrow"; requested?: number; applied: number; raised: boolean; floored: boolean }
interface Surface { key: string; el: HTMLElement; container: Container; pitch: number; rects: Map<string, Box>; runs?: Run[]; columnsInfo?: PagesColumnsInfo }
interface Tile {
  node: TileNode; button?: Component; surface: Surface; rect: { x: number; y: number; w: number; h: number };
  status: HTMLSpanElement; statusText: HTMLSpanElement; icon: HTMLSpanElement; label: HTMLSpanElement; detail: HTMLSpanElement;
}
function span(className: string, value = "") {
  const node = document.createElement("span"); node.className = className; node.textContent = value; return node;
}

// The height of the strip with a Pages widget's page tabs (px); a Pages widget with one page has none. T97: 32px (it was 44px); the 44px touch targets that remain are the resize handles (HANDLE_PX).
export const STRIP_PX = 32;
const HANDLE_PX = 44;
export const EDIT_DRAG_PX = 8;
// Keep page tabs separate from their content, and leave room for Edit's corner targets.
// Shared by both modes so entering Edit does not change the flow's columns or cell size.
const CONTENT_INSET_PX = 14;
// T97 (ADR-088): in a wide window the top-level items keep 1u from the canvas edge (left, right, bottom and below the bar) and 2u from each other when one of them is a Pages widget; the
// key gap stays between other items. u is the nominal px per u of the Grid size (GRID_CELL / 120), rounded to whole px (at least 1px and 2px). A narrow window keeps the old 14px inset.
// The grid frame has no padding in a wide window (zones.ts writes --frame-pad); the canvas edge is this spacing alone.
const FRAME_PAD_NARROW_PX = 4;
export interface TopSpacing { wide: boolean; edge: number; pagesEdge: number; pagesGap: number }
export const topSpacing = (wide: boolean, size: GridSize, keyGap: number): TopSpacing => {
  if (!wide) return { wide, edge: CONTENT_INSET_PX, pagesEdge: 0, pagesGap: keyGap };
  const u = GRID_CELL[size] / STANDARD_KEY_U, edge = Math.max(1, Math.round(u));
  return { wide, edge, pagesEdge: edge, pagesGap: Math.max(2, Math.round(2 * u)) };
};
const place = (node: HTMLElement, rect: { x: number; y: number; w: number; h: number }) => {
  for (const [name, value] of [["--kx", rect.x], ["--ky", rect.y], ["--kw", rect.w], ["--kh", rect.h]] as const) node.style.setProperty(name, String(value));
};

export function createControlDesk(options: Options) {
  let gridKey = "", current: ViewState | undefined;
  let tiles: Tile[] = [];
  let surfaces: Surface[] = [];
  const tabNodes = new Map<string, HTMLElement>();
  const pageScroll = new Map<string, { top: number; left: number }>();
  const displays = new Map<string, { instance: WidgetInstance; key: string; owner: boolean }>();
  let suppressClickUntil = 0, fitKey = "", pitch = 120, fitted = "";
  let swipe: { x: number; y: number; surface: Surface } | undefined;
  // ---- responsive geometry inside the actual content area ----
  // The gap between keys in px, from the canvas's --gap (a length in px once the theme and the breakpoint have chosen it).
  function gapPx(): number {
    if (typeof window.getComputedStyle !== "function") return 0;
    const value = window.getComputedStyle(options.grid).getPropertyValue?.("--gap") ?? "";
    return /^\s*(\d+\.?\d*|\.\d+)px\s*$/.test(value) ? parseFloat(value) : 0;
  }
  // The frame's padding, written by zones.ts as --frame-pad (0 in a wide window, 4px in a narrow one).
  function framePad(): number {
    const value = Number.parseFloat(options.frame.style?.getPropertyValue?.("--frame-pad") ?? "");
    return Number.isFinite(value) ? value : FRAME_PAD_NARROW_PX;
  }
  const spacing = (size: GridSize): TopSpacing => topSpacing(screenSide() === "wide", size, gapPx());
  function areaPx(): { width: number; height: number } | undefined {
    const given = options.area?.();
    const frame = options.frame;
    // client dimensions exclude native scrollbars; the frame's padding (4px, none in a wide window) is on every side.
    const pad = framePad();
    if (frame.clientWidth > 0 && frame.clientHeight > 0) return { width: Math.max(1, frame.clientWidth - pad * 2), height: Math.max(1, frame.clientHeight - pad * 2) };
    if (given && given.width > 0 && given.height > 0) return given;
    if (typeof frame.getBoundingClientRect !== "function") return undefined;
    const box = frame.getBoundingClientRect();
    return box.width > 0 && box.height > 0 ? { width: box.width, height: box.height } : undefined;
  }

  const pagesOf = (config: Config): PagesWidget[] => config.widgets.filter(isPages);
  // T91: wide or narrow by the window width, the same split the theme layouts use; re-read on every fit, nothing is saved by resizing.
  const screenSide = (): "wide" | "narrow" => typeof window.innerWidth === "number" && window.innerWidth > 0 && window.innerWidth <= NARROW_MAX_WIDTH ? "narrow" : "wide";
  const columnsFor = (widget: PagesWidget): number | undefined => widget.columns?.[screenSide()];
  const shownPage = (state: ViewState, widget: PagesWidget) => widget.pages.find(page => page.id === state.pageOf.get(widget.id)) ?? widget.pages[0]!;
  // In Edit the strip is always there: it carries the "+" that adds a page.
  function stripOf(widget: PagesWidget): number { return widget.pages.length > 1 || current?.editing ? STRIP_PX : 0; }
  // The only runtime layout: order -> current container geometry. Nothing here writes configuration.
  function fit(): boolean {
    if (!current) return false;
    const area = areaPx() ?? { width: 800, height: 560 }, gap = gapPx(), config = current.config;
    const key = JSON.stringify([area, gap, config.gridSize, gridKey, screenSide(), framePad()]);
    if (key === fitted) return false;
    if (fitted && lifted) abort("resize");
    fitted = key;
    const canvas = surfaces[0]!; canvas.runs = [];
    const sp = spacing(config.gridSize), edge = sp.edge;
    function placeWidget(surface: Surface, id: string, box: Box) {
      surface.rects.set(id, box);
      const node = Array.from(surface.el.children).find(child => (child as HTMLElement).dataset.widgetId === id || (child as HTMLElement).dataset.buttonId === id) as HTMLElement | undefined;
      const rect = { x: box.left, y: box.top, w: box.width, h: box.height };
      if (node) place(node, rect);
      if (node?.className === "pages-widget") {
        const compact = box.width < HANDLE_PX * 3 || box.height < HANDLE_PX * 3;
        node.dataset.compact = String(compact); node.dataset.tiny = String(box.width < HANDLE_PX || box.height < HANDLE_PX);
        node.tabIndex = current?.editing && compact ? 0 : -1;
        node.setAttribute("aria-label", compact ? "Pages, small frame. Press Enter in Edit to configure its size." : "Pages");
      }
      const tile = tiles.find(tile => tile.button?.id === id); if (tile) tile.rect = rect;
      const minus = Array.from(surface.el.children).find(child => (child as HTMLElement).dataset.removeFor === id) as HTMLElement | undefined;
      // T97: a "−" drawn inward: its 22px disc (centred 8px in from the corner) never goes past the canvas edge, even for an item that sits 1u from it.
      if (minus) place(minus, { ...rect, x: Math.max(rect.x, 3), y: Math.max(rect.y, 3) });
    }
    function placePageContents(widget: PagesWidget, width: number, height: number) {
      const surface = surfaces.find(item => item.key === widget.id)!;
      const body = surface.el.parentElement!;
      const measured = widget.size ? fractionalContentSize(body.getBoundingClientRect(), { width: body.offsetWidth, height: body.offsetHeight }, { width: body.clientWidth, height: body.clientHeight }) : { width: body.clientWidth, height: body.clientHeight };
      const innerWidth = measured.width > 0 ? measured.width : width;
      const innerHeight = measured.height > 0 ? measured.height : Math.max(0, height - stripOf(widget));
      const page = shownPage(current!, widget), requested = columnsFor(widget), layout = flowLayout(page.widgets, innerWidth, config.gridSize, gap, CONTENT_INSET_PX, 0, 0, requested);
      surface.columnsInfo = { side: screenSide(), requested, applied: layout.columns, raised: !!layout.raised, floored: !!layout.floored && layout.overflow };
      surface.pitch = layout.pitch; surface.rects.clear(); surface.runs = [{ start: 0, widgets: page.widgets, offset: 0, until: Infinity, available: innerWidth, gap, inset: CONTENT_INSET_PX, height: 0, pitch: layout.pitch, columns: layout.columns, requested }];
      surface.el.style.setProperty("--cell", `${layout.cell}px`);
      surface.el.style.width = `${layout.width}px`;
      surface.el.style.height = `${Math.max(layout.height, innerHeight)}px`;
      surface.el.dataset.overflow = String(layout.overflow);
      surface.el.setAttribute("aria-description", layout.overflow ? "This area is too narrow for 44 pixel controls. Scroll horizontally to reach every component." : "Components follow shared order. Scroll vertically for more.");
      for (const rect of layout.placements) placeWidget(surface, rect.id, rect);
    }
    // `top` is where the next top-level item starts. A wide window starts 1u below the bar and keeps 2u after anything that involves a Pages widget; a narrow one keeps the old
    // spacing (nothing above the first row, 14px above later runs, the key gap after each item).
    let top = sp.wide ? edge : 0, widest = area.width, canvasBottom = 0, placed = false;
    let segment: Widget[] = [], runStart = 0;
    const runInsetTop = () => !sp.wide && placed ? CONTENT_INSET_PX : 0;
    const after = sp.wide ? sp.pagesGap : gap;
    function flush() {
      if (!segment.length) return;
      const insetTop = runInsetTop();
      const layout = flowLayout(segment, area.width, config.gridSize, gap, edge, area.height, top, undefined, insetTop, sp.pagesGap);
      pitch = canvas.pitch = layout.pitch; widest = Math.max(widest, layout.width);
      canvas.runs!.push({ start: runStart, widgets: segment, offset: top, until: Infinity, available: area.width, gap, inset: edge, insetTop, height: area.height, pitch: layout.pitch, columns: layout.columns });
      for (const rect of layout.placements) {
        placeWidget(canvas, rect.id, { ...rect, top: top + rect.top });
        const node = Array.from(canvas.el.children).find(child => (child as HTMLElement).dataset.widgetId === rect.id || (child as HTMLElement).dataset.buttonId === rect.id) as HTMLElement | undefined;
        node?.style.setProperty("--cell", `${layout.cell}px`);
      }
      canvas.el.style.setProperty("--cell", `${layout.cell}px`);
      for (const widget of segment) if (isPages(widget)) {
        const outer = layout.placements.find(rect => rect.id === widget.id)!;
        placePageContents(widget, outer.width, outer.height);
      }
      // The flow's height ends with its own bottom inset (`edge`); the next item starts after the last row, not after that inset, in a wide window.
      canvasBottom = top + layout.height; top = canvasBottom - (sp.wide ? edge : 0) + after; segment = []; placed = true;
    }
    for (const [at, widget] of config.widgets.entries()) {
      if (!isPages(widget) || widget.size) { if (!segment.length) runStart = at; segment.push(widget); continue; }
      flush();
      const above = canvas.runs!.at(-1); if (above && above.until === Infinity) above.until = top;
      const context = sizingContext(GRID_CELL[config.gridSize] / STANDARD_KEY_U, sp.wide ? sp.pagesGap : gap, { w: area.width - sp.pagesEdge * 2, h: area.height - sp.pagesEdge * 2 });
      const size = sizeToPx(resolveWidgetSizeU(widget, context), context);
      placeWidget(canvas, widget.id, { left: sp.pagesEdge, top, width: size.w, height: size.h });
      placePageContents(widget, size.w, size.h);
      canvasBottom = top + size.h + sp.pagesEdge; top += size.h + after; placed = true;
    }
    // Empty room below the last full-width Pages group (or an empty canvas) is a run of its own, so a component can be dropped there.
    const trailing = !segment.length;
    flush();
    if (trailing) {
      const insetTop = runInsetTop(), empty = flowLayout([], area.width, config.gridSize, gap, edge, area.height, top, undefined, insetTop, sp.pagesGap);
      canvas.runs!.push({ start: config.widgets.length, widgets: [], offset: top, until: Infinity, available: area.width, gap, inset: edge, insetTop, height: area.height, pitch: empty.pitch, columns: empty.columns });
    }
    // Keep the scroll range during a gesture: native scroll clamping while shrinking must not feed back into its pointer delta.
    const canvasWidth = Math.max(widest, pagesDrag?.extent.width ?? 0), canvasHeight = Math.max(area.height, canvasBottom, pagesDrag?.extent.height ?? 0);
    if (pagesDrag) pagesDrag.extent = { width: canvasWidth, height: canvasHeight };
    options.grid.style.width = `${canvasWidth}px`; options.grid.style.height = `${canvasHeight}px`;
    options.grid.dataset.overflow = String(canvasWidth > area.width + .5);
    paintResizeLabels();
    return true;
  }
  // Pages resize in place in the draft. Keep the captured handle and page scroll nodes alive during previews.
  interface PagesDrag { id: string; handle: HTMLElement; node: HTMLElement; pointerId: number; axis: PagesResizeAxis; x: number; y: number; point: { x: number; y: number }; scrollX: number; scrollY: number; size: { w: number; h: number }; modes: PagesSize; scale: number; gap: number; pagesGap: number; edge: number; contentWidth: number; loss: { w: number; h: number }; rightEdge: number; startRight: number; startBottom: number; alt: boolean; frame: { width: number; height: number }; extent: { width: number; height: number }; moved: boolean }
  let pagesDrag: PagesDrag | undefined, resizeScrollTimer: ReturnType<typeof setTimeout> | undefined;
  function pagesGeometry(id: string) {
    if (!current) return undefined;
    const list = current.config.widgets, at = list.findIndex(item => item.id === id), widget = list[at], box = surfaces[0]?.rects.get(id), area = areaPx() ?? { width: 800, height: 560 };
    if (!widget || !isPages(widget) || !box || box.width <= 0 || box.height <= 0) return undefined;
    let first = at, last = at + 1;
    while (first > 0 && !(isPages(list[first - 1]!) && !(list[first - 1] as PagesWidget).size)) first--;
    while (last < list.length && !(isPages(list[last]!) && !(list[last] as PagesWidget).size)) last++;
    const segment = list.slice(first, last).map(item => item.id === id ? { ...widget, size: { w: { mode: "fixed" as const, u: 720 }, h: { mode: "fixed" as const, u: 480 } } } : item);
    const sp = spacing(current.config.gridSize), scale = flowLayout(segment, area.width, current.config.gridSize, gapPx(), sp.edge).cell / STANDARD_KEY_U;
    return { size: { w: box.width / scale, h: box.height / scale }, scale, widthPx: box.width, contentWidthPx: Math.max(1, area.width - sp.edge * 2), gapPx: sp.pagesGap };
  }
  function resizeContext(widget: PagesWidget, node: HTMLElement) {
    const geometry = pagesGeometry(widget.id), box = node.getBoundingClientRect();
    if (!geometry || box.width <= 0 || box.height <= 0) return undefined;
    return { size: { w: box.width / geometry.scale, h: box.height / geometry.scale }, scale: geometry.scale };
  }
  function paintResizeLabels() {
    if (!current?.editing || typeof options.grid.querySelectorAll !== "function") return;
    for (const node of Array.from(options.grid.querySelectorAll<HTMLElement>(":scope>.pages-widget"))) {
      const widget = current.config.widgets.find(item => item.id === node.dataset.widgetId);
      if (!widget || !isPages(widget)) continue;
      const context = resizeContext(widget, node); if (!context) continue;
      const modes = widget.size ?? DEFAULT_PAGES_SIZE;
      const describe = (axis: PagesSize["w"] | PagesSize["h"], actual: number, clamped: boolean) => `${axis.mode === "percent" ? `${axis.pct}%` : axis.mode === "fill" ? "Fill" : "Fixed"} · ${actual}u${clamped ? " (clamped)" : ""}`;
      const text = `${describe(modes.w, Math.round(context.size.w), modes.w.mode === "fixed" && modes.w.u > Math.round(context.size.w))} × ${describe(modes.h, Math.round(context.size.h), false)}`, label = node.querySelector<HTMLElement>(".pages-size-live");
      if (label) { label.textContent = text; label.hidden = pagesDrag?.id !== widget.id; }
      for (const handle of Array.from(node.querySelectorAll<HTMLElement>(".pages-resize-handle"))) handle.setAttribute("aria-label", `Resize Pages ${handle.dataset.axis === "x" ? "width" : handle.dataset.axis === "y" ? "height" : "width and height"}, ${text}. Arrow keys adjust 1 unit; Shift adjusts 10.`);
    }
  }
  function finishPagesResize(commit: boolean, reason = commit ? "release" : "cancel") {
    const done = pagesDrag; if (!done) return;
    pagesDrag = undefined; clearTimeout(resizeScrollTimer); resizeScrollTimer = undefined;
    delete done.node.dataset.resizing; delete options.grid.dataset.resizing;
    options.grid.dataset.resizeEnd = reason;
    try { done.handle.releasePointerCapture?.(done.pointerId); } catch { /* Capture may have been cancelled by the browser. */ }
    suppressClickUntil = Date.now() + 350; gridKey = ""; fitted = "";
    options.onPagesResizeEnd?.(commit);
  }
  function resizeFrameChanged(): boolean {
    if (!pagesDrag) return false;
    const box = options.frame.getBoundingClientRect();
    return Math.abs(box.width - pagesDrag.frame.width) > .5 || Math.abs(box.height - pagesDrag.frame.height) > .5;
  }
  function previewPagesDrag() {
    const drag = pagesDrag; if (!drag?.moved) return;
    const dx = drag.point.x - drag.x + options.frame.scrollLeft - drag.scrollX, dy = drag.point.y - drag.y + options.frame.scrollTop - drag.scrollY;
    const raw = draggedPagesSize(drag.size, dx, dy, drag.scale, drag.axis), frame = options.frame.getBoundingClientRect();
    const size: PagesSize = { ...drag.modes };
    const widget = current?.config.widgets.find(item => item.id === drag.id);
    const page = widget && isPages(widget) && current ? shownPage(current, widget) : undefined;
    const snap = (axis: PagesResizeAxis, value: { w: number; h: number }) => !drag.alt && page && current && !(widget && isPages(widget) && columnsFor(widget)) ? snapPagesGridU(page.widgets, value, drag.scale, current.config.gridSize, drag.gap, CONTENT_INSET_PX, drag.loss, axis) : value;
    const minimum = (value: number) => Math.max(1, Math.min(3840, Math.ceil(value)));
    if (drag.axis !== "y") {
      if (Math.abs(drag.startRight + dx - drag.rightEdge) <= 16) {
        size.w = { mode: "fill", min: minimum(Math.min(drag.contentWidth / drag.scale, drag.size.w + dx / drag.scale)) };
      } else if (drag.modes.w.mode === "percent") {
        const pct = Math.max(1, Math.min(100, Math.round(pagesWidthPercent(drag.size.w * drag.scale + dx, drag.contentWidth, drag.pagesGap))));
        const presets = [25, 33, 50, 67, 75, 100];
        size.w = { mode: "percent", pct: drag.alt ? pct : presets.reduce((a, b) => Math.abs(b - pct) < Math.abs(a - pct) ? b : a) };
      } else size.w = { mode: "fixed", u: snap("x", raw).w };
    }
    if (drag.axis !== "x") {
      const width = size.w.mode === "fixed" ? size.w.u : size.w.mode === "percent" ? pagesPercentWidth(drag.contentWidth, drag.pagesGap, size.w.pct) / drag.scale : raw.w;
      if (Math.abs(drag.startBottom + drag.point.y - drag.y - (frame.bottom - framePad())) <= 16) {
        const top = surfaces[0]?.rects.get(drag.id)?.top ?? 0;
        const natural = Math.max(0, ((areaPx()?.height ?? 560) - drag.edge - top) / drag.scale);
        const cap = Math.max(1, Math.min(3840, Math.floor(natural + 1e-9)));
        const start = drag.size.h <= natural ? minimum(drag.size.h) : 1;
        size.h = { mode: "fill", min: Math.min(cap, Math.max(start, minimum(drag.size.h + dy / drag.scale))) };
      } else size.h = { mode: "fixed", u: snap("y", { w: width, h: raw.h }).h };
    }
    options.onPagesResizePreview?.(drag.id, size);
  }
  function scrollPagesDrag() {
    resizeScrollTimer = undefined; const drag = pagesDrag; if (!drag?.moved) return;
    const box = options.frame.getBoundingClientRect(), edge = 32;
    if (drag.axis !== "y") options.frame.scrollLeft += drag.point.x > box.right - edge ? 12 : drag.point.x < box.left + edge ? -12 : 0;
    if (drag.axis !== "x") options.frame.scrollTop += drag.point.y > box.bottom - edge ? 12 : drag.point.y < box.top + edge ? -12 : 0;
    previewPagesDrag();
    if (pagesDrag) resizeScrollTimer = setTimeout(scrollPagesDrag, 32);
  }
  function resizeHandle(widget: PagesWidget, node: HTMLElement, axis: PagesResizeAxis): HTMLButtonElement {
    const handle = document.createElement("button"), grip = span("pages-resize-grip");
    handle.type = "button"; handle.className = "pages-resize-handle"; handle.dataset.axis = axis; handle.dataset.resizePages = widget.id;
    handle.title = "Drag to resize Pages. Arrow keys: 1u; Shift + arrow: 10u. Esc cancels a drag."; grip.setAttribute("aria-hidden", "true"); handle.append(grip);
    handle.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); });
    handle.addEventListener("contextmenu", event => { event.preventDefault(); event.stopPropagation(); });
    handle.addEventListener("pointerdown", event => {
      event.stopPropagation();
      if (!current?.editing || current.sending || !event.isPrimary || event.button !== 0 || lifted || pagesDrag || options.locked?.()) return;
      const active = current.config.widgets.find(item => item.id === widget.id);
      if (!active || !isPages(active)) return;
      const context = resizeContext(active, node); if (!context) return;
      event.preventDefault(); clearEditPress();
      const box = options.frame.getBoundingClientRect(), canvas = options.grid.getBoundingClientRect();
      const surface = surfaces.find(item => item.key === widget.id), body = surface?.el.parentElement, outer = node.getBoundingClientRect(), gap = gapPx();
      const measured = body ? fractionalContentSize(body.getBoundingClientRect(), { width: body.offsetWidth, height: body.offsetHeight }, { width: body.clientWidth, height: body.clientHeight }) : undefined;
      const innerWidth = measured && measured.width > 0 ? measured.width : outer.width, innerHeight = measured && measured.height > 0 ? measured.height : Math.max(0, outer.height - stripOf(active));
      const loss = { w: Math.max(0, outer.width - innerWidth), h: Math.max(0, outer.height - innerHeight) };
      const sp = spacing(current.config.gridSize), contentWidth = Math.max(1, (areaPx()?.width ?? box.width) - sp.edge * 2);
      const rightEdge = canvas.left + sp.edge + contentWidth;
      pagesDrag = { id: widget.id, node, handle, pointerId: event.pointerId, axis, x: event.clientX, y: event.clientY, point: { x: event.clientX, y: event.clientY }, scrollX: options.frame.scrollLeft, scrollY: options.frame.scrollTop, size: context.size, modes: { ...(active.size ?? DEFAULT_PAGES_SIZE) }, scale: context.scale, gap, pagesGap: sp.pagesGap, edge: sp.edge, contentWidth, loss, rightEdge, startRight: outer.right, startBottom: outer.bottom, alt: event.altKey, frame: { width: box.width, height: box.height }, extent: { width: canvas.width, height: canvas.height }, moved: false };
      if (!options.onPagesResizeStart?.(widget.id)) { pagesDrag = undefined; return; }
      node.dataset.resizing = "true"; options.grid.dataset.resizing = "true";
      delete options.grid.dataset.resizeEnd;
      handle.focus(); try { handle.setPointerCapture?.(event.pointerId); } catch { finishPagesResize(false, "capture"); }
    });
    handle.addEventListener("lostpointercapture", () => { if (pagesDrag?.handle === handle) finishPagesResize(false, "capture"); });
    handle.addEventListener("keydown", event => {
      if (!current?.editing || pagesDrag || lifted || options.locked?.() || event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key, step = event.shiftKey ? 10 : 1;
      const dx = axis !== "y" ? key === "ArrowRight" ? step : key === "ArrowLeft" ? -step : 0 : 0;
      const dy = axis !== "x" ? key === "ArrowDown" ? step : key === "ArrowUp" ? -step : 0 : 0;
      if (!dx && !dy) return;
      event.preventDefault(); event.stopPropagation();
      const active = current.config.widgets.find(item => item.id === widget.id);
      if (!active || !isPages(active)) return;
      const context = resizeContext(active, node); if (!context || !options.onPagesResizeStart?.(widget.id)) return;
      const size = { ...(active.size ?? DEFAULT_PAGES_SIZE) }, next = draggedPagesSize(context.size, dx, dy, 1, axis);
      if (dx) size.w = size.w.mode === "percent" ? { mode: "percent", pct: Math.max(1, Math.min(100, size.w.pct + dx)) } : { mode: "fixed", u: next.w };
      if (dy) size.h = { mode: "fixed", u: next.h };
      options.onPagesResizePreview?.(widget.id, size);
      options.onPagesResizeEnd?.(true);
      if (typeof options.grid.querySelector === "function") {
        const group = options.grid.querySelector<HTMLElement>(`[data-widget-id="${widget.id}"]`);
        if (group?.dataset.tiny === "true") group.focus();
        else group?.querySelector<HTMLElement>(`[data-axis="${group.dataset.compact === "true" ? "xy" : axis}"]`)?.focus();
      }
    });
    return handle;
  }
  if (typeof document.addEventListener === "function") {
    document.addEventListener("pointermove", event => {
      const drag = pagesDrag; if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault(); drag.point = { x: event.clientX, y: event.clientY }; drag.alt = event.altKey;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3) return;
      drag.moved = true; previewPagesDrag();
      if (pagesDrag && resizeScrollTimer === undefined) resizeScrollTimer = setTimeout(scrollPagesDrag, 32);
    });
    document.addEventListener("pointerup", event => {
      if (pagesDrag?.pointerId !== event.pointerId) return;
      pagesDrag.point = { x: event.clientX, y: event.clientY }; pagesDrag.alt = event.altKey;
      if (Math.hypot(event.clientX - pagesDrag.x, event.clientY - pagesDrag.y) >= 3) pagesDrag.moved = true;
      previewPagesDrag(); finishPagesResize(true);
    });
    document.addEventListener("pointercancel", event => { if (pagesDrag?.pointerId === event.pointerId) finishPagesResize(false, "pointercancel"); });
    document.addEventListener("pointerdown", event => { if (pagesDrag && event.pointerId !== pagesDrag.pointerId) finishPagesResize(false, "second-pointer"); }, { capture: true });
    document.addEventListener("keydown", event => { if (pagesDrag && event.key === "Escape") { event.preventDefault(); finishPagesResize(false, "escape"); } });
    document.addEventListener("visibilitychange", () => { if (document.hidden) finishPagesResize(false, "hidden"); });
  }
  if (typeof window.addEventListener === "function") window.addEventListener("blur", () => finishPagesResize(false, "blur"));
  // ---- long press lifts in Use; both modes preview insertion in shared order ----
  type Hover = { target: Extract<DropTarget, { container: Container; index: number }>; surface: Surface; same: boolean; refused?: string } | { swap: { container: Container; id: string }; surface: Surface; refused?: string } | { empty: { container: Container; index: number; fills: number; x: number; y: number }; surface: Surface; span: Span; cell: { offset: number; inset: number; insetTop: number; pitch: number; gap: number }; refused?: string } | { tab: { pagesId: string; pageId: string }; same: boolean } | { same: true } | { outside: true } | undefined;
  interface Lift { node: HTMLElement; id: string; span: Span; external?: { spec: unknown }; pointerId: number; ox: number; oy: number; grab: { x: number; y: number }; moved: boolean; touch: boolean; surface: Surface; layer?: HTMLElement; ghost?: HTMLElement; touchId?: number; interrupted?: string }
  let lifted: Lift | undefined;
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  let dragPoint: { x: number; y: number } | undefined;
  function edgeScroll() {
    scrollTimer = undefined;
    if (!lifted || !dragPoint) return;
    const { x, y } = dragPoint;
    const inner = surfaces.find(surface => surface.container.pagesId && surface.container.pagesId !== lifted!.id && inBox(surface.el.parentElement!, x, y));
    const scroller = inner?.el.parentElement ?? options.frame;
    if (typeof scroller.getBoundingClientRect === "function" && inBox(scroller, x, y)) {
      const box = scroller.getBoundingClientRect(), edge = Math.min(48, box.height / 4);
      const dy = y < box.top + edge ? -16 : y > box.bottom - edge ? 16 : 0;
      if (dy) {
        const before = scroller.scrollTop; scroller.scrollTop += dy;
        if (scroller !== options.frame && scroller.scrollTop === before) options.frame.scrollTop += dy;
        markHover(hoverAt(x, y));
      }
    }
    scrollTimer = setTimeout(edgeScroll, 32);
  }
  const inBox = (node: HTMLElement, x: number, y: number) => {
    if (!node.isConnected || typeof node.getBoundingClientRect !== "function") return false;
    const box = node.getBoundingClientRect();
    return box.width > 0 && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  };
  // Page tabs are checked first, then the grid of a Pages widget, then the canvas.
  function hoverAt(x: number, y: number): Hover {
    if (!current || !lifted) return undefined;
    if (!inBox(options.frame, x, y)) return { outside: true };
    const config = current.config, here = lifted.surface.container;
    for (const [key, tab] of tabNodes) {
      if (!inBox(tab, x, y) || !inBox(tab.parentElement!, x, y)) continue;
      const [pagesId, pageId] = key.split("/") as [string, string];
      return { tab: { pagesId, pageId }, same: here.pagesId === pagesId && here.pageId === pageId };
    }
    for (const surface of surfaces) {
      if (!surface.container.pagesId || surface.container.pagesId === lifted.id || !inBox(surface.el, x, y) || !inBox(surface.el.parentElement!, x, y)) continue;
      return landing(surface, x, y);
    }
    for (const widget of pagesOf(config)) {
      if (widget.id === lifted.id) continue;
      const node = options.grid.querySelector?.(`[data-widget-id="${widget.id}"]`) as HTMLElement | null | undefined;
      if (node && inBox(node, x, y)) return { outside: true };
    }
    const canvas = surfaces[0]!;
    if (!inBox(options.frame, x, y)) return { outside: true };
    return landing(canvas, x, y);
  }
  const nodeOf = (surface: Surface, id: string) => Array.from(surface.el.children).find(child => (child as HTMLElement).dataset.widgetId === id || (child as HTMLElement).dataset.buttonId === id) as HTMLElement | undefined;
  // T88 (ADR-083), Swap mode. Over a component or blank: trade places with it (a Library item only replaces a blank). Over empty area inside a run of the container (T89):
  // a dashed cell where it would land, or a refused cell when it cannot land exactly there without moving anything else. Pages groups and Library Pages keep Insert behavior;
  // anything else returns nothing and the Insert landing follows.
  function swapLanding(surface: Surface, x: number, y: number): Hover | undefined {
    if (!lifted || !current) return undefined;
    const config = current.config, moved = lifted, movedWidget = moved.id ? locate(config, moved.id)?.widget : undefined;
    if (movedWidget && isPages(movedWidget) || !moved.id && (moved.external?.spec as { type?: string } | undefined)?.type === "pages") return undefined;
    const widgets = containerWidgets(config, surface.container), slack = gapPx() / 2;
    const over = (widget: Widget): Hover | undefined => {
      if (widget.id === moved.id) return { same: true };
      if (isPages(widget)) return undefined;
      if (moved.external) return isBlank(widget) ? { swap: { container: surface.container, id: widget.id }, surface } : undefined;
      let refused: string | undefined;
      try { swapWidgets(config, moved.id, widget.id); } catch (error) { refused = (error as Error).message; }
      return { swap: { container: surface.container, id: widget.id }, surface, ...(refused ? { refused } : {}) };
    };
    const hit = widgets.find(widget => {
      const box = nodeOf(surface, widget.id)?.getBoundingClientRect();
      return !!box && box.width > 0 && x >= box.left - slack && x <= box.left + box.width + slack && y >= box.top - slack && y <= box.top + box.height + slack;
    });
    if (hit) return over(hit);
    if (moved.external || !movedWidget) return undefined;
    const box = surface.el.getBoundingClientRect(), rx = x - box.left, ry = y - box.top;
    if (!surface.runs?.length || box.width <= 0 || x < box.left || x > box.right || y < box.top || y > box.bottom) return undefined;
    const eps = 1e-6, run = surface.runs.find(item => ry >= item.offset - eps && ry < item.until) ?? (ry < surface.runs[0]!.offset ? undefined : surface.runs.at(-1));
    if (!run || run.pitch <= 0) return undefined;
    const place = (trial: Widget[]) => flowLayout(trial, run.available, config.gridSize, run.gap, run.inset, run.height, run.offset, run.requested, run.insetTop ?? run.inset).placements;
    const span = moved.span, cell = (value: number) => Math.floor(value / run.pitch + eps);
    const under = { x: Math.max(0, cell(rx - run.inset)), y: Math.max(0, cell(ry - run.offset - (run.insetTop ?? run.inset))) };
    // A cell inside an item's footprint (the inset around the items, say) belongs to that item.
    const now = place(run.widgets), owner = now.findIndex(at => under.x >= at.x - eps && under.x < at.x + at.cols - eps && under.y >= at.y - eps && under.y < at.y + at.rows - eps);
    if (owner >= 0) return over(run.widgets[owner]!);
    // The leftover at the right edge is the last column, and a wide item is pulled left to where it fits.
    const want = { x: Math.max(0, Math.min(under.x, run.columns - span.cols)), y: under.y };
    // The run as it will be: a blank of the moved size stands where the component left it.
    const rest = run.widgets.map(widget => widget.id === moved.id ? { id: "left-behind", kind: "blank", size: movedWidget.size } as Widget : widget);
    const plan = planEmptyDrop(rest, movedWidget, want, place, run.columns), cellBox = { offset: run.offset, inset: run.inset, insetTop: run.insetTop ?? run.inset, pitch: run.pitch, gap: run.gap };
    return plan ? { empty: { container: surface.container, index: run.start + plan.index, fills: plan.fills, x: plan.x, y: plan.y }, surface, span, cell: cellBox }
      : { empty: { container: surface.container, index: 0, fills: 0, x: want.x, y: want.y }, surface, span, cell: cellBox, refused: "Not enough room here." };
  }
  function landing(surface: Surface, x: number, y: number): Hover {
    if (!lifted || !current) return { outside: true };
    if (options.moveMode?.() === "swap") { const found = swapLanding(surface, x, y); if (found) return found; }
    const widgets = containerWidgets(current.config, surface.container);
    const boxes = widgets.map(widget => {
      const node = Array.from(surface.el.children).find(child => (child as HTMLElement).dataset.widgetId === widget.id || (child as HTMLElement).dataset.buttonId === widget.id) as HTMLElement | undefined;
      const box = node?.getBoundingClientRect();
      return box ? { left: box.left, top: box.top, width: box.width, height: box.height } : { left: 0, top: 0, width: 0, height: 0 };
    });
    const index = insertionAt(boxes, x, y), from = widgets.findIndex(widget => widget.id === lifted!.id);
    const same = from >= 0 && (index === from || index === from + 1);
    let refused: string | undefined;
    if (surface.container.pagesId && (lifted.external?.spec as { type?: string } | undefined)?.type === "pages") refused = "A Pages widget cannot be placed inside another one.";
    else if (!same && lifted.id) { try { moveWidget(current.config, lifted.id, surface.container, index); } catch (error) { refused = (error as Error).message; } }
    return { target: { container: surface.container, index }, surface, same, ...(refused ? { refused } : {}) };
  }
  let marked: HTMLElement[] = [];
  function markHover(hover: Hover) {
    for (const node of marked) delete node.dataset.dropTarget;
    marked = [];
    const ghost = lifted?.ghost;
    if (hover && "swap" in hover) {
      const node = nodeOf(hover.surface, hover.swap.id);
      if (node && !hover.refused) { node.dataset.dropTarget = "true"; marked.push(node); }
    }
    if (ghost) {
      if (hover && "empty" in hover) {
        // The same inset, pitch and run offset as the layout, so the cell sits exactly where the item would be drawn.
        const { offset, inset, insetTop, pitch, gap } = hover.cell;
        if (ghost.parentElement !== hover.surface.el) hover.surface.el.append(ghost);
        ghost.dataset.shape = "cell"; ghost.dataset.refused = String(!!hover.refused);
        ghost.style.left = `${inset + hover.empty.x * pitch}px`; ghost.style.top = `${offset + insetTop + hover.empty.y * pitch}px`;
        ghost.style.width = `${hover.span.cols * pitch - gap}px`; ghost.style.height = `${hover.span.rows * pitch - gap}px`;
        ghost.hidden = false;
      } else if (hover && "target" in hover) {
        delete ghost.dataset.shape;
        const widgets = containerWidgets(current!.config, hover.surface.container), index = hover.target.index;
        const before = widgets[index], after = widgets[index - 1];
        const box = before ? hover.surface.rects.get(before.id) : after ? hover.surface.rects.get(after.id) : undefined;
        if (ghost.parentElement !== hover.surface.el) hover.surface.el.append(ghost);
        const edge = box ? before ? box.left : box.left + box.width : 0;
        const width = parseFloat(hover.surface.el.style.width) || hover.surface.el.clientWidth || 3;
        ghost.style.left = `${Math.max(0, Math.min(width - 3, edge))}px`;
        ghost.style.top = `${box?.top ?? 0}px`; ghost.style.width = "3px"; ghost.style.height = `${box?.height ?? 44}px`;
        ghost.hidden = false; ghost.dataset.refused = String(!!hover.refused);
      } else ghost.hidden = true;
    }
    for (const [key, tab] of tabNodes) {
      const [pagesId, pageId] = key.split("/") as [string, string];
      const over = !!hover && "tab" in hover && hover.tab.pagesId === pagesId && hover.tab.pageId === pageId;
      if (over) {
        tab.dataset.dropTarget = "true";
        if (lifted?.id && !options.canDropOnPage(lifted.id, pagesId, pageId)) tab.dataset.dropRefused = "true"; else delete tab.dataset.dropRefused;
      } else { delete tab.dataset.dropTarget; delete tab.dataset.dropRefused; }
    }
  }
  // A floating copy of the key follows the finger (above it on touch, so the finger does not hide it). It is built in its own one-key grid
  // so the stylesheet draws it exactly like a key, and it lives in <body> so no scrolling frame clips it.
  function placeLayer(lift: Lift, x: number, y: number) {
    if (!lift.layer) return;
    const height = lift.node.getBoundingClientRect().height, width = lift.node.getBoundingClientRect().width;
    lift.layer.style.left = `${Math.round(x - width / 2)}px`; lift.layer.style.top = `${Math.round(lift.touch ? y - height - 28 : y - height / 2)}px`;
  }
  function makeLayer(lift: Lift) {
    if (typeof lift.node.cloneNode !== "function" || typeof lift.node.getBoundingClientRect !== "function" || typeof window.getComputedStyle !== "function") return;
    const box = lift.node.getBoundingClientRect();
    const layer = document.createElement("div"), copy = lift.node.cloneNode(true) as HTMLElement;
    layer.className = "button-grid lift-layer"; layer.setAttribute("aria-hidden", "true"); layer.dataset.coords = "true";
    layer.style.width = `${box.width}px`; layer.style.height = `${box.height}px`;
    layer.style.setProperty("--cell", window.getComputedStyle(lift.node).getPropertyValue("--cell"));
    place(copy, { x: 0, y: 0, w: box.width, h: box.height });
    layer.append(copy); document.body.append(layer); lift.layer = layer; placeLayer(lift, lift.ox, lift.oy);
  }
  function lift(next: Lift) {
    swipe = undefined; lifted = next; clearStop();
    // The canvas and its keys stop panning for new gestures while a key is lifted (T40).
    options.grid.dataset.lifted = "true"; delete options.grid.dataset.liftEnd;
    if (!next.external) makeLayer(next);
    next.node.dataset.lifted = "true";
    // Where it would land: an outline on the grid it hovers.
    if (typeof document.createElement === "function") {
      const ghost = document.createElement("div"); ghost.className = "drop-ghost"; ghost.setAttribute("aria-hidden", "true"); ghost.hidden = true;
      next.surface.el.append(ghost); next.ghost = ghost;
    }
    try { next.node.setPointerCapture?.(next.pointerId); } catch { /* The pointer is already gone; the pointerup that follows is then not ours. */ }
  }
  // reason is the event type that ended the lift; it is left on the grid (data-lift-end) so a report from a device can name it.
  function endLift(reason?: string) {
    const done = lifted; lifted = undefined; clearStop(); clearTimeout(scrollTimer); scrollTimer = undefined; dragPoint = undefined;
    if (!done) return;
    delete options.grid.dataset.lifted; if (reason) options.grid.dataset.liftEnd = done.interrupted ? `${reason} after ${done.interrupted}` : reason;
    delete done.node.dataset.lifted; done.layer?.remove(); done.ghost?.remove();
    for (const node of marked) delete node.dataset.dropTarget; marked = [];
    for (const [, tab] of tabNodes) { delete tab.dataset.dropTarget; delete tab.dataset.dropRefused; }
    try { done.node.releasePointerCapture?.(done.pointerId); } catch { /* Already released. */ }
  }
  function dragLifted(x: number, y: number) {
    const active = lifted; if (!active) return;
    if (!active.moved && Math.hypot(x - active.ox, y - active.oy) > 10) active.moved = true;
    if (!active.moved) return;
    dragPoint = { x, y }; if (scrollTimer === undefined) scrollTimer = setTimeout(edgeScroll, 32);
    placeLayer(active, x, y); markHover(hoverAt(x, y));
  }
  function dropLifted(x: number, y: number, reason = "pointerup") {
    const done = lifted; if (!done) return;
    const hover = done.moved ? hoverAt(x, y) : undefined;
    endLift(reason); suppressClickUntil = Date.now() + 350;
    // A preview card of the component library: the Edit side decides what to add where.
    if (done.external) {
      if (!hover || "outside" in hover || ("same" in hover && !("target" in hover) && !("tab" in hover))) options.onDropNew(done.external.spec, undefined);
      else if ("tab" in hover) options.onDropNew(done.external.spec, { tab: hover.tab });
      else if ("swap" in hover) options.onDropNew(done.external.spec, hover.refused ? { refused: hover.refused } : { swap: hover.swap });
      else if ("target" in hover) options.onDropNew(done.external.spec, hover.refused ? { refused: hover.refused } : hover.target);
      return;
    }
    // Let go without moving: the key's popup opens, as a long press always did.
    if (!done.moved) { if (current?.editing) options.onSelect(done.id); else options.onEdit(done.id); return; }
    if (!hover || "outside" in hover) { options.onDrop(done.id, undefined); return; }
    if ("same" in hover && hover.same && !("target" in hover) && !("tab" in hover)) return;
    if ("tab" in hover) { if (!hover.same) options.onDrop(done.id, { tab: hover.tab }); return; }
    if ("swap" in hover) { options.onDrop(done.id, hover.refused ? { refused: hover.refused } : { swap: hover.swap }); return; }
    if ("empty" in hover) { options.onDrop(done.id, hover.refused ? { refused: hover.refused } : { empty: hover.empty }); return; }
    if (!("target" in hover)) return;
    if (hover.refused) { options.onDrop(done.id, { refused: hover.refused }); return; }
    if (hover.same) return;
    options.onDrop(done.id, hover.target);
  }
  // A lifted key must not scroll the page: the touch-action of the grid is fixed at pointerdown, so the touchmove itself is cancelled.
  options.grid.addEventListener("touchmove", event => { if (lifted && event.cancelable) event.preventDefault(); }, { passive: false });
  // ---- T40: the browser may take a touch away from the key (pointercancel, lostpointercapture; Windows treats press-and-hold as a right-click).
  // A lift therefore does not end there. The same finger is followed on the document, by touch events and by any pointer event that arrives, and
  // only letting go drops. It snaps back on touchcancel with nothing after it, on a second finger, on Esc, and when the grid is rebuilt.
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  function clearStop() { if (stopTimer !== undefined) { clearTimeout(stopTimer); stopTimer = undefined; } }
  function abort(reason: string) {
    const done = lifted; if (!done) return;
    endLift(reason); suppressClickUntil = Date.now() + 350;
    options.onLiftStopped?.(done.id, reason);
  }
  function fingerOf(event: TouchEvent): { x: number; y: number } | undefined {
    const active = lifted; if (!active || !event.changedTouches) return undefined;
    for (const touch of Array.from(event.changedTouches)) {
      if (active.touchId === undefined) active.touchId = touch.identifier;
      if (touch.identifier === active.touchId) return { x: touch.clientX, y: touch.clientY };
    }
    return undefined;
  }
  const ours = (event: PointerEvent) => !!lifted && (event.pointerId === lifted.pointerId || !!lifted.interrupted);
  if (typeof document.addEventListener === "function") {
    document.addEventListener("touchmove", event => {
      if (!lifted) return;
      if (event.cancelable) event.preventDefault();
      const finger = fingerOf(event); if (!finger) return;
      clearStop(); dragLifted(finger.x, finger.y);
    }, { passive: false });
    document.addEventListener("touchend", event => {
      if (!lifted) return;
      const finger = fingerOf(event); if (!finger) return;
      if (event.cancelable) event.preventDefault();
      dropLifted(finger.x, finger.y, "touchend");
    }, { passive: false });
    // touchcancel is not final at once: a pointer or touch event that follows shows the finger is still down.
    document.addEventListener("touchcancel", () => {
      if (!lifted) return;
      clearStop(); stopTimer = setTimeout(() => abort("touchcancel"), 300);
    });
    document.addEventListener("touchstart", event => {
      if (lifted && event.touches && event.touches.length > 1) abort("touchstart");
    });
    document.addEventListener("pointermove", event => { if (ours(event)) { clearStop(); dragLifted(event.clientX, event.clientY); } });
    document.addEventListener("pointerup", event => { if (ours(event)) { clearStop(); dropLifted(event.clientX, event.clientY); } });
    // A new pointer after the browser took the old one means that touch is gone and nothing will drop the key: put it back.
    document.addEventListener("pointerdown", event => { if (lifted?.interrupted && event.pointerId !== lifted.pointerId) abort("pointerdown"); });
    document.addEventListener("keydown", event => { if (lifted && event.key === "Escape") { event.preventDefault(); abort("escape"); } });
  }
  // A swipe on a page of a Pages widget turns that widget's pages. The canvas itself does not swipe.
  function watchSwipe(surface: Surface) {
    surface.el.addEventListener("pointerdown", event => {
      if (event.isPrimary && event.button === 0 && !current?.editing && !options.locked?.()) swipe = { x: event.clientX, y: event.clientY, surface };
    });
    surface.el.addEventListener("pointercancel", () => { swipe = undefined; });
    surface.el.addEventListener("pointerup", event => {
      const start = swipe; swipe = undefined;
      if (!start || start.surface !== surface || !current || current.editing || !surface.container.pagesId) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      suppressClickUntil = Date.now() + 350;
      const widget = current.config.widgets.find(item => item.id === surface.container.pagesId) as PagesWidget | undefined;
      if (!widget) return;
      const index = widget.pages.findIndex(page => page.id === shownPage(current!, widget).id), next = widget.pages[index + (dx < 0 ? 1 : -1)];
      if (next) options.onPage(widget.id, next.id);
    });
  }
  // T58/T62: a key narrower than 80px (its smaller side) is "small" (data-small on the tile, whatever the screen): the stylesheet then draws an 11px name
  // and a larger icon. Keys of 80px and more are unchanged.
  function markSmall(): void {
    for (const tile of tiles) {
      if (typeof tile.node.getBoundingClientRect !== "function") continue;
      const box = tile.node.getBoundingClientRect();
      tile.node.dataset.small = String(box.width > 0 && isSmallKey(box));
    }
  }
  // T102: names are one line at the stylesheet's size (an overlong name ends in an ellipsis), so only the small-key mark is measured.
  function fitLabels() { markSmall(); }

  // Ephemeral rendered pixel boxes, shared by Use and Edit; no display coordinates enter Config.
  function placeTile(tile: Tile) { place(tile.node, tile.rect); }

  const refit = () => { if (resizeFrameChanged()) { finishPagesResize(false, "frame"); return; } fitKey = ""; if (current) { fit(); fitLabels(); } };
  if (typeof ResizeObserver === "function") { new ResizeObserver(refit).observe(options.grid); new ResizeObserver(refit).observe(options.frame); }
  if (typeof document.fonts?.ready?.then === "function") void document.fonts.ready.then(refit);
  // ---- T63: Edit mode gestures (ADR-064). Nothing is selected by a frame or stretched by a handle: a tap opens the widget's settings card, a drag moves it
  // in sequence, and a long press or a right click opens the quick menu. `only` limits the press to one element (the empty part of a page strip). ----
  // The press that may become a drag or a menu. It is followed on the document, not on the element: a mouse that moves quickly leaves the element at once.
  let editPress: { node: HTMLElement; id: string; surface: Surface; x: number; y: number; pointerId: number; touch: boolean; menuShown?: boolean; timer?: ReturnType<typeof setTimeout> } | undefined;
  function clearEditPress() { if (editPress?.timer !== undefined) clearTimeout(editPress.timer); editPress = undefined; }
  function moveEditPress(event: PointerEvent) {
    const start = editPress;
    if (!start || lifted || event.pointerId !== start.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) <= EDIT_DRAG_PX) return;
    // Held first, then moved (the menu is already up): the menu closes and the drag begins, as on a phone's home screen.
    if (start.menuShown) options.onMenuDrag();
    clearEditPress();
    const found = current ? locate(current.config, start.id) : undefined;
    if (!found || !options.onLift(start.id)) return;
    const span = widgetSpan(found.widget);
    lift({ node: start.node, id: start.id, span, pointerId: event.pointerId, ox: event.clientX, oy: event.clientY, moved: true, touch: start.touch, surface: start.surface,
      grab: { x: span.cols / 2, y: span.rows / 2 } });
    dragLifted(event.clientX, event.clientY);
  }
  if (typeof document.addEventListener === "function") {
    document.addEventListener("pointermove", moveEditPress);
    document.addEventListener("pointerup", () => clearEditPress());
    document.addEventListener("pointercancel", () => clearEditPress());
  }
  function watchEdit(node: HTMLElement, id: string, surface: Surface, tap: boolean, only?: HTMLElement) {
    node.addEventListener("pointerdown", event => {
      if (!current?.editing || current.sending || pagesDrag || !event.isPrimary || event.button !== 0 || (only && event.target !== only) || options.locked?.()) return;
      clearEditPress();
      const origin = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, touch: event.pointerType === "touch" || event.pointerType === "pen" };
      editPress = { node, id, surface, ...origin, timer: setTimeout(() => {
        if (editPress?.pointerId !== origin.pointerId || editPress.node !== node) return;
        editPress.timer = undefined; editPress.menuShown = true; suppressClickUntil = Date.now() + 350;
        options.onMenu({ kind: "widget", id }, origin.x, origin.y);
      }, 550) };
    });
    // Tests and some browsers deliver the move to the element itself.
    node.addEventListener("pointermove", event => {
      if (lifted?.node === node && event.pointerId === lifted.pointerId) { dragLifted(event.clientX, event.clientY); return; }
      moveEditPress(event);
    });
    node.addEventListener("pointerup", event => { if (editPress?.node === node) clearEditPress(); if (lifted?.node === node && event.pointerId === lifted.pointerId) dropLifted(event.clientX, event.clientY); });
    node.addEventListener("pointercancel", () => { if (editPress?.node === node) clearEditPress(); if (lifted?.node === node) lifted.interrupted ??= "pointercancel"; });
    node.addEventListener("lostpointercapture", () => { if (lifted?.node === node) lifted.interrupted ??= "lostpointercapture"; });
    node.addEventListener("contextmenu", event => {
      if (!current?.editing) return;
      event.preventDefault(); clearEditPress();
      if (only && event.target !== only) return;
      suppressClickUntil = Date.now() + 350;
      options.onMenu({ kind: "widget", id }, event.clientX ?? 0, event.clientY ?? 0);
    });
    if (tap) node.addEventListener("click", event => {
      if (!current?.editing || options.locked?.() || (only && event.target !== only)) return;
      if (event.detail !== 0 && Date.now() < suppressClickUntil) return;
      options.onSelect(id);
    });
  }
  // The "−" of a widget: a round button at its top-left corner, a sibling of the widget (a key is a <button>, which cannot hold another button).
  function minusFor(id: string, rect: { x: number; y: number; w: number; h: number }, name: string): HTMLButtonElement {
    const minus = document.createElement("button");
    minus.type = "button"; minus.className = "edit-remove"; minus.dataset.removeFor = id;
    minus.setAttribute("aria-label", `Remove ${name || "this component"}`); minus.title = `Remove ${name || "this component"}`;
    place(minus, rect);
    minus.addEventListener("pointerdown", event => { event.stopPropagation(); });
    minus.addEventListener("click", event => { event.stopPropagation(); if (!current?.sending && !options.locked?.()) options.onRemove(id); });
    return minus;
  }
  // A tap on empty canvas, empty page area or the frame around them: nothing opens, an open card closes.
  const blankTap = (self: HTMLElement) => self.addEventListener("click", event => {
    if (!current?.editing || event.target !== self || Date.now() < suppressClickUntil) return;
    options.onBlank();
  });
  blankTap(options.grid); blankTap(options.frame);

  function buildTile(button: Component, order: number, surface: Surface, state: ViewState): Tile {
          const node: TileNode = document.createElement("button");
          (node as HTMLButtonElement).type = "button";
          node.className = "control-tile"; node.dataset.order = String(order);
          const rect = { x: 0, y: 0, w: 0, h: 0 };
          node.dataset.columnSpan = String(widgetPresetSpan(button).cols); node.dataset.rowSpan = String(widgetPresetSpan(button).rows);
          // Tier ratios and the current container cell size determine icon geometry.
          node.style.setProperty("--span-c", String(widgetPresetSpan(button).cols)); node.style.setProperty("--span-r", String(widgetPresetSpan(button).rows));
          node.dataset.buttonId = button.id;
          const top = span("tile-top"), status = span("tile-status"), icon = span("tile-icon"), lamp = span("tile-lamp");
          const label = span("tile-label"), detail = span("tile-detail"), statusText = span("status-text");
          status.append(statusText);
          lamp.setAttribute("aria-hidden", "true");
          top.append(status, lamp);
          icon.setAttribute("aria-hidden", "true"); node.append(top, icon, label, detail);
          const revision = state.config.revision;
          let longPress: ReturnType<typeof setTimeout> | undefined, ignoreClick = false;
          let start: { x: number; y: number } | undefined, pressId = 0, pressTouch = false;
          const release = () => { clearTimeout(longPress); longPress = undefined; delete node.dataset.pressed; };
          node.addEventListener("pointerdown", event => {
            if (!event.isPrimary || event.button !== 0 || options.locked?.()) return;
            ignoreClick = false; start = { x: event.clientX, y: event.clientY }; pressId = event.pointerId; pressTouch = event.pointerType === "touch" || event.pointerType === "pen";
            if (!node.disabled) node.dataset.pressed = "true";
            if (current?.editing || current?.sending) return;
            longPress = setTimeout(() => {
              if (!node.isConnected || !start) return;
              const origin = start; ignoreClick = true; release();
              // A key is lifted: dragging moves it, letting go without moving opens its popup (T39). The finger's place inside it is kept (the grab).
              if (!options.onLift(button.id)) return;
              const span = widgetPresetSpan(button);
              lift({ node, id: button.id, span, pointerId: pressId, ox: origin.x, oy: origin.y, grab: { x: span.cols / 2, y: span.rows / 2 }, moved: false, touch: pressTouch, surface });
            }, 550);
          });
          node.addEventListener("pointermove", event => {
            if (lifted?.node === node && event.pointerId === lifted.pointerId) { dragLifted(event.clientX, event.clientY); return; }
            // Moving after pressing an item makes it no tap and no long press.
            // Motion cancels long-press editing; a native click still decides whether this was a tap.
            if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) release();
          });
          node.addEventListener("pointerup", event => { if (lifted?.node === node && event.pointerId === lifted.pointerId) dropLifted(event.clientX, event.clientY); });
          // T40: the browser taking the touch (pointercancel, lostpointercapture) does not end a lift: the document keeps following the finger.
          node.addEventListener("pointercancel", () => { ignoreClick = true; start = undefined; release(); if (lifted?.node === node) lifted.interrupted ??= "pointercancel"; });
          for (const event of ["pointerup", "pointerleave", "lostpointercapture", "blur"])
            node.addEventListener(event, () => { start = undefined; release(); });
          node.addEventListener("lostpointercapture", () => { if (lifted?.node === node) lifted.interrupted ??= "lostpointercapture"; });
          // Windows turns press-and-hold into a right-click: the menu would take the touch from the lifted key. Use mode never shows one on a key.
          node.addEventListener("contextmenu", event => { if (!current?.editing || ignoreClick) event.preventDefault(); });
          if (state.editing) watchEdit(node, button.id, surface, false);
          // Native click is the only execution source. Gestures select or navigate, never send.
          node.addEventListener("click", event => {
            if (options.locked?.()) return;
            const pointerClick = event.detail !== 0;
            if (pointerClick && Date.now() < suppressClickUntil) return;
            if (pointerClick && ignoreClick) { ignoreClick = false; return; }
            ignoreClick = false;
            if (node.disabled || !node.isConnected) return;
            if (current?.editing) options.onSelect(button.id);
            else options.onRun(button.id, revision);
          });
          return { node, button, surface, rect, status, statusText, icon, label, detail };
  }

  // Builds one ordered container; fit() computes all pixel boxes after attachment.
  function fill(surface: Surface, widgets: readonly Widget[], state: ViewState, nodes: HTMLElement[]) {
    for (const widget of widgets) {
      if (isPages(widget)) {
        nodes.push(buildPages(widget, state));
        continue;
      }
      if ("label" in widget) {
        const tile = buildTile(widget, tiles.length, surface, state);
        tiles.push(tile); nodes.push(tile.node);
        if (state.editing) nodes.push(minusFor(widget.id, tile.rect, widget.label));
        continue;
      }
      if (isBlank(widget)) {
        // T88: a blank takes its place in the flow and shows nothing in Use (not seen, not focusable, not announced); in Edit it is a dashed square that can be dropped on,
        // dragged, and removed with its "−".
        const hole = document.createElement("div");
        hole.className = "canvas-widget"; hole.dataset.widgetId = widget.id; hole.dataset.kind = "blank";
        place(hole, { x: 0, y: 0, w: 0, h: 0 }); nodes.push(hole);
        if (state.editing) {
          hole.dataset.editing = "true"; hole.setAttribute("role", "group"); hole.setAttribute("aria-label", "Empty space");
          watchEdit(hole, widget.id, surface, false);
          nodes.push(minusFor(widget.id, { x: 0, y: 0, w: 0, h: 0 }, "empty space"));
        } else hole.setAttribute("aria-hidden", "true");
        continue;
      }
      const made = displayFor(widget);
      if (!made) continue;
      const wrapper = document.createElement("div");
      wrapper.className = "canvas-widget"; wrapper.dataset.widgetId = widget.id; wrapper.dataset.kind = widget.kind; wrapper.dataset.form = widget.form;
      place(wrapper, { x: 0, y: 0, w: 0, h: 0 });
      wrapper.append(made.element); nodes.push(wrapper);
      if (state.editing) {
        const rect = { x: 0, y: 0, w: 0, h: 0 };
        wrapper.dataset.editing = "true"; wrapper.setAttribute("role", "button"); wrapper.setAttribute("tabindex", "0");
        wrapper.setAttribute("aria-label", `Edit ${widget.kind.replace("-", " ")}. Select to configure`);
        wrapper.addEventListener("keydown", event => { if (event.target === wrapper && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); options.onSelect(widget.id); } });
        watchEdit(wrapper, widget.id, surface, true);
        nodes.push(minusFor(widget.id, rect, widget.kind.replace("-", " ")));
      }
    }
  }
  // Display widgets keep their instance between renders (a clock keeps its timer); one whose kind or form changed is made again.
  const seen = new Set<string>();
  function displayFor(widget: Extract<Widget, { form: string }>): WidgetInstance | undefined {
    const key = `${widget.kind}/${widget.form}`;
    let held = displays.get(widget.id);
    if (held && held.key !== key) { held.instance.destroy(); displays.delete(widget.id); held = undefined; }
    if (!held) {
      const holder = [...displays.entries()].some(([id, other]) => id !== widget.id && other.key === key && other.owner);
      const instance = options.createWidget(widget.kind, widget.form, holder);
      if (!instance) return undefined;
      held = { instance, key, owner: !holder }; displays.set(widget.id, held);
    }
    seen.add(widget.id);
    if (widget.kind === "text") held.instance.words?.(widget.text ?? "");
    held.instance.preset?.(widget.size);
    return held.instance;
  }
  function buildPages(widget: PagesWidget, state: ViewState): HTMLElement {
    const page = shownPage(state, widget), container: Container = { pagesId: widget.id, pageId: page.id };
    const outer = document.createElement("div"), body = document.createElement("div"), surfaceEl = document.createElement("div");
    outer.className = "pages-widget"; outer.dataset.widgetId = widget.id; outer.dataset.pages = String(widget.pages.length);
    outer.setAttribute("role", "group");
    outer.addEventListener("keydown", event => {
      if (event.target !== outer || !current?.editing || options.locked?.() || !["Enter", " "].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); options.onSelect(widget.id);
    });
    place(outer, { x: 0, y: 0, w: 0, h: 0 });
    body.className = "pages-body";
    const scrollKey = `${widget.id}/${page.id}`;
    body.addEventListener("scroll", () => pageScroll.set(scrollKey, { top: body.scrollTop, left: body.scrollLeft }));
    surfaceEl.className = "button-grid pages-surface"; surfaceEl.dataset.coords = "true"; surfaceEl.dataset.pageId = page.id;
    surfaceEl.setAttribute("role", "group"); surfaceEl.setAttribute("aria-label", `${page.name || "Unnamed page"} · scrolling components`);
    const surface: Surface = { key: widget.id, el: surfaceEl, container, pitch, rects: new Map() };
    surfaces.push(surface);
    watchSwipe(surface);
    if (widget.pages.length > 1 || state.editing) {
      const strip = document.createElement("nav");
      strip.className = "pages-strip use-pages"; strip.setAttribute("aria-label", "Pages");
      // The parent control stays fixed while its child page tabs scroll independently.
      const tabs = state.editing ? document.createElement("div") : strip;
      if (state.editing) {
        const owner = document.createElement("div"), label = document.createElement("button");
        owner.className = "pages-owner"; owner.title = "Pages group — drag to move, select to configure";
        label.type = "button"; label.className = "pages-owner-label"; label.textContent = "Pages"; label.setAttribute("aria-label", "Configure Pages");
        const remove = minusFor(widget.id, { x: 0, y: 0, w: 44, h: 44 }, "Pages group and all its pages");
        remove.className = "edit-remove pages-remove";
        owner.append(remove, label); strip.append(owner);
        // Watch the outer widget so lifting preserves its full-size preview.
        watchEdit(outer, widget.id, surfaces[0]!, true, owner);
        watchEdit(outer, widget.id, surfaces[0]!, true, label);
        tabs.className = "pages-tabs"; strip.append(tabs);
      }
      for (const item of widget.pages) {
        const tab = document.createElement("button");
        tab.type = "button"; tab.className = "use-page"; tab.dataset.pageId = item.id; tab.title = item.name;
        tab.setAttribute("aria-label", item.name || "Unnamed page"); tab.setAttribute("aria-pressed", String(item.id === page.id));
        tab.dataset.initial = (Array.from((item.name || "?").trim())[0] ?? "?").toUpperCase();
        tab.textContent = item.name || "Unnamed page";
        tab.addEventListener("click", () => { if (tab.isConnected && !options.locked?.()) options.onPage(widget.id, item.id); });
        tabNodes.set(`${widget.id}/${item.id}`, tab); tabs.append(tab);
        if (state.editing) {
          // A long press or a right click on a tab opens the page menu (rename, delete, move).
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stop = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
          const menu = (x: number, y: number) => { stop(); suppressClickUntil = Date.now() + 350; options.onMenu({ kind: "tab", pagesId: widget.id, pageId: item.id }, x, y); };
          tab.addEventListener("pointerdown", event => { if (!event.isPrimary || event.button !== 0) return; stop(); const x = event.clientX, y = event.clientY; timer = setTimeout(() => menu(x, y), 550); });
          for (const name of ["pointerup", "pointercancel", "pointerleave"]) tab.addEventListener(name, stop);
          tab.addEventListener("contextmenu", event => { event.preventDefault(); menu(event.clientX ?? 0, event.clientY ?? 0); });
        }
      }
      if (state.editing) {
        const add = document.createElement("button");
        add.type = "button"; add.className = "use-page add-page"; add.dataset.addPage = widget.id;
        add.textContent = "+"; add.title = "Add a page"; add.setAttribute("aria-label", "Add a page");
        add.addEventListener("click", () => { if (add.isConnected && !options.locked?.()) options.onAddPage(widget.id); });
        tabs.append(add);
        outer.dataset.editing = "true";
        watchEdit(outer, widget.id, surfaces[0]!, true, strip);
      }
      outer.append(strip);
    }
    const nodes: HTMLElement[] = [];
    fill(surface, page.widgets, state, nodes);
    surfaceEl.replaceChildren(...nodes);
    if (state.editing) { blankTap(surfaceEl); blankTap(body); }
    body.append(surfaceEl); outer.append(body);
    if (state.editing) {
      const value = span("pages-size-live"); value.hidden = true; value.setAttribute("aria-hidden", "true");
      outer.append(value, ...(["x", "y", "xy"] as const).map(axis => resizeHandle(widget, outer, axis)));
    }
    return outer;
  }
  // T63: a preview card of the component library is dragged over the canvas like a lifted widget (it has no id yet). `source` is the card the finger is on.
  function beginExternal(source: HTMLElement, spec: unknown, span: Span, pointer: { pointerId: number; x: number; y: number; touch: boolean }, preview?: HTMLElement) {
    if (!current?.editing || lifted || pagesDrag || options.locked?.() || !surfaces.length) return false;
    lift({ node: source, id: "", span, external: { spec }, pointerId: pointer.pointerId, ox: pointer.x, oy: pointer.y, moved: true, touch: pointer.touch, surface: surfaces[0]!,
      grab: { x: span.cols / 2, y: span.rows / 2 } });
    const active = lifted as Lift | undefined;
    if (preview && active) {
      const layer = document.createElement("div");
      layer.className = "lift-layer shelf-drag"; layer.setAttribute("aria-hidden", "true"); layer.append(preview);
      document.body.append(layer); active.layer = layer; placeLayer(active, pointer.x, pointer.y);
    }
    dragLifted(pointer.x, pointer.y);
    return true;
  }
  return {
    beginExternal,
    pagesGeometry,
    // T91: what the keys-per-row setting of a Pages widget did on this screen (undefined before the first fit).
    pagesColumns: (id: string): PagesColumnsInfo | undefined => surfaces.find(surface => surface.key === id)?.columnsInfo,
    // Draws the canvas for the room it has now (called when the area is resized and when the zones have drawn).
    refit() { if (resizeFrameChanged()) { finishPagesResize(false, "frame"); return; } if (current) { if (fit()) { fitKey = ""; } refit(); } },
    get pitch() { return pitch; },
    // The page tab of each page of each Pages widget, "<widget id>/<page id>" (the drop targets of a lifted key, T39).
    tabs: (): ReadonlyMap<string, HTMLElement> => tabNodes,
    // Every display widget gets the new snapshot of the desk.
    updateWidgets(desk: DeskState) { for (const held of displays.values()) held.instance.update(desk); },
    render(state: ViewState) {
      if (pagesDrag && (!state.editing || state.sending || state.config.gridSize !== current?.config.gridSize || state.theme !== current?.theme || resizeFrameChanged())) { finishPagesResize(false, "view"); return; }
      current = state;
      if (lifted && (state.availability !== "ready" || state.sending)) abort("unavailable");
      const { config } = state;
      // A custom Pages height can sit on the canvas's vertical-overflow boundary.
      // Reserve its native gutter before measuring so scrollbar visibility cannot change the scale back and forth.
      const customPages = config.widgets.some(widget => isPages(widget) && widget.size) ? "true" : "false";
      if (options.frame.dataset.customPages !== customPages) options.frame.dataset.customPages = customPages;
      options.frame.dataset.pagesResizable = String(state.editing && config.widgets.some(isPages));
      // The page tabs are part of what is drawn: renaming, adding, deleting or moving a page that is not showing redraws them too.
      const visible = config.widgets.map(widget => isPages(widget) ? { ...widget, pages: [shownPage(state, widget)], tabs: widget.pages.map(page => [page.id, page.name]) } : widget);
      let rebuilt = false;
      const nextGrid = JSON.stringify([config.revision, config.gridSize, visible, state.editing]);
      if (pagesDrag && nextGrid !== gridKey) { gridKey = nextGrid; fitted = ""; }
      if (nextGrid !== gridKey) {
        rebuilt = true;
        for (const surface of surfaces) if (surface.container.pagesId && surface.el.parentElement) {
          const body = surface.el.parentElement;
          pageScroll.set(`${surface.container.pagesId}/${surface.container.pageId}`, { top: body.scrollTop, left: body.scrollLeft });
        }
        endLift(); gridKey = nextGrid; fitted = ""; tiles = []; tabNodes.clear(); seen.clear();
        const canvas: Surface = { key: "canvas", el: options.grid, container: {}, pitch, rects: new Map() };
        surfaces = [canvas];
        const nodes: HTMLElement[] = [];
        fill(canvas, config.widgets, state, nodes);
        for (const [id, held] of displays) if (!seen.has(id)) { held.instance.destroy(); displays.delete(id); }
        options.grid.replaceChildren(...nodes);
        // The pages' own grids lost their swipe listeners with the old nodes; they were attached while building.
      }
      options.grid.setAttribute("aria-label", `Canvas · ${tiles.length} ${tiles.length === 1 ? "component" : "components"} in shared order`); options.grid.setAttribute("aria-busy", "false");
      // data-coords identifies ephemeral pixel placement; persistent order is the array.
      options.grid.dataset.coords = "true";
      fit();
      if (rebuilt) for (const surface of surfaces) if (surface.container.pagesId && surface.el.parentElement) {
        const held = pageScroll.get(`${surface.container.pagesId}/${surface.container.pageId}`);
        if (held) { surface.el.parentElement.scrollTop = held.top; surface.el.parentElement.scrollLeft = held.left; }
      }
      for (const tile of tiles) {
        placeTile(tile);
        const button = tile.button!;
        const status = button.id === state.pendingComponentId && state.hasPending ?
          state.unknown ? "unknown" : state.feedback.get(button.id) || "sending" :
          state.availability !== "ready" ? state.availability : !button.action ? "unconfigured" :
          state.busy || state.sending || state.hasPending ? "busy" : state.feedback.get(button.id) || "ready";
        tile.node.dataset.state = status;
        tile.node.disabled = state.editing ? state.sending : !button.action || state.availability !== "ready" || state.busy || state.sending || state.hasPending;
        tile.node.dataset.editing = String(state.editing);
        tile.node.setAttribute("aria-pressed", String(state.editing && button.id === state.selectedId));
        if (tile.node.disabled) delete tile.node.dataset.pressed;
        tile.node.setAttribute("aria-busy", String(["sending", "accepted", "running"].includes(status)));
        tile.statusText.textContent = state.editing ? "Edit" : tileStatus(state.theme, status);
        const brief = state.editing ? undefined : shortStatus(state.theme, status);
        if (brief) tile.statusText.dataset.short = brief; else delete tile.statusText.dataset.short;
        const look = appearance(button);
        setKeyIcon(tile.icon, button);
        tile.node.dataset.color = look.shown; styleKey(tile.node, button);
        tile.label.textContent = button.label;
        // The action line stays put in every theme except Classic, which shows the state there as it always did.
        tile.detail.textContent = state.theme !== "classic" || state.editing || status === "ready" ? actionMeta(button) :
          status === "succeeded" ? button.action?.type === "keyboard.shortcut" ? "Sent · just now" : (button.action?.type === "shell.run"||button.action?.type === "shortcuts.run"||button.action?.type === "workflow.run") ? "Ran · just now" : "Opened · just now" :
          state.details?.get(button.id) && ["failed", "notice", "rejected", "unknown"].includes(status) ? state.details.get(button.id)! : tileStatus(state.theme, status);
        const description = actionDescription(button, state.apps, state.scripts,state.shortcuts,state.config.workflows);
        tile.node.setAttribute("aria-label", `${state.editing ? "Edit " : ""}${tile.label.textContent}. ${description}. ${state.editing ? "Select to configure" : tileStatus("braun", status)}`); // plain wording for screen readers in every theme
        tile.node.title = `${tile.label.textContent} · ${description}${state.details?.get(button.id) ? ` · ${state.details.get(button.id)}` : ""}`;
      }
      const nextFit = JSON.stringify([state.theme, gridKey, pitch, tiles.map(tile => tile.label.textContent)]);
      if (nextFit !== fitKey) { fitKey = nextFit; fitLabels(); }
    },
  };
}
