import { lstatSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { curatedIconSet, exact, Fault, ICON_PREFIX_LIMIT, ICON_SETS, ICON_UNKNOWN_LICENSE, iconId, iconLabel, iconQuery, iconScope, iconSet, iconSvg, MAX_SVG_BYTES, record, revision,
  type IconScope, type IconSetPrefix, type LibraryIcon } from "../../packages/contracts/index.js";
import { atomicJSON, privateDir } from "./store.js";

// T31/T32. Two independent parts: a tiny read-only Iconify client (the only outbound HTTPS this Host makes, to one fixed
// host) and the offline "My icons" store. Nothing here ever sends a device name, ID, cookie or layout content.
export const ICONIFY_ORIGIN = "https://api.iconify.design";
// One search request plus one icon-data request per distinct icon set among the results. A search of all Iconify sets can
// name dozens of sets, so only the first ICON_PREFIX_LIMIT sets (in Iconify's own order) are kept: at most 1 + 12 requests.
export const ICON_RESULT_LIMIT = 48, ICON_REQUEST_LIMIT = 1 + ICON_PREFIX_LIMIT, ICON_FETCH_CONCURRENCY = 4;
export const ICONIFY_LIMITS = { requestMs: 5_000, totalMs: 9_000, searchBytes: 262_144, dataBytes: 262_144 } as const;
export const MAX_SEARCH_REPLY_BYTES = 1_048_576;
export const ICON_CACHE_MS = 600_000, ICON_CACHE_QUERIES = 256, ICON_CACHE_ICONS = 512, ICON_CACHE_BYTES = 8 * 1024 * 1024, ICON_CACHE_SETS = 512, ICON_SEARCHES = 2;
export const MAX_LIBRARY_ICONS = 500, MAX_LIBRARY_BYTES = 4 * 1024 * 1024, MAX_LIBRARY_REPLY_BYTES = MAX_LIBRARY_BYTES + 65_536;

export interface SetInfo { setName: string; license: string }
export interface DrawnIcon { id: string; set: string; name: string; svg: string }
export interface IconResult extends DrawnIcon, SetInfo {}
/**
 * `truncated` is true only when at least one icon was left out because its icon set was beyond the first ICON_PREFIX_LIMIT sets
 * of the answer. Iconify's own `limit=48` cut is not counted.
 */
export interface IconSearchResult { results: IconResult[]; truncated: boolean }
// The raw network side. IconSearch wraps it with limits and caching; tests and the UI fixture inject fakes.
export interface IconSource {
  search(query: string, scope: IconScope, set?: IconSetPrefix): Promise<IconSearchResult>;
  icon(id: string): Promise<string>;
}
const unavailable = () => new Fault("ICON_SEARCH_UNAVAILABLE",
  "Searching online icons needs your Mac to reach the internet. My icons still works offline.", 503);
// Whatever goes wrong while talking to Iconify - network, status, size, format - is one answer for the person using the page.
const asUnavailable = (error: unknown) => error instanceof Fault && error.code === "ICON_SEARCH_UNAVAILABLE" ? error : unavailable();
const plain = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function readBody(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get("content-length") ?? 0) > limit) throw unavailable();
  const reader = response.body?.getReader(); if (!reader) throw unavailable();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length; if (size > limit) throw unavailable();
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}
const dimension = (value: unknown, fallback: number, positive = false) => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 4096 || positive && value <= 0) throw Error("Invalid size.");
  return value;
};
// Turns an IconifyJSON answer into complete, validated SVG documents. Anything unusual is dropped, never repaired.
export function assembleIcons(data: unknown, set: string, names: string[]): DrawnIcon[] {
  const root = record(data);
  if (root.prefix !== set) throw Error("Unexpected icon set.");
  const icons = record(root.icons), aliases = root.aliases === undefined ? {} : record(root.aliases);
  const result: DrawnIcon[] = [];
  for (const name of names) {
    try {
      let current: Record<string, unknown> | undefined = Object.hasOwn(icons, name) ? record(icons[name]) : undefined;
      let key = name, hops = 0; const chain: Record<string, unknown>[] = [];
      while (!current && Object.hasOwn(aliases, key) && hops++ < 3) {
        const alias = record(aliases[key]);
        if (typeof alias.parent !== "string") throw Error("Alias without parent.");
        chain.push(alias); key = alias.parent; current = Object.hasOwn(icons, key) ? record(icons[key]) : undefined;
      }
      if (!current) continue;
      // Flips and rotations (only reachable through aliases or the icon itself) are skipped rather than re-implemented.
      if ([current, ...chain].some(layer => layer.rotate || layer.hFlip || layer.vFlip)) throw Error("Transformed icons are skipped.");
      let width = current.width, height = current.height;
      for (const alias of chain.reverse()) { width = alias.width ?? width; height = alias.height ?? height; }
      if (typeof current.body !== "string" || current.body.length > MAX_SVG_BYTES) throw Error("Invalid body.");
      const w = dimension(width ?? root.width, 16, true), h = dimension(height ?? root.height, 16, true);
      const left = dimension(current.left ?? root.left, 0), top = dimension(current.top ?? root.top, 0);
      const svg = iconSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${w} ${h}" width="${w}" height="${h}">${current.body}</svg>`);
      result.push({ id: `${set}:${name}`, set, name, svg });
    } catch { /* A single unusable icon never fails the whole search. */ }
  }
  return result;
}

