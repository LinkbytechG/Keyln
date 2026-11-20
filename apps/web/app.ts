import { moveToPage, moveToPageSwap, moveToSlot, moveWidget, swapWidgets, resizeWidget, type Container } from "./page-layout.js";
import { createMoveMode } from "./move-mode.js";
import { createFullScreen } from "./full-screen.js";
import { Fault, EVENT_PATH, EVENT_PROTOCOL, DEFAULT_THEME, allComponents, applySplit, findComponent, isBlank, isPages, locate, resolveTheme, parseHostEvent, parseExecution, parseConfig, parseScriptInfo, parseShortcutInfo, parseWindows, parseAppRecent, splitView, stableId, needsConfirmation, viewFor,
  type AppInfo, type Component, type Config, type ConfigDocument, type Execution, type StateEvent, type ScriptInfo, type ShortcutInfo, type CustomTheme, type ThemeChoice, type ThemeName } from "../../packages/contracts/index.js";
import { createControlDesk, type DropTarget, type TileFeedback } from "./console.js";
import { createLibrary, type LibrarySpec } from "./library.js";
import { createEditMenu } from "./edit-menu.js";
import { createEditBar } from "./edit-bar.js";
import { createLibraryResize, CANVAS_GAP, SHELF_GRAB, TOP_FALLBACK } from "./library-resize.js";
import { createConfigurationEditor } from "./editor.js";
import { rememberApp } from "./app-picker.js";
import { enhanceSelect } from "./select-menu.js";
import { createThemeEditor } from "./theme-editor.js";
import { createFirstTheme } from "./first-theme.js";
import { deriveTheme, paintVariables } from "./theme-custom.js";
import { hydrateIcons, repeatsPhrase, setActiveTheme } from "./presentation.js";
import { cachedTheme, createThemePicker, paintTheme } from "./themes.js";
import { createLayoutFiles } from "./layout-files.js";
import { createReconnect } from "./reconnect.js";
import { resetAppIcons } from "./app-icons.js";
import { createInstallExperience } from "./install.js";
import { createPageRefresh } from "./page-refresh.js";
import { createRegistry, type DeskIntents } from "./widgets/registry.js";
import { initialDeskState, READY_LINE, type DeskState, type ResultState } from "./widgets/state.js";
import { createRuntime, registerSystemWidgets } from "./widgets/system.js";
import { createZones, dockReserve, dockStrip, planZones, safeInsets, type Insets } from "./zones.js";
import { createMacDock } from "./mac-dock.js";
import { createSubscriptionClient } from "./subscription-client.js";
import { isSubscriptionKind, subscriptionProvider, type SubscriptionProvider } from "../../packages/contracts/subscription.js";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (id: string, value: string) => { el(id).textContent = value; };
const input = (id: string) => el<HTMLInputElement>(id);
el("startup-help").hidden = true;
// T62 (ADR-064): the three system components (connection, Use | Edit switch, settings) are made here and placed by the theme's zones; the other widgets are
// ordinary widgets of the canvas and are made by the control desk (console.ts). They all act through these intents only.
const intents: DeskIntents = {
  refresh: () => pageRefresh.request(),
  reconnect: () => { reconnect.manual(); },
  setMode: mode => { if (mode === "edit") editor.requestEdit(); else leaveEdit(); },
};
const registry = createRegistry(intents);
registerSystemWidgets(registry);
const widgets = createRuntime(registry);
// T88 (ADR-083): how a dragged component lands, a setting of this device (the gear menu's "Moving keys").
const moveMode = createMoveMode();
let desk: DeskState = initialDeskState(DEFAULT_THEME);
// Widgets draw from the last snapshot; a patch changes only what it names.
function paint(patch: Partial<DeskState>) { desk = { ...desk, ...patch }; widgets.update(desk); controlDesk.updateWidgets(desk); }
const subscriptionClient = createSubscriptionClient(subscriptions => paint({ subscriptions }));
// Back to Use mode: a draft asks by itself.
function leaveEdit() { editor.requestUse(); }
// ADR-064/ADR-087: the theme a device shows is the theme of its layout, kept on the Mac (a field of the layout in config.json); a custom theme that was deleted means the default theme.
let deviceChoice: ThemeChoice | undefined, deviceThemeLoaded = false;
// A plain request like the old device-layout read, so a failure here never marks the connection lost or asks to pair again.
type PlainReply = { status: number; data: { theme?: unknown; layoutName?: unknown; previousLayoutRevision?: unknown; layoutRevision?: unknown; error?: { message?: string } } & Record<string, unknown> } | undefined;
const deviceThemeCall = (path: string, body: unknown, timeout = 4000): Promise<PlainReply> => plainCall(`/api/device-theme${path ? `/${path}` : ""}`, body, timeout);
async function plainCall(url: string, body: unknown, timeout = 4000): Promise<PlainReply> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Keyln-Client": "1" }, body: JSON.stringify(body), signal: controller.signal });
    let data = {}; try { data = await response.json(); } catch { /* No body: the status says enough. */ }
    return { status: response.status, data };
  } catch { return undefined; } finally { clearTimeout(timer); }
}
async function loadDeviceTheme() {
  const epoch = connectionEpoch, reply = await deviceThemeCall("", {});
  if (!reply || reply.status !== 200 || epoch !== connectionEpoch) return;
  const stored = reply.data.theme, next = typeof stored === "string" ? stored as ThemeChoice : undefined;
  // The Mac has answered, so "none yet" (null) is now known: that is what asks a new device for its theme.
  const first = !deviceThemeLoaded;
  deviceThemeLoaded = true;
  if (next === deviceChoice && !first) return;
  deviceChoice = next; render();
}
hydrateIcons(); text("host-address", location.origin);
createInstallExperience();
for (let slot = 0; slot < 12; slot++) {
  const node = document.createElement("div"); node.className = "skeleton-tile"; node.setAttribute("aria-hidden", "true"); el("button-grid").append(node);
}
el("desk").hidden = false;
let connected = false, paired = false, busy = false, sending = false, syncing = false;
let configurationUnavailable = false, moveSaving = false, unsupported = false;
let config: Config | undefined, apps: AppInfo[] = [], pending: string | undefined, unknown = false;
let scripts: ScriptInfo[] = [],shortcuts:ShortcutInfo[]=[];
let pendingButtonId: string | undefined, resultButtonId: string | undefined, resultContext = "", resultName = "", resultKeyed = false;
const feedback = new Map<string, TileFeedback>();
const feedbackDetails = new Map<string, string>(), feedbackTimers = new Map<string, ReturnType<typeof setTimeout>>();


