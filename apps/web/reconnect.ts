// Reconnect only obtains state. This module has no execution or save callback.
export const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15_000, 30_000] as const;
export interface ReconnectState { phase: "idle" | "waiting" | "connecting" | "paused" | "exhausted"; attempt: number; delayMs: number }
interface Options { connect: () => Promise<boolean>; changed: () => void; online: () => boolean; visible: () => boolean }
export function createReconnect(options: Options) {
  let state: ReconnectState = { phase: "idle", attempt: 0, delayMs: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined, generation = 0, active = false, waitingForState = false, failedWhileActive = false, blocked = false;
  function clear() { clearTimeout(timer); timer = undefined; }
  function update(phase: ReconnectState["phase"], delayMs = 0) { state = { phase, attempt: state.attempt, delayMs }; options.changed(); }
  function schedule(immediate = false) {
    if (blocked || timer !== undefined || active || waitingForState) return;
    if (!options.online() || !options.visible()) { update("paused"); return; }
    if (state.attempt >= RECONNECT_DELAYS.length) { update("exhausted"); return; }
    const delay = immediate ? 0 : RECONNECT_DELAYS[state.attempt]!;
    update("waiting", delay);
    timer = setTimeout(() => { timer = undefined; void connect(); }, delay);
  }
  async function connect() {
    if (blocked || !options.online() || !options.visible()) { update("paused"); return; }
    const expected = ++generation; active = true; failedWhileActive = false;
    state = { phase: "connecting", attempt: state.attempt + 1, delayMs: 0 }; options.changed();
    let opened = false;
    try { opened = await options.connect(); } catch { /* state recovery is bounded, never a write retry */ }
    if (generation !== expected) return;
    active = false;
    // A successful HTTP read still needs the first authenticated WSS state.
    if (opened && !failedWhileActive) waitingForState = true;
    else schedule();
  }
  return {
    get state(): ReconnectState { return { ...state }; },
    failed() { waitingForState = false; if (active) failedWhileActive = true; else schedule(); },
    recovered() { generation++; clear(); active = false; waitingForState = false; blocked = false; state = { phase: "idle", attempt: 0, delayMs: 0 }; options.changed(); },
    stop() { generation++; clear(); active = false; waitingForState = false; blocked = true; state = { phase: "idle", attempt: 0, delayMs: 0 }; options.changed(); },
    pause() { generation++; clear(); active = false; waitingForState = false; update("paused"); },
    wake() {
      if (blocked || active || state.phase === "waiting" && state.delayMs === 0) return;
      generation++; clear(); waitingForState = false; state = { phase: "idle", attempt: 0, delayMs: 0 }; schedule(true);
    },
    manual() {
      generation++; clear(); active = false; waitingForState = false; blocked = false;
      state = { phase: "idle", attempt: 0, delayMs: 0 }; void connect();
    },
  };
}
