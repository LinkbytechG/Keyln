import { windowChoices, type AppInfo, type AppRecent, type Component, type WindowInfo } from "../../packages/contracts/index.js";
import { appDisplayName } from "./app-picker.js";
import { setIcon, setKeyIcon } from "./presentation.js";
import type { LibrarySpec } from "./library.js";
import { watchPress } from "./touch-hold.js";

export type AppSort = "recent" | "az" | "za";
export function sortedLibraryApps(apps: readonly AppInfo[], query: string, sort: AppSort, recent: readonly string[]): AppInfo[] {
  const terms = query.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean), rank = new Map(recent.map((id, index) => [id, index]));
  return apps.filter(app => terms.every(term => `${app.name} ${app.id}`.normalize("NFKC").toLocaleLowerCase().includes(term))).sort((a, b) => {
    const name = appDisplayName(a).localeCompare(appDisplayName(b)) || a.id.localeCompare(b.id);
    return sort === "recent" ? (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || name : sort === "za" ? -name : name;
  });
}
interface Options {
  apps: () => AppInfo[]; online: () => boolean; editable: () => boolean;
  recent: () => Promise<AppRecent>; windows: (id: string) => Promise<WindowInfo[]>;
  place: (spec: LibrarySpec) => string | undefined;
  drag: (source: HTMLElement, spec: LibrarySpec, pointer: { pointerId: number; x: number; y: number; touch: boolean }) => boolean;
  say: (text: string) => void;
}
// Tiles mounted first, and per sentinel hit: about one screen of the Library plus one more.
const APP_SLICE = 72;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => { const value = document.createElement(tag); value.className = cls; value.textContent = text; return value; };
export function createAppLibrary(options: Options) {
  const toolbar = el("shelf-app-toolbar"), search = el<HTMLInputElement>("shelf-search"), sort = el<HTMLSelectElement>("shelf-app-sort"), usage = el("shelf-app-usage"), previews = el("shelf-previews");
  const menu = el("shelf-app-menu"), menuAction = el<HTMLButtonElement>("shelf-app-window-action"), dialog = el<HTMLDialogElement>("shelf-windows"), windowList = el("shelf-window-list"), windowNote = el("shelf-window-note"), retry = el<HTMLButtonElement>("shelf-window-retry");
  menu.hidden = true;
  let active = false, query = "", order: AppSort = "recent", recent: AppRecent = { status: "starting", appIds: [] }, signature = "", recentTicket = 0, windowTicket = 0;
  let opener: HTMLElement | undefined, chosen: AppInfo | undefined, menuApp: AppInfo | undefined, pendingRecent: AppRecent | undefined, pressing = false;
  // T101: the windows added since the list opened. The list stays open for more; an added window is not offered again until it is reopened.
  let added = new Set<string>();
  // T84 (ADR-079): only what can be seen is built. A first slice of tiles is mounted; a sentinel at the end appends more as the list scrolls, and a tile's icon is asked for
  // only while the tile is within about one screen of the view (the same pattern as the App picker). Search and sort still work on every app.
  let list: AppInfo[] = [], built = 0, sentinel: HTMLElement | undefined, observer: IntersectionObserver | undefined;
  const tiles = new Map<Element, { glyph: HTMLElement; button: Component }>(), seen = new Map<Element, AbortController>();
  function stopIcons() {
    observer?.disconnect(); observer?.takeRecords();
    for (const controller of seen.values()) controller.abort();
    seen.clear(); tiles.clear(); sentinel = undefined;
  }
  function showIcon(tile: Element) {
    const entry = tiles.get(tile); if (!entry || seen.has(tile)) return;
    const controller = new AbortController(); seen.set(tile, controller);
    // An icon already on the tile stays; only a tile that is still bare asks again (a null result left it retryable).
    if (entry.glyph.getAttribute("data-glyph") !== "app") setKeyIcon(entry.glyph, entry.button, controller.signal);
  }
  function observed(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      const target = entry.target;
      if (target === sentinel) { if (entry.isIntersecting && previews.contains(target)) more(); continue; }
      if (!entry.isIntersecting || !tiles.has(target) || !previews.contains(target)) { seen.get(target)?.abort(); seen.delete(target); continue; }
      showIcon(target);
    }
  }
  function mount(count: number) {
    const batch = list.slice(built, built + count).map(cardFor); built += batch.length;
    const view = typeof IntersectionObserver === "function" ? observer ??= new IntersectionObserver(observed, { root: previews, rootMargin: "100% 0px" }) : undefined;
    sentinel?.remove(); previews.append(...batch);
    if (!view) { for (const tile of batch) showIcon(tile); if (built < list.length) mount(list.length - built); return; }
    for (const tile of batch) view.observe(tile);
    if (built < list.length) {
      sentinel ??= node("div", "shelf-app-sentinel"); sentinel.setAttribute("aria-hidden", "true"); previews.append(sentinel);
      // Observing again gives a fresh first notification, so a sentinel that is still in view after more tiles arrive keeps pulling.
      view.unobserve(sentinel); view.observe(sentinel);
    } else if (sentinel) { view.unobserve(sentinel); sentinel = undefined; }
  }
  const more = () => { if (built < list.length) mount(APP_SLICE); };
  const canUse = () => active && options.online() && options.editable();
  function restoreFocus() { if (opener?.isConnected) opener.focus({ preventScroll: true }); else search.focus({ preventScroll: true }); }
  function closeMenu(restore = true) { menu.hidden = true; menuApp = undefined; if (restore) restoreFocus(); }
  function closeWindows(restore = true) { windowTicket++; chosen = undefined; added = new Set(); if (dialog.open) dialog.close(); if (restore) restoreFocus(); }
  function close(restore = false) { closeMenu(false); closeWindows(restore); }
  function release() {
    pressing = false;
    // Native click follows pointerup. Never replace its card in the intervening microtask checkpoint.
    setTimeout(() => { if (!pressing && pendingRecent && active) { recent = pendingRecent; pendingRecent = undefined; render(active); } }, 0);
  }
  async function refreshRecent() {
    if (!canUse() || order !== "recent") return;
    const ticket = ++recentTicket;
    try {
      const next = await options.recent();
      if (ticket !== recentTicket || !canUse() || order !== "recent") return;
      if (pressing) pendingRecent = next; else { recent = next; render(active); }
    } catch {
      if (ticket !== recentTicket || !canUse() || order !== "recent") return;
      const next: AppRecent = { status: "unavailable", appIds: recent.appIds, message: "Mac app usage could not be read. Saved order is shown; try Recent again." };
      if (pressing) pendingRecent = next; else { recent = next; render(active); }
    }
  }
  function openMenu(app: AppInfo, card: HTMLElement, x?: number, y?: number) {
    if (!canUse()) return;
    closeWindows(false); opener = card; menuApp = app; menu.hidden = false;
    const box = card.getBoundingClientRect(), width = typeof window.innerWidth === "number" ? window.innerWidth : 1024, height = typeof window.innerHeight === "number" ? window.innerHeight : 768;
    menu.style.left = `${Math.max(8, Math.min(x ?? box.left, width - 232))}px`; menu.style.top = `${Math.max(8, Math.min(y ?? box.top, height - 64))}px`;
    menuAction.focus();
  }
  async function readWindows() {
    if (!canUse() || !chosen || !dialog.open) return;
    const app = chosen, ticket = ++windowTicket;
    retry.disabled = true; windowList.replaceChildren(); windowNote.textContent = "Reading windows…";
    try {
      const rows = await options.windows(app.id);
      if (ticket !== windowTicket || !canUse() || chosen?.id !== app.id || !dialog.open) return;
      windowNote.textContent = rows.length ? "Choose windows to add their keys; the list stays open until you close it. Finder folders use their paths; other targets need unique titles." : "No windows found. Open a window on the Mac, then retry.";
      windowList.replaceChildren(...windowChoices(app.id, rows).map(({window: row, id, ambiguous: duplicate, folder}) => {
        const card = node("button", "shelf-window-card"), name = node("span", "", row.title), state = node("span", "field-note");
        const mark = (done: boolean) => {
          card.disabled = duplicate || done; if (done) card.dataset.added = "true";
          state.textContent = duplicate ? "Duplicate title" : done ? "Added" : row.minimized ? "Minimized" : "";
          card.setAttribute("aria-label", `${done ? "Added" : "Add"} window ${row.title}${folder ? `, ${folder}` : ""}${duplicate ? ", duplicate title — unavailable" : ""}`);
        };
        card.type = "button"; card.title = folder ? `${row.title} · ${folder}` : row.title; mark(added.has(id)); card.append(name, state);
        if (folder) card.append(node("span", "field-note", folder));
        card.addEventListener("click", () => {
          if (!canUse() || !dialog.open || chosen?.id !== app.id || card.disabled || ticket !== windowTicket) return;
          const problem = options.place({ type: "key", tier: "S", label: row.title.slice(0, 40).replace(/[\uD800-\uDBFF]$/, ""), action: { type: "window.activate", appId: app.id, title: row.title, match: "exact", ...(row.path !== undefined ? { path: row.path } : {}) } });
          if (problem) { windowNote.textContent = problem; return; }
          added.add(id); mark(true); windowNote.textContent = `Added “${row.title}” to the draft. Choose another window, or close the list.`; options.say("Added to the draft.");
        }); return card;
      }));
    } catch (error) { if (ticket === windowTicket && chosen?.id === app.id && dialog.open && active) windowNote.textContent = `${(error as Error).message} Try Retry.`; }
    finally { if (ticket === windowTicket) retry.disabled = false; }
  }
  menuAction.addEventListener("click", () => {
    const app = menuApp; if (!canUse() || !app) return;
    closeMenu(false); chosen = app; el("shelf-window-title").textContent = `Windows — ${appDisplayName(app)}`;
    dialog.showModal(); void readWindows();
  });
  retry.addEventListener("click", () => { void readWindows(); });
  el("shelf-window-close").addEventListener("click", () => closeWindows());
  dialog.addEventListener("cancel", event => { event.preventDefault(); closeWindows(); });
  dialog.addEventListener("close", () => { if (chosen) closeWindows(); });
  // A click outside the dialog's box (on the backdrop) closes it, like the close button.
  dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeWindows();
  });
  document.addEventListener("pointerdown", event => { const target = event.target as Node | null; if (!menu.hidden && target && !menu.contains(target) && !opener?.contains(target)) closeMenu(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && !menu.hidden) { event.preventDefault(); event.stopPropagation(); closeMenu(); } });
  search.addEventListener("input", () => { query = search.value; close(); render(active); });
  sort.addEventListener("change", () => { order = ["az", "za"].includes(sort.value) ? sort.value as AppSort : "recent"; recentTicket++; pendingRecent = undefined; close(); render(active); if (order === "recent") void refreshRecent(); });
  function cardFor(app: AppInfo) {
    const name = appDisplayName(app), card = node("button", "shelf-card shelf-app-card"), glyph = node("span", "shelf-target-icon"), caption = node("span", "shelf-caption", name);
    const spec: LibrarySpec = { type: "key", tier: "S", label: name.slice(0, 40).replace(/[\uD800-\uDBFF]$/, ""), action: { type: "app.open", appId: app.id } };
    card.type = "button"; card.title = app.name; caption.title = app.name; card.dataset.appId = app.id; card.setAttribute("aria-label", `Add ${name}`); card.setAttribute("aria-haspopup", "menu");
    const button: Component = { id: "preview", kind: "key", size: "S", label: name, icon: "app", action: spec.action, appearance: { glyph: { type: "app" } } };
    setIcon(glyph, "app-window"); tiles.set(card, { glyph, button }); card.append(glyph, caption);
    // T85 (ADR-080): mouse press-and-move drags; touch swipes scroll the list, and a hold lifts the tile: move to drag, let go for the menu.
    watchPress(card, { enabled: canUse, begin: () => { pressing = true; }, end: release,
      drag: pointer => options.drag(card, spec, pointer),
      release: (x, y) => openMenu(app, card, x, y),
      contextmenu: event => { event.preventDefault(); event.stopPropagation(); openMenu(app, card, event.clientX, event.clientY); },
      click: () => { if (!canUse() || !menu.hidden || dialog.open) return; options.say(options.place(spec) ?? "Added to the draft."); } });
    card.addEventListener("keydown", event => { if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) { event.preventDefault(); event.stopPropagation(); openMenu(app, card); } });
    return card;
  }
  function render(show: boolean) {
    const newlyActive = show && !active; active = show; toolbar.hidden = !show;
    if (!show) { recentTicket++; pendingRecent = undefined; signature = ""; stopIcons(); close(); return; }
    if (!options.online() || !options.editable()) { recentTicket++; pendingRecent = undefined; close(); }
    const next = JSON.stringify([active, options.online(), options.editable(), options.apps(), query, order, recent]);
    usage.textContent = order !== "recent" ? "" : recent.message ?? (recent.status === "observing" ? recent.appIds.length ? "Recently used on this Mac · collected since observation began" : "No Mac app usage recorded yet. Unrecorded apps use name order." : "Mac app usage observation is starting; apps use name order.");
    if (next !== signature) {
      signature = next; stopIcons(); built = 0;
      list = options.online() ? sortedLibraryApps(options.apps(), query, order, recent.appIds) : [];
      previews.replaceChildren(...(!options.online() ? [node("p", "shelf-empty", "Reconnect to the Mac to choose an application.")] : []));
      mount(APP_SLICE);
      if (!previews.children.length) previews.append(node("p", "shelf-empty", query ? "No matching Mac applications." : "No Mac applications available."));
    }
    if (newlyActive && order === "recent") void refreshRecent();
  }
  return { render, refreshRecent, close };
}
