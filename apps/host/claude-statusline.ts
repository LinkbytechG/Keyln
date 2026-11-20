// Copied as a standalone .mjs by scripts/subscriptions.mjs. Node built-ins only; no Keyln runtime dependency.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function captureStatus(payload: unknown, authentication: unknown, previous: unknown, now = Date.now()) {
  const data = obj(payload), auth = obj(authentication), rate = obj(data.rate_limits), old = obj(previous);
  if (auth.loggedIn !== true || auth.authMethod !== "claude.ai" || auth.subscriptionType === "free") return undefined;
  const account = hash([auth.authMethod, auth.email, auth.orgId, auth.orgUuid, auth.subscriptionType]);
  const windows: Array<{ id: string; label: string; usedPercent: number; windowMinutes: number; resetsAt: number }> = [];
  for (const [id, label, minutes] of [["five_hour", "5-hour", 300], ["seven_day", "Weekly", 10080]] as const) {
    if (rate[id] === undefined || rate[id] === null) continue;
    const w = obj(rate[id]), used = w.used_percentage, reset = w.resets_at;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100 || typeof reset !== "number" || !Number.isSafeInteger(reset) || reset < 1 || reset * 1000 > 8.64e15) return undefined;
    windows.push({ id, label, usedPercent: used, windowMinutes: minutes, resetsAt: reset * 1000 });
  }
  // An idle status-line timer does not fetch the service. Repeated identical response metadata must not freshen an old balance.
  if (!windows.length) return undefined;
  const sample = hash([data.session_id, data.prompt_id, obj(data.cost).total_api_duration_ms, windows]);
  const observedAt = old.account === account && old.sample === sample && typeof old.observedAt === "number" && old.observedAt <= now ? old.observedAt : now;
  return { version: 1, account, sample, observedAt, windows };
}
function privateJSON(path: string): Record<string, unknown> {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144 || stat.uid !== process.getuid?.() || stat.mode & 0o077) return {};
    return obj(JSON.parse(readFileSync(path, "utf8")));
  } catch { return {}; }
}
function bounded(file: string, args: string[], input?: Buffer): Promise<{ code: number | null; stdout: Buffer }> {
  return new Promise(resolve => {
    const child = spawn(file, args, { detached: true, stdio: ["pipe", "pipe", "ignore"] });
    let size = 0, done = false; const chunks: Buffer[] = [];
    const kill = (s: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, s); } catch { /* Gone. */ } };
    const timeout = setTimeout(() => { kill("SIGTERM"); timer = setTimeout(() => kill("SIGKILL"), 150); }, 2000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    function finish(code: number | null) { if (done) return; done = true; clearTimeout(timeout); clearTimeout(timer); kill("SIGKILL"); resolve({ code, stdout: Buffer.concat(chunks) }); }
    child.stdout.on("data", (chunk: Buffer) => { if (size + chunk.length <= 32768) chunks.push(chunk); size += chunk.length; if (size > 32768) kill("SIGTERM"); });
    child.once("error", () => finish(null)); child.once("close", finish); child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}
export async function runStatusline(dir: string) {
  const manifest = privateJSON(join(dir, "bridge.json"));
  if (manifest.version !== 1 || typeof manifest.claude !== "string") return;
  let size = 0; const chunks: Buffer[] = [];
  for await (const raw of process.stdin) { const b = Buffer.from(raw); size += b.length; if (size > 262144) return; chunks.push(b); }
  const input = Buffer.concat(chunks), original = obj(manifest.original);
  // Run precisely the owner's pre-existing command, with the same stdin, in parallel with capture. Never construct a command from payload data.
  const previousOutput = typeof original.command === "string" ? bounded("/bin/sh", ["-c", original.command], input) : undefined;
  let captured: ReturnType<typeof captureStatus>;
  try {
    const status = await bounded(manifest.claude, ["auth", "status", "--json"]);
    if (status.code === 0) captured = captureStatus(JSON.parse(input.toString("utf8")), JSON.parse(status.stdout.toString("utf8")), privateJSON(join(dir, "claude.json")));
    if (captured) {
      const path = join(dir, "claude.json"), temporary = `${path}.${randomUUID()}.tmp`;
      try { writeFileSync(temporary, JSON.stringify(captured) + "\n", { flag: "wx", mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, path); }
      finally { try { unlinkSync(temporary); } catch { /* Renamed, or no file was written. */ } }
    }
  } catch { /* Capture must not print paths, payloads, account information or errors to the terminal. */ }
  if (previousOutput) process.stdout.write((await previousOutput).stdout);
  else if (captured) process.stdout.write(captured.windows.map(w => `${w.label}: ${Math.round(100 - w.usedPercent)}% left`).join(" · "));
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runStatusline(dirname(fileURLToPath(import.meta.url))).catch(() => { process.exitCode = 0; });
}
