import { FINDER_APP_ID, parseWindows, windowChoices, type WindowAction, type WindowInfo, type WindowChoice } from "../../packages/contracts/index.js";
import { enhanceSelect } from "./select-menu.js";

interface Options {
  appId: () => string;
  load: (id: string) => Promise<WindowInfo[]>;
  changed: () => void;
  discoveryFirst?: boolean;
}
// Discovery is explicit and read-only. Replies from a previous app/key never change the current draft.
export function createWindowPicker(parent: HTMLElement, prefix: string, options: Options) {
  const title = document.createElement("input"), match = document.createElement("select"),
    read = document.createElement("button"), choices = document.createElement("select"), status = document.createElement("p"), note = document.createElement("p");
  // T100 (ADR-090): a Finder key also keeps the folder its tab shows, so the Mac can open the folder when no tab shows it.
  const path = document.createElement("input"), pathLabel = document.createElement("label"), pathNote = document.createElement("p");
  let serial = 0, disabled = false, reading = false, windows: WindowChoice[] = [];
  function field(caption: string, node: HTMLElement, suffix: string) {
    const label = document.createElement("label"); node.id = prefix + suffix; label.htmlFor = node.id; label.textContent = caption; parent.append(label, node);
  }
  title.type = "text"; title.maxLength = 256; title.placeholder = "e.g. Win11X99";
  match.replaceChildren(new Option("Exactly matches", "exact"), new Option("Contains", "contains"));
  read.type = "button"; read.id = prefix + "-read"; read.className = "quiet"; read.textContent = "Read open windows";
  if (options.discoveryFirst) {
    parent.append(read); field("Choose an open window", choices, "-choices");
    field("Window title", title, "-title");
    const advanced = document.createElement("details"), summary = document.createElement("summary");
    advanced.className = "design-details"; summary.textContent = "Title matching options"; advanced.append(summary); parent.append(advanced);
    const label = document.createElement("label"); label.textContent = "Title matching"; match.id = prefix + "-match"; label.htmlFor = match.id; advanced.append(label, match);
  } else {
    field("Window title", title, "-title"); field("Title matching", match, "-match");
    parent.append(read); field("Choose an open window (optional)", choices, "-choices");
  }
  path.type = "text"; path.maxLength = 1024; path.id = prefix + "-path"; path.placeholder = "/Users/me/Documents"; path.spellcheck = false; path.autocomplete = "off";
  pathLabel.htmlFor = path.id; pathLabel.textContent = "Folder";
  pathNote.className = "field-note"; pathNote.textContent = "Filled when you choose a read Finder window. If no Finder tab shows this folder, the Mac opens it.";
  parent.append(pathLabel, path, pathNote);
  status.id = prefix + "-status"; status.className = "field-note"; status.setAttribute("role", "status");
  note.className = "field-note"; note.textContent = "Case-sensitive. Only one window may match. The app and window must already be open; this does not start a remote connection. For Windows App, a session that is not connected opens the Connection Center instead. A Finder key with a folder opens that folder when no tab shows it.";
  parent.append(status, note);
  const finder = () => options.appId() === FINDER_APP_ID;
  function render() {
    title.disabled = disabled; match.disabled = disabled; read.disabled = disabled || reading || !options.appId(); choices.disabled = disabled || !windows.length;
    path.disabled = disabled; pathLabel.hidden = path.hidden = pathNote.hidden = !finder();
  }
  function clear() { serial++; reading = false; windows = []; choices.replaceChildren(new Option("Read windows to choose, or enter a title", "")); status.textContent = ""; render(); }
  title.addEventListener("input", () => { choices.value = ""; options.changed(); });
  match.addEventListener("change", options.changed);
  path.addEventListener("input", () => { choices.value = ""; options.changed(); });
  choices.addEventListener("change", () => {
    const choice = windows[Number(choices.value)], item = choice?.window;
    if (disabled || choices.value === "" || !item || choice.ambiguous) return;
    title.value = item.title; match.value = "exact"; if (finder()) path.value = item.path ?? ""; options.changed();
  });
  read.addEventListener("click", async () => {
    if (disabled || reading || !options.appId()) return;
    const id = options.appId(), ticket = ++serial; reading = true; status.textContent = "Reading this application's windows…"; render();
    try {
      const result = parseWindows(await options.load(id));
      if (ticket !== serial || id !== options.appId() || disabled || !parent.isConnected) return;
      windows = windowChoices(id, result);
      choices.replaceChildren(new Option("Choose a window to fill its title", ""), ...windows.map(({window: item, ambiguous, folder}, index) => {
        const option = new Option(`${item.title}${folder ? ` · ${folder}` : ""}${ambiguous ? " · duplicate title" : item.minimized ? " · minimized" : ""}`, String(index));
        option.disabled = ambiguous; return option;
      }));
      status.textContent = windows.length ? `${windows.length} open window(s). Reading did not activate or save anything. Duplicate titles need a more specific rule.` : "No named windows found. Open the target window on the Mac, then read again.";
      if (finder() && windows.length && windows.every(item => item.folder === undefined))
        status.textContent += " Finder folders could not be read: allow Keyln to control Finder on the Mac (System Settings › Privacy & Security › Automation), then read again.";
    } catch (error) {
      if (ticket === serial && id === options.appId() && !disabled) status.textContent = (error as Error).message || "Could not read windows from the Mac.";
    } finally { if (ticket === serial) { reading = false; render(); } }
  });
  clear();
  enhanceSelect(match); enhanceSelect(choices);
  return {
    get title() { return title.value; }, get match() { return match.value as WindowAction["match"]; },
    // Only a Finder key has a folder; an empty field is none.
    get path() { return finder() && path.value.trim() ? path.value.trim() : undefined; },
    set(action?: WindowAction) { clear(); title.value = action?.title ?? ""; match.value = action?.match ?? "exact"; path.value = action?.path ?? ""; render(); },
    appChanged() { clear(); title.value = ""; path.value = ""; render(); },
    setDisabled(value: boolean) { if (value && !disabled) clear(); disabled = value; render(); },
  };
}
