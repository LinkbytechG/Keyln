import { Fault, widgetPresetSpan, presetSummary, findComponent, isPages, type Widget, icons, sizeTiers, parseAppearance, imageDimensions, jpegDimensions, imageIcon, svgDataUrl, type Component, type Config, type KeyAppearance, type SizeTier } from "../../packages/contracts/index.js";
import { resizeWidget } from "./page-layout.js";
import { appearance, getActiveTheme, iconInk, setIcon } from "./presentation.js";
import { themeColor } from "./themes.js";
import { appIconReference } from "./app-icons.js";
import { createIconLibrary, type LibraryRequest } from "./icon-library.js";
import { tiersFor } from "./library.js";

// A 4 × 2 board of standard keys: the area a size covers is one merged block, the rest stays empty.
function tierSample(tier: SizeTier, component: { kind: string; form?: string } = { kind: "key" }): HTMLElement {
  const board = document.createElement("span"), span = widgetPresetSpan({ ...component, size: tier });
  board.className = "size-sample"; board.setAttribute("aria-hidden", "true");
  const block = document.createElement("b");
  block.dataset.columns = String(span.cols); block.dataset.rows = String(span.rows);
  board.append(block);
  for (let index = 0; index < 8 - span.cols * span.rows; index++) board.append(document.createElement("i"));
  return board;
}
const tierLabel = presetSummary;