/**
 * Name and licence of one icon set. The six curated sets always use the frozen table in contracts. Any other set takes them from
 * the `collections` object of the very same /search answer ({ prefix: { name, license: { title, spdx } } }), so asking costs no
 * request. A missing, oversized or non-printable value never fails the search: the name falls back to the prefix and the
 * licence to "Unknown license".
 */
export function setInfo(prefix: string, collections: unknown): SetInfo {
  const curated = curatedIconSet(prefix);
  if (curated) return { setName: curated.name, license: curated.license };
  const table = plain(collections), entry = plain(Object.hasOwn(table, prefix) ? table[prefix] : undefined), license = plain(entry.license);
  return { setName: iconLabel(entry.name) ?? prefix, license: iconLabel(license.spdx) ?? iconLabel(license.title) ?? ICON_UNKNOWN_LICENSE };
}

export class IconifyClient implements IconSource {
  constructor(private request: typeof fetch = (url, init) => fetch(url, init), private limits: { requestMs: number; totalMs: number; searchBytes: number; dataBytes: number } = ICONIFY_LIMITS) {}
  private async json(path: string, limit: number, total: AbortSignal): Promise<unknown> {
    const url = `${ICONIFY_ORIGIN}${path}`;
    if (new URL(url).origin !== ICONIFY_ORIGIN) throw unavailable();
    try {
      // The signal ends at whichever comes first: this request's 5 seconds or the whole search's 9 seconds.
      const response = await this.request(url, { method: "GET", redirect: "error", credentials: "omit",
        headers: { "User-Agent": "Keyln" }, signal: AbortSignal.any([AbortSignal.timeout(this.limits.requestMs), total]) });
      if (response.status !== 200 || !/\bjson\b/i.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel().catch(() => {}); throw unavailable();
      }
      return JSON.parse(await readBody(response, limit));
    } catch (error) { throw asUnavailable(error); }
  }
  /** "curated" searches the six curated sets (or just `set`); "all" searches every Iconify set and takes no `set`. */
  async search(query: string, scope: IconScope = "curated", set?: IconSetPrefix): Promise<IconSearchResult> {
    const text = iconQuery(query), kind = iconScope(scope);
    if (kind === "all" && set !== undefined) throw new Fault("INVALID_INPUT", "Choose one icon set or search all sets, not both.");
    const prefixes = kind === "all" ? undefined : set ? [iconSet(set)] : ICON_SETS.map(item => item.prefix);
    const stop = new AbortController();
    try { return await this.lookup(text, prefixes, stop); }
    catch (error) { stop.abort(); throw asUnavailable(error); }
  }
  private async lookup(text: string, prefixes: IconSetPrefix[] | undefined, stop: AbortController): Promise<IconSearchResult> {
    const total = AbortSignal.any([AbortSignal.timeout(this.limits.totalMs), stop.signal]); let requests = 0;
    const get = (path: string, limit: number) => { if (++requests > ICON_REQUEST_LIMIT) throw unavailable(); return this.json(path, limit, total); };
    // Without `prefixes`, Iconify searches all of its icon sets.
    const found = record(await get(`/search?query=${encodeURIComponent(text)}${prefixes ? `&prefixes=${prefixes.join(",")}` : ""}&limit=${ICON_RESULT_LIMIT}`, this.limits.searchBytes));
    if (!Array.isArray(found.icons)) throw unavailable();
    const order: string[] = [], groups = new Map<string, string[]>(); let truncated = false;
    for (const value of found.icons) {
      let parsed: ReturnType<typeof iconId>;
      try { parsed = iconId(value); } catch { continue; }
      if (prefixes && !(prefixes as string[]).includes(parsed.set) || order.includes(parsed.id) || order.length >= ICON_RESULT_LIMIT) continue;
      // Iconify's order is kept; icons of a thirteenth and later distinct set are dropped so the request count stays bounded.
      if (!groups.has(parsed.set) && groups.size >= ICON_PREFIX_LIMIT) { truncated = true; continue; }
      order.push(parsed.id); groups.set(parsed.set, [...(groups.get(parsed.set) ?? []), parsed.name]);
    }
    const byId = new Map<string, IconResult>(), queue = [...groups];
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const [prefix, all] = item, names: string[] = []; let length = 0;
        // Keep each request URL short; an unusually long list loses its tail rather than costing another request.
        for (const name of [...all].sort()) { length += name.length + 1; if (length > 1_700) break; names.push(name); }
        const info = setInfo(prefix, found.collections);
        for (const icon of assembleIcons(await get(`/${prefix}.json?icons=${names.join(",")}`, this.limits.dataBytes), prefix, names)) byId.set(icon.id, { ...icon, ...info });
      }
    };
    await Promise.all(Array.from({ length: Math.min(ICON_FETCH_CONCURRENCY, queue.length) }, worker));
    return { results: order.flatMap(id => byId.get(id) ?? []), truncated };
  }
  async icon(id: string): Promise<string> {
    const { set, name } = iconId(id), total = AbortSignal.timeout(this.limits.totalMs);
    let icons: DrawnIcon[];
    try { icons = assembleIcons(await this.json(`/${set}.json?icons=${name}`, this.limits.dataBytes, total), set, [name]); }
    catch (error) { throw asUnavailable(error); }
    const icon = icons[0];
    if (!icon) throw new Fault("ICON_NOT_FOUND", "That icon is not available as plain SVG. Choose another one.", 404);
    return icon.svg;
  }
}

