import type { AppInfo } from "../../packages/contracts/index.js";
import {setIcon, setKeyIcon} from "./presentation.js";

export interface AppContext {used: string[]; recent?: string[]}
const recentlyUsed: string[] = [];
export function rememberApp(id: string) {
  const index = recentlyUsed.indexOf(id); if (index >= 0) recentlyUsed.splice(index, 1);
  recentlyUsed.unshift(id); recentlyUsed.length = Math.min(8, recentlyUsed.length);
}
export function rankApplications(apps: AppInfo[], text: string, context: AppContext) {
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
  const query = normalize(text).trim(), terms = query.split(/\s+/).filter(Boolean), recent = context.recent ?? recentlyUsed;
  const group = (app: AppInfo) => context.used.includes(app.id) ? 0 : recent.includes(app.id) ? 1 :
    /(?:AOSUIPrefPaneLauncher|ARDAgent|Helper|Launcher|Agent)$/i.test(app.name) ? 3 : 2;
  const rank = (app: AppInfo) => {
    if (!query) return 0;
    const name = normalize(app.name), id = normalize(app.id);
    return name === query ? 0 : id === query ? 1 : name.startsWith(query) ? 2 : terms.every(term => name.includes(term)) ? 3 : id.startsWith(query) ? 4 : 5;
  };
  return apps.filter(app => terms.every(term => normalize(`${app.name} ${app.id}`).includes(term)))
    .sort((a,b) => rank(a)-rank(b) || group(a)-group(b) ||
      (group(a)===1 ? recent.indexOf(a.id)-recent.indexOf(b.id) : 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map(app => ({...app, group: ["On this page", "Recently used", "All apps", "System utilities"][group(app)]!}));
}

// A few system apps have names made only of invisible characters (for example a left-to-right mark). Those show the last part of the
// bundle id instead, so the tile and the field are never blank. Search still matches the real name and the id.
export function appDisplayName(app: { id: string; name: string }): string {
  if (app.name.replace(/[\p{Cf}\s]/gu, "") !== "") return app.name;
  return app.id.split(/[./]/).filter(Boolean).pop() ?? app.id;
}

// T37: choosing a Mac app. The field is a button (icon and name of the bound app). Tapping it opens one shared App picker window
// (<dialog id="app-dialog">, a grid of large icons with the name under each) over whatever is open. The search text is local UI
// state; only a tap on a tile (or Enter in the search box, which takes the first match) changes the binding.
interface Session {
  apps: () => AppInfo[]; loaded: () => boolean; value: () => string; context: () => AppContext;
  pick: (app: AppInfo) => void; opener: HTMLElement;
  title?: string;
  // Called when the window closes without a pick or a confirmation.
  dismissed?: () => void;
}
interface Controller {
  show: (session: Session) => void; render: () => void; close: (restoreFocus?: boolean) => void; active: () => Session | undefined;
}
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
// One controller per window element: the page has one App picker window, shared by every picker on it.
const controllers = new WeakMap<object, Controller>();
function controller(): Controller {
  const dialog = el<HTMLDialogElement>("app-dialog");
  let found = controllers.get(dialog);
  if (!found) { found = createController(dialog); controllers.set(dialog, found); }
  return found;
}
// True while the App picker window is open: the page behind it must not save or act.
export const appDialogOpen = (): boolean => (document.getElementById("app-dialog") as HTMLDialogElement | null)?.open === true;
const existing = (): Controller | undefined => controllers.get(el<HTMLDialogElement>("app-dialog") ?? {});
const renderIcon = (target: HTMLElement, app: { id: string; name: string }, signal?: AbortSignal) =>
  setKeyIcon(target, {id:"picker",kind:"key",size:"S",label:app.name,icon:"app",appearance:{glyph:{type:"app"}},action:{type:"app.open",appId:app.id}},signal);

function createController(dialog: HTMLDialogElement): Controller {
  const search = el<HTMLInputElement>("app-dialog-search"), status = el("app-dialog-status"), grid = el("app-dialog-grid");
  let session: Session | undefined, query = "", composing = false;
  let shown: (AppInfo & { group: string })[] = [];
  const icons = new Map<Element, HTMLElement>(), visibleIcons = new Map<Element, AbortController>();
  function cancelIcons() {
    observer?.disconnect();
    observer?.takeRecords();
    for (const controller of visibleIcons.values()) controller.abort();
    visibleIcons.clear();
  }
  // Icons are fetched only for tiles that scroll into view (the loader batches them, 16 to a request).
  const observer: IntersectionObserver | undefined = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const tile = entry.target;
      if (!entry.isIntersecting || !session || !grid.contains(tile)) { visibleIcons.get(tile)?.abort(); visibleIcons.delete(tile); continue; }
      if (visibleIcons.has(tile)) continue;
      const app = shown.find(item => item.id === (tile as HTMLElement).dataset.appId), target = icons.get(tile);
      if (app && target) { const abort = new AbortController(); visibleIcons.set(tile, abort); renderIcon(target, app, abort.signal); }
    }
  }, {root: grid}) : undefined;
  function render() {
    cancelIcons(); icons.clear();
    const current = session;
    if (!current) { grid.replaceChildren(); return; }
    const all = current.apps(), searching = query.trim() !== "";
    shown = rankApplications(all, query, current.context());
    const nodes: HTMLElement[] = [], bound = current.value();
    let group = "";
    for (const app of shown) {
      // Groups are headings in the full list; a search shows its matches in rank order.
      if (!searching && app.group !== group) {
        group = app.group;
        const heading = document.createElement("h3"); heading.className = "app-section-label"; heading.textContent = group; nodes.push(heading);
      }
      const tile = document.createElement("button"), icon = document.createElement("span"), name = document.createElement("span");
      tile.type = "button"; tile.className = "app-tile"; tile.dataset.appId = app.id; tile.dataset.group = app.group; tile.title = app.id;
      tile.setAttribute("aria-label", `${appDisplayName(app)}, ${app.group}, ${app.id}`);
      const selected = app.id === bound;
      tile.setAttribute("aria-pressed", String(selected)); if (selected) tile.dataset.selected = "true";
      icon.className = "tile-icon app-picker-icon"; icon.setAttribute("aria-hidden", "true");
      name.className = "app-tile-name"; name.textContent = appDisplayName(app);
      tile.append(icon, name);
      tile.addEventListener("click", () => session?.pick(app));
      icons.set(tile, icon); nodes.push(tile);
    }
    grid.replaceChildren(...nodes);
    for (const tile of icons.keys()) observer?.observe(tile);
    status.textContent = !current.loaded() ? "Loading Mac apps…" : shown.length ? `${shown.length} app${shown.length === 1 ? "" : "s"} found` :
      all.length ? "No matching apps. Try another name." : "No installed apps available.";
  }
  // A window that closed without a pick tells its session; a pick or a confirmation has already taken the session away.
  function dismissedOnClose(closing: Session | undefined, tell: boolean) { if (tell) closing?.dismissed?.(); }
  function close(restoreFocus = true, after?: Session) {
    const closing = after ?? session; const open = session; session = undefined;
    cancelIcons(); icons.clear();
    if (dialog.open && typeof dialog.close === "function") dialog.close();
    grid.replaceChildren(); query = ""; search.value = "";
    el("app-dialog-title").textContent = "Choose a Mac app";
    if (restoreFocus) closing?.opener.focus();
    dismissedOnClose(open, true);
  }
  function show(next: Session) {
    if (session && session !== next) close(false);
    session = next; query = ""; search.value = "";
    el("app-dialog-title").textContent = next.title ?? "Choose a Mac app";
    if (!dialog.open && typeof dialog.showModal === "function") dialog.showModal();
    render();
    // A phone or the Surface in touch mode must not pop its keyboard up just because the window opened.
    if (typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches) search.focus();
  }
  search.addEventListener("input", () => { if (composing) return; query = search.value; render(); });
  search.addEventListener("compositionstart", () => { composing = true; });
  search.addEventListener("compositionend", () => { composing = false; query = search.value; render(); });
  search.addEventListener("keydown", event => {
    if (composing || (event as KeyboardEvent).isComposing) return;
    const key = (event as KeyboardEvent).key;
    if (key === "Enter") { event.preventDefault(); const first = shown[0]; if (first) session?.pick(first); }
    else if (key === "ArrowDown") {
      const first = Array.from(grid.children).find(node => (node as HTMLElement).dataset.appId) as HTMLElement | undefined;
      if (first) { event.preventDefault(); first.focus(); }
    }
  });
  el("app-dialog-close").addEventListener("click", () => close());
  // Esc closes this window only; the key popup under it stays as it is.
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => { if (session) close(); });
  return { show, render, close, active: () => session };
}

