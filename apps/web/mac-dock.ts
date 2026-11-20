import { make } from "./widgets/dom.js";
import { loadAppIcon } from "./app-icons.js";
import { DOCK_CAPSULE } from "./zones.js";
import { DOCK_OPTION_KEYS, DOCK_OPTION_SPECS, parseExecution, parseRunningApps, validDockOption, type DockApp, type DockOptionKey, type DockOptionMap, type Execution, type PxRect, type RunningApps } from "../../packages/contracts/index.js";

// T115 (ADR-099): the Mac Dock bar. A floating capsule at the foot of the page (in the strip zones.ts reserves) that lists the Mac apps running now, in the order of the macOS
// Dock; a tap brings that app to the front on the Mac. The setting is the layout's (the gear menu's "Mac Dock"), the list comes from the Host (a first read and then pushed events).
// This module owns the capsule and the two settings buttons (#dock-off, #dock-on, #dock-note, which widgets/settings.ts places). It never changes the layout itself.
// SIDE: the gap between the capsule and the sides of the strip, so it floats even where the content area reaches the window edges (the wide built-in themes).
const SIDE = { wide: 12, narrow: 8 }, ICON_MIN = 44, FADE_MS = 4000, OPTIMISTIC_MS = 3000, POLL_MS = 1500, POLLS = 4;
// T117 (ADR-101): the rows of the Dock settings window (gear > Mac Dock > Dock settings…). One entry per option: its storage key (packages/contracts DOCK_OPTION_KEYS), the label and the
// description. Adding an option is one entry here plus its key there (and, if it changes what the capsule shows, the place in paint() that reads `dockOptions`).
// T118 (ADR-102): a row is a `switch` (a boolean) or a `choice` (one of a list of {value,label}, shown as buttons like "Moving keys").
export type DockOptionRow = { key: DockOptionKey; label: string; description: string } & ({ kind: "switch" } | { kind: "choice"; choices: readonly { value: string; label: string }[] });
export const DOCK_OPTION_ROWS: readonly DockOptionRow[] = [
  { key: "hideKeyedApps", kind: "switch", label: "Hide apps that have an Open app key", description: "Apps you can already open with a key in this layout stay out of the Dock." },
  { key: "align", kind: "choice", label: "Position", description: "Where the Dock sits along the bottom of the screen.", choices: [{ value: "left", label: "Left" }, { value: "center", label: "Center" }, { value: "right", label: "Right" }] },
];
type OptionMap = DockOptionMap;
type OptionValue = boolean | string;
const noOptions = (): OptionMap => ({ hideKeyedApps: false, align: "center" });
// The Host's full map of options, or undefined for anything else (an older Host sends none). A choice the Host does not send (no `align`) reads as its default; a wrong value is no map.
function parseOptionMap(value: unknown): OptionMap | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const map = value as Record<string, unknown>, out: Record<string, unknown> = {};
  for (const key of DOCK_OPTION_KEYS) {
    const spec = DOCK_OPTION_SPECS[key], given = map[key];
    if (given === undefined && spec.kind === "choice") { out[key] = spec.fallback; continue; }
    if (!validDockOption(key, given)) return undefined;
    out[key] = given;
  }
  return out as unknown as OptionMap;
}
export interface DockMetrics { height: number; icon: number; gap: number; padX: number; width: number; scroll: boolean }
// Icons are 56px (44px in a narrow window) and shrink to a 44px touch size to fit; beyond that the list scrolls inside the capsule.
export function dockMetrics(count: number, available: number, narrow: boolean): DockMetrics {
  const height = DOCK_CAPSULE[narrow ? "narrow" : "wide"], max = height - 8, gap = narrow ? 6 : 8, padX = 10;
  const fit = count > 0 ? Math.floor((available - 2 * padX - gap * (count - 1)) / count) : max;
  const icon = Math.max(ICON_MIN, Math.min(max, fit));
  const natural = 2 * padX + Math.max(count, 1) * icon + gap * Math.max(count - 1, 0);
  return { height, icon, gap, padX, width: Math.max(0, Math.min(natural, available)), scroll: natural > available };
}
type Reply = { status: number; data: Record<string, unknown> & { error?: { message?: string } } } | undefined;
interface Options {
  host: HTMLElement;
  // A plain POST (the page's own request helper): a failure here never marks the connection lost or asks to pair again.
  call: (url: string, body: unknown, timeout?: number) => Promise<Reply>;
  // The layout this page shows, and what a save of its Dock must adopt (the layout's revision goes up by one, like the theme's).
  layout: () => { name: string | undefined; revision: number | undefined } | undefined;
  adopt: (reply: Record<string, unknown>, startedRevision: number | undefined) => Promise<void>;
  saving: (flag: boolean) => void;
  online: () => boolean;
  editing: () => boolean;
  // T115 follow-up (ADR-092): the lock the keys obey. "unknown": a result is unknown and every key stays locked until it is cleared in Settings;
  // "busy": an action is being sent, running or confirmed. The Dock sends nothing while either holds. Absent: never locked.
  locked?: () => "" | "busy" | "unknown";
  // The Mac cannot be changed right now (a draft, a save, no connection): why, or "".
  blocked: () => string;
  epoch: () => number;
  relayout: () => void;
  failed: (message: string) => void;
  loadIcon?: (appId: string) => Promise<string | null>;
  // T117: the bundle ids of the apps an `app.open` key of this layout opens (any page; window.activate keys and workflow steps do not count). Read at every paint.
  keyed?: () => Iterable<string>;
}
interface Item { appId: string; button: HTMLButtonElement; glyph: HTMLElement; img: HTMLImageElement }
export function createMacDock(options: Options) {
  const { host } = options, loadIcon = options.loadIcon ?? ((id: string) => loadAppIcon(id));
  const track = make("div", { className: "mac-dock-track" });
  const capsule = make("div", { className: "mac-dock-capsule", attrs: { role: "toolbar", "aria-label": "Running Mac apps" }, hidden: true }, track);
  const note = make("div", { className: "mac-dock-note", attrs: { role: "status", "aria-live": "polite" }, hidden: true });
  host.replaceChildren(capsule, note);
  const items = new Map<string, Item>();
  let enabled: boolean | undefined, list: RunningApps | undefined, strip: PxRect | undefined, narrow = false;
  let optimistic: string | undefined, optimisticTimer: ReturnType<typeof setTimeout> | undefined, noteTimer: ReturnType<typeof setTimeout> | undefined;
  let inflight: { id: string; appId: string } | undefined, pollTimer: ReturnType<typeof setTimeout> | undefined;
  let saving = false, settingNote = "", listEpoch = -1, pushedEpoch = -1;
  // T117: the Dock options of this layout (known once the Host has said), the settings window, and its own save state and note.
  let dockOptions = noOptions(), optionsKnown = false, optionSaving = false, optionNote = "", dialogOpen = false;
  const bound = new WeakSet<object>(), toggles = new Map<DockOptionKey, HTMLButtonElement>(), choiceButtons = new Map<DockOptionKey, Map<string, HTMLButtonElement>>();

  function say(message: string) {
    clearTimeout(noteTimer); note.textContent = message; note.hidden = !message;
    if (message) noteTimer = setTimeout(() => { note.textContent = ""; note.hidden = true; }, FADE_MS);
  }
  function itemFor(app: DockApp): Item {
    let item = items.get(app.appId);
    if (item) return item;
    const glyph = make("span", { className: "mac-dock-glyph", text: (Array.from(app.name)[0] ?? "?").toUpperCase(), attrs: { "aria-hidden": "true" } });
    const img = make("img", { className: "mac-dock-icon", hidden: true, attrs: { alt: "", draggable: "false", "aria-hidden": "true" } });
    const button = make("button", { className: "mac-dock-item", attrs: { type: "button" } }, glyph, img);
    item = { appId: app.appId, button, glyph, img }; items.set(app.appId, item);
    const made = item;
    button.addEventListener("click", () => { void activate(made.appId); });
    void loadIcon(app.appId).then(url => { if (url && items.get(app.appId) === made) { made.img.src = url; made.img.hidden = false; made.glyph.hidden = true; } }, () => {});
    return item;
  }
  function paint() {
    const show = !!strip && enabled === true;
    host.hidden = !show;
    paintSettings();
    if (!show || !strip) return;
    const editing = options.editing(), stale = !options.online(), lock = options.locked?.() ?? "", off = editing || stale || !!lock;
    host.dataset.align = dockOptions.align; host.style.setProperty("--dock-side", `${SIDE[narrow ? "narrow" : "wide"]}px`);
    host.dataset.editing = String(editing); host.dataset.stale = String(stale); host.dataset.locked = lock || "none";
    for (const [name, value] of [["left", strip.x], ["top", strip.y], ["width", strip.w], ["height", strip.h]] as const) host.style.setProperty(name, `${Math.round(value)}px`);
    const running = list?.status === "ready" ? list.apps : [];
    // T117: with "Hide apps that have an Open app key" on, the apps an app.open key of this layout opens stay out.
    const keyed = dockOptions.hideKeyedApps ? new Set(options.keyed?.() ?? []) : undefined, apps = keyed ? running.filter(app => !keyed.has(app.appId)) : running;
    const allKeyed = !!keyed && running.length > 0 && !apps.length;
    const room = Math.max(0, strip.w - 2 * SIDE[narrow ? "narrow" : "wide"]), metrics = dockMetrics(apps.length, room, narrow);
    for (const [name, value] of [["--dock-h", metrics.height], ["--dock-icon", metrics.icon], ["--dock-gap", metrics.gap], ["--dock-pad", metrics.padX]] as const) host.style.setProperty(name, `${value}px`);
    capsule.dataset.scroll = String(metrics.scroll);
    capsule.setAttribute("aria-disabled", String(off));
    // Not loaded yet: the strip stays reserved but empty. A Mac that cannot list its apps says so in the capsule.
    const unavailable = list?.status === "unavailable";
    const line = unavailable && !apps.length ? "Mac apps unavailable" : allKeyed ? "All running apps have keys" : "";
    capsule.hidden = !list || (!apps.length && !line);
    capsule.style.setProperty("width", `${line ? Math.min(room, 240) : metrics.width}px`);
    if (line) { track.replaceChildren(make("span", { className: "mac-dock-empty", text: line })); items.clear(); return; }
    const present = new Set(apps.map(app => app.appId));
    for (const id of [...items.keys()]) if (!present.has(id)) items.delete(id);
    const front = optimistic ?? apps.find(app => app.active)?.appId;
    const nodes: HTMLElement[] = [];
    for (const app of apps) {
      const item = itemFor(app);
      item.button.setAttribute("aria-label", app.name); item.button.title = app.name;
      item.button.dataset.appId = app.appId; item.button.dataset.hidden = String(app.hidden);
      item.button.dataset.active = String(app.appId === front);
      if (app.appId === front) item.button.setAttribute("aria-current", "true"); else item.button.removeAttribute("aria-current");
      item.button.disabled = off;
      nodes.push(item.button);
    }
    const current = Array.from(track.children);
    if (current.length !== nodes.length || current.some((child, index) => child !== nodes[index])) track.replaceChildren(...nodes);
  }
  function setOptimistic(appId: string | undefined) {
    clearTimeout(optimisticTimer); optimistic = appId;
    if (appId) optimisticTimer = setTimeout(() => { optimistic = undefined; paint(); }, OPTIMISTIC_MS);
  }
  function fail(message: string) {
    clearTimeout(pollTimer); inflight = undefined; setOptimistic(undefined); say(message); options.failed(message); paint();
  }
  function settle(execution: Execution, polls = 0) {
    if (!inflight || execution.requestId !== inflight.id) return;
    if (execution.status === "succeeded") { clearTimeout(pollTimer); inflight = undefined; paint(); return; }
    if (execution.status === "failed" || execution.status === "unknown") { fail(execution.message); return; }
    clearTimeout(pollTimer);
    const id = inflight.id;
    pollTimer = setTimeout(async () => {
      if (inflight?.id !== id) return;
      if (polls + 1 >= POLLS) { fail("The Mac did not confirm. Check it before trying again."); return; }
      const reply = await options.call("/api/result", { requestId: id }, 4000);
      if (inflight?.id !== id) return;
      try { settle(parseExecution(reply?.data.execution), polls + 1); } catch { fail("The Mac did not confirm. Check it before trying again."); }
    }, POLL_MS);
  }
  async function activate(appId: string) {
    if (enabled !== true || options.editing() || !options.online() || options.locked?.() || inflight || !list?.apps.some(app => app.appId === appId)) return;
    const id = crypto.randomUUID(), epoch = options.epoch();
    inflight = { id, appId }; setOptimistic(appId); paint();
    const reply = await options.call("/api/dock/activate", { requestId: id, appId }, 6000);
    if (inflight?.id !== id || epoch !== options.epoch()) return;
    if (!reply) { fail("Connection lost. Check the Mac; nothing was resent."); return; }
    if (reply.status !== 202) { fail(reply.data.error?.message ?? "The Mac did not accept this."); return; }
    try {
      const execution = parseExecution(reply.data.execution);
      if (execution.requestId !== id) throw new Error("Unexpected result.");
      settle(execution);
    } catch { fail("The Mac sent an unexpected reply. Check it before trying again."); }
  }
  // ---- the list ----
  function receive(next: RunningApps) {
    list = next; listEpoch = pushedEpoch = options.epoch();
    if (optimistic) setOptimistic(undefined);
    paint();
  }
  async function refresh() {
    const epoch = options.epoch(), reply = await options.call("/api/running-apps", {}, 4000);
    if (!reply || reply.status !== 200 || epoch !== options.epoch() || pushedEpoch === epoch) return;
    try { list = parseRunningApps(reply.data); listEpoch = epoch; paint(); } catch { /* the capsule keeps what it had */ }
  }
  // ---- the setting ----
  function setEnabled(value: boolean) {
    if (enabled === value) return;
    enabled = value; if (!value) { list = undefined; listEpoch = pushedEpoch = -1; }
    options.relayout(); paint();
  }
  async function load() {
    const epoch = options.epoch(), reply = await options.call("/api/device-dock", {}, 4000);
    if (!reply || reply.status !== 200 || epoch !== options.epoch() || typeof reply.data.dock !== "boolean") return;
    const map = parseOptionMap(reply.data.options);
    const changedOptions = !!map && (!optionsKnown || DOCK_OPTION_KEYS.some(key => map[key] !== dockOptions[key]));
    if (map) { dockOptions = map; optionsKnown = true; }
    setEnabled(reply.data.dock);
    if (changedOptions) paint();
    // A read per connection; after that the Host pushes changes.
    if (reply.data.dock && listEpoch !== epoch) await refresh();
  }
  async function save(value: boolean) {
    if (saving || enabled === undefined || value === enabled) return;
    const why = options.blocked(), where = options.layout();
    if (why || !where || where.name === undefined) { settingNote = why || "Wait a moment and try again."; paint(); return; }
    saving = true; settingNote = "Saving…"; paint();
    const epoch = options.epoch(), started = where.revision;
    options.saving(true);
    let reply: Reply;
    try { reply = await options.call("/api/device-dock/save", { dock: value, layoutName: where.name }, 6000); } finally { options.saving(false); }
    try {
      if (!reply) throw new Error("The Mac Dock save could not be confirmed. Reconnect to see the saved setting.");
      if (reply.status < 200 || reply.status >= 300) throw new Error(reply.data.error?.message ?? "The Mac Dock could not be saved.");
      if (epoch !== options.epoch() || typeof reply.data.dock !== "boolean") throw new Error("The save response belongs to an earlier connection. Reconnect to see the saved setting.");
      await options.adopt(reply.data, started);
      setEnabled(reply.data.dock); settingNote = "";
      if (reply.data.dock && listEpoch !== options.epoch()) void refresh();
    } catch (error) { settingNote = (error as Error).message; }
    finally { saving = false; paint(); }
  }
  // ---- the settings window (T117, ADR-101) ----
  async function setOption(key: DockOptionKey, value: OptionValue) {
    if (optionSaving || !optionsKnown || dockOptions[key] === value || !validDockOption(key, value)) return;
    const why = options.blocked(), where = options.layout();
    if (why || !where || where.name === undefined) { optionNote = why || "Wait a moment and try again."; paint(); return; }
    optionSaving = true; optionNote = "Saving…"; paint();
    const epoch = options.epoch(), started = where.revision;
    options.saving(true);
    let reply: Reply;
    try { reply = await options.call("/api/device-dock/options", { options: { [key]: value }, layoutName: where.name }, 6000); } finally { options.saving(false); }
    try {
      if (!reply) throw new Error("The Mac Dock options save could not be confirmed. Reconnect to see the saved setting.");
      if (reply.status < 200 || reply.status >= 300) throw new Error(reply.data.error?.message ?? "The Mac Dock option could not be saved.");
      const map = parseOptionMap(reply.data.options);
      if (epoch !== options.epoch() || !map) throw new Error("The save response belongs to an earlier connection. Reconnect to see the saved setting.");
      await options.adopt(reply.data, started);
      dockOptions = map; optionNote = "";
    } catch (error) { optionNote = (error as Error).message; }
    finally { optionSaving = false; paint(); }
  }
  const gearMenu = () => document.getElementById("connection-settings") as HTMLDetailsElement | null;
  function openDialog() {
    const dialog = document.getElementById("dock-dialog") as HTMLDialogElement | null;
    if (!dialog || dialogOpen || !optionsKnown) return;
    // The gear's menu would stay open behind the window (the Theme window does the same).
    const gear = gearMenu(); if (gear) gear.open = false;
    dialogOpen = true; optionNote = "";
    if (!dialog.open && typeof dialog.showModal === "function") dialog.showModal();
    paint();
  }
  // Esc, the close button and the dialog's own close all end here; focus goes back to the button that opened the window (in the gear menu, which is opened again for it).
  function closeDialog() {
    if (!dialogOpen) return;
    dialogOpen = false; optionNote = "";
    const dialog = document.getElementById("dock-dialog") as HTMLDialogElement | null;
    if (dialog?.open && typeof dialog.close === "function") dialog.close();
    const gear = gearMenu(); if (gear) gear.open = true;
    document.getElementById("dock-settings-open")?.focus();
    paint();
  }
  function paintDialog() {
    const dialog = document.getElementById("dock-dialog") as HTMLDialogElement | null, list = document.getElementById("dock-options"), close = document.getElementById("dock-dialog-close");
    if (!dialog || !list) return;
    if (!bound.has(dialog)) {
      bound.add(dialog);
      dialog.addEventListener("cancel", event => { event.preventDefault(); closeDialog(); });
      dialog.addEventListener("close", () => { if (dialogOpen) closeDialog(); });
      close?.addEventListener("click", closeDialog);
    }
    if (!bound.has(list)) {
      bound.add(list);
      list.replaceChildren(...DOCK_OPTION_ROWS.map(row => {
        const label = make("span", { id: `dock-option-${row.key}-label`, className: "dock-option-label", text: row.label });
        const note = make("p", { id: `dock-option-${row.key}-note`, className: "field-note", text: row.description });
        const text = make("div", { className: "dock-option-text" }, label, note);
        if (row.kind === "choice") {
          const buttons = new Map<string, HTMLButtonElement>();
          for (const choice of row.choices) {
            const button = make("button", { id: `dock-option-${row.key}-${choice.value}`, className: "move-choice", text: choice.label, attrs: { type: "button", "aria-pressed": "false" } });
            button.addEventListener("click", () => { void setOption(row.key, choice.value); });
            buttons.set(choice.value, button);
          }
          choiceButtons.set(row.key, buttons);
          return make("div", { className: "dock-option dock-option-choice" }, text, make("div", { className: "move-choices dock-choices", attrs: { role: "group", "aria-labelledby": label.id, "aria-describedby": note.id } }, ...buttons.values()));
        }
        const toggle = make("button", { id: `dock-option-${row.key}`, className: "dock-switch", attrs: { type: "button", role: "switch", "aria-checked": "false", "aria-labelledby": label.id, "aria-describedby": note.id } });
        toggle.addEventListener("click", () => { void setOption(row.key, toggle.getAttribute("aria-checked") !== "true"); });
        toggles.set(row.key, toggle);
        return make("div", { className: "dock-option" }, text, toggle);
      }));
    }
    const blocked = options.blocked(), locked = optionSaving || !optionsKnown || !!blocked;
    for (const row of DOCK_OPTION_ROWS) {
      if (row.kind === "choice") {
        for (const [value, button] of choiceButtons.get(row.key) ?? []) { button.setAttribute("aria-pressed", String(dockOptions[row.key] === value)); button.disabled = locked; }
        continue;
      }
      const toggle = toggles.get(row.key);
      if (!toggle) continue;
      toggle.setAttribute("aria-checked", String(dockOptions[row.key] === true)); toggle.disabled = locked;
    }
    const message = document.getElementById("dock-dialog-message");
    if (message) message.textContent = optionNote || blocked;
  }
  function paintSettings() {
    paintDialog();
    const opener = document.getElementById("dock-settings-open") as HTMLButtonElement | null;
    if (opener) {
      if (!bound.has(opener)) { bound.add(opener); opener.addEventListener("click", openDialog); }
      opener.disabled = !optionsKnown;
    }
    const find = (id: string) => document.getElementById(id) as HTMLButtonElement | null;
    const off = find("dock-off"), on = find("dock-on"), message = find("dock-note");
    const blocked = options.blocked(), locked = saving || enabled === undefined || !!blocked;
    for (const [button, value] of [[off, false], [on, true]] as const) {
      if (!button) continue;
      if (!bound.has(button)) { bound.add(button); button.addEventListener("click", () => { void save(value); }); }
      button.setAttribute("aria-pressed", String((enabled === true) === value)); button.disabled = locked;
    }
    if (message) message.textContent = settingNote || blocked || (enabled ? "The apps running on the Mac show at the bottom. Tap one to bring it to the front." : "Show the apps running on the Mac as a bar at the bottom.");
  }
  return {
    get enabled() { return enabled === true; },
    // Where the strip is now (undefined: no Dock in this window, or the page is not drawn).
    place(next: PxRect | undefined, isNarrow: boolean) { strip = next; narrow = isNarrow; paint(); },
    // The page's state changed (connection, Edit): redraw what depends on it.
    render() { paint(); },
    receive, refresh, load, save, setEnabled, setOption,
    // T117: the options as the Host last said, and whether the settings window is open.
    get options(): Readonly<OptionMap> { return dockOptions; },
    get settingsOpen() { return dialogOpen; },
    // A pushed running-apps event.
    apply(event: RunningApps) { receive({ status: event.status, apps: event.apps }); },
    // Every execution event goes through here; only the Dock's own request is taken.
    execution(execution: Execution) { settle(execution); },
    // The connection was lost or replaced: the list is not current any more (it stays visible, marked stale) and is read again on the next connection.
    disconnected() { listEpoch = pushedEpoch = -1; if (inflight) fail("Connection lost. Check the Mac; nothing was resent."); else paint(); },
    destroy() { clearTimeout(optimisticTimer); clearTimeout(noteTimer); clearTimeout(pollTimer); },
  };
}
export type MacDock = ReturnType<typeof createMacDock>;
