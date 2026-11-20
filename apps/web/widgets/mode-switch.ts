import { listeners, make } from "./dom.js";
import type { WidgetType } from "./registry.js";

// S3 mode switch. "segmented": Use | Edit. "icon" (T50): one button that shows a pencil in Use mode (press: Edit) and a check in Edit mode (press: back to Use).
export const modeSwitchWidget: WidgetType = {
  type: "mode-switch", forms: ["segmented", "icon"], interactive: true,
  minSize: { w: 96, h: 44 }, maxSize: { w: 300, h: 64 },
  formLimits: { icon: { minSize: { w: 44, h: 44 }, maxSize: { w: 72, h: 72 } } },
  create({ intents, form }) {
    if (form === "icon") {
      const pencil = make("span", { className: "ui-icon", attrs: { "data-ui-icon": "pencil", "aria-hidden": "true" } });
      const check = make("span", { className: "ui-icon", hidden: true, attrs: { "data-ui-icon": "check", "aria-hidden": "true" } });
      const button = make("button", { className: "icon-button mode-icon", attrs: { type: "button", "data-extra": "true", "aria-label": "Edit mode", "aria-pressed": "false", title: "Edit layout" } }, pencil, check);
      const bin = listeners();
      let editing = false;
      bin.on(button, "click", () => intents.setMode(editing ? "use" : "edit"));
      return {
        element: button,
        update({ mode }) {
          if (!mode) return;
          editing = mode.editing;
          button.setAttribute("aria-pressed", String(editing)); button.title = editing ? "Back to Use mode" : "Edit layout";
          pencil.hidden = editing; check.hidden = !editing;
          button.disabled = editing ? mode.useDisabled : mode.editDisabled;
        },
        destroy() { bin.clear(); button.remove(); },
      };
    }
    const use = make("button", { id: "use-mode", className: "mode-button", attrs: { type: "button", title: "Use mode", "aria-pressed": "true" } },
      make("span", { className: "ui-icon", attrs: { "data-ui-icon": "hand" } }), make("span", { className: "mode-label", text: "Use" }));
    const edit = make("button", { id: "edit-layout", className: "mode-button", attrs: { type: "button", title: "Edit layout", "aria-pressed": "false" } },
      make("span", { className: "ui-icon", attrs: { "data-ui-icon": "pencil" } }), make("span", { id: "edit-mode-label", className: "mode-label", text: "Edit" }));
    const element = make("div", { id: "mode-switch", className: "mode-switch", attrs: { role: "group", "aria-label": "Desk mode" } }, use, edit);
    const bin = listeners();
    bin.on(edit, "click", () => intents.setMode("edit"));
    bin.on(use, "click", () => intents.setMode("use"));
    return {
      element,
      update({ mode }) {
        if (!mode) return;
        edit.setAttribute("aria-pressed", String(mode.editing)); use.setAttribute("aria-pressed", String(!mode.editing));
        edit.disabled = mode.editDisabled; use.disabled = mode.useDisabled;
      },
      destroy() { bin.clear(); element.remove(); },
    };
  },
};
