import { DEFAULT_THEME, resolveTheme, themes, type CustomTheme, type ThemeChoice } from "../../packages/contracts/index.js";
import { baseNames, deriveTheme, paintVariables } from "./theme-custom.js";
import { createSketch } from "./theme-sketch.js";
import { themeInfo } from "./themes.js";

// T64 (ADR-064): the first time a device opens Keyln it has no theme of its own yet. This dialog asks once: every built-in theme and every custom theme, each with a small picture of
// where it puts Use | Edit, Settings and the connection and where the keys go. Braun is selected. "Use this" saves it for this device (the Mac keeps it); "Not now" is remembered for
// this browser tab, so the question does not come back until the tab is opened again.
interface Options {
  customThemes: () => readonly CustomTheme[];
  /** Saves this device's choice; rejects with a readable message. */
  choose: (choice: ThemeChoice) => Promise<void>;
  /** The width of the window, which decides the picture (wide or narrow). */
  width: () => number;
}
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const skippedKey = "keyln.theme-question-skipped";

export function createFirstTheme(options: Options) {
  const dialog = el<HTMLDialogElement>("first-theme-dialog"), list = el("first-theme-list");
  let open = false, busy = false, selected: ThemeChoice = DEFAULT_THEME, skippedHere = false;
  const skipped = () => { try { return skippedHere || sessionStorage.getItem(skippedKey) === "1"; } catch { return skippedHere; } };
  const skip = () => { skippedHere = true; try { sessionStorage.setItem(skippedKey, "1"); } catch { /* The copy in memory is enough for this page. */ } };
  const choices = new Map<ThemeChoice, HTMLButtonElement>();

  function card(choice: ThemeChoice, name: string, note: string, custom?: CustomTheme): HTMLButtonElement {
    const resolved = resolveTheme(choice, options.customThemes()), narrow = options.width() <= 600;
    const button = document.createElement("button"), picture = document.createElement("span"), title = document.createElement("strong"), line = document.createElement("span");
    button.type = "button"; button.className = "first-theme-card"; button.dataset.themeChoice = choice; button.setAttribute("role", "radio");
    picture.className = "first-theme-picture"; picture.dataset.theme = resolved.name; picture.setAttribute("aria-hidden", "true");
    if (custom) paintVariables(picture, deriveTheme(custom).vars);
    const sketch = createSketch(narrow ? "narrow" : "wide");
    sketch.update(resolved.layout[narrow ? "narrow" : "wide"]);
    picture.append(sketch.element);
    title.textContent = name; line.className = "first-theme-note"; line.textContent = note;
    button.append(picture, title, line);
    button.addEventListener("click", () => { if (!busy) { selected = choice; paint(); } });
    return button;
  }
  function build() {
    choices.clear();
    const cards = themes.map(theme => card(theme, baseNames[theme], themeInfo[theme].note));
    themes.forEach((theme, index) => choices.set(theme, cards[index]!));
    for (const theme of options.customThemes()) { const made = card(theme.id, theme.name, `Your theme · based on ${baseNames[theme.base]}`, theme); choices.set(theme.id, made); cards.push(made); }
    list.replaceChildren(...cards);
    if (!choices.has(selected)) selected = DEFAULT_THEME;
  }
  function paint() {
    for (const [choice, button] of choices) { button.setAttribute("aria-checked", String(choice === selected)); button.setAttribute("aria-pressed", String(choice === selected)); }
    el<HTMLButtonElement>("first-theme-use").disabled = busy; el<HTMLButtonElement>("first-theme-skip").disabled = busy;
  }
  function show() {
    if (open) return;
    open = true; busy = false; selected = DEFAULT_THEME; el("first-theme-message").textContent = "";
    build(); paint();
    if (!dialog.open && typeof dialog.showModal === "function") dialog.showModal();
  }
  function hide() {
    if (!open) return;
    open = false; busy = false;
    if (dialog.open && typeof dialog.close === "function") dialog.close();
  }
  el("first-theme-use").addEventListener("click", async () => {
    if (busy || !open) return;
    busy = true; el("first-theme-message").textContent = "Saving…"; paint();
    try { await options.choose(selected); }
    catch (error) { busy = false; el("first-theme-message").textContent = (error as Error).message || "The theme could not be saved."; paint(); }
  });
  el("first-theme-skip").addEventListener("click", () => { if (busy) return; skip(); hide(); });
  // Esc is "Not now".
  dialog.addEventListener("cancel", event => { event.preventDefault(); if (!busy) { skip(); hide(); } });
  return { show, hide, skipped, isOpen: () => open, busy: () => busy, selected: () => selected };
}
export type FirstTheme = ReturnType<typeof createFirstTheme>;
