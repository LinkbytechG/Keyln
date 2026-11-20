import { appId, imageDimensions, type Component } from "../../packages/contracts/index.js";

// No migration: only pristine legacy defaults get a display-time replacement.
export function appIconReference(button: Component): string | undefined {
  const action = button.action;
  if (action?.type !== "app.open" && action?.type !== "window.activate") return;
  if (button.appearance?.glyph?.type === "app" || (button.icon === "app" && !button.appearance && !button.color)) return action.appId || undefined;
}

// T84 (ADR-079): validated icons are kept in IndexedDB on this device (cleared on page load and after a reconnect); memory holds a small recent set only.
// Every IndexedDB call is wrapped: without it (private window, quota, blocked) the loader runs from memory and asks the Mac again.
export interface IconStore {
  get(id: string): Promise<Uint8Array | undefined>; put(id: string, png: Uint8Array): Promise<void>;
  delete(id: string): Promise<void>; clear(): Promise<void>;
}
export function createIndexedDbStore(): IconStore {
  let opened: { factory: IDBFactory; db: Promise<IDBDatabase> } | undefined;
  const open = () => {
    const factory = globalThis.indexedDB;
    if (!factory) return Promise.reject(Error("IndexedDB unavailable."));
    if (opened?.factory !== factory) opened = { factory, db: new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("keyln-app-icons", 1);
      request.onupgradeneeded = () => { request.result.createObjectStore("icons"); };
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => db.close(); resolve(db); };
      request.onerror = request.onblocked = () => reject(request.error ?? Error("IndexedDB unavailable."));
    }) };
    return opened.db;
  };
  const run = <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>) => open().then(db => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction("icons", mode), request = work(transaction.objectStore("icons"));
    transaction.oncomplete = () => resolve(request.result); transaction.onerror = transaction.onabort = () => reject(transaction.error ?? Error("IndexedDB failed."));
  }));
  return {
    get: id => run<unknown>("readonly", store => store.get(id)).then(value => value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : undefined),
    put: (id, png) => run("readwrite", store => store.put(png, id)).then(() => undefined),
    delete: id => run("readwrite", store => store.delete(id)).then(() => undefined),
    clear: () => run("readwrite", store => store.clear()).then(() => undefined),
  };
}
const toDataUrl = (bytes: Uint8Array) => {
  let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return "data:image/png;base64," + btoa(binary);
};
// What comes back from disk is checked again like a reply from the Mac: a PNG of 128x128 within 64 KiB.
function storedUrl(bytes: Uint8Array): string | undefined {
  try { if (bytes.length > 65_536) return; const size = imageDimensions(bytes, "image/png"); if (size.width === 128 && size.height === 128) return toDataUrl(bytes); } catch { /* corrupted */ }
}
class BusyError extends Error {}
const MEMORY_ICONS = 64, BATCH_ICONS = 16, COOLDOWN_MS = 30_000, BUSY_RETRY_MS = 500, BATCH_TIMEOUT_MS = 6000, STORE_TIMEOUT_MS = 2000;

