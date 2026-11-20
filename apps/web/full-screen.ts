// T119 (ADR-103): full screen, a setting of this device only (the gear menu's "Full screen"). Windows Edge ignores `"display": "fullscreen"` of the web app manifest for an installed app
// (it opens as standalone, so the taskbar stays), so the page asks for full screen itself with the Fullscreen API. The browser only allows that from a user gesture: choosing On is one;
// after a load with On stored, the first touch, pen or mouse release or key press on the page asks once. Nothing is sent to the Mac.
export const FULLSCREEN_KEY = "keyln.fullscreen";
// Anything missing, damaged or unreadable (private window, blocked storage) is Off.
export function loadFullScreen(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try { return storage?.getItem(FULLSCREEN_KEY) === "on"; } catch { return false; }
}
export function saveFullScreen(storage: Pick<Storage, "setItem"> | undefined, on: boolean): boolean {
  try { if (!storage) return false; storage.setItem(FULLSCREEN_KEY, on ? "on" : "off"); return true; } catch { return false; }
}
const storageOf = (): Storage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };
// These keys never count as a user activation, so they must not use up the one try of this page load.
const NO_ACTIVATION = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Escape"]);
interface Options { storage?: Storage; doc?: Document; relayout?: () => void }
export function createFullScreen(options: Options = {}) {
  const storage = "storage" in options ? options.storage : storageOf(), doc = options.doc ?? document, relayout = options.relayout ?? (() => {});
  const root = () => doc.documentElement as HTMLElement | undefined;
  const supported = () => typeof root()?.requestFullscreen === "function" && doc.fullscreenEnabled !== false;
  const inFullScreen = () => !!doc.fullscreenElement;
  let on = supported() && loadFullScreen(storage), armed = false, refused = false;
  const find = (id: string) => doc.getElementById(id) as HTMLButtonElement | null;
  function paint() {
    const can = supported();
    for (const [id, value] of [["fullscreen-off", false], ["fullscreen-on", true]] as const) {
      const button = find(id); if (!button) continue;
      button.setAttribute("aria-pressed", String(on === value)); button.disabled = !can;
    }
    const note = find("fullscreen-note");
    if (note) note.textContent = !can ? "Full screen is not available in this browser." : refused ? "The browser refused full screen. Tap On again." :
      !on ? "The page keeps its normal window." : inFullScreen() ? "In full screen. Esc leaves it; it comes back with your first touch after a reload." :
      armed ? "On. Your next touch on the page enters full screen." : "On, but you left full screen. Tap On again, or reload the page.";
  }
  async function request() {
    refused = false;
    try { await root()!.requestFullscreen({ navigationUI: "hide" }); } catch { refused = true; }
    paint();
  }
  function disarm() {
    if (!armed) return;
    armed = false; doc.removeEventListener("pointerup", gesture, true); doc.removeEventListener("keydown", gesture, true);
  }
  // The first gesture of the page load asks once. It only listens: the touch or key press itself goes on to do what it always does.
  function gesture(event: Event) {
    if (event.type === "keydown" && NO_ACTIVATION.has((event as KeyboardEvent).key)) return;
    disarm();
    if (on && supported() && !inFullScreen()) void request(); else paint();
  }
  function arm() {
    if (armed || !on || !supported() || inFullScreen()) return;
    armed = true; doc.addEventListener("pointerup", gesture, true); doc.addEventListener("keydown", gesture, true);
  }
  function set(next: boolean) {
    if (!supported()) return;
    on = next; saveFullScreen(storage, on); disarm(); refused = false;
    if (on) { if (!inFullScreen()) void request(); } else if (inFullScreen()) { try { void Promise.resolve(doc.exitFullscreen()).catch(() => {}); } catch { /* already out */ } }
    paint();
  }
  for (const [id, value] of [["fullscreen-off", false], ["fullscreen-on", true]] as const) find(id)?.addEventListener("click", () => set(value));
  doc.addEventListener("fullscreenchange", () => { if (inFullScreen()) refused = false; relayout(); paint(); });
  arm(); paint();
  return { get on() { return on; }, get armed() { return armed; }, set, render: paint };
}
export type FullScreen = ReturnType<typeof createFullScreen>;