interface CachedIcon extends SetInfo { svg: string; at: number }
// Concurrency, caching and last-line validation in front of whichever source the Host was given.
export class IconSearch {
  private queries = new Map<string, { ids: string[]; truncated: boolean; at: number }>();
  private icons = new Map<string, CachedIcon>();
  // Name and licence of every non-curated set seen in a search answer. Saving an icon from such a set can only use these,
  // because the person's device never sends them; so they stay (bounded) for as long as the Host runs.
  private sets = new Map<string, SetInfo>();
  private pending = new Map<string, Promise<IconSearchResult>>();
  private bytes = 0; private active = 0;
  constructor(private source: IconSource, private now = Date.now) {}
  private remember(result: IconResult) {
    const known = this.icons.get(result.id);
    if (known) { this.bytes -= known.svg.length; this.icons.delete(result.id); }
    while (this.icons.size >= ICON_CACHE_ICONS || this.bytes + result.svg.length > ICON_CACHE_BYTES) {
      const oldest = this.icons.keys().next().value; if (oldest === undefined) break;
      this.bytes -= this.icons.get(oldest)!.svg.length; this.icons.delete(oldest);
    }
    this.icons.set(result.id, { svg: result.svg, setName: result.setName, license: result.license, at: this.now() }); this.bytes += result.svg.length;
    if (!curatedIconSet(result.set)) {
      this.sets.delete(result.set);
      while (this.sets.size >= ICON_CACHE_SETS) this.sets.delete(this.sets.keys().next().value!);
      this.sets.set(result.set, { setName: result.setName, license: result.license });
    }
  }
  private cached(id: string): CachedIcon | undefined {
    const hit = this.icons.get(id);
    if (!hit) return undefined;
    if (this.now() - hit.at >= ICON_CACHE_MS) { this.bytes -= hit.svg.length; this.icons.delete(id); return undefined; }
    return hit;
  }
  private async limited<T>(run: () => Promise<T>): Promise<T> {
    if (this.active >= ICON_SEARCHES) throw new Fault("BUSY", "Icon search is busy. Try again in a moment.", 409);
    this.active++;
    try { return await run(); } finally { this.active--; }
  }
  /** Curated sets use the frozen table; any other set uses what the source reported, checked again here. */
  private describe(prefix: string, item?: { setName?: unknown; license?: unknown }): SetInfo {
    const curated = curatedIconSet(prefix);
    if (curated) return { setName: curated.name, license: curated.license };
    return { setName: iconLabel(item?.setName) ?? prefix, license: iconLabel(item?.license) ?? ICON_UNKNOWN_LICENSE };
  }
  async search(query: string, scope: IconScope = "curated", set?: IconSetPrefix): Promise<IconSearchResult> {
    const text = iconQuery(query), kind = iconScope(scope);
    if (kind === "all" && set !== undefined) throw new Fault("INVALID_INPUT", "Choose one icon set or search all sets, not both.");
    const prefix = set === undefined ? undefined : iconSet(set), key = `${kind}|${prefix ?? "*"}|${text.toLowerCase()}`;
    const hit = this.queries.get(key);
    if (hit) {
      const entries = hit.ids.map(id => this.cached(id));
      if (this.now() - hit.at < ICON_CACHE_MS && entries.every(entry => entry !== undefined)) {
        this.queries.delete(key); this.queries.set(key, hit);
        // A cached answer keeps the same truncation flag as the answer it came from.
        return { results: hit.ids.map((id, index) => { const { set: s, name } = iconId(id), entry = entries[index]!; return { id, set: s, name, svg: entry.svg, setName: entry.setName, license: entry.license }; }), truncated: hit.truncated };
      }
      this.queries.delete(key);
    }
    const running = this.pending.get(key); if (running) return await running;
    const promise = this.limited(async () => {
      const results: IconResult[] = [], seen = new Set<string>(), sets = new Set<string>();
      const answer = await this.source.search(text, kind, prefix); let truncated = kind === "all" && answer.truncated === true; // only an all-sets search can lose icons to the set limit
      for (const item of answer.results) {
        // Whatever the source returns is re-checked here; a bad entry is dropped, it never fails the search.
        try {
          const parsed = iconId(item.id);
          if (seen.has(parsed.id) || results.length >= ICON_RESULT_LIMIT) continue;
          // A curated search can only contain curated sets; an all-sets search at most ICON_PREFIX_LIMIT distinct sets.
          if (kind === "curated" ? !curatedIconSet(parsed.set) || prefix && parsed.set !== prefix : !sets.has(parsed.set) && sets.size >= ICON_PREFIX_LIMIT) {
            // A source that returned icons of too many sets is cut here too, and that counts as truncation.
            if (kind === "all") truncated = true;
            continue;
          }
          results.push({ id: parsed.id, set: parsed.set, name: parsed.name, svg: iconSvg(item.svg), ...this.describe(parsed.set, item) });
          seen.add(parsed.id); sets.add(parsed.set);
        } catch { /* Drop an unusable icon. */ }
      }
      return { results, truncated };
    }).then(answer => {
      for (const result of answer.results) this.remember(result);
      while (this.queries.size >= ICON_CACHE_QUERIES) this.queries.delete(this.queries.keys().next().value!);
      this.queries.set(key, { ids: answer.results.map(result => result.id), truncated: answer.truncated, at: this.now() });
      return answer;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return await promise;
  }
  /**
   * The SVG of one icon plus its set's name and licence, for saving into My icons. A non-curated set must have been seen in an
   * earlier search (that is where its licence came from); otherwise nothing is downloaded and the person is asked to search again.
   */
  async icon(id: string): Promise<IconResult> {
    const parsed = iconId(id), curated = curatedIconSet(parsed.set), known = this.sets.get(parsed.set);
    if (!curated && !known) throw new Fault("ICON_SET_UNKNOWN", "Search for this icon again, then tap it to save it.", 409);
    const info: SetInfo = curated ? { setName: curated.name, license: curated.license } : known!, hit = this.cached(parsed.id);
    if (hit) return { ...parsed, svg: hit.svg, ...info };
    const svg = iconSvg(await this.limited(() => this.source.icon(parsed.id)));
    this.remember({ ...parsed, svg, ...info });
    return { ...parsed, svg, ...info };
  }
}

// schemaVersion 1 (T31) had no setName or license; 2 (T32) has both. Version 1 files are read and upgraded on the next write.
interface Library { schemaVersion: 1 | 2; revision: number; icons: LibraryIcon[] }
const emptyLibrary = (): Library => ({ schemaVersion: 2, revision: 0, icons: [] });
function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function printable(value: unknown): string {
  const text = iconLabel(value);
  if (text === undefined) throw Error("Invalid icon set label.");
  return text;
}
function readLibrary(path: string): Library {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LIBRARY_BYTES) throw Error("Not a regular file within the limit.");
  const obj = exact(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path))), ["schemaVersion", "revision", "icons"]);
  const version = obj.schemaVersion;
  if (version !== 1 && version !== 2 || !Array.isArray(obj.icons) || obj.icons.length > MAX_LIBRARY_ICONS) throw Error("Unsupported library.");
  const ids = new Set<string>();
  const icons = obj.icons.map((value: unknown): LibraryIcon => {
    const item = exact(value, version === 1 ? ["id", "set", "name", "svg", "addedAt"] : ["id", "set", "name", "svg", "addedAt", "setName", "license"]), parsed = iconId(item.id);
    if (item.set !== parsed.set || item.name !== parsed.name || !Number.isSafeInteger(item.addedAt) || (item.addedAt as number) < 0 || ids.has(parsed.id)) throw Error("Invalid icon.");
    ids.add(parsed.id);
    // T31 only ever stored the six curated sets, so their name and licence come from the frozen table.
    const curated = curatedIconSet(parsed.set);
    if (version === 1 && !curated) throw Error("Unknown icon set in a version 1 library.");
    return { id: parsed.id, set: parsed.set, name: parsed.name, svg: iconSvg(item.svg), addedAt: item.addedAt as number,
      setName: version === 1 ? curated!.name : printable(item.setName), license: version === 1 ? curated!.license : printable(item.license) };
  });
  return { schemaVersion: version, revision: revision(obj.revision), icons };
}