const MAX_IMAGE_BYTES = 2 * 1024 * 1024, MAX_IMAGE_SIDE = 2048;
const svgLength = (value?: string) => {
  const match = /^\s*([0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?)\s*(px|pt|pc|mm|cm|in|em|ex)?\s*$/i.exec(value ?? "");
  const units: Record<string, number> = { pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
  const size = match ? Number(match[1]) * (units[match[2]?.toLowerCase() ?? ""] ?? 1) : 0;
  return size > 0 && Number.isFinite(size) ? size : undefined;
};
// Text-only preparation of an SVG that is later decoded by an <img>. It never enters the page DOM.
// width/height are rewritten to a fixed box so the browser rasterizes the vector, not a small preview.
export function prepareSvg(source: string, ink: string, edge = 192): { text: string; width: number; height: number } {
  const text = source.replace(/^\uFEFF/, "");
  const prolog = /^\s*(?:<\?xml[^>]*\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>\[]*(?:\[[\s\S]*?\])?\s*>\s*)*/i.exec(text)![0];
  const root = /^<svg(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/i.exec(text.slice(prolog.length));
  if (!root) throw Error("This file is not an SVG image.");
  const selfClosing = /\/\s*$/.test(root[1]!), attributes = root[1]!.replace(/\/\s*$/, "");
  const attribute = (name: string) => { const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attributes); return match?.[1] ?? match?.[2]; };
  let width = svgLength(attribute("width")), height = svgLength(attribute("height"));
  const box = attribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const view = box?.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0 ? { width: box[2]!, height: box[3]! } : undefined;
  const sized = width !== undefined || height !== undefined, ratio = view ? view.width / view.height : 1;
  if (width === undefined && height === undefined) { width = view?.width ?? 1; height = view?.height ?? 1; }
  else if (width === undefined) width = height! * ratio;
  else if (height === undefined) height = width / ratio;
  const scale = edge / Math.max(width!, height!), outWidth = Math.max(1, Math.round(width! * scale)), outHeight = Math.max(1, Math.round(height! * scale));
  const rewritten = attributes.replace(/\s+(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*')/gi, "") +
    ` width="${outWidth}" height="${outHeight}"` + (!view && sized ? ` viewBox="0 0 ${width} ${height}"` : "");
  const head = prolog.replace(/<\?xml[^>]*\?>\s*/i, "");
  // currentColor has no page color inside an image, so it becomes this key's own icon color.
  return { text: `${head}<svg${rewritten}${selfClosing ? "/" : ""}>${text.slice(prolog.length + root[0].length)}`.replace(/currentColor/gi, ink), width: outWidth, height: outHeight };
}
// data: is the only URL form the page CSP allows for images; the SVG is decoded as an image, never inserted.
function decodeSvg(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image(), timer = setTimeout(() => { image.onload = image.onerror = null; reject(Error("This SVG took too long to decode. Choose a simpler file.")); }, 10_000);
    image.onload = () => { clearTimeout(timer); resolve(image); };
    image.onerror = () => { clearTimeout(timer); reject(Error("This SVG could not be decoded. Export a plain SVG without scripts or external files.")); };
    image.src = url;
  });
}
function rasterDimensions(bytes: Uint8Array) {
  for (const read of [(data: Uint8Array) => imageDimensions(data, "image/png"), (data: Uint8Array) => imageDimensions(data, "image/webp"), jpegDimensions])
    try { return read(bytes); } catch { /* Try the next supported header. */ }
  throw Error("Choose a PNG, WebP, JPEG or SVG image.");
}

// Shared by uploads and the Icon library: draw a decoded image at 192, then 160, 128 and 96 pixels until imageIcon() accepts the WebP.
function rasterIcon(source: CanvasImageSource, width: number, height: number): string {
  const canvas = document.createElement("canvas"), context = canvas.getContext("2d"); if (!context) throw Error("Image preparation is unavailable in this browser.");
  for (const limit of [192,160,128,96]) {
    const scale = Math.min(1, limit / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    context.clearRect(0,0,canvas.width,canvas.height);
    try { context.drawImage(source,0,0,canvas.width,canvas.height); } catch { throw Error("This image could not be drawn. Choose a different file."); }
    try { return imageIcon(canvas.toDataURL("image/webp", .9)); }
    catch (error) {
      if ((error as Error).name === "SecurityError") throw Error("This image cannot be converted safely, for example because it uses external content. Choose a plain image.");
    }
  }
  throw Error("This image is too complex for a key icon. Choose a simpler image.");
}
// SVG text -> WebP icon. `currentColor` becomes `ink`; the SVG only ever passes through a data: URL image.
async function svgIcon(source: string, ink: string): Promise<string> {
  const prepared = prepareSvg(source, ink);
  return rasterIcon(await decodeSvg(svgDataUrl(prepared.text)), prepared.width, prepared.height);
}

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (id: string) => el<HTMLInputElement>(id);
const copy = (config: Config): Config => JSON.parse(JSON.stringify(config));
interface Options {
  view: () => Config | undefined; selected: () => Component | undefined;
  // T63: the widget whose size tiers are shown (a key, a group or a display widget; a Pages widget has none).
  widget: () => Widget | undefined;
  apply: (next: Config, selectedId?: string) => void;
  editable: () => boolean; redraw: () => void;
  library: LibraryRequest;
}
// The Icon source is one value ("app", "builtin", "text", "image" or "library") kept in a hidden input. The four tabs write it;
// "My image" covers both "image" (upload) and "library" (Icon library), which its inner switch chooses between.
const sourceNames: readonly string[] = ["app", "builtin", "text", "image"];
const looks = [
  { id: "icon-style", property: "style", fallback: "tile", options: [["tile", "Color block"], ["outline", "Outline"], ["plain", "Icon only"]] },
  { id: "icon-shape", property: "shape", fallback: "rounded", options: [["rounded", "Rounded"], ["circle", "Circle"], ["square", "Square"]] },
  { id: "icon-scale", property: "scale", fallback: "medium", options: [["small", "Small"], ["medium", "Medium"], ["large", "Large"]] },
  { id: "key-content-layout", property: "layout", fallback: "stacked", options: [["stacked", "Icon above label"], ["horizontal", "Icon beside label"], ["icon-only", "Hide label"]] },
] as const;
export function createLayoutTools(options: Options) {
  let selectedId = "", sourceIntent = "", uploadTicket = 0, uploading = false, applyTicket = 0, applying = false;
  let imageSource = "image";
  const gallery = new Map<string, HTMLButtonElement>();
  const message = (text: string) => { el("design-message").textContent = text; };
  const tabs = new Map<string, HTMLButtonElement>(sourceNames.map(name => [name, el<HTMLButtonElement>(`icon-tab-${name}`)] as const));
  function showSource() {
    const value = field("icon-source").value, tab = value === "library" ? "image" : value;
    el("text-icon-fields").hidden = value !== "text";
    el("image-icon-fields").hidden = value !== "image";
    el("library-icon-fields").hidden = value !== "library";
    el("icon-library").hidden = value !== "builtin";
    el("app-icon-note").hidden = value !== "app";
    field("icon").disabled = value !== "builtin";
    for (const [name, node] of tabs) {
      const on = name === tab;
      node.setAttribute("aria-selected", String(on)); node.setAttribute("tabindex", on ? "0" : "-1"); el(`icon-panel-${name}`).hidden = !on;
    }
    el("image-source-upload").setAttribute("aria-pressed", String(value === "image")); el("image-source-library").setAttribute("aria-pressed", String(value === "library"));
    // The key color only shapes an App icon or an image through the Outline ring, Classic's color plate and the default ink of one-color pictures.
    const limited = value === "app" || value === "image" || value === "library";
    el("key-color-group").dataset.emphasis = limited ? "muted" : "normal"; el("key-color-note").hidden = !limited;
  }
  function operate(operation: (config: Config) => Config, id = options.selected()?.id, done = "") {
    const config = options.view(); if (!config || !options.editable()) return;
    try {
      options.apply(operation(config), id); message(done);
    } catch (error) {
      message((error as Error).message);
      load();
    }
  }
  function changeLook(change: (look: KeyAppearance) => void) {
    operate(config => {
      const next = copy(config), button = findComponent(next, options.selected()?.id ?? "");
      if (!button) throw new Fault("INVALID_INPUT", "Select a key first.");
      const look = { ...button.appearance }; change(look); button.appearance = parseAppearance(look);
      return next;
    });
  }
  const library = createIconLibrary({ request: options.library, selected: options.selected, editable: options.editable, use: applyLibraryIcon });
  function load() {
    const button = options.selected();
    if (uploading) el("icon-upload-message").textContent = "The key changed while preparing the image. Choose the file again.";
    uploadTicket++; uploading = false; applyTicket++; applying = false;
    if (!button) { selectedId = ""; sourceIntent = ""; library.reset(); return; }
    const look = button.appearance, actualSource = appIconReference(button) ? "app" : look?.glyph?.type ?? "builtin";
    el<HTMLButtonElement>("icon-tab-app").disabled = button.action?.type !== "app.open" && button.action?.type !== "window.activate";
    if (selectedId !== button.id) { selectedId = button.id; sourceIntent = ""; message(""); el("icon-upload-message").textContent = ""; library.reset(); }
    field("icon-source").value = sourceIntent || actualSource;
    if (field("icon-source").value === "image" || field("icon-source").value === "library") imageSource = field("icon-source").value;
    field("icon").value = button.icon;
    if (field("icon-text").value !== (look?.glyph?.type === "text" ? look.glyph.text : ""))
      field("icon-text").value = look?.glyph?.type === "text" ? look.glyph.text : "";
    const shown = look as unknown as Record<string, string | undefined> | undefined;
    for (const group of looks) for (const [value] of group.options)
      lookButtons.get(`${group.id}:${value}`)?.setAttribute("aria-pressed", String(value === (shown?.[group.property] ?? group.fallback)));
    field("custom-color-enabled").checked = !!look?.tint; field("key-tint").disabled = !look?.tint; field("key-tint").hidden = !look?.tint;
    field("key-tint").value = look?.tint ?? themeColor(getActiveTheme(), appearance(button).color);
    for (const [id, node] of gallery) node.setAttribute("aria-pressed", String(id === button.icon));
    showSource(); library.sync();
  }
  // Size: the six tier buttons (S, M, L, XL, Tall, Wide). They read the selected widget; only the sizes its type may use are shown (library.ts), and the one it has.
  const sizeButtons = new Map<string, HTMLButtonElement>(), lookButtons = new Map<string, HTMLButtonElement>();
  const sizeBox = el("key-size-options");
  for (const tier of sizeTiers) {
    const button = document.createElement("button"), caption = document.createElement("span");
    button.type = "button"; button.className = "size-choice"; button.id = `size-${tier}`; button.dataset.size = tier; button.dataset.tier = tier; button.setAttribute("aria-pressed", "false");
    caption.textContent = tierLabel(tier); button.append(tierSample(tier), caption);
    button.addEventListener("click", () => {
      const widget = options.widget(); if (!widget || isPages(widget) || !options.editable()) return;
      if (widget.size === tier) renderSize(); else resize(tier);
    });
    sizeButtons.set(tier, button); sizeBox.append(button);
  }
  function renderSize() {
    const widget = options.widget(), row = el("card-size");
    row.hidden = !widget || isPages(widget) || widget.kind === "clock";
    if (!widget || isPages(widget) || widget.kind === "clock") return;
    const allowed = tiersFor(widget.kind, "form" in widget ? widget.form : undefined);
    for (const [id, node] of sizeButtons) {
      const tier = id as SizeTier, caption = document.createElement("span");
      caption.textContent = tierLabel(tier, widget);
      node.replaceChildren(tierSample(tier, widget), caption);
      node.setAttribute("aria-pressed", String(id === widget.size));
      node.hidden = !allowed.includes(id as SizeTier) && id !== widget.size;
    }
  }
  for (const group of looks) for (const [value, name] of group.options) {
    const button = document.createElement("button"), sample = document.createElement("span"), caption = document.createElement("span");
    button.type = "button"; button.className = "style-choice"; button.id = `${group.id}-${value}`; button.dataset.value = value; button.setAttribute("aria-pressed", "false");
    sample.className = "style-sample"; sample.dataset.sample = value; sample.setAttribute("aria-hidden", "true"); sample.append(document.createElement("b"), document.createElement("i"));
    caption.textContent = name; button.append(sample, caption);
    // Choosing the value the key already shows changes nothing, like picking the same option in a menu.
    button.addEventListener("click", () => { if (button.getAttribute("aria-pressed") !== "true") changeLook(look => Object.assign(look, { [group.property]: value })); });
    lookButtons.set(`${group.id}:${value}`, button); el(group.id).append(button);
  }
  function resize(tier: SizeTier) {
    const id = options.widget()?.id, config = options.view(); if (!id || !config || !options.editable()) return;
    try { options.apply(resizeWidget(config, id, tier), id); el("card-size-message").textContent = ""; }
    catch (error) { el("card-size-message").textContent = (error as Error).message; renderSize(); }
  }
  field("custom-color-enabled").addEventListener("change", () => changeLook(look => {
    if (field("custom-color-enabled").checked) look.tint = field("key-tint").value; else delete look.tint;
  }));
  field("key-tint").addEventListener("input", () => changeLook(look => { look.tint = field("key-tint").value; }));
  // What choosing a source does: the same for a tab, for the My image switch and for a script that sets the hidden #icon-source.
  function sourceChosen() {
    uploadTicket++; sourceIntent = field("icon-source").value; showSource();
    if (sourceIntent === "image" || sourceIntent === "library") imageSource = sourceIntent;
    if (sourceIntent === "library") library.open();
    if (sourceIntent === "builtin") changeLook(look => { look.glyph = {type:"builtin"}; });
    if (sourceIntent === "app" && (options.selected()?.action?.type === "app.open" || options.selected()?.action?.type === "window.activate"))
      changeLook(look => { look.glyph = {type:"app"}; });
    if (sourceIntent === "text") changeLook(look => { look.glyph = { type: "text", text: field("icon-text").value.trim() || "K" }; });
    if (sourceIntent === "image") options.redraw();
  }
  field("icon-source").addEventListener("change", () => { if (options.editable()) sourceChosen(); });
  function chooseSource(value: string) {
    if (!options.editable() || field("icon-source").value === value) return;
    field("icon-source").value = value; sourceChosen();
  }
  for (const [name, tab] of tabs) {
    // "My image" opens on the source that was used last (upload by default).
    tab.addEventListener("click", () => { if (!tab.disabled) chooseSource(name === "image" ? imageSource : name); });
    tab.addEventListener("keydown", event => {
      const key = (event as KeyboardEvent).key, step = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const open = sourceNames.filter(source => !tabs.get(source)?.disabled), next = open[(open.indexOf(name) + step + open.length) % open.length];
      const target = next ? tabs.get(next) : undefined; target?.focus(); target?.click();
    });
  }
  el("image-source-upload").addEventListener("click", () => chooseSource("image"));
  el("image-source-library").addEventListener("click", () => chooseSource("library"));
  field("icon-text").addEventListener("input", () => {
    const value = field("icon-text").value;
    operate(config => {
      const next = copy(config), button = findComponent(next, options.selected()?.id ?? "");
      if (button) button.appearance = { ...button.appearance, glyph: { type: "text", text: value } };
      return next;
    });
  });
  el("reset-key-style").addEventListener("click", () => {
    sourceIntent = ""; operate(config => { const next = copy(config), button = findComponent(next, options.selected()?.id ?? ""); if (button) delete button.appearance; return next; });
  });
  for (const [id, name] of Object.entries(icons)) {
    const button = document.createElement("button"), glyph = document.createElement("span");
    button.type = "button"; button.className = "icon-option"; button.title = name; button.dataset.icon = id; button.setAttribute("aria-label", name);
    glyph.className = "ui-icon"; setIcon(glyph, appearance({ icon: id as Component["icon"], action: null }).symbol); button.append(glyph);
    button.addEventListener("click", () => operate(config => {
      const next = copy(config), target = findComponent(next, options.selected()?.id ?? "");
      if (!target) return config;
      target.icon = id as Component["icon"];
      if (id === "app") target.appearance = {...target.appearance, glyph:{type:"builtin"}};
      else if (target.appearance) delete target.appearance.glyph;
      sourceIntent = "builtin"; return next;
    }));
    gallery.set(id, button); el("icon-gallery").append(button);
  }
  field("icon-search").addEventListener("input", () => {
    const query = field("icon-search").value.toLowerCase().trim(); let count = 0;
    for (const [id, node] of gallery) { node.hidden = !`${id} ${icons[id as Component["icon"]]}`.toLowerCase().includes(query); if (!node.hidden) count++; }
    el("icon-search-empty").hidden = count !== 0;
  });
  field("icon-image-file").addEventListener("change", () => { void uploadImage(); });
  async function uploadImage() {
    const file = field("icon-image-file").files?.[0], config = options.view(), button = options.selected(); if (!file || !config || !button || !options.editable()) return;
    const ticket = ++uploadTicket; uploading = true; el("icon-upload-message").textContent = "Preparing icon on this device…";
    options.redraw();
    try {
      if (file.size > MAX_IMAGE_BYTES) throw Error("Choose an image within 2 MiB.");
      let data: string;
      if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) data = await svgIcon(await file.text(), iconInk(button));
      else {
        const dimensions = rasterDimensions(new Uint8Array(await file.arrayBuffer()));
        if (dimensions.width < 1 || dimensions.height < 1 || dimensions.width > MAX_IMAGE_SIDE || dimensions.height > MAX_IMAGE_SIDE)
          throw Error("Choose an image within 2048 × 2048 pixels.");
        const bitmap = await createImageBitmap(file);
        try { data = rasterIcon(bitmap, bitmap.width, bitmap.height); } finally { bitmap.close(); }
      }
      if (ticket !== uploadTicket || options.view() !== config || options.selected()?.id !== button.id) return;
      sourceIntent = "image"; changeLook(look => { look.glyph = { type: "image", data }; });
      el("icon-upload-message").textContent = "Image ready in your draft. Save layout to keep it.";
    } catch (error) { if (ticket === uploadTicket) el("icon-upload-message").textContent = (error as Error).message; }
    finally { if (ticket === uploadTicket) uploading = false; field("icon-image-file").value = ""; options.redraw(); }
  }
  async function applyLibraryIcon(svg: string, ink: string): Promise<boolean> {
    const config = options.view(), button = options.selected(); if (!config || !button || !options.editable()) return false;
    const ticket = ++applyTicket; applying = true; options.redraw();
    try {
      const data = await svgIcon(svg, ink);
      // load() bumps the ticket whenever the key, page or look changed while this was being drawn.
      if (ticket !== applyTicket || options.view() !== config || options.selected()?.id !== button.id) return false;
      applying = false; sourceIntent = "library"; changeLook(look => { look.glyph = { type: "image", data }; });
      return true;
    } finally { if (ticket === applyTicket) { applying = false; } options.redraw(); }
  }
  return { load, renderSize,
    reset() { selectedId = ""; sourceIntent = ""; uploadTicket++; uploading = false; applyTicket++; applying = false; library.reset(true); },
    get uploading() { return uploading || applying; },
    // The icon search window is open: the page behind it is inert and must not save or act.
    get modalOpen() { return library.modal; },
    validate() {
      if (uploading || applying) { message("Wait for the icon image to finish preparing."); return false; }
      if (sourceIntent === "image" && options.selected()?.appearance?.glyph?.type !== "image") {
        message("Choose an image, or select another icon source before saving."); field("icon-image-file").focus(); return false;
      }
      return true;
    } };
}
