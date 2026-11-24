import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// T125 (ADR-109): scripts/build.mjs writes package.json's version next to the compiled Host as version.json; both service layouts copy dist/apps whole, so it travels with the runtime.
export const UNKNOWN_VERSION = "unknown";
export function readVersion(dir = dirname(fileURLToPath(import.meta.url))): string {
  try {
    const value = (JSON.parse(readFileSync(join(dir, "version.json"), "utf8")) as { version?: unknown }).version;
    return typeof value === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(value) ? value : UNKNOWN_VERSION;
  } catch { return UNKNOWN_VERSION; }
}
