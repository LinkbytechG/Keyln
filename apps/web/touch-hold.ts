// T85 (ADR-080): the press gesture of a Library card, shared by every Library tab.
// Mouse: press and move more than 8px drags at once; a click adds. Touch and pen: a swipe scrolls the list (the card is touch-action:pan-y);
// holding for 400ms without moving "lifts" the card, and from then on the list does not scroll. After the lift, moving drags, and letting go
// without moving calls `release` (the App tab opens Activate window there). A tap is still only the click.
export const HOLD_MS = 400, SLOP = 8;
// The click that ends a hold or a drag must never add the item; the same guard console.ts uses after a drop.
const CLICK_GUARD_MS = 350, CONTEXT_GUARD_MS = 700, STOP_MS = 300;

export interface PressPointer { pointerId: number; x: number; y: number; touch: boolean }
export interface PressOptions {
  enabled: () => boolean;
  // Carry the card over the canvas. True when something took it over (console.ts then follows the finger itself).
  drag: (pointer: PressPointer) => boolean;
  click: (event: Event) => void;
  // A touch hold let go without moving.
  release?: (x: number, y: number) => void;
  // A context menu that does not come from a touch hold (right click, ContextMenu key).
  contextmenu?: (event: MouseEvent) => void;
  // The press is under way / over, for a caller that must not rebuild the card meanwhile.
  begin?: () => void; end?: () => void;
}
type Phase = "wait" | "held" | "drag";
interface Gesture { id: number; x: number; y: number; px: number; py: number; touch: boolean; phase: Phase; timer?: ReturnType<typeof setTimeout>; stop?: ReturnType<typeof setTimeout>; touchId?: number; interrupted?: boolean }
type Listener = [type: string, listener: (event: any) => void, options?: AddEventListenerOptions];

const touchLike = (event: { pointerType?: string }) => event.pointerType === "touch" || event.pointerType === "pen";

