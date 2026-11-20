import { NO_INSETS, safeInsets, type Insets } from "./zones.js";

// T83 (ADR-078): the toolbar of Edit mode floats over the canvas. The left grip drags it anywhere inside the window, one button collapses it to a small round icon, and the place
// is remembered on this device only (localStorage; nothing goes to the Mac or into the layout). Positions are distances from the right and bottom edge, because the docked bar
// sits there and grows leftwards when Save appears; a position the window cannot hold is only shown clamped, the remembered one is kept for when the window is large again.
export const BAR_KEY = "keyln.editBar.v1";
export const BAR_MARGIN = 8, BAR_STEP = 8, BAR_BIG_STEP = 32, DRAG_THRESHOLD = 6, DOUBLE_TAP_MS = 350;
export interface BarPlace { right: number; bottom: number }
export interface BarState extends BarPlace { docked: boolean; collapsed: boolean }
export interface Box { width: number; height: number }
// Docked = the stylesheet's own place (12px from the right and bottom edge, above the open Library); `right`/`bottom` are then not used.
export const DOCKED: BarState = { right: 12, bottom: 12, docked: true, collapsed: false };

const between = (value: number, low: number, high: number) => high < low ? low : Math.min(Math.max(value, low), high);
// Keeps the whole bar inside the window, `margin` (plus the safe area) from every edge. A window too small for the bar pins its right edge.
export function clampBar(place: BarPlace, size: Box, view: Box, insets: Insets = NO_INSETS, margin = BAR_MARGIN): BarPlace {
  return {
    right: between(place.right, margin + insets.right, view.width - size.width - margin - insets.left),
    bottom: between(place.bottom, margin + insets.bottom, view.height - size.height - margin - insets.top),
  };
}
// An arrow key moves the bar `step` px (Shift: the big step) the way the arrow points; any other key returns nothing.
export function nudgeBar(place: BarPlace, key: string, big = false): BarPlace | undefined {
  const step = big ? BAR_BIG_STEP : BAR_STEP;
  switch (key) {
    case "ArrowLeft": return { right: place.right + step, bottom: place.bottom };
    case "ArrowRight": return { right: place.right - step, bottom: place.bottom };
    case "ArrowUp": return { right: place.right, bottom: place.bottom + step };
    case "ArrowDown": return { right: place.right, bottom: place.bottom - step };
    default: return undefined;
  }
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
// Anything missing, damaged or unreadable (private window, blocked storage) gives the docked, expanded bar.
export function loadBarState(storage: Pick<Storage, "getItem"> | undefined): BarState {
  try {
    const raw = storage?.getItem(BAR_KEY);
    if (!raw) return { ...DOCKED };
    const found = JSON.parse(raw) as Partial<BarState> | null, collapsed = found?.collapsed === true;
    if (found && found.docked === false && finite(found.right) && finite(found.bottom)) return { right: found.right, bottom: found.bottom, docked: false, collapsed };
    return { ...DOCKED, collapsed };
  } catch { return { ...DOCKED }; }
}
export function saveBarState(storage: Pick<Storage, "setItem"> | undefined, state: BarState): boolean {
  try { storage?.setItem(BAR_KEY, JSON.stringify({ right: state.right, bottom: state.bottom, docked: state.docked, collapsed: state.collapsed })); return !!storage; } catch { return false; }
}
// A press that stays within `threshold` px of where it started is a tap; once it leaves that circle it is a drag for good (so the icon never expands after a drag).
export function pointerGesture(threshold = DRAG_THRESHOLD) {
  let startX = 0, startY = 0, active = false, dragging = false;
  return {
    start(x: number, y: number) { startX = x; startY = y; active = true; dragging = false; },
    // The offset from the start once it is a drag, otherwise nothing.
    move(x: number, y: number): { dx: number; dy: number } | undefined {
      if (!active) return undefined;
      const dx = x - startX, dy = y - startY;
      if (!dragging && Math.hypot(dx, dy) > threshold) dragging = true;
      return dragging ? { dx, dy } : undefined;
    },
    end(): "tap" | "drag" | undefined { if (!active) return undefined; active = false; return dragging ? "drag" : "tap"; },
    cancel() { active = false; dragging = false; },
    get active() { return active; },
  };
}
export const isDoubleTap = (previous: number, now: number) => previous > 0 && now - previous <= DOUBLE_TAP_MS;

interface Parts { bar: HTMLElement; row: HTMLElement; grip: HTMLElement; chip: HTMLElement; collapse: HTMLElement }
const storageOf = (): Storage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };
export function createEditBar(parts: Parts, storage: Storage | undefined = storageOf()) {
  const { bar, row, grip, chip, collapse } = parts;
  let state = loadBarState(storage), active = false, dirty = false, insetsFor = "", insets: Insets = NO_INSETS, moved = false, lastTap = 0;
  const view = (): Box | undefined => typeof window.innerWidth === "number" && typeof window.innerHeight === "number" && window.innerWidth > 0 ? { width: window.innerWidth, height: window.innerHeight } : undefined;
  const sizeOf = (): Box => { const box = bar.getBoundingClientRect(); return { width: box.width, height: box.height }; };
  // The safe area changes only with the window, so it is read once per size, not on every pointer move.
  function safe(box: Box): Insets {
    const key = `${box.width}x${box.height}`;
    if (key !== insetsFor) { insetsFor = key; insets = safeInsets(); }
    return insets;
  }
  const clamp = (place: BarPlace): BarPlace => {
    const box = view(), size = sizeOf();
    return box && size.width > 0 ? clampBar(place, size, box, safe(box)) : place;
  };
  // Where the bar is now, from its box (docked or not); the saved place when the page cannot measure it.
  function current(): BarPlace {
    const box = view(), rect = bar.getBoundingClientRect();
    return box && rect.width > 0 ? { right: box.width - rect.right, bottom: box.height - rect.bottom } : { right: state.right, bottom: state.bottom };
  }
  function paint() {
    bar.dataset.docked = String(state.docked); bar.dataset.collapsed = String(state.collapsed);
    row.hidden = state.collapsed; chip.hidden = !state.collapsed;
    collapse.setAttribute("aria-expanded", String(!state.collapsed)); chip.setAttribute("aria-expanded", "false");
    if (state.docked) { bar.style.removeProperty("right"); bar.style.removeProperty("bottom"); return; }
    const shown = clamp(state);
    bar.style.setProperty("right", `${Math.round(shown.right)}px`); bar.style.setProperty("bottom", `${Math.round(shown.bottom)}px`);
  }
  const save = () => { saveBarState(storage, state); };
  function place(next: BarPlace) {
    const shown = clamp(next);
    state = { ...state, right: shown.right, bottom: shown.bottom, docked: false };
    paint();
  }
  function reset() { state = { ...DOCKED, collapsed: state.collapsed }; lastTap = 0; paint(); save(); }
  function setCollapsed(collapsed: boolean) {
    if (state.collapsed === collapsed) return;
    // Measured before the swap: what the bar is now is where it stays, however the window changed since it was saved.
    const here = state.docked ? undefined : current();
    state = { ...state, collapsed };
    if (here) state = { ...state, right: here.right, bottom: here.bottom };
    paint(); save();
    if (collapsed) chip.focus?.(); else collapse.focus?.();
  }
  function refit() { if (active && !state.docked) paint(); }

  // One press-and-move on a handle: the grip drags after 3px, the icon after DRAG_THRESHOLD (a finger is less steady); whatever is left is a tap.
  function drag(handle: HTMLElement, threshold: number, tapped: () => void) {
    const gesture = pointerGesture(threshold);
    let origin: BarPlace | undefined, pointer = -1;
    const finish = (event: PointerEvent, cancelled: boolean) => {
      if (!gesture.active || event.pointerId !== pointer) return;
      const kind = gesture.end();
      origin = undefined; delete bar.dataset.dragging;
      try { handle.releasePointerCapture?.(pointer); } catch { /* already released */ }
      // A cancelled press (the system took the pointer) keeps wherever the bar got to and is never a tap.
      if (kind === "drag") { moved = !cancelled; save(); } else if (kind === "tap" && !cancelled) tapped();
    };
    handle.addEventListener("pointerdown", ((event: PointerEvent) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      moved = false; origin = current(); pointer = event.pointerId; gesture.start(event.clientX, event.clientY);
      try { handle.setPointerCapture?.(pointer); } catch { /* the pointer is gone */ }
    }) as EventListener);
    handle.addEventListener("pointermove", ((event: PointerEvent) => {
      if (!origin || event.pointerId !== pointer) return;
      const offset = gesture.move(event.clientX, event.clientY);
      if (!offset) return;
      bar.dataset.dragging = "true";
      place({ right: origin.right - offset.dx, bottom: origin.bottom - offset.dy });
    }) as EventListener);
    handle.addEventListener("pointerup", ((event: PointerEvent) => finish(event, false)) as EventListener);
    handle.addEventListener("pointercancel", ((event: PointerEvent) => finish(event, true)) as EventListener);
    // Arrow keys move a focused handle (Shift: far), Home puts the bar back in its docked place.
    handle.addEventListener("keydown", ((event: KeyboardEvent) => {
      moved = false;
      if (event.key === "Home") { event.preventDefault(); reset(); return; }
      const next = nudgeBar(current(), event.key, event.shiftKey);
      if (!next) return;
      event.preventDefault(); place(next); save();
    }) as EventListener);
  }
  // A double tap on the grip docks the bar again.
  drag(grip, 3, () => { const now = Date.now(); if (isDoubleTap(lastTap, now)) reset(); else lastTap = now; });
  // The icon expands on click, which covers touch, mouse and keyboard; a click that ends a drag is not a tap.
  drag(chip, DRAG_THRESHOLD, () => {});
  chip.addEventListener("click", () => { if (moved) { moved = false; return; } setCollapsed(false); });
  collapse.addEventListener("click", () => setCollapsed(true));
  // Save appearing makes the bar wider; it must still fit inside the window.
  if (typeof ResizeObserver === "function") new ResizeObserver(refit).observe(row);
  paint();
  return {
    get state(): Readonly<BarState> { return state; },
    reset,
    // The page calls this whenever the window changes size (its own resize handling), so one handler serves the canvas and the bar.
    refit,
    // Called with the page: whether Edit is on, and whether the draft has changes (the icon carries the unsaved dot).
    render(on: boolean, changes: boolean) {
      const was = active;
      active = on; bar.hidden = !on; dirty = changes;
      chip.dataset.dirty = String(dirty);
      chip.setAttribute("aria-label", dirty ? "Show Edit toolbar, unsaved changes" : "Show Edit toolbar");
      chip.title = dirty ? "Show Edit toolbar (unsaved changes)" : "Show Edit toolbar";
      if (on && !was) refit();
    },
  };
}
