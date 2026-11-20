import { make } from "./dom.js";
import type { WidgetType } from "./registry.js";

// T50: the two widgets that only show something and need nothing from the desk: S9 clock and S10 text. Neither is pressed.

// ---- S9 clock ----------------------------------------------------------------------------------------------------------------------------------

// ISO week is based on the local calendar date, calculated in UTC to avoid DST-length days.
export function formatClock(date: Date): { time: string; date: string } {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()];
  const pad = (value: number) => String(value).padStart(2, "0");
  return { time: `${pad(date.getHours())}:${pad(date.getMinutes())}`, date: `${month} ${date.getDate()}  ${weekday}  Week ${week}` };
}
// Milliseconds to the next whole minute (a clock that shows minutes changes only then), never 0 so a tick is never scheduled for "now".
export const msToNextMinute = (now: number): number => 60_000 - (((now % 60_000) + 60_000) % 60_000);

export const clockWidget: WidgetType = {
  type: "clock", forms: ["time"], interactive: false,
  minSize: { w: 240, h: 120 }, maxSize: { w: 240, h: 120 },
  create() {
    const time = make("time", { className: "clock-time" });
    const monthDay = make("span", { attrs: { "aria-hidden": "true" } }), weekday = make("span", { attrs: { "aria-hidden": "true" } }), week = make("span", { attrs: { "aria-hidden": "true" } });
    const date = make("span", { className: "clock-date", attrs: { role: "group" } }, monthDay, weekday, week);
    const element = make("div", { className: "w-clock", attrs: { "data-extra": "true" } }, time, date);
    let timer: ReturnType<typeof setTimeout> | undefined;
    function show() {
      const now = new Date(), shown = formatClock(now);
      time.textContent = shown.time; time.setAttribute("datetime", now.toISOString());
      const groups = shown.date.split("  ");
      monthDay.textContent = groups[0]!; weekday.textContent = groups[1]!; week.textContent = groups[2]!;
      date.setAttribute("aria-label", shown.date);
    }
    // Ticks on the minute boundary, and not at all while the page is hidden; becoming visible shows the right time at once and re-aligns.
    function schedule() {
      clearTimeout(timer); timer = undefined;
      if (typeof document !== "undefined" && document.hidden) return;
      timer = setTimeout(() => { timer = undefined; show(); schedule(); }, msToNextMinute(Date.now()));
    }
    const visibility = () => { if (typeof document !== "undefined" && !document.hidden) show(); schedule(); };
    document.addEventListener?.("visibilitychange", visibility);
    show(); schedule();
    return {
      element,
      update() { /* The clock reads the time, not the desk. */ },
      destroy() { clearTimeout(timer); timer = undefined; document.removeEventListener?.("visibilitychange", visibility); element.remove(); },
    };
  },
};

// ---- S10 text ----------------------------------------------------------------------------------------------------------------------------------

// The words are put in with textContent, so whatever is typed (markup included) is shown as plain text. An empty text shows nothing.
export const textWidget: WidgetType = {
  type: "text", forms: ["title", "note"], interactive: false,
  minSize: { w: 40, h: 20 }, maxSize: { w: 1400, h: 120 },
  formLimits: { title: { minSize: { w: 60, h: 28 }, maxSize: { w: 1400, h: 120 } }, note: { minSize: { w: 40, h: 20 }, maxSize: { w: 1400, h: 96 } } },
  create({ form }) {
    // The words sit in an inner span so the box (the container) can size them.
    const body = make("span", { className: "w-text-body" });
    const element = make("div", { className: "w-text", attrs: { "data-extra": "true", "data-form": form === "title" ? "title" : "note" } }, body);
    return {
      element,
      update() { /* The words come from the placement (words()), not from the desk. */ },
      words(value: string) { if (body.textContent !== value) body.textContent = value; },
      destroy() { element.remove(); },
    };
  },
};
