import { parseThemeLayout, slotRect, SYSTEM_FORM_SIZES, SYSTEM_FORMS, SYSTEM_PARTS, ZONE_CHECK_WINDOWS, zoneProblem, NARROW_MAX_WIDTH, type SystemPart, type SystemSlot, type ThemeLayout, type WindowSize, type ZoneSet } from "../../packages/contracts/index.js";
import { createSketch, partNames, SKETCH_WINDOWS, type Sketch } from "./theme-sketch.js";

// T64 (ADR-064): the Layout page of the theme window, the only place that changes zones. The window is drawn to scale in two sizes (Wide: wider than 600 px, Narrow: 600 px or
// less); the three system components are dragged on it (or moved with the arrow keys) and snap to the nearest corner-edge pair of the window; the top bar height, the
// margins of the content area and the form of each component are set below. Every change gives a whole new ThemeLayout, checked by the rules the Host applies.
export type LayoutSide = "wide" | "narrow";
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const GRID = 4;

// Moves a component so its top-left corner is at (x, y) in the window: it is held inside the window, snapped to a 4 px grid (an axis that did not move is left alone), and anchored to the nearer left/right and top/bottom edge.
export function anchorSlot(slot: SystemSlot, x: number, y: number, window: WindowSize, snap = GRID): SystemSlot {
  // An axis that did not move keeps its exact value; only a moved one is snapped.
  const now = slotRect(slot, window), onGrid = (value: number, current: number) => value === current ? current : Math.round(value / snap) * snap;
  const left = clamp(onGrid(x, now.x), 0, Math.max(0, window.width - slot.w)), top = clamp(onGrid(y, now.y), 0, Math.max(0, window.height - slot.h));
  return { form: slot.form, w: slot.w, h: slot.h,
    ...(left + slot.w / 2 < window.width / 2 ? { left } : { right: window.width - left - slot.w }),
    ...(top + slot.h / 2 < window.height / 2 ? { top } : { bottom: window.height - top - slot.h }) };
}
// The first rule a whole layout breaks (in the windows it is checked in), or undefined. The Host runs the same parser.
export function layoutProblem(layout: ThemeLayout): string | undefined {
  for (const side of ["wide", "narrow"] as const) { const found = zoneProblem(layout[side], ZONE_CHECK_WINDOWS[side]); if (found) return `${side === "wide" ? "Wide" : "Narrow"}: ${found}`; }
  try { parseThemeLayout(layout); return undefined; } catch (error) { return (error as Error).message; }
}
// A form change keeps the anchor and takes the form's usual size.
export function withForm(slot: SystemSlot, form: string): SystemSlot {
  const size = SYSTEM_FORM_SIZES[form]; return { ...slot, form, w: size ? size.w : slot.w, h: size ? size.h : slot.h };
}

interface Options {
  /** The layout being edited (a custom theme's own, or its base theme's when it has none). */
  layout: () => ThemeLayout | undefined;
  /** The layout the base theme brings; "Reset" goes back to it. */
  base: () => ThemeLayout | undefined;
  baseName: () => string;
  change: (layout: ThemeLayout) => void;
}
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const NUMBERS = [["layout-header", "header"], ["layout-left", "left"], ["layout-right", "right"], ["layout-top", "top"], ["layout-bottom", "bottom"]] as const;

