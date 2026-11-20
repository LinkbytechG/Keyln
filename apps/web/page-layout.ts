import { Fault, isBlank, isPages, locate, MAX_WIDGETS, widgetSpan, type BlankWidget, type Config, type FlatWidget, type PagesWidget, type SizeTier, type Widget } from "../../packages/contracts/index.js";

// T65: arrays are the one shared order. These pure operations never save or place geometry.
export interface Container { pagesId?: string; pageId?: string }
export const sameContainer = (a: Container, b: Container): boolean => (a.pagesId ?? "") === (b.pagesId ?? "") && (a.pageId ?? "") === (b.pageId ?? "");
const copy = (config: Config): Config => JSON.parse(JSON.stringify(config));
function resolve(config: Config, ref: Container): Widget[] {
  if (!ref.pagesId && !ref.pageId) return config.widgets;
  const group = config.widgets.find(item => item.id === ref.pagesId);
  if (!group || !isPages(group)) throw new Fault("INVALID_INPUT", "Choose a page first.");
  const page = group.pages.find(item => item.id === ref.pageId);
  if (!page) throw new Fault("INVALID_INPUT", "Choose a page first.");
  return page.widgets;
}
export function containerOf(config: Config, id: string): Container | undefined {
  const found = locate(config, id);
  return found ? (found.parent ? { pagesId: found.parent.id, pageId: found.page!.id } : {}) : undefined;
}
export function containerWidgets(config: Config, ref: Container): readonly Widget[] { return resolve(config, ref); }
function target(config: Config, id: string): { widget: Widget; list: Widget[] } {
  const found = locate(config, id);
  if (!found) throw new Fault("INVALID_INPUT", "Select a component first.");
  return { widget: found.widget, list: resolve(config, containerOf(config, id)!) };
}
function insertionIndex(index: number, length: number): number {
  if (!Number.isInteger(index) || index < 0 || index > length) throw new Fault("INVALID_INPUT", "Choose a place in the component order.");
  return index;
}
// ---- T88 (ADR-083): blanks. A blank holds a place of one size in a container's order, so the rest of the container does not reflow when a component leaves it. ----
export const blankOf = (size: SizeTier): BlankWidget => ({ id: `blank-${crypto.randomUUID()}`, kind: "blank", size });
// Trailing blanks are never kept: a change trims them (in place; the caller owns the copy). Blanks in the middle stay until the person removes them.
function trimList(list: Widget[]): void { while (list.length && isBlank(list[list.length - 1]!)) list.pop(); }
function trimNext(next: Config): Config {
  trimList(next.widgets);
  for (const widget of next.widgets) if (isPages(widget)) for (const page of widget.pages) trimList(page.widgets);
  return next;
}
// The same config (not a copy) when nothing trails.
export function trimBlanks(config: Config): Config {
  const trails = (list: readonly Widget[]) => list.length > 0 && isBlank(list[list.length - 1]!);
  if (!trails(config.widgets) && !config.widgets.some(widget => isPages(widget) && widget.pages.some(page => trails(page.widgets)))) return config;
  return trimNext(copy(config));
}
const flat = (widget: Widget): FlatWidget => { if (isPages(widget)) throw new Fault("INVALID_INPUT", "A Pages group keeps moving by insertion: it cannot trade places."); return widget; };
// Swap mode: two flat widgets (keys, display widgets, blanks) trade places, in one container or between a canvas and a page (or two pages). A blank takes the size of the
// component that was in the place it moves to, so the place it leaves behind keeps the size of what left it.
export function swapWidgets(config: Config, id: string, otherId: string): Config {
  if (id === otherId) throw new Fault("INVALID_INPUT", "Choose another component to trade places with.");
  const next = copy(config), a = target(next, id), b = target(next, otherId);
  const fa = flat(a.widget), fb = flat(b.widget), at = a.list.indexOf(a.widget), bt = b.list.indexOf(b.widget);
  a.list[at] = fb; b.list[bt] = fa;
  if (isBlank(fa) && !isBlank(fb)) fa.size = fb.size;
  if (isBlank(fb) && !isBlank(fa)) fb.size = fa.size;
  return trimNext(next);
}
// Swap mode, dropped on a page tab: the component goes to the end of that page and a blank of its size stays where it was.
export function moveToPageSwap(config: Config, id: string, pagesId: string, pageId: string): Config {
  const ref = { pagesId, pageId };
  if (sameContainer(containerOf(config, id) ?? {}, ref)) throw new Fault("INVALID_INPUT", "This component is already on that page.");
  const next = copy(config), { widget, list } = target(next, id), to = resolve(next, ref);
  const moved = flat(widget);
  list.splice(list.indexOf(widget), 1, blankOf(moved.size)); to.push(widget);
  return trimNext(next);
}
// T89: a drop on empty area (ADR-083, amended). `widgets` is the destination order as it will be once the moved component has left its old place (a same-size blank stands there
// when it came from this very list). `place` lays a trial order out the way the surface does and returns every placement in order; `columns` is the surface's column count.
// The moved component is put at order index `index`, after `fills` S blanks, so that it lands EXACTLY on the wanted cell (grid-index units; x is clamped so it fits in the row)
// and every later item keeps its exact cell (nothing reflows). That covers the empty tail after the last item and the holes in front of it (the end of a row where the next
// item wrapped, the room beside a Tall one). No such order exists: nothing is returned and the caller shows the cell as refused. Never a "nearest" cell elsewhere.
export interface EmptyPlan { index: number; fills: number; x: number; y: number }
export function planEmptyDrop(widgets: readonly Widget[], moved: Widget, cell: { x: number; y: number }, place: (trial: Widget[]) => readonly { x: number; y: number }[], columns: number): EmptyPlan | undefined {
  const eps = 1e-6, cols = widgetSpan(moved).cols, want = { x: Math.max(0, Math.min(cell.x, columns - cols)), y: Math.max(0, cell.y) };
  const base = place([...widgets]);
  // The first item that sits after the wanted cell in reading order: the moved one goes right before it (or last).
  let index = widgets.length;
  for (let i = 0; i < widgets.length; i++) { const at = base[i]; if (at && (at.y > want.y + eps || Math.abs(at.y - want.y) <= eps && at.x > want.x + eps)) { index = i; break; } }
  const limit = index === widgets.length ? Math.max(0, Math.min(200, MAX_WIDGETS - widgets.length - 1)) : Math.max(0, columns);
  for (let fills = 0; fills <= limit; fills++) {
    const trial: Widget[] = [...widgets.slice(0, index), ...Array.from({ length: fills }, () => blankOf("S")), moved, ...widgets.slice(index)], out = place(trial), at = out[index + fills];
    if (!at) return undefined;
    const exact = Math.abs(at.x - want.x) <= eps && Math.abs(at.y - want.y) <= eps;
    if (exact && widgets.slice(index).every((_, j) => { const was = base[index + j], now = out[index + fills + 1 + j]; return !!was && !!now && Math.abs(was.x - now.x) <= eps && Math.abs(was.y - now.y) <= eps; })) return { index, fills, x: want.x, y: want.y };
    // Further fills only move it on: past the wanted cell nothing can be exact.
    if (at.y > want.y + eps || Math.abs(at.y - want.y) <= eps && at.x > want.x + eps) return undefined;
  }
  return undefined;
}
// Swap mode, dropped on empty area: the component goes to order index `index` of the destination (or its end), after `fills` S blanks, and a blank of its size stays where it was.
// `index` counts in the destination as it is once the blank stands in the old place (the same list keeps its length).
export function moveToSlot(config: Config, id: string, ref: Container, index: number | "end", fills: number): Config {
  if (!Number.isInteger(fills) || fills < 0 || fills > MAX_WIDGETS) throw new Fault("INVALID_INPUT", "Choose a place in the component order.");
  const next = copy(config), { widget, list } = target(next, id), to = resolve(next, ref);
  const moved = flat(widget);
  list.splice(list.indexOf(widget), 1, blankOf(moved.size));
  const at = index === "end" ? to.length : insertionIndex(index, to.length);
  to.splice(at, 0, ...Array.from({ length: fills }, () => blankOf("S")), widget);
  return trimNext(next);
}
// The component goes to the end of the destination (see moveToSlot).
export const moveToEmpty = (config: Config, id: string, ref: Container, fills: number): Config => moveToSlot(config, id, ref, "end", fills);
// T93 (ADR-084, amended): changing a Pages widget's keys per row from `from` to `to` must not scramble a hand-made arrangement. The order of a page is rewritten so every item keeps the
// cell (row, column) it has under `from`: the items are laid out with `from` columns, taken in (row, column) order, and each is put where it lands on exactly that cell under `to`
// columns, after as many S blanks as it takes to get there (planEmptyDrop on the growing order). Blanks of the old order are dropped (they only held places) and made again as needed.
// An item whose old cell does not fit under `to` (it would leave the row, or no order reaches that cell) goes to the end, in its old (row, column) order. `place` lays a trial order out
// with the given column count the way the page does (grid-index units); the cells do not depend on the width.
export interface ColumnsRebuild { widgets: Widget[]; moved: number }
export function rebuildForColumns(widgets: readonly Widget[], from: number, to: number, place: (trial: Widget[], columns: number) => readonly { x: number; y: number; cols: number }[]): ColumnsRebuild {
  const eps = 1e-6, old = place([...widgets], from);
  const items = widgets.map((widget, index) => ({ widget, index, at: old[index]! })).filter(entry => !isBlank(entry.widget)).sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x || a.index - b.index);
  const result: Widget[] = [], deferred: Widget[] = [], placeTo = (trial: Widget[]) => place(trial, to);
  for (const { widget, at } of items) {
    const plan = at.x + at.cols > to + eps ? undefined : planEmptyDrop(result, widget, { x: at.x, y: at.y }, placeTo, to);
    if (!plan || Math.abs(plan.x - at.x) > eps || Math.abs(plan.y - at.y) > eps) { deferred.push(widget); continue; }
    result.splice(plan.index, 0, ...Array.from({ length: plan.fills }, () => blankOf("S")), widget);
  }
  return { widgets: [...result, ...deferred], moved: deferred.length };
}
// The whole Pages group: every page is rebuilt; `moved` counts the items sent to the end, per page.
export function rebuildPagesColumns(config: Config, pagesId: string, from: number, to: number, place: Parameters<typeof rebuildForColumns>[3]): { config: Config; moved: { page: string; count: number }[] } {
  const next = copy(config), group = pagesTarget(next, pagesId), moved: { page: string; count: number }[] = [];
  for (const page of group.pages) {
    const done = rebuildForColumns(page.widgets, from, to, place);
    page.widgets = done.widgets as typeof page.widgets;
    if (done.moved) moved.push({ page: page.name, count: done.moved });
  }
  return { config: trimNext(next), moved };
}
// A Library item dropped on a blank takes its place.
export function replaceBlank(config: Config, widget: Widget, blankId: string): Config {
  const next = copy(config), found = locate(next, blankId);
  if (!found || !isBlank(found.widget)) throw new Fault("INVALID_INPUT", "Choose an empty place.");
  if (isPages(widget) && found.parent) throw new Fault("INVALID_INPUT", "A Pages widget cannot be placed inside another one.");
  if (locate(next, widget.id)) throw new Fault("INVALID_INPUT", "Duplicate widget ID.");
  const list = resolve(next, containerOf(next, blankId)!);
  list.splice(list.indexOf(found.widget), 1, JSON.parse(JSON.stringify(widget)) as Widget);
  return trimNext(next);
}
// `index` is a boundary in the destination's current order, before removing the dragged widget.
export function moveWidget(config: Config, id: string, ref: Container, index: number): Config {
  const next = copy(config), { widget, list } = target(next, id), to = resolve(next, ref);
  if (ref.pagesId && isPages(widget)) throw new Fault("INVALID_INPUT", "A Pages widget cannot be placed inside another one.");
  let at = insertionIndex(index, to.length);
  const from = list.indexOf(widget);
  if (list === to && from < at) at--;
  list.splice(from, 1); to.splice(at, 0, widget);
  return trimNext(next);
}
export function resizeWidget(config: Config, id: string, size: SizeTier): Config {
  const next = copy(config), { widget } = target(next, id);
  if (isPages(widget)) throw new Fault("INVALID_INPUT", "Pages fill the available area automatically.");
  if (widget.kind === "clock" && size !== "M") throw new Fault("INVALID_INPUT", "Clock has a fixed size.");
  widget.size = size; return next;
}
export function moveToPage(config: Config, id: string, pagesId: string, pageId: string): Config {
  if (sameContainer(containerOf(config, id) ?? {}, { pagesId, pageId })) throw new Fault("INVALID_INPUT", "This component is already on that page.");
  return moveWidget(config, id, { pagesId, pageId }, resolve(config, { pagesId, pageId }).length);
}
export function addWidget(config: Config, widget: Widget, preferred: Container = {}): { config: Config; container: Container } {
  const ref = isPages(widget) ? {} : preferred;
  return { config: addWidgetAt(config, widget, ref, resolve(config, ref).length), container: ref };
}
export function addWidgetAt(config: Config, widget: Widget, ref: Container, index: number): Config {
  const next = copy(config), to = resolve(next, ref);
  if (isPages(widget) && ref.pagesId) throw new Fault("INVALID_INPUT", "A Pages widget cannot be placed inside another one.");
  if (locate(next, widget.id)) throw new Fault("INVALID_INPUT", "Duplicate widget ID.");
  to.splice(insertionIndex(index, to.length), 0, JSON.parse(JSON.stringify(widget)) as Widget); return next;
}
export function removeWidget(config: Config, id: string): Config {
  const next = copy(config), { widget, list } = target(next, id);
  list.splice(list.indexOf(widget), 1); return trimNext(next);
}
function pagesTarget(config: Config, id: string): PagesWidget {
  const widget = config.widgets.find(item => item.id === id);
  if (!widget || !isPages(widget)) throw new Fault("INVALID_INPUT", "Choose a Pages widget first.");
  return widget;
}
export const MAX_PAGES = 16;
export function addPage(config: Config, pagesId: string, name?: string): { config: Config; pageId: string } {
  const next = copy(config), widget = pagesTarget(next, pagesId);
  if (widget.pages.length >= MAX_PAGES) throw new Fault("LAYOUT_SPACE", `A Pages widget holds up to ${MAX_PAGES} pages.`);
  const pageId = `page-${crypto.randomUUID()}`;
  widget.pages.push({ id: pageId, name: name ?? `Page ${widget.pages.length + 1}`, widgets: [] });
  return { config: next, pageId };
}
export function renamePage(config: Config, pagesId: string, pageId: string, name: string): Config {
  const next = copy(config), page = pagesTarget(next, pagesId).pages.find(item => item.id === pageId);
  if (!page) throw new Fault("INVALID_INPUT", "Choose a page first.");
  page.name = name; return next;
}
// The last page cannot be deleted; deleting a page deletes the components on it (the caller asks first).
export function removePage(config: Config, pagesId: string, pageId: string): Config {
  const next = copy(config), widget = pagesTarget(next, pagesId);
  if (widget.pages.length <= 1) throw new Fault("INVALID_INPUT", "The last page cannot be deleted.");
  const index = widget.pages.findIndex(item => item.id === pageId);
  if (index < 0) throw new Fault("INVALID_INPUT", "Choose a page first.");
  widget.pages.splice(index, 1); return next;
}
export function movePage(config: Config, pagesId: string, pageId: string, step: -1 | 1): Config {
  const next = copy(config), pages = pagesTarget(next, pagesId).pages, from = pages.findIndex(item => item.id === pageId), to = from + step;
  if (from < 0 || to < 0 || to >= pages.length) throw new Fault("INVALID_INPUT", "The page cannot move further that way.");
  [pages[from], pages[to]] = [pages[to]!, pages[from]!]; return next;
}
