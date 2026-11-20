import { curatedIconSet, ICON_PREFIX_LIMIT, ICON_SETS, ICON_UNKNOWN_LICENSE, iconId, iconLabel, iconSvg, svgDataUrl, type Component, type IconScope, type LibraryIcon } from "../../packages/contracts/index.js";
import { appearance, getActiveTheme, iconInk, palette } from "./presentation.js";
import { ICON_KEYWORD_EXAMPLES, iconKeywords } from "./icon-keywords.js";

// T31/T32 "Icon library" panel. Vector originals live on the Mac (My icons) and only travel here as text; every
// thumbnail and preview is an <img src="data:image/svg+xml"> so the SVG is never inserted into this page.
// Search results open in a modal window (<dialog>); tapping an icon there saves it to My icons and returns to the panel.
export type LibraryRequest = (action: "list" | "search" | "add" | "remove", value: unknown) => Promise<unknown>;
interface Options {
  request: LibraryRequest;
  selected: () => Component | undefined;
  editable: () => boolean;
  // Rasterizes `svg` with `ink` and writes it into the draft. Resolves false when the key changed meanwhile.
  use: (svg: string, ink: string) => Promise<boolean>;
}
interface Item { id: string; set: string; name: string; svg: string; setName: string; license: string }
const LIGHT = "#EEEFF1", MAX_RESULTS = 48;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (id: string) => el<HTMLInputElement>(id);
const inked = (svg: string, color: string) => svg.replace(/currentColor/gi, color);
// An icon without currentColor draws in its own colors (most brand logos): it is shown and applied as it is.
const ownColors = (svg: string) => !/currentColor/i.test(svg);
const heading = (item: Item) => `${item.setName} · ${item.name}`;
const description = (item: Item) => `${heading(item)} · ${item.license}`;
// Replies come from our own Host, but they are checked again before anything is drawn.
function readItem(value: unknown): Item | undefined {
  try {
    const obj = value as Record<string, unknown>, parsed = iconId(obj.id);
    if (obj.set !== parsed.set || obj.name !== parsed.name) return undefined;
    // The six curated sets keep the names frozen in contracts; any other set shows what the Host reported, if it is plain text.
    const curated = curatedIconSet(parsed.set);
    return { id: parsed.id, set: parsed.set, name: parsed.name, svg: iconSvg(obj.svg),
      setName: curated?.name ?? iconLabel(obj.setName) ?? parsed.set, license: curated?.license ?? iconLabel(obj.license) ?? ICON_UNKNOWN_LICENSE };
  } catch { return undefined; }
}
function readIcon(raw: unknown): LibraryIcon | undefined {
  const item = readItem(raw), added = (raw as { addedAt?: unknown } | null)?.addedAt;
  return item && Number.isSafeInteger(added) && (added as number) >= 0 ? { ...item, addedAt: added as number } : undefined;
}
function readLibrary(value: unknown): LibraryIcon[] {
  const list = (value as { icons?: unknown } | null)?.icons;
  if (!Array.isArray(list)) throw Error("My icons could not be read. Reload the page and try again.");
  return list.flatMap(raw => { const icon = readIcon(raw); return icon ? [icon] : []; });
}
// A grid keeps one button per icon so filtering only re-parents nodes instead of rebuilding up to 500 images.
// `captions` adds the set name and licence under the icon (search results); the full text is always in the label.
function createGallery(grid: HTMLElement, pick: (item: Item) => void, captions = false) {
  const nodes = new Map<string, { signature: string; node: HTMLButtonElement }>();
  const build = (item: Item) => {
    const signature = `${item.svg}|${item.setName}|${item.license}`, known = nodes.get(item.id);
    if (known && known.signature === signature) return known.node;
    const node = document.createElement("button"), image = document.createElement("img");
    node.type = "button"; node.className = "library-icon"; node.title = description(item); node.dataset.iconId = item.id;
    node.dataset.own = String(ownColors(item.svg));
    node.setAttribute("aria-label", description(item)); node.setAttribute("aria-pressed", "false");
    image.alt = ""; image.draggable = false; image.src = svgDataUrl(inked(item.svg, LIGHT));
    node.append(image);
    if (captions) for (const [className, text] of [["library-icon-set", item.setName], ["library-icon-license", item.license]] as const) {
      const caption = document.createElement("span"); caption.className = className; caption.textContent = text; node.append(caption);
    }
    node.addEventListener("click", () => pick(item));
    nodes.set(item.id, { signature, node }); return node;
  };
  return {
    show(items: Item[], selected: string, saved: Set<string>) {
      const wanted = new Set(items.map(item => item.id));
      for (const id of [...nodes.keys()]) if (!wanted.has(id)) nodes.delete(id);
      grid.replaceChildren(...items.map(item => {
        const node = build(item); node.dataset.saved = String(saved.has(item.id)); node.setAttribute("aria-pressed", String(item.id === selected)); return node;
      }));
    },
    mark(selected: string) { for (const [id, { node }] of nodes) node.setAttribute("aria-pressed", String(id === selected)); },
  };
}

