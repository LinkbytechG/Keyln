import { connectionWidget } from "./connection.js";
import { clockWidget, textWidget } from "./display.js";
import { codexUsageWidget, claudeUsageWidget } from "./subscription.js";
import { modeSwitchWidget } from "./mode-switch.js";
import { refreshWidget } from "./refresh.js";
import type { Registry, WidgetInstance } from "./registry.js";
import { settingsWidget } from "./settings.js";
import type { DeskState } from "./state.js";
import { SYSTEM_FORMS, SYSTEM_PARTS, type SystemPart } from "../../../packages/contracts/index.js";

// T44/T62: the widget types. The three system components (connection, Use | Edit switch, settings) belong to the theme (ADR-064): every form a theme can ask for
// is made once, kept hidden in #system-layer, and zones.ts shows the one the theme's zones name. Display widgets (including subscription quotas) are
// ordinary widgets: console.ts makes one instance per widget on the canvas, standalone, so no element id appears twice.
export const widgetTypes = [connectionWidget, refreshWidget, modeSwitchWidget, settingsWidget, clockWidget, textWidget, codexUsageWidget, claudeUsageWidget];
export function registerSystemWidgets(registry: Registry) { for (const widget of widgetTypes) registry.register(widget); }

// Creates the system forms and puts them in `host` (hidden until the zones place one). update() hands one snapshot to all of them.
export function createRuntime(registry: Registry, host: HTMLElement | null = document.getElementById("system-layer")) {
  const instances = new Map<string, WidgetInstance>();
  for (const part of SYSTEM_PARTS) for (const form of SYSTEM_FORMS[part]) {
    // Only the capsule, the segmented switch and the gear carry element ids (#connection-button, #use-mode, #connection-settings); the other forms carry none.
    const instance = registry.create(part, form);
    instance.element.hidden = true;
    host?.append(instance.element);
    instances.set(`${part}/${form}`, instance);
  }
  return {
    host,
    instance<T extends WidgetInstance = WidgetInstance>(part: SystemPart, form: string): T | undefined { return instances.get(`${part}/${form}`) as T | undefined; },
    elements(): HTMLElement[] { return [...instances.values()].map(instance => instance.element); },
    update(state: DeskState) { for (const instance of instances.values()) instance.update(state); },
    destroy() { for (const instance of instances.values()) instance.destroy(); instances.clear(); },
  };
}
export type Runtime = ReturnType<typeof createRuntime>;
