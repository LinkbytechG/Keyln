import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FORMAT, CONFIG_VERSION } from "../../packages/contracts/index.js";
import { atomicJSON, privateDir } from "./store.js";

// T65/T94: v1/v2/v3 configuration files and My icons stay in place. The read boundary converts v1/v2 without writing it.
// Only unsupported older configurations and retired per-device structures move to archive-<time>/. TLS, pairing, scripts and host.json stay untouched.
export const MARKER = "layout-format.json";
// The configuration, its backups and restore copies: the files whose `format` tells whether they are current.
const CONFIG_FILES = /^config(?:\.[^/]+)?\.json$/;
// Files of structures that no longer exist (T62): device layouts and theme canvases. They are always archived.
const RETIRED_FILES = /^(?:device-layouts|theme-canvases)(?:\.[^/]+)?\.(?:json|corrupt)$/;
const MAX_LEGACY_BYTES = 4_194_304;
// keyln.config v1, v2 and v3 are supported reads (T94): a v1/v2 file is converted when it is read (imports, backups) and is migrated by `npm run layout:migrate`,
// never moved aside. Anything else that parses as JSON is unsupported. A file that is not JSON at all is not judged here: the store keeps it aside as damaged or
// asks for recovery, as it always did.
const SUPPORTED_VERSIONS: readonly number[] = [1, 2, CONFIG_VERSION];
function configJSON(path: string): { format?: unknown; version?: unknown } | null | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_LEGACY_BYTES) return undefined;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path))) as { format?: unknown; version?: unknown } | null;
  } catch { return undefined; }
}
function legacy(path: string): boolean {
  const value = configJSON(path);
  if (value === undefined) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  return value.format !== CONFIG_FORMAT || !SUPPORTED_VERSIONS.includes(value.version as number);
}
export function archiveLegacyData(dir: string, log: (message: string) => void = message => console.log(message), now = Date.now): string | undefined {
  privateDir(dir);
  const marker = join(dir, MARKER);
  let marked = false;
  try {
    const value = JSON.parse(readFileSync(marker, "utf8")) as { format?: unknown; version?: unknown };
    marked = value.format === CONFIG_FORMAT && value.version === CONFIG_VERSION;
  } catch { /* No marker yet. */ }
  const found = readdirSync(dir).filter(name => {
    const path = join(dir, name);
    if (RETIRED_FILES.test(name)) return true;
    return CONFIG_FILES.test(name) && legacy(path);
  });
  let folder: string | undefined;
  if (found.length) {
    const base = `archive-${new Date(now()).toISOString().replace(/[:.]/g, "-")}`;
    folder = join(dir, base);
    for (let n = 2; existsSync(folder); n++) folder = join(dir, `${base}-${n}`);
    mkdirSync(folder, { mode: 0o700 }); chmodSync(folder, 0o700);
    for (const name of found) renameSync(join(dir, name), join(folder, name));
    log(`Old-format data moved to ${folder}: ${found.join(", ")}. Starting with the default configuration; nothing was deleted. Supported v1 files are converted only when read.`);
  }
  // The marker says version 3 only for a directory that is in the v3 format: a fresh one (no config.json yet) or one that `npm run layout:migrate` has converted.
  // A directory whose config.json is still v1 or v2 is left unmarked, so a Host that refuses to run on it never claims it is current.
  const current = configJSON(join(dir, "config.json"));
  if (!marked && (current === undefined || current === null || current.version === CONFIG_VERSION || current.format !== CONFIG_FORMAT)) atomicJSON(marker, { format: CONFIG_FORMAT, version: CONFIG_VERSION });
  return folder;
}
