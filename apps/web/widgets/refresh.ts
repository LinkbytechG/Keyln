import { listeners, make } from "./dom.js";
import type { WidgetType } from "./registry.js";

// S5 Refresh, icon-and-label button. The confirmation dialog and the reload itself stay in page-refresh.ts.
export const refreshWidget: WidgetType = {
  type: "refresh", forms: ["button"], interactive: true,
  minSize: { w: 44, h: 44 }, maxSize: { w: 200, h: 64 },
  create({ intents }) {
    const element = make("button", { id: "refresh-page", className: "quiet page-refresh", attrs: { type: "button", title: "Refresh the Keyln page" } },
      make("span", { className: "ui-icon", attrs: { "data-ui-icon": "refresh", "aria-hidden": "true" } }), make("span", { className: "page-refresh-label", text: "Refresh" }));
    const bin = listeners();
    bin.on(element, "click", () => intents.refresh());
    return {
      element,
      update({ refresh }) {
        element.disabled = refresh.disabled;
        element.title = refresh.blocked ? "Wait for the layout save or image upload to finish." : "Refresh the Keyln page";
      },
      destroy() { bin.clear(); element.remove(); },
    };
  },
};
