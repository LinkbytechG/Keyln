import { isDoubleTap, pointerGesture } from "./edit-bar.js";

// T86 (ADR-081): the top edge of the Library is a handle. Dragging it (or the arrow keys) changes the Library's height by writing --shelf-h on the shell; the canvas, the docked Edit
// toolbar and the settings card already follow --shelf-h. The height is remembered on this device only (localStorage; nothing goes to the Mac or into the layout). A remembered height the
// window cannot hold is only shown clamped, the remembered one is kept for when the window is large again.
export const SHELF_KEY = "keyln.libraryHeight.v1";
export const SHELF_MIN = 120, MIN_CANVAS = 120, SHELF_STEP = 16, SHELF_BIG_STEP = 64, TOP_FALLBACK = 56;
// The handle is 44px tall: 36px above the border and 8px below it (the panel's own top padding), so it never covers the search field. The canvas and the docked toolbar keep
// SHELF_GRAB (plus their own 8px) clear of the border for it (style.css --shelf-grab).
export const SHELF_GRAB = 28, CANVAS_GAP = 8;
const STOP_MS = 300, STORED_MAX = 10000;
export interface ShelfLimits { min: number; max: number }

// The Library may grow until MIN_CANVAS px of canvas are left below the top of the content area (the handle's room included); it never shrinks below SHELF_MIN.
export function shelfLimits(viewHeight: number, contentTop: number): ShelfLimits {
  return { min: SHELF_MIN, max: Math.max(SHELF_MIN, Math.floor(viewHeight - contentTop - MIN_CANVAS - SHELF_GRAB - CANVAS_GAP)) };
}
export const clampShelf = (value: number, limits: ShelfLimits) => Math.round(Math.min(Math.max(value, limits.min), Math.max(limits.max, limits.min)));
// An arrow key makes the Library taller (Up) or shorter (Down) by 16px (Shift: 64px); other keys return nothing.
export function nudgeShelf(height: number, key: string, big = false): number | undefined {
  const step = big ? SHELF_BIG_STEP : SHELF_STEP;
  return key === "ArrowUp" ? height + step : key === "ArrowDown" ? height - step : undefined;
}
// Anything missing, damaged or unreadable (private window, blocked storage) gives the stylesheet's own height.
export function loadShelfHeight(storage: Pick<Storage, "getItem"> | undefined): number | undefined {
  try {
    const raw = storage?.getItem(SHELF_KEY);
    if (!raw || !/^\d{1,5}(\.\d+)?$/.test(raw)) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= SHELF_MIN && value <= STORED_MAX ? Math.round(value) : undefined;
  } catch { return undefined; }
}
// undefined removes the remembered height (back to the stylesheet's). True when the storage took the call.
export function saveShelfHeight(storage: Pick<Storage, "setItem" | "removeItem"> | undefined, value: number | undefined): boolean {
  try {
    if (!storage) return false;
    if (value === undefined) storage.removeItem(SHELF_KEY); else storage.setItem(SHELF_KEY, String(Math.round(value)));
    return true;
  } catch { return false; }
}