// Offline vector originals, shared by every paired device. Not part of the layout, its export or its backup:
// each key that uses an icon already carries its own raster copy.
export class IconLibrary {
  readonly path: string;
  /** Set when a damaged file was moved aside at start-up; the name never overwrites an existing file. */
  damagedCopy?: string;
  private current: Library = emptyLibrary();
  private failure = "";
  constructor(directory: string, private now = Date.now) {
    privateDir(directory); this.path = join(directory, "icon-library.json");
    try {
      if (!present(this.path)) atomicJSON(this.path, this.current);
      else this.current = readLibrary(this.path);
    } catch {
      // A damaged or unreadable file must never stop the Host. Keep it under a name that cannot overwrite anything, then start empty.
      this.current = emptyLibrary();
      try {
        const copy = join(directory, `icon-library.damaged-${Date.now()}-${randomUUID()}.json`);
        renameSync(this.path, copy); this.damagedCopy = copy;
        atomicJSON(this.path, this.current);
      } catch { this.failure = "My icons could not be opened or repaired on the Mac. Check the Keyln data folder permissions."; }
    }
  }
  state(): { revision: number; icons: LibraryIcon[] } { return { revision: this.current.revision, icons: structuredClone(this.current.icons) }; }
  find(id: string): LibraryIcon | undefined {
    const icon = this.current.icons.find(item => item.id === iconId(id).id);
    return icon && structuredClone(icon);
  }
  private commit(icons: LibraryIcon[]): void {
    if (this.failure) throw new Fault("ICON_LIBRARY_UNAVAILABLE", this.failure, 503);
    if (this.current.revision >= Number.MAX_SAFE_INTEGER) throw new Fault("ICON_LIBRARY_FULL", "My icons reached its revision limit.", 409);
    // Every write is version 2, which is how a version 1 file gets upgraded.
    const next: Library = { schemaVersion: 2, revision: this.current.revision + 1, icons };
    if (Buffer.byteLength(JSON.stringify(next, null, 2) + "\n") > MAX_LIBRARY_BYTES)
      throw new Fault("ICON_LIBRARY_FULL", "My icons is full (4 MiB). Remove some icons first.", 409);
    try { atomicJSON(this.path, next); } catch { throw new Fault("SAVE_FAILED", "Could not save My icons. Check Mac disk space and permissions.", 500); }
    this.current = next;
  }
  /**
   * Idempotent: an icon that is already stored is returned unchanged, with no write. `info` is the set's name and licence;
   * without it only the six curated sets (whose details are frozen in contracts) can be added.
   */
  add(id: string, svg: string, info?: SetInfo): LibraryIcon {
    const parsed = iconId(id), known = this.find(parsed.id);
    if (known) return known;
    const curated = curatedIconSet(parsed.set), setName = iconLabel(info ? info.setName : curated?.name), license = iconLabel(info ? info.license : curated?.license);
    if (setName === undefined || license === undefined) throw new Fault("INVALID_INPUT", "This icon set needs a name and a license.");
    const icon: LibraryIcon = { id: parsed.id, set: parsed.set, name: parsed.name, svg: iconSvg(svg), addedAt: this.now(), setName, license };
    if (this.current.icons.length >= MAX_LIBRARY_ICONS)
      throw new Fault("ICON_LIBRARY_FULL", `My icons holds at most ${MAX_LIBRARY_ICONS} icons. Remove some first.`, 409);
    this.commit([...this.current.icons, icon]);
    return structuredClone(icon);
  }
  /** Returns whether anything was removed; removing an icon that is not there is not an error. */
  remove(id: string): boolean {
    const parsed = iconId(id);
    if (!this.current.icons.some(item => item.id === parsed.id)) return false;
    this.commit(this.current.icons.filter(item => item.id !== parsed.id));
    return true;
  }
}
