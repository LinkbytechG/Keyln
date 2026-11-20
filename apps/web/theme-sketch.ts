import { contentRect, SYSTEM_PARTS, slotRect, type SystemPart, type WindowSize, type ZoneSet } from "../../packages/contracts/index.js";

// T64 (ADR-064): a small drawing of a theme's zones. The window is drawn to scale: the top bar, the three system components and the content area that holds the canvas.
// The picker for a new device and the read-only view of a built-in theme use it as a picture; the Layout page of the theme window drags the parts on it.
// The window sizes are the ones a layout is checked in first (contracts ZONE_CHECK_WINDOWS): a laptop-size window for the wide set, a phone for the narrow one.
export const SKETCH_WINDOWS: Readonly<Record<"wide" | "narrow", WindowSize>> = { wide: { width: 1366, height: 768 }, narrow: { width: 411, height: 860 } };
export const partNames: Readonly<Record<SystemPart, string>> = { "mode-switch": "Use | Edit", settings: "Settings", connection: "Connection" };
const partText = (part: SystemPart, form: string): string => part === "mode-switch" ? (form === "segmented" ? "Use | Edit" : "Edit") : part === "settings" ? "⚙" : form === "capsule" ? "Mac connected" : "●";

export interface Sketch {
  readonly element: HTMLElement;
  readonly parts: Readonly<Record<SystemPart, HTMLElement>>;
  readonly window: WindowSize;
  /** Draws these zones; `bad` marks a drawing whose zones break a rule. */
  update(zones: ZoneSet, bad?: boolean): void;
}
const percent = (value: number, whole: number) => `${(value / whole * 100).toFixed(3)}%`;
export function createSketch(which: "wide" | "narrow", interactive = false): Sketch {
  const window = SKETCH_WINDOWS[which];
  const element = document.createElement("div"), header = document.createElement("div"), content = document.createElement("div");
  element.className = "sketch"; element.dataset.set = which; element.style.setProperty("aspect-ratio", `${window.width} / ${window.height}`);
  header.className = "sketch-header"; header.setAttribute("aria-hidden", "true");
  content.className = "sketch-content"; content.setAttribute("aria-hidden", "true");
  const parts = {} as Record<SystemPart, HTMLElement>;
  element.append(header, content);
  for (const part of SYSTEM_PARTS) {
    const node = document.createElement(interactive ? "button" : "span");
    node.className = "sketch-part"; node.dataset.part = part;
    if (interactive) { (node as HTMLButtonElement).type = "button"; node.setAttribute("aria-label", partNames[part]); }
    else node.setAttribute("aria-hidden", "true");
    parts[part] = node; element.append(node);
  }
  return {
    element, parts, window,
    update(zones, bad = false) {
      element.dataset.problem = String(bad);
      header.hidden = zones.header <= 0;
      header.style.setProperty("height", percent(zones.header, window.height));
      const area = contentRect(zones, window);
      for (const [name, value] of [["left", percent(area.x, window.width)], ["top", percent(area.y, window.height)], ["width", percent(area.w, window.width)], ["height", percent(area.h, window.height)]] as const) content.style.setProperty(name, value);
      for (const part of SYSTEM_PARTS) {
        const rect = slotRect(zones.slots[part], window), node = parts[part];
        for (const [name, value] of [["left", percent(rect.x, window.width)], ["top", percent(rect.y, window.height)], ["width", percent(rect.w, window.width)], ["height", percent(rect.h, window.height)]] as const) node.style.setProperty(name, value);
        node.dataset.form = zones.slots[part].form;
        node.textContent = partText(part, zones.slots[part].form);
        if (interactive) node.title = `${partNames[part]} · ${zones.slots[part].form}`;
      }
    },
  };
}
