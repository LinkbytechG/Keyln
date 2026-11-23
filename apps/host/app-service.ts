import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { atomicBytes, atomicJSON, privateDir } from "./store.js";
import { appBundlePaths, appRuntimeOwned, hostAlive, owned, present, readService, serviceNodePath, servicePlist, startService, stopService, restoreServiceStartup, serviceStartupState,
  type ManifestV2, type ServicePaths, type ServiceStartupState } from "./service.js";

// T123 (ADR-107): install the self-contained Keyln.app and point the LaunchAgent at the Node and runtime inside it. The old <data>/runtime is never touched.
export const NODE_TEAM = "HX7739G8FX";
export function verifyBundle(app: string) {
  const bundle = appBundlePaths(app), codesign = (args: string[]) => execFileSync("/usr/bin/codesign", args, { encoding: "utf8", stdio: "pipe", timeout: 60000 });
  for (const file of [bundle.node, bundle.helper, join(app, "Contents/MacOS/Keyln"), join(bundle.runtime, "dist/apps/host/main.js"), join(bundle.runtime, "dist/apps/host/service-runner.js"), join(bundle.runtime, "node_modules/ws/package.json")])
    if (!statSync(file).isFile()) throw new Error("The app bundle is incomplete: " + file);
  appRuntimeOwned(bundle.runtime);
  codesign(["--verify", "--strict", "--deep", app]);
  // codesign -dv writes its details to stderr.
  const info = (path: string) => { const result = spawnSync("/usr/bin/codesign", ["-dv", path], { encoding: "utf8", timeout: 20000 }); return result.stderr ?? ""; };
  if (!new RegExp(`^TeamIdentifier=${NODE_TEAM}$`, "m").test(info(bundle.node))) throw new Error(`The bundled Node is not signed by team ${NODE_TEAM}; the app was not installed.`);
  if (!/^Identifier=local\.keyln\.helper$/m.test(info(bundle.helper))) throw new Error("The bundled helper has an unexpected signing identifier.");
  serviceNodePath(bundle.node);
  return bundle;
}
export interface AppInstall { manifest: ManifestV2; app: string; commit(): void; rollback(): void; finish(): void }
// Everything is copied and verified while the old service keeps running; only commit needs it stopped.
export function stageAppService(paths: ServicePaths, source: string, targetDir: string, quit: (installed: string) => void = () => {}, verify: (app: string) => unknown = verifyBundle): AppInstall {
  if (process.platform !== "darwin" || process.getuid?.() === 0) throw new Error("Install as the signed-in Mac user, without sudo.");
  if (!isAbsolute(targetDir)) throw new Error("Use an absolute application directory.");
  owned(paths.data, "directory"); if (present(paths.logs)) owned(paths.logs, "directory");
  const previous = present(paths.manifest) ? readService(paths) : undefined;
  if (present(paths.plist) && !previous) throw new Error("An unrecognized LaunchAgent exists. It was preserved.");
  for (const file of ["host.json", "tls/server.key", "tls/server.pem", "tls/rootCA.pem"]) owned(join(paths.data, file), "file");
  privateDir(paths.data); privateDir(paths.logs);
  const agents = join(paths.plist, ".."); mkdirSync(agents, { mode: 0o700, recursive: true }); owned(agents, "directory");
  mkdirSync(targetDir, { recursive: true });
  const installed = join(targetDir, "Keyln.app"), backup = join(targetDir, ".Keyln.app.previous");
  const stage = mkdtempSync(join(targetDir, ".Keyln-install-")), staged = join(stage, "Keyln.app"), held = join(stage, "old.app");
  const candidate = paths.plist + "." + randomUUID() + ".tmp", bundle = appBundlePaths(installed);
  const oldManifest = previous ? readFileSync(paths.manifest) : undefined, oldPlist = previous ? readFileSync(paths.plist) : undefined;
  const manifest: ManifestV2 = { schemaVersion: 2, label: paths.label, uid: process.getuid!(), node: bundle.node, data: paths.data, runtime: bundle.runtime, logs: paths.logs, plist: paths.plist, app: installed, installedAt: new Date().toISOString() };
  const cleanup = () => { rmSync(stage, { recursive: true, force: true }); rmSync(candidate, { force: true }); };
  try {
    cpSync(source, staged, { recursive: true, verbatimSymlinks: true });
    verify(staged);
    writeFileSync(candidate, servicePlist(paths, bundle.node, bundle.runtime), { flag: "wx", mode: 0o600 });
    execFileSync("/usr/bin/plutil", ["-lint", candidate], { stdio: "pipe", timeout: 4000 });
  } catch (error) { try { cleanup(); } catch (cleanupError) { throw new Error(`App staging failed: ${String(error)}. Temporary files could not be removed: ${String(cleanupError)}`); } throw error; }
  let oldMoved = false, newMoved = false, plistWritten = false, manifestWritten = false, finished = false;
  return { manifest, app: installed,
    commit() {
      if (finished || newMoved) throw new Error("This installation has already been committed.");
      if (hostAlive(paths.data)) throw new Error("A Host is running. Stop it before installing; no process was terminated.");
      quit(installed);
      if (present(installed)) { renameSync(installed, held); oldMoved = true; }
      renameSync(staged, installed); newMoved = true;
      // The directory was copied and verified under another name; the seal does not depend on the path, but check once more where it will run.
      verify(installed);
      renameSync(candidate, paths.plist); plistWritten = true;
      atomicJSON(paths.manifest, manifest); manifestWritten = true;
    },
    rollback() {
      if (finished) throw new Error("The installation has already finished.");
      const errors: string[] = [], attempt = (work: () => void) => { try { work(); } catch (error) { errors.push(String(error)); } };
      if (manifestWritten) attempt(() => { if (oldManifest) atomicBytes(paths.manifest, oldManifest); else rmSync(paths.manifest); manifestWritten = false; });
      if (plistWritten) attempt(() => { if (oldPlist) atomicBytes(paths.plist, oldPlist); else rmSync(paths.plist); plistWritten = false; });
      if (newMoved) attempt(() => { renameSync(installed, staged); newMoved = false; });
      if (oldMoved) attempt(() => { if (present(installed)) throw new Error("The new app could not be moved aside; the previous app is preserved at " + held); renameSync(held, installed); oldMoved = false; });
      if (!errors.length) attempt(cleanup);
      if (errors.length) throw new Error("App installation rollback could not finish; preserve the remaining staging files. " + errors.join("; "));
    },
    finish() {
      if (finished || !newMoved || !manifestWritten) throw new Error("There is no committed installation to finish.");
      if (oldMoved) {
        const retired = backup + ".retired-" + randomUUID(), hadBackup = present(backup);
        if (hadBackup) renameSync(backup, retired);
        try { renameSync(held, backup); oldMoved = false; } catch (error) { if (hadBackup) renameSync(retired, backup); throw error; }
        if (hadBackup) try { rmSync(retired, { recursive: true }); } catch { console.warn("Keyln updated; an older app was retained at " + retired); }
      }
      finished = true;
      try { cleanup(); } catch { console.warn("Keyln updated; temporary installation files could not all be removed."); }
    },
  };
}
export interface AppInstallLifecycle {
  state(paths: ServicePaths): ServiceStartupState;
  start(paths: ServicePaths): Promise<void>;
  stop(paths: ServicePaths): Promise<void>;
  ready(data: string): Promise<void>;
  restore(paths: ServicePaths, state: ServiceStartupState): Promise<void>;
  quit(installed: string): void;
  verify?(app: string): unknown; // tests only; the default is the full codesign and Node-team check
}
export const appLifecycle = (ready: (data: string) => Promise<void>, quit: (installed: string) => void): AppInstallLifecycle => ({ state: serviceStartupState, start: startService, stop: stopService, ready, restore: restoreServiceStartup, quit });
// Same transaction shape as installService: the old files and startup state come back if anything fails.
export async function installApp(paths: ServicePaths, source: string, targetDir: string, control: AppInstallLifecycle) {
  const previous = existsSync(paths.manifest), state = control.state(paths);
  if (!previous && state.loaded) throw new Error("An unrecognized Keyln login job is loaded. It was preserved.");
  const installation = stageAppService(paths, source, targetDir, control.quit, control.verify);
  let stopAttempted = false, startAttempted = false;
  try {
    if (previous) { stopAttempted = true; await control.stop(paths); }
    installation.commit();
    startAttempted = true; await control.start(paths); await control.ready(paths.data);
    installation.finish();
  } catch (error) {
    if (startAttempted) { try { await control.stop(paths); } catch (stopError) { throw new Error(`Installation failed: ${String(error)}. The new job could not be stopped; rollback files were preserved. ${String(stopError)}`); } }
    try {
      installation.rollback();
      if (stopAttempted || startAttempted) { await control.restore(paths, state); if (state.running) await control.ready(paths.data); }
    } catch (restoreError) { throw new Error(`Installation failed: ${String(error)}. Automatic recovery could not finish: ${String(restoreError)}`); }
    throw new Error(`Installation failed; previous files and startup state were preserved or restored. ${String(error)}`);
  }
  return installation.manifest;
}