export function createAppPicker(host: HTMLElement, id: string, onChange: () => void, context: () => AppContext = () => ({used:[]})) {
  let apps: AppInfo[] = [], value = "", loaded = false, disabled = false;
  const field = document.createElement("button"), icon = document.createElement("span"), blank = document.createElement("span"), name = document.createElement("span");
  const details = document.createElement("details"), summary = document.createElement("summary"), binding = document.createElement("p");
  host.className = "app-picker";
  field.type = "button"; field.id = id; field.className = "app-field"; field.setAttribute("aria-haspopup", "dialog");
  icon.className = "tile-icon app-picker-icon"; icon.setAttribute("aria-hidden", "true");
  blank.className = "tile-icon app-picker-icon"; blank.setAttribute("aria-hidden", "true"); setIcon(blank, "app-window");
  name.className = "app-field-name"; name.id = `${id}-name`;
  field.append(icon, blank, name);
  details.className = "app-picker-current"; summary.textContent = "App details";
  binding.className = "app-picker-binding"; binding.id = `${id}-binding`;
  details.append(summary, binding); host.append(field, details);

  const label = () => {
    const found = apps.find(app => app.id === value);
    return !value ? "Choose a Mac app" : found ? appDisplayName(found) : "Unavailable app — keep existing binding";
  };
  function renderField() {
    const found = apps.find(app => app.id === value);
    name.textContent = label(); name.dataset.empty = String(!value);
    binding.textContent = value ? `${label()} · ${value}` : "No app chosen yet.";
    details.hidden = !value; icon.hidden = !value; blank.hidden = !!value;
    field.setAttribute("aria-label", `Mac application: ${label()}`);
    if (value) renderIcon(icon, found ?? {id: value, name: label()});
  }
  const session: Session = {
    apps: () => apps, loaded: () => loaded, value: () => value, context, opener: field,
    pick(app) {
      const changed = value !== app.id; value = app.id;
      rememberApp(app.id); renderField();
      controller().close();
      if (changed) onChange();
    },
  };
  const closeIfOwn = () => { const current = existing(); if (current?.active() === session) current.close(false); };
  function open() { if (!disabled) controller().show(session); }
  field.addEventListener("click", open);
  renderField();
  return {
    get value() { return value; },
    open,
    set(catalog: AppInfo[], selected: string) { apps = catalog; value = selected; loaded = true; renderField(); closeIfOwn(); },
    refresh(catalog: AppInfo[]) {
      apps = catalog; loaded = true; renderField();
      const current = existing(); if (current?.active() === session) current.render();
    },
    setDisabled(state: boolean) { disabled = state; field.disabled = state; if (state) closeIfOwn(); },
  };
}
