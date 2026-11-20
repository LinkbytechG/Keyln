import { make, words } from "./dom.js";
import type { WidgetType } from "./registry.js";

// S4 settings, gear form: the gear opens a menu. The theme picker (this device's own theme, ADR-064), the Theme window button, the layout files and install buttons are only
// placed here; themes.ts, mac-dock.ts, full-screen.ts, layout-files.ts and install.ts find them by id and own what they do.
export const settingsWidget: WidgetType = {
  type: "settings", forms: ["gear"], interactive: true,
  minSize: { w: 44, h: 44 }, maxSize: { w: 72, h: 72 },
  create() {
    const note = make("p", { id: "theme-note", className: "theme-note", attrs: { role: "status", "aria-live": "polite" } });
    const theme = make("section", { className: "theme-section", attrs: { "aria-labelledby": "theme-title" } },
      make("strong", { id: "theme-title", text: "Theme" }), make("span", { id: "theme-scope", className: "theme-scope", text: "This screen only" }),
      make("div", { id: "theme-picker", className: "theme-picker", attrs: { role: "group", "aria-labelledby": "theme-title" } }),
      make("button", { id: "theme-open", className: "quiet theme-open", text: "Theme settings…", attrs: { type: "button", "aria-haspopup": "dialog" } }), note);
    // T88 (ADR-083): how a dragged key lands, for this screen only. move-mode.ts finds the two buttons by id and owns what they do.
    const moving = make("section", { className: "move-section", attrs: { "aria-labelledby": "move-mode-title" } },
      make("strong", { id: "move-mode-title", text: "Moving keys" }), make("span", { className: "theme-scope", text: "This screen only" }),
      make("div", { className: "move-choices", attrs: { role: "group", "aria-labelledby": "move-mode-title" } },
        make("button", { id: "move-mode-swap", className: "move-choice", text: "Swap", attrs: { type: "button", "aria-pressed": "true" } }),
        make("button", { id: "move-mode-insert", className: "move-choice", text: "Insert", attrs: { type: "button", "aria-pressed": "false" } })),
      make("p", { id: "move-mode-note", className: "field-note" }));
    // T119 (ADR-103): full screen for this device. full-screen.ts finds the two buttons and the note by id and owns what they do.
    const fullScreen = make("section", { className: "move-section", attrs: { "aria-labelledby": "fullscreen-title" } },
      make("strong", { id: "fullscreen-title", text: "Full screen" }), make("span", { className: "theme-scope", text: "This screen only" }),
      make("div", { className: "move-choices", attrs: { role: "group", "aria-labelledby": "fullscreen-title" } },
        make("button", { id: "fullscreen-off", className: "move-choice", text: "Off", attrs: { type: "button", "aria-pressed": "true" } }),
        make("button", { id: "fullscreen-on", className: "move-choice", text: "On", attrs: { type: "button", "aria-pressed": "false" } })),
      make("p", { id: "fullscreen-note", className: "field-note", attrs: { role: "status", "aria-live": "polite" } }));
    // T115 (ADR-099): the Mac Dock bar of this screen's layout. mac-dock.ts finds the two buttons by id and owns what they do.
    const dock = make("section", { className: "move-section dock-section", attrs: { "aria-labelledby": "dock-title" } },
      make("strong", { id: "dock-title", text: "Mac Dock" }), make("span", { className: "theme-scope", text: "This screen only" }),
      make("div", { className: "move-choices", attrs: { role: "group", "aria-labelledby": "dock-title" } },
        make("button", { id: "dock-off", className: "move-choice", text: "Off", attrs: { type: "button", "aria-pressed": "true" } }),
        make("button", { id: "dock-on", className: "move-choice", text: "Running apps", attrs: { type: "button", "aria-pressed": "false" } })),
      make("p", { id: "dock-note", className: "field-note", attrs: { role: "status", "aria-live": "polite" } }),
      // T117 (ADR-101): the Dock's own settings window (#dock-dialog); mac-dock.ts finds this button by id and owns the window.
      make("button", { id: "dock-settings-open", className: "quiet theme-open", text: "Dock settings…", attrs: { type: "button", "aria-haspopup": "dialog" } }));
    const check = make("a", { text: "Surface connection check ↗", attrs: { href: "/check", target: "_blank", rel: "noopener" } });
    const popover = make("div", { className: "settings-popover" }, theme, moving, fullScreen, dock,
      make("strong", { text: "Your Mac connection" }), make("p", { id: "host-address" }),
      make("p", { text: "Keep Keyln running on the Mac. This page reconnects automatically after Wi-Fi returns or it wakes. If retries stop, tap the connection status to reconnect." }),
      make("p", {}, words("Manage devices on the Mac at "), make("code", { text: "/admin" }), words(". For login startup, use "), make("code", { text: "npm run service:admin" }), words(" to get a management code.")),
      make("p", {}, make("button", { id: "layout-files-open", className: "quiet", text: "Layout files & backup", attrs: { type: "button" }, hidden: true })),
      make("p", {}, make("button", { id: "install-open", className: "quiet", text: "Install Keyln", attrs: { type: "button" } })),
      make("p", {}, check),
      make("details", { id: "execution-diagnostics", className: "execution-diagnostics" },
        make("summary", { text: "Action diagnostics" }),
        make("p", { id: "execution-message", text: "Ready", attrs: { role: "status", "aria-live": "polite" } }),
        make("pre", { id: "execution-output", hidden: true }),
        make("button", { id: "execution-acknowledge", className: "quiet", text: "I checked the Mac — clear unknown result", attrs: { type: "button" }, hidden: true })));
    const element = make("details", { id: "connection-settings", className: "connection-settings" },
      make("summary", { className: "icon-button", attrs: { "aria-label": "Settings", title: "Settings" } }, make("span", { className: "ui-icon", attrs: { "data-ui-icon": "settings" } })), popover) as HTMLDetailsElement;
    // T82: a tap outside the open menu only closes it. The click that follows is swallowed so the same tap never also runs a key or presses a button behind the menu.
    // The Edit toolbar's gear (#edit-settings) toggles the menu itself, so it does not count as outside. Esc closes it too and returns focus to the gear.
    let swallow = false, swallowTimer: ReturnType<typeof setTimeout> | undefined;
    const outside = (event: PointerEvent) => {
      swallow = false; clearTimeout(swallowTimer);
      const target = event.target as Element | null;
      if (!element.open || !target || element.contains(target) || target.closest("#edit-settings")) return;
      element.open = false; swallow = true; swallowTimer = setTimeout(() => { swallow = false; }, 800);
    };
    const swallowClick = (event: MouseEvent) => { if (!swallow) return; swallow = false; clearTimeout(swallowTimer); event.preventDefault(); event.stopPropagation(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !element.open) return;
      element.open = false; event.preventDefault(); event.stopPropagation(); element.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("click", swallowClick, true);
    document.addEventListener("keydown", escape, true);
    return {
      element,
      update({ settings }) { note.textContent = settings.themeNote; },
      destroy() {
        document.removeEventListener("pointerdown", outside, true); document.removeEventListener("click", swallowClick, true); document.removeEventListener("keydown", escape, true);
        clearTimeout(swallowTimer); element.remove();
      },
    };
  },
};
