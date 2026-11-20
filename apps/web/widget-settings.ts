import { PAGES_SIZE_BOUNDS, DEFAULT_PAGES_SIZE, MAX_PAGES_COLUMNS, NARROW_MAX_WIDTH, pagesWidthPercent, DISPLAY_FORMS, isPages, locate, type Config, type DisplayWidget, type PagesWidget, type PagesSize, type Widget } from "../../packages/contracts/index.js";
import { renamePage, resizeWidget, rebuildPagesColumns } from "./page-layout.js";
import { flowLayout } from "./page-view.js";
import { LIBRARY_TYPES, tierAfterFormChange } from "./library.js";
import type { PagesColumnsInfo } from "./console.js";

// T63 (ADR-064): the parts of the settings card that are not about a key or a group. A display widget (result, activity, clock, text, Refresh) has its form and, for
// Text, its words. A Pages widget has its list of pages (name, order, delete, add).
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const copy = (config: Config): Config => JSON.parse(JSON.stringify(config));
interface Options {
  view: () => Config | undefined;
  widget: () => Widget | undefined;
  editable: () => boolean;
  apply: (next: Config, selectedId?: string, coalesce?: string) => void;
  say: (value: string) => void;
  invalidChanged: () => void;
  pagesGeometry: (id: string) => { size: { w: number; h: number }; widthPx: number; contentWidthPx: number; gapPx: number } | undefined;
  // T91: what the keys-per-row setting did on this screen (the side that applies, whether it was lifted to the widest item or held at 44px).
  pagesColumns?: (id: string) => PagesColumnsInfo | undefined;
  pages: { add: (pagesId: string) => boolean; remove: (pagesId: string, pageId: string) => void; move: (pagesId: string, pageId: string, step: -1 | 1) => boolean };
}
export function createWidgetSettings(options: Options) {
  let formsKey = "", rowsKey = "";
  const invalid = new Map<string, { w: string; h: string }>();
  // T91: the text of a keys-per-row field that is not a whole number from 1 to 16, per Pages widget; it blocks Save like a bad size (ADR-084).
  type Side = "wide" | "narrow";
  const SIDES: readonly Side[] = ["wide", "narrow"], invalidColumns = new Map<string, Partial<Record<Side, string>>>();
  const sideNow = (): Side => typeof window.innerWidth === "number" && window.innerWidth > 0 && window.innerWidth <= NARROW_MAX_WIDTH ? "narrow" : "wide";
  const rows = new Map<string, HTMLInputElement>(), formButtons = new Map<string, HTMLButtonElement>();
  const display = () => { const widget = options.widget(); return widget && !isPages(widget) && "form" in widget ? widget : undefined; };
  const pages = (): PagesWidget | undefined => { const widget = options.widget(); return widget && isPages(widget) ? widget : undefined; };
  function setSize(size: PagesSize, coalesce?: string) {
    const widget = pages(), config = options.view(); if (!widget || !config || !options.editable()) return;
    invalid.delete(widget.id); const next = copy(config), target = locate(next, widget.id)!.widget as PagesWidget;
    target.size = size;
    options.apply(next, widget.id, coalesce);
  }
  const bounded = (n: number, max = 3840) => Math.max(1, Math.min(max, Math.round(n)));
  for (const [axis, modes] of [["w", ["fixed", "fill", "percent"]], ["h", ["fixed", "fill"]]] as const) for (const mode of modes) {
    el(`pages-${axis === "w" ? "width" : "height"}-${mode}`).addEventListener("click", () => {
      const widget = pages(); if (!widget) return;
      if ((axis === "w" ? widget.size?.w.mode : widget.size?.h.mode) === mode || !widget.size && mode === "fill") return;
      const size = { ...(widget.size ?? DEFAULT_PAGES_SIZE) }, actual = options.pagesGeometry(widget.id);
      if (!actual) { options.say("Pages geometry is not available yet."); return; }
      if (axis === "w") size.w = mode === "fixed" ? { mode, u: bounded(actual.size.w) } : mode === "fill" ? { mode, min: 240 } : { mode: "percent", pct: bounded(pagesWidthPercent(actual.widthPx, actual.contentWidthPx, actual.gapPx), 100) };
      else size.h = mode === "fixed" ? { mode, u: bounded(actual.size.h) } : { mode: "fill", min: 240 };
      setSize(size);
    });
  }
  for (const pct of [25, 33, 50, 67, 75, 100]) el(`pages-percent-${pct}`).addEventListener("click", () => {
    const widget = pages(); if (widget) setSize({ ...(widget.size ?? DEFAULT_PAGES_SIZE), w: { mode: "percent", pct } });
  });
  for (const id of ["pages-width", "pages-height"]) el(id).addEventListener("input", () => {
    const widget = pages(); if (!widget || !options.editable()) return;
    const size = { ...(widget.size ?? DEFAULT_PAGES_SIZE) };
    const w = el<HTMLInputElement>("pages-width").value, h = el<HTMLInputElement>("pages-height").value;
    const valid = (v: string, max: number) => /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) >= 1 && Number(v) <= max;
    if (!valid(w, size.w.mode === "percent" ? 100 : PAGES_SIZE_BOUNDS.max.w) || !valid(h, PAGES_SIZE_BOUNDS.max.h)) { invalid.set(widget.id, { w, h }); options.invalidChanged(); return; }
    size.w = size.w.mode === "fixed" ? { mode: "fixed", u: Number(w) } : size.w.mode === "fill" ? { mode: "fill", min: Number(w) } : { mode: "percent", pct: Number(w) };
    size.h = size.h.mode === "fixed" ? { mode: "fixed", u: Number(h) } : { mode: "fill", min: Number(h) };
    setSize(size, `pages-size:${widget.id}:${id}`);
  });
  // T93 (ADR-084): changing the number from A to B rewrites the order of the pages so every item keeps its cell (rebuildPagesColumns). A "session" is one stretch of editing a field:
  // it remembers the draft as it was before the first keystroke and the count in force then (A), and every keystroke rebuilds from THAT, not from the previous preview, so typing
  // "1" then "0" for 10 goes 9 to 10 and never 9 to 1 to 10. The session ends when the field commits (change or blur), when Auto is chosen, or when anything else changed the draft.
  const nominal = (trial: Widget[], columns: number) => flowLayout(trial, 2000, "standard", 8, 14, 0, 0, columns).placements;
  interface Session { id: string; side: Side; base: Config; from: number | undefined; last: string; serial: number }
  let session: Session | undefined, serial = 0;
  const movedNote = new Map<string, { json: string; text: string }>();
  function setColumns(side: Side, value: number | undefined, coalesce?: string, rebuild?: { base: Config; from: number | undefined }) {
    const widget = pages(), config = options.view(); if (!widget || !config || !options.editable()) return;
    const pending = invalidColumns.get(widget.id);
    if (pending) { delete pending[side]; if (!Object.keys(pending).length) invalidColumns.delete(widget.id); }
    let next = copy(rebuild?.base ?? config), target = locate(next, widget.id)!.widget as PagesWidget;
    const columns = { ...target.columns };
    if (value === undefined) delete columns[side]; else columns[side] = value;
    if (Object.keys(columns).length) target.columns = columns; else delete target.columns;
    let note = "";
    if (rebuild && rebuild.from !== undefined && value !== undefined && value !== rebuild.from) {
      const done = rebuildPagesColumns(next, widget.id, rebuild.from, value, nominal);
      next = done.config;
      const total = done.moved.reduce((sum, entry) => sum + entry.count, 0), group = locate(next, widget.id)!.widget as PagesWidget;
      if (total) note = `${total} key${total === 1 ? "" : "s"} moved to the end of ${group.pages.length === 1 ? "the page" : `their pages: ${done.moved.map(entry => `${entry.page || "Unnamed"} (${entry.count})`).join(", ")}`}.`;
    }
    options.apply(next, widget.id, coalesce);
    const view = options.view();
    if (note && view) movedNote.set(widget.id, { json: JSON.stringify(view), text: note }); else movedNote.delete(widget.id);
    options.invalidChanged();
    if (session && view) session.last = JSON.stringify(view);
  }
  for (const side of SIDES) {
    // Auto is a toggle: from Auto the field takes the number of columns the page has now (or 8 wide, 4 narrow); from a number it goes back to Auto. Going to Auto never rebuilds.
    // From Auto the count on show is A when this is the side in use here; the field then starts at that count (at most 16), so only a count above 16 moves anything.
    el(`pages-columns-${side}-auto`).addEventListener("click", () => {
      const widget = pages(), config = options.view(); if (!widget || !config || !options.editable()) return;
      session = undefined;
      if (widget.columns?.[side] !== undefined) { setColumns(side, undefined); return; }
      const info = options.pagesColumns?.(widget.id), shown = info && info.side === side ? info.applied : undefined, guess = shown ?? (side === "wide" ? 8 : 4);
      setColumns(side, Math.max(1, Math.min(MAX_PAGES_COLUMNS, guess)), undefined, shown === undefined ? undefined : { base: config, from: shown });
    });
    el(`pages-columns-${side}`).addEventListener("input", () => {
      const widget = pages(), config = options.view(); if (!widget || !config || !options.editable() || widget.columns?.[side] === undefined) return;
      const text = el<HTMLInputElement>(`pages-columns-${side}`).value;
      if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > MAX_PAGES_COLUMNS) { invalidColumns.set(widget.id, { ...invalidColumns.get(widget.id), [side]: text }); options.invalidChanged(); return; }
      // The same session while the draft is exactly what the last keystroke made; any other change starts again from the draft as it is.
      if (!session || session.id !== widget.id || session.side !== side || session.last !== JSON.stringify(config)) session = { id: widget.id, side, base: copy(config), from: widget.columns[side], last: JSON.stringify(config), serial: ++serial };
      setColumns(side, Number(text), `pages-columns:${widget.id}:${side}:${session.serial}`, { base: session.base, from: session.from });
    });
    for (const name of ["change", "blur"]) el(`pages-columns-${side}`).addEventListener(name, () => { session = undefined; });
  }
  function setForm(form: string) {
    const widget = display(), config = options.view(); if (!widget || !config || !options.editable() || widget.form === form) return;
    try {
      const next = copy(config), target = locate(next, widget.id)!.widget as DisplayWidget;
      target.form = form;
      const tier = tierAfterFormChange(target.kind, form, target.size);
      options.apply(tier === target.size ? next : resizeWidget(next, widget.id, tier), widget.id);
      el("display-message").textContent = "";
    } catch (error) { el("display-message").textContent = (error as Error).message; }
  }
  el("display-text").addEventListener("input", () => {
    const widget = display(), config = options.view(); if (!widget || widget.kind !== "text" || !config || !options.editable()) return;
    const next = copy(config), target = locate(next, widget.id)!.widget as DisplayWidget;
    target.text = el<HTMLInputElement>("display-text").value;
    options.apply(next, widget.id, "text");
  });
  el("pages-add").addEventListener("click", () => { const widget = pages(); if (widget && options.editable()) options.pages.add(widget.id); });
  function pageRows(widget: PagesWidget) {
    const key = JSON.stringify([widget.id, widget.pages.map(page => page.id)]);
    if (key === rowsKey) return;
    rowsKey = key; rows.clear();
    el("pages-list").replaceChildren(...widget.pages.map((page, index) => {
      const row = document.createElement("li"), name = document.createElement("input");
      row.className = "pages-row"; row.dataset.pageId = page.id;
      name.type = "text"; name.maxLength = 40; name.value = page.name; name.autocomplete = "off"; name.className = "pages-name";
      name.setAttribute("aria-label", `Name of page ${index + 1}`);
      name.addEventListener("input", () => {
        const config = options.view(); if (!config || !options.editable()) return;
        try { options.apply(renamePage(config, widget.id, page.id, name.value), widget.id, `page:${page.id}`); } catch (error) { options.say((error as Error).message); }
      });
      const make = (caption: string, label: string, run: () => void, disabled: boolean) => {
        const button = document.createElement("button");
        button.type = "button"; button.className = "pages-row-button"; button.textContent = caption; button.setAttribute("aria-label", `${label} ${page.name || `page ${index + 1}`}`);
        button.disabled = disabled; button.addEventListener("click", () => { if (!button.disabled) run(); });
        return button;
      };
      row.append(name,
        make("↑", "Move up", () => options.pages.move(widget.id, page.id, -1), index === 0),
        make("↓", "Move down", () => options.pages.move(widget.id, page.id, 1), index === widget.pages.length - 1),
        make("Delete", "Delete", () => options.pages.remove(widget.id, page.id), widget.pages.length <= 1));
      rows.set(page.id, name);
      return row;
    }));
  }
  return {
    load() { const widget = display(); if (widget?.kind === "text") el<HTMLInputElement>("display-text").value = widget.text ?? ""; },
    reset() { formsKey = ""; rowsKey = ""; rows.clear(); invalid.clear(); invalidColumns.clear(); session = undefined; movedNote.clear(); },
    get invalid() { return invalid.size > 0 || invalidColumns.size > 0; },
    get firstInvalidId() { return (invalid.keys().next().value ?? invalidColumns.keys().next().value) as string | undefined; },
    // Puts the cursor in the field that blocks Save.
    focusInvalid() {
      const id = this.firstInvalidId;
      if (id && invalid.has(id)) el<HTMLInputElement>("pages-width").focus();
      else { const side = SIDES.find(name => id && invalidColumns.get(id)?.[name] !== undefined); if (side) el<HTMLInputElement>(`pages-columns-${side}`).focus(); }
    },
    prune(config: Config) { for (const id of [...invalid.keys()]) if (!locate(config, id)) invalid.delete(id); for (const id of [...invalidColumns.keys()]) if (!locate(config, id)) invalidColumns.delete(id); },
    clearInvalid() { const had = invalid.size > 0 || invalidColumns.size > 0; invalid.clear(); invalidColumns.clear(); const size = pages()?.size ?? DEFAULT_PAGES_SIZE;
      el<HTMLInputElement>("pages-width").value = String(size.w.mode === "fixed" ? size.w.u : size.w.mode === "fill" ? size.w.min : size.w.pct);
      el<HTMLInputElement>("pages-height").value = String(size.h.mode === "fixed" ? size.h.u : size.h.min);
      for (const side of SIDES) { const n = pages()?.columns?.[side]; el<HTMLInputElement>(`pages-columns-${side}`).value = n === undefined ? "" : String(n); }
      return had; },
    // Shows the section the selected widget needs, and nothing else.
    render(isDisplay: boolean, isPagesView: boolean, saving: boolean) {
      el("display-settings").hidden = !isDisplay; el("pages-settings").hidden = !isPagesView;
      const widget = display();
      if (isDisplay && widget) {
        const key = `${widget.id}/${widget.kind}`;
        if (key !== formsKey) {
          formsKey = key; formButtons.clear();
          const names = LIBRARY_TYPES.find(type => type.key === widget.kind)?.forms ?? [];
          el("display-forms").replaceChildren(...DISPLAY_FORMS[widget.kind].map(form => {
            const button = document.createElement("button");
            button.type = "button"; button.className = "form-choice"; button.dataset.form = form; button.textContent = names.find(entry => entry.form === form)?.name ?? form;
            button.setAttribute("aria-pressed", "false"); button.addEventListener("click", () => setForm(form));
            formButtons.set(form, button); return button;
          }));
        }
        for (const [form, button] of formButtons) { button.setAttribute("aria-pressed", String(form === widget.form)); button.disabled = saving; }
        el("display-form-field").hidden = DISPLAY_FORMS[widget.kind].length < 2;
        el("display-text-field").hidden = widget.kind !== "text";
        el<HTMLInputElement>("display-text").disabled = saving;
      }
      const group = pages();
      if (isPagesView && group) {
        const pending = invalid.get(group.id), size = group.size ?? DEFAULT_PAGES_SIZE;
        for (const [axis, modes] of [["width", ["fixed", "fill", "percent"]], ["height", ["fixed", "fill"]]] as const) {
          const value = axis === "width" ? size.w : size.h;
          for (const mode of modes) { const button = el<HTMLButtonElement>(`pages-${axis}-${mode}`); button.setAttribute("aria-pressed", String(value.mode === mode)); button.disabled = saving; }
          const input = el<HTMLInputElement>(`pages-${axis}`), key = axis === "width" ? "w" : "h";
          const text = pending?.[key] ?? String(value.mode === "fixed" ? value.u : value.mode === "fill" ? value.min : value.pct);
          if (document.activeElement !== input && input.value !== text) input.value = text;
          input.min = "1"; input.max = value.mode === "percent" ? "100" : "3840";
          input.setAttribute("aria-invalid", String(!!pending)); input.disabled = saving;
          el(`pages-${axis}-label`).textContent = value.mode === "fill" ? "Minimum (u)" : value.mode === "percent" ? "Percent" : `${axis === "width" ? "Width" : "Height"} (u)`;
        }
        el("pages-percent-presets").hidden = size.w.mode !== "percent";
        for (const pct of [25, 33, 50, 67, 75, 100]) {
          const button = el<HTMLButtonElement>(`pages-percent-${pct}`);
          button.setAttribute("aria-pressed", String(size.w.mode === "percent" && size.w.pct === pct));
          button.disabled = saving;
        }
        // T91: keys per row. The row for this screen's side is marked; the notes only speak about that row.
        const info = options.pagesColumns?.(group.id), side = info?.side ?? sideNow(), bad = invalidColumns.get(group.id);
        for (const name of SIDES) {
          const fixed = group.columns?.[name] !== undefined, input = el<HTMLInputElement>(`pages-columns-${name}`), toggle = el<HTMLButtonElement>(`pages-columns-${name}-auto`);
          toggle.setAttribute("aria-pressed", String(!fixed)); toggle.disabled = saving;
          const text = bad?.[name] ?? (fixed ? String(group.columns![name]) : "");
          if (document.activeElement !== input && input.value !== text) input.value = text;
          input.disabled = saving || !fixed; input.setAttribute("aria-invalid", String(bad?.[name] !== undefined));
          el(`pages-columns-${name}-row`).dataset.active = String(name === side);
        }
        el("pages-columns-side").textContent = `This screen: ${side}`;
        const notes: string[] = [];
        if (group.columns?.[side] === undefined) notes.push("Auto: the Grid size decides how many keys fit in a row.");
        else if (info) {
          if (info.raised) notes.push(`The widest item needs ${info.applied} columns, so this row uses ${info.applied}.`);
          if (info.floored) notes.push("Keys would be narrower than 44px here, so they stay 44px and the page scrolls sideways.");
        }
        const moved = movedNote.get(group.id), json = moved ? JSON.stringify(options.view()) : "";
        if (moved && moved.json === json) notes.unshift(moved.text); else if (moved) movedNote.delete(group.id);
        el("pages-columns-note").textContent = notes.join(" ");
        el("pages-columns-error").textContent = bad && Object.keys(bad).length ? `Enter a whole number from 1 to ${MAX_PAGES_COLUMNS}, or choose Auto.` : "";
        el("pages-size-error").textContent = pending ? "Enter whole numbers within the allowed range (1–3840u or 1–100%)." : "";
        el<HTMLButtonElement>("pages-add").disabled = saving || group.pages.length >= 16;
        pageRows(group);
        for (const [id, input] of rows) { const page = group.pages.find(item => item.id === id); if (page && document.activeElement !== input && input.value !== page.name) input.value = page.name; }
      } else rowsKey = "";
    },
    focusPage(pageId: string) { rows.get(pageId)?.focus(); },
  };
}
