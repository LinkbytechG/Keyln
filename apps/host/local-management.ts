import { createServer, connect } from "node:net";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { exact } from "../../packages/contracts/index.js";
import { privateDir } from "./store.js";
import type { LocalAdmin } from "./admin.js";

export const managementPath = (dir: string) => join(dir, "management.sock");
export async function localManagement(dir: string, admin: LocalAdmin, origin: string, doctor: () => Promise<unknown>) {
  privateDir(dir);
  const path = managementPath(dir);
  if (Buffer.byteLength(path) > 103) throw new Error("The local management socket path is too long. Use a shorter private data directory.");
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("The management socket path is not owned by this Host user. It was preserved.");
    unlinkSync(path); // Caller already holds the exclusive data-directory lock.
  }
  const clients = new Set<import("node:net").Socket>();
  const server = createServer(socket => {
    clients.add(socket); socket.on("close", () => clients.delete(socket)); socket.on("error", () => socket.destroy());
    socket.setTimeout(2000, () => socket.destroy());
    let bytes = Buffer.alloc(0), handled = false;
    socket.on("data", chunk => {
      if (handled) return;
      if (bytes.length + chunk.length > 256) { socket.destroy(); return; }
      bytes = Buffer.concat([bytes, chunk]);
      if (!bytes.includes(10)) return;
      handled = true;
      void (async () => {
        const input = exact(JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(bytes)), ["command"]);
        if (input.command === "admin") socket.end(JSON.stringify({ origin, code: admin.invite(), expiresInSeconds: 120 }) + "\n");
        else if (input.command === "doctor") socket.end(JSON.stringify({ origin, pid: process.pid, uid: process.getuid?.(), diagnostics: await doctor() }) + "\n");
        else throw new Error("Unsupported local management command.");
      })().catch(() => socket.destroy());
    });
  });
  server.maxConnections = 4;
  await new Promise<void>((resolve, reject) => {server.once("error", reject); server.listen(path, () => {chmodSync(path, 0o600); resolve();});});
  const inode = lstatSync(path).ino;
  return async () => {
    for (const socket of clients) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (existsSync(path) && lstatSync(path).ino === inode) unlinkSync(path);
  };
}

export async function requestLocalManagement(dir: string, command: "admin" | "doctor"): Promise<Record<string, unknown>> {
  const path = managementPath(dir), stat = lstatSync(path);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("The local management socket is not private to this user.");
  return await new Promise((resolve, reject) => {
    const socket = connect(path); let bytes = Buffer.alloc(0);
    socket.setTimeout(5000, () => socket.destroy(new Error("Local management timed out.")));
    socket.on("connect", () => socket.write(JSON.stringify({command}) + "\n"));
    socket.on("data", chunk => {if (bytes.length + chunk.length > 8192) socket.destroy(new Error("Invalid local management response.")); else bytes = Buffer.concat([bytes, chunk]);});
    socket.on("error", reject);
    socket.on("end", () => {try {resolve(JSON.parse(bytes.toString("utf8")));} catch {reject(new Error("No valid local management response. Start the current Host first."));}});
  });
}
