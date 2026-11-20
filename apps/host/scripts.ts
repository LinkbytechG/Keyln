import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { exact, Fault, label, parseAction, parseShellParameters, revision, scriptVersion, stableId, validateShellArguments,
  type ScriptInfo, type ShellAction, type ShellParameter } from "../../packages/contracts/index.js";
import { atomicJSON, privateDir } from "./store.js";

export const SCRIPT_INTERPRETERS = ["/bin/zsh", "/bin/bash", "/bin/sh"] as const;
export const MAX_SCRIPT_BYTES = 65_536;
export const MAX_SCRIPTS = 32;
export const MAX_SCRIPT_TIMEOUT = 60_000;
export interface ScriptDefinition {
  id: string; name: string; kind: "file" | "command"; source: string;
  interpreter: typeof SCRIPT_INTERPRETERS[number]; parameters: ShellParameter[]; timeoutMs: number;
  approvedVersion?: string;
}
interface Registry { schemaVersion: 1; revision: number; scripts: ScriptDefinition[] }
interface ScriptMaterial { bytes: Buffer; cwd: string; version: string }
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function definition(value: unknown, id: string): ScriptDefinition {
  const obj = exact(value, ["name", "kind", "source", "interpreter", "parameters", "timeoutMs"]);
  if (!SCRIPT_INTERPRETERS.includes(obj.interpreter as ScriptDefinition["interpreter"]) ||
      !["file", "command"].includes(obj.kind as string) || typeof obj.source !== "string" || !obj.source.trim() || obj.source.includes("\0") ||
      Buffer.byteLength(obj.source) > MAX_SCRIPT_BYTES ||
      obj.kind === "file" && (!isAbsolute(obj.source) || obj.source.length > 2048 || /[\r\n]/.test(obj.source)) ||
      !Number.isInteger(obj.timeoutMs) || (obj.timeoutMs as number) < 100 || (obj.timeoutMs as number) > MAX_SCRIPT_TIMEOUT)
    throw new Fault("INVALID_INPUT", "Choose a shell, an absolute script path or command, and a timeout from 100 to 60000 ms.");
  return { id: stableId(id), name: label(obj.name), kind: obj.kind as ScriptDefinition["kind"], source: obj.source,
    interpreter: obj.interpreter as ScriptDefinition["interpreter"], parameters: parseShellParameters(obj.parameters), timeoutMs: obj.timeoutMs as number };
}
function material(script: ScriptDefinition): ScriptMaterial {
  let bytes: Buffer, canonical: string | null = null;
  if (script.kind === "command") bytes = Buffer.from(script.source, "utf8");
  else {
    let fd: number | undefined;
    try {
      // Open first without following the final symlink; read a bounded immutable copy from this descriptor.
      fd = openSync(script.source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_SCRIPT_BYTES) throw Error("Invalid script file.");
      canonical = realpathSync(script.source);
      const buffer = Buffer.alloc(MAX_SCRIPT_BYTES + 1); let size = 0, count: number;
      while ((count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) {
        size += count; if (size > MAX_SCRIPT_BYTES) throw Error("Script grew beyond the limit.");
      }
      bytes = buffer.subarray(0, size);
      if (!bytes.length || bytes.includes(0)) throw Error("Invalid script text.");
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch { throw new Fault("SCRIPT_UNAVAILABLE", "The script file is missing, unreadable, a link, or exceeds 64 KiB. Review it on the Mac."); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  const cwd = canonical ? dirname(canonical) : homedir();
  const version = digest(JSON.stringify({ ...script, approvedVersion: undefined, canonical, cwd, contentHash: digest(bytes), policy: 1 }));
  return { bytes, cwd, version };
}
export class ScriptRegistry {
  private current: Registry;
  readonly path: string;
  constructor(directory: string) {
    privateDir(directory); this.path = join(directory, "scripts.json");
    if (!existsSync(this.path)) atomicJSON(this.path, { schemaVersion: 1, revision: 0, scripts: [] });
    try {
      const obj = exact(JSON.parse(readFileSync(this.path, "utf8")), ["schemaVersion", "revision", "scripts"]);
      if (obj.schemaVersion !== 1 || !Array.isArray(obj.scripts) || obj.scripts.length > MAX_SCRIPTS) throw Error("Invalid registry.");
      const ids = new Set<string>();
      const scripts = obj.scripts.map(value => {
        const item = exact(value, ["id", "name", "kind", "source", "interpreter", "parameters", "timeoutMs",
          ...(Object.hasOwn(value, "approvedVersion") ? ["approvedVersion"] : [])]);
        const { id, approvedVersion, ...fields } = item;
        const script = definition(fields, stableId(id));
        if (ids.has(script.id)) throw Error("Duplicate script ID."); ids.add(script.id);
        return { ...script, ...(approvedVersion !== undefined ? { approvedVersion: scriptVersion(approvedVersion) } : {}) };
      });
      this.current = { schemaVersion: 1, revision: revision(obj.revision), scripts };
    } catch { throw Error("The local script registry is damaged or unsupported. It was preserved; restore it on the Mac before starting Host."); }
  }
  private find(id: unknown): ScriptDefinition {
    const script = this.current.scripts.find(item => item.id === stableId(id));
    if (!script) throw new Fault("SCRIPT_UNAVAILABLE", "This script is not registered on the Mac.");
    return script;
  }
  private check(value: unknown): void {
    if (revision(value) !== this.current.revision) throw new Fault("SCRIPT_CONFLICT", "The script registry changed. Reload it before saving or approving.", 409);
  }
  private commit(scripts: ScriptDefinition[]): void {
    if (this.current.revision >= Number.MAX_SAFE_INTEGER) throw new Fault("SCRIPT_CONFLICT", "The script registry revision limit was reached.", 409);
    const next: Registry = { schemaVersion: 1, revision: this.current.revision + 1, scripts };
    try { atomicJSON(this.path, next); } catch { throw new Fault("SAVE_FAILED", "Could not save the script registry. No approval was changed.", 500); }
    this.current = next;
  }
  localState() {
    return { revision: this.current.revision, scripts: this.current.scripts.map(script => {
      let version: string | undefined, error: string | undefined;
      try { version = material(script).version; } catch (reason) { error = (reason as Fault).message; }
      return { ...structuredClone(script), version, status: error ? "unavailable" : !script.approvedVersion ? "unapproved" :
        script.approvedVersion === version ? "approved" : "changed", error };
    }) };
  }
  available(): ScriptInfo[] {
    return this.current.scripts.flatMap(script => {
      if (!script.approvedVersion) return [];
      try {
        if (material(script).version !== script.approvedVersion) return [];
        return [{ id: script.id, name: script.name, version: script.approvedVersion, parameters: structuredClone(script.parameters) }];
      } catch { return []; }
    });
  }
  save(input: unknown) {
    const obj = exact(input, ["revision", "id", "definition"]); this.check(obj.revision);
    const id = obj.id === null ? `script-${randomUUID()}` : this.find(obj.id).id;
    if (obj.id === null && this.current.scripts.length >= MAX_SCRIPTS) throw new Fault("CAPACITY", "At most 32 local scripts can be registered.", 429);
    const next = definition(obj.definition, id); // Any edit removes the old approval.
    this.commit([...this.current.scripts.filter(item => item.id !== id), next]);
    return { id, ...this.localState() };
  }
  preview(input: unknown) {
    const obj = exact(input, ["id"]), script = this.find(obj.id), reviewed = material(script);
    return { id: script.id, revision: this.current.revision, name: script.name, version: reviewed.version, sourceText: reviewed.bytes.toString("utf8"),
      interpreter: script.interpreter, parameters: structuredClone(script.parameters), timeoutMs: script.timeoutMs };
  }
  approve(input: unknown) {
    const obj = exact(input, ["revision", "id", "version"]); this.check(obj.revision);
    const script = this.find(obj.id), version = scriptVersion(obj.version);
    if (material(script).version !== version) throw new Fault("SCRIPT_CHANGED", "The script changed after preview. Review the current content before approving.", 409);
    this.commit(this.current.scripts.map(item => item.id === script.id ? { ...item, approvedVersion: version } : item));
    return this.localState();
  }
  revoke(input: unknown) {
    const obj = exact(input, ["revision", "id"]); this.check(obj.revision);
    const script = this.find(obj.id);
    this.commit(this.current.scripts.map(item => { const { approvedVersion: _approval, ...draft } = item; return item.id === script.id ? draft : item; }));
    return this.localState();
  }
  remove(input: unknown) {
    const obj = exact(input, ["revision", "id"]); this.check(obj.revision);
    const script = this.find(obj.id); this.commit(this.current.scripts.filter(item => item.id !== script.id));
    return this.localState();
  }
  prepare(input: ShellAction): ScriptMaterial & { interpreter: ScriptDefinition["interpreter"]; args: string[]; timeoutMs: number } {
    const action = parseAction(input);
    if (action.type !== "shell.run") throw new Fault("INVALID_INPUT", "Choose an approved script.");
    const script = this.find(action.scriptId);
    if (!script.approvedVersion) throw new Fault("SCRIPT_UNAPPROVED", "Approve this script on the Mac before using it.");
    const reviewed = material(script);
    if (script.approvedVersion !== action.version || reviewed.version !== action.version)
      throw new Fault("SCRIPT_CHANGED", "The approved script version changed. Review it on the Mac, then select the approved version again.");
    validateShellArguments(script.parameters, action.args);
    return { ...reviewed, interpreter: script.interpreter, args: [...action.args], timeoutMs: script.timeoutMs };
  }
}
