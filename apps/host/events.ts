import type { Server } from "node:https";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { EVENT_PATH, EVENT_PROTOCOL, EVENT_PROTOCOLS, MAX_EVENT_MESSAGE_BYTES, parseEventRequest, type Execution, type HostEvent, type RunningApps, type StateEvent } from "../../packages/contracts/index.js";
import type { Auth } from "./auth.js";

export const EVENT_HEARTBEAT_MS = 15_000;
export const MAX_EVENT_CONNECTIONS = 16;
export const MAX_DEVICE_CONNECTIONS = 4;
const MAX_BUFFERED_BYTES = 65_536;
const MAX_MESSAGES_PER_SECOND = 5;
interface Connection {
  ws: WebSocket; cookie: string; deviceId: string; sequence: number; awaitingPong: boolean;
  // T115 (ADR-099): the protocol this connection negotiated. Only v4 ever receives running-apps events.
  protocol: string; running?: string;
  received: number; windowStart: number; closing?: ReturnType<typeof setTimeout>;
}
interface Options {
  origin: string; auth: Auth;
  // T94: the library revision is the same for everyone; the layout revision is that of the layout assigned to the connection's device.
  snapshot: (deviceId: string) => Pick<StateEvent, "instanceId" | "revision" | "layoutRevision" | "busy">;
  heartbeatMs?: number;
  onDisconnect?:(deviceId:string)=>void;
  available?: () => boolean;
  // T115 (ADR-099): the Mac Dock. `enabled` says whether the device's layout shows it; `snapshot` is the Host's current list of running apps.
  dock?: { enabled: (deviceId: string) => boolean; snapshot: () => RunningApps; debounceMs?: number };
}
export function attachEvents(server: Server, options: Options) {
  const { auth, origin, snapshot } = options, canonical = new URL(origin);
  const connections = new Map<WebSocket, Connection>();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_EVENT_MESSAGE_BYTES,
    handleProtocols: protocols => EVENT_PROTOCOLS.find(name => protocols.has(name)) ?? false });
  let stopped = false;
  function closeDeadline(connection: Connection) {
    if (connection.closing) return;
    connection.closing = setTimeout(() => connection.ws.terminate(), 2000);
    connection.closing.unref();
  }
  function close(connection: Connection, code: number, reason: string) {
    if (connection.ws.readyState !== WebSocket.OPEN) return;
    connection.ws.close(code, reason);
    closeDeadline(connection);
  }
  function authorized(connection: Connection): boolean {
    try { auth.authenticate(connection.cookie); return true; }
    catch { close(connection, 4001, "Session expired or revoked"); return false; }
  }
  function send(connection: Connection, payload: { type: "state"; revision: number; layoutRevision: number; busy: boolean } | { type: "execution"; execution: Execution } | ({ type: "running-apps" } & RunningApps), instanceId = snapshot(connection.deviceId).instanceId) {
    const { ws } = connection;
    if (ws.readyState !== WebSocket.OPEN || !authorized(connection)) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) { close(connection, 1013, "Client is too slow"); return; }
    const event: HostEvent = { ...payload, version: 2, instanceId, sequence: ++connection.sequence };
    ws.send(JSON.stringify(event), error => { if (error) ws.terminate(); });
  }
  function sendState(connection: Connection, state = snapshot(connection.deviceId)) {
    send(connection, { type: "state", revision: state.revision, layoutRevision: state.layoutRevision, busy: state.busy }, state.instanceId);
  }
  // T115: the list goes only to a v4 connection whose device's layout shows the Dock, and only when it differs from what that connection last got.
  function sendRunning(connection: Connection, force = false) {
    const dock = options.dock;
    if (!dock || connection.protocol !== EVENT_PROTOCOL || connection.ws.readyState !== WebSocket.OPEN) return;
    let enabled = false;
    try { enabled = dock.enabled(connection.deviceId); } catch { /* an unreadable layout shows no Dock */ }
    if (!enabled) { connection.running = undefined; return; }
    const reply = dock.snapshot(), key = JSON.stringify(reply);
    if (!force && connection.running === key) return;
    connection.running = key;
    send(connection, { type: "running-apps", status: reply.status, apps: reply.apps });
  }
  let runningTimer: ReturnType<typeof setTimeout> | undefined;
  function reject(socket: Duplex, status: number) {
    const reasons: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests", 503: "Unavailable" };
    const reason = reasons[status] || "Rejected";
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => socket.destroy());
    if (stopped || options.available?.() === false) { reject(socket, 503); return; }
    if (request.url !== EVENT_PATH) { reject(socket, 404); return; }
    if (request.headers.host !== canonical.host || request.headers.origin !== origin ||
        (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin")) { reject(socket, 403); return; }
    // One protocol name per connection: this page's (v4) or the previous one (v3, which never receives the running-apps event).
    const protocol = EVENT_PROTOCOLS.find(name => name === request.headers["sec-websocket-protocol"]);
    if (!protocol) { reject(socket, 400); return; }
    let deviceId: string;
    const cookie = request.headers.cookie || "";
    try { deviceId = auth.authenticate(cookie).id; }
    catch { reject(socket, 401); return; }
    if (connections.size >= MAX_EVENT_CONNECTIONS ||
        [...connections.values()].filter(connection => connection.deviceId === deviceId).length >= MAX_DEVICE_CONNECTIONS) { reject(socket, 429); return; }
    try {
      wss.handleUpgrade(request, socket, head, ws => {
        const connection: Connection = { ws, cookie, deviceId, protocol, sequence: 0, awaitingPong: false, received: 0, windowStart: Date.now() };
        connections.set(ws, connection);
        ws.on("error", () => { close(connection, 1011, "Connection error"); closeDeadline(connection); });
        ws.on("close", () => { clearTimeout(connection.closing); connections.delete(ws);options.onDisconnect?.(deviceId); });
        ws.on("pong", () => { if (authorized(connection)) connection.awaitingPong = false; });
        ws.on("message", (data, binary) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (!authorized(connection)) return;
          if (Date.now() - connection.windowStart >= 1000) { connection.received = 0; connection.windowStart = Date.now(); }
          if (++connection.received > MAX_MESSAGES_PER_SECOND) { close(connection, 1008, "Too many messages"); return; }
          if (binary) { close(connection, 1008, "Use a JSON text message"); return; }
          try { parseEventRequest(JSON.parse(data.toString())); }
          catch { close(connection, 1008, "Invalid state request"); return; }
          sendState(connection);
        });
        sendState(connection);
        sendRunning(connection);
      });
    } catch { socket.destroy(); }
  }
  server.on("upgrade", upgrade);
  const unsubscribe = auth.onRevoke(id => {
    for (const connection of connections.values()) if (connection.deviceId === id) close(connection, 4001, "Session expired or revoked");
  });
  const heartbeat = setInterval(() => {
    for (const connection of connections.values()) {
      if (!authorized(connection) || connection.ws.readyState !== WebSocket.OPEN) continue;
      if (connection.awaitingPong) { connection.ws.terminate(); continue; }
      connection.awaitingPong = true;
      connection.ws.ping(undefined, false, error => { if (error) connection.ws.terminate(); });
    }
  }, options.heartbeatMs ?? EVENT_HEARTBEAT_MS);
  heartbeat.unref();
  function stop() {
    if (stopped) return;
    stopped = true; clearInterval(heartbeat); clearTimeout(runningTimer); runningTimer = undefined; unsubscribe(); server.removeListener("upgrade", upgrade);
    for (const connection of connections.values()) { clearTimeout(connection.closing); connection.ws.terminate(); }
    connections.clear(); wss.close();
  }
  server.once("close", stop);
  return {
    publish: () => { for (const connection of connections.values()) sendState(connection); },
    // T115: running apps change often (every app switch), so pushes are coalesced; `immediate` (a Dock setting change) sends at once and re-sends the list.
    runningApps: (immediate = false) => {
      if (immediate) { clearTimeout(runningTimer); runningTimer = undefined; for (const connection of connections.values()) sendRunning(connection, true); return; }
      if (runningTimer || stopped) return;
      runningTimer = setTimeout(() => { runningTimer = undefined; for (const connection of connections.values()) sendRunning(connection); }, options.dock?.debounceMs ?? 100);
      runningTimer.unref();
    },
    execution: (deviceId: string, execution: Execution) => {
      for (const connection of connections.values()) if (connection.deviceId === deviceId) send(connection, { type: "execution", execution });
    },
    stop,
  };
}
