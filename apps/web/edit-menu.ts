import { presetSummary, isBlank, isPages, locate, type Config, type SizeTier } from "../../packages/contracts/index.js";
import type { MenuTarget } from "./console.js";
import { tiersFor } from "./library.js";

// T63 (ADR-064): the quick menu of Edit, opened by a long press or a right click. On a widget: its sizes, Edit (its settings card) and Remove. On a page tab:
// Rename, Delete, Move left and Move right. It is a small floating list; a tap outside it, Esc or choosing an entry closes it.
interface Options {
  view: () => Config | undefined;
  resize: (id: string, tier: SizeTier) => void;
  edit: (id: string) => void;
  remove: (id: string) => void;
  tab: { rename: (pagesId: string, pageId: string) => void; remove: (pagesId: string, pageId: string) => void; move: (pagesId: string, pageId: string, step: -1 | 1) => void };
}
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
export function createEditMenu(options: Options) {
  const menu = el("edit-menu"), scrim = el("edit-menu-scrim");
  let opener: HTMLElement | undefined;
  function close() {
    if (menu.hidden) return;
    menu.hidden = true; scrim.hidden = true; menu.replaceChildren();
    opener?.focus?.(); opener = undefined;
  }
  const entry = (caption: string, run: () => void, extra: { danger?: boolean; disabled?: boolean; pressed?: boolean; size?: string; component?: { kind: string; form?: string } } = {}) => {
    const button = document.createElement("button");
    button.type = "button"; button.className = extra.size ? "menu-size" : "menu-item"; button.textContent = caption; button.setAttribute("role", "menuitem");
    if (extra.size) { button.dataset.tier = extra.size; button.title = presetSummary(extra.size as SizeTier, extra.component); button.setAttribute("aria-pressed", String(!!extra.pressed)); }
    if (extra.danger) button.dataset.danger = "true";
    button.disabled = !!extra.disabled;
    button.addEventListener("click", () => { if (button.disabled) return; close(); run(); });
    return button;
  };
  function open(target: MenuTarget, x: number, y: number) {
    const config = options.view(); if (!config) return;
    const items: HTMLElement[] = [];
    if (target.kind === "widget") {
      const found = locate(config, target.id)?.widget; if (!found) return;
      // A blank has nothing to size or configure: only Remove (ADR-083).
      if (isBlank(found)) items.push(entry("Remove", () => options.remove(target.id), { danger: true }));
      else {
      if (!isPages(found) && found.kind !== "clock") {
        const allowed = tiersFor(found.kind, "form" in found ? found.form : undefined), tiers = allowed.includes(found.size) ? allowed : [...allowed, found.size];
        const row = document.createElement("div");
        row.className = "menu-sizes"; row.setAttribute("role", "group"); row.setAttribute("aria-label", "Size");
        row.append(...tiers.map(tier => entry(tier, () => options.resize(target.id, tier), { size: tier, pressed: tier === found.size, component: found })));
        items.push(row);
      }
      items.push(entry("Edit", () => options.edit(target.id)), entry("Remove", () => options.remove(target.id), { danger: true }));
      }
    } else {
      const group = locate(config, target.pagesId)?.widget;
      if (!group || !isPages(group)) return;
      const index = group.pages.findIndex(page => page.id === target.pageId); if (index < 0) return;
      items.push(entry("Rename", () => options.tab.rename(target.pagesId, target.pageId)),
        entry("Move left", () => options.tab.move(target.pagesId, target.pageId, -1), { disabled: index === 0 }),
        entry("Move right", () => options.tab.move(target.pagesId, target.pageId, 1), { disabled: index === group.pages.length - 1 }),
        entry("Delete", () => options.tab.remove(target.pagesId, target.pageId), { danger: true, disabled: group.pages.length <= 1 }));
    }
    opener = (typeof document.activeElement === "object" ? document.activeElement : undefined) as HTMLElement | undefined;
    menu.replaceChildren(...items); menu.hidden = false; scrim.hidden = false;
    const width = typeof window.innerWidth === "number" ? window.innerWidth : 0, height = typeof window.innerHeight === "number" ? window.innerHeight : 0;
    menu.style.left = `${width ? Math.max(8, Math.min(x, width - 232)) : x}px`; menu.style.top = `${height ? Math.max(8, Math.min(y, height - 200)) : y}px`;
    (menu.children[0] as HTMLElement | undefined)?.focus?.();
  }
  // A press on anything else (a button of the floating area, say) closes the menu and goes on to do its own work.
  if (typeof window.addEventListener === "function") window.addEventListener("pointerdown", event => {
    const target = event.target as Node | null;
    if (!menu.hidden && target !== scrim && !menu.contains?.(target)) close();
  }, true);
  scrim.addEventListener("pointerdown", event => { event.preventDefault(); close(); });
  scrim.addEventListener("click", close);
  scrim.addEventListener("contextmenu", event => { event.preventDefault(); close(); });
  menu.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } });
  return { open, close, get isOpen() { return !menu.hidden; } };
}
