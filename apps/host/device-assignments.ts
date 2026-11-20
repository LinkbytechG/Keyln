import { existsSync, lstatSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { deviceThemeId, emptyDeviceAssignments, layoutName, parseDeviceAssignmentFile, type DeviceAssignmentFile } from "../../packages/contracts/index.js";
import { atomicJSON, privateDir } from "./store.js";

// T94 (ADR-086, ADR-087): which layout each paired device shows, `{ format, version, devices: { [deviceId]: { layout } } }` in device-assignments.json beside config.json.
// The layouts themselves live in the configuration, by name. A device with no entry, or whose layout no longer exists, uses the default layout. Every method takes the
// device id the caller got from its cookie, never from a request. (There is no screen to change an assignment yet; T96 adds it.)
const MAX_BYTES = 65_536;
export class DeviceAssignments {
  readonly path: string;
  /** Set when a damaged file was moved aside at start-up. */
  damagedCopy?: string;
  private data: DeviceAssignmentFile = emptyDeviceAssignments();
  constructor(dir: string, private log: (message: string) => void = message => console.error(message), private now = Date.now) {
    privateDir(dir); this.path = join(dir, "device-assignments.json");
    if (!existsSync(this.path)) return;
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("not a regular file within its size limit");
      this.data = parseDeviceAssignmentFile(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(this.path))));
    } catch (error) {
      // A damaged file never stops the Host: keep it under a name that cannot overwrite anything and run with every device on the default layout.
      this.data = emptyDeviceAssignments();
      const base = `device-assignments.${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}`;
      let copy = join(dir, `${base}.corrupt`);
      for (let n = 2; existsSync(copy); n++) copy = join(dir, `${base}-${n}.corrupt`);
      try { renameSync(this.path, copy); this.damagedCopy = copy; } catch { /* The next write replaces it. */ }
      this.log(`Device assignments file is damaged (${(error as Error).message}). ${this.damagedCopy ? `It was kept at ${this.damagedCopy}` : "It could not be moved aside"}; every device uses the default layout.`);
    }
  }
  /** The layout the device was given, or undefined when it has no entry. It may name a layout that no longer exists: the caller falls back to the default. */
  get(id: string): string | undefined { return this.data.devices[deviceThemeId(id)]?.layout; }
  /** The layout the device shows: its assignment while that layout exists, else `fallback` (the default layout). */
  layoutOf(id: string, names: readonly string[], fallback: string): string {
    const name = this.get(id);
    return name !== undefined && names.includes(name) ? name : fallback;
  }
  /** Gives the device a layout. The same assignment writes nothing. */
  set(id: string, layout: unknown): string {
    deviceThemeId(id);
    const name = layoutName(layout);
    if (this.data.devices[id]?.layout === name) return name;
    const next = structuredClone(this.data);
    next.devices[id] = { layout: name };
    atomicJSON(this.path, next); this.data = next;
    return name;
  }
}
