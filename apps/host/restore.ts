import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJSON, configurationBytes, configurationFile, defaultDataDir, lockDataDir } from "./store.js";

let unlock: (() => void) | undefined;
try {
  const dir = defaultDataDir(); unlock = lockDataDir(dir);
  const backup = configurationFile(join(dir, "config.backup.json"));
  // Preserve the damaged file for inspection; never overwrite the backup.
  let previous: Buffer | undefined;
  try { previous = configurationBytes(join(dir, "config.json")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (previous !== undefined) atomicJSON(join(dir, `config.before-restore-${Date.now()}-${randomUUID()}.json`), { encoding: "base64", originalBase64: previous.toString("base64") });
  // Restoring can roll back a revision. Revoke old sessions first so a stale client
  // can never mistake a subsequently reused revision for its old configuration.
  atomicJSON(join(dir, "devices.json"), { schemaVersion: 1, devices: [] });
  atomicJSON(join(dir, "config.json"), backup);
  console.log(`Restored configuration revision ${backup.library.revision}. Device authorizations were revoked for revision safety. Restart Host and pair again.`);
} catch (error) { console.error(`Restore failed; configuration was preserved: ${(error as Error).message}`); process.exitCode = 1; }
finally { unlock?.(); }