interface Parts { shell: HTMLElement; panel: HTMLElement; handle: HTMLElement; contentTop: () => number }
const storageOf = (): Storage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };
export function createLibraryResize(parts: Parts, storage: Storage | undefined = storageOf()) {
  const { shell, panel, handle } = parts;
  let stored = loadShelfHeight(storage), lastTap = 0;
  type Drag = { pointer: number; startY: number; origin: number; before: string; value: number; touchId?: number; interrupted?: boolean; stop?: ReturnType<typeof setTimeout> };
  let drag: Drag | undefined, pending: number | undefined, frame: number | undefined;
  const gesture = pointerGesture(3);
  const viewHeight = () => typeof window !== "undefined" && typeof window.innerHeight === "number" && window.innerHeight > 0 ? window.innerHeight : undefined;
  function limits(floor = 0): ShelfLimits {
    const view = viewHeight(), found = view === undefined ? { min: SHELF_MIN, max: 4000 } : shelfLimits(view, parts.contentTop());
    // A drag that starts above the limit (a short window with the default height) may still make the Library smaller without it jumping.
    return floor > found.max ? { ...found, max: floor } : found;
  }
  const inline = () => shell.style.getPropertyValue?.("--shelf-h") ?? "";
  const measured = () => { const high = panel.getBoundingClientRect().height; return high > 0 ? Math.round(high) : undefined; };
  function aria(now: number | undefined) {
    handle.setAttribute("aria-valuemin", String(SHELF_MIN)); handle.setAttribute("aria-valuemax", String(limits().max));
    if (now !== undefined) handle.setAttribute("aria-valuenow", String(now));
  }
  function show(value: number, floor = 0): number {
    const px = clampShelf(value, limits(floor));
    shell.style.setProperty("--shelf-h", `${px}px`); aria(px);
    return px;
  }
  // The remembered height (clamped for this window), or the stylesheet's own.
  function paint() {
    if (stored === undefined) { shell.style.removeProperty("--shelf-h"); aria(measured()); } else show(stored);
  }
  function flush() {
    if (frame !== undefined) { (window as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame?.(frame); frame = undefined; }
    if (drag && pending !== undefined) drag.value = show(pending, drag.origin);
    pending = undefined;
  }
  function queue(value: number) {
    pending = value;
    if (typeof window.requestAnimationFrame !== "function") { flush(); return; }
    frame ??= window.requestAnimationFrame(() => { frame = undefined; flush(); });
  }
  function move(y: number) {
    const now = drag; if (!now) return;
    const offset = gesture.move(0, y);
    if (!offset) return;
    handle.dataset.dragging = "true"; shell.dataset.shelfResizing = "true";
    queue(now.origin - offset.dy);
  }
  const doc: Array<[string, (event: any) => void, AddEventListenerOptions?]> = [
    // Esc during a drag puts the height back and is not Esc for the page (it must not leave Edit).
    ["keydown", event => { if (drag && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); restore(); } }, { capture: true }],
    // The system may take the pointer (pointercancel); the same finger is then followed by touch events (as T40 does for a lifted key).
    ["touchmove", event => {
      if (!drag) return;
      if (event.cancelable) event.preventDefault();
      if (!drag.interrupted) return;
      for (const touch of Array.from(event.changedTouches ?? []) as Touch[]) {
        drag.touchId ??= touch.identifier;
        if (touch.identifier === drag.touchId) { clearTimeout(drag.stop); drag.stop = undefined; move(touch.clientY); }
      }
    }, { passive: false }],
    ["touchend", event => {
      if (!drag?.interrupted) return;
      for (const touch of Array.from(event.changedTouches ?? []) as Touch[]) if (touch.identifier === (drag.touchId ?? touch.identifier)) { end(false); return; }
    }, { passive: false }],
    ["touchcancel", () => { if (drag) { drag.interrupted = true; clearTimeout(drag.stop); drag.stop = setTimeout(() => end(true), STOP_MS); } }],
  ];
  function finish() {
    const done = drag; if (!done) return;
    clearTimeout(done.stop); drag = undefined;
    for (const [type, listener, options] of doc) document.removeEventListener(type, listener, options);
    delete handle.dataset.dragging; delete shell.dataset.shelfResizing;
    try { handle.releasePointerCapture?.(done.pointer); } catch { /* already released */ }
  }
  function restore() {
    const done = drag; if (!done) return;
    pending = undefined; if (frame !== undefined) { (window as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame?.(frame); frame = undefined; }
    if (done.before) shell.style.setProperty("--shelf-h", done.before); else shell.style.removeProperty("--shelf-h");
    finish(); gesture.cancel(); paint();
  }
  // Letting go (or the system ending the press): a drag keeps where the Library got to and remembers it; a tap is half of a double tap.
  function end(cancelled: boolean) {
    const done = drag; if (!done) return;
    flush(); const kind = gesture.end(); finish();
    if (kind === "drag") { stored = done.value; saveShelfHeight(storage, stored); }
    else if (kind === "tap" && !cancelled) { const now = Date.now(); if (isDoubleTap(lastTap, now)) reset(); else lastTap = now; }
  }
  function reset() { stored = undefined; lastTap = 0; shell.style.removeProperty("--shelf-h"); saveShelfHeight(storage, undefined); aria(measured()); }
  // Where the Library is now: its own box, else what has been set.
  const height = () => measured() ?? stored ?? 0;
  function set(value: number) { const px = clampShelf(value, limits()); stored = px; show(px); saveShelfHeight(storage, stored); }

  handle.addEventListener("pointerdown", ((event: PointerEvent) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    if (drag) finish();
    drag = { pointer: event.pointerId, startY: event.clientY, origin: height(), before: inline(), value: height() };
    gesture.start(0, event.clientY);
    for (const [type, listener, options] of doc) document.addEventListener(type, listener, options);
    try { handle.setPointerCapture?.(event.pointerId); } catch { /* the pointer is gone */ }
  }) as EventListener);
  handle.addEventListener("pointermove", ((event: PointerEvent) => { if (drag && event.pointerId === drag.pointer) move(event.clientY); }) as EventListener);
  handle.addEventListener("pointerup", ((event: PointerEvent) => { if (drag && event.pointerId === drag.pointer) end(false); }) as EventListener);
  handle.addEventListener("pointercancel", ((event: PointerEvent) => { if (drag && event.pointerId === drag.pointer) drag.interrupted = true; }) as EventListener);
  handle.addEventListener("dblclick", () => { if (!drag) reset(); });
  // Arrow keys (Shift: far), Home back to the stylesheet's height, End as tall as the window allows.
  handle.addEventListener("keydown", ((event: KeyboardEvent) => {
    if (event.key === "Home") { event.preventDefault(); reset(); return; }
    if (event.key === "End") { event.preventDefault(); set(limits().max); return; }
    const next = nudgeShelf(height(), event.key, event.shiftKey);
    if (next === undefined) return;
    event.preventDefault(); set(next);
  }) as EventListener);
  handle.setAttribute("role", "separator"); handle.setAttribute("aria-orientation", "horizontal"); handle.setAttribute("aria-label", "Resize library"); handle.tabIndex = 0;
  paint();
  return {
    get stored() { return stored; },
    get dragging() { return !!drag; },
    reset,
    // The page calls this whenever the window or the Library changes size, so the remembered height is shown clamped again.
    refit() { if (!drag) paint(); },
  };
}
