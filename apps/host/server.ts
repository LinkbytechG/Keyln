import { createServer, type ServerOptions } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { appId, exact, Fault, ICON_SETS, iconId, iconQuery, iconScope, iconSet, MAX_CONFIG_BYTES, parseTrigger, parseWindows, parseAppRecent, record, requestId, type Action, type AppInfo, type AppRecent, type WindowInfo } from "../../packages/contracts/index.js";
import { Auth, SESSION_MS } from "./auth.js";
import { ConfigStore, configurationFile } from "./store.js";
import { Scheduler } from "./scheduler.js";
import { attachEvents } from "./events.js";
import { ADMIN_COOKIE, ADMIN_SESSION_MS, LocalAdmin, requireLocalAdminPeer } from "./admin.js";
import type { ScriptRegistry } from "./scripts.js";
import type { ShortcutsCatalog } from "./shortcuts.js";
import { Confirmations } from "./confirmations.js";
import { importPreview } from "./layout.js";
import type { DeviceAssignments } from "./device-assignments.js";
import { AppIcons, appIconIds, MAX_ICON_REPLY_BYTES } from "./app-icons.js";
import { IconSearch, MAX_LIBRARY_REPLY_BYTES, MAX_SEARCH_REPLY_BYTES, type IconLibrary, type IconSource } from "./icon-library.js";
import { parseSubscriptionProviders } from "../../packages/contracts/subscription.js";
import type { SubscriptionUsage } from "./subscriptions.js";
import type { RunningApps } from "./running-apps.js";

