import { appId, Fault, imageDimensions } from "../../packages/contracts/index.js";

export const APP_ICON_SIZE = 128, MAX_APP_ICON_BYTES = 65_536;
export const MAX_ICON_BATCH = 16, MAX_ICON_REPLY_BYTES = 1_410_000;
export const ICON_CACHE_MS = 3_600_000, ICON_CACHE_ITEMS = 512, ICON_CACHE_BYTES = 8 * 1024 * 1024;
export function appIconIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ICON_BATCH)
    throw new Fault("INVALID_APP", "Use one to sixteen distinct application identifiers.");
  const ids = value.map(appId);
  if (new Set(ids).size !== ids.length) throw new Fault("INVALID_APP", "Use distinct application identifiers.");
  return ids;
}
export function validateAppIcon(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.length > MAX_APP_ICON_BYTES)
    throw new Fault("ICON_UNAVAILABLE", "The Mac icon is unavailable or too large.", 503);
  const { width, height } = imageDimensions(value, "image/png");
  if (width !== APP_ICON_SIZE || height !== APP_ICON_SIZE)
    throw new Fault("ICON_UNAVAILABLE", "The Mac icon has an unsupported size.", 503);
  return Buffer.from(value);
}

// No disk paths or durable cache; authentication stays outside this cache on every request.
export class AppIcons {
  private cache = new Map<string, { data: Buffer; at: number }>();
  private pending = new Map<string, Promise<Buffer>>();
  private bytes = 0;
  private active = 0;
  constructor(private read: (id: string) => Promise<Uint8Array>, private now = Date.now,
    private readMany?: (ids: string[]) => Promise<Map<string, Uint8Array>>) {}
  async get(value: string): Promise<Buffer> {
    const [data] = await this.getMany([value]);
    if (!data) throw new Fault("ICON_UNAVAILABLE", "This Mac icon is unavailable.", 503);
    return data;
  }
  async getMany(values: string[]): Promise<(Buffer | null)[]> {
    const ids = appIconIds(values), hits = new Map<string, Buffer>();
    for (const id of ids) {
      const hit = this.cache.get(id);
      if (hit) {
        this.cache.delete(id); this.bytes -= hit.data.length;
        if (this.now() - hit.at < ICON_CACHE_MS) {
          this.cache.set(id, hit); this.bytes += hit.data.length; hits.set(id, hit.data);
        }
      }
    }
    const missing = ids.filter(id => !hits.has(id) && !this.pending.has(id));
    if (missing.length) {
      if (this.active >= 2) throw new Fault("ICON_BUSY", "Icon loading is busy. The built-in icon is still available.", 503);
      this.active++;
      const batch = Promise.resolve().then(async () => {
        if (this.readMany) return await this.readMany(missing);
        // Compatibility for single-reader adapters: never fan out sixteen native processes.
        const result = new Map<string, Uint8Array>();
        for (const id of missing) { try { result.set(id, await this.read(id)); } catch {} }
        return result;
      }).finally(() => { this.active--; });
      for (const id of missing) {
        const promise = batch.then(values => {
          const value = values.get(id);
          if (!value) throw new Fault("ICON_UNAVAILABLE", "This Mac icon is unavailable.", 503);
          const data = validateAppIcon(value);
          while (this.cache.size >= ICON_CACHE_ITEMS || this.bytes + data.length > ICON_CACHE_BYTES) {
            const oldest = this.cache.keys().next().value!;
            this.bytes -= this.cache.get(oldest)!.data.length; this.cache.delete(oldest);
          }
          this.cache.set(id, {data, at: this.now()}); this.bytes += data.length; return data;
        }).finally(() => this.pending.delete(id));
        this.pending.set(id, promise);
      }
    }
    return await Promise.all(ids.map(id => hits.has(id) ? hits.get(id)! : this.pending.get(id)!.catch(() => null)));
  }
}