export function createAppIconLoader(request: typeof fetch = (url, init) => fetch(url, init), now = Date.now, store: IconStore | null = createIndexedDbStore()) {
  type User = { finish: (data: string | null) => void };
  type Entry = { id: string; started: boolean; users: Set<User> };
  type Icon = { url: string; bytes: Uint8Array };
  const memory = new Map<string, string>(), pending = new Map<string, Entry>(), failed = new Map<string, number>(), queue: Entry[] = [];
  let running = 0, scheduled = false, cleared: Promise<unknown> = Promise.resolve();
  const guard = <T>(work: () => Promise<T>, fallback: T): Promise<T> => { try { return work().catch(() => fallback); } catch { return Promise.resolve(fallback); } };
  const within = <T>(promise: Promise<T>, fallback: T) => new Promise<T>(resolve => { const timer = setTimeout(() => resolve(fallback), STORE_TIMEOUT_MS); void promise.then(value => { clearTimeout(timer); resolve(value); }); });
  const remember = (id: string, url: string) => { memory.delete(id); memory.set(id, url); while (memory.size > MEMORY_ICONS) memory.delete(memory.keys().next().value!); };
  function schedule() {
    if (scheduled || running >= 2 || !queue.length) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); });
  }
  async function read(ids: string[]): Promise<Map<string, Icon | null>> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), BATCH_TIMEOUT_MS);
    try {
      const response = await request("/api/app-icons", { method: "POST", credentials: "same-origin", signal: controller.signal,
        headers: {"Content-Type": "application/json", "X-Keyln-Client": "1"}, body: JSON.stringify({appIds: ids}) });
      if (response.status === 503 && Number(response.headers.get("content-length") ?? 0) <= 4096 &&
          (await response.json().catch(() => undefined))?.error?.code === "ICON_BUSY") throw new BusyError("Icon loading is busy.");
      if (!response.ok || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "") ||
          Number(response.headers.get("content-length") ?? 0) > 1_410_000) throw Error("Icon unavailable.");
      const reader = response.body?.getReader(); if (!reader) throw Error("Icon unavailable.");
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          length += chunk.value.length; if (length > 1_410_000) throw Error("Icon response too large."); chunks.push(chunk.value);
        }
      } finally { await reader.cancel(); }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const envelope = JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(bytes));
      if (!envelope || Object.keys(envelope).join() !== "icons" || !Array.isArray(envelope.icons) || envelope.icons.length !== ids.length)
        throw Error("Invalid icon response.");
      const result = new Map<string, Icon | null>();
      for (const item of envelope.icons) {
        if (!item || !ids.includes(item.appId) || result.has(item.appId)) throw Error("Invalid icon response.");
        if (item.code === "ICON_UNAVAILABLE" && Object.keys(item).sort().join() === "appId,code") { result.set(item.appId,null); continue; }
        if (Object.keys(item).sort().join() !== "appId,png" || typeof item.png !== "string" || item.png.length > 87_384 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(item.png)) throw Error("Invalid icon encoding.");
        const binary = atob(item.png);
        if (binary.length > 65_536 || btoa(binary) !== item.png) throw Error("Invalid icon encoding.");
        const data = Uint8Array.from(binary, byte => byte.charCodeAt(0)), size = imageDimensions(data,"image/png");
        if (size.width !== 128 || size.height !== 128) throw Error("Icon unavailable.");
        result.set(item.appId, { url: "data:image/png;base64," + item.png, bytes: data });
      }
      return result;
    } finally { clearTimeout(timer); }
  }
  // A busy Mac (503 ICON_BUSY) gets one more try shortly after; any other failure leaves the built-in icon (and a short cooldown).
  async function fetchBatch(ids: string[]): Promise<Map<string, Icon | null>> {
    try { return await read(ids); } catch (error) { if (!(error instanceof BusyError)) return new Map(); }
    await new Promise(resolve => setTimeout(resolve, BUSY_RETRY_MS));
    return read(ids).catch(() => new Map<string, Icon | null>());
  }
  function settle(entry: Entry, data: string | null) {
    if (pending.get(entry.id) === entry) pending.delete(entry.id);
    if (data) { remember(entry.id, data); failed.delete(entry.id); } else failed.set(entry.id, now());
    for (const user of [...entry.users]) user.finish(data);
  }
  function pump() {
    while (running < 2 && queue.length) {
      const batch = queue.splice(0,BATCH_ICONS); running++;
      for (const entry of batch) entry.started = true;
      void fetchBatch(batch.map(entry => entry.id)).then(result => {
        for (const entry of batch) {
          const icon = result.get(entry.id) ?? null;
          if (icon && store) void guard(() => store.put(entry.id, icon.bytes), undefined);
          settle(entry, icon?.url ?? null);
        }
      }).finally(() => { running--; schedule(); });
    }
  }
  // The disk comes first; only a miss (or a corrupted entry, which is dropped) asks the Mac.
  async function lookup(entry: Entry, disk: IconStore) {
    const bytes = await within(cleared.then(() => guard(() => disk.get(entry.id), undefined)), undefined);
    if (pending.get(entry.id) !== entry) return;
    if (!entry.users.size) { pending.delete(entry.id); return; }
    if (bytes) {
      const url = storedUrl(bytes);
      if (url) { settle(entry, url); return; }
      void guard(() => disk.delete(entry.id), undefined);
    }
    queue.push(entry); schedule();
  }
  function load(value: string, signal?: AbortSignal): Promise<string | null> {
    let id: string; try { id = appId(value); } catch { return Promise.resolve(null); }
    if (signal?.aborted) return Promise.resolve(null);
    const known = memory.get(id); if (known) { remember(id, known); return Promise.resolve(known); }
    const failedAt = failed.get(id);
    if (failedAt !== undefined) { if (now() - failedAt < COOLDOWN_MS) return Promise.resolve(null); failed.delete(id); }
    let entry = pending.get(id);
    if (!entry) {
      entry = {id, started:false, users:new Set()}; pending.set(id,entry);
      if (store) void lookup(entry, store); else { queue.push(entry); }
    }
    const target = entry;
    const promise = new Promise<string | null>(resolve => {
      const user: User = {finish(data) { target.users.delete(user); signal?.removeEventListener("abort",cancel); resolve(data); }};
      function cancel() {
        user.finish(null);
        if (!target.started && !target.users.size) {
          const index = queue.indexOf(target); if (index >= 0) queue.splice(index,1);
          if (pending.get(id) === target) pending.delete(id);
        }
      }
      target.users.add(user); signal?.addEventListener("abort",cancel,{once:true});
    });
    schedule(); return promise;
  }
  // A refresh or a reconnect forgets everything: memory, cooldowns and the disk copy. Icons are asked for again as they are shown.
  load.reset = () => { memory.clear(); failed.clear(); if (store) cleared = guard(() => store.clear(), undefined); };
  return load;
}
export const loadAppIcon = createAppIconLoader();
export const resetAppIcons = () => loadAppIcon.reset();