// The theme is this device's own choice (ADR-064). Until the Mac answers the page shows the theme this browser last saw (or the default);
// a choice is shown at once and stays "pending" until the Mac has saved it.
let shownTheme: ThemeName = cachedTheme() ?? DEFAULT_THEME, themePending: ThemeName | undefined, themeNote = "", shownThemeKey = "";
setActiveTheme(shownTheme); paintTheme(shownTheme);
let resultView: Omit<ResultState, "unknown"> = { status: "ready", title: "Ready", line: READY_LINE, detail: "" };
let eventSocket: WebSocket | undefined, eventTimer: ReturnType<typeof setTimeout> | undefined;
let eventsFailed = false, eventsReady = false, hostInstanceId: string | undefined;
// T84 (ADR-079): the icons kept on this device start empty on every page load and again after a lost connection is restored.
let iconsStale = false; resetAppIcons();
let latestState: StateEvent | undefined, lastExecution: Execution | undefined;
let connectionEpoch = 0;
interface RiskIntent {id:string;button:Component;revision:number;epoch:number;token?:string;expiresAt?:number}
let riskIntent:RiskIntent|undefined,riskTimer:ReturnType<typeof setTimeout>|undefined;
let syncSerial = 0, syncController: AbortController | undefined;
const pendingKey = "keyln.pending-request";
const pendingButtonKey = "keyln.pending-button", pagesKey = "keyln.active-pages";
// The page each Pages widget shows (widget id -> page id); a widget that is not listed shows its first page. Kept for the browser tab, not on the Mac.
const pageOf = new Map<string, string>();
let canTrackRequests = true;
try {
  sessionStorage.setItem("keyln.storage-check", "1"); sessionStorage.removeItem("keyln.storage-check");
  pending = sessionStorage.getItem(pendingKey) || undefined;
  if (pending) {
    try { pendingButtonId = stableId(sessionStorage.getItem(pendingButtonKey) || "primary"); } catch { pendingButtonId = undefined; }
    resultButtonId = pendingButtonId;
  }
  try {
    const stored = JSON.parse(sessionStorage.getItem(pagesKey) || "{}") as Record<string, unknown>;
    for (const [widget, page] of Object.entries(stored)) if (typeof page === "string") pageOf.set(stableId(widget), stableId(page));
  } catch { pageOf.clear(); }
} catch { canTrackRequests = false; }
// T94: the library revision (`revision`) and the layout's own revision move independently. A newer layout name (the device was given another layout) always replaces.
function isNewer(next: Config, current: Config): boolean {
  return next.layoutName !== current.layoutName || next.revision >= current.revision && (next.layoutRevision ?? 0) >= (current.layoutRevision ?? 0);
}
// The save request: the parts of `candidate` that differ from `base`, each checked by the Mac against its own revision (the parts that did not change are not sent).
function saveBody(base: Config, candidate: Config) {
  if (base.layoutName === undefined || base.layoutRevision === undefined) throw new Error("The layout has not been loaded from the Mac yet.");
  return { libraryRevision: base.revision, layoutName: base.layoutName, layoutRevision: base.layoutRevision, ...splitView(base, candidate) };
}
// An import replaces everything: the document the Mac reviewed, with the edits made to the draft folded into the layout the draft shows.
function importDocument(imported: ConfigDocument, candidate: Config, base: Config): ConfigDocument {
  const name = candidate.layoutName ?? imported.defaultLayout, next = applySplit(imported, name, splitView(viewFor(imported, name), candidate));
  next.library.revision = base.revision;
  return next;
}
const editor = createConfigurationEditor({
  changed: render,
  pagesGeometry: id => controlDesk.pagesGeometry(id),
  pagesColumns: id => controlDesk.pagesColumns(id),
  windows: async id => parseWindows((await api<{windows: unknown}>("windows", {appId: id})).windows),
  // The Mac gives an online search up to 9 seconds; the page waits a little longer than that for its answer.
  library: (action, value) => api<unknown>(action === "list" ? "icon-library" : `icon-library/${action}`, value, undefined, 12_000),
  bindings: async layout => (await api<{ issues: Array<{ location: string; message: string }> }>("configuration/preview", layout)).issues.map(issue => `${issue.location}: ${issue.message}`),
  // A new component goes to the page that is showing, else the canvas.
  container: () => currentContainer(),
  reload: async () => await sync(true) ? config : undefined,
  test: (id, revision) => { void executeButton(id, revision, true); },
  // T94: a save sends only what changed against `base` (the draft's baseline), each part with its own revision; an import sends the whole document it was made from.
  save: async (candidate, base, imported) => {
    const epoch = connectionEpoch;
    const response = await api<{ config: Config }>(imported ? "configuration/import" : "configuration/save", imported ? { config: importDocument(imported.document, candidate, base), stamp: imported.stamp } : saveBody(base, candidate));
    const saved = parseConfig(response.config);
    if (epoch !== connectionEpoch || !connected || eventsFailed)
      throw new Error("The save response could not be confirmed. Reconnect and load the latest layout.");
    if (!config || isNewer(saved, config)) config = saved;
    editor.receive(config, apps, hostInstanceId!, scripts,shortcuts);
    for (const button of allComponents(candidate)) if (button.id !== pendingButtonId) feedback.delete(button.id);
    return config;
  },
});
// T41: the selects of Edit become styled menus (the native selects stay, hidden, as the source of truth). The ones built later
// (script parameters, workflow steps, window pickers) are enhanced where they are built.
for (const id of ["shortcut-key", "script-select", "mac-shortcut-select", "workflow-select", "library-set", "library-dialog-set"]) enhanceSelect(el<HTMLSelectElement>(id));
// A device without a theme of its own is asked once (T64): shown when this device is paired, online and not in Edit; "Not now" holds for this browser tab.
const firstTheme = createFirstTheme({ customThemes: () => config?.customThemes ?? [], width: () => typeof window.innerWidth === "number" ? window.innerWidth : 1366,
  choose: async choice => { await setDeviceTheme(choice); themeNote = "Theme saved for this device."; render(); } });
function askForTheme() {
  const wanted = deviceThemeLoaded && deviceChoice === undefined && paired && !!config && !configurationUnavailable && connected && eventsReady && !eventsFailed && !editor.active && !riskIntent &&
    !themePending && !themeEditor.isOpen() && !firstTheme.skipped() && el("install-panel").hidden === true && el("layout-files-panel").hidden === true;
  if (wanted && !firstTheme.isOpen()) firstTheme.show();
  else if (!wanted && firstTheme.isOpen() && (!firstTheme.busy() || deviceChoice !== undefined)) firstTheme.hide();
}
const themePicker = createThemePicker({ container: el("theme-picker"), choose: theme => { void chooseTheme(theme); } });
// The theme this device shows: its own choice, resolved against the shared custom themes (a custom theme that no longer exists is the default).
const resolved = () => resolveTheme(deviceChoice, config?.customThemes);
const themeEditor = createThemeEditor({ config: () => config, blocked: () => themeBlocked(), save: (themes, theme) => saveThemes(themes, theme), changed: () => render(),
  deviceTheme: () => resolved().choice });
// The page a Pages widget shows now (its first page when none was chosen or the chosen one is gone).
function shownPageId(widget: Extract<Config["widgets"][number], { kind: "pages" }>): string {
  const wanted = pageOf.get(widget.id);
  return widget.pages.some(page => page.id === wanted) ? wanted! : widget.pages[0]!.id;
}
// Where a new component goes first: the page of the first Pages widget that is showing.
function currentContainer(): Container {
  const widget = (editor.view || config)?.widgets.find(isPages);
  return widget ? { pagesId: widget.id, pageId: shownPageId(widget) } : {};
}
function goToPage(pagesId: string, pageId: string) {
  const widget = (editor.view || config)?.widgets.find(item => item.id === pagesId);
  if (editor.saving || !widget || !isPages(widget) || !widget.pages.some(page => page.id === pageId)) return;
  pageOf.set(pagesId, pageId);
  try { sessionStorage.setItem(pagesKey, JSON.stringify(Object.fromEntries(pageOf))); } catch { /* Page selection is optional persistence. */ }
  render();
}
// T65: the theme places the system controls and gives the responsive canvas its actual content area.
let insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 }, insetsFor = "";
const zones = createZones({ shell: el("shell"), layer: el("system-layer"), bar: el("system-bar"), frame: el("grid-frame"),
  system: (part, form) => widgets.instance(part, form)?.element, all: () => widgets.elements() });
// T115 (ADR-099): the Mac Dock bar of this layout. It sits in the strip layoutZones reserves; the setting is the layout's and saves like the theme (it raises the layout's revision only).
const macDock = createMacDock({ host: el("mac-dock"), call: plainCall, layout: () => config && { name: config.layoutName, revision: config.layoutRevision },
  adopt: (data, started) => adoptSavedRevision(data, started), saving: flag => { themeSaving = flag; },
  online: () => connected && eventsReady && !eventsFailed, editing: () => editor.active,
  // The same lock as the keys (console.ts): an unknown result locks everything until it is cleared; a send, a running action or a confirmation holds it briefly.
  locked: () => unknown ? "unknown" : busy || sending || editor.saving || !!riskIntent || moveSaving || !!pending ? "busy" : "",
  blocked: () => !paired || !config || configurationUnavailable ? "" : editor.dirty ? "Save or discard your draft first." : editor.saving ? "Wait until the configuration has finished saving." :
    !connected || !eventsReady || eventsFailed ? "Reconnect to the Mac to change the Mac Dock." : "",
  epoch: () => connectionEpoch, relayout: () => layoutZones(),
  // T117 (ADR-101): the apps an app.open key of this layout opens (any page; window.activate keys do not count), for "Hide apps that have an Open app key".
  keyed: () => config ? allComponents(config).flatMap(key => key.action?.type === "app.open" ? [key.action.appId] : []) : [],
  failed: message => queueMicrotask(() => { if (!pending && !unknown && !sending) { result("rejected", "Mac Dock", message); render(); } }) });
// T83 (ADR-078): the toolbar of Edit floats, moves by its grip, collapses to an icon and remembers its place on this device.
const editBar = createEditBar({ bar: el("edit-toolbar"), row: el("edit-float-row"), grip: el("edit-grip"), chip: el("edit-chip"), collapse: el("edit-collapse") });