export function createLayoutPage(options: Options) {
  let side: LayoutSide = "wide";
  const sketches: Record<LayoutSide, Sketch> = { wide: createSketch("wide", true), narrow: createSketch("narrow", true) };
  const stage = el("layout-stage");
  const forms = new Map<string, HTMLButtonElement>();
  const rowOf = new Map<SystemPart, HTMLElement>();
  let drag: { part: SystemPart; x: number; y: number; origin: { x: number; y: number } } | undefined;

  const zones = (): ZoneSet | undefined => options.layout()?.[side];
  function put(next: ZoneSet) { const layout = options.layout(); if (!layout) return; const made = clone(layout); made[side] = next; options.change(made); }
  function setSlot(part: SystemPart, slot: SystemSlot) { const now = zones(); if (now) put({ ...now, slots: { ...now.slots, [part]: slot } }); }

  // ---- static pieces ----
  const list = el("layout-forms");
  for (const part of SYSTEM_PARTS) {
    const row = document.createElement("div"), label = document.createElement("span"), group = document.createElement("div");
    row.className = "layout-form-row"; label.className = "group-label"; label.textContent = partNames[part]; label.id = `layout-form-${part}`;
    group.className = "form-options"; group.setAttribute("role", "group"); group.setAttribute("aria-labelledby", label.id);
    for (const form of SYSTEM_FORMS[part]) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "form-choice"; button.dataset.part = part; button.dataset.form = form; button.textContent = form.replace("-", " ").replace(/^./, letter => letter.toUpperCase());
      button.addEventListener("click", () => { const slot = zones()?.slots[part]; if (slot && slot.form !== form) setSlot(part, withForm(slot, form)); });
      forms.set(`${part}/${form}`, button); group.append(button);
    }
    // One form only (the gear): nothing to choose, so the row is left out.
    if (SYSTEM_FORMS[part].length > 1) { row.append(label, group); rowOf.set(part, row); list.append(row); }
  }
  for (const [id, key] of NUMBERS) {
    el<HTMLInputElement>(id).addEventListener("input", () => {
      const input = el<HTMLInputElement>(id), now = zones(); if (!now) return;
      const value = Number.parseInt(input.value, 10); if (!Number.isFinite(value)) return;
      if (key === "header") put({ ...now, header: clamp(value, 0, 160) });
      else put({ ...now, content: { ...now.content, [key]: clamp(value, 0, 400) } });
    });
  }
  for (const which of ["wide", "narrow"] as const) {
    const sketch = sketches[which];
    for (const part of SYSTEM_PARTS) {
      const node = sketch.parts[part];
      node.addEventListener("pointerdown", (event: PointerEvent) => {
        const slot = zones()?.slots[part]; if (!slot) return;
        const rect = slotRect(slot, sketch.window);
        drag = { part, x: event.clientX, y: event.clientY, origin: { x: rect.x, y: rect.y } };
        try { node.setPointerCapture?.(event.pointerId); } catch { /* A synthetic pointer cannot be captured. */ }
        event.preventDefault();
      });
      node.addEventListener("pointermove", (event: PointerEvent) => {
        if (!drag || drag.part !== part) return;
        const box = sketch.element.getBoundingClientRect(), scale = box.width > 0 ? box.width / sketch.window.width : 0, slot = zones()?.slots[part];
        if (!scale || !slot) return;
        setSlot(part, anchorSlot(slot, drag.origin.x + (event.clientX - drag.x) / scale, drag.origin.y + (event.clientY - drag.y) / scale, sketch.window));
      });
      for (const name of ["pointerup", "pointercancel"]) node.addEventListener(name, () => { drag = undefined; });
      node.addEventListener("keydown", (event: KeyboardEvent) => {
        const step = event.shiftKey ? 16 : GRID, move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
        const slot = zones()?.slots[part]; if (!move || !slot) return;
        event.preventDefault();
        const rect = slotRect(slot, sketch.window);
        setSlot(part, anchorSlot(slot, rect.x + move[0]!, rect.y + move[1]!, sketch.window, 1));
      });
    }
  }
  for (const which of ["wide", "narrow"] as const) el(`layout-${which}`).addEventListener("click", () => { side = which; render(); });
  el("layout-reset").addEventListener("click", () => { const base = options.base(); if (base) put(clone(base[side])); });

  function render() {
    const layout = options.layout(), now = layout?.[side];
    for (const which of ["wide", "narrow"] as const) el(`layout-${which}`).setAttribute("aria-pressed", String(which === side));
    stage.replaceChildren(sketches[side].element);
    el("layout-note").textContent = side === "wide" ? `Wide: windows wider than ${NARROW_MAX_WIDTH} px, drawn as ${SKETCH_WINDOWS.wide.width} × ${SKETCH_WINDOWS.wide.height}. Drag a component to a new place; it keeps its distance from the nearest side, so in a narrower window it stays near that side.` :
      `Narrow: windows ${NARROW_MAX_WIDTH} px wide or less (a phone), drawn as ${SKETCH_WINDOWS.narrow.width} × ${SKETCH_WINDOWS.narrow.height}. Drag a component to a new place; it keeps its distance from the nearest side.`;
    if (!layout || !now) return;
    const problem = layoutProblem(layout), mine = zoneProblem(now, ZONE_CHECK_WINDOWS[side]);
    sketches[side].update(now, !!mine);
    for (const [id, key] of NUMBERS) {
      const input = el<HTMLInputElement>(id), value = key === "header" ? now.header : now.content[key];
      if (document.activeElement !== input && input.value !== String(value)) input.value = String(value);
    }
    for (const [key, button] of forms) { const [part, form] = key.split("/") as [SystemPart, string]; button.setAttribute("aria-pressed", String(now.slots[part].form === form)); }
    const box = el("layout-problem"); box.textContent = problem ?? "The layout fits every window size it is checked in."; box.dataset.status = problem ? "bad" : "ok";
    el<HTMLButtonElement>("layout-reset").textContent = `Reset this layout to ${options.baseName()}`;
    el<HTMLButtonElement>("layout-reset").disabled = !options.base();
  }
  return { render, side: () => side };
}
export type LayoutPage = ReturnType<typeof createLayoutPage>;
