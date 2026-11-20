import { GRID_CELL, STANDARD_KEY_U, PAGES_SIZE_BOUNDS, widgetPresetSpan, widgetSpan, isPages, resolveWidgetSizeU, sizingContext, rectToPx, sizingFor, type RectU, type Widget, type GridSize } from "../../packages/contracts/index.js";
import type { PagesWidget } from "../../packages/contracts/index.js";

export interface Box { left: number; top: number; width: number; height: number }
export interface FlowPlacement extends Box { id: string; x: number; y: number; cols: number; rows: number }
// raised / floored are only set with a fixed column count (T91): the count was lifted to the widest item, or the cell was held at 44px (the flow then scrolls sideways).
export interface FlowLayout { placements: FlowPlacement[]; columns: number; cell: number; pitch: number; width: number; height: number; overflow: boolean; raised?: boolean; floored?: boolean }
export interface FlowRectU extends RectU { readonly id: string }
export type PagesResizeAxis = "x" | "y" | "xy";
// A gesture freezes its pixels-per-u scale. Layout may reflow around it; the saved values stay integer u.
export function draggedPagesSize(start: { w: number; h: number }, dx: number, dy: number, pxPerU: number, axis: PagesResizeAxis): { w: number; h: number } {
  if (![start.w, start.h, dx, dy, pxPerU].every(Number.isFinite) || pxPerU <= 0) throw new Error("Invalid Pages resize context.");
  const bound = (value: number, name: "w" | "h") => Math.max(PAGES_SIZE_BOUNDS.min[name], Math.min(PAGES_SIZE_BOUNDS.max[name], Math.round(value)));
  return { w: bound(start.w + (axis === "y" ? 0 : dx / pxPerU), "w"), h: bound(start.h + (axis === "x" ? 0 : dy / pxPerU), "h") };
}
// Client and offset dimensions are integer CSS pixels. Preserve the fractional border-box
// remainder while subtracting the measured border and scrollbar gutter.
export function fractionalContentSize(rect: { width: number; height: number }, offset: { width: number; height: number }, client: { width: number; height: number }): { width: number; height: number } {
  const axis = (box: number, outer: number, inner: number) => box > 0 && outer > 0 && inner > 0 ? Math.max(0, box - Math.max(0, outer - inner)) : inner;
  return { width: axis(rect.width, offset.width, client.width), height: axis(rect.height, offset.height, client.height) };
}
// One monotone engine for resolved u rectangles, including exact 1u designs. A grid-preset
// supplies standard-key row boundaries; exact rectangles also contribute their own bottom edges.
// Neither kind returns to an earlier hole. Height never limits the flow.
export function flowRectsU(sizes: readonly { id: string; w: number; h: number }[], availableU: number, gapU: number, rowStepU?: number): FlowRectU[] {
  if (!Number.isFinite(availableU) || availableU <= 0 || !Number.isFinite(gapU) || gapU < 0 || rowStepU !== undefined && (!Number.isFinite(rowStepU) || rowStepU <= 0)) throw new Error("Invalid u flow context.");
  const placed: FlowRectU[] = [], epsilon = 1e-8;
  let x = 0, y = 0;
  for (const size of sizes) {
    if (![size.w, size.h].every(value => Number.isFinite(value) && value > 0) || size.w > availableU + epsilon) throw new Error("A resolved component must fit the u flow width.");
    for (;;) {
      if (x + size.w > availableU + epsilon) {
        x = 0;
        const edges = placed.map(rect => rect.y + rect.h + gapU).filter(edge => edge > y + epsilon);
        if (rowStepU !== undefined) edges.push((Math.floor((y + epsilon) / rowStepU) + 1) * rowStepU);
        y = Math.min(...edges);
      }
      const blocked = placed.filter(rect => x < rect.x + rect.w + gapU - epsilon && x + size.w + gapU > rect.x + epsilon && y < rect.y + rect.h + gapU - epsilon && y + size.h + gapU > rect.y + epsilon);
      if (!blocked.length) break;
      x = Math.max(...blocked.map(rect => rect.x + rect.w + gapU));
    }
    placed.push({ id: size.id, x, y, w: size.w, h: size.h });
    x += size.w + gapU;
  }
  return placed;
}
// Natural grid extent is shared by layout and Pages' whole-track snapping.
const naturalGridWidth = (columns: number, size: GridSize, gap: number) => columns * GRID_CELL[size] + (columns - 1) * gap;
// At impossible widths keep 44px targets and expose a horizontally scrollable surface instead of clipping.
// `fixedColumns` (T91, a Pages widget's "keys per row"): exactly that many columns, the cell fills the width (no cap, no Grid size), never fewer columns than the widest item
// and never a cell under 44px (the flow then scrolls sideways). Without it nothing changes.
// `insetTop` (T97) is the room above the first row; it defaults to `inset`. `pagesGap` (T97) is the gap between two items when one of them is a Pages widget (default `gap`).
// Percent widths of Pages divide the width with that gap.
export function flowLayout(widgets: readonly Widget[], available: number, size: GridSize, gap: number, inset = 0, visibleHeight = 0, offsetTop = 0, fixedColumns?: number, insetTop = inset, pagesGap = gap): FlowLayout {
  const widest = Math.max(1, ...widgets.filter(widget => !isPages(widget)).map(widget => widgetPresetSpan(widget).cols));
  const wanted = fixedColumns === undefined ? undefined : Math.max(widest, Math.round(fixedColumns));
  const width = Math.max(available - inset * 2, (wanted ?? widest) * (44 + gap) - gap); const base = GRID_CELL[size];
  const columns = wanted ?? Math.max(widest, Math.floor((width + gap) / (naturalGridWidth(1, size, gap) + gap)));
  const cell = wanted === undefined ? Math.max(44, Math.min(base * 1.15, (width + gap) / columns - gap)) : Math.max(44, (width + gap) / columns - gap), pitch = cell + gap;
  const context = sizingContext(cell / STANDARD_KEY_U, gap, { w: width, h: visibleHeight });
  const insetU = inset / context.pxPerU, insetTopU = insetTop / context.pxPerU, pitchU = STANDARD_KEY_U + context.gapU;
  const pagesContext = pagesGap === gap ? context : sizingContext(cell / STANDARD_KEY_U, pagesGap, { w: width, h: visibleHeight });
  const resolved = widgets.map(widget => ({ id: widget.id, ...resolveWidgetSizeU(widget, isPages(widget) ? pagesContext : context) }));
  const gridRows = widgets.some(widget => !isPages(widget) && sizingFor(widget.kind, "form" in widget ? widget.form : undefined).policy === "grid-preset");
  let rects: FlowRectU[];
  if (!widgets.some(isPages)) rects = flowRectsU(resolved, columns * pitchU - context.gapU, context.gapU, gridRows ? pitchU : undefined);
  else {
    // T97: between two items where one is a Pages widget the gap is `pagesGap`; between other items it is `gap`. Rows are packed first, then placed, because a row's distance to the
    // next one depends on whether either holds a Pages widget.
    const availableU = width / context.pxPerU, gapU = context.gapU, pagesGapU = pagesContext.gapU;
    const between = (a: number, b: number) => isPages(widgets[a]!) || isPages(widgets[b]!) ? pagesGapU : gapU;
    // Fixed widths are u, which scale with the cell, while the 1u/2u spacing is whole px: a row that filled the width exactly can come out a fraction of a px too wide.
    // Up to 1px over still counts as one row; its last item gives the excess back below.
    const slackU = 1 / context.pxPerU;
    const rows: number[][] = [];
    let row: number[] = [], used = 0;
    for (let i = 0; i < widgets.length; i++) {
      const w = resolved[i]!.w;
      if (row.length && used + between(row.at(-1)!, i) + w > availableU + slackU + 1e-8) { rows.push(row); row = []; used = 0; }
      used += w + (row.length ? between(row.at(-1)!, i) : 0); row.push(i);
    }
    if (row.length) rows.push(row);
    rects = [];
    let y = 0;
    rows.forEach((members, at) => {
      const rowUsed = members.reduce((sum, i, n) => sum + resolved[i]!.w + (n ? between(members[n - 1]!, i) : 0), 0);
      const fills = members.filter(i => isPages(widgets[i]!) && (widgets[i] as PagesWidget).size?.w.mode === "fill");
      const extra = fills.length ? Math.max(0, availableU - rowUsed) / fills.length : 0;
      const thirds = !fills.length && members.length === 3 && members.every(i => {
        const widget = widgets[i]!;
        return isPages(widget) && widget.size?.w.mode === "percent" && widget.size.w.pct === 33;
      });
      const thirdExtra = thirds ? Math.max(0, availableU - rowUsed) / 3 : 0;
      const over = members.length > 1 ? Math.max(0, rowUsed - availableU) : 0;
      let x = 0, rowHeight = 0;
      members.forEach((i, n) => {
        const widget = widgets[i]!, baseSize = resolved[i]!;
        const w = baseSize.w + (fills.includes(i) ? extra : thirdExtra) - (n === members.length - 1 ? over : 0);
        const h = isPages(widget) && widget.size?.h.mode === "fill" ? Math.max(widget.size.h.min, (visibleHeight - offsetTop - insetTop - inset) / context.pxPerU - y) : baseSize.h;
        rects.push({ id: widget.id, x, y, w, h });
        x += w + (n + 1 < members.length ? between(i, members[n + 1]!) : 0); rowHeight = Math.max(rowHeight, h);
      });
      const next = rows[at + 1], touching = members.some(i => isPages(widgets[i]!)) || !!next?.some(i => isPages(widgets[i]!));
      y += rowHeight + (touching ? pagesGapU : gapU);
    });
  }
  const gridIndex = (value: number) => Math.abs(value - Math.round(value)) < 1e-8 ? Math.round(value) : value;
  const placements = rects.map((rect, index) => {
    const box = rectToPx({ ...rect, x: rect.x + insetU, y: rect.y + insetTopU }, context), span = widgetSpan(widgets[index]!);
    return { id: rect.id, x: gridIndex(rect.x / pitchU), y: gridIndex(rect.y / pitchU), ...span, left: box.x, top: box.y, width: box.w, height: box.h };
  });
  const bottomU = Math.max(0, ...rects.map(rect => rect.y + rect.h));
  return { placements, columns, cell, pitch, width: width + inset * 2, height: (bottomU + insetTopU + insetU) * context.pxPerU, overflow: width + inset * 2 > available + .5,
    ...(wanted === undefined ? {} : { raised: wanted > Math.round(fixedColumns!), floored: cell <= 44 + 1e-6 }) };
}
// Snap with the same grid calculation used by the interior; losses include the frame and stable gutter.
export function snapPagesGridU(widgets: readonly Widget[], raw: { w: number; h: number }, scale: number, grid: GridSize, gap: number, inset: number, loss: { w: number; h: number }, axis: PagesResizeAxis): { w: number; h: number } {
  const bound = (value: number) => Math.max(1, Math.min(PAGES_SIZE_BOUNDS.max.w, value));
  let w = raw.w, h = raw.h;
  if (axis !== "y") {
    const available = Math.max(1, raw.w * scale - loss.w);
    const minimum = flowLayout(widgets, 1, grid, gap, inset).columns;
    const columns = Math.max(minimum, Math.round((available - inset * 2 + gap) / (naturalGridWidth(1, grid, gap) + gap)));
    const candidates = [columns, columns - 1, columns + 1, columns - 2, columns + 2].filter(count => count >= minimum);
    let bestDistance = Infinity;
    for (const count of candidates) {
      const target = naturalGridWidth(count, grid, gap) + inset * 2;
      const candidate = bound(Math.ceil((target + loss.w) / scale - 1e-9));
      const actualWidth = candidate * scale - loss.w, inner = flowLayout(widgets, Math.max(1, actualWidth), grid, gap, inset);
      if (inner.columns !== count || actualWidth - target < -1e-7 || actualWidth - target > 1 + 1e-7) continue;
      const distance = Math.abs(candidate - raw.w);
      if (distance < bestDistance) { bestDistance = distance; w = candidate; }
    }
    if (bestDistance === Infinity) w = bound(Math.ceil((naturalGridWidth(columns, grid, gap) + inset * 2 + loss.w) / scale - 1e-9));
  }
  if (axis !== "x") {
    const inner = flowLayout(widgets, Math.max(1, w * scale - loss.w), grid, gap, inset);
    const available = Math.max(0, raw.h * scale - loss.h - inset * 2);
    const rows = Math.max(1, Math.round((available + gap) / inner.pitch));
    let bestDistance = Infinity;
    for (const count of [rows, rows - 1, rows + 1, rows - 2, rows + 2].filter(value => value >= 1)) {
      const target = count * inner.cell + (count - 1) * gap + inset * 2;
      const candidate = bound(Math.ceil((target + loss.h) / scale - 1e-9));
      const remainder = candidate * scale - loss.h - target;
      if (remainder < -1e-7 || remainder > 1 + 1e-7) continue;
      const distance = Math.abs(candidate - raw.h);
      if (distance < bestDistance) { bestDistance = distance; h = candidate; }
    }
    if (bestDistance === Infinity) h = bound(Math.ceil((rows * inner.cell + (rows - 1) * gap + inset * 2 + loss.h) / scale - 1e-9));
  }
  return { w, h };
}
// Uses current rendered boxes (already include scroll offsets). A boundary before/after a component, never a fictitious empty cell.
export function insertionAt(boxes: readonly Box[], x: number, y: number): number {
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index]!;
    if (y < box.top) return index;
    if (y <= box.top + box.height && x <= box.left + box.width) return index + (x > box.left + box.width / 2 ? 1 : 0);
  }
  return boxes.length;
}
export const SMALL_KEY_PX = 80;
export const isSmallKey = (box: Pick<Box, "width" | "height">): boolean => Math.min(box.width, box.height) < SMALL_KEY_PX;
