import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appId, exact, record, type AppInfo, type AppRecent } from "../../packages/contracts/index.js";
import { atomicJSON, privateDir } from "./store.js";
import { helperPath } from "./helper-path.js";

const MAX_ENTRIES = 2048, MAX_FILE = 1048576, MAX_LINE = 1024;
interface Entry { appId: string; at: number; order: number }
interface Options { now?: () => number; child?: () => ChildProcess; retryMs?: number; log?: (message: string) => void }
// Independent from configuration. A UI selection never calls recordActivation: only the native observer does.
export class AppUsage {
  readonly path: string;
  damagedCopy?: string;
  private entries = new Map<string, Entry>();
  private known: Set<string>;
  private order = 0;
  private child?: ChildProcess;
  private retry?: ReturnType<typeof setTimeout>;
  private writing?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private started = false;
  private dirty = false;
  private persistent = true;
  private status: AppRecent["status"] = "starting";
  private failures = 0;
  private last = "";
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  constructor(dir: string, apps: readonly AppInfo[], private options: Options = {}) {
    privateDir(dir); this.path = join(dir, "app-usage.json"); this.known = new Set(apps.map(app => app.id));
    this.now = options.now ?? Date.now; this.log = options.log ?? (message => console.error(message));
    if (!existsSync(this.path)) return;
    try {
      const stat = lstatSync(this.path); if (!stat.isFile() || stat.size > MAX_FILE) throw Error("Invalid usage file size.");
      const obj = exact(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(this.path))), ["format", "version", "entries"]);
      if (obj.format !== "keyln.app-usage" || obj.version !== 1 || !Array.isArray(obj.entries) || obj.entries.length > MAX_ENTRIES) throw Error("Invalid usage file.");
      const seen = new Set<string>();
      for (const value of obj.entries) {
        const item = exact(value, ["appId", "at", "order"]), id = appId(item.appId);
        if (seen.has(id) || !Number.isSafeInteger(item.at) || (item.at as number) < 0 || !Number.isSafeInteger(item.order) || (item.order as number) < 1) throw Error("Invalid usage entry.");
        seen.add(id); this.order = Math.max(this.order, item.order as number);
        if (this.known.has(id)) this.entries.set(id, { appId: id, at: item.at as number, order: item.order as number });
      }
    } catch {
      this.entries.clear(); this.order = 0;
      const copy = `${this.path}.corrupt-${randomUUID()}`;
      try { renameSync(this.path, copy); this.damagedCopy = copy; } catch { this.persistent = false; }
      this.log("App usage data is damaged; the original was preserved. Configuration was not changed.");
    }
  }
  snapshot(): AppRecent {
    return { status: this.status, appIds: [...this.entries.values()].sort((a, b) => b.order - a.order).map(entry => entry.appId),
      ...(this.status !== "observing" ? { message: "Mac app usage observation is unavailable. Saved usage is shown; unrecorded apps use name order." } : !this.persistent ? { message: "Mac app usage is observed but could not be saved. It may not survive a Host restart." } : {}) };
  }
  private recordActivation(id: string) {
    if (!this.known.has(id) || id === this.last) return;
    this.last = id;
    if (this.order >= Number.MAX_SAFE_INTEGER - 1) { const list = [...this.entries.values()].sort((a, b) => a.order - b.order); list.forEach((entry, index) => entry.order = index + 1); this.order = list.length; }
    this.entries.set(id, { appId: id, at: this.now(), order: ++this.order });
    if (this.entries.size > MAX_ENTRIES) { const oldest = [...this.entries.values()].sort((a, b) => a.order - b.order)[0]!; this.entries.delete(oldest.appId); }
    this.dirty = true;
    if (!this.writing) { this.writing = setTimeout(() => { this.writing = undefined; this.flush(); }, 250); this.writing.unref(); }
  }
  flush() {
    if (!this.dirty || !this.persistent) return;
    try { atomicJSON(this.path, { format: "keyln.app-usage", version: 1, entries: [...this.entries.values()] }); this.dirty = false; }
    catch { this.persistent = false; this.log("Mac app usage could not be saved. Configuration was not changed."); }
  }
  start() { if (this.started || this.stopping) return; this.started = true; this.launch(); }
  private launch() {
    if (this.stopping) return;
    this.status = "starting";
    let child: ChildProcess;
    try { child = this.options.child?.() ?? spawn(helperPath(import.meta.url), ["observe-app-activation"], { stdio: ["ignore", "pipe", "pipe"] }); }
    catch { this.failed(); return; }
    this.child = child;
    let readyAt: number | undefined;
    let buffer = "", bytes = 0, count = 0, since = this.now(), bad = false;
    const reject = () => { if (bad) return; bad = true; this.status = "unavailable"; child.kill("SIGKILL"); };
    const startup = setTimeout(reject, 5000); startup.unref();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (bad || this.stopping || this.child !== child) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_LINE * 64) { reject(); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_LINE) { reject(); return; }
        if (this.now() - since >= 60000) { since = this.now(); count = 0; }
        if (++count > 600) { reject(); return; }
        try {
          const obj = record(JSON.parse(line));
          if (obj.type === "ready") { exact(obj, ["type"]); this.status = "observing"; readyAt ??= this.now(); clearTimeout(startup); }
          else { exact(obj, ["type", "appId"]); if (obj.type !== "activated" || this.status !== "observing") throw Error("Invalid activation."); this.recordActivation(appId(obj.appId)); }
        } catch { reject(); return; }
      }
      if (Buffer.byteLength(buffer) > MAX_LINE) reject();
    });
    child.stderr?.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4096) reject(); });
    // Error is followed by close for a failed spawn. Only close schedules a replacement.
    child.on("error", () => { this.status = "unavailable"; });
    child.once("close", () => { clearTimeout(startup); if (!bad && readyAt !== undefined && this.now() - readyAt >= 30000) this.failures = 0; if (this.child !== child) return; this.child = undefined; if (!this.stopping) this.failed(); });
  }
  private failed() {
    this.status = "unavailable"; this.flush();
    if (this.stopping || this.retry || ++this.failures >= 8) return;
    const delay = Math.min(60000, (this.options.retryMs ?? 1000) * 2 ** Math.min(this.failures - 1, 6));
    this.retry = setTimeout(() => { this.retry = undefined; this.launch(); }, delay); this.retry.unref();
  }
  terminate() {
    this.stopping = true; clearTimeout(this.retry); clearTimeout(this.writing); this.retry = this.writing = undefined;
    this.flush(); this.child?.kill("SIGKILL");
  }
  async stop() {
    this.stopping = true; clearTimeout(this.retry); clearTimeout(this.writing); this.retry = this.writing = undefined;
    const child = this.child; this.flush(); if (!child) return;
    await new Promise<void>(resolve => {
      let force: ReturnType<typeof setTimeout>, deadline: ReturnType<typeof setTimeout>;
      const finish = () => { clearTimeout(force); clearTimeout(deadline); resolve(); };
      child.once("close", finish); child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), 500);
      deadline = setTimeout(finish, 1500);
    });
  }
}
