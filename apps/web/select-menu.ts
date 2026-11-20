// T41: a styled menu for the <select> fields of Edit. Native dropdowns look poor on Windows Edge with touch, and cannot be styled by the themes.
// The native <select> stays in the document, visually hidden, and remains the source of truth: code and tests keep reading and writing
// .value, .options and change events. A button shows the chosen option; opening it shows a listbox in the top layer (Popover API, with a
// fixed-position fallback), under or over the button by the room there is, or a bottom sheet on a phone (600px and below).
type Popover = HTMLElement & { showPopover?: () => void; hidePopover?: () => void };
// The button of each enhanced select, so enhancing the same select twice gives the same button.
const buttons = new WeakMap<HTMLSelectElement, HTMLButtonElement>();
let counter = 0;

function descriptorOf(target: object, name: string): PropertyDescriptor | undefined {
  for (let node: object | null = target; node; node = Object.getPrototypeOf(node)) {
    const found = Object.getOwnPropertyDescriptor(node, name); if (found) return found;
  }
  return undefined;
}
// Setting .value, .selectedIndex or .disabled from code does not raise an event, so each is wrapped on the instance to refresh the button.
function mirror(select: HTMLSelectElement, name: "value" | "selectedIndex" | "disabled", after: () => void) {
  const found = descriptorOf(select, name); if (!found) return;
  let stored: unknown = found.value;
  Object.defineProperty(select, name, {
    configurable: true, enumerable: true,
    get(this: HTMLSelectElement) { return found.get ? found.get.call(this) : stored; },
    set(this: HTMLSelectElement, next: unknown) { if (found.set) found.set.call(this, next); else stored = next; after(); },
  });
}
const optionsOf = (select: HTMLSelectElement): HTMLOptionElement[] => Array.from((select.options ?? select.children ?? []) as ArrayLike<HTMLOptionElement>);
function chosenIndex(select: HTMLSelectElement, options: HTMLOptionElement[]): number {
  if (typeof select.selectedIndex === "number") return select.selectedIndex;
  return options.findIndex(option => option.value === select.value);
}

