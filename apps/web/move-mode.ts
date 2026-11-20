// T88 (ADR-083): how a dragged component lands. Swap (default): it trades places with the component or blank it is dropped on, and leaves a blank where it was.
// Insert: it goes between two components and the order closes up behind it (the behavior of T65). A setting of this device only: localStorage, nothing goes to the Mac.
export type MoveMode = "swap" | "insert";
export const MOVE_MODE_KEY = "keyln.moveMode.v1";
export const DEFAULT_MOVE_MODE: MoveMode = "swap";
// Anything missing, damaged or unreadable (private window, blocked storage) is Swap.
export function loadMoveMode(storage: Pick<Storage, "getItem"> | undefined): MoveMode {
  try { return storage?.getItem(MOVE_MODE_KEY) === "insert" ? "insert" : DEFAULT_MOVE_MODE; } catch { return DEFAULT_MOVE_MODE; }
}
export function saveMoveMode(storage: Pick<Storage, "setItem"> | undefined, mode: MoveMode): boolean {
  try { if (!storage) return false; storage.setItem(MOVE_MODE_KEY, mode); return true; } catch { return false; }
}
const storageOf = (): Storage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };
// The two-choice control in the Settings menu (#move-mode-swap, #move-mode-insert; widgets/settings.ts places them).
export function createMoveMode(storage: Storage | undefined = storageOf()) {
  let mode = loadMoveMode(storage);
  const find = (id: string) => document.getElementById(id) as HTMLButtonElement | null;
  const buttons = (): Record<MoveMode, HTMLButtonElement | null> => ({ swap: find("move-mode-swap"), insert: find("move-mode-insert") });
  function paint() {
    for (const [name, button] of Object.entries(buttons()) as [MoveMode, HTMLButtonElement | null][]) button?.setAttribute("aria-pressed", String(name === mode));
    const note = find("move-mode-note");
    if (note) note.textContent = mode === "swap" ? "A key dropped on another key trades places; dropped on empty space it leaves a blank behind." : "A key dropped between two others goes there and the rest close up.";
  }
  function set(next: MoveMode) { if (next === mode) return; mode = next; saveMoveMode(storage, mode); paint(); }
  for (const [name, button] of Object.entries(buttons()) as [MoveMode, HTMLButtonElement | null][]) button?.addEventListener("click", () => set(name));
  paint();
  return { get mode() { return mode; }, set };
}
