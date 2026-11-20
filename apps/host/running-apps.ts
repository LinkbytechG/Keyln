import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exact, record, parseDockApps, type DockApp, type RunningApps as RunningAppsReply } from "../../packages/contracts/index.js";

// T115 (ADR-099): the Mac apps the Dock bar shows. A long-running native observer prints full, ordered snapshots; this service validates them strictly and keeps the latest.
// It runs only while at least one layout shows the Dock (wanted(true)). Read-only: it never launches, activates or changes anything.
const MAX_LINE = 65_536, MAX_LINES_PER_MINUTE = 1200, MAX_FAILURES = 8;
type Status = "off" | "starting" | "ready" | "unavailable";
interface Options { now?: () => number; child?: () => ChildProcess; retryMs?: number; log?: (message: string) => void }
export class RunningApps {
  private apps: DockApp[] = [];
  private status: Status = "off";
  private child?: ChildProcess;
  private retry?: ReturnType<typeof setTimeout>;
  private wantedNow = false;
  private stopping = false;
  private failures = 0;
  private serial = 0;
  private listeners = new Set<() => void>();
  private readonly now: () => number;
  constructor(private options: Options = {}) { this.now = options.now ?? Date.now; }
  /** The reply of /api/running-apps: "ready" only while the observer has sent a valid snapshot. */
  snapshot(): RunningAppsReply {
    if (this.status === "ready") return { status: "ready", apps: this.apps.map(app => ({ ...app })) };
    // Only the first start after wanted(true) is "starting"; a restart after a failure stays "unavailable" so the page does not flicker between the two.
    return { status: this.status === "starting" && this.failures === 0 ? "starting" : "unavailable", apps: [] };
  }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify() { for (const listener of this.listeners) { try { listener(); } catch { /* One observer never affects another. */ } } }
  /** Start observing while some layout shows the Dock; stop (and forget the list) when none does. */
  wanted(value: boolean) {
    if (this.stopping || value === this.wantedNow) return;
    this.wantedNow = value;
    if (value) { this.failures = 0; this.launch(); return; }
    clearTimeout(this.retry); this.retry = undefined; this.serial++;
    const child = this.child; this.child = undefined; child?.kill("SIGKILL");
    this.apps = []; this.status = "off"; this.notify();
  }
  private launch() {
    if (this.stopping || !this.wantedNow || this.child) return;
    this.status = "starting";
    let child: ChildProcess;
    try { child = this.options.child?.() ?? spawn(fileURLToPath(new URL("../../keyln-helper", import.meta.url)), ["observe-running-apps"], { stdio: ["ignore", "pipe", "pipe"] }); }
    catch { this.failed(); return; }
    this.child = child;
    const serial = ++this.serial, log = this.options.log ?? (() => {});
    let buffer = "", bytes = 0, count = 0, since = this.now(), bad = false, ready = false, readyAt: number | undefined;
    const reject = () => { if (bad) return; bad = true; log("Running apps observer sent invalid data and was stopped."); child.kill("SIGKILL"); };
    const startup = setTimeout(reject, 5000); startup.unref();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (bad || this.child !== child || serial !== this.serial) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_LINE * 2) { reject(); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_LINE) { reject(); return; }
        if (this.now() - since >= 60_000) { since = this.now(); count = 0; }
        if (++count > MAX_LINES_PER_MINUTE) { reject(); return; }
        try {
          const obj = record(JSON.parse(line));
          if (obj.type === "ready") { exact(obj, ["type"]); if (ready) throw Error("Duplicate ready."); ready = true; readyAt ??= this.now(); }
          else {
            exact(obj, ["type", "apps"]);
            if (obj.type !== "apps" || !ready) throw Error("Invalid snapshot.");
            const apps = parseDockApps(obj.apps);
            clearTimeout(startup);
            if (this.status !== "ready" || JSON.stringify(apps) !== JSON.stringify(this.apps)) { this.apps = apps; this.status = "ready"; this.notify(); }
          }
        } catch { reject(); return; }
      }
      if (Buffer.byteLength(buffer) > MAX_LINE) reject();
    });
    child.stderr?.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4096) reject(); });
    // Error is followed by close for a failed spawn. Only close schedules a replacement.
    child.on("error", () => { /* close follows */ });
    child.once("close", () => {
      clearTimeout(startup);
      if (!bad && readyAt !== undefined && this.now() - readyAt >= 30_000) this.failures = 0;
      if (this.child !== child) return;
      this.child = undefined;
      if (!this.stopping && this.wantedNow) this.failed();
    });
  }
  private failed() {
    this.apps = []; this.status = "unavailable"; this.notify();
    if (this.stopping || !this.wantedNow || this.retry || ++this.failures >= MAX_FAILURES) return;
    const delay = Math.min(60_000, (this.options.retryMs ?? 1000) * 2 ** Math.min(this.failures - 1, 6));
    this.retry = setTimeout(() => { this.retry = undefined; this.launch(); }, delay); this.retry.unref();
  }
  terminate() { this.stopping = true; clearTimeout(this.retry); this.retry = undefined; this.child?.kill("SIGKILL"); }
  async stop() {
    this.stopping = true; clearTimeout(this.retry); this.retry = undefined;
    const child = this.child; this.child = undefined; if (!child) return;
    await new Promise<void>(resolve => {
      let force: ReturnType<typeof setTimeout>, deadline: ReturnType<typeof setTimeout>;
      const finish = () => { clearTimeout(force); clearTimeout(deadline); resolve(); };
      child.once("close", finish); child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), 500);
      deadline = setTimeout(finish, 1500);
    });
  }
}