// Only the component library (when open) covers a good part of the foot of the window, so the canvas keeps clear of it. The Edit toolbar floats over the preview (T83, ADR-078) and reserves nothing.
const SHELF_RESERVE = 252;
// The library is 244px high, or 52% of the window up to 400px on a narrow one (style.css --shelf-h).
function shelfReserve(): number {
  if (typeof window.innerWidth === "number" && window.innerWidth <= 600) return Math.round(Math.min(window.innerHeight * 0.52, 400)) + 8;
  return SHELF_RESERVE;
}
// Measure the open library after layout, so the safe-area inset and the short-phone heights need no viewport-specific estimate.
function editReserve(known: boolean): number {
  if (!editor.active || !library.open) return 0;
  const shelf = el("shelf-panel").getBoundingClientRect();
  if (known && shelf.height > 0) {
    const base = planZones(shownLayout, { width: window.innerWidth, height: window.innerHeight }, insets);
    return Math.max(0, insets.top + base.content.y + base.content.h - shelf.top + CANVAS_GAP + SHELF_GRAB);
  }
  // No CSS layout in the minimal DOM harness; the real browser always takes the measured path.
  return shelfReserve();
}
function layoutZones() {
  const known = typeof window !== "undefined" && typeof window.innerWidth === "number";
  if (known) {
    const size = `${window.innerWidth}x${window.innerHeight}`;
    if (size !== insetsFor) { insetsFor = size; insets = safeInsets(); }
  }
  const drawn = known && paired && !configurationUnavailable && !el("desk").hidden && el("install-panel").hidden === true && el("layout-files-panel").hidden === true;
  // T115: the Mac Dock keeps a strip at the foot of the content area (also in Edit, so the canvas does not reflow); with the library shelf open the larger of the two reserves is kept.
  const viewport = known ? { width: window.innerWidth, height: window.innerHeight } : { width: 0, height: 0 };
  const dockRoom = known && macDock.enabled ? dockReserve(shownLayout, viewport, insets) : 0, reserve = Math.max(dockRoom, editReserve(known));
  const plan = zones.apply(shownLayout, viewport, drawn, insets, reserve);
  macDock.place(plan && dockRoom > 0 ? dockStrip(plan, insets, reserve, dockRoom) : undefined, plan?.set === "narrow");
  controlDesk.refit(); editBar.refit(); libraryResize.refit(); editor.refitCard();
}
if (typeof window.addEventListener === "function") {
  for (const name of ["resize", "orientationchange"]) window.addEventListener(name, layoutZones);
  window.visualViewport?.addEventListener("resize", layoutZones);
}
// T119 (ADR-103): full screen, a setting of this device (the gear menu's "Full screen"). Entering or leaving it changes the window, so the page is laid out again.
createFullScreen({ relayout: () => layoutZones() });
const controlDesk = createControlDesk({ grid: el("button-grid"), frame: el("grid-frame"), moveMode: () => moveMode.mode,
  // Fallback room before the browser exposes client dimensions (which exclude native scrollbars).
  area: () => { const room = zones.area(), pad = zones.pad * 2; return room && { width: Math.max(0, room.width - pad), height: Math.max(0, room.height - pad) }; },
  createWidget: (kind, form, standalone) => registry.has(kind) ? registry.create(kind, form, standalone) : undefined,
  onRun: (id, revision) => { void executeButton(id, revision); },
  onSelect: id => editor.selectComponent(id),
  // Edit mode (ADR-064): the "−", a tap on empty canvas, the quick menu, the "+" of a page strip, and a library card dropped on the canvas.
  onRemove: id => editor.removeComponent(id),
  onBlank: () => { menu.close(); editor.deselect(); },
  onMenu: (target, x, y) => menu.open(target, x, y),
  onMenuDrag: () => menu.close(),
  onAddPage: pagesId => { if (editor.addPageTo(pagesId)) goToLastPage(pagesId); },
  onDropNew: (spec, target) => dropNew(spec as LibrarySpec, target),
  onPagesResizeStart: id => { menu.close(); return editor.beginPagesResize(id); },
  onPagesResizePreview: (id, size) => editor.previewPagesResize(id, size),
  onPagesResizeEnd: commit => editor.endPagesResize(commit),
  locked: () => editor.resizing,
  onLift: id => liftKey(id),
  onDrop: (id, target) => { void dropKey(id, target); },
  onLiftStopped: (id, reason) => liftStopped(id, reason),
  canDropOnPage: (id, pagesId, pageId) => { try { const base = editor.active ? editor.view : config; return !!base && !!moveToPage(base, id, pagesId, pageId); } catch { return false; } },
  // A long press in Use mode, or letting go of a lifted key without moving it, opens the key popup (Edit mode starts with it).
  onEdit: id => { editor.startEditing(id, true); },
  onPage: (pagesId, pageId) => goToPage(pagesId, pageId),
});
if (typeof ResizeObserver === "function") {
  const observeEdit = new ResizeObserver(() => { if (editor.active) layoutZones(); });
  observeEdit.observe(el("shelf-panel"));
}

// ADR-064 / T63: the component library (a panel at the foot of Edit) and the quick menu (long press or right click).
const library = createLibrary({
  recent: async () => parseAppRecent(await api("apps/recent", {})),
  apps: () => apps, online: () => connected && eventsReady && !eventsFailed,
  windows: async id => parseWindows((await api<{windows: unknown}>("windows", {appId: id})).windows),
  editable: () => editor.active && !editor.saving && !editor.resizing,
  place: spec => editor.addNew(spec),
  drag: (source, spec, span, pointer, preview) => controlDesk.beginExternal(source, spec, span, pointer, preview),
  inspectFile: file => editor.inspectFile(file),
  placeFile: size => editor.placeFile(size),
  changed: () => render(),
});
const menu = createEditMenu({
  view: () => editor.view,
  resize: (id, tier) => {
    const draft = editor.view; if (!draft) return;
    try { editor.applyDraft(resizeWidget(draft, id, tier)); } catch (error) { say("Not resized", (error as Error).message); }
  },
  edit: id => editor.selectComponent(id),
  remove: id => editor.removeComponent(id),
  tab: { rename: (pagesId, pageId) => editor.renamePageIn(pagesId, pageId), remove: (pagesId, pageId) => editor.removePageFrom(pagesId, pageId), move: (pagesId, pageId, step) => { editor.movePageIn(pagesId, pageId, step); } },
});
// A new page shows at once (the "+" of the page strip).
function goToLastPage(pagesId: string) {
  const widget = editor.view?.widgets.find(item => item.id === pagesId);
  if (widget && isPages(widget)) goToPage(pagesId, widget.pages[widget.pages.length - 1]!.id);
}
function dropNew(spec: LibrarySpec, target: DropTarget | undefined) {
  if (!target) { say("Not added", "Drop it on the canvas or on a page of a Pages widget."); return; }
  if ("refused" in target) { say("Not added", target.refused); return; }
  const problem = editor.addNew(spec, "tab" in target ? { tab: target.tab } : "swap" in target ? { replace: target.swap.id } : "empty" in target ? undefined : { container: target.container, index: target.index });
  if (problem) say("Not added", problem);
}
// Closing or reloading the page with unsaved changes asks first.
window.addEventListener("beforeunload", event => { if (editor.dirty) { event.preventDefault(); event.returnValue = ""; } });
const layoutFiles = createLayoutFiles({post:api,
  current:()=>paired&&config&&hostInstanceId&&!configurationUnavailable?{revision:config.revision,layoutRevision:config.layoutRevision,layoutName:config.layoutName,instanceId:hostInstanceId}:undefined,
  available:()=>connected&&eventsReady&&!eventsFailed&&!busy&&!sending&&!pending&&!riskIntent&&!editor.saving&&!editor.resizing,
  adopt:(view,document,stamp)=>editor.importDraft(view,document,stamp),
});
const networkOnline = () => globalThis.navigator?.onLine !== false;
const reconnect = createReconnect({connect:()=>sync(true),changed:render,online:networkOnline,visible:()=>!document.hidden});
const pageRefresh = createPageRefresh({
  state: () => ({ dirty: editor.dirty, blocked: editor.refreshBlocked, pending: sending || busy || !!pending, online: networkOnline() }),
  discardDraft: () => editor.discardDraft(),
  changed: () => paint({ refresh: refreshState() }),
});
const refreshState = () => ({ disabled: pageRefresh.disabled, blocked: editor.refreshBlocked });

