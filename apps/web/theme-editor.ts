import { MAX_CUSTOM_THEMES, themeFonts, themeRadii, themeSpacings, themes, THEME_LAYOUTS, type ThemeLayout, type Config, type CustomTheme, type CustomThemeId, type ThemeChoice, type ThemeFont, type ThemeName, type ThemeRadius, type ThemeSpacing } from "../../packages/contracts/index.js";
import { enhanceSelect } from "./select-menu.js";
import { accentSwatches, baseNames, contrastSummary, deriveTheme, fontStacks, lookOf, normalizeHex, paintVariables, radiusTokens, spacingGap, themeBasics } from "./theme-custom.js";
import { themeColors, themeInfo } from "./themes.js";
import { createLayoutPage, layoutProblem } from "./theme-layout.js";
import { createSketch } from "./theme-sketch.js";

// T64: a custom theme also has a Layout page (theme-layout.ts), the only place where zones change; a built-in theme shows its zones as pictures.
// T42: the Theme window (gear > Theme). A list of the five built-in themes and the custom ones on the left, an editor on the right. Choosing or editing
// a theme previews it live on the whole page (the app paints what preview() returns); Cancel gives the saved theme back exactly. Nothing is saved until
// "Save and use" (or "Use this theme" / "Delete theme"), and then the list and the selected theme go to the Mac in one request.
export interface PagePreview { base: ThemeName; vars: Record<string, string>; ground: string; layout?: ThemeLayout }
interface Options {
  config: () => Config | undefined;
  // Why the theme cannot be changed now ("" when it can): an unsaved layout draft, a save under way, no connection.
  blocked: () => string;
  // Saves the list and the selected theme in one request. Rejects with a readable message.
  save: (customThemes: CustomTheme[], theme: ThemeChoice) => Promise<void>;
  // The window changed what the page should show (or stopped previewing): the app paints again.
  changed: () => void;
  // The theme this device shows (its own choice, ADR-064).
  deviceTheme: () => ThemeChoice;
}
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fontLabel = (font: ThemeFont, base: ThemeName) => `${fontStacks[font].name}${font === themeBasics[base].font ? ` (${baseNames[base]} default)` : ""}`;
const radiusLabels: Record<ThemeRadius, string> = { square: "Square", small: "Small", rounded: "Rounded", round: "Round" };
const spacingLabels: Record<ThemeSpacing, string> = { tight: "Tight", normal: "Normal", loose: "Loose" };
function node(className: string, text = ""): HTMLElement {
  const made = document.createElement("span"); made.className = className; if (text) made.textContent = text; return made;
}
const newId = (): CustomThemeId => `theme-${typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;

export function createThemeEditor(options: Options) {
  const dialog = el<HTMLDialogElement>("theme-dialog");
  let open = false, busy = false, confirming = false, message = "", messageBad = false, skipHex = "";
  let saved: CustomTheme[] = [], active: ThemeChoice = "braun", loaded = "";
  let working: CustomTheme[] = [], selected: ThemeChoice = "braun";
  let dirtyHex: { background?: string; keyBody?: string } = {};
  let tab: "look" | "layout" = "look";
  const rows = new Map<string, HTMLButtonElement>();

  const find = (id: string) => working.find(theme => theme.id === id);
  const current = () => (themes as readonly string[]).includes(selected) ? undefined : find(selected);
  const savedState = () => { const config = options.config(); return JSON.stringify([config?.customThemes ?? [], options.deviceTheme()]); };
  const changedFromSaved = () => JSON.stringify(working) !== JSON.stringify(saved);
  const baseOf = (choice: ThemeChoice): ThemeName => (themes as readonly string[]).includes(choice) ? choice as ThemeName : find(choice)?.base ?? "braun";

  // ---- the Layout page: edits the zones of the selected custom theme; a layout equal to the base theme's is not stored ----
  const baseLayout = (theme: CustomTheme | undefined) => theme ? THEME_LAYOUTS[theme.base] : undefined;
  const layoutIssue = (theme: CustomTheme) => theme.layout ? layoutProblem(theme.layout) : undefined;
  const layoutPage = createLayoutPage({
    layout: () => { const theme = current(); return theme ? theme.layout ?? baseLayout(theme) : undefined; },
    base: () => baseLayout(current()),
    baseName: () => baseNames[current()?.base ?? "braun"],
    change: layout => {
      const theme = current(); if (!theme || busy) return;
      if (JSON.stringify(layout) === JSON.stringify(baseLayout(theme))) delete theme.layout; else theme.layout = clone(layout);
      message = ""; refresh();
    },
  });
  // ---- what the page shows while the window is open ----
  function preview(): PagePreview | undefined {
    if (!open) return undefined;
    const theme = current();
    if (!theme) { const base = baseOf(selected); return { base, vars: {}, ground: themeColors[base].ground }; }
    return { base: theme.base, vars: deriveTheme(theme).vars, ground: theme.background, ...(theme.layout ? { layout: theme.layout } : {}) };
  }

  // ---- the list ----
  function swatch(colors: string[]): HTMLElement {
    const box = node("theme-swatch"); box.setAttribute("aria-hidden", "true");
    for (const color of colors) { const cell = node("theme-swatch-cell"); cell.style.setProperty("background", color); box.append(cell); }
    return box;
  }
  function row(id: ThemeChoice, name: string, note: string, colors: string[], inUse: boolean): HTMLButtonElement {
    const button = document.createElement("button"), text = node("theme-row-text");
    button.type = "button"; button.className = "theme-row"; button.dataset.themeId = id;
    button.setAttribute("aria-pressed", String(id === selected));
    const title = node("theme-row-name", name); if (inUse) title.append(node("theme-tag", "In use"));
    text.append(title, node("theme-row-note", note));
    button.append(swatch(colors), text);
    button.addEventListener("click", () => select(id));
    return button;
  }
  function renderList() {
    rows.clear();
    const builtin = themes.map(theme => {
      const basics = themeBasics[theme];
      const made = row(theme, baseNames[theme], themeInfo[theme].note, [basics.background, basics.keyBody, basics.accent, themeColors[theme].colors.blue.fill], active === theme);
      rows.set(theme, made); return made;
    });
    el("theme-list-builtin").replaceChildren(...builtin);
    const mine = working.map(theme => {
      const made = row(theme.id, theme.name, `Based on ${baseNames[theme.base]}${saved.some(item => item.id === theme.id) ? "" : " · not saved"}`,
        [theme.background, theme.keyBody, theme.accent, themeColors[theme.base].colors.blue.fill], active === theme.id);
      rows.set(theme.id, made); return made;
    });
    el("theme-list-mine").replaceChildren(...mine);
    el("theme-list-empty").hidden = working.length > 0;
    const full = working.length >= MAX_CUSTOM_THEMES;
    el<HTMLButtonElement>("theme-new").disabled = busy || full || !!options.blocked();
    el("theme-new-note").textContent = full ? `You have ${MAX_CUSTOM_THEMES} custom themes, the most you can keep. Delete one to make another.` :
      "Built-in themes can't be changed. Pick one and choose New theme to make your own copy.";
  }

  // ---- the editor ----
  function renderPreview(base: ThemeName, vars: Record<string, string>) {
    const box = el("theme-preview"); box.dataset.theme = base; paintVariables(box, vars);
  }
  function renderEditor() {
    const theme = current(), custom = !!theme;
    el("theme-readonly").hidden = custom; el("theme-form").hidden = !custom;
    const onLayout = custom && tab === "layout";
    el("theme-preview").hidden = onLayout; el("theme-look").hidden = onLayout; el("theme-layout").hidden = !onLayout;
    el("theme-tab-look").setAttribute("aria-pressed", String(!onLayout)); el("theme-tab-layout").setAttribute("aria-pressed", String(onLayout));
    el("theme-confirm").hidden = !(custom && confirming);
    if (!theme) {
      const base = baseOf(selected);
      renderPreview(base, {});
      el("theme-readonly-title").textContent = baseNames[base];
      el("theme-readonly-note").textContent = `${themeInfo[base].note}. Built-in themes can't be changed; use this theme as it is, or make your own copy to change it.`;
      el("theme-readonly-layout").textContent = base === "widget" ? "Layout: Widget has no top bar; three round controls float in the top corners. A built-in layout can't be changed; make your own copy to move the controls." :
        "Layout: where Use | Edit, Settings and the connection sit, and the area that holds your keys. A built-in layout can't be changed; make your own copy to move them.";
      const pictures: HTMLElement[] = [];
      for (const which of ["wide", "narrow"] as const) {
        const sketch = createSketch(which), caption = node("theme-sketch-caption", which === "wide" ? "Wide" : "Narrow");
        sketch.update(THEME_LAYOUTS[base][which]); const box = node("theme-sketch-box"); box.dataset.set = which; box.append(sketch.element, caption); pictures.push(box);
      }
      el("theme-readonly-sketches").replaceChildren(...pictures);
      return;
    }
    const derived = deriveTheme(theme), summary = contrastSummary(theme, derived);
    renderPreview(theme.base, derived.vars);
    const name = el<HTMLInputElement>("theme-name"); if (name.value !== theme.name) name.value = theme.name;
    el("theme-based").textContent = `Based on ${baseNames[theme.base]}`;
    const accentIn = accentSwatches.includes(theme.accent as typeof accentSwatches[number]);
    for (const [hex, button] of accentButtons) button.setAttribute("aria-pressed", String(hex === theme.accent));
    el("theme-accent-custom-button").dataset.active = String(!accentIn);
    el<HTMLInputElement>("theme-accent-custom").value = theme.accent.toLowerCase();
    for (const [field, hexId, colorId, value] of [["background", "theme-bg-hex", "theme-bg-color", theme.background], ["keyBody", "theme-key-hex", "theme-key-color", theme.keyBody]] as const) {
      const hex = el<HTMLInputElement>(hexId), color = el<HTMLInputElement>(colorId);
      if (dirtyHex[field] === undefined && skipHex !== field) hex.value = value;
      hex.setAttribute("aria-invalid", String(dirtyHex[field] !== undefined)); color.value = value.toLowerCase();
      (el(`${colorId}-chip`)).style.setProperty("background", value);
    }
    for (const [radius, button] of radiusButtons) button.setAttribute("aria-pressed", String(radius === theme.radius));
    for (const [spacing, button] of spacingButtons) button.setAttribute("aria-pressed", String(spacing === theme.spacing));
    const font = el<HTMLSelectElement>("theme-font");
    font.replaceChildren(...themeFonts.map(item => new Option(fontLabel(item, theme.base), item))); font.value = theme.font;
    const box = el("theme-contrast"); box.dataset.status = summary.ok ? "ok" : "bad"; box.textContent = summary.text;
    if (onLayout) layoutPage.render();
  }
  function renderFooter() {
    const theme = current(), blocked = options.blocked(), custom = !!theme;
    const named = !!theme && theme.name.trim().length > 0 && theme.name.trim().length <= 40;
    const readable = !!theme && deriveTheme(theme).blockers.length === 0 && !layoutIssue(theme);
    el("theme-delete").hidden = !custom;
    el<HTMLButtonElement>("theme-delete").disabled = busy || !!blocked;
    el("theme-save").hidden = !custom;
    el<HTMLButtonElement>("theme-save").disabled = busy || !!blocked || !named || !readable || Object.keys(dirtyHex).length > 0;
    el<HTMLButtonElement>("theme-use").disabled = busy || !!blocked;
    el<HTMLButtonElement>("theme-copy").disabled = busy || working.length >= MAX_CUSTOM_THEMES || !!blocked;
    const why = blocked || (custom && !named ? "Give the theme a name of up to 40 characters." : custom && Object.keys(dirtyHex).length ? "Finish the color (#RRGGBB) or leave it." :
      theme && layoutIssue(theme) ? `Layout: ${layoutIssue(theme)}` : "");
    el("theme-message").textContent = message || why;
    el("theme-message").dataset.status = (message ? messageBad : !!why) ? "bad" : "info";
  }
  function render() {
    // The entry button in the settings popover.
    const opener = el<HTMLButtonElement>("theme-open"); if (opener) opener.disabled = !!options.blocked() || !options.config();
    if (!open) return;
    renderList(); renderEditor(); renderFooter();
  }
  function refresh() { render(); options.changed(); }

  // ---- actions ----
  function select(id: ThemeChoice) {
    if (busy) return;
    selected = id; tab = "look"; confirming = false; message = ""; dirtyHex = {}; refresh();
  }
  function uniqueName(base: ThemeName): string {
    const taken = new Set(working.map(theme => theme.name));
    let name = `My ${baseNames[base]}`, count = 2;
    while (taken.has(name)) name = `My ${baseNames[base]} ${count++}`;
    return name;
  }
  function createFrom(source: ThemeChoice) {
    if (busy || working.length >= MAX_CUSTOM_THEMES || options.blocked()) return;
    const origin = (themes as readonly string[]).includes(source) ? source as ThemeName : find(source) ?? "braun";
    const look = lookOf(origin), made: CustomTheme = { id: newId(), name: uniqueName(look.base), ...look, ...(typeof origin !== "string" && origin.layout ? { layout: clone(origin.layout) } : {}) };
    working = [...working, made]; selected = made.id; tab = "look"; confirming = false; message = ""; dirtyHex = {}; refresh();
  }
  function edit(patch: Partial<CustomTheme>) {
    const theme = current(); if (!theme || busy) return;
    Object.assign(theme, patch); message = ""; refresh();
  }
  function setColor(field: "background" | "keyBody" | "accent", value: string) {
    if (field !== "accent") delete dirtyHex[field];
    edit({ [field]: value } as Partial<CustomTheme>);
  }
  function typedColor(field: "background" | "keyBody", text: string) {
    const hex = normalizeHex(text);
    // While the person is typing, the text field is left as typed ("abc" is not rewritten to #AABBCC under the cursor).
    if (hex) { skipHex = field; setColor(field, hex); skipHex = ""; } else { dirtyHex[field] = text; refresh(); }
  }
  async function commit(list: CustomTheme[], theme: ThemeChoice, done: () => void) {
    const blocked = options.blocked();
    if (blocked) { message = blocked; messageBad = true; refresh(); return; }
    // Another device may have changed the themes since this window opened: do not overwrite them with an older list.
    if (savedState() !== loaded) { message = "The themes changed on another device while this window was open. Close it and open it again; nothing was saved."; messageBad = true; refresh(); return; }
    busy = true; message = "Saving…"; messageBad = false; refresh();
    try { await options.save(list, theme); message = ""; busy = false; done(); }
    catch (error) { busy = false; message = (error as Error).message || "Could not save the theme."; messageBad = true; refresh(); }
  }
  function adopt() {
    const config = options.config();
    saved = clone(config?.customThemes ?? []); active = options.deviceTheme(); loaded = savedState();
  }
  function close() {
    if (!open) return;
    open = false; busy = false; confirming = false; message = "";
    if (dialog.open && typeof dialog.close === "function") dialog.close();
    // The list is drawn again from the saved layout now, so it never shows "not saved" from before the save the next time it is seen.
    adopt(); working = clone(saved); selected = active; renderList();
    options.changed();
  }
  function openWindow() {
    if (open || options.blocked() || !options.config()) return;
    // The gear's popover would stay open behind the window.
    const gear = document.getElementById("connection-settings") as HTMLDetailsElement | null; if (gear) gear.open = false;
    adopt(); working = clone(saved); selected = active; confirming = false; message = ""; dirtyHex = {}; busy = false; open = true; tab = "look";
    if (!dialog.open && typeof dialog.showModal === "function") dialog.showModal();
    render(); options.changed();
  }

  // ---- static pieces built once ----
  const accentButtons = new Map<string, HTMLButtonElement>(), radiusButtons = new Map<ThemeRadius, HTMLButtonElement>(), spacingButtons = new Map<ThemeSpacing, HTMLButtonElement>();
  for (const hex of accentSwatches) {
    const button = document.createElement("button"); button.type = "button"; button.className = "theme-swatch-button";
    button.setAttribute("aria-label", `Accent ${hex}`); button.title = hex; button.style.setProperty("background-color", hex);
    button.addEventListener("click", () => setColor("accent", hex)); accentButtons.set(hex, button);
  }
  el("theme-accent").replaceChildren(...accentButtons.values());
  el("theme-accent-custom").addEventListener("input", () => { const hex = normalizeHex(el<HTMLInputElement>("theme-accent-custom").value); if (hex) setColor("accent", hex); });
  for (const radius of themeRadii) {
    const button = document.createElement("button"), sample = node("theme-radius-sample");
    button.type = "button"; button.className = "theme-choice"; sample.style.setProperty("border-radius", `${Math.round(radiusTokens[radius].key * 1.2)}px`); sample.setAttribute("aria-hidden", "true");
    button.append(sample, node("theme-choice-name", radiusLabels[radius])); button.addEventListener("click", () => edit({ radius })); radiusButtons.set(radius, button);
  }
  el("theme-radius").replaceChildren(...radiusButtons.values());
  for (const spacing of themeSpacings) {
    const button = document.createElement("button"), samples = node("theme-gap-sample");
    button.type = "button"; button.className = "theme-choice"; samples.setAttribute("aria-hidden", "true");
    samples.style.setProperty("gap", `${spacing === "normal" ? 4 : spacingGap[spacing] / 3}px`);
    for (let index = 0; index < 3; index++) samples.append(node("theme-gap-cell"));
    button.append(samples, node("theme-choice-name", spacingLabels[spacing])); button.addEventListener("click", () => edit({ spacing })); spacingButtons.set(spacing, button);
  }
  el("theme-spacing").replaceChildren(...spacingButtons.values());
  const samples: [string, string, string, boolean][] = [["solid", "Open", "App", false], ["body", "Mute", "Shortcut", false], ["body", "Deploy", "Script", true], ["solid2", "Build", "Workflow", false]];
  el("theme-preview").replaceChildren(...samples.map(([fill, name, detail, lamp]) => {
    const key = node("theme-sample"), icon = node("theme-sample-icon");
    key.dataset.fill = fill; icon.setAttribute("aria-hidden", "true");
    key.append(icon, node("theme-sample-name", name), node("theme-sample-detail", detail));
    if (lamp) { const light = node("theme-sample-lamp"); light.setAttribute("aria-hidden", "true"); key.append(light); }
    return key;
  }));
  enhanceSelect(el<HTMLSelectElement>("theme-font"));

  el("theme-name").addEventListener("input", () => edit({ name: el<HTMLInputElement>("theme-name").value.replace(/[\x00-\x1f\x7f]/g, "") }));
  el("theme-bg-hex").addEventListener("input", () => typedColor("background", el<HTMLInputElement>("theme-bg-hex").value));
  el("theme-key-hex").addEventListener("input", () => typedColor("keyBody", el<HTMLInputElement>("theme-key-hex").value));
  el("theme-bg-hex").addEventListener("change", () => { delete dirtyHex.background; refresh(); });
  el("theme-key-hex").addEventListener("change", () => { delete dirtyHex.keyBody; refresh(); });
  el("theme-bg-color").addEventListener("input", () => { const hex = normalizeHex(el<HTMLInputElement>("theme-bg-color").value); if (hex) setColor("background", hex); });
  el("theme-key-color").addEventListener("input", () => { const hex = normalizeHex(el<HTMLInputElement>("theme-key-color").value); if (hex) setColor("keyBody", hex); });
  el("theme-font").addEventListener("change", () => { const value = el<HTMLSelectElement>("theme-font").value as ThemeFont; if (themeFonts.includes(value)) edit({ font: value }); });
  el("theme-tab-look").addEventListener("click", () => { tab = "look"; render(); options.changed(); });
  el("theme-tab-layout").addEventListener("click", () => { tab = "layout"; render(); options.changed(); });
  el("theme-new").addEventListener("click", () => createFrom(selected));
  el("theme-copy").addEventListener("click", () => createFrom(selected));
  el("theme-use").addEventListener("click", () => {
    const choice = selected; if ((themes as readonly string[]).indexOf(choice) < 0) return;
    // The saved list is sent as it is: unsaved edits in this window are not part of "Use this theme".
    void commit(clone(saved), choice, close);
  });
  el("theme-save").addEventListener("click", () => {
    const theme = current(); if (!theme || el<HTMLButtonElement>("theme-save").disabled) return;
    theme.name = theme.name.trim();
    void commit(clone(working), theme.id, close);
  });
  el("theme-delete").addEventListener("click", () => {
    const theme = current(); if (!theme || busy) return;
    if (!saved.some(item => item.id === theme.id)) { working = working.filter(item => item.id !== theme.id); selected = theme.base; message = ""; refresh(); return; }
    confirming = true; message = ""; refresh();
  });
  el("theme-confirm-no").addEventListener("click", () => { confirming = false; refresh(); });
  el("theme-confirm-yes").addEventListener("click", () => {
    const theme = current(); if (!theme) return;
    // The theme in use falls back to its base theme in the same save.
    const next = clone(saved).filter(item => item.id !== theme.id), choice: ThemeChoice = active === theme.id ? theme.base : active;
    void commit(next, choice, () => { working = working.filter(item => item.id !== theme.id); confirming = false; adopt(); selected = choice; refresh(); });
  });
  el("theme-cancel").addEventListener("click", close);
  el("theme-dialog-close").addEventListener("click", close);
  el("theme-open").addEventListener("click", openWindow);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => { if (open) close(); });
  // Esc inside the font menu closes only that menu (the menu stops the key and intercepts the dialog's cancel while it is open).

  return {
    render, preview, isOpen: () => open, open: openWindow, close,
    // For the app: the layout was replaced (another device, a reload) while the window is open.
    configChanged() { if (open && !busy && savedState() !== loaded && !changedFromSaved()) { adopt(); working = clone(saved); if (!find(selected) && !(themes as readonly string[]).includes(selected)) selected = active; render(); } },
  };
}