export function createIconLibrary(options: Options) {
  let icons: LibraryIcon[] = [], results: Item[] = [], view: "mine" | "online" = "mine", selectedId = "", color = "";
  let serial = 0, busy = false, using = false;
  // What the open results window is about: the English words actually searched, what the person typed (shown when it was
  // Chinese), which scope and, for curated sets, the single set that filters the search.
  let scope: IconScope = "curated", filter = "", term = "", typed = "";
  let outcome: "idle" | "searching" | "found" | "none" | "failed" | "english" = "idle";
  const dialog = el<HTMLDialogElement>("library-dialog");
  const say = (text: string, tone = "") => { const node = el("library-message"); node.textContent = text; node.dataset.tone = tone; };
  const tell = (text: string, tone = "") => { const node = el("library-status"); node.textContent = text; node.dataset.tone = tone; };
  const savedIds = () => new Set(icons.map(icon => icon.id));
  const chosen = () => icons.find(icon => icon.id === selectedId);
  const ink = () => /^#[0-9a-f]{6}$/i.test(color) ? color : iconInk(options.selected());
  const mine = createGallery(el("library-grid"), pick), found = createGallery(el("library-results"), pick, true);

  function syncBusy() {
    const locked = busy || using;
    field("library-search").disabled = locked; el("library-grid").setAttribute("aria-busy", String(busy)); el("library-results").setAttribute("aria-busy", String(busy));
    for (const id of ["library-scope-curated", "library-scope-all", "library-search-all"]) el<HTMLButtonElement>(id).disabled = busy;
    el<HTMLSelectElement>("library-dialog-set").disabled = busy;
    for (const node of el("library-examples").children) (node as HTMLButtonElement).disabled = busy;
    el<HTMLButtonElement>("library-use").disabled = busy || using || !chosen() || !options.selected() || !options.editable();
    el<HTMLButtonElement>("library-remove").disabled = busy || using || !chosen();
  }
  function renderSelected() {
    const icon = chosen(), panel = el("library-selected"); panel.hidden = !icon;
    if (icon) {
      const curated = curatedIconSet(icon.set), button = options.selected(), look = button?.appearance, own = ownColors(icon.svg);
      el<HTMLImageElement>("library-preview").src = svgDataUrl(inked(icon.svg, ink()));
      // The preview sits on the same background the key will have, so a poor color choice is visible before it is applied: the dark key body,
      // or in Classic the colored plate behind the icon.
      const frame = el("library-preview-frame"), tile = button && button.color !== "none" && getActiveTheme() === "classic" && (look?.style ?? "tile") === "tile" ? look?.tint ?? palette[appearance(button).color] : "";
      if (tile) frame.style.setProperty("--library-preview-bg", tile); else frame.style.removeProperty("--library-preview-bg");
      el("library-selected-name").textContent = icon.name; el("library-selected-set").textContent = `${icon.setName} · ${icon.license}`;
      // Every set outside the curated six is a general Iconify set and may hold brand logos.
      el("library-brand-note").hidden = !!curated && !("brand" in curated);
      field("library-color").value = ink(); field("library-color").disabled = own;
      el<HTMLButtonElement>("library-color-reset").disabled = own || !color; el("library-own-colors").hidden = !own;
      el("library-convert-note").textContent = own ? "The icon is converted to a small WebP image on this device when you use it." :
        "The icon is converted to a small WebP image on this device when you use it, so change the color before choosing Use on this key.";
    }
    mine.mark(selectedId); found.mark(selectedId); syncBusy();
  }
  function renderMine() {
    const terms = field("library-filter").value.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = [...icons].sort((a, b) => b.addedAt - a.addedAt || a.id.localeCompare(b.id))
      .filter(icon => terms.every(term => `${icon.id} ${icon.setName}`.toLowerCase().includes(term)));
    mine.show(shown, selectedId, new Set());
    const empty = el("library-empty"); empty.hidden = shown.length > 0;
    empty.textContent = icons.length ? "No icons match this filter." : "My icons is empty. Choose Search online and tap an icon to save it here.";
  }
  function renderResults() { found.show(results, selectedId, savedIds()); }
  function renderDialog() {
    el("library-dialog-title").textContent = term ? `Results for “${term}”${typed ? ` (${typed})` : ""}` : `Results for “${typed}”`;
    for (const [id, name] of [["library-scope-curated", "curated"], ["library-scope-all", "all"]] as const) el(id).setAttribute("aria-pressed", String(scope === name));
    el("library-dialog-sets").hidden = scope !== "curated"; field("library-dialog-set").value = filter;
    el("library-license-note").hidden = scope !== "all";
    // Zero curated results offer the wider search; an unusable query offers English example words.
    el("library-suggest").hidden = !(outcome === "none" && scope === "curated");
    el("library-examples").hidden = outcome !== "english";
    syncBusy();
  }
  function render() { renderMine(); renderResults(); renderSelected(); }
  function showView(next: "mine" | "online") {
    view = next;
    for (const [id, name] of [["library-tab-mine", "mine"], ["library-tab-online", "online"]] as const) el(id).setAttribute("aria-pressed", String(view === name));
    el("library-mine").hidden = view !== "mine"; el("library-online").hidden = view !== "online";
  }
  function begin() { const ticket = ++serial; busy = true; syncBusy(); return ticket; }
  function end(ticket: number) { if (ticket === serial) { busy = false; syncBusy(); } }
  const failure = (error: unknown, report = say) => report((error as Error).message || "Something went wrong. Try again.", "error");
  function select(item: Item) { selectedId = item.id; render(); }
  // Whatever was still on its way is dropped at once; this never waits for the browser's own (asynchronous) close event.
  function drop() { serial++; busy = false; results = []; outcome = "idle"; renderResults(); syncBusy(); }
  function closeDialog() { if (dialog.open) { dialog.close(); drop(); } }

  async function open() {
    showView(view); const ticket = begin(); say("Loading My icons…");
    try {
      const next = readLibrary(await options.request("list", {}));
      if (ticket !== serial) return;
      icons = next; say(icons.length ? `${icons.length} icon${icons.length === 1 ? "" : "s"} in My icons.` : "");
      if (!chosen()) selectedId = ""; render();
    } catch (error) { if (ticket === serial) failure(error); }
    finally { end(ticket); }
  }
  async function pick(item: Item) {
    if (busy || using) return;
    const report = dialog.open ? tell : say;
    if (icons.some(icon => icon.id === item.id)) { select(item); closeDialog(); say(`${heading(item)} selected.`); el("library-selected").scrollIntoView?.({ block: "nearest" }); return; }
    const ticket = begin(); report(`Saving ${heading(item)} to My icons…`);
    try {
      const added = readIcon(((await options.request("add", { id: item.id })) as { icon?: unknown } | null)?.icon);
      if (!added || added.id !== item.id) throw Error("The Mac sent an icon that cannot be used. Try another one.");
      icons = [...icons.filter(icon => icon.id !== added.id), added];
      // The icon is stored on the Mac either way; a changed key or a closed window only means this panel no longer shows it as chosen.
      if (ticket === serial) { selectedId = added.id; closeDialog(); say(`Saved ${heading(added)} to My icons.`); }
      render(); if (ticket === serial) el("library-selected").scrollIntoView?.({ block: "nearest" });
    } catch (error) { if (ticket === serial) failure(error, report); }
    finally { end(ticket); }
  }
  // Runs the search described by term / scope / filter and fills the results window.
  async function run() {
    const ticket = begin(); outcome = "searching"; results = []; renderResults(); renderDialog(); tell("Searching…");
    try {
      const body = scope === "all" ? { query: term, scope } : filter ? { query: term, scope, set: filter } : { query: term, scope };
      const reply = (await options.request("search", body)) as { results?: unknown; truncated?: unknown } | null;
      if (ticket !== serial) return;
      if (!Array.isArray(reply?.results)) throw Error("The Mac sent search results that cannot be read. Try again.");
      // A curated search can only show curated sets, whatever the reply contains.
      results = reply.results.flatMap(raw => { const item = readItem(raw); return item && (scope === "all" || curatedIconSet(item.set)) ? [item] : []; }).slice(0, MAX_RESULTS);
      renderResults(); outcome = results.length ? "found" : "none";
      // The Mac says when icons of later sets were dropped to stay within its request budget; a full set count alone proves nothing.
      const count = results.length, cut = scope === "all" && reply.truncated === true, where = filter ? curatedIconSet(filter)?.name ?? filter : "the curated sets";
      tell(count ? `${count} icon${count === 1 ? "" : "s"} found. Tap one to save it to My icons.${cut ? ` Only the first ${ICON_PREFIX_LIMIT} icon sets are shown; try a more specific word.` : ""}` :
        scope === "curated" ? `No icons in ${where} for “${term}”.` : `No icons found for “${term}” in any Iconify set. Try another English word.`);
    } catch (error) { if (ticket === serial) { outcome = "failed"; failure(error, tell); } }
    finally { end(ticket); if (ticket === serial) renderDialog(); }
  }
  // Search button or Enter in the query box.
  function search() {
    if (busy || using) return;
    const raw = field("library-query").value.trim().replace(/\s+/g, " "), words = iconKeywords(raw);
    if (!raw || Array.from(raw).length > 64 || words.query && words.query.length < 2) { say("Search for 2 to 64 characters.", "error"); return; }
    scope = "curated"; filter = field("library-set").value; term = words.query; typed = words.chinese ? raw : ""; if (!term) typed = raw;
    results = []; renderResults();
    if (!dialog.open) dialog.showModal();
    if (term) { void run(); return; }
    // Nothing in the text could be turned into an English word: no request is made.
    outcome = "english"; renderDialog(); tell("Iconify only understands English keywords.");
  }
  function again(next: { scope?: IconScope; filter?: string; term?: string }) {
    if (busy) return;
    scope = next.scope ?? scope; filter = next.filter ?? filter;
    if (next.term !== undefined) { term = next.term; typed = ""; field("library-query").value = next.term; }
    if (term) void run(); else renderDialog();
  }
  async function remove() {
    const icon = chosen(); if (!icon || busy) return;
    const ticket = begin(); say(`Removing ${heading(icon)}…`);
    try {
      await options.request("remove", { id: icon.id });
      icons = icons.filter(item => item.id !== icon.id);
      if (selectedId === icon.id) selectedId = "";
      render(); if (ticket === serial) say(`Removed ${heading(icon)} from My icons. Keys that already use it are not changed.`);
    } catch (error) { if (ticket === serial) failure(error); }
    finally { end(ticket); }
  }
  async function use() {
    const icon = chosen(), button = options.selected(); if (!icon || !button || using || busy) return;
    const ticket = ++serial; using = true; syncBusy(); say("Preparing icon on this device…");
    try {
      const applied = await options.use(icon.svg, ink());
      if (ticket === serial) {
        if (applied) say("Icon ready in your draft. Save layout to keep it.", "ok");
        else say("The key changed while preparing the icon. Choose Use on this key again.", "error");
      }
    } catch (error) { if (ticket === serial) failure(error); }
    finally { if (ticket === serial) { using = false; syncBusy(); } }
  }

  el("library-tab-mine").addEventListener("click", () => showView("mine"));
  el("library-tab-online").addEventListener("click", () => showView("online"));
  field("library-filter").addEventListener("input", renderMine);
  field("library-search").addEventListener("click", search);
  // Enter must not submit the surrounding layout form.
  for (const id of ["library-query", "library-filter"]) field(id).addEventListener("keydown", event => {
    if ((event as KeyboardEvent).key !== "Enter") return;
    event.preventDefault(); if (id === "library-query") search();
  });
  field("library-color").addEventListener("input", () => { color = field("library-color").value; renderSelected(); });
  el("library-color-reset").addEventListener("click", () => { color = ""; renderSelected(); });
  el("library-use").addEventListener("click", () => { void use(); });
  el("library-remove").addEventListener("click", () => { void remove(); });
  // Both set filters (the panel's and the results window's) offer the same choices.
  const choices = () => [new Option("All curated sets", ""), ...ICON_SETS.map(set => new Option(`${set.name} · ${set.license}`, set.prefix))];
  el<HTMLSelectElement>("library-set").replaceChildren(...choices());
  el<HTMLSelectElement>("library-dialog-set").replaceChildren(...choices());
  // The results window. Closing it (button, Esc, a key or page change) drops anything still on its way.
  el("library-dialog-close").addEventListener("click", closeDialog);
  // Esc fires "cancel" and then closes the window; any other way of closing ends in "close" (ignored if it was opened again meanwhile).
  dialog.addEventListener("cancel", drop);
  dialog.addEventListener("close", () => { if (!dialog.open) drop(); });
  el("library-scope-curated").addEventListener("click", () => again({ scope: "curated" }));
  el("library-scope-all").addEventListener("click", () => again({ scope: "all" }));
  el("library-search-all").addEventListener("click", () => again({ scope: "all" }));
  field("library-dialog-set").addEventListener("change", () => { field("library-set").value = field("library-dialog-set").value; again({ filter: field("library-dialog-set").value }); });
  el("library-examples").replaceChildren(...ICON_KEYWORD_EXAMPLES.map(word => {
    const node = document.createElement("button"); node.type = "button"; node.className = "quiet"; node.textContent = word;
    node.addEventListener("click", () => again({ term: word })); return node;
  }));

  return {
    // Entering the Icon library source: show My icons from the Mac (the list is fetched fresh each time).
    open() { void open(); },
    // Called on every layout-tools reload: follows the key's current ink without touching requests.
    sync() { renderSelected(); },
    // True while the results window is open: the rest of the page is inert, and global shortcuts must not act.
    get modal() { return !!dialog.open; },
    // A different key or page: late replies for the old one are dropped, the results window closes and the color goes back to the key's own.
    reset(everything = false) {
      serial++; busy = false; using = false; color = ""; say(""); closeDialog(); outcome = "idle";
      if (everything) { icons = []; results = []; selectedId = ""; view = "mine"; showView("mine"); render(); } else renderSelected();
    },
  };
}
