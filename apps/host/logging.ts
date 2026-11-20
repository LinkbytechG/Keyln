import { appendFileSync, existsSync, lstatSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { privateDir } from "./store.js";

export const LOG_BYTES = 1_048_576;
export function rotatingLog(dir: string, limit = LOG_BYTES) {
  try {if(!lstatSync(dir).isDirectory()||lstatSync(dir).isSymbolicLink())throw new Error("The log directory must not be a link.");} catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  privateDir(dir); const path = join(dir, "host.log"), previous = path + ".1";
  for (const file of [path, previous]) {
    try {const stat = lstatSync(file);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Log files must be ordinary private files owned by this user.");
    } catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
  return (stream: "stdout" | "stderr" | "service", message: string) => {
    const line = JSON.stringify({time:new Date().toISOString(),stream,message:message.slice(0,2048)}) + "\n";
    if (existsSync(path) && lstatSync(path).size + Buffer.byteLength(line) > limit) {
      rmSync(previous, {force:true}); renameSync(path, previous);
    }
    appendFileSync(path, line, {mode:0o600});
  };
}
export function lineSink(write: (line:string) => void) {
  const decoder = new TextDecoder(); let pending = "", truncated = false;
  return (chunk: Buffer) => {
    for (const part of decoder.decode(chunk, {stream:true}).split(/(?<=\n)/)) {
      if (!truncated) { pending += part.slice(0, Math.max(0,2048-pending.length)); if (pending.length >= 2048) truncated = true; }
      if (part.endsWith("\n")) { write(pending.trimEnd()); pending = ""; truncated = false; }
    }
  };
}
