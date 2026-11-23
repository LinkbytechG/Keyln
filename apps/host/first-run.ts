import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { adoptApp, appLifecycle, selfApp, type AppInstallLifecycle, type AppProblem } from "./app-service.js";
import { hostAlive, loadedService, readService, stopService, restoreServiceStartup, type ServicePaths } from "./service.js";
import { atomicBytes } from "./store.js";
import { caFingerprint, candidateAddresses, derCertificate, readHostSettings, runSetup, type Candidate, type SetupOptions } from "./setup.js";
import { ready } from "./service-cli.js";

// T124 (ADR-108): everything the menu bar app's first run may ask of Node. Each function takes no path from the caller except the export target.
export interface SetupInfo {
  configured: boolean; address: string | null; port: number | null; origin: string | null;
  candidates: Candidate[]; caFingerprint: string | null;
  selfApp: string | null; selfAppProblem: AppProblem | null;
  manifestApp: string | null; manifestMatchesSelf: boolean; layout: "app" | "legacy" | null; running: boolean;
}
function sameFile(a: string, b: string) { try { return realpathSync(a) === realpathSync(b); } catch { return a === b; } }
export function setupInfo(paths: ServicePaths, moduleUrl: string): SetupInfo {
  const host = readHostSettings(paths.data), self = selfApp(moduleUrl);
  let manifestApp: string | null = null, layout: SetupInfo["layout"] = null;
  try {
    const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as { schemaVersion?: number; app?: unknown };
    if (manifest.schemaVersion === 2) { layout = "app"; manifestApp = typeof manifest.app === "string" ? manifest.app : null; }
    else if (manifest.schemaVersion === 1) layout = "legacy";
  } catch { /* no manifest, or one we cannot read */ }
  let running: boolean;
  try { running = hostAlive(paths.data) || loadedService(paths).pid !== null; } catch { running = true; } // an unreadable lock is treated as a running Host
  return { configured: host !== null, address: host?.address ?? null, port: host?.port ?? null, origin: host?.origin ?? null,
    candidates: candidateAddresses(), caFingerprint: caFingerprint(paths.data),
    selfApp: self.app, selfAppProblem: self.problem, manifestApp,
    manifestMatchesSelf: !!(self.app && self.problem === null && layout === "app" && manifestApp && sameFile(manifestApp, self.app)), layout, running };
}

export type ServiceControl = Pick<AppInstallLifecycle, "state" | "start" | "stop" | "ready" | "restore">;
export const realControl = (): AppInstallLifecycle => ({
  ...appLifecycle(ready, () => {}),
  // A moved app leaves a manifest whose app is gone; stopping must still work so the service can be pointed at the new place.
  stop: paths => stopService(paths, false),
  restore: async (paths, state) => {
    try { await restoreServiceStartup(paths, state); }
    catch (error) { let readable = true; try { readService(paths); } catch { readable = false; } if (readable) throw error; /* the previous installation was already broken; its files are back */ }
  },
});

export async function setupCommand(paths: ServicePaths, options: Pick<SetupOptions, "address" | "port" | "interfaces" | "checkPort">, isRunning: () => boolean = () => loadedService(paths).pid !== null) {
  if (isRunning() || hostAlive(paths.data)) throw new Error("Stop Keyln before changing its setup.");
  const result = await runSetup({ data: paths.data, ...options });
  return { origin: result.origin, caFingerprint: result.caFingerprint };
}

/** Install the app that contains this runtime as the login service, in place. Takes no path argument. */
export function installSelf(paths: ServicePaths, moduleUrl: string, control: AppInstallLifecycle = realControl()) {
  const self = selfApp(moduleUrl);
  if (!self.app) throw new Error("Keyln is not running from an app bundle.");
  return adoptApp(paths, self.app, control);
}

const SNAPSHOT = ["host.json", "tls/server.key", "tls/server.pem"];
export async function changeAddress(paths: ServicePaths, options: Pick<SetupOptions, "address" | "port" | "interfaces" | "checkPort">, control: ServiceControl = realControl()) {
  const installed = existsSync(paths.manifest), state = control.state(paths), wasRunning = state.running || hostAlive(paths.data);
  const before = SNAPSHOT.map(name => [name, existsSync(join(paths.data, name)) ? readFileSync(join(paths.data, name)) : null] as const);
  const restoreFiles = () => { for (const [name, bytes] of before) { const file = join(paths.data, name); if (bytes) atomicBytes(file, bytes); else rmSync(file, { force: true }); } };
  const restart = async () => { if (wasRunning) { await control.start(paths); await control.ready(paths.data); } };
  if (installed && wasRunning) await control.stop(paths);
  let result;
  try { result = await runSetup({ data: paths.data, ...options }); }
  catch (error) {
    try { restoreFiles(); if (installed) await restart(); }
    catch (restoreError) { throw new Error(`Change failed: ${String(error)}. The previous service could not be restored: ${String(restoreError)}`); }
    throw error;
  }
  if (installed && wasRunning) {
    try { await control.start(paths); await control.ready(paths.data); }
    catch (error) {
      try { await control.stop(paths); restoreFiles(); await restart(); }
      catch (restoreError) { throw new Error(`The service did not start at the new address: ${String(error)}. The previous address could not be restored: ${String(restoreError)}`); }
      throw new Error(`The service did not start at the new address, so the previous address was restored. ${String(error)}`);
    }
  }
  return { origin: result.origin, caFingerprint: result.caFingerprint, repairRequired: true,
    note: "The certificate authority is unchanged, so devices keep trusting it, but they must open the new address and be paired again." };
}

/** Write the public CA certificate as DER. Refuses anything inside the data folder. */
export function exportCertificate(data: string, out: string) {
  if (!isAbsolute(out) || !/\.cer$/i.test(out)) throw new Error("Use an absolute path ending in .cer.");
  const target = resolve(out), folder = realpathSync(dirname(target)), root = realpathSync(data);
  const inside = relative(root, join(folder, basename(target)));
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) throw new Error("Choose a place outside the Keyln data folder.");
  try { if (lstatSync(target).isDirectory()) throw new Error("That path is a folder."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const bytes = derCertificate(data), fingerprint = caFingerprint(data)!;
  const temporary = join(folder, `.${basename(target)}.${randomUUID()}.tmp`);
  try { writeFileSync(temporary, bytes, { flag: "wx", mode: 0o644 }); chmodSync(temporary, 0o644); renameSync(temporary, join(folder, basename(target))); }
  finally { rmSync(temporary, { force: true }); }
  return { path: join(folder, basename(target)), fingerprint };
}