interface Options {
  tls: ServerOptions; origin: string; auth: Auth; store: ConfigStore;
  scheduler: Scheduler; apps: AppInfo[];
  appRecent?: () => AppRecent;
  onPair: (id: string, name: string) => void;
  eventHeartbeatMs?: number;
  admin?: LocalAdmin;
  scripts?: ScriptRegistry;
  shortcuts?: Pick<ShortcutsCatalog,"state"|"refresh">;
  windows?: (id: string) => Promise<WindowInfo[]>;
  appIcon?: (id: string) => Promise<Uint8Array>;
  appIcons?: (ids: string[]) => Promise<Map<string, Uint8Array>>;
  iconSearch?: IconSource;
  iconLibrary?: IconLibrary;
  // T94: the layout each paired device shows (ADR-086). Without it every device shows the default layout.
  assignments?: DeviceAssignments;
  subscriptions?: Pick<SubscriptionUsage, "read">;
  // T115 (ADR-099): the running Mac apps of the Dock bar. `wanted` starts or stops the observer; the Host asks for it only while some layout shows the Dock.
  runningApps?: Pick<RunningApps, "snapshot" | "onChange" | "wanted">;
  dockDebounceMs?: number;
}
const staticFiles = new Map([
  ["/", ["../../apps/web/index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["../../apps/web/style.css", "text/css; charset=utf-8"]],
  ["/manifest.webmanifest", ["../../apps/web/manifest.webmanifest", "application/manifest+json; charset=utf-8"]],
  ["/icons/keyln-180.png", ["../../apps/web/icons/keyln-180.png", "image/png"]],
  ["/icons/keyln-192.png", ["../../apps/web/icons/keyln-192.png", "image/png"]],
  ["/icons/keyln-512.png", ["../../apps/web/icons/keyln-512.png", "image/png"]],
  ["/icons/keyln-maskable-512.png", ["../../apps/web/icons/keyln-maskable-512.png", "image/png"]],
  ["/apps/web/app.js", ["../../apps/web/app.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/install.js", ["../../apps/web/install.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/page-refresh.js", ["../../apps/web/page-refresh.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/console.js", ["../../apps/web/console.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/editor.js", ["../../apps/web/editor.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/app-picker.js", ["../../apps/web/app-picker.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/component-files.js", ["../../apps/web/component-files.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/window-picker.js", ["../../apps/web/window-picker.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/layout-tools.js", ["../../apps/web/layout-tools.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/page-layout.js", ["../../apps/web/page-layout.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/library-apps.js", ["../../apps/web/library-apps.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/library.js", ["../../apps/web/library.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/widget-settings.js", ["../../apps/web/widget-settings.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/edit-menu.js", ["../../apps/web/edit-menu.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/edit-bar.js", ["../../apps/web/edit-bar.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/touch-hold.js", ["../../apps/web/touch-hold.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/library-resize.js", ["../../apps/web/library-resize.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/move-mode.js", ["../../apps/web/move-mode.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/card-move.js", ["../../apps/web/card-move.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/workflows.js", ["../../apps/web/workflows.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/layout-files.js", ["../../apps/web/layout-files.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/reconnect.js", ["../../apps/web/reconnect.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/presentation.js", ["../../apps/web/presentation.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/app-icons.js", ["../../apps/web/app-icons.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/icon-paths.js", ["../../apps/web/icon-paths.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/icon-library.js", ["../../apps/web/icon-library.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/icon-keywords.js", ["../../apps/web/icon-keywords.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/theme-custom.js", ["../../apps/web/theme-custom.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/theme-editor.js", ["../../apps/web/theme-editor.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/first-theme.js", ["../../apps/web/first-theme.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/theme-layout.js", ["../../apps/web/theme-layout.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/theme-sketch.js", ["../../apps/web/theme-sketch.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/select-menu.js", ["../../apps/web/select-menu.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/themes.js", ["../../apps/web/themes.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/page-view.js", ["../../apps/web/page-view.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/widgets/state.js", ["../../apps/web/widgets/state.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/widgets/dom.js", ["../../apps/web/widgets/dom.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/widgets/registry.js", ["../../apps/web/widgets/registry.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/widgets/connection.js", ["../../apps/web/widgets/connection.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/widgets/mode-switch.js", ["../../apps/web/widgets/mode-switch.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/widgets/refresh.js", ["../../apps/web/widgets/refresh.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/widgets/settings.js", ["../../apps/web/widgets/settings.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/widgets/system.js", ["../../apps/web/widgets/system.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/widgets/display.js", ["../../apps/web/widgets/display.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/widgets/subscription.js", ["../../apps/web/widgets/subscription.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/subscription-client.js", ["../../apps/web/subscription-client.js", "text/javascript; charset=utf-8"]],
  ["/packages/contracts/subscription.js", ["../../packages/contracts/subscription.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/mac-dock.js", ["../../apps/web/mac-dock.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/full-screen.js", ["../../apps/web/full-screen.js", "text/javascript; charset=utf-8"]],
  ["/apps/web/zones.js", ["../../apps/web/zones.js", "text/javascript; charset=utf-8"]],
  ["/packages/contracts/sizing.js", ["../../packages/contracts/sizing.js", "text/javascript; charset=utf-8"]],
  ["/packages/contracts/index.js", ["../../packages/contracts/index.js", "text/javascript; charset=utf-8"]],
  ["/admin", ["../../apps/web/admin.html", "text/html; charset=utf-8"]],
  ["/admin.css", ["../../apps/web/admin.css", "text/css; charset=utf-8"]],
  ["/apps/web/admin.js", ["../../apps/web/admin.js", "text/javascript; charset=utf-8"]],
  ["/check", ["../../apps/web/check.html", "text/html; charset=utf-8"]],
  ["/check.css", ["../../apps/web/check.css", "text/css; charset=utf-8"]],
  ["/apps/web/check.js", ["../../apps/web/check.js", "text/javascript; charset=utf-8"]],
]);
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage, limit = 16_384): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] || ""))
    throw new Fault("CONTENT_TYPE", "Use application/json.", 415);
  if (Number(request.headers["content-length"] || 0) > limit) throw new Fault("TOO_LARGE", "Request is too large.", 413);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Fault("TOO_LARGE", "Request is too large.", 413);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new Fault("INVALID_JSON", "Invalid JSON body."); }
}
export function createHost(options: Options) {
  const { auth, store, scheduler, apps, origin } = options;
  const canonical = new URL(origin), instanceId = randomUUID();
  const confirmations=new Confirmations();
  let readingWindows = false;
  const appIcons = options.appIcon ? new AppIcons(options.appIcon, Date.now, options.appIcons) : undefined;
  const iconSearch = options.iconSearch ? new IconSearch(options.iconSearch) : undefined;
  const library = () => options.iconLibrary ?? (() => { throw new Fault("ICON_LIBRARY_UNAVAILABLE", "My icons is unavailable on this Host.", 503); })();
  const searchOnline = () => iconSearch ?? (() => { throw new Fault("ICON_SEARCH_UNAVAILABLE", "Searching online icons is unavailable on this Host. My icons still works offline.", 503); })();
  function validateAction(action: Action) {
    if (action.type === "shell.run") {
      if (!options.scripts) throw new Fault("SCRIPT_UNAVAILABLE", "The local script registry is unavailable.");
      options.scripts.prepare(action);
    }
    if (action.type === "shortcuts.run" && !options.shortcuts?.state().shortcuts.some(item => item.id === action.shortcutId))
      throw new Fault("SHORTCUT_UNAVAILABLE", "Refresh Mac shortcuts and choose an available target.");
  }
  // The layout a device shows: its assignment while that layout exists, else the default layout. The device id comes from the auth cookie, never from a request.
  const layoutOf = (deviceId: string) => options.assignments ? options.assignments.layoutOf(deviceId, store.layoutNames, store.defaultLayout) : store.defaultLayout;
  // T115: the observer runs only while at least one layout shows the Dock.
  const syncRunning = () => { try { options.runningApps?.wanted(store.available && store.anyDock); } catch { /* an unreadable layout leaves it as it was */ } };
  const runningNow = () => options.runningApps?.snapshot() ?? { status: "unavailable" as const, apps: [] };
  const eventOrigin = `${canonical.protocol === "https:" ? "wss:" : "ws:"}//${canonical.host}`;
  const assets = new Map([...staticFiles].map(([path, file]) => [path, {
    content: readFileSync(fileURLToPath(new URL(file[0]!, import.meta.url))), type: file[1]!,
  }]));
  const server = createServer({ ...options.tls, minVersion: "TLSv1.2" }, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; manifest-src 'self'; connect-src 'self' ${eventOrigin}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "microphone=(), camera=(), geolocation=()");
    void (async () => {
      if (req.headers.host !== canonical.host) throw new Fault("WRONG_HOST", "Use the address printed by the Mac Host.", 403);
      const path = req.url || "";
      const adminRoute = path.startsWith("/api/admin/");
      if (adminRoute || path === "/admin" || path === "/admin.css" || path === "/apps/web/admin.js") {
        if (!options.admin) throw new Fault("NOT_FOUND", "Not found.", 404);
        requireLocalAdminPeer(req, canonical.hostname);
      }
      if (req.method === "GET" && assets.has(path)) {
        const asset = assets.get(path)!;
        res.writeHead(200, { "Content-Type": asset.type }); res.end(asset.content); return;
      }
      if (!path.startsWith("/api/")) throw new Fault("NOT_FOUND", "Not found.", 404);
      if (req.method !== "POST") throw new Fault("METHOD", "Use POST.", 405);
      if (req.headers.origin !== origin || req.headers["x-keyln-client"] !== "1" ||
          (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin"))
        throw new Fault("WRONG_ORIGIN", "This request did not come from the Keyln page.", 403);
      if (adminRoute) {
        const admin = options.admin!, login = path === "/api/admin/login";
        if (!login) admin.authenticate(req.headers.cookie);
        const input = await body(req, path.startsWith("/api/admin/scripts/") ? 524_288 : 1024);
        if (!login) admin.authenticate(req.headers.cookie);
        if (!store.available && !["/api/admin/login", "/api/admin/state", "/api/admin/logout", "/api/admin/layout/backup", "/api/admin/layout/restore"].includes(path))
          throw new Fault("CONFIG_DAMAGED", "Recover the layout before managing scripts or pairing devices.", 503);
        if (path.startsWith("/api/admin/scripts/")) {
          const scripts = options.scripts;
          if (!scripts) throw new Fault("NOT_FOUND", "The local script registry is unavailable.", 404);
          switch (path) {
            case "/api/admin/scripts/state": exact(input, []); json(res, 200, scripts.localState()); break;
            case "/api/admin/scripts/save": json(res, 200, scripts.save(input)); events.publish(); break;
            case "/api/admin/scripts/preview": json(res, 200, scripts.preview(input)); break;
            case "/api/admin/scripts/approve": json(res, 200, scripts.approve(input)); events.publish(); break;
            case "/api/admin/scripts/revoke": json(res, 200, scripts.revoke(input)); events.publish(); break;
            case "/api/admin/scripts/remove": json(res, 200, scripts.remove(input)); events.publish(); break;
            default: throw new Fault("NOT_FOUND", "Not found.", 404);
          }
          return;
        }
        switch (path) {
          case "/api/admin/login": {
            const obj = exact(input, ["code"]), session = admin.login(obj.code);
            res.setHeader("Set-Cookie", `${ADMIN_COOKIE}=${session.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_MS / 1000}`);
            json(res, 200, { expiresAt: session.expiresAt }); break;
          }
          case "/api/admin/state":
            exact(input, []);
            json(res, 200, { origin, expiresAt: admin.authenticate(req.headers.cookie), devices: auth.list(), pairing: auth.pairingState(),
              scriptRegistry: options.scripts?.localState() ?? { revision: 0, scripts: [] },
              layout: { available: store.available, reason: store.reason, backup: store.backupState() } }); break;
          case "/api/admin/layout/backup":
            exact(input, []); json(res, 200, { config: configurationFile(store.backup) }); break;
          case "/api/admin/layout/restore": {
            if (scheduler.busy) throw new Fault("BUSY", "Wait for the running action to finish before recovering the layout.", 409);
            const config = store.restoreBackup(input, () => auth.revokeAll()); confirmations.clear();
            json(res, 200, { revision: config.revision, restored: true, devicesRevoked: true }); syncRunning(); events.publish(); break;
          }
          case "/api/admin/invite":
            exact(input, []);
            json(res, 200, { code: auth.invite(), ...auth.pairingState() }); break;
          case "/api/admin/approve": {
            const obj = exact(input, ["id"]), pending = auth.pairingState().pending;
            if (!pending || obj.id !== pending.id) throw new Fault("PAIR_EXPIRED", "The pairing request changed or expired. Check the request ID on the device again.", 409);
            auth.approve(pending.id); json(res, 200, { approved: true }); break;
          }
          case "/api/admin/close-pairing":
            exact(input, []); auth.closePairing(); json(res, 200, { closed: true }); break;
          case "/api/admin/revoke": {
            const obj = exact(input, ["id"]);
            if (!auth.list().some(device => device.id === obj.id)) throw new Fault("DEVICE_NOT_FOUND", "The device was revoked or its access expired. Refresh the list.", 404);
            auth.revoke(obj.id as string); json(res, 200, { revoked: true }); break;
          }
          case "/api/admin/logout":
            exact(input, []); admin.logout(req.headers.cookie);
            res.setHeader("Set-Cookie", `${ADMIN_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
            json(res, 200, { loggedOut: true }); break;
          default: throw new Fault("NOT_FOUND", "Not found.", 404);
        }
        return;
      }
      if (!store.available) throw new Fault("CONFIG_DAMAGED", "The Mac layout needs recovery. Open /admin on the Mac; pairing and execution are disabled.", 503);
      // Authentication is checked before parsing protected requests.
      const pairing = path === "/api/pair" || path === "/api/pair/status";
      const device = pairing ? undefined : auth.authenticate(req.headers.cookie);
      const input = await body(req, path === "/api/configuration/import" ? MAX_CONFIG_BYTES + 1024 : ["/api/configuration/save", "/api/configuration/preview"].includes(path) ? MAX_CONFIG_BYTES : 16_384);
      // Body reads yield; a device revoked during upload must not reach dispatch.
      if (device) auth.authenticate(req.headers.cookie);
      if (path === "/api/pair") {
        const obj = exact(input, ["code", "name"]), pair = auth.begin(obj.code, obj.name);
        options.onPair(pair.id, pair.name);
        json(res, 202, { id: pair.id, claim: pair.claim }); return;
      }
      if (path === "/api/pair/status") {
        const obj = exact(input, ["id", "claim"]), result = auth.claim(obj.id, obj.claim);
        if (result.token) res.setHeader("Set-Cookie", `__Host-keyln=${result.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
        json(res, 200, { approved: result.approved }); return;
      }
      switch (path) {
        case "/api/echo": {
          const obj = exact(input, ["sampleId"]);
          json(res, 200, { sampleId: requestId(obj.sampleId), instanceId }); break;
        }
        case "/api/configuration":
          exact(input, []);
          json(res, 200, { config: store.get(layoutOf(device!.id)), scripts: options.scripts?.available() ?? [], ...(options.shortcuts?.state() ?? {shortcuts:[],shortcutsError:"",shortcutsRefreshing:false}), busy: scheduler.busy, instanceId, deviceName: device!.name }); break;
        // T94: the whole v3 document (the key library and every layout), what Export writes.
        case "/api/configuration/export": exact(input, []); json(res, 200, { config: store.document() }); break;
        case "/api/configuration/preview": {
          const layoutName = layoutOf(device!.id);
          json(res, 200, { ...importPreview(input, apps, validateAction, layoutName), stamp: store.documentStamp(), revision: store.revision, layoutRevision: store.layoutRevision(layoutName), layoutName, instanceId }); break;
        }
        case "/api/configuration/import": {
          if (scheduler.busy) throw new Fault("BUSY", "Wait for the running action before saving an imported layout.", 409);
          if (Object.hasOwn(record(input), "format")) throw new Fault("CONFIG_VERSION", "This page is older than the Mac Host. Reload the page and review the import again.");
          const obj = exact(input, ["config", "stamp"]);
          store.importDocument(obj.config, obj.stamp, apps, validateAction);
          json(res, 200, { config: store.get(layoutOf(device!.id)) }); confirmations.clear(); syncRunning(); events.publish(); events.runningApps(true); break;
        }
        case "/api/configuration/save": {
          // T94: { libraryRevision, layoutName, layoutRevision, library?, layout? }: only the changed part(s), each checked against its own revision. The layout is the
          // device's own: a request for another layout is a conflict (its assignment may have changed), never a write to that layout.
          // A whole document (what a page from before T94 sends) is refused with a clear reason, not as a malformed request.
          if (Object.hasOwn(record(input), "format")) throw new Fault("CONFIG_VERSION", "This page is older than the Mac Host. Reload the page and try again.");
          if (record(input).layoutName !== layoutOf(device!.id)) throw new Fault("CONFIG_CONFLICT", "Configuration changed. Reconnect and review the latest version.", 409);
          json(res, 200, { config: store.save(input, apps, validateAction) }); events.publish(); break;
        }
        case "/api/configuration/themes": {
          // T62: { customThemes, revision } -> { config }. The definitions of the custom themes are shared (the key library's); a stale library revision is a CONFIG_CONFLICT like any save.
          const obj = exact(input, ["customThemes", "revision"]);
          json(res, 200, { config: store.setCustomThemes(obj.customThemes, obj.revision, layoutOf(device!.id)) }); events.publish(); break;
        }
        case "/api/device-theme":
          // T94: the theme of the calling device's layout (it is the layout's, not the device's). null: the layout names a custom theme that no longer exists (the page shows the default).
          exact(input, []); json(res, 200, { theme: store.theme(layoutOf(device!.id)) }); break;
        case "/api/device-theme/save": {
          // Naming the layout also refuses old pages that blindly adopt a returned revision without its baseline.
          if (!Object.hasOwn(record(input), "layoutName")) throw new Fault("CONFIG_VERSION", "This page is older than the Mac Host. Reload the page before changing the theme.");
          const obj = exact(input, ["theme", "layoutName"]);
          if (obj.layoutName !== layoutOf(device!.id)) throw new Fault("CONFIG_CONFLICT", "The device layout changed. Reconnect before changing its theme.", 409);
          json(res, 200, store.setTheme(layoutOf(device!.id), obj.theme)); events.publish(); break;
        }
        case "/api/device-dock":
          // T115 (ADR-099): the Mac Dock setting of the calling device's layout.
          exact(input, []); json(res, 200, { dock: store.dock(layoutOf(device!.id)), layoutName: layoutOf(device!.id), options: store.dockOptions(layoutOf(device!.id)) }); break;
        case "/api/device-dock/save": {
          const obj = exact(input, ["dock", "layoutName"]);
          if (obj.layoutName !== layoutOf(device!.id)) throw new Fault("CONFIG_CONFLICT", "The device layout changed. Reconnect before changing its Mac Dock.", 409);
          json(res, 200, store.setDock(layoutOf(device!.id), obj.dock)); syncRunning(); events.publish(); events.runningApps(true); break;
        }
        case "/api/device-dock/options": {
          // T117 (ADR-101): the Mac Dock options of the calling device's layout (independent of the Dock being on).
          const obj = exact(input, ["options", "layoutName"]);
          if (obj.layoutName !== layoutOf(device!.id)) throw new Fault("CONFIG_CONFLICT", "The device layout changed. Reconnect before changing its Mac Dock options.", 409);
          json(res, 200, store.setDockOptions(layoutOf(device!.id), obj.options)); events.publish(); break;
        }
        case "/api/running-apps": exact(input, []); json(res, 200, runningNow()); break;
        case "/api/dock/activate": {
          // T115: the Dock can only bring an app that is running right now to the front (the app.open path); it cannot launch or run anything else.
          const obj = exact(input, ["requestId", "appId"]), id = requestId(obj.requestId), target = appId(obj.appId), layout = layoutOf(device!.id);
          if (!store.dock(layout)) throw new Fault("DOCK_OFF", "The Mac Dock is off for this screen.", 409);
          if (!runningNow().apps.some(app => app.appId === target)) throw new Fault("APP_NOT_RUNNING", "That app is no longer running on the Mac.", 409);
          json(res, 202, { execution: scheduler.openRunning(device!.id, { requestId: id, appId: target }, store.get(layout)) }); break;
        }
        case "/api/subscriptions": {
          const obj = exact(input, ["providers"]);
          let providers; try { providers = parseSubscriptionProviders(obj.providers); } catch { throw new Fault("INVALID_INPUT", "Choose Codex or Claude Code."); }
          json(res, 200, { subscriptions: options.subscriptions?.read(providers) ?? providers.map(provider => ({ provider, status: "unavailable", windows: [], updatedAt: null, checkedAt: Date.now(), source: null, reason: "read-failed" })) }); break;
        }
        case "/api/apps/recent": exact(input, []); json(res, 200, parseAppRecent(options.appRecent?.() ?? { status: "unavailable", appIds: [], message: "Mac app usage observation is unavailable. Apps use name order." })); break;
        case "/api/apps": exact(input, []); json(res, 200, { apps }); break;
        case "/api/app-icon": {
          const obj = exact(input, ["appId"]), id = appId(obj.appId);
          if (!apps.some(app => app.id === id)) throw new Fault("APP_UNAVAILABLE", "Choose an installed Mac application.", 404);
          if (!appIcons) throw new Fault("ICON_UNAVAILABLE", "App icons are unavailable on this Host.", 503);
          const data = await appIcons.get(id);
          auth.authenticate(req.headers.cookie);
          res.writeHead(200, {"Content-Type": "image/png", "Content-Length": data.length}); res.end(data); break;
        }
        case "/api/app-icons": {
          const obj = exact(input, ["appIds"]), ids = appIconIds(obj.appIds);
          // T115: the apps running now may be icon sources too (the Dock bar); anything else unknown still never reaches the exporter.
          const running = runningNow().apps, installed = ids.filter(id => apps.some(app => app.id === id) || running.some(app => app.appId === id));
          if (!appIcons) throw new Fault("ICON_UNAVAILABLE", "App icons are unavailable on this Host.", 503);
          // Unknown IDs never reach the exporter or cache, and cannot spoil other icons.
          const data = installed.length ? await appIcons.getMany(installed) : [];
          const icons = new Map(installed.map((id, i) => [id, data[i]] as const));
          auth.authenticate(req.headers.cookie);
          const response = {icons: ids.map(id => { const icon = icons.get(id); return icon ? {appId: id, png: icon.toString("base64")} : {appId: id, code: "ICON_UNAVAILABLE"}; })};
          if (Buffer.byteLength(JSON.stringify(response)) > MAX_ICON_REPLY_BYTES) throw new Fault("ICON_UNAVAILABLE", "Icon response is too large.", 503);
          json(res, 200, response); break;
        }
        case "/api/icon-library": {
          exact(input, []);
          const reply = JSON.stringify({ icons: library().state().icons, sets: ICON_SETS.map(({ prefix, name, license }) => ({ prefix, name, license })) });
          if (Buffer.byteLength(reply) > MAX_LIBRARY_REPLY_BYTES) throw new Fault("ICON_LIBRARY_UNAVAILABLE", "My icons is too large to send.", 503);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); res.end(reply); break;
        }
        case "/api/icon-library/search": {
          // { query, scope?: "curated" | "all", set? } -> { results, truncated }. The query is English only (the page translates Chinese on the device);
          // `set` filters the curated sets and cannot be combined with "all". `truncated` is true only when icons of sets beyond the set limit were dropped.
          const obj = exact(input, ["query", ...["scope", "set"].filter(key => Object.hasOwn(record(input), key))]);
          const query = iconQuery(obj.query), scope = Object.hasOwn(obj, "scope") ? iconScope(obj.scope) : "curated";
          if (scope === "all" && Object.hasOwn(obj, "set")) throw new Fault("INVALID_INPUT", "Choose one icon set or search all sets, not both.");
          const set = Object.hasOwn(obj, "set") ? iconSet(obj.set) : undefined;
          const { results, truncated } = await searchOnline().search(query, scope, set);
          auth.authenticate(req.headers.cookie);
          const reply = JSON.stringify({ results, truncated });
          if (Buffer.byteLength(reply) > MAX_SEARCH_REPLY_BYTES) throw new Fault("ICON_SEARCH_UNAVAILABLE", "The icon results were too large. Try a more specific search.", 503);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); res.end(reply); break;
        }
        case "/api/icon-library/add": {
          const id = iconId(exact(input, ["id"]).id).id, store = library(), known = store.find(id);
          if (known) { json(res, 200, { icon: known }); break; }
          const found = await searchOnline().icon(id);
          auth.authenticate(req.headers.cookie);
          json(res, 200, { icon: store.add(id, found.svg, found) }); break;
        }
        case "/api/icon-library/remove": {
          const id = iconId(exact(input, ["id"]).id).id;
          json(res, 200, { removed: library().remove(id) }); break;
        }
        case "/api/windows": {
          const obj = exact(input, ["appId"]), id = appId(obj.appId);
          if (!apps.some(app => app.id === id)) throw new Fault("APP_UNAVAILABLE", "Choose an installed Mac application.");
          if (!options.windows) throw new Fault("WINDOW_LIST_UNAVAILABLE", "Window discovery is unavailable on this Host.", 503);
          if (readingWindows || scheduler.busy) throw new Fault("BUSY", "The Mac is busy. Try reading windows after its current action finishes.", 409);
          readingWindows = true;
          try {
            const windows = parseWindows(await options.windows(id));
            auth.authenticate(req.headers.cookie);
            json(res, 200, {windows});
          } finally { readingWindows = false; }
          break;
        }
        case "/api/scripts": exact(input, []); json(res, 200, { scripts: options.scripts?.available() ?? [] }); break;
        case "/api/shortcuts/refresh": exact(input,[]);void options.shortcuts?.refresh();json(res,200,{refreshing:!!options.shortcuts});break;
        case "/api/execute": {
          const trigger=parseTrigger(input);
          const execution = scheduler.trigger(device!.id, trigger, store.get(layoutOf(device!.id)),()=>confirmations.consume(device!.id,trigger));
          json(res, 202, { execution }); break;
        }
        case "/api/confirmation":{
          exact(input,["requestId","componentId","revision"]);
          if(scheduler.busy)throw new Fault("BUSY","The Mac is busy. Nothing was queued.",409);
          json(res,200,confirmations.issue(device!.id,parseTrigger(input),store.get(layoutOf(device!.id))));break;
        }
        case "/api/result": {
          const obj = exact(input, ["requestId"]);
          json(res, 200, { execution: scheduler.get(device!.id, requestId(obj.requestId)) }); break;
        }
        default: throw new Fault("NOT_FOUND", "Not found.", 404);
      }
    })().catch(error => {
      const fault = error instanceof Fault ? error : new Fault("HOST_ERROR", "The Host could not complete this request. Check the Mac terminal and local data permissions.", 500);
      if (!res.headersSent && !res.destroyed) json(res, fault.status, { error: { code: fault.code, message: fault.message } });
      else res.end();
    });
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.timeout = 10_000;
  server.keepAliveTimeout = 5000; server.maxConnections = 32; server.maxRequestsPerSocket = 100;
  const events = attachEvents(server, { origin, auth, available: () => store.available, snapshot: deviceId => ({ instanceId, revision: store.available ? store.revision : 0, layoutRevision: store.available ? store.layoutRevision(layoutOf(deviceId)) : 0, busy: scheduler.busy }), heartbeatMs: options.eventHeartbeatMs,onDisconnect:id=>confirmations.cancel(id),
    dock: { enabled: deviceId => store.available && store.dock(layoutOf(deviceId)), snapshot: runningNow, debounceMs: options.dockDebounceMs } });
  const unwatchRunning = options.runningApps?.onChange(() => events.runningApps());
  syncRunning();
  const unsubscribe = scheduler.onChange((deviceId, execution) => { events.publish(); events.execution(deviceId, execution); });
  function stopEvents() { unsubscribe(); unwatchRunning?.(); events.stop(); options.admin?.clear();confirmations.clear(); }
  server.once("close", stopEvents);
  return Object.assign(server, { stopEvents });
}