// Returns the button, or undefined where the page cannot hold one (no parent, or a minimal DOM): the native select is then left as it was.
export function enhanceSelect(select: HTMLSelectElement): HTMLButtonElement | undefined {
  const known = buttons.get(select); if (known) return known;
  if (!select.parentNode || typeof select.after !== "function" || typeof document.createElement !== "function") return undefined;
  const number = ++counter;
  if (!select.id) select.id = `select-${number}`;
  const button = document.createElement("button"), value = document.createElement("span"), chevron = document.createElement("span");
  button.type = "button"; button.id = `${select.id}-button`; button.className = "select-button";
  value.className = "select-value"; chevron.className = "select-chevron"; chevron.setAttribute("aria-hidden", "true");
  button.append(value, chevron);
  button.setAttribute("aria-haspopup", "listbox"); button.setAttribute("aria-expanded", "false");
  // The accessible name stays the label of the field (and the chosen text is read after it); a select without a label keeps its aria-label.
  const names: string[] = [];
  for (const label of Array.from(select.labels ?? [])) { if (!label.id) label.id = `${select.id}-label${names.length ? names.length : ""}`; names.push(label.id); }
  if (names.length) button.setAttribute("aria-labelledby", [...names, button.id].join(" "));
  else if (select.getAttribute("aria-label")) button.setAttribute("aria-label", select.getAttribute("aria-label")!);
  const described = select.getAttribute("aria-describedby"); if (described) button.setAttribute("aria-describedby", described);
  select.className = `${select.className ?? ""} select-native`.trim();
  select.tabIndex = -1; select.setAttribute("aria-hidden", "true");
  select.after(button);

  let layer: Popover | undefined, list: HTMLElement | undefined, rows: HTMLElement[] = [], active = -1, typed = "", typedAt = 0;
  let dialog: Element | null = null;
  const listeners: [EventTarget, string, EventListener][] = [];
  const listen = (target: EventTarget, type: string, handler: EventListener) => { target.addEventListener(type, handler); listeners.push([target, type, handler]); };

  function refresh() {
    const options = optionsOf(select), index = chosenIndex(select, options);
    value.textContent = options[index]?.text ?? "";
    button.disabled = !!select.disabled;
    if (list) renderRows();
  }
  function renderRows() {
    if (!list) return;
    const options = optionsOf(select), current = chosenIndex(select, options);
    list.replaceChildren(); rows = [];
    let group: Element | null = null;
    options.forEach((option, index) => {
      const parent = (option.parentElement ?? null) as HTMLElement | null, inGroup = parent && parent.tagName === "OPTGROUP" ? parent : null;
      if (inGroup !== group) {
        group = inGroup;
        if (inGroup) { const heading = document.createElement("div"); heading.className = "select-heading"; heading.setAttribute("role", "presentation"); heading.textContent = (inGroup as HTMLOptGroupElement).label ?? ""; list!.append(heading); }
      }
      const row = document.createElement("div"), check = document.createElement("span"), text = document.createElement("span");
      row.className = "select-option"; row.id = `${select.id}-option-${index}`; row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === current)); row.dataset.index = String(index);
      if (option.disabled) row.setAttribute("aria-disabled", "true");
      check.className = "select-check"; check.setAttribute("aria-hidden", "true"); check.textContent = "✓";
      text.className = "select-text"; text.textContent = option.text;
      row.append(check, text); list!.append(row); rows[index] = row;
    });
    activate(active >= 0 && active < rows.length ? active : current);
  }
  const enabled = (index: number) => !!rows[index] && rows[index]!.getAttribute("aria-disabled") !== "true";
  // The row is brought into view by moving the list's own scroll (never the page): centered when the menu opens, the nearest edge while moving.
  function reveal(row: HTMLElement, center: boolean) {
    const box = list; if (!box) return;
    if (typeof row.offsetTop === "number" && box.clientHeight > 0) {
      const top = row.offsetTop, bottom = top + row.offsetHeight;
      if (center) box.scrollTop = top - (box.clientHeight - row.offsetHeight) / 2;
      else if (top < box.scrollTop) box.scrollTop = top;
      else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
    } else row.scrollIntoView?.({ block: center ? "center" : "nearest" });
  }
  function activate(index: number, center = false) {
    if (!list) return;
    active = index;
    rows.forEach((row, at) => { if (at === index) row.dataset.active = "true"; else delete row.dataset.active; });
    const row = rows[index];
    if (row) { list.setAttribute("aria-activedescendant", row.id); reveal(row, center); } else list.removeAttribute("aria-activedescendant");
  }
  function step(from: number, direction: 1 | -1): number {
    for (let index = from + direction; index >= 0 && index < rows.length; index += direction) if (enabled(index)) return index;
    return from;
  }
  function place() {
    if (!layer || !list) return;
    const sheet = typeof window.matchMedia === "function" && window.matchMedia("(max-width:600px)").matches;
    if (sheet) { layer.dataset.sheet = "true"; return; }
    delete layer.dataset.sheet;
    if (typeof button.getBoundingClientRect !== "function") return;
    const rect = button.getBoundingClientRect(), vh = window.innerHeight || 800, vw = window.innerWidth || 1200;
    const width = Math.min(Math.max(rect.width, 200), vw - 16), below = vh - rect.bottom - 12, above = rect.top - 12;
    const natural = Math.min(list.scrollHeight || 320, 320), up = below < natural && above > below;
    list.style.width = `${width}px`; list.style.left = `${Math.max(8, Math.min(rect.left, vw - width - 8))}px`;
    list.style.maxHeight = `${Math.max(120, Math.min(320, up ? above : below))}px`;
    if (up) { list.style.bottom = `${vh - rect.top + 4}px`; list.style.top = "auto"; } else { list.style.top = `${rect.bottom + 4}px`; list.style.bottom = "auto"; }
  }
  function open() {
    if (layer || select.disabled) return;
    const next = document.createElement("div") as Popover, menu = document.createElement("div");
    next.className = "select-layer"; menu.className = "select-menu"; menu.id = `${select.id}-menu`;
    menu.setAttribute("role", "listbox"); menu.tabIndex = -1;
    if (names.length) menu.setAttribute("aria-labelledby", names.join(" ")); else if (select.getAttribute("aria-label")) menu.setAttribute("aria-label", select.getAttribute("aria-label")!);
    next.append(menu); layer = next; list = menu; active = -1;
    // Inside a modal dialog the page outside it is inert, so the menu has to live in the dialog; the top layer still puts it above everything.
    dialog = select.closest?.("dialog") ?? null;
    (dialog ?? document.body).append(next);
    if (typeof next.showPopover === "function") { next.setAttribute("popover", "manual"); try { next.showPopover(); } catch { /* Falls back to the fixed layer. */ } }
    renderRows(); place();
    // The list has its size only now (place() sets the max height), so the current option is revealed after it.
    activate(active, true);
    button.setAttribute("aria-expanded", "true");
    menu.focus?.();
    listen(next, "click", event => { if (event.target === next) close(true); });
    listen(menu, "click", event => {
      const row = (event.target as HTMLElement | null)?.closest?.(".select-option") as HTMLElement | null | undefined;
      if (row) choose(Number(row.dataset.index));
    });
    listen(menu, "keydown", event => onKey(event as KeyboardEvent));
    // Esc closes the menu only: the dialog under it must stay open.
    if (dialog) { listen(dialog, "cancel", event => { event.preventDefault(); close(true); }); listen(dialog, "close", () => close(false)); }
    listen(window, "resize", () => place());
  }
  function close(restore: boolean) {
    const done = layer; if (!done) return;
    for (const [target, type, handler] of listeners.splice(0)) target.removeEventListener?.(type, handler);
    try { done.hidePopover?.(); } catch { /* Not showing. */ }
    done.remove(); layer = undefined; list = undefined; rows = []; active = -1; dialog = null;
    button.setAttribute("aria-expanded", "false");
    if (restore) button.focus();
  }
  function choose(index: number) {
    const option = optionsOf(select)[index]; if (!option || option.disabled) return;
    if (typeof select.selectedIndex === "number") select.selectedIndex = index; else select.value = option.value;
    refresh(); close(true);
    select.dispatchEvent(new Event("input", { bubbles: true })); select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function onKey(event: KeyboardEvent) {
    const key = event.key;
    if (key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (key === "Tab") { close(false); return; }
    if (key === "ArrowDown" || key === "ArrowUp") { event.preventDefault(); activate(step(active, key === "ArrowDown" ? 1 : -1)); return; }
    if (key === "Home" || key === "End") { event.preventDefault(); activate(key === "Home" ? step(-1, 1) : step(rows.length, -1)); return; }
    if (key === "Enter" || key === " ") { event.preventDefault(); if (enabled(active)) choose(active); return; }
    if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Type-ahead: letters typed in quick succession jump to the next option that starts with them.
      const now = Date.now(); typed = now - typedAt > 700 ? key.toLowerCase() : typed + key.toLowerCase(); typedAt = now;
      const options = optionsOf(select), order = [...options.keys()].map(index => (index + Math.max(active, 0) + (typed.length === 1 ? 1 : 0)) % options.length);
      const hit = order.find(index => enabled(index) && options[index]!.text.toLowerCase().startsWith(typed));
      if (hit !== undefined) { event.preventDefault(); activate(hit); }
    }
  }
  button.addEventListener("click", () => { if (layer) close(true); else open(); });
  button.addEventListener("keydown", event => {
    if (layer || !["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
    event.preventDefault(); open();
  });
  // A label click or code calling select.focus() lands on the hidden select: hand it to the visible button.
  select.addEventListener("focus", () => button.focus());
  select.addEventListener("click", event => event.preventDefault());
  mirror(select, "value", refresh); mirror(select, "selectedIndex", refresh); mirror(select, "disabled", refresh);
  const replace = select.replaceChildren;
  if (typeof replace === "function") select.replaceChildren = (...nodes: (Node | string)[]) => { replace.apply(select, nodes); refresh(); };
  if (typeof MutationObserver === "function") new MutationObserver(refresh).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled"] });
  buttons.set(select, button);
  refresh();
  return button;
}
