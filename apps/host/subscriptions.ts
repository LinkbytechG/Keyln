import { spawn } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { managedProcess } from "./process.js";
import { parseQuotaWindows, type QuotaWindow, type SubscriptionProvider, type SubscriptionSnapshot } from "../../packages/contracts/subscription.js";

export const QUOTA_REFRESH_MS = 120_000, QUOTA_STALE_MS = 300_000;
const dict = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const accountKey = (v: Record<string, unknown>) => createHash("sha256").update(JSON.stringify([v.authMethod, v.email, v.orgId, v.orgUuid, v.subscriptionType])).digest("hex");
export function executable(name: SubscriptionProvider, env = process.env, home = homedir()): string | undefined {
  const override = env[name === "codex" ? "KEYLN_CODEX_PATH" : "KEYLN_CLAUDE_PATH"];
  const candidates = override !== undefined ? [override] : [
    ...((env.PATH ?? "").split(":").filter(isAbsolute).slice(0,64).map(dir => join(dir, name))),
    join(home, ".local/bin", name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`,
    ...(name === "codex" ? ["/Applications/Codex.app/Contents/Resources/codex", "/Applications/ChatGPT.app/Contents/Resources/codex"] : []),
  ];
  return [...new Set(candidates)].find(path => { try { if (!isAbsolute(path) || !statSync(path).isFile()) return false; accessSync(path, constants.X_OK); return true; } catch { return false; } });
}
// A short-lived stdio connection, restricted to initialization and two read methods. No threads, turns, tools or login RPCs.
export function codexQuota(file: string, signal: AbortSignal, timeoutMs = 12_000): Promise<{ account: Record<string, unknown>; limits: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Quota read canceled.")); return; }
    const child = spawn(file, ["app-server", "--stdio"], { detached: true, stdio: ["pipe", "pipe", "pipe"], cwd: homedir() });
    let buffer = "", bytes = 0, finished = false, result: { account: Record<string, unknown>; limits: Record<string, unknown> } | undefined;
    let failure: Error | undefined, account: Record<string, unknown> = {};
    let stage = 1;
    const timer = setTimeout(() => end(new Error("Quota read timed out.")), timeoutMs);
    let killTimer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
    function kill(s: NodeJS.Signals) { if (child.pid) try { process.kill(-child.pid, s); } catch { /* The owned child has already exited. */ } }
    function settle() {
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(closeTimer); signal.removeEventListener("abort", aborted);
      if (failure || !result) reject(failure ?? new Error("Quota read failed.")); else resolve(result);
    }
    function end(error?: Error) {
      if (finished) return; finished = true; failure = error;
      clearTimeout(timer); kill("SIGTERM");
      killTimer = setTimeout(() => { kill("SIGKILL"); closeTimer = setTimeout(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); settle(); }, 400); }, 200);
    }
    const send = (message: unknown) => { if (!finished) child.stdin.write(JSON.stringify(message) + "\n"); };
    function aborted() { end(new Error("Quota read canceled.")); }
    signal.addEventListener("abort", aborted, { once: true });
    child.stdin.on("error", () => end(new Error("Quota read failed.")));
    child.once("error", () => end(new Error("Quota tool could not start.")));
    child.once("close", () => { if (!finished) { finished = true; failure = new Error("Quota tool stopped."); } settle(); });
    // Both streams are bounded and discarded after parsing; upstream errors, emails and credentials are never surfaced.
    child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 524288) end(new Error("Quota response too large.")); });
    child.stdout.on("data", (chunk: Buffer) => {
      if (finished) return;
      bytes += chunk.length; if (bytes > 524288) { end(new Error("Quota response too large.")); return; }
      buffer += chunk.toString("utf8");
      for (;;) {
        const at = buffer.indexOf("\n"); if (at < 0) break;
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let msg: Record<string, unknown>; try { msg = dict(JSON.parse(line)); } catch { end(new Error("Invalid quota response.")); return; }
        // Never service any server-initiated request, approval or notification.
        if (msg.id !== stage) continue;
        if (msg.error && stage === 3) {
          const authRequired = /401|unauthoriz|authentication|token.*expired|refresh_token/i.test(String(dict(msg.error).message ?? ""));
          result = { account, limits: { readFailed: true, authRequired } }; end(); return;
        }
        if (msg.error) { end(new Error("Quota service unavailable.")); return; }
        if (msg.id === 1) {
          stage = 2;
          send({ method: "initialized" }); send({ id: 2, method: "account/read", params: { refreshToken: false } });
        } else if (msg.id === 2) {
          account = dict(dict(msg.result).account);
          if (account.type !== "chatgpt") { result = { account, limits: {} }; end(); }
          else { stage = 3; send({ id: 3, method: "account/rateLimits/read" }); }
        } else if (msg.id === 3) { result = { account, limits: dict(msg.result) }; end(); }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "keyln_subscription_usage", title: "Keyln subscription quota", version: "0.1.0" } } });
  });
}
export function codexWindows(limits: Record<string, unknown>): QuotaWindow[] {
  const all = dict(limits.rateLimitsByLimitId), rows = Object.keys(all).length ? Object.entries(all).slice(0,4) : [["codex", limits.rateLimits] as const];
  const windows: QuotaWindow[] = [];
  for (const [bucket, raw] of rows) {
    if (!/^[a-zA-Z0-9_.:-]{1,60}$/.test(bucket)) continue;
    const snapshot = dict(raw);
    for (const name of ["primary", "secondary"] as const) {
      if (snapshot[name] === undefined || snapshot[name] === null) continue;
      const w = dict(snapshot[name]), minutes = w.windowDurationMins ?? null;
      const cadence = minutes === 300 ? "5-hour" : minutes === 10080 ? "Weekly" : typeof minutes === "number" ? minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute` : name === "primary" ? "Current window" : "Other window";
      windows.push(...parseQuotaWindows([{ id: `${bucket}:${name}`, label: rows.length > 1 ? `${bucket.slice(0,28)} · ${cadence}` : cadence,
        usedPercent: w.usedPercent, windowMinutes: minutes, resetsAt: w.resetsAt === undefined || w.resetsAt === null ? null : typeof w.resetsAt === "number" ? w.resetsAt * 1000 : NaN }]));
    }
  }
  return parseQuotaWindows(windows);
}
// Claude Code's own structured /usage read: one get_usage control request over print-mode stream-json, then stdin closes.
// It sends no prompt, so there is no model turn; --restricted skips user/project hooks and plugins, and no tools, MCP servers or transcript are loaded.
export const CLAUDE_USAGE_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--restricted", "--strict-mcp-config", "--no-session-persistence", "--tools", ""];
// Claude Code finds its saved login in the Keychain by USER. A login-startup job only has HOME/PATH, which reads as signed out.
export const claudeEnv = (env = process.env): NodeJS.ProcessEnv => {
  const user = env.USER || userInfo().username;
  return { ...env, USER: user, LOGNAME: env.LOGNAME || user, DISABLE_AUTOUPDATER: "1" };
};
export async function claudeUsage(file: string, signal: AbortSignal, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const input = Buffer.from(JSON.stringify({ type: "control_request", request_id: "keyln-usage", request: { subtype: "get_usage", skip_behaviors: true } }) + "\n");
  const result = await managedProcess(file, CLAUDE_USAGE_ARGS, { signal, timeoutMs, outputLimit: 65536, cwd: homedir(), env: claudeEnv(), input });
  if (result.truncated) throw new Error("Claude usage response too large.");
  for (const line of result.stdout.toString("utf8").split("\n")) {
    let msg: Record<string, unknown>; try { msg = dict(JSON.parse(line)); } catch { continue; }
    const reply = dict(msg.response);
    if (msg.type === "control_response" && reply.request_id === "keyln-usage") {
      if (reply.subtype !== "success") throw new Error("Claude usage unavailable.");
      return dict(reply.response);
    }
  }
  throw new Error("Claude usage unavailable.");
}
// Plan-wide windows only, the same two the status line reports. utilization is 0–100; resets_at is ISO 8601. A null utilization is unknown, not 0%.
export function claudeWindows(usage: Record<string, unknown>): QuotaWindow[] {
  const rate = dict(usage.rate_limits), windows: unknown[] = [];
  for (const [id, label, minutes] of [["five_hour", "5-hour", 300], ["seven_day", "Weekly", 10080]] as const) {
    const w = dict(rate[id]), used = w.utilization, reset = w.resets_at;
    if (used === undefined || used === null) continue;
    windows.push({ id, label, windowMinutes: minutes, usedPercent: typeof used === "number" && used > 100 ? 100 : used,
      resetsAt: reset === undefined || reset === null ? null : typeof reset === "string" ? Date.parse(reset) : NaN });
  }
  return parseQuotaWindows(windows);
}
export interface QuotaMeasurement { snapshot: SubscriptionSnapshot; identity?: string; failed?: boolean }
const empty = (provider: SubscriptionProvider, status: SubscriptionSnapshot["status"], now: number, reason?: SubscriptionSnapshot["reason"]): SubscriptionSnapshot => ({ provider, status, windows: [], updatedAt: null, checkedAt: now, source: null, ...(reason ? { reason } : {}) });
export async function collectSubscription(provider: SubscriptionProvider, dataDir: string, signal: AbortSignal, now = Date.now()): Promise<QuotaMeasurement> {
  const file = executable(provider);
  if (!file) return { snapshot: empty(provider, "not-installed", now) };
  if (provider === "codex") {
    const { account, limits } = await codexQuota(file, signal);
    if (!account.type) return { snapshot: empty(provider, "sign-in", now) };
    if (account.type !== "chatgpt" || account.planType === "free") return { snapshot: empty(provider, "not-subscribed", now) };
    const identity = createHash("sha256").update(JSON.stringify([account.type, account.email, account.id, account.planType])).digest("hex");
    if (limits.authRequired) return { snapshot: empty(provider, "sign-in", now) };
    if (limits.readFailed) return { identity, failed: true, snapshot: empty(provider, "unavailable", now, "read-failed") };
    const windows = codexWindows(limits);
    return { identity, snapshot: windows.length ? { provider, status: "ready", windows, updatedAt: Date.now(), checkedAt: Date.now(), source: "codex-app-server" } : empty(provider, "unavailable", now, "no-quota") };
  }
  const authResult = await managedProcess(file, ["auth", "status", "--json"], { signal, timeoutMs: 4000, outputLimit: 32768, env: claudeEnv() });
  if (authResult.reason || authResult.truncated) throw new Error("Claude authentication status unavailable.");
  let auth: Record<string, unknown>; try { auth = dict(JSON.parse(authResult.stdout.toString("utf8"))); } catch { throw new Error("Claude authentication status unavailable."); }
  if (auth.loggedIn !== true) return { snapshot: empty(provider, "sign-in", now) };
  if (auth.authMethod !== "claude.ai" || auth.subscriptionType === "free") return { snapshot: empty(provider, "not-subscribed", now) };
  const identity = accountKey(auth), path = join(dataDir, "subscription-usage", "claude.json");
  // "none" = Claude Code answered that plan limits do not apply to this login; anything else unanswered is a failed read.
  let answer: "windows" | "none" | "failed" = "failed", live: QuotaWindow[] = [];
  try {
    const usage = await claudeUsage(file, signal);
    live = claudeWindows(usage); answer = live.length ? "windows" : usage.rate_limits_available === false ? "none" : "failed";
  } catch { if (signal.aborted) throw new Error("Quota read canceled."); }
  if (answer === "windows") return { identity, snapshot: { provider, status: "ready", windows: live, updatedAt: Date.now(), checkedAt: Date.now(), source: "claude-code-usage" } };
  // Older Claude Code without get_usage, or a usage-endpoint failure: fall back to the opt-in status-line capture when one exists.
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("Unsafe capture file.");
    const raw = dict(JSON.parse(readFileSync(path, "utf8")));
    if (raw.version !== 1 || raw.account !== identity) return { identity, snapshot: empty(provider, "unavailable", now, "no-quota") };
    const updatedAt = raw.observedAt;
    if (typeof updatedAt !== "number" || !Number.isSafeInteger(updatedAt) || updatedAt < 1 || updatedAt > now + 5000) throw new Error("Invalid capture time.");
    const windows = parseQuotaWindows(raw.windows);
    return { identity, snapshot: windows.length ? { provider, status: now - updatedAt > QUOTA_STALE_MS ? "stale" : "ready", windows, updatedAt, checkedAt: now, source: "claude-statusline" } : empty(provider, "unavailable", now, "no-quota") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && answer === "none") return { identity, snapshot: empty(provider, "unavailable", now, "no-quota") };
    return { identity, failed: true, snapshot: empty(provider, "unavailable", now, "read-failed") };
  }
}
// One cache and at most one collection per provider for every paired device. No polling or subprocess without a request.
export class SubscriptionUsage {
  private readonly rows = new Map<SubscriptionProvider, QuotaMeasurement>();
  private readonly active = new Map<SubscriptionProvider, Promise<void>>();
  private readonly next = new Map<SubscriptionProvider, number>();
  private readonly abort = new AbortController();
  constructor(private readonly collect: (provider: SubscriptionProvider, signal: AbortSignal) => Promise<QuotaMeasurement>, private readonly now = Date.now) {}
  read(providers: SubscriptionProvider[]): SubscriptionSnapshot[] {
    for (const provider of providers) if (!this.abort.signal.aborted && !this.active.has(provider) && this.now() >= (this.next.get(provider) ?? 0)) {
      const work = this.refresh(provider); this.active.set(provider, work); void work.finally(() => this.active.delete(provider));
    }
    return providers.map(provider => {
      const snapshot = this.rows.get(provider)?.snapshot ?? empty(provider, "loading", this.now());
      return snapshot.status === "ready" && snapshot.updatedAt !== null && this.now() - snapshot.updatedAt > QUOTA_STALE_MS ? { ...snapshot, status: "stale" as const } : { ...snapshot, windows: snapshot.windows.map(w => ({ ...w })) };
    });
  }
  private async refresh(provider: SubscriptionProvider) {
    try {
      const next = await this.collect(provider, this.abort.signal), previous = this.rows.get(provider);
      if (next.failed && next.identity && next.identity === previous?.identity && previous.snapshot.windows.length)
        this.rows.set(provider, { identity: next.identity, snapshot: { ...previous.snapshot, status: "stale", checkedAt: this.now(), reason: "read-failed" } });
      else this.rows.set(provider, next);
      this.next.set(provider, this.now() + (next.failed ? 30000 : QUOTA_REFRESH_MS));
    } catch {
      // An unverified failure may be a changed account. Do not reuse another identity's last balance.
      this.rows.set(provider, { snapshot: empty(provider, "unavailable", this.now(), "read-failed") });
      this.next.set(provider, this.now() + 30_000);
    }
  }
  async stop() { this.abort.abort(); await Promise.allSettled(this.active.values()); }
}