export function watchPress(card: HTMLElement, options: PressOptions) {
  let g: Gesture | undefined, suppressUntil = 0, lastTouch = 0;
  const guard = () => { suppressUntil = Date.now() + CLICK_GUARD_MS; };
  const clearStop = () => { if (g?.stop !== undefined) { clearTimeout(g.stop); g.stop = undefined; } };
  const ours = (event: PointerEvent) => !!g && (event.pointerId === g.id || !!g.interrupted);
  function fingerOf(event: TouchEvent) {
    const now = g; if (!now || !event.changedTouches) return undefined;
    for (const touch of Array.from(event.changedTouches)) { now.touchId ??= touch.identifier; if (touch.identifier === now.touchId) return { x: touch.clientX, y: touch.clientY }; }
    return undefined;
  }
  function finish() {
    const done = g; if (!done) return; g = undefined;
    clearTimeout(done.timer); clearTimeout(done.stop);
    for (const [type, listener, listenerOptions] of onDocument) document.removeEventListener(type, listener, listenerOptions);
    delete card.dataset.held; if (done.touch) lastTouch = Date.now();
    options.end?.();
  }
  function lift() {
    const now = g; if (!now || now.phase !== "wait") return; now.timer = undefined;
    if (!card.isConnected || !options.enabled()) { finish(); return; }
    now.phase = "held"; card.dataset.held = "true";
  }
  function drag(x: number, y: number) {
    const now = g!; clearTimeout(now.timer); delete card.dataset.held;
    const taken = options.drag({ pointerId: now.id, x, y, touch: now.touch });
    if (taken || now.touch) guard();
    if (taken) now.phase = "drag"; else finish();
  }
  function move(x: number, y: number) {
    const now = g; if (!now) return; now.px = x; now.py = y;
    if (now.phase === "drag" || Math.hypot(x - now.x, y - now.y) <= SLOP) return;
    // Moving before the hold completes is a scroll: the browser takes the gesture.
    if (now.phase === "wait" && now.touch) { finish(); return; }
    drag(x, y);
  }
  function up(x?: number, y?: number) {
    const now = g; if (!now) return;
    const held = now.phase === "held", at = { x: x ?? now.px, y: y ?? now.py };
    finish();
    if (held) { guard(); if (card.isConnected) options.release?.(at.x, at.y); }
  }
  // The browser took the pointer (pointercancel, lostpointercapture; Windows does so on press-and-hold). Before the lift it is a scroll. After it the
  // same finger is followed by touch events on the document (T40), and only letting go (or a second finger) ends it.
  function interrupt() { const now = g; if (!now) return; if (now.phase === "wait") finish(); else now.interrupted = true; }
  const onDocument: Listener[] = [
    ["pointermove", event => { if (ours(event)) { clearStop(); move(event.clientX, event.clientY); } }],
    ["pointerup", event => { if (ours(event)) { clearStop(); up(event.clientX, event.clientY); } }],
    ["pointercancel", event => { if (ours(event)) interrupt(); }],
    ["touchmove", event => {
      const now = g; if (!now) return;
      if (now.phase !== "wait" && event.cancelable) event.preventDefault();
      if (!now.interrupted || now.phase === "drag") return;
      const finger = fingerOf(event); if (!finger) return;
      clearStop(); move(finger.x, finger.y);
    }, { passive: false }],
    ["touchend", event => {
      const now = g; if (!now || !now.interrupted) return;
      const finger = fingerOf(event); if (!finger) return;
      if (event.cancelable) event.preventDefault();
      if (now.phase === "held") up(finger.x, finger.y); else finish();
    }, { passive: false }],
    // touchcancel is not final at once for a lifted card: a touch or pointer event that follows shows the finger is still down.
    ["touchcancel", () => { const now = g; if (!now) return; if (now.phase === "wait") { finish(); return; } now.interrupted = true; clearStop(); now.stop = setTimeout(finish, STOP_MS); }],
    ["touchstart", event => { if (g && event.touches && event.touches.length > 1) finish(); }],
    // A new pointer after the browser took the old one means that touch is gone and nothing will end this press.
    ["pointerdown", event => { if (g?.interrupted && event.pointerId !== g.id) finish(); }],
    ["keydown", event => { if (g && event.key === "Escape") finish(); }],
  ];
  const mouseListeners = onDocument.slice(0, 3);
  card.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0 || !options.enabled()) return;
    finish();
    const touch = touchLike(event);
    g = { id: event.pointerId, x: event.clientX, y: event.clientY, px: event.clientX, py: event.clientY, touch, phase: "wait" };
    for (const [type, listener, listenerOptions] of touch ? onDocument : mouseListeners) document.addEventListener(type, listener, listenerOptions);
    options.begin?.();
    if (touch) { lastTouch = Date.now(); g.timer = setTimeout(lift, HOLD_MS); }
  });
  card.addEventListener("pointermove", event => { if (g && event.pointerId === g.id) { clearStop(); move(event.clientX, event.clientY); } });
  card.addEventListener("pointerup", event => { if (g && event.pointerId === g.id) { clearStop(); up(event.clientX, event.clientY); } });
  for (const type of ["pointercancel", "lostpointercapture"]) card.addEventListener(type, () => { interrupt(); });
  // A lifted card must not scroll the list. The touch-action of the card is fixed at pointerdown, so the touchmove itself is cancelled.
  card.addEventListener("touchmove", event => { if (g && g.phase !== "wait" && event.cancelable) event.preventDefault(); }, { passive: false });
  card.addEventListener("click", event => {
    if (Date.now() < suppressUntil && event.detail !== 0) { suppressUntil = 0; event.preventDefault?.(); event.stopPropagation?.(); return; }
    options.click(event);
  });
  // Windows turns press-and-hold into a right click: that menu must neither open nor take the touch from the lifted card.
  card.addEventListener("contextmenu", event => {
    const viaTouch = touchLike(event as PointerEvent) || ((event as PointerEvent).pointerType !== "mouse" && (!!g?.touch || Date.now() - lastTouch < CONTEXT_GUARD_MS));
    if (viaTouch) { event.preventDefault(); event.stopPropagation(); return; }
    if (g) finish();
    options.contextmenu?.(event);
  });
}
