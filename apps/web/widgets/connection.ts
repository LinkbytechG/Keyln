import { listeners, make } from "./dom.js";
import type { WidgetType } from "./registry.js";
import type { ConnectionState, RefreshState } from "./state.js";

// T50: the three colours of the dot forms. The six status texts map to them by phase (ADR-057): connected is green, connecting (and the first
// load) is yellow, everything else (Disconnected, Pairing required, Mac layout needs recovery, Browser update needed) is red.
export type ConnectionTone = "ok" | "busy" | "bad";
export const connectionTone = (connection: Pick<ConnectionState, "phase">): ConnectionTone =>
  connection.phase === "online" ? "ok" : connection.phase === "connecting" || connection.phase === "loading" ? "busy" : "bad";

// What pressing the dot button does now, in words (its accessible name) and as a plan: only a disconnected or failed state reconnects first.
export function dotButtonPlan(connection: ConnectionState): { reconnect: boolean; label: string } {
  const tone = connectionTone(connection);
  if (tone === "bad") return connection.reconnectDisabled ? { reconnect: false, label: `${connection.text}. Refresh the page.` } : { reconnect: true, label: `${connection.text}. Reconnect and refresh the page.` };
  return { reconnect: false, label: `${connection.text}. Refresh the page.` };
}

// T87 (ADR-082): what a press on the capsule or the dot button does, from the connection and the Refresh state (ADR-057, ADR-082). A lost Mac can always be reconnected,
// even while Refresh is held back (a layout save or an upload in progress), so then the press only reconnects. Otherwise a press waits for Refresh to be allowed.
export function connectionPress(connection: ConnectionState, refresh: RefreshState): { reconnect: boolean; refresh: boolean; disabled: boolean; label: string } {
  const plan = dotButtonPlan(connection);
  if (!plan.reconnect) return { reconnect: false, refresh: !refresh.disabled, disabled: refresh.disabled, label: plan.label };
  return refresh.disabled ? { reconnect: true, refresh: false, disabled: false, label: `${connection.text}. Reconnect.` } : { reconnect: true, refresh: true, disabled: false, label: plan.label };
}

// How long a finger rests on the dot before the full status text shows, and how long that bubble stays.
export const BUBBLE_DELAY_MS = 450, BUBBLE_STAY_MS = 2500;

// S2 connection status. "capsule": the lamp, the status text and a refresh icon in one button that does what the dot button does (T87, ADR-082). "dot": a coloured dot that only shows (hover or
// long press shows the full text). "dot-button": the same dot as a button of at least 44px that reconnects (when needed) and refreshes.
export const connectionWidget: WidgetType = {
  type: "connection", forms: ["capsule", "dot", "dot-button"], interactive: true,
  minSize: { w: 44, h: 44 }, maxSize: { w: 480, h: 72 },
  formLimits: { dot: { interactive: false, minSize: { w: 12, h: 12 }, maxSize: { w: 72, h: 72 } }, "dot-button": { interactive: true, minSize: { w: 44, h: 44 }, maxSize: { w: 72, h: 72 } } },
  create({ intents, form }) {
    const bin = listeners();
    if (form === "capsule") {
      // One button: the lamp (drawn by the stylesheet), the status words and a small refresh icon. Its name says what it will do; the status words are announced once,
      // from the visually hidden role=status text beside it, so a change does not re-read the button.
      let plan = connectionPress({ text: "Loading…", phase: "loading", online: false, reconnectDisabled: false }, { disabled: false, blocked: false });
      const words = make("span", { className: "connection-text", text: "Loading…", attrs: { "aria-hidden": "true" } });
      const icon = make("span", { className: "ui-icon", attrs: { "data-ui-icon": "refresh", "aria-hidden": "true" } });
      const button = make("button", { id: "connection-button", className: "connection connection-button", attrs: { type: "button", "data-online": "false", "data-phase": "loading", "aria-label": plan.label, title: plan.label } }, words, icon);
      const status = make("span", { id: "connection", className: "sr-only", text: "Loading…", attrs: { role: "status", "data-online": "false", "data-phase": "loading" } });
      const element = make("div", { className: "connection-tools" }, button, status);
      bin.on(button, "click", () => { if (plan.reconnect) intents.reconnect(); if (plan.refresh) intents.refresh(); });
      return {
        element,
        update({ connection, refresh }) {
          plan = connectionPress(connection, refresh);
          words.textContent = connection.text; status.textContent = connection.text;
          for (const node of [button, status]) { node.dataset.online = String(connection.online); node.dataset.phase = connection.phase; }
          button.setAttribute("aria-label", plan.label); button.title = plan.label;
          button.disabled = plan.disabled;
        },
        destroy() { bin.clear(); element.remove(); },
      };
    }
    const lamp = make("span", { className: "w-lamp", attrs: { "aria-hidden": "true", "data-tone": "bad" } });
    if (form === "dot-button") {
      let plan = connectionPress({ text: "Loading…", phase: "loading", online: false, reconnectDisabled: false }, { disabled: false, blocked: false });
      const element = make("button", { className: "icon-button conn-dot-button", attrs: { type: "button", "data-extra": "true", "data-phase": "loading", "data-tone": "busy", "aria-label": plan.label, title: "Loading…" } }, lamp);
      bin.on(element, "click", () => { if (plan.reconnect) intents.reconnect(); if (plan.refresh) intents.refresh(); });
      return {
        element,
        update({ connection, refresh }) {
          plan = connectionPress(connection, refresh);
          const tone = connectionTone(connection);
          lamp.dataset.tone = tone; element.dataset.tone = tone; element.dataset.phase = connection.phase;
          element.setAttribute("aria-label", plan.label); element.title = connection.text;
          element.disabled = plan.disabled;
        },
        destroy() { bin.clear(); element.remove(); },
      };
    }
    // dot: shows only. role=status with the text kept for assistive tools; `title` for the hover; a long press opens a small bubble (it opens nothing else).
    const label = make("span", { className: "sr-only", text: "Loading…" });
    const bubble = make("span", { className: "conn-bubble", text: "Loading…", hidden: true, attrs: { "aria-hidden": "true" } });
    const element = make("div", { className: "conn-dot", attrs: { role: "status", "data-extra": "true", "data-phase": "loading", "data-tone": "busy", title: "Loading…" } }, lamp, label, bubble);
    let hold: ReturnType<typeof setTimeout> | undefined, stay: ReturnType<typeof setTimeout> | undefined;
    const hide = () => { clearTimeout(hold); clearTimeout(stay); hold = stay = undefined; bubble.hidden = true; };
    bin.on(element, "pointerdown", () => {
      hide();
      hold = setTimeout(() => { hold = undefined; bubble.hidden = false; stay = setTimeout(hide, BUBBLE_STAY_MS); }, BUBBLE_DELAY_MS);
    });
    // Letting go before the delay cancels the bubble; one that is already open stays its time so it can be read.
    for (const name of ["pointerup", "pointercancel", "pointerleave"]) bin.on(element, name, () => { clearTimeout(hold); hold = undefined; });
    bin.on(element, "contextmenu", (event: Event) => event.preventDefault());
    return {
      element,
      update({ connection }) {
        const tone = connectionTone(connection);
        lamp.dataset.tone = tone; element.dataset.tone = tone; element.dataset.phase = connection.phase;
        element.title = connection.text; label.textContent = connection.text; bubble.textContent = connection.text;
      },
      destroy() { hide(); bin.clear(); element.remove(); },
    };
  },
};
