import { Fault, PAGES_SIZE_BOUNDS, gridSize, allComponents, findComponent, isBlank, isPages, locate, type Widget, parseAppearance, keyboardKeys, keyLabel, modifiers, label, icon, icons, keyColors, buttonColor, parseAction, parseConfig, splitView,
  validateShellArguments, shortcutLabel, exportItemFile, itemFileLayout, parseItemFile, type ItemFile, type AppInfo, type Component, type Config, type ConfigDocument, type PagesSize, type ScriptInfo, type ShortcutInfo, type SizeTier, type WindowInfo } from "../../packages/contracts/index.js";
import { appearance, setIcon, type SymbolName } from "./presentation.js";
import { createWorkflowEditor } from "./workflows.js";
import { createLayoutTools } from "./layout-tools.js";
import type { LibraryRequest } from "./icon-library.js";
import { addPage, addWidget, addWidgetAt, containerWidgets, containerOf, moveWidget, movePage, removePage, removeWidget, replaceBlank, type Container } from "./page-layout.js";
import { createWidgetSettings } from "./widget-settings.js";
import { createCardMover } from "./card-move.js";
import { tiersFor, PAGES_PRESETS, type LibrarySpec } from "./library.js";
import { appDialogOpen, createAppPicker } from "./app-picker.js";
import { createWindowPicker } from "./window-picker.js";
import { enhanceSelect } from "./select-menu.js";
import { downloadJson, itemFileName, itemInfo, planItemImport, readJsonFile } from "./component-files.js";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
const text = (id: string, value: string) => { el(id).textContent = value; };
// Configurations are small plain JSON. Avoid requiring structuredClone on the Surface.
const copy = (config: Config): Config => JSON.parse(JSON.stringify(config));
// T94: the draft and its baseline do not carry the layout's revision: the editor keeps it apart (baseLayoutRevision), so a theme change of this page, which raises only
// that revision, can be adopted without touching the draft, its Undo steps or the "unsaved changes" comparison.
const own = (config: Config): Config => { const next = copy(config); delete next.layoutRevision; return next; };
export interface ReviewedImport { document: ConfigDocument; stamp: string }
interface Options {
  // `base` is the baseline the draft was started from (with the revision of each part it was based on); `imported` is the document an import was made from.
  save: (candidate: Config, base: Config, imported?: ReviewedImport) => Promise<Config>;
  reload: () => Promise<Config | undefined>;
  // Where a new component goes first: the page of a Pages widget that is showing, else the canvas (ADR-064).
  container: () => Container;
  changed: () => void;
  test: (buttonId: string, revision: number) => void;
  windows: (id: string) => Promise<WindowInfo[]>;
  library: LibraryRequest;
  // T57: the Mac's import check for a file's apps, scripts and shortcuts. Returns one line per thing to fix; it changes and runs nothing.
  bindings: (layout: Config) => Promise<string[]>;
  pagesGeometry: (id: string) => { size: { w: number; h: number }; widthPx: number; contentWidthPx: number; gapPx: number } | undefined;
  pagesColumns?: (id: string) => import("./console.js").PagesColumnsInfo | undefined;
}
type Confirmation = "remove" | "leave" | "reload" | "import" | "page";

export function targetKeyName(button: Component, config: Config, apps: AppInfo[], scripts: ScriptInfo[], shortcuts: ShortcutInfo[]): string | undefined {
  const action = button.action;
  const name = !action ? undefined : action.type === "app.open" ? apps.find(app => app.id === action.appId)?.name :
    action.type === "window.activate" ? action.title : action.type === "keyboard.shortcut" ? shortcutLabel(action).replaceAll(" + ", "") :
    action.type === "shell.run" ? scripts.find(script => script.id === action.scriptId)?.name :
    action.type === "shortcuts.run" ? shortcuts.find(shortcut => shortcut.id === action.shortcutId)?.name :
    config.workflows?.find(workflow => workflow.id === action.workflowId)?.name;
  // The existing label contract counts UTF-16 units. Do not split a surrogate pair.
  return name?.trim().slice(0, 40).replace(/[\uD800-\uDBFF]$/, "") || undefined;
}

// One line under the label that says what the chosen action does when the key is tapped.
export function actionNote(button?: Component): string {
  if (!button) return "";
  const note: Record<string, string> = {
    "app.open": "Opens the app and brings it to the foreground.",
    "window.activate": "Brings the chosen window of the app to the front.",
    "keyboard.shortcut": "Sends the keys to the Mac’s current foreground app.",
    "shell.run": "Runs a script you approved on the Mac.",
    "shortcuts.run": "Runs a Mac shortcut and waits for it to finish.",
    "workflow.run": "Runs the steps of a saved workflow in order.",
  };
  return button.action ? note[button.action.type] ?? "" : "Choose what this key does when tapped.";
}

