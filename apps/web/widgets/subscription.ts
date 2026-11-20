import { make } from "./dom.js";
import type { WidgetType } from "./registry.js";
import type { DeskState } from "./state.js";
import type { SizeTier } from "../../../packages/contracts/sizing.js";
import { subscriptionProvider, type SubscriptionKind, type SubscriptionSnapshot, type QuotaWindow } from "../../../packages/contracts/subscription.js";

export function remainingText(used: number): string {
  const left = 100 - used;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(left === 0 || left === 100 ? left : Math.floor((left + Number.EPSILON * 100) * 10) / 10) + "%";
}
export function resetText(at: number | null, now: number, compact: boolean): string {
  if (at === null) return compact ? "—" : "Reset not reported";
  if (at <= now) return compact ? "Checking" : "Checking reset…";
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes < 1440) {
    const duration = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
    return compact ? duration : `Resets in ${duration}`;
  }
  const date = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(at));
  return compact ? date : `Resets ${date}`;
}
const ageText = (at: number, now: number) => {
  const mins = Math.max(0, Math.floor((now - at) / 60000));
  return mins < 1 ? "Updated now" : mins < 60 ? `Seen ${mins}m ago` : mins < 1440 ? `Seen ${Math.floor(mins / 60)}h ago` : `Seen ${Math.floor(mins / 1440)}d ago`;
};
function sample(provider: "codex" | "claude"): SubscriptionSnapshot {
  const now = Date.now();
  return { provider, status: "ready", source: provider === "codex" ? "codex-app-server" : "claude-code-usage", updatedAt: now, checkedAt: now,
    windows: [{ id: "primary", label: "5-hour", usedPercent: provider === "codex" ? 28 : 82, windowMinutes: 300, resetsAt: now + (provider === "codex" ? 138 : 48) * 60_000 },
      { id: "weekly", label: "Weekly", usedPercent: provider === "codex" ? 59 : 37, windowMinutes: 10080, resetsAt: now + 3 * 86400000 }] };
}
export function subscriptionWidget(kind: SubscriptionKind): WidgetType {
  const provider = subscriptionProvider(kind), name = provider === "codex" ? "Codex" : "Claude Code";
  return { type: kind, forms: ["quota"], interactive: false, minSize: { w: 240, h: 120 }, maxSize: { w: 240, h: 240 },
    create(context) {
      const glyph = make("span", { className: "usage-icon", attrs: { "aria-hidden": "true" } });
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "22"); svg.setAttribute("height", "22");
      svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.6"); svg.setAttribute("stroke-linecap", "round");
      path.setAttribute("d", provider === "codex" ? "m7 5-5 7 5 7m10-14 5 7-5 7m-3-15-4 16" : "M12 2v20M2 12h20M5 5l14 14M5 19 19 5M8 3l8 18M3 8l18 8M3 16l18-8M8 21 16 3");
      svg.append(path); glyph.append(svg);
      const unit = make("span", { className: "usage-unit", text: "remaining" });
      const head = make("div", { className: "usage-head" }, glyph, make("span", { className: "usage-name", text: name }), unit);
      const rows = make("div", { className: "usage-windows" });
      const message = make("div", { className: "usage-message" });
      const foot = make("div", { className: "usage-foot" });
      const element = make("div", { className: "w-subscription", attrs: { role: "group", "aria-label": `${name} subscription remaining quota` } }, head, rows, message, foot);
      let state: DeskState | undefined, size: SizeTier = "L", destroyed = false;
      let rendered = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const preview = context.preview ? sample(provider) : undefined;
      function windowRow(w: QuotaWindow, now: number, compact: boolean): HTMLElement {
        const expired = w.resetsAt !== null && w.resetsAt <= now, remaining = 100 - w.usedPercent;
        const label = compact && !w.label.includes("·") ? w.windowMinutes === 300 ? "5h" : w.windowMinutes === 10080 ? "Week" : w.label : w.label;
        const title = make("span", { className: "usage-window-name", text: label, attrs: { title: w.label } });
        const value = make("span", { className: "usage-value", text: expired ? "—" : remainingText(w.usedPercent) });
        value.append(make("span", { className: "usage-left", text: expired ? "" : " left" }));
        const bar = make("div", { className: "usage-track" });
        const fill = make("div", { className: "usage-fill" }); fill.style.setProperty("width", `${expired ? 0 : remaining}%`); bar.append(fill);
        if (expired) bar.setAttribute("aria-hidden", "true");
        else { bar.setAttribute("role", "meter"); bar.setAttribute("aria-label", `${w.label} remaining quota`); bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100"); bar.setAttribute("aria-valuenow", String(remaining)); }
        const reset = make("span", { className: "usage-reset", text: resetText(w.resetsAt, now, compact), attrs: { title: resetText(w.resetsAt, now, false) } });
        const row = make("div", { className: "usage-window", attrs: { "data-low": String(!expired && remaining <= 20) } }, title, value, bar, reset);
        return row;
      }
      function draw() {
        if (destroyed) return;
        const now = Date.now(), snapshot = preview ?? state?.subscriptions?.[provider], compact = size === "M";
        element.dataset.compact = String(compact); element.dataset.provider = provider;
        unit.hidden = !compact;
        const status = snapshot?.status ?? "loading", online = !!preview || !!state?.connection.online;
        const measured = snapshot && (status === "ready" || status === "stale") && snapshot.windows.length;
        const next = JSON.stringify([snapshot, compact, online, Math.floor(now / 60000), snapshot?.windows.map(w => w.resetsAt !== null && w.resetsAt <= now)]);
        if (rendered === next) return; rendered = next;
        rows.hidden = !measured; message.hidden = !!measured;
        element.dataset.stale = String(!!measured && (!online || status === "stale"));
        if (measured) {
          rows.replaceChildren(...snapshot.windows.map(w => windowRow(w, now, compact)));
          const expired = snapshot.windows.some(w => w.resetsAt !== null && w.resetsAt <= now);
          const low = snapshot.windows.some(w => (w.resetsAt === null || w.resetsAt > now) && 100 - w.usedPercent <= 20);
          foot.dataset.warning = String(low || !online || status === "stale");
          const age = ageText(snapshot.updatedAt!, now);
          foot.textContent = preview ? "Sample data" : !online ? `Mac disconnected · ${age}` : status === "stale" ? `Stale · ${age}` : expired ? "Waiting for fresh quota" : low ? `Low remaining · ${age}` : age;
          foot.title = snapshot.updatedAt ? `Last observed ${new Date(snapshot.updatedAt).toLocaleString()}` : "";
        } else {
          rows.replaceChildren(); foot.dataset.warning = "false"; foot.title = "";
          const copy = status === "not-installed" ? ["Not installed", `Install ${name} on your Mac.`] : status === "sign-in" ? ["Sign in required", provider === "claude" ? "In Mac Terminal, run: claude auth login" : "Sign in with your subscription on the Mac."] :
            status === "not-subscribed" ? ["Subscription not detected", "A subscription login is needed."] : status === "unavailable" && snapshot?.reason === "setup-required" ? ["Local setup needed", "Connect Claude usage sharing on your Mac."] :
            status === "unavailable" ? ["Quota unavailable", snapshot?.reason === "read-failed" ? "Could not read the tool on your Mac." : "The tool did not report a current limit."] : ["Reading subscription…", "Checking the tool on your Mac."];
          message.replaceChildren(make("p", { className: "usage-state-title", text: copy[0] }), make("p", { className: "usage-state-detail", text: copy[1] }));
          foot.textContent = compact ? "" : "Subscription quota only";
        }
      }
      function schedule() {
        clearTimeout(timer); timer = undefined;
        if (destroyed || context.preview || document.hidden) return;
        timer = setTimeout(() => { draw(); schedule(); }, 60000 - Date.now() % 60000);
      }
      const visible = () => { draw(); schedule(); };
      document.addEventListener?.("visibilitychange", visible);
      draw(); schedule();
      return { element, update(next) { state = next; draw(); }, preset(next) { if (size !== next) { size = next; draw(); } },
        destroy() { destroyed = true; clearTimeout(timer); document.removeEventListener?.("visibilitychange", visible); element.remove(); } };
    } };
}
export const codexUsageWidget = subscriptionWidget("codex-usage"), claudeUsageWidget = subscriptionWidget("claude-usage");
