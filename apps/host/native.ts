import { execFile } from "node:child_process";
import { appId, Fault, label, parseAction, parseWindows, type WindowInfo, type WindowAction, type AppInfo, type BasicAction } from "../../packages/contracts/index.js";
import type { ActionResult, Adapter } from "./scheduler.js";
import { appIconIds, MAX_APP_ICON_BYTES, MAX_ICON_REPLY_BYTES, validateAppIcon } from "./app-icons.js";
import { helperPath } from "./helper-path.js";

const helper = helperPath(import.meta.url);
function invoke(args: string[], signal?: AbortSignal, maxBuffer = 512 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(helper, args, { signal, timeout: 10_000, killSignal: "SIGKILL", maxBuffer }, (error, stdout) => {
      if (error && (error.killed || error.name === "AbortError" || !stdout)) return reject(error);
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Invalid native helper response.")); }
    });
  });
}
export async function installedApps(): Promise<AppInfo[]> {
  const data = await invoke(["list"]);
  if (!Array.isArray(data)) throw new Error("Could not read installed Mac applications.");
  return data.map(item => ({ id: appId(item.id), name: label(item.name, 200) }));
}
export async function nativeDiagnostics(): Promise<unknown> { return await invoke(["doctor"]); }
export async function nativeAppIcon(id: string): Promise<Buffer> {
  const result = await invoke(["icon", appId(id)]) as { png?: unknown };
  return decodeAppIcon(result?.png);
}
function decodeAppIcon(png: unknown): Buffer {
  if (typeof png !== "string" || png.length > Math.ceil(MAX_APP_ICON_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(png)) throw new Fault("ICON_UNAVAILABLE", "This Mac icon is unavailable.", 503);
  const data = Buffer.from(png, "base64");
  if (data.toString("base64") !== png) throw new Fault("ICON_UNAVAILABLE", "Invalid Mac icon encoding.", 503);
  return validateAppIcon(data);
}
export async function nativeAppIcons(values: string[]): Promise<Map<string, Buffer>> {
  // Foundation may escape each '/' in base64. The canonical HTTP JSON still has the smaller limit.
  const ids = appIconIds(values), result = await invoke(["icons", ...ids], undefined, MAX_ICON_REPLY_BYTES * 2) as {icons?: unknown};
  if (!Array.isArray(result?.icons) || result.icons.length !== ids.length)
    throw new Fault("ICON_UNAVAILABLE", "Invalid Mac icon batch.", 503);
  const found = new Map<string, Buffer>(), seen = new Set<string>();
  for (const item of result.icons) {
    if (!item || !ids.includes(item.appId) || seen.has(item.appId)) throw new Fault("ICON_UNAVAILABLE", "Invalid Mac icon batch.", 503);
    seen.add(item.appId);
    if (item.png !== undefined) found.set(item.appId, decodeAppIcon(item.png));
    else if (!["APP_UNAVAILABLE", "ICON_UNAVAILABLE"].includes(item.code)) throw new Fault("ICON_UNAVAILABLE", "Invalid Mac icon batch.", 503);
  }
  return found;
}
export async function applicationWindows(id: string): Promise<WindowInfo[]> {
  const data = await invoke(["windows", appId(id)]);
  if (!Array.isArray(data)) {
    const result = data as ActionResult;
    if (result?.ok === false && typeof result.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(result.code) && typeof result.message === "string")
      throw new Fault(result.code, result.message.slice(0, 300), 409);
    throw new Fault("WINDOW_LIST_UNAVAILABLE", "The Mac could not read this application's open windows.", 503);
  }
  return parseWindows(data);
}
export const nativeAdapter: Adapter & {runTargeted(action:Extract<BasicAction,{type:"keyboard.shortcut"}>,target:string|WindowAction,signal:AbortSignal):Promise<ActionResult>} = {
  async runTargeted(action,target,signal){
    const parsed=parseAction(action);if(parsed.type!=="keyboard.shortcut")throw Error("Expected a keyboard action.");
    const binding = typeof target === "string" ? ["shortcut-target", appId(target)] : (() => {
      const rule = parseAction(target); if (rule.type !== "window.activate") throw Error("Expected a window target.");
      return ["shortcut-window", rule.appId, rule.match, rule.title, ...(rule.path !== undefined ? [rule.path] : [])];
    })();
    const result=await invoke([...binding,parsed.key,parsed.modifiers.join(",")],signal) as ActionResult;
    if(!result||typeof result.ok!=="boolean"||typeof result.message!=="string")throw Error("Invalid helper result.");
    return {ok:result.ok,code:result.code,message:result.message.slice(0,300)};
  },
  async run(input, signal): Promise<ActionResult> {
    const action = parseAction(input);
    if (action.type !== "app.open" && action.type !== "keyboard.shortcut" && action.type !== "window.activate") throw new Error("This action requires its own Host adapter.");
    const args = action.type === "app.open" ? ["open", action.appId] : action.type === "window.activate" ?
      ["window-activate", action.appId, action.match, action.title, ...(action.path !== undefined ? [action.path] : [])] : ["shortcut", action.key, action.modifiers.join(",")];
    const result = await invoke(args, signal) as ActionResult;
    if (!result || typeof result.ok !== "boolean" || typeof result.message !== "string") throw new Error("Invalid helper result.");
    if (result.code === "LAUNCH_UNCONFIRMED") throw new Error("Native launch result unknown.");
    return { ok: result.ok, code: result.code, message: result.message.slice(0, 300), ...(result.code === "WINDOW_FOCUS_UNCONFIRMED" ? {unknown: true} : {}) };
  },
};