export function createConfigurationEditor(options: Options) {
  let latest: Config | undefined, baseline: Config | undefined, draft: Config | undefined;
  let baselineJson: string | undefined;
  let apps: AppInfo[] = [], selectedKey = "", instanceId = "", baseInstance = "";
  let scripts: ScriptInfo[] = [], scriptArgs: string[] = [], shortcuts:ShortcutInfo[]=[];
  let dirty = false, saving = false, available = false, blocked = false, testAvailable = false;
  let confirmation: Confirmation | undefined, pendingRemoval: { id?: string; pagesId?: string; pageId?: string } | undefined;
  let importing = false, importDoc: ReviewedImport | undefined, baseLayoutRevision: number | undefined, baseLayoutName: string | undefined;
  // The Mac layout has moved on from the one the draft was started from: either revision differs, or it is another layout, or another Host run.
  const isBehind = () => !!draft && (latest?.revision !== draft.revision || latest?.layoutName !== baseLayoutName || latest?.layoutRevision !== baseLayoutRevision || baseInstance !== instanceId);
  // Whether saving the draft would conflict: another Host run, another layout, or a newer revision of a part the draft changed (ADR-086 decision 11: a key renamed
  // elsewhere does not block a draft that only moved keys, and the other way round). An import replaces everything, so any newer revision counts.
  const isStale = () => {
    if (!draft) return false;
    if (baseInstance !== instanceId || latest?.layoutName !== baseLayoutName) return true;
    const libraryStale = latest?.revision !== draft.revision, layoutStale = latest?.layoutRevision !== baseLayoutRevision;
    if (importing || !baseline) return libraryStale || layoutStale;
    const parts = splitView(baseline, draft);
    return !!parts.library && libraryStale || !!parts.layout && layoutStale;
  };
  const actionContexts = new Map<string, string>();
  const names = new Map<string, { manual: boolean }>();
  // T92 (ADR-085): the card moves by its grip and collapses to its header; both last only while it stays open.
  const cardMover = createCardMover({ card: el("editor"), grip: el("editor-grip"), collapse: el("editor-collapse") });
  // T63: the settings card (<section id="editor">) is open for the selected widget; popupId is the widget to return focus to when it closes.
  let popup = false, popupId = "", shownKey = "";
  // Undo: the draft as it was before each change (a run of typing in one field is one step). Cleared whenever the draft starts again.
  const history: string[] = [];
  let lastJson = "", lastCoalesce: string | undefined;
  let resizeSequence = 0;
  let pagesResize: { id: string; before: Config; history: string[]; lastJson: string; lastCoalesce?: string; coalesce: string } | undefined;
  const selected = () => draft && selectedKey ? findComponent(draft, selectedKey) : undefined;
  const selectedWidget = (): Widget | undefined => draft && selectedKey ? locate(draft, selectedKey)?.widget : undefined;
  const target = selected;
  const nameKey = () => selected()?.id ?? "";
  const appContext = () => ({used: (draft ? allComponents(draft) : []).flatMap(button => {
    const actions = button.action?.type === "workflow.run" ? draft?.workflows?.find(workflow => workflow.id === (button.action as Extract<Component["action"],{type:"workflow.run"}>).workflowId)?.steps.map(step => step.action) ?? [] : [button.action];
    return actions.flatMap(action => action?.type === "app.open" || action?.type === "window.activate" ? [action.appId] : []);
  })});
  const appPicker = createAppPicker(el("app-select-host"), "app-select", () => { windowPicker.appChanged(); updateButton(); }, appContext);
  const windowPicker = createWindowPicker(el("window-fields"), "window", {appId:()=>appPicker.value,load:options.windows,changed:updateButton,discoveryFirst:true});
  const workflowEditor = createWorkflowEditor({config:()=>draft,selected,apps:()=>apps,appContext,scripts:()=>scripts,shortcuts:()=>shortcuts,windows:options.windows,changed:()=>{input("action-type").value=selected()?.action?.type??"none";automaticName();actionFields();changed();}});
  el<HTMLSelectElement>("grid-size").addEventListener("change", () => {
    if (!draft || saving) return;
    applyDraft({ ...copy(draft), gridSize: gridSize(el<HTMLSelectElement>("grid-size").value) });
  });
  for (const name of ["first", "earlier", "later", "last"] as const) el(`order-${name}`).addEventListener("click", () => {
    if (!draft || saving || !selectedWidget()) return;
    const ref = containerOf(draft, selectedKey)!, list = containerWidgets(draft, ref), at = list.findIndex(widget => widget.id === selectedKey);
    const index = name === "first" ? 0 : name === "earlier" ? Math.max(0, at - 1) : name === "last" ? list.length : Math.min(list.length, at + 2);
    applyDraft(moveWidget(draft, selectedKey, ref, index), selectedKey);
  });
  const layoutTools = createLayoutTools({ view: () => draft, selected, widget: selectedWidget,
    editable: () => !!draft && !saving && !pagesResize, redraw: options.changed, library: options.library,
    apply: (next, selectedId) => applyDraft(next, selectedId) });
  const widgetSettings = createWidgetSettings({ view: () => draft, widget: selectedWidget, editable: () => !!draft && !saving && !pagesResize,
    pagesGeometry: options.pagesGeometry, pagesColumns: options.pagesColumns, apply: (next, selectedId, coalesce) => applyDraft(next, selectedId, coalesce), say: value => message(value),
    invalidChanged: () => { updateDirty(); options.changed(); },
    pages: { add: (id: string): boolean => api.addPageTo(id), remove: (id: string, pageId: string): void => api.removePageFrom(id, pageId), move: (id: string, pageId: string, step: -1 | 1): boolean => api.movePageIn(id, pageId, step) } });
  // A change made by the layout tools or the widget settings: the draft becomes `next`.
  function applyDraft(next: Config, selectedId?: string, coalesce?: string) {
    if (!draft || saving || pagesResize && coalesce !== pagesResize.coalesce) return;
    const previousId = selected()?.id; draft = next; widgetSettings.prune(next);
    if (selectedId !== undefined) selectedKey = locate(draft, selectedId)?.widget.id ?? "";
    if (!selectedWidget()) { selectedKey = ""; popup = false; }
    if (previousId !== selected()?.id) loadFields(); else layoutTools.load();
    changed(coalesce);
  }
  function beginPagesResize(id: string): boolean {
    if (!draft || saving || pagesResize || layoutTools.uploading || widgetSettings.invalid || confirmation) return false;
    const widget = locate(draft, id)?.widget;
    if (!widget || !isPages(widget)) return false;
    pagesResize = { id, before: copy(draft), history: history.slice(), lastJson, lastCoalesce, coalesce: `pages-drag-${++resizeSequence}` };
    popup = false; selectedKey = id; loadFields(); options.changed(); return true;
  }
  function previewPagesResize(id: string, size: PagesSize) {
    if (!draft || pagesResize?.id !== id) return;
    const valid = (value: number, max: number) => Number.isInteger(value) && value >= 1 && value <= max;
    if (!valid(size.w.mode === "fixed" ? size.w.u : size.w.mode === "fill" ? size.w.min : size.w.pct, size.w.mode === "percent" ? 100 : PAGES_SIZE_BOUNDS.max.w) || !valid(size.h.mode === "fixed" ? size.h.u : size.h.min, PAGES_SIZE_BOUNDS.max.h)) return;
    const widget = locate(draft, id)?.widget;
    if (!widget || !isPages(widget) || JSON.stringify(widget.size) === JSON.stringify(size)) return;
    const next = copy(draft), target = locate(next, id)!.widget;
    if (isPages(target)) target.size = size;
    applyDraft(next, id, pagesResize.coalesce);
  }
  function endPagesResize(commit: boolean) {
    const gesture = pagesResize; if (!gesture) return;
    pagesResize = undefined;
    if (!commit || JSON.stringify(draft) === JSON.stringify(gesture.before)) {
      draft = gesture.before; history.splice(0, history.length, ...gesture.history);
      lastJson = gesture.lastJson; lastCoalesce = gesture.lastCoalesce;
    } else lastCoalesce = undefined;
    updateDirty(); loadFields(); message(dirty ? "Unsaved changes. Save to apply them on your Mac." : "No unsaved changes."); options.changed();
  }
  // The status line is in the floating Edit area.
  // T64: the status line is a live region that stays out of sight unless it says something the Save dot does not: a result (it fades after a few seconds) or a problem (it stays).
  const quietMessages = new Set(["Unsaved changes. Save to apply them on your Mac.", "No unsaved changes.", "Saving…"]);
  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  const message = (value: string) => {
    text("save-message", value);
    const line = el("save-message"), good = /^(Saved on your Mac\.|Latest saved layout loaded\.|Undone\.|Added |Exported as )/.test(value);
    line.dataset.tone = quietMessages.has(value) || value.startsWith("Editing.") ? "quiet" : good ? "result" : "problem";
    clearTimeout(messageTimer);
    if (good) messageTimer = setTimeout(() => { if (line.dataset.tone === "result") line.dataset.tone = "quiet"; }, 3500);
  };
  const colorButtons = new Map<string, HTMLButtonElement>(), actionButtons = new Map<string, HTMLButtonElement>();
  const canTest = () => !!draft && !!selected()?.action && !dirty && !saving && !layoutTools.uploading && !blocked && testAvailable &&
    !isBehind();
  function clearErrors() {
    for (const id of ["button-name", "icon", "icon-text", "icon-image-file", "action-type", "app-select", "window-title", "shortcut-key", "script-select"])
      input(id).setAttribute("aria-invalid", "false");
    text("field-error", "");
  }
  // ---- the settings card ----
  function focusTile(id: string) {
    const tile = typeof el("button-grid").querySelector === "function" ? el("button-grid").querySelector<HTMLElement>(`[data-button-id="${id}"],[data-widget-id="${id}"]`) : null;
    tile?.focus();
  }
  function syncCard() {
    const card = el("editor"), want = !!draft && popup && !!selectedWidget();
    // T92: every opening starts in the default place, fully expanded; closing forgets the place and the collapse.
    if (want && card.hidden) { cardMover.reset(); card.hidden = false; el("editor-title").focus(); }
    else if (!want && !card.hidden) { card.hidden = true; cardMover.reset(); }
    if (want) {
      const id = selectedKey;
      if (id !== shownKey) { el("popup-body").scrollTop = 0; if (shownKey) cardMover.expand(); shownKey = id; }
    } else shownKey = "";
  }
  // The card's close button, and a tap on empty canvas. The draft is kept; nothing is saved or discarded.
  function closeCard() {
    if (!popup) return;
    popup = false; selectedKey = "";
    loadFields(); options.changed(); focusTile(popupId);
  }
  function updateDirty() { dirty = !!draft && (importing || widgetSettings.invalid || JSON.stringify(draft) !== baselineJson); }
  // Every change of the draft goes through here: Undo remembers the draft as it was, and the status line follows.
  function changed(coalesce?: string) {
    if (draft) {
      const now = JSON.stringify(draft);
      if (now !== lastJson) {
        if (!(coalesce && coalesce === lastCoalesce)) { history.push(lastJson); if (history.length > 60) history.shift(); }
        lastJson = now;
      }
      lastCoalesce = coalesce;
    }
    updateDirty(); confirmation = undefined; pendingRemoval = undefined; clearErrors();
    message(dirty ? "Unsaved changes. Save to apply them on your Mac." : "No unsaved changes.");
    options.changed();
  }
  function undo() {
    if (!draft || saving || pagesResize) return;
    if (widgetSettings.clearInvalid()) { updateDirty(); options.changed(); return; }
    if (!history.length) return;
    const back = history.pop()!;
    draft = JSON.parse(back) as Config; lastJson = back; lastCoalesce = undefined;

    if (!selectedWidget()) { selectedKey = ""; popup = false; }
    updateDirty(); confirmation = undefined; pendingRemoval = undefined;
    loadFields(); message(dirty ? "Undone. Unsaved changes remain." : "Undone. No unsaved changes."); options.changed();
  }
  function automaticName() {
    const button = target(); if (!button || !draft) return;
    let ownership = names.get(nameKey());
    if (!ownership) { ownership = { manual: !!button.label && button.label !== "New button" && button.label !== "New action" }; names.set(nameKey(), ownership); }
    const name = targetKeyName(button, draft, apps, scripts, shortcuts);
    if (!ownership.manual && name) { button.label = name; input("button-name").value = name; }
  }
  function actionFields() {
    const type = input("action-type").value;
    el("app-fields").hidden = type !== "app.open" && type !== "window.activate";
    el("window-fields").hidden = type !== "window.activate";
    el("shortcut-fields").hidden = type !== "keyboard.shortcut";
    el("shell-fields").hidden = type !== "shell.run";
    el("mac-shortcuts-fields").hidden=type!=="shortcuts.run";
    el("workflow-fields").hidden=type!=="workflow.run";
    input("mac-shortcut-select").disabled=type!=="shortcuts.run";input("mac-shortcut-timeout").disabled=type!=="shortcuts.run";
    input("script-select").disabled = type !== "shell.run";
    appPicker.setDisabled(type !== "app.open" && type !== "window.activate" || saving);
    windowPicker.setDisabled(type !== "window.activate" || saving || !available);
    input("shortcut-key").disabled = type !== "keyboard.shortcut";
    for (const modifier of modifiers) input(`modifier-${modifier}`).disabled = type !== "keyboard.shortcut";
    for (const [value, button] of actionButtons) button.setAttribute("aria-pressed", String(type === value));
  }
  function scriptFields(action = target()?.action) {
    const missing = action?.type === "shell.run" && !!action.scriptId && !!action.version && !scripts.some(script => script.id === action.scriptId && script.version === action.version);
    const select = el<HTMLSelectElement>("script-select");
    select.replaceChildren(new Option("Choose a Mac-approved script", ""), ...scripts.map(script => new Option(script.name, script.id)),
      ...(missing && action?.type === "shell.run" ? [new Option("Unavailable version — select an approved script", "__unavailable")] : []));
    select.value = missing ? "__unavailable" : action?.type === "shell.run" ? action.scriptId : "";
    scriptArgs = action?.type === "shell.run" ? [...action.args] : [];
    const script = scripts.find(script => script.id === select.value), container = el("script-args");
    container.replaceChildren();
    for (const [index, rule] of (script?.parameters ?? []).entries()) {
      const wrapper = document.createElement("label"), field = rule.kind === "choice" ? document.createElement("select") : document.createElement("input");
      field.id = `script-arg-${index}`; wrapper.textContent = rule.name; wrapper.setAttribute("for", field.id);
      if (rule.kind === "choice") (field as HTMLSelectElement).replaceChildren(new Option("Choose a value", ""), ...rule.choices.map(value => new Option(value, value)));
      else if (rule.kind === "integer") { const number = field as HTMLInputElement; number.type = "number"; number.min = String(rule.min); number.max = String(rule.max); number.step = "1"; }
      else (field as HTMLInputElement).maxLength = rule.maxLength;
      field.value = scriptArgs[index] ?? "";
      field.addEventListener("input", () => { scriptArgs[index] = field.value; updateButton(); });
      field.addEventListener("change", () => { scriptArgs[index] = field.value; updateButton(); });
      container.append(wrapper, field);
      if (rule.kind === "choice") enhanceSelect(field as HTMLSelectElement);
    }
  }
  function macShortcutFields(){
    const action=target()?.action,missing=action?.type==="shortcuts.run"&&!shortcuts.some(item=>item.id===action.shortcutId)?action.shortcutId:undefined;
    el<HTMLSelectElement>("mac-shortcut-select").replaceChildren(new Option("Choose a Mac shortcut",""),...shortcuts.map(item=>new Option(`${item.name} · ${item.id.slice(0,8)}`,item.id)),...(missing?[new Option("Unavailable shortcut — keep existing binding",missing)]:[]));
    input("mac-shortcut-select").value=action?.type==="shortcuts.run"?action.shortcutId:"";
    input("mac-shortcut-timeout").value=String(action?.type==="shortcuts.run"?action.timeoutMs/1000:30);
  }
  function loadFields() {
    clearErrors();
    const button = target(), action = button?.action;
    input("button-name").value = button?.label || ""; input("icon").value = button?.icon || "app";
    input("action-type").value = action?.type || actionContexts.get(selectedKey) || "none";
    input("button-risk").checked=!!button?.requiresConfirmation;
    appPicker.set(apps, action?.type === "app.open" || action?.type === "window.activate" ? action.appId : "");
    windowPicker.set(action?.type === "window.activate" ? action : undefined);
    input("shortcut-key").value = action?.type === "keyboard.shortcut" ? action.key : "KeyK";
    for (const modifier of modifiers)
      input(`modifier-${modifier}`).checked = action?.type === "keyboard.shortcut" ? action.modifiers.includes(modifier) : modifier === "command";
    scriptFields(action);macShortcutFields();workflowEditor.load(); actionFields(); layoutTools.load(); widgetSettings.load();
  }
  function reset(config: Config) {
    layoutTools.reset(); widgetSettings.reset();
    names.clear(); history.length = 0; lastCoalesce = undefined;
    baseline = own(config); baselineJson = JSON.stringify(baseline); draft = own(config); lastJson = baselineJson; baseInstance = instanceId; baseLayoutRevision = config.layoutRevision; baseLayoutName = config.layoutName;
    dirty = false; blocked = false; confirmation = undefined; pendingRemoval = undefined; importing = false; importDoc = undefined;
    if (!selectedWidget()) { selectedKey = ""; popup = false; }
    loadFields();
  }
  function ask(kind: Confirmation) {
    if (!draft || saving || pagesResize) return;
    if (kind === "remove" && !pendingRemoval?.id) return;
    confirmation = kind;
    const doomed = pendingRemoval?.id ? locate(draft, pendingRemoval.id)?.widget : undefined;
    const count = doomed && isPages(doomed) ? doomed.pages.reduce((total, page) => total + page.widgets.length, 0) : 0;
    text("confirm-message", kind === "import" ? "Replace the saved Mac layout with this reviewed import? The current layout will be backed up. No action will run." :
      kind === "remove" ? (doomed && isPages(doomed) ? `Delete this Pages widget, its ${doomed.pages.length} page${doomed.pages.length === 1 ? "" : "s"} and the ${count} component${count === 1 ? "" : "s"} on them? Save to apply.` :
        `Remove “${(doomed && "label" in doomed ? doomed.label : "") || "this component"}”? Save to apply.`) :
      kind === "page" ? "Delete this page and the components on it? Save to apply." :
      kind === "leave" ? "You have unsaved changes. Save them on your Mac, or discard them?" :
      "Discard this draft and load the latest saved layout from the Mac?");
    el("confirm-save").hidden = kind !== "leave"; text("confirm-yes", kind === "leave" ? "Discard changes" : kind === "import" ? "Replace" : kind === "reload" ? "Discard draft" : "Delete");
    options.changed();
    el("layout-confirm").scrollIntoView({ behavior: "auto", block: "nearest" });
    el("confirm-no").focus();
  }
  function leave() {
    layoutTools.reset(); widgetSettings.reset();
    names.clear(); history.length = 0; lastCoalesce = undefined; popup = false; selectedKey = "";
    draft = undefined; baseline = undefined; baselineJson = undefined; dirty = false; blocked = false; confirmation = undefined; pendingRemoval = undefined; importing = false; importDoc = undefined;
    clearErrors(); options.changed();
  }
  function errorAt(componentId: string, field: string, value: string): false {
    selectedKey = componentId; loadFields();
    popup = !!selected(); if (popup) popupId = componentId;
    options.changed();
    input(field).setAttribute("aria-invalid", "true"); text("field-error", value); message("Please check the highlighted field.");
    input(field).focus(); return false;
  }
  function validate(): boolean {
    if (!draft) return false;
    if (!layoutTools.validate()) {
      if (selected() && !popup) { popup = true; popupId = selectedKey; options.changed(); input("icon-image-file").focus(); }
      return false;
    }
    for (const page of draft.widgets.flatMap(widget => isPages(widget) ? widget.pages : [])) {
      try { page.name = label(page.name); }
      catch { message("A page name must contain 1–40 characters and no control characters."); return false; }
    }
    for (const button of allComponents(draft)) {
      try { button.label = label(button.label); }
      catch { return errorAt(button.id, "button-name", "Button name must contain 1–40 characters and no control characters."); }
      try { button.icon = icon(button.icon); }
      catch { return errorAt(button.id, "icon", "Choose a built-in icon."); }
      if (button.color !== undefined) button.color = buttonColor(button.color);
      if (button.appearance) {
        try { button.appearance = parseAppearance(button.appearance); }
        catch (error) { return errorAt(button.id, button.appearance.glyph?.type === "image" ? "icon-image-file" : "icon-text", (error as Error).message); }
      }

      if (button.action) {
        try { button.action = parseAction(button.action); }
        catch { const type=button.action.type;if(type==="window.activate"&&button.action.path!==undefined&&button.action.title)return errorAt(button.id,"window-path","Use a full folder path such as /Users/me/Documents.");return errorAt(button.id,type==="window.activate"?"window-title":type==="app.open"?"app-select":type==="shell.run"?"script-select":type==="shortcuts.run"?"mac-shortcut-select":type==="workflow.run"?"workflow-select":"shortcut-key",type==="window.activate"?"Choose a Mac application and a window title of 1–256 characters.":type==="app.open"?"Choose an installed Mac application.":"Choose an action and complete its settings."); }
        const action = button.action;
        if ((action.type === "app.open" || action.type === "window.activate") && !apps.some(app => app.id === action.appId)) {
          const previous = !importing ? (baseline ? findComponent(baseline, button.id) : undefined)?.action : undefined;
          if (!((previous?.type === "app.open" || previous?.type === "window.activate") && JSON.stringify(previous) === JSON.stringify(action)))
            return errorAt(button.id, "app-select", "Choose an installed Mac application.");
        }
        if(action.type==="shortcuts.run"&&!shortcuts.some(item=>item.id===action.shortcutId)){
          const previous=!importing ? (baseline ? findComponent(baseline, button.id) : undefined)?.action : undefined;
          if(JSON.stringify(previous)!==JSON.stringify(action))return errorAt(button.id,"mac-shortcut-select","Choose an available Mac shortcut.");
        }
        if (action.type === "shell.run") {
          const script = scripts.find(script => script.id === action.scriptId && script.version === action.version);
          const previous = !importing ? (baseline ? findComponent(baseline, button.id) : undefined)?.action : undefined;
          if (!script && JSON.stringify(previous) !== JSON.stringify(action))
            return errorAt(button.id, "script-select", "Approve this script on the Mac, then select its approved version.");
          if (script) {
            try { validateShellArguments(script.parameters, action.args); }
            catch { return errorAt(button.id, "script-select", "Fill in all parameters using their approved rules."); }
          }
        }
      }
    }
    const workflowError=workflowEditor.validate(importing ? undefined : baseline);
    if(workflowError){
      if (selected() && !popup) { popup = true; popupId = selectedKey; options.changed(); }
      text("field-error",workflowError);message("Check workflow settings before saving.");return false;
    }
    return true;
  }
  function fixPagesSize() {
    const id = widgetSettings.firstInvalidId;
    if (!id || !draft || !locate(draft, id)) return;
    selectedKey = id; popup = true; popupId = id; loadFields(); options.changed();
    widgetSettings.focusInvalid();
  }
  el("pages-fix-invalid").addEventListener("click", fixPagesSize);
  async function save(confirmedImport = false) {
    if (pagesResize) return;
    if (widgetSettings.invalid) { fixPagesSize(); return; }
    if (!draft || !dirty || saving || !available || blocked || widgetSettings.invalid || !validate()) return;
    if (importing && !confirmedImport) { ask("import"); return; }
    saving = true; confirmation = undefined; message("Saving…"); options.changed();
    try {
      const saved = await options.save(parseConfig(draft), { ...baseline!, ...(baseLayoutRevision !== undefined ? { layoutRevision: baseLayoutRevision } : {}) }, importing ? importDoc : undefined);
      // The caller may already know a newer revision than this save acknowledgment.
      const open = popup ? selectedKey : "";
      reset(saved); message("Saved on your Mac.");
      if (open && selectedWidget()) { selectedKey = open; popup = true; loadFields(); }
      return saved;
    } catch (error) {
      blocked = !(error instanceof Fault) || error.code === "CONFIG_CONFLICT" || error.status >= 500;
      message(error instanceof Fault && error.code === "CONFIG_CONFLICT" ?
        "Configuration changed on the Mac. Your draft was kept. Load latest before editing again; nothing was overwritten." :
        `${(error as Error).message}${blocked ? " Your draft was kept. Load latest to check the saved layout before trying again." : ""}`);
    } finally { saving = false; options.changed(); }
  }
  async function submit() {
    if (!draft || saving) return;
    await save();
  }
  async function confirm() {
    if (!draft || saving || !confirmation) return;
    const kind = confirmation, removal = pendingRemoval; confirmation = undefined; pendingRemoval = undefined;
    if (kind === "import") { await save(true); return; }
    if (kind === "leave") { leave(); return; }
    if (kind === "reload") {
      saving = true; options.changed();
      try {
        const config = await options.reload();
        if (config) { reset(config); message("Latest saved layout loaded."); }
        else message("Could not load the Mac layout. Your draft was kept. Reconnect and try again.");
      } finally { saving = false; options.changed(); }
      return;
    }
    if (kind === "page" && removal?.pagesId && removal.pageId) { removePageNow(removal.pagesId, removal.pageId); return; }
    if (removal?.id) removeNow(removal.id);
  }
  // ---- removing, with Undo ----
  function removeNow(id: string) {
    if (!draft || saving || !locate(draft, id)) return;
    draft = removeWidget(draft, id);
    if (selectedKey === id || !selectedWidget()) { selectedKey = ""; popup = false; }
    loadFields(); changed();
  }
  function removeComponent(id: string) {
    if (!draft || saving || pagesResize) return;
    const found = locate(draft, id)?.widget; if (!found) return;
    if (isPages(found)) { pendingRemoval = { id }; ask("remove"); return; }
    removeNow(id);
  }
  function removePageNow(pagesId: string, pageId: string) {
    if (!draft || saving) return;
    try { draft = removePage(draft, pagesId, pageId); } catch (error) { message((error as Error).message); options.changed(); return; }
    if (!selectedWidget()) { selectedKey = ""; popup = false; }
    loadFields(); changed();
  }
  function pageOperation(operation: (config: Config) => Config | { config: Config }, id?: string) {
    if (!draft || saving || pagesResize) return false;
    try {
      const result = operation(draft), next = "config" in result ? result.config : result;
      applyDraft(next, id ?? selectedKey); return true;
    } catch (error) { message((error as Error).message); options.changed(); return false; }
  }
  // ---- the component library (T63): everything goes straight into the draft ----
  const newId = () => `button-${crypto.randomUUID()}`;
  type Where = { container: Container; index: number } | { tab: { pagesId: string; pageId: string } } | { replace: string };
  type NewWidget = Parameters<typeof addWidget>[1];
  function buildSpec(spec: LibrarySpec): NewWidget {
    const tier = spec.tier ?? "S";
    if (spec.type === "key") return { id: newId(), kind: "key", size: tier, label: spec.label ?? "New button", icon: "app", action: spec.action ?? null, ...(spec.action ? { appearance: { glyph: { type: "app" as const } } } : {}) };
    if (spec.type === "pages") {
      const preset = spec.preset ? PAGES_PRESETS[spec.preset] : undefined;
      return { id: `pages-${crypto.randomUUID()}`, kind: "pages", pages: [{ id: `page-${crypto.randomUUID()}`, name: "Page 1", widgets: [] }],
        ...(preset ? { size: JSON.parse(JSON.stringify(preset.size)) as PagesSize, columns: { ...preset.columns } } : {}) };
    }
    const kind = spec.type as "clock" | "text" | "refresh" | "codex-usage" | "claude-usage";
    if (kind === "clock") return { id: `widget-${crypto.randomUUID()}`, kind, size: "M", form: "time" };
    const form = spec.form ?? "panel";
    return { id: `widget-${crypto.randomUUID()}`, kind, size: tier, form, ...(kind === "text" ? { text: "Text" } : {}) } as NewWidget;
  }
  function putIn(widget: NewWidget, where?: Where): string | undefined {
    if (!draft) return "Nothing to add to.";
    try {
      let next: Config;
      if (!where) next = addWidget(draft, widget, options.container()).config;
      else if ("tab" in where) {
        const ref: Container = { pagesId: where.tab.pagesId, pageId: where.tab.pageId };
        next = addWidgetAt(draft, widget, ref, containerWidgets(draft, ref).length);
      } else if ("replace" in where) next = replaceBlank(draft, widget as Widget, where.replace);
      else next = addWidgetAt(draft, widget, where.container, where.index);
      const id = (widget as { id: string }).id, kind = (widget as { kind: string }).kind;
      draft = next;
      const open = kind === "key" && !("action" in widget && widget.action);
      selectedKey = open ? id : ""; popup = open; if (open) popupId = id;
      loadFields(); changed();
      return undefined;
    } catch (error) { return error instanceof Fault ? error.message : "This size does not fit here."; }
  }
  // Adds a library card at the insertion boundary, or appends to the current page (Pages to the canvas).
  function addNew(spec: LibrarySpec, where?: Where): string | undefined {
    if (!draft || saving || pagesResize) return "Finish the current layout change first.";
    const problem = putIn(buildSpec(spec), where);
    if (!problem && spec.editAction) { actionContexts.set(selectedKey, spec.editAction); input("action-type").value = spec.editAction; actionFields(); scriptFields(); macShortcutFields(); workflowEditor.load(); }
    return problem;
  }
  // ---- T57: export and import of one component (ADR-062). Nothing here saves or runs anything; an import only changes the draft. ----
  let pendingItem: ItemFile | undefined;
  async function fileIssues(layout: Config): Promise<string[]> {
    if (!available) return ["Not connected to the Mac: apps, scripts and shortcuts were not checked."];
    try { return await options.bindings(layout); } catch { return ["The Mac could not check this file: apps, scripts and shortcuts were not checked."]; }
  }
  el("export-item").addEventListener("click", () => {
    const button = selected(); if (!draft || !button) return;
    try {
      const name = itemFileName(button.label); downloadJson(exportItemFile(draft, button.id), name);
      message(`Exported as ${name}. Unsaved edits in the draft are included.`);
    } catch (error) { message(`Could not export: ${(error as Error).message}`); }
  });
  // A component file is read and checked here; T63's library adds it to the draft with place().
  async function inspectFile(file: { size: number; arrayBuffer: () => Promise<ArrayBuffer> }) {
    let parsed: ItemFile;
    try { parsed = parseItemFile(await readJsonFile(file)); } catch (error) { throw new Error(`File rejected: ${(error as Error).message}`); }
    const issues = await fileIssues(itemFileLayout(parsed));
    pendingItem = parsed;
    return { info: itemInfo(parsed), issues };
  }
  function placeFile(size?: SizeTier): string | undefined {
    if (!draft || saving || !pendingItem) return "Nothing to add to.";
    try {
      const planned = planItemImport(draft, options.container(), pendingItem, size);
      draft = planned.config; selectedKey = planned.button.id;
      popup = true; popupId = selectedKey;
      loadFields(); changed();
      message(`Added “${planned.button.label}” to the draft. Save to apply it.`);
    } catch (error) { return (error as Error).message; }
    return undefined;
  }
  // Opens Edit mode, and with `create` the card of the widget `id` (a click on a component in Edit, or a long press on it in Use mode).
  function startEditing(id = "", create = false) {
    if (saving || pagesResize || !latest) return;

    if (!draft) {
      selectedKey = ""; popup = false; reset(latest); message("Editing. Tap a component to change it.");
      const found = id ? locate(draft!, id)?.widget : undefined;
      selectedKey = found?.id ?? ""; loadFields();
    } else { selectedKey = id; confirmation = undefined; pendingRemoval = undefined; loadFields(); }
    if (create && selectedWidget()) { popup = true; popupId = selectedKey; }
    options.changed();
  }
  el<HTMLSelectElement>("icon").replaceChildren(...Object.entries(icons).map(([value, name]) => new Option(name, value)));
  // "None" comes first (T43): no fill color, the key sits on the dark key body. It is a layout v8 feature, so choosing it raises the draft's
  // format, and choosing a color again lets the format settle back to what the draft needs.
  for (const color of ["none", ...keyColors] as const) {
    const button = document.createElement("button"); button.type = "button"; button.className = "color-swatch";
    button.dataset.color = color; button.setAttribute("aria-label", color === "none" ? "None, no key color" : `${color[0]!.toUpperCase()}${color.slice(1)} key color`); button.title = color === "none" ? "None" : color;
    button.addEventListener("click", () => {
      const selectedButton = selected();
      if (!selectedButton || saving) return;
      selectedButton.color = color; if (selectedButton.appearance) delete selectedButton.appearance.tint;
      layoutTools.load(); changed();
    });
    colorButtons.set(color, button); el("color-options").append(button);
  }
  const actions: [string, string, SymbolName][] = [["app.open", "Open app", "app-window"], ["window.activate", "Activate window", "monitor"],
    ["keyboard.shortcut", "Shortcut", "command"], ["shell.run", "Shell script", "code"], ["shortcuts.run", "Mac shortcut", "play"], ["workflow.run", "Workflow", "play"]];
  for (const [value, name, symbol] of actions) {
    const button = document.createElement("button"), glyph = document.createElement("span"), caption = document.createElement("span");
    button.type = "button"; button.className = "action-choice"; button.dataset.actionType = value;
    glyph.className = "ui-icon"; setIcon(glyph, symbol); caption.textContent = name; button.append(glyph, caption);
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      if (!selected() || saving) return;
      input("action-type").value = value; updateButton();
      if (value === "shell.run") scriptFields();
      if (value === "shortcuts.run") macShortcutFields();
      if (value === "workflow.run") workflowEditor.load();
      if (value === "app.open" || value === "window.activate") {
        // A key or item with no app yet opens the App picker straight away; closing it without a pick leaves the app empty.
        const key = target();
        if (key && !appPicker.value) appPicker.open(); else input("app-select").focus();
      }
    });
    actionButtons.set(value, button); el("action-options").append(button);
  }
  el("clear-action").addEventListener("click", () => { if (selected() && !saving) { input("action-type").value = "none"; updateButton(); } });
  el<HTMLSelectElement>("shortcut-key").replaceChildren(...keyboardKeys.map(key => new Option(keyLabel(key), key)));
  // The Use | Edit switch is a widget (T44); it asks through these two. Done asks first when there is a draft: save it, or discard it.
  function requestEdit() { if (!draft) startEditing(); }
  function requestUse() {
    if (saving || pagesResize || !draft) return;
    if (dirty) ask("leave"); else leave();
  }
  el("reload-layout").addEventListener("click", () => ask("reload"));
  el("editor-close").addEventListener("click", closeCard);
  el("edit-undo").addEventListener("click", undo);
  function updateButton(coalesce?: string) {
    const button = target(); if (!button || saving) return;
    const before: string | undefined = button.action?.type, wasConfigured = !!button.action;
    button.label = input("button-name").value;
    button.icon = input("icon").value as Component["icon"];
    if(input("button-risk").checked)button.requiresConfirmation=true;else delete button.requiresConfirmation;
    const type = input("action-type").value;
    button.action = type === "none" ? null : type === "workflow.run" ? {type:"workflow.run",workflowId:input("workflow-select").value} : type === "keyboard.shortcut" ? {
      type, key: input("shortcut-key").value, modifiers: modifiers.filter(modifier => input(`modifier-${modifier}`).checked),
    } : type === "shortcuts.run" ? {type:"shortcuts.run",shortcutId:input("mac-shortcut-select").value,timeoutMs:Math.round(Number(input("mac-shortcut-timeout").value)*1000)} : type === "shell.run" ? (() => {
      const script = scripts.find(script => script.id === input("script-select").value);
      if (!script && button.action?.type === "shell.run" && input("script-select").value === "__unavailable") return button.action;
      return { type: "shell.run" as const, scriptId: script?.id || "", version: script?.version || "", args: (script?.parameters ?? []).map((_, index) => scriptArgs[index] ?? "") };
    })() : type === "window.activate" ? {type: "window.activate", appId: appPicker.value, title: windowPicker.title, match: windowPicker.match, ...(windowPicker.path ? {path: windowPicker.path} : {})} : { type: "app.open", appId: appPicker.value };
    if (before !== "app.open" && before !== "window.activate" && (button.action?.type === "app.open" || button.action?.type === "window.activate") && button.icon === "app" && !button.appearance) {
      button.appearance = {glyph:{type:"app"}};
    }
    actionContexts.set(selectedKey, type);
    try { if (button.action) button.action = parseAction(button.action); } catch { if (!wasConfigured) button.action = null; }
    automaticName(); actionFields(); layoutTools.load(); changed(coalesce);
  }
  input("icon").addEventListener("change", () => {
    const button = selected(); if (!button || saving) return;
    button.icon = input("icon").value as Component["icon"];
    // A deliberate generic selection must not be mistaken for a legacy default.
    if (button.icon === "app") { button.appearance = {...button.appearance, glyph:{type:"builtin"}}; }
    else if (button.appearance) delete button.appearance.glyph;
  });
  input("button-name").addEventListener("input", () => {
    const button = target(); if (!button || saving) return;
    names.set(nameKey(), {manual:true});
  });
  input("script-select").addEventListener("change", () => {
    scriptArgs = []; updateButton(); scriptFields();
  });
  for (const id of ["button-name", "button-risk", "icon", "action-type", "shortcut-key", "mac-shortcut-select", "mac-shortcut-timeout", ...modifiers.map(modifier => `modifier-${modifier}`)]) {
    input(id).addEventListener("input", () => updateButton(id === "button-name" ? "name" : undefined));
    if (id !== "button-name") input(id).addEventListener("change", () => updateButton());
  }
  el("config-form").addEventListener("submit", event => { event.preventDefault(); void submit(); });
  el("delete-button").addEventListener("click", () => { const id = selectedKey; if (id) removeComponent(id); });
  el("confirm-yes").addEventListener("click", () => { void confirm(); });
  el("confirm-save").addEventListener("click", () => { confirmation = undefined; void save().then(saved => { if (saved) leave(); }); });
  el("confirm-no").addEventListener("click", () => { confirmation = undefined; pendingRemoval = undefined; options.changed(); });
  el("test-key").addEventListener("click", () => { if (canTest()) options.test(selected()!.id, draft!.revision); });
  // Text fields keep their own undo; elsewhere Esc is Done and Ctrl/Cmd+Z is Undo.
  const inField = (node: unknown) => { const tag = (node as { tagName?: string } | null | undefined)?.tagName?.toLowerCase(); return tag === "input" || tag === "textarea" || tag === "select" || (node as { isContentEditable?: boolean } | null | undefined)?.isContentEditable === true; };
  const dialogOpen = () => layoutTools.modalOpen || (document.getElementById("shelf-windows") as HTMLDialogElement | null)?.open === true || document.getElementById("shelf-app-menu")?.hidden === false || appDialogOpen() || (document.getElementById("theme-dialog") as HTMLDialogElement | null)?.open === true ||
    (document.getElementById("refresh-dialog") as HTMLDialogElement | null)?.open === true || document.getElementById("risk-confirm")?.hidden === false;
  window.addEventListener("keydown", event => {
    if (!draft || dialogOpen()) return;
    const key = event.key.toLowerCase();
    if (pagesResize) { if ((event.metaKey || event.ctrlKey) && ["s", "z"].includes(key)) event.preventDefault(); return; }
    if ((event.metaKey || event.ctrlKey) && key === "s") { event.preventDefault(); void submit(); return; }
    if ((event.metaKey || event.ctrlKey) && key === "z" && !event.shiftKey && !inField(event.target)) { event.preventDefault(); undo(); return; }
    if (event.key === "Escape" && !event.defaultPrevented && !inField(event.target)) {
      event.preventDefault();
      if (confirmation) { confirmation = undefined; pendingRemoval = undefined; options.changed(); return; }
      requestUse();
    }
  });
  const api = {
    get active() { return !!draft; }, get saving() { return saving; }, get view() { return draft; }, get selectedId() { return popup ? selectedKey : ""; },
    get dirty() { return dirty; }, get resizing() { return !!pagesResize; }, get refreshBlocked() { return saving || layoutTools.uploading || !!pagesResize; },
    discardDraft() { if (!saving && !layoutTools.uploading && !pagesResize) leave(); },
    get canTest() { return canTest(); }, get loaded() { return !!latest; }, startEditing, requestEdit, requestUse,
    // The library: a card clicked (append) or dropped (insertion boundary).
    addNew, addDropped(spec: LibrarySpec, target: Where | undefined) { return target ? addNew(spec, target) : "Drop it on the canvas or on a page of a Pages widget."; },
    // The draft changes by a tool or a move; submit saves it.
    refitCard() { cardMover.refit(); },
    applyDraft, submit, undo, removeComponent, closeCard, beginPagesResize, previewPagesResize, endPagesResize,
    // Pages of a Pages widget (the "+", the page menu and the card's list).
    addPageTo(pagesId: string) { return pageOperation(config => addPage(config, pagesId), pagesId); },
    removePageFrom(pagesId: string, pageId: string) {
      if (!draft || saving) return;
      const widget = locate(draft, pagesId)?.widget;
      if (!widget || !isPages(widget)) return;
      if (widget.pages.length <= 1) { message("The last page cannot be deleted."); options.changed(); return; }
      if (widget.pages.find(page => page.id === pageId)?.widgets.length) { pendingRemoval = { pagesId, pageId }; ask("page"); return; }
      removePageNow(pagesId, pageId);
    },
    movePageIn(pagesId: string, pageId: string, step: -1 | 1) { return pageOperation(config => movePage(config, pagesId, pageId, step), pagesId); },
    renamePageIn(pagesId: string, pageId: string) { api.selectComponent(pagesId); widgetSettings.focusPage(pageId); },
    // A component file chosen in Edit: read and checked, then placed in the draft (the library calls these).
    inspectFile, placeFile,
    get isSaving() { return saving; }, get canSave() { return available && !blocked && !layoutTools.uploading && !widgetSettings.invalid && !pagesResize; },
    // `candidate` is the view of the layout the import will show, `document` the whole reviewed document it came from (the save sends that, with the draft's edits folded in).
    importDraft(candidate: Config, document: ConfigDocument, stamp: string) {
      if (!latest || saving || pagesResize || !available) return false;
      if (!/^[a-f0-9]{64}$/.test(stamp)) return false;
      layoutTools.reset(); widgetSettings.reset(); names.clear(); history.length = 0;
      baseline = own(latest); baselineJson = JSON.stringify(baseline); draft = parseConfig({ ...own(candidate), revision: latest.revision }); lastJson = JSON.stringify(draft);
      baseInstance = instanceId; baseLayoutRevision = latest.layoutRevision; baseLayoutName = latest.layoutName; importDoc = { document, stamp }; importing = true; blocked = false; dirty = true; confirmation = undefined;
      selectedKey = ""; popup = false; loadFields();
      message("Imported draft only. Rebind unavailable targets, then Save and confirm replacement."); options.changed(); return true;
    },
    receive(config: Config, catalog: AppInfo[], instance: string, scriptCatalog: ScriptInfo[] = [],shortcutCatalog:ShortcutInfo[] = []) {
      const appsChanged = JSON.stringify(apps) !== JSON.stringify(catalog);
      const catalogChanged = JSON.stringify(scripts) !== JSON.stringify(scriptCatalog), shortcutsChanged=JSON.stringify(shortcuts)!==JSON.stringify(shortcutCatalog);
      latest = config; apps = catalog; instanceId = instance;
      scripts = scriptCatalog;shortcuts=shortcutCatalog;
      if (draft && !dirty && !saving && !pagesResize && isBehind()) reset(config);
      else if(draft){if(appsChanged)appPicker.refresh(apps);if(catalogChanged)scriptFields();if(shortcutsChanged)macShortcutFields();if(appsChanged||catalogChanged||shortcutsChanged)workflowEditor.load();}
    },
    // T94: this page's own theme change raised the layout's revision (and nothing else): the draft's base moves with it, unless it was already behind for another reason.
    adoptLayoutRevision(from: number, to: number) { if (!importing && baseLayoutRevision === from) baseLayoutRevision = to; },
    // A tap on a component in Edit opens its settings card. `open` is false when it is only being selected, for example by Retry in the activity list.
    selectComponent(id: string, open = true) {
      const target = draft ? locate(draft, id)?.widget : undefined;
      // A blank has nothing to configure (ADR-083): it can only be dragged, dropped on or removed.
      if (!draft || saving || pagesResize || !target || isBlank(target)) return;
      selectedKey = id; confirmation = undefined; pendingRemoval = undefined;
      if (open) { popup = true; popupId = id; cardMover.expand(); }
      loadFields(); options.changed();
    },
    // Nothing is selected (a tap on empty canvas): an open card closes; a tap that opened nothing changes nothing.
    deselect() { if (!draft || (!selectedKey && !popup)) return; closeCard(); },
    // The card steps aside without any draft rule (used before a confirmation prompt covers the page).
    dismissPopup() { if (popup) { popup = false; options.changed(); focusTile(popupId); } },
    get cardOpen() { return popup && !!selectedWidget(); },
    // Called before the library or the menu asks for the current selection's card rules.
    get tiersOfSelected() { const widget = selectedWidget(); return widget && !isPages(widget) ? tiersFor(widget.kind, "form" in widget ? widget.form : undefined) : []; },
    render(canSave: boolean, allowTest: boolean) {
      available = canSave; testAvailable = allowTest;
      const size = el<HTMLSelectElement>("grid-size"); size.disabled = !draft || saving || !!pagesResize;
      el<HTMLButtonElement>("edit-back").disabled = !!pagesResize;
      el<HTMLButtonElement>("shelf-toggle").disabled = !!pagesResize;
      if (draft) size.value = draft.gridSize;
      if (!draft) { popup = false; syncCard(); return; }
      const widget = selectedWidget();
      if (!widget) popup = false;
      const button = selected(), pagesView = !!widget && isPages(widget), displayView = !!widget && !button && !pagesView;

      el("widget-order").hidden = !widget;
      const ref = widget ? containerOf(draft, widget.id)! : {}, list = widget ? containerWidgets(draft, ref) : [], at = list.findIndex(entry => entry.id === widget?.id);
      for (const name of ["first", "earlier", "later", "last"]) el<HTMLButtonElement>(`order-${name}`).disabled = saving || at < 0 || (name === "first" || name === "earlier" ? at === 0 : at === list.length - 1);
      const holder = target();
      const typeName = widget ? ({ clock: "Clock", text: "Text", refresh: "Refresh" } as Record<string, string>)[widget.kind] : undefined;
      text("editor-title", button ? "Key" : pagesView ? "Pages" : typeName ?? "");
      text("editor-sub", button ? button.label : pagesView ? "Adjust each axis · scroll each page" : "");
      text("action-note", actionNote(holder));
      text("label-count", `${Array.from(holder?.label || "").length}/40`);
      const iconSection = el("key-icon-section"), iconHost = el("main-icon-host");
      if (iconSection.parentNode !== iconHost) iconHost.append(iconSection);
      const look = button ? appearance(button) : { symbol: "plus" as const, color: "blue" as const, shown: "blue" as const };
      for (const [color, node] of colorButtons) node.setAttribute("aria-pressed", String(color === look.shown));
      el("save-message").dataset.dirty = String(dirty);
      const stale = isStale();
      el("pages-invalid-warning").hidden = !widgetSettings.invalid;
      el("pages-fix-invalid").hidden = !widgetSettings.invalid;
      el("layout-warning").hidden = !stale && !blocked;
      text("layout-warning", stale ? "The Mac layout changed. Your draft keeps its original revision; load latest to start again." :
        "The save could not be confirmed. Load latest before making another save.");
      el<HTMLFieldSetElement>("editor-fields").disabled = saving || !!pagesResize;
      appPicker.setDisabled(saving || !["app.open", "window.activate"].includes(input("action-type").value));
      windowPicker.setDisabled(saving || !available || input("action-type").value !== "window.activate");
      el("button-fields").hidden = !button;
      el("key-appearance").hidden = !button; el("delete-button").hidden = !widget;
      text("delete-button", pagesView ? "Delete this Pages widget" : button ? "Remove this key" : "Remove this component");
      text("export-item", "Export this key…"); el("export-item").hidden = !button;
      el<HTMLButtonElement>("delete-button").disabled = saving || !widget;
      // The floating Edit area: Save appears with a change, Undo with something to undo, and Load latest when the Mac moved on or a save failed.
      el<HTMLButtonElement>("desk-save").hidden = !dirty;
      el<HTMLButtonElement>("desk-save").disabled = saving || !!pagesResize || layoutTools.uploading || !dirty || !available || blocked || widgetSettings.invalid;
      el<HTMLButtonElement>("edit-undo").disabled = saving || !!pagesResize || (!history.length && !widgetSettings.invalid);
      el<HTMLButtonElement>("reload-layout").hidden = !blocked && !stale;
      el<HTMLButtonElement>("reload-layout").disabled = saving || !available;
      el("test-key").hidden = !button;
      el<HTMLButtonElement>("test-key").disabled = !canTest();
      el("test-key").title = dirty ? "Save before testing this key" : "Run this saved key once on your Mac";
      el("more-settings").hidden = !button && !widget;
      el("layout-confirm").hidden = !confirmation;
      layoutTools.renderSize(); widgetSettings.render(displayView, pagesView, saving);
      syncCard();
    },
  };
  return api;
}
