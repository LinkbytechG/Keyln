import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { networkInterfaces } from "node:os";
import { Auth } from "./auth.js";
import { ConfigStore, defaultDataDir, lockDataDir } from "./store.js";
import { archiveLegacyData } from "./archive.js";
import { installedApps, nativeDiagnostics, applicationWindows, nativeAppIcon, nativeAppIcons } from "./native.js";
import { EXECUTION_TIMEOUT_MS, Scheduler } from "./scheduler.js";
import { createHost } from "./server.js";
import { LocalAdmin } from "./admin.js";
import { ScriptRegistry } from "./scripts.js";
import { actionAdapter } from "./shell.js";
import { ShortcutsCatalog } from "./shortcuts.js";
import { localManagement } from "./local-management.js";
import { readVersion } from "./version.js";
import { IconifyClient, IconLibrary } from "./icon-library.js";
import { AppUsage } from "./app-usage.js";
import { RunningApps } from "./running-apps.js";
import { DeviceAssignments } from "./device-assignments.js";
import { collectSubscription, SubscriptionUsage } from "./subscriptions.js";

let unlock: (() => void) | undefined;
let appUsage: AppUsage | undefined;
let runningApps: RunningApps | undefined;
let subscriptionUsage: SubscriptionUsage | undefined;
try {
  if (process.platform !== "darwin") throw new Error("Keyln Host requires macOS; open its web client on Surface.");
  if (process.getuid?.() === 0) throw new Error("Run Keyln as the signed-in Mac user, without sudo.");
  const dir = defaultDataDir(); unlock = lockDataDir(dir);
  process.once("exit", () => { appUsage?.terminate(); runningApps?.terminate(); unlock?.(); });
  const settings = JSON.parse(readFileSync(join(dir, "host.json"), "utf8"));
  const { address, port, origin } = settings;
  const isLocal = address === "127.0.0.1" || Object.values(networkInterfaces()).flat().some(item => item?.address === address);
  const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
  if (settings.schemaVersion !== 1 || !isLocal || (address !== "127.0.0.1" && !isPrivate) ||
      !Number.isInteger(port) || port < 1024 || port > 65535 || origin !== `https://${address}:${port}`)
    throw new Error("Invalid or unavailable listen address. Run npm run setup with a current private IPv4 address.");
  archiveLegacyData(dir);
  const store = new ConfigStore(dir, true), auth = new Auth(dir), admin = new LocalAdmin(), scripts = new ScriptRegistry(dir);
  if (!store.available) console.error(`${store.reason}\nRecovery only: open ${origin}/admin on this Mac. Control and pairing are disabled.`);
  const shortcuts = new ShortcutsCatalog(); await shortcuts.refresh();
  const refreshShortcuts = setInterval(()=>{void shortcuts.refresh();},30_000); refreshShortcuts.unref();
  const scheduler = new Scheduler(actionAdapter(scripts,shortcuts), Date.now, EXECUTION_TIMEOUT_MS, 1000, run => {
    console.log(JSON.stringify({ executionId: run.id, requestId: run.requestId, status: run.status,
      elapsedMs: run.finishedAt! - run.createdAt, code: run.code }));
  });
  const iconLibrary = new IconLibrary(dir);
  if (iconLibrary.damagedCopy) console.error(`My icons file was damaged. It was kept at ${iconLibrary.damagedCopy} and an empty library started.`);
  const assignments = new DeviceAssignments(dir);
  const apps = await installedApps();
  appUsage = new AppUsage(dir, apps); appUsage.start();
  // T115 (ADR-099): observed only while some layout shows the Mac Dock (createHost starts and stops it as that changes).
  runningApps = new RunningApps({ log: message => console.error(message) });
  subscriptionUsage = new SubscriptionUsage((provider, signal) => collectSubscription(provider, dir, signal));
  const server = createHost({ origin, store, auth, admin, scripts, shortcuts, scheduler, apps, appRecent: () => appUsage!.snapshot(), windows: applicationWindows, appIcon: nativeAppIcon, appIcons: nativeAppIcons,
    iconSearch: new IconifyClient(), iconLibrary, assignments, subscriptions: subscriptionUsage, runningApps,
    tls: { key: readFileSync(join(dir, "tls/server.key")), cert: readFileSync(join(dir, "tls/server.pem")) },
    onPair: (id, name) => console.log(`\nPairing request ${id} from ${JSON.stringify(name)}. Compare this ID on Surface, then type: approve ${id}`),
  });
  const closeManagement = await localManagement(dir, admin, origin, nativeDiagnostics, readVersion());
  server.on("error", error => { console.error(`Host stopped: ${error.message}`); process.exit(1); });
  server.listen(port, address, () => {
    console.log(`Keyln is listening at ${origin}\nInstalled apps: ${apps.length}. Data: ${dir}`);
    if (process.env.KEYLN_BACKGROUND === "1") console.log(`Mac management: ${origin}/admin. Run npm run service:admin for a private, short-lived login code. Codes are not logged.`);
    else { showAdmin(); console.log("Commands: admin | pair | approve <id> | devices | revoke <id> | quit"); }
  });
  function showAdmin() { console.log(`Mac management: ${origin}/admin\nMac management login code: ${admin.invite()} (2 minutes, 5 attempts; use on this Mac only).`); }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  terminal.on("line", line => {
    const [command, id, extra] = line.trim().split(/\s+/);
    try {
      if (extra) throw new Error("Too many arguments.");
      if (!store.available && !["admin", "quit"].includes(command ?? "")) throw new Error("Recover the layout in Mac management before pairing or controlling devices.");
      if (command === "admin" && !id) showAdmin();
      else if (command === "pair" && !id) console.log(`Pairing code: ${auth.invite()} (2 minutes, 5 attempts; Mac approval still required).`);
      else if (command === "approve" && id) { auth.approve(id); console.log(`Approved request ${id}.`); }
      else if (command === "devices" && !id) console.table(auth.list());
      else if (command === "revoke" && id) { auth.revoke(id); console.log(`Revoked device ${id}; its next request is denied. An already-started action is not undone.`); }
      else if (command === "quit" && !id) shutdown();
      else console.log("Commands: admin | pair | approve <id> | devices | revoke <id> | quit");
    } catch (error) { console.error((error as Error).message); }
  });
  let stopping = false;
  async function shutdown() {
    if (stopping) return; stopping = true;
    clearInterval(refreshShortcuts);scheduler.stop(); terminal.close(); server.stopEvents(); server.closeAllConnections();
    await Promise.all([appUsage!.stop(),runningApps!.stop(),subscriptionUsage!.stop(),closeManagement(),scheduler.settled(), new Promise<void>(resolve => server.close(() => resolve()))]);
    process.exit(0);
  }
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
} catch (error) {
  console.error(`Keyln could not start: ${(error as Error).message}\nFor first-time setup, see README.md.`);
  await appUsage?.stop();
  await runningApps?.stop();
  await subscriptionUsage?.stop();
  process.exitCode = 1; unlock?.(); unlock = undefined;
}
