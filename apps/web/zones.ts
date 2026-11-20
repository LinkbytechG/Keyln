import { contentRect, MIN_CONTENT, slotRect, SYSTEM_PARTS, zoneSetFor, type PxRect, type SystemPart, type ThemeLayout, type WindowSize, type ZoneSet } from "../../packages/contracts/index.js";

// T62 (ADR-064): the theme's zones on the page. The Host-independent rule is in the contracts (zoneSetFor, slotRect, contentRect); this module writes it on the page:
// the three system components are placed from the window edges, and the content area (#grid-frame) is the rectangle that holds the shared canvas.
export interface Insets { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }
export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
// The window the zones are laid out in: the viewport without the safe area (an installed app on a notched phone).
export function usableWindow(viewport: WindowSize, insets: Insets = NO_INSETS): WindowSize {
  return { width: Math.max(0, viewport.width - insets.left - insets.right), height: Math.max(0, viewport.height - insets.top - insets.bottom) };
}
// Everything the page needs to draw one set of zones, as plain numbers (px, relative to the usable window).
export interface ZonePlan { zones: ZoneSet; set: "wide" | "narrow"; window: WindowSize; slots: Record<SystemPart, PxRect & { form: string }>; content: PxRect }
// `reserveBottom` keeps the foot of the content area free (the bar of Edit mode); the system components do not move.
export function planZones(layout: ThemeLayout, viewport: WindowSize, insets: Insets = NO_INSETS, reserveBottom = 0): ZonePlan {
  const window = usableWindow(viewport, insets), zones = zoneSetFor(layout, window.width);
  const slots = {} as ZonePlan["slots"];
  for (const part of SYSTEM_PARTS) slots[part] = { ...slotRect(zones.slots[part], window), form: zones.slots[part].form };
  const content = contentRect(zones, window);
  return { zones, set: zones === layout.narrow ? "narrow" : "wide", window, slots, content: reserveBottom > 0 ? { ...content, h: Math.max(0, content.h - reserveBottom) } : content };
}
// T115 (ADR-099): the strip the Mac Dock bar keeps at the foot of the content area (the capsule and its gap to the bottom): 64 + 12px in a wide window, 52 + 8px in a
// narrow one. It is the same `reserveBottom` the Edit shelf uses; the theme layouts are not touched. A window too short to keep MIN_CONTENT above it shows no Dock (0).
export const DOCK_RESERVE = { wide: 76, narrow: 60 } as const;
export const DOCK_CAPSULE = { wide: 64, narrow: 52 } as const;
export function dockReserve(layout: ThemeLayout, viewport: WindowSize, insets: Insets = NO_INSETS): number {
  const base = planZones(layout, viewport, insets), reserve = DOCK_RESERVE[base.set];
  return base.content.h - reserve < MIN_CONTENT.h ? 0 : reserve;
}
// Where the Dock strip is on the page (px, from the page's top left): the foot of the content area without the Edit shelf's extra reserve. `used` is the reserve the plan was
// made with (the larger of the Dock's and the shelf's); `dock` is the Dock's own.
export function dockStrip(plan: ZonePlan, insets: Insets, used: number, dock: number): PxRect {
  return { x: insets.left + plan.content.x, y: insets.top + plan.content.y + plan.content.h + (used - dock), w: plan.content.w, h: dock };
}
// Safe-area insets, read through a throwaway element whose padding is the env() values.
export function safeInsets(): Insets {
  try {
    const probe = document.createElement("div");
    for (const [name, side] of [["padding-top", "top"], ["padding-right", "right"], ["padding-bottom", "bottom"], ["padding-left", "left"]]) probe.style.setProperty(name!, `env(safe-area-inset-${side})`);
    probe.style.setProperty("position", "fixed"); probe.style.setProperty("visibility", "hidden"); probe.style.setProperty("pointer-events", "none");
    document.body.append(probe);
    const style = getComputedStyle(probe), found = { top: Number.parseFloat(style.paddingTop), right: Number.parseFloat(style.paddingRight), bottom: Number.parseFloat(style.paddingBottom), left: Number.parseFloat(style.paddingLeft) };
    probe.remove();
    const clean = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
    return { top: clean(found.top), right: clean(found.right), bottom: clean(found.bottom), left: clean(found.left) };
  } catch { return NO_INSETS; }
}

interface Options {
  shell: HTMLElement; layer: HTMLElement; bar: HTMLElement; frame: HTMLElement;
  // The element of a system component in a form (made by widgets/system.ts, hidden until placed).
  system: (part: SystemPart, form: string) => HTMLElement | undefined;
  // Every system element, so the ones a theme does not use stay hidden.
  all: () => HTMLElement[];
}
const px = (value: number) => `${Math.round(value)}px`;
// The padding of the frame that holds the canvas (T97): none in a wide window, 4px in a narrow one.
export const framePadFor = (set: "wide" | "narrow"): number => set === "wide" ? 0 : 4;
// Places the three system components and the content area for a theme's layout. Returns the content area size in px.
export function createZones(options: Options) {
  let plan: ZonePlan | undefined;
  return {
    get plan() { return plan; },
    // `drawn` false hides the system layer (not paired, or something else covers the page): the stylesheet's plain flow is then used.
    apply(layout: ThemeLayout, viewport: WindowSize, drawn: boolean, insets: Insets = NO_INSETS, reserveBottom = 0): ZonePlan | undefined {
      options.shell.dataset.canvas = String(drawn);
      options.layer.hidden = !drawn;
      if (!drawn) { plan = undefined; return undefined; }
      plan = planZones(layout, viewport, insets, reserveBottom);
      const { zones, slots, content } = plan, left = insets.left, top = insets.top;
      options.shell.dataset.zones = plan.set;
      // Where the content area starts: the floating area of Edit keeps below it, so the top bar and the controls stay reachable.
      options.shell.style.setProperty("--zone-top", px(top + content.y));
      options.bar.hidden = zones.header <= 0;
      options.bar.style.setProperty("left", px(left)); options.bar.style.setProperty("top", px(top)); options.bar.style.setProperty("width", px(plan.window.width)); options.bar.style.setProperty("height", px(zones.header));
      const shown = new Set<HTMLElement>();
      for (const part of SYSTEM_PARTS) {
        const element = options.system(part, slots[part].form);
        if (!element) continue;
        shown.add(element);
        element.hidden = false; element.dataset.zonePart = part;
        for (const [name, value] of [["left", left + slots[part].x], ["top", top + slots[part].y], ["width", slots[part].w], ["height", slots[part].h]] as const) element.style.setProperty(name, px(value));
      }
      for (const element of options.all()) if (!shown.has(element)) { element.hidden = true; delete element.dataset.zonePart; }
      for (const [name, value] of [["left", left + content.x], ["top", top + content.y], ["width", content.w], ["height", content.h]] as const) options.frame.style.setProperty(name, px(value));
      // T97 (ADR-088): a wide window's canvas has no frame padding (the canvas keeps its own 1u from the edge); a narrow one keeps 4px. console.ts reads this too.
      options.frame.style.setProperty("--frame-pad", px(framePadFor(plan.set)));
      return plan;
    },
    // The room the content area gives the canvas.
    area(): { width: number; height: number } | undefined { return plan ? { width: plan.content.w, height: plan.content.h } : undefined; },
    // The frame's padding in the plan now.
    get pad(): number { return plan ? framePadFor(plan.set) : 4; },
  };
}
export type Zones = ReturnType<typeof createZones>;
