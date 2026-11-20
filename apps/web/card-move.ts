import { BAR_MARGIN, clampBar, isDoubleTap, nudgeBar, pointerGesture } from "./edit-bar.js";
import { NARROW_MAX_WIDTH } from "../../packages/contracts/index.js";
import { NO_INSETS, safeInsets, type Insets } from "./zones.js";

// T92 (ADR-085): the settings card of Edit moves by the grip in its header and collapses to its header bar. Both are only for as long as the card is open: closing it
// (and opening it again) forgets the place and the collapse, so every opening starts where the card always stood, fully expanded. Nothing is stored. The gesture, the clamping
// inside the window (safe area included), the arrow-key steps and the double tap are the Edit toolbar's own (edit-bar.ts).
interface Parts { card: HTMLElement; grip: HTMLElement; collapse: HTMLElement }
interface Moved { left: number; top: number; width: number }
export function createCardMover(parts: Parts) {
  const { card, grip, collapse } = parts;
  let moved: Moved | undefined, collapsed = false, insetsFor = "", insets: Insets = NO_INSETS, lastTap = 0;
  const view = () => typeof window.innerWidth === "number" && typeof window.innerHeight === "number" && window.innerWidth > 0 ? { width: window.innerWidth, height: window.innerHeight } : undefined;
  // The bottom sheet of a phone has no free move: its grip is hidden and only the collapse works.
  const narrow = () => { const box = view(); return !!box && box.width <= NARROW_MAX_WIDTH; };
  function safe(): Insets {
    const box = view(); if (!box) return NO_INSETS;
    const key = `${box.width}x${box.height}`;
    if (key !== insetsFor) { insetsFor = key; insets = safeInsets(); }
    return insets;
  }
  const sizeOf = () => { const box = card.getBoundingClientRect(); return { width: box.width, height: box.height }; };
  // The height the card wants (its content, at most the stylesheet's 600px and the window), not what the room below its top leaves it: a card is moved up to show
  // whole rather than squeezed. A collapsed card is just its header.
  function naturalSize(): { width: number; height: number } {
    const box = view(), held = card.style.getPropertyValue("max-height");
    if (held) card.style.removeProperty("max-height");
    const size = sizeOf();
    if (held) card.style.setProperty("max-height", held);
    if (!box) return size;
    const room = box.height - 2 * BAR_MARGIN - safe().top - safe().bottom;
    return { width: size.width, height: Math.max(0, Math.min(size.height, room)) };
  }
  // The card's top-left corner as the toolbar's distances from the right and bottom edge, and back.
  function clampTo(left: number, top: number, size: { width: number; height: number }): { left: number; top: number } {
    const box = view(); if (!box) return { left, top };
    const place = clampBar({ right: box.width - left - size.width, bottom: box.height - top - size.height }, size, box, safe(), BAR_MARGIN);
    return { left: box.width - place.right - size.width, top: box.height - place.bottom - size.height };
  }
  function paint() {
    card.dataset.collapsed = String(collapsed);
    collapse.setAttribute("aria-expanded", String(!collapsed));
    const word = collapsed ? "Expand settings" : "Collapse settings";
    collapse.setAttribute("aria-label", word); collapse.title = word;
    const free = moved && !narrow();
    if (!free) {
      delete card.dataset.moved;
      for (const name of ["left", "top", "width", "max-height"]) card.style.removeProperty(name);
      return;
    }
    const box = view();
    card.dataset.moved = "true";
    card.style.setProperty("left", `${Math.round(moved!.left)}px`); card.style.setProperty("top", `${Math.round(moved!.top)}px`);
    card.style.setProperty("width", `${Math.round(box ? Math.min(moved!.width, box.width - 2 * BAR_MARGIN) : moved!.width)}px`);
    // The body scrolls inside; the header never leaves the window.
    if (box) card.style.setProperty("max-height", `${Math.max(120, Math.round(box.height - moved!.top - BAR_MARGIN - safe().bottom))}px`);
  }
  // The card changed size (it was collapsed or expanded, or the window changed): keep it whole inside the window.
  function fit() {
    if (!moved || narrow()) return;
    const size = naturalSize();
    if (size.width <= 0) return;
    const next = clampTo(moved.left, moved.top, size);
    if (Math.abs(next.left - moved.left) > .5 || Math.abs(next.top - moved.top) > .5) { moved = { ...moved, ...next }; paint(); }
  }
  // Where the card is now (it may still be in its default place).
  function origin(): Moved { const box = card.getBoundingClientRect(); return { left: box.left, top: box.top, width: box.width }; }
  function place(left: number, top: number) {
    const base = moved ?? origin(), size = naturalSize(), next = clampTo(left, top, size);
    moved = { ...next, width: base.width }; paint();
  }
  function setCollapsed(next: boolean) {
    if (collapsed === next) return;
    collapsed = next; paint();
    if (next) collapse.focus?.(); else fit();
  }
  function reset() { moved = undefined; collapsed = false; lastTap = 0; delete card.dataset.dragging; paint(); }

  // One press-and-move on the grip: a drag after 3px; whatever is left is a tap (two taps in a row put the card back).
  const gesture = pointerGesture(3);
  let start: Moved | undefined, pointer = -1;
  const finish = (event: PointerEvent, cancelled: boolean) => {
    if (!gesture.active || event.pointerId !== pointer) return;
    const kind = gesture.end(); start = undefined; delete card.dataset.dragging;
    try { grip.releasePointerCapture?.(pointer); } catch { /* already released */ }
    if (kind === "tap" && !cancelled) { const now = Date.now(); if (isDoubleTap(lastTap, now)) reset(); else lastTap = now; }
  };
  grip.addEventListener("pointerdown", ((event: PointerEvent) => {
    if (event.button !== 0 || event.isPrimary === false || narrow()) return;
    start = moved ? { ...moved } : origin(); pointer = event.pointerId; gesture.start(event.clientX, event.clientY);
    try { grip.setPointerCapture?.(pointer); } catch { /* the pointer is gone */ }
  }) as EventListener);
  grip.addEventListener("pointermove", ((event: PointerEvent) => {
    if (!start || event.pointerId !== pointer) return;
    const offset = gesture.move(event.clientX, event.clientY);
    if (!offset) return;
    card.dataset.dragging = "true"; place(start.left + offset.dx, start.top + offset.dy);
  }) as EventListener);
  grip.addEventListener("pointerup", ((event: PointerEvent) => finish(event, false)) as EventListener);
  grip.addEventListener("pointercancel", ((event: PointerEvent) => finish(event, true)) as EventListener);
  // Arrow keys move a focused grip 8px (Shift: 32px); Home puts the card back.
  grip.addEventListener("keydown", ((event: KeyboardEvent) => {
    if (narrow()) return;
    if (event.key === "Home") { event.preventDefault(); reset(); return; }
    const base = moved ?? origin(), box = view(), size = sizeOf();
    const next = box && nudgeBar({ right: box.width - base.left - size.width, bottom: box.height - base.top - size.height }, event.key, event.shiftKey);
    if (!next || !box) return;
    event.preventDefault(); place(box.width - next.right - size.width, box.height - next.bottom - size.height);
  }) as EventListener);
  collapse.addEventListener("click", () => setCollapsed(!collapsed));
  paint();
  return {
    get moved() { return !!moved; }, get collapsed() { return collapsed; },
    reset,
    // Tapping another component while the card is open: it stays where it is, but opens out (the person wants to edit).
    expand() { setCollapsed(false); },
    // The page calls this when the window changes: the card stays whole inside it, and a window that became narrow gives the bottom sheet back.
    refit() { fit(); paint(); },
  };
}