function remember(id?: string, buttonId?: string) {
  pending = id;
  pendingButtonId = id ? buttonId ?? pendingButtonId : undefined;
  try {
    if (id) {
      sessionStorage.setItem(pendingKey, id); if (pendingButtonId) sessionStorage.setItem(pendingButtonKey, pendingButtonId);
    }
    else { sessionStorage.removeItem(pendingKey); sessionStorage.removeItem(pendingButtonKey); }
    return true;
  }
  catch { canTrackRequests = false; return false; }
}
function buttonContext(id: string) {
  const found = config ? locate(config, id) : undefined;
  return found?.widget && "label" in found.widget ? `${found.page?.name || "Canvas"} · ${found.widget.label}` : "Previous action";
}
// The zones the page draws now: the device theme's, or what the Theme window is previewing.
let shownLayout = resolveTheme(undefined, undefined).layout, shownLayoutKey = "";
// T86 (ADR-081): the top edge of the Library resizes it (--shelf-h on the shell), remembered on this device.
const libraryResize = createLibraryResize({ shell: el("shell"), panel: el("shelf-panel"), handle: el("shelf-resize"), contentTop: () => {
  if (typeof window.innerWidth !== "number" || typeof window.innerHeight !== "number") return TOP_FALLBACK;
  return insets.top + planZones(shownLayout, { width: window.innerWidth, height: window.innerHeight }, insets).content.y;
} });
function render() {
  pageRefresh.render();
  const loading = !config && syncing;
  el("shell").dataset.paired = String(paired); el("shell").dataset.editing = String(editor.active); el("shell").dataset.loading = String(loading);
  el("pair-panel").hidden = paired || loading || configurationUnavailable;
  el("desk").hidden = !paired && !loading || configurationUnavailable;
  el("configuration-recovery").hidden = !configurationUnavailable;
  const recovery = reconnect.state;
  const recoveryMessage = recovery.phase === "waiting" ? `Reconnecting automatically · attempt ${recovery.attempt + 1}/6 in ${recovery.delayMs / 1000}s. Nothing will be resent.` :
    recovery.phase === "connecting" ? `Reconnecting · attempt ${recovery.attempt}/6. Reading Mac state only.` :
    recovery.phase === "exhausted" ? "Automatic reconnect stopped after 6 attempts. Check the Mac and Wi-Fi, then tap the connection status to reconnect. Nothing was resent." :
    recovery.phase === "paused" && paired ? "Connection paused while offline or in the background. It will resync when this page is visible and online." : "";
  text("connection-recovery", recoveryMessage); el("connection-recovery").hidden = !recoveryMessage;
  // T42: the Theme window previews what it is showing on the whole page; otherwise a custom theme in use is painted over its base.
  const preview = themeEditor.preview(), own = resolved();
  const custom = !preview && !themePending ? own.custom : undefined;
  const theme = preview?.base ?? themePending ?? (config || deviceChoice ? own.name : shownTheme);
  const vars = preview ? preview.vars : custom ? deriveTheme(custom).vars : {}, ground = preview ? preview.ground : custom?.background;
  const paintKey = JSON.stringify([theme, vars, ground ?? ""]);
  if (theme !== shownTheme) { shownTheme = theme; setActiveTheme(theme); }
  if (paintKey !== shownThemeKey) { shownThemeKey = paintKey; paintTheme(theme, ground); paintVariables(document.documentElement, vars); }
  const layout = preview?.layout ?? (preview || themePending ? resolveTheme(theme, undefined).layout : own.layout), layoutKey = JSON.stringify(layout);
  if (layoutKey !== shownLayoutKey) { shownLayoutKey = layoutKey; shownLayout = layout; }
  const blocked = deviceThemeBlocked();
  themePicker.render(preview || custom ? undefined : theme, !blocked && !themePending);
  themeEditor.configChanged(); themeEditor.render();
  layoutFiles.render();
  el("edit-float").hidden = !editor.active; editBar.render(editor.active, editor.dirty); el("shell").dataset.shelf = String(editor.active && library.open);
  if (!editor.active) { library.reset(); menu.close(); }
  else library.render();
  el("shelf-toggle").setAttribute("aria-pressed", String(library.open));
  // The settings card goes to the side the edited component is not on.
  let side = "right";
  if (editor.selectedId && typeof document.querySelector === "function" && typeof window.innerWidth === "number") {
    const node = document.querySelector(`[data-button-id="${editor.selectedId}"],[data-widget-id="${editor.selectedId}"]`) as HTMLElement | null;
    const box = node?.getBoundingClientRect?.();
    if (box && box.width > 0 && box.left + box.width / 2 > window.innerWidth / 2) side = "left";
  }
  el("edit-float").dataset.cardSide = side;
  // Everything the widgets draw: the first snapshot is what they show before the configuration arrives.
  const early: Partial<DeskState> = {
    paired, editing: editor.active, theme,
    connection: { text: unsupported ? "Browser update needed" : configurationUnavailable ? "Mac layout needs recovery" : connected ? eventsReady ? "Mac connected" : "Connecting…" : paired ? "Disconnected" : "Pairing required",
      phase: configurationUnavailable ? "offline" : loading ? "loading" : connected ? eventsReady ? "online" : "connecting" : paired ? "offline" : "idle",
      online: connected && eventsReady, reconnectDisabled: syncing || unsupported },
    refresh: refreshState(),
    settings: { themeNote: blocked || themeNote },
  };
  if (!config) { subscriptionClient.sync([], false); paint(early); layoutZones(); askForTheme(); return; }
  const view = editor.view || config;
  const subscriptionProviders: SubscriptionProvider[] = [];
  for (const widget of view.widgets) for (const candidate of isPages(widget) ? widget.pages.flatMap(page => page.widgets) : [widget])
    if (isSubscriptionKind(candidate.kind)) subscriptionProviders.push(subscriptionProvider(candidate.kind));
  subscriptionClient.sync(paired ? subscriptionProviders : [], connected && eventsReady && paired);
  // A Pages widget shows its chosen page; a choice that is gone (a deleted page, a reload) falls back to the first page.
  for (const widget of view.widgets) if (isPages(widget)) pageOf.set(widget.id, shownPageId(widget));
  for (const id of [...pageOf.keys()]) if (!view.widgets.some(widget => widget.id === id)) pageOf.delete(id);
  editor.render(connected && eventsReady && !sending && !riskIntent, connected && eventsReady && !busy && !sending && !pending && !riskIntent && canTrackRequests);
  el("desk").dataset.editing = String(editor.active);
  controlDesk.render({ config: view, pageOf, apps, scripts, shortcuts,
    availability: !connected || !canTrackRequests ? "offline" : eventsReady ? "ready" : "connecting",
    busy, sending: sending || editor.saving || !!riskIntent || moveSaving, hasPending: !!pending, pendingComponentId: pendingButtonId, unknown, feedback, details: feedbackDetails,
    editing: editor.active, selectedId: editor.selectedId, theme });
  if (resultButtonId && !resultContext) resultContext = buttonContext(resultButtonId);
  // The readout is titled with the key it is about; follow a rename or a configuration that arrives after the result.
  if (resultKeyed && resultButtonId) resultView = { ...resultView, title: buttonName(resultButtonId) };
  paint({ ...early, mode: { editing: editor.active, useDisabled: editor.saving || editor.resizing, editDisabled: editor.saving || editor.resizing || !editor.loaded } });
  layoutZones();
  askForTheme();
}
// T42/T62: the Theme window saves the custom themes (shared, one configuration revision) and then this device's choice (its own, no revision). It throws a readable message for the window to show.
async function saveThemes(customThemes: CustomTheme[], theme: ThemeChoice) {
  const why = themeBlocked();
  if (why) throw new Error(why);
  if (!config || !paired || themePending) throw new Error("Wait a moment and try again.");
  const epoch = connectionEpoch;
  try {
    if (JSON.stringify(customThemes) !== JSON.stringify(config.customThemes ?? [])) {
      const response = await api<{ config: Config }>("configuration/themes", { customThemes, revision: config.revision });
      const saved = parseConfig(response.config);
      if (epoch !== connectionEpoch || !connected || eventsFailed) throw new Error("The theme could not be confirmed. Reconnect to see the saved theme.");
      if (!config || isNewer(saved, config)) config = saved;
      editor.receive(config, apps, hostInstanceId!, scripts, shortcuts);
    }
    await setDeviceTheme(theme);
    themeNote = "Theme saved for this device.";
  } catch (error) {
    if (error instanceof Fault && error.code === "CONFIG_CONFLICT") { void sync(); throw new Error("The configuration changed on the Mac, so nothing was saved. Loading it again; try again in a moment."); }
    throw error;
  }
}
// Why the custom themes cannot be saved right now, or "" when they can. They are saved with the configuration, so a draft on this device blocks it.
function themeBlocked(): string {
  if (!paired || !config || configurationUnavailable) return "";
  if (editor.dirty) return "Save or discard your draft first.";
  if (editor.saving) return "Wait until the configuration has finished saving.";
  return deviceThemeBlocked();
}
// This device's own choice only needs the Mac to be reachable.
function deviceThemeBlocked(): string {
  if (!paired || !config || configurationUnavailable) return "";
  if (!connected || !eventsReady || eventsFailed) return "Reconnect to the Mac to change the theme.";
  return "";
}
// T94: the theme is the layout's, so saving it raises the layout's revision (nothing else changes). This page adopts the new revision, and so does an open draft: a theme
// change of its own must not make the draft look stale.
let themeSaving = false;
async function setDeviceTheme(theme: ThemeChoice) {
  const epoch = connectionEpoch, name = config?.layoutName, startedRevision = config?.layoutRevision;
  themeSaving = true;
  let reply: Awaited<ReturnType<typeof deviceThemeCall>>;
  try { reply = await deviceThemeCall("save", { theme, layoutName: name }, 6000); } finally { themeSaving = false; }
  if (!reply) throw new Error("The theme save could not be confirmed. Reconnect to see the saved theme.");
  if (reply.status < 200 || reply.status >= 300) throw new Error(reply.data.error?.message ?? "The theme could not be saved.");
  if (epoch !== connectionEpoch || !connected || eventsFailed || config?.layoutName !== name)
    throw new Error("The theme save response belongs to an earlier connection. Reconnect to see the saved theme.");
  const saved = reply.data.theme;
  deviceChoice = typeof saved === "string" ? saved as ThemeChoice : theme;
  await adoptSavedRevision(reply.data, startedRevision);
}
// A one-field save of the layout (the theme, the Mac Dock) raised only its revision: adopt it here and in an open draft, or load the layout when it is not that simple.
async function adoptSavedRevision(data: { layoutName?: unknown; previousLayoutRevision?: unknown; layoutRevision?: unknown }, startedRevision: number | undefined) {
  const { layoutRevision, previousLayoutRevision } = data;
  if (config && data.layoutName === config.layoutName &&
      (previousLayoutRevision === config.layoutRevision || previousLayoutRevision === startedRevision && layoutRevision === config.layoutRevision) &&
      typeof previousLayoutRevision === "number" && Number.isSafeInteger(previousLayoutRevision) &&
      typeof layoutRevision === "number" && Number.isSafeInteger(layoutRevision) &&
      (layoutRevision === previousLayoutRevision || layoutRevision === previousLayoutRevision + 1)) {
    editor.adoptLayoutRevision(previousLayoutRevision, layoutRevision);
    config = { ...config, layoutRevision };
    editor.receive(config, apps, hostInstanceId!, scripts, shortcuts);
  } else { await sync(); }
  // Something else changed the layout meanwhile (an event already names a newer revision than the one adopted): load it as usual.
  if (config && latestState && latestState.layoutRevision > (config.layoutRevision ?? 0) && !sending) void sync();
}
async function chooseTheme(theme: ThemeName) {
  if (!config || !paired || themePending || deviceThemeBlocked() || theme === resolved().choice) return;
  themePending = theme; themeNote = "Saving theme…"; render();
  try { await setDeviceTheme(theme); themeNote = "Theme saved for this device."; }
  catch (error) { themeNote = (error as Error).message; }
  finally { themePending = undefined; render(); }
}
// The result readout: the title is the key's name; the line under it is one state phrase, with how long it took once the action is
// over; a message line follows only when the Host's message says something the phrase does not. Results that belong to no key
interface ResultOptions { key?: boolean; time?: number }
const seconds = (ms: number) => ms < 50 ? "<0.1 s" : `${(ms / 1000).toFixed(ms < 99_950 ? 1 : 0)} s`;
// The last known name of the key a result is about: a rename shows at once, and a deleted key keeps the name it had.
function buttonName(id: string) { const found = (config ? findComponent(config, id)?.label : undefined) || undefined; if (found) resultName = found; return resultName || "Previous action"; }
function result(status: string, title: string, detail: string, options: ResultOptions = {}) {
  const named = !!options.key && !!resultButtonId;
  resultKeyed = named;
  resultView = { status, title: named ? buttonName(resultButtonId!) : title, line: !named ? detail : options.time === undefined ? title : `${title} · ${seconds(options.time)}`,
    detail: named && !repeatsPhrase(title, detail) ? detail : "" };
  el("execution-diagnostics").dataset.status = status;
  text("execution-output", ""); el("execution-output").hidden = true;
  text("execution-message", `${resultView.title} · ${resultView.line}${resultView.detail ? ` · ${resultView.detail}` : ""}`);
  el("execution-acknowledge").hidden = !unknown;
  // T100 (ADR-090): a failure shows on the key and in this line; the Settings menu is not opened over the keys. Its diagnostics are expanded for when it is opened.
  if (status === "failed" || status === "rejected" || status === "unknown") (el("execution-diagnostics") as HTMLDetailsElement).open = true;
  // T103 (ADR-092): an unknown result keeps every key locked until it is cleared, and the clear button is in the Settings menu, so the menu opens for it
  // and scrolls to the button (the last item of the menu), once the caller has shown it.
  if (status === "unknown") {
    (el("connection-settings") as HTMLDetailsElement).open = true;
    setTimeout(() => { const clear = el("execution-acknowledge"); if (!clear.hidden) clear.scrollIntoView?.({ block: "nearest" }); }, 0);
  }
}
// T116 (ADR-100): bringing an app or a window to the front is safe to repeat, so an unknown result of one only marks its key (UNKNOWN with the Mac's words, for a
// while) and locks nothing else; the Settings menu stays closed and there is nothing to clear. Shortcuts, scripts, Mac shortcuts and workflows keep the ADR-092 lock.
// Only a final answer is softened (the Mac reported unknown, or the result could not be had); a lost connection still waits for the reconnect to ask.
const REPEAT_SAFE: ReadonlySet<string> = new Set(["app.open", "window.activate"]), SOFT_UNKNOWN_MS = 8000;
function repeatSafeKey(buttonId: string | undefined): boolean {
  const action = config && buttonId ? findComponent(config, buttonId)?.action : undefined;
  return !!action && REPEAT_SAFE.has(action.type);
}
function softUnknown(detail: string, code?: string) {
  const buttonId = resultButtonId ?? pendingButtonId, wasLocked = unknown;
  remember(); unknown = false; lastExecution = undefined;
  if (buttonId) {
    clearTimeout(feedbackTimers.get(buttonId)); feedback.set(buttonId, "unknown"); feedbackDetails.set(buttonId, detail);
    feedbackTimers.set(buttonId, setTimeout(() => { feedbackTimers.delete(buttonId); feedback.delete(buttonId); feedbackDetails.delete(buttonId); render(); }, SOFT_UNKNOWN_MS));
  }
  result("notice", "Not confirmed", detail, { key: true });
  if (code) { text("execution-output", code); el("execution-output").hidden = false; }
  // The wait before the answer (a reload, a lost connection) may have opened the menu for the clear button; nothing needs clearing now.
  if (wasLocked) (el("connection-settings") as HTMLDetailsElement).open = false;
  render();
}
function unknownResult(detail: string) {
  if (resultButtonId) { feedback.set(resultButtonId, "unknown"); feedbackDetails.set(resultButtonId, detail); }
  unknown = true; result("unknown", "Result unknown", detail, { key: true }); render();
}
// ---- T39: moving a key in Use mode. A long press lifts it; dropping on a slot (swapping with a compatible key) or on a page tab saves
// the layout at once, with no draft. A toast offers Undo for 5 seconds; Undo saves the previous layout only if nothing else changed it.
interface MoveUndo { revision: number; layoutRevision: number | undefined; previous: Config }
// T51: the toast can also offer a plain action (undoing a theme layout), which does its own checks.
type ToastUndo = MoveUndo | (() => void);
let moveUndo: ToastUndo | undefined, moveToastTimer: ReturnType<typeof setTimeout> | undefined;
const keyName = (button?: Component) => button?.label || "this key";
// What the person is told. The readout is the live region, so it carries the message when it is idle; while a result is pending or unknown it
// must not be overwritten, and the toast announces instead.
function say(title: string, detail: string, undo?: ToastUndo, quiet = false) {
  const idle = !pending && !unknown && !sending;
  if (idle) result("ready", title, detail);
  // The "lifted" announcement only needs the live region; the toast is for results and refusals.
  if (quiet && idle) return;
  clearTimeout(moveToastTimer); moveUndo = undo;
  el("move-toast-text").setAttribute("aria-live", idle ? "off" : "polite"); text("move-toast-text", `${title} · ${detail}`);
  el("move-undo").hidden = !undo; el("move-toast").hidden = false;
  moveToastTimer = setTimeout(hideMoveToast, 5000);
}
function hideMoveToast() { clearTimeout(moveToastTimer); moveUndo = undefined; el("move-toast").hidden = true; }
function moveRefusal(): string | undefined {
  if (editor.active || editor.dirty) return "Finish or discard your layout draft before moving keys here.";
  if (moveSaving || editor.saving) return "Wait until the layout has finished saving.";
  if (!config || !connected || !eventsReady || eventsFailed) return "Reconnect to the Mac to move keys.";
  if (riskIntent) return "Answer the confirmation first.";
  return undefined;
}
function liftKey(id: string): boolean {
  // Edit mode drags straight away on the draft: no toast and no save.
  if (editor.active) return !editor.saving && !editor.resizing && !riskIntent;
  const why = moveRefusal();
  if (why) { say("Can't move", why); return false; }
  say(`Lifted “${keyName(config ? findComponent(config, id) : undefined)}”`, moveMode.mode === "swap" ? "Drop it on another key to trade places, on a free place, or on a page tab. Let go without moving to edit the key." : "Drag it to a free place or to a page tab and let go. Let go without moving to edit the key.", undefined, true);
  return true;
}
// T40: a lift that did not end by letting go. Esc is the person's own choice; anything else was the browser, and the person is told so.
function liftStopped(id: string, reason: string) {
  const name = keyName(config ? findComponent(config, id) : undefined);
  if (reason === "escape") say("Not moved", `Cancelled. “${name}” stayed where it was.`);
  else say("Not moved", "Drag stopped by the browser. Hold the key and move it right away.");
}
async function saveMove(candidate: Config, title: string, done: string, undo?: MoveUndo) {
  moveSaving = true; render();
  const epoch = connectionEpoch;
  try {
    if (!config) throw new Error("The layout has not been loaded from the Mac yet.");
    const response = await api<{ config: Config }>("configuration/save", saveBody(config, parseConfig(candidate)));
    const saved = parseConfig(response.config);
    if (epoch !== connectionEpoch || !connected || eventsFailed) throw new Error("The save could not be confirmed. Reconnect and check the layout.");
    if (!config || isNewer(saved, config)) config = saved;
    editor.receive(config, apps, hostInstanceId!, scripts, shortcuts);
    say(title, done, undo && { revision: saved.revision, layoutRevision: saved.layoutRevision, previous: undo.previous });
  } catch (error) {
    if (error instanceof Fault && error.code === "CONFIG_CONFLICT") { say("Not moved", "The layout changed on the Mac, so nothing was moved. Loading the latest layout."); void sync(); }
    else say("Not moved", (error as Error).message);
  } finally { moveSaving = false; render(); }
}
// The layout after dropping a component: Swap mode trades places with a component or blank, goes to empty space or to a page tab and leaves a blank behind;
// Insert (and a Pages group in either mode) goes between two components and the order closes up (ADR-083).
function movedConfig(base: Config, id: string, target: Exclude<DropTarget, { refused: string }>): Config {
  if ("swap" in target) return swapWidgets(base, id, target.swap.id);
  if ("empty" in target) return moveToSlot(base, id, target.empty.container, target.empty.index, target.empty.fills);
  if ("tab" in target) { const found = locate(base, id)?.widget; return moveMode.mode === "swap" && found && !isPages(found) ? moveToPageSwap(base, id, target.tab.pagesId, target.tab.pageId) : moveToPage(base, id, target.tab.pagesId, target.tab.pageId); }
  return moveWidget(base, id, target.container, target.index);
}
// Edit mode: a move changes the draft only (Undo and Save are the editor's).
function dropInEdit(id: string, target: DropTarget | undefined) {
  const draft = editor.view; if (!draft || editor.saving) return;
  if (!target) { say("Not moved", "Dropped outside the canvas and the page tabs. It stayed where it was."); return; }
  if ("refused" in target) { say("Not moved", `${target.refused} It stayed where it was.`); return; }
  try { editor.applyDraft(movedConfig(draft, id, target)); }
  catch (error) { say("Not moved", (error as Error).message); }
}
async function dropKey(id: string, target: DropTarget | undefined) {
  if (editor.active) { dropInEdit(id, target); return; }
  const before = config, button = before ? findComponent(before, id) : undefined;
  if (!before || !button) return;
  if (!target) { say("Not moved", `Dropped outside the canvas and the page tabs. “${keyName(button)}” stayed where it was.`); return; }
  if ("refused" in target) { say("Not moved", `${target.refused} “${keyName(button)}” stayed where it was.`); return; }
  const why = moveRefusal();
  if (why) { say("Not moved", why); return; }
  let next = before, done = "", title = "Moved";
  try {
    next = movedConfig(before, id, target);
    if ("tab" in target) {
      const group = before.widgets.find(item => item.id === target.tab.pagesId), page = group && isPages(group) ? group.pages.find(item => item.id === target.tab.pageId) : undefined;
      done = `“${keyName(button)}” is now on “${page?.name || "Unnamed page"}”.`;
    } else if ("swap" in target) {
      const other = locate(before, target.swap.id)?.widget;
      done = other && isBlank(other) ? `“${keyName(button)}” moved to the empty place.` : `“${keyName(button)}” traded places.`;
    } else if ("empty" in target) done = `“${keyName(button)}” moved to a free place.`;
    else done = `“${keyName(button)}” moved in the component order.`;
  } catch (error) { say("Not moved", (error as Error).message); return; }
  await saveMove(next, title, done, { revision: before.revision, layoutRevision: before.layoutRevision, previous: JSON.parse(JSON.stringify(before)) as Config });
}
async function undoMove() {
  const undo = moveUndo;
  if (!undo) return;
  hideMoveToast();
  if (typeof undo === "function") { undo(); return; }
  const why = moveRefusal();
  if (why) { say("Can't undo", why); return; }
  if (!config || config.revision !== undo.revision || config.layoutRevision !== undo.layoutRevision) { say("Can't undo", "The layout changed after this move, so it can't be undone."); return; }
  await saveMove({ ...undo.previous, revision: config.revision, ...(config.layoutRevision !== undefined ? { layoutRevision: config.layoutRevision } : {}) }, "Undone", "The layout is back as it was.");
}
async function api<T>(path: string, value: unknown, signal?: AbortSignal, timeout = 4000): Promise<T> {
  const epoch = connectionEpoch;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const response = await fetch(`/api/${path}`, { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Keyln-Client": "1" }, body: JSON.stringify(value), signal: controller.signal });
    const data = await response.json();
    if (!response.ok) {
      if (data.error.code === "UNAUTHORIZED" && epoch === connectionEpoch && !signal?.aborted) {
        const wasPaired = paired;
        configurationUnavailable=false;
        paired = false; connected = false; deviceThemeLoaded = false; disconnectEvents();
        reconnect.stop();
        text("pair-message", wasPaired ? "Device authorization expired or was revoked. Start pairing in Mac management or the Mac terminal." : "Generate a pairing code in Mac management, or type pair in the Keyln window on your Mac.");
        if (pending) unknownResult("Device authorization was lost. Check the Mac before sending another action.");
        render();
      }
      throw new Fault(data.error.code, data.error.message, response.status);
    }
    return data as T;
  } catch (error) {
    if (error instanceof Fault) throw error;
    const detail = "Connection lost. Check the Mac and Wi-Fi, then reconnect. Nothing will be resent.";
    // A failed request from an abandoned connection must not close its replacement.
    if (epoch === connectionEpoch && !signal?.aborted) {
      connected = false; disconnectEvents(); eventsFailed = true;
      reconnect.failed();
      if (pending) unknownResult(detail);
      else if (paired) result("rejected", "Connection unavailable", detail);
      render();
    }
    throw new Error(detail);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
function cancelSync() {
  syncSerial++;
  syncController?.abort(); syncController = undefined; syncing = false;
  paintReconnect();
}
// Reconnect is disabled while a sync runs (and for good in a browser too old to run Keyln).
function paintReconnect() { paint({ connection: { ...desk.connection, reconnectDisabled: syncing || unsupported } }); }
function disconnectEvents() {
  cancelRisk();
  connectionEpoch++;
  cancelSync();
  eventsReady = false; latestState = undefined; iconsStale = true; macDock.disconnected();
  clearTimeout(eventTimer);
  const socket = eventSocket; eventSocket = undefined;
  socket?.close();
}
function connectEvents() {
  if (!paired || eventsFailed || eventSocket?.readyState === WebSocket.OPEN || eventSocket?.readyState === WebSocket.CONNECTING) return;
  const url = new URL(EVENT_PATH, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, EVENT_PROTOCOL);
  eventSocket = socket;
  let sequence = 0;
  eventTimer = setTimeout(() => { if (eventSocket === socket && !eventsReady) socket.close(); }, 4000);
  socket.onmessage = message => {
    if (eventSocket !== socket) return;
    try {
      if (typeof message.data !== "string" || message.data.length > 65_536) throw new Error("Invalid event.");
      const event = parseHostEvent(JSON.parse(message.data));
      if (event.sequence <= sequence) throw new Error("Out-of-order state event.");
      sequence = event.sequence;
      if (event.instanceId !== hostInstanceId) {
        cancelRisk();
        if (pending) unknownResult("The Mac Host restarted. Check the previous result before sending another action.");
        if (event.type !== "state") throw new Error("Unexpected Host instance.");
        latestState = event;
        if (!sending) void sync();
        return;
      }
      if (event.type === "state") {
        if(riskIntent&&(event.busy||event.revision!==riskIntent.revision))cancelRisk("The Mac state changed. Review and confirm again.");
        const first = !eventsReady;
        if (first && iconsStale) { iconsStale = false; resetAppIcons(); }
        clearTimeout(eventTimer); latestState = event; eventsReady = true; busy = event.busy; reconnect.recovered(); render();
        if ((event.revision !== config?.revision || event.layoutRevision !== config?.layoutRevision) && !sending && !themeSaving) void sync();
        if (first && pending) void checkResult();
      } else if (event.type === "running-apps") {
        if (!eventsReady) throw new Error("State must precede running apps.");
        if (connected && !eventsFailed) macDock.apply(event);
      } else {
        if (!eventsReady) throw new Error("State must precede execution events.");
        if (connected && !eventsFailed) { showExecution(event.execution); macDock.execution(event.execution); }
      }
    } catch { socket.close(1008, "Unsupported event"); }
  };
  socket.onerror = () => { /* close handles the connection state without logging credentials. */ };
  socket.onclose = event => {
    if (eventSocket !== socket) return;
    cancelRisk();
    connectionEpoch++;
    cancelSync();
    clearTimeout(eventTimer); eventSocket = undefined; eventsFailed = true; eventsReady = false; latestState = undefined; connected = false; iconsStale = true; macDock.disconnected();
    if (event.code === 4001) {
      paired = false;
      reconnect.stop();
      text("pair-message", "Device authorization expired or was revoked. Start pairing in Mac management or the Mac terminal.");
    } else if (event.code === 1008 || event.code === 1002) reconnect.stop();
    else reconnect.failed();
    if (pending) unknownResult("Connection lost. Check the Mac; reconnect only queries the previous result.");
    else if (paired) result("rejected", "Connection unavailable", "Check the Mac and Wi-Fi, then reconnect. Nothing will be resent.");
    render();
  };
}
function readyDetail() {
  return "Choose a configured button. One touch sends one action to the Mac.";
}
async function sync(manual = false) {
  if (syncing && !manual) return false;
  if (manual) { disconnectEvents(); eventsFailed = false; }
  const serial = ++syncSerial, controller = new AbortController(); syncController = controller;
  syncing = true; paintReconnect();
  const epoch = connectionEpoch;
  const previousState = latestState;
  try {
    const state = await api<{ config: Config; scripts?: unknown[];shortcuts?:unknown[];shortcutsError?:string;shortcutsRefreshing?:boolean; busy: boolean; instanceId: string }>("configuration", {}, controller.signal);
    if (epoch !== connectionEpoch || serial !== syncSerial) return false;
    const nextConfig = parseConfig(state.config);
    if (state.scripts !== undefined && (!Array.isArray(state.scripts) || state.scripts.length > 32)) throw new Error("Invalid script catalog.");
    scripts = (state.scripts ?? []).map(parseScriptInfo);
    if(state.shortcuts!==undefined&&(!Array.isArray(state.shortcuts)||state.shortcuts.length>1024))throw new Error("Invalid shortcut catalog.");
    shortcuts=(state.shortcuts??[]).map(parseShortcutInfo);
    text("shortcuts-note",state.shortcutsError|| (state.shortcutsRefreshing?"Refreshing Mac shortcuts…":"Bound to a stable ID. Input prompts may need attention on the Mac."));
    if (state.instanceId === hostInstanceId && config && !isNewer(nextConfig, config)) return false;
    if (!apps.length || manual) {
      const catalog = (await api<{ apps: AppInfo[] }>("apps", {}, controller.signal)).apps;
      if (epoch !== connectionEpoch || serial !== syncSerial) return false;
      apps = catalog;
    }
    if(riskIntent&&(nextConfig.revision!==riskIntent.revision||state.instanceId!==hostInstanceId))cancelRisk("The saved layout changed. Review and confirm again.");
    if (hostInstanceId && state.instanceId !== hostInstanceId && eventSocket) {
      const previous = eventSocket; eventSocket = undefined; clearTimeout(eventTimer); eventsReady = false; latestState = undefined; previous.close();
    }
    configurationUnavailable=false; paired = true; config = nextConfig;
    for (const id of feedback.keys()) if (!findComponent(config, id)) feedback.delete(id);
    busy = latestState !== previousState && latestState?.instanceId === state.instanceId ? latestState.busy : state.busy;
    hostInstanceId = state.instanceId; connected = !eventsFailed;
    editor.receive(config, apps, hostInstanceId, scripts,shortcuts);
    if (!pending && !unknown && (resultView.status === "ready" || manual && resultView.status === "rejected")) {
      if (manual) { resultButtonId = undefined; resultContext = ""; resultName = ""; }
      result("ready", "Ready", readyDetail());
    }
    render();
    connectEvents();
    void loadDeviceTheme(); void macDock.load();
    return true;
  } catch (error) {
    if (epoch !== connectionEpoch || serial !== syncSerial) return false;
    connected = false;
    if(error instanceof Fault&&error.code==="CONFIG_DAMAGED"){configurationUnavailable=true;disconnectEvents();reconnect.stop();render();return false;}
    disconnectEvents(); eventsFailed = true;
    if (error instanceof Fault && error.status >= 400 && error.status < 500) reconnect.stop(); else reconnect.failed();
    if (pending) unknownResult((error as Error).message);
    else if (!paired) text("pair-message", (error as Error).message);
    else result("rejected", "Connection unavailable", (error as Error).message);
    return false;
  } finally {
    if (serial === syncSerial) { syncing = false; syncController = undefined; render(); }
  }
}

// Only the tile's native click reaches this sender; page changes never execute.
async function executeButton(buttonId: string, revision: number, fromEditor = false) {
  if (!config || editor.active && !(fromEditor && editor.canTest) || editor.saving || !connected || !eventsReady || !canTrackRequests || busy || sending || pending || riskIntent ||
      revision !== config.revision) return;
  const button = findComponent(config, buttonId);
  if (!button) return;
  const target = { action: button.action };
  if (!target.action) return;
  const id=crypto.randomUUID();
  if(needsConfirmation(config,button)){
    // The confirmation card sits above the page, so the key popup steps aside first (the draft is kept).
    editor.dismissPopup();
    const intent:RiskIntent={id,button:JSON.parse(JSON.stringify(button)),revision,epoch:connectionEpoch};riskIntent=intent;render();
    try{
      const challenge=await api<{id:string;expiresInMs:number;label:string;summary:string}>("confirmation",{requestId:id,componentId:buttonId,revision});
      if(riskIntent!==intent||intent.epoch!==connectionEpoch||!connected||!eventsReady)return;
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(challenge.id)||!Number.isSafeInteger(challenge.expiresInMs)||challenge.expiresInMs<1||challenge.expiresInMs>30_000||typeof challenge.label!=="string"||typeof challenge.summary!=="string"||challenge.summary.length>400)throw new Error("Invalid confirmation. Nothing was sent.");
      intent.token=challenge.id;intent.expiresAt=Date.now()+challenge.expiresInMs;
      text("risk-title",`Run “${challenge.label}”?`);text("risk-summary",challenge.summary);el("risk-confirm").hidden=false;el("shell").inert=true;el("risk-cancel").focus();
      riskTimer=setTimeout(()=>{if(riskIntent===intent){cancelRisk("Confirmation expired. Tap the key to review it again.");render();}},challenge.expiresInMs);
    }catch(error){if(riskIntent===intent){cancelRisk((error as Error).message);render();}}
    return;
  }
  await sendAction(button,revision,id,undefined);
}
function cancelRisk(message?:string){
  if(!riskIntent)return;
  riskIntent=undefined;clearTimeout(riskTimer);el("risk-confirm").hidden=true;el("shell").inert=false;
  if(message)result("rejected","Confirmation cancelled",message);
}
async function sendAction(button:Component,revision:number,id:string,confirmation?:string){
  const buttonId=button.id;
  if(!config||config.revision!==revision||!connected||!eventsReady||eventsFailed||busy||sending||pending||JSON.stringify(findComponent(config,buttonId))!==JSON.stringify(button))return;
  clearTimeout(feedbackTimers.get(buttonId)); feedbackTimers.delete(buttonId); feedbackDetails.delete(buttonId);
  if (!remember(id, buttonId)) {
    pending = undefined;
    result("rejected", "Browser storage unavailable", "Enable site storage before running an action. Nothing was sent."); render(); return;
  }
  sending = true; unknown = false; lastExecution = undefined;
  resultButtonId = buttonId;
  resultContext = buttonContext(buttonId); resultName = button.label; feedback.set(buttonId, "sending");
  const epoch = connectionEpoch;
  render();
  result("sending", "Sending to Mac…", "", { key: true });
  try {
    const response = await api<{ execution: Execution }>("execute", { requestId: id, componentId: buttonId, revision,...(confirmation?{confirmation}:{}) });
    if (pending !== id || epoch !== connectionEpoch) return;
    if (!connected || eventsFailed) { unknownResult("Connection lost. Reconnect only queries the previous result; nothing will be resent."); return; }
    const execution = parseExecution(response.execution);
    if (execution.requestId !== id) throw new Error("Unexpected execution result. Check the Mac before trying again.");
    showExecution(execution);
  } catch (error) {
    if (pending !== id || epoch !== connectionEpoch) return;
    if (error instanceof Fault && error.status < 500) {
      feedback.set(buttonId, "rejected");
      feedbackDetails.set(buttonId, error.message);
      remember(); result("rejected", "Action rejected", error.message, { key: true });
    } else unknownResult((error as Error).message);
  } finally { sending = false; render(); }
}
function showExecution(execution: Execution) {
  if (execution.requestId !== pending) return;
  const order = { accepted: 0, running: 1, succeeded: 2, failed: 2, unknown: 2 };
  if (lastExecution?.requestId === execution.requestId) {
    if (lastExecution.id !== execution.id || order[lastExecution.status] > order[execution.status] || order[lastExecution.status] === 2) return;
    // A reconnect query can arrive after a newer pushed running-step snapshot.
    const progress=(value:Execution)=>value.workflow?.steps.reduce((total,step)=>total+(step.status==="running"?1:2),0)??0;
    if(lastExecution.status==="running"&&execution.status==="running"&&progress(execution)<progress(lastExecution))return;
  }
  lastExecution = execution;
  if (execution.status === "unknown" && REPEAT_SAFE.has(execution.actionType)) { softUnknown(execution.message, execution.code); return; }
  // T99 (ADR-089): a Windows App session that is not connected leaves the Connection Center open on the Mac. It is still not done, but it is a notice, not an error.
  const notice = execution.status === "failed" && execution.actionType === "window.activate" && execution.code === "SESSION_NOT_CONNECTED";
  if (resultButtonId) { feedback.set(resultButtonId, notice ? "notice" : execution.status); feedbackDetails.set(resultButtonId, execution.message); }
  const titles = { accepted: "Received by Mac", running: "Executing on Mac…", succeeded: execution.actionType === "window.activate" ? "Window activated" : execution.actionType === "keyboard.shortcut" ? "Shortcut sent" : execution.actionType === "shell.run" ? "Script completed" : execution.actionType === "shortcuts.run" ? "Mac shortcut completed" : execution.actionType==="workflow.run"?"Workflow completed":"Done", failed: "Action failed", unknown: "Result unknown" };
  const over = execution.status !== "accepted" && execution.status !== "running";
  result(notice ? "notice" : execution.status, notice ? "Not connected" : titles[execution.status], execution.message, { key: true, ...(over && execution.finishedAt !== undefined ? { time: Math.max(0, execution.finishedAt - execution.createdAt) } : {}) });
  resultView = { ...resultView, ...(execution.output ? { output: execution.output } : {}), ...(execution.workflow ? { workflow: execution.workflow } : {}) };
  const diagnostics = [execution.code, execution.output?.stdout, execution.output?.stderr, ...(execution.workflow ? Array.from({ length: execution.workflow.totalSteps }, (_, index) => { const step = execution.workflow!.steps[index]; return step ? `Step ${index + 1} · ${step.status} · ${step.message}${step.output ? `\n${step.output.stdout}\n${step.output.stderr}` : ""}` : `Step ${index + 1} · not-run`; }) : [])].filter(Boolean).join("\n");
  text("execution-output", diagnostics); el("execution-output").hidden = !diagnostics;
  unknown = execution.status === "unknown";
  el("execution-acknowledge").hidden = !unknown;
  if (execution.status === "succeeded" || execution.status === "failed") {
    const action = config && resultButtonId ? findComponent(config, resultButtonId)?.action : undefined;
    if (action?.type === "app.open" || action?.type === "window.activate") rememberApp(action.appId);
    const buttonId = resultButtonId;
    if (buttonId) {
      clearTimeout(feedbackTimers.get(buttonId));
      feedbackTimers.set(buttonId, setTimeout(() => {
        feedbackTimers.delete(buttonId); feedback.delete(buttonId); feedbackDetails.delete(buttonId); render();
      }, 2000));
    }
    remember();
  }
  render();
}
let checking: string | undefined;
async function checkResult() {
  if (!pending || !connected || !eventsReady || eventsFailed) return;
  const id = pending, epoch = connectionEpoch, query = `${epoch}/${id}`;
  if (checking === query) return;
  checking = query;
  try {
    const response = await api<{ execution: Execution }>("result", { requestId: id });
    if (id !== pending || epoch !== connectionEpoch || !connected || eventsFailed) return;
    const execution = parseExecution(response.execution);
    if (execution.requestId !== id) throw new Error("Unexpected execution result. Check the Mac before trying again.");
    showExecution(execution);
  } catch (error) {
    if (id !== pending || epoch !== connectionEpoch) return;
    if (repeatSafeKey(resultButtonId ?? pendingButtonId)) softUnknown((error as Error).message); else unknownResult((error as Error).message);
  } finally { if (checking === query) checking = undefined; }
}
el("pair-form").addEventListener("submit", async event => {
  event.preventDefault();
  const submit = el<HTMLButtonElement>("pair-submit");
  submit.disabled = true;
  try {
    const response = await api<{ id: string; claim: string }>("pair", { code: input("pair-code").value, name: input("device-name").value });
    input("pair-code").value = "";
    text("pair-message", `Waiting for Mac approval. Compare request ${response.id} in Mac management, or type approve ${response.id} in the Mac terminal.`);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      const status = await api<{ approved: boolean }>("pair/status", response);
      if (status.approved) { await sync(true); return; }
    }
    throw new Error("Pairing expired. Generate a new code in Mac management or type pair in the Mac terminal.");
  } catch (error) { text("pair-message", (error as Error).message); }
  finally { submit.disabled = false; }
});
el("move-undo").addEventListener("click", () => { void undoMove(); });
el("shelf-toggle").addEventListener("click", () => library.toggle());
// The gear of the floating area opens the same Settings menu as the system gear (which Edit keeps in place).
el("edit-settings").addEventListener("click", () => { const settings = document.getElementById("connection-settings") as HTMLDetailsElement | null; if (settings) settings.open = !settings.open; });
el("desk-save").addEventListener("click", () => { void editor.submit(); });
// The one exit of Edit (ADR-064: Done); it asks first when the draft has unsaved changes.
el("edit-back").addEventListener("click", () => leaveEdit());
el("risk-cancel").addEventListener("click",()=>{cancelRisk();render();});
el("risk-run").addEventListener("click",()=>{
  const intent=riskIntent;if(!intent?.token)return;
  if(intent.epoch!==connectionEpoch||!intent.expiresAt||intent.expiresAt<=Date.now()){cancelRisk("Confirmation expired. Review it again.");render();return;}
  cancelRisk();void sendAction(intent.button,intent.revision,intent.id,intent.token);render();
});
el("risk-confirm").addEventListener("keydown",event=>{
  if(event.key==="Escape"){event.preventDefault();cancelRisk();render();}
  if(event.key==="Tab"){event.preventDefault();el(document.activeElement===el("risk-cancel")?"risk-run":"risk-cancel").focus();}
});
el("execution-acknowledge").addEventListener("click", () => clearUnknown());
function clearUnknown() {
  if (resultButtonId) { feedback.delete(resultButtonId); feedbackDetails.delete(resultButtonId); }
  remember(); unknown = false; lastExecution = undefined;
  result("ready", "Ready", "Previous result acknowledged. No action was resent."); render();
}
window.addEventListener("offline", () => {
  connected = false; disconnectEvents(); eventsFailed = true;
  reconnect.pause();
  if (pending) unknownResult("Connection lost after sending. Check the Mac; reconnect only queries the result.");
  else result("rejected", "Offline", "Execution is disabled. Connection will resync after Wi-Fi returns.");
  render();
});
// A small visible-page heartbeat detects Host shutdown, revocation and changed configuration.
setInterval(() => { if (connected && !document.hidden && !sending) void sync(); }, 5000);
function resumeConnection() {
  if (document.hidden || !networkOnline() || syncing) return;
  connected = false; disconnectEvents(); eventsFailed = true; reconnect.wake(); render();
}
window.addEventListener("online", resumeConnection);
window.addEventListener("pageshow", resumeConnection);
function pauseConnection() {
  connected = false; disconnectEvents(); eventsFailed = true; reconnect.pause();
  if (pending) unknownResult("Page paused after sending. Returning only queries the previous result; nothing will be resent.");
  render();
}
document.addEventListener("visibilitychange", () => { if (document.hidden) pauseConnection(); else resumeConnection(); });
document.addEventListener("freeze", pauseConnection);
document.addEventListener("resume", resumeConnection);
if (!canTrackRequests) result("rejected", "Browser storage unavailable", "Enable site storage and reload before running an action.");
if (pending) unknownResult("Checking the previous request. It will not be resent.");
if (typeof globalThis.crypto?.randomUUID !== "function" || typeof AbortController !== "function" || typeof WebSocket !== "function") {
  unsupported = true; render();
  text("pair-message", "Use a current Microsoft Edge with secure-context APIs. Open the exact HTTPS URL from the Mac terminal.");
  el<HTMLButtonElement>("pair-submit").disabled = true;
} else void sync();

el("refresh-shortcuts").addEventListener("click",()=>{void api("shortcuts/refresh",{}).then(()=>{text("shortcuts-note","Refreshing Mac shortcuts… The list will update shortly.");}).catch(error=>{text("shortcuts-note",(error as Error).message);});});
