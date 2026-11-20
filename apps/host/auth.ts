import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Fault, label } from "../../packages/contracts/index.js";
import { atomicJSON, privateDir } from "./store.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const equal = (left: string, right: string) => timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)));
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
interface Device { id: string; name: string; tokenHash: string; expiresAt: number }
interface Pairing { id: string; name: string; claimHash: string; expiresAt: number; approved: boolean }
export class Auth {
  private devices: Device[];
  private challenge?: { code: string; expiresAt: number; attempts: number };
  private pending?: Pairing;
  private readonly path: string;
  private readonly revokeListeners = new Set<(id: string) => void>();
  constructor(dir: string, private now = Date.now) {
    privateDir(dir); this.path = join(dir, "devices.json");
    this.devices = [];
    if (existsSync(this.path)) {
      try {
        const data = JSON.parse(readFileSync(this.path, "utf8"));
        if (data.schemaVersion !== 1 || !Array.isArray(data.devices) || data.devices.length > 8) throw new Error();
        this.devices = data.devices.map((item: Device) => {
          if (!/^[a-f0-9]{8}$/.test(item.id) || !/^[a-f0-9]{64}$/.test(item.tokenHash) || !Number.isSafeInteger(item.expiresAt)) throw new Error();
          return { id: item.id, name: label(item.name), tokenHash: item.tokenHash, expiresAt: item.expiresAt };
        });
      } catch { throw new Error("Device authorization file is damaged. Stop Host and move devices.json aside to revoke all devices, then pair again."); }
    }
  }
  invite(): string {
    this.pending = undefined;
    const code = String(randomInt(10_000_000, 100_000_000));
    this.challenge = { code, expiresAt: this.now() + 120_000, attempts: 0 };
    return code;
  }
  begin(code: unknown, name: unknown): { id: string; claim: string; name: string } {
    const c = this.challenge;
    if (!c || c.expiresAt <= this.now() || c.attempts >= 5)
      throw new Fault("PAIR_CLOSED", "Pairing is closed. Start pairing in Mac management or type pair in the Mac terminal.", 429);
    c.attempts++;
    if (typeof code !== "string" || code.length !== 8 || !equal(code, c.code))
      throw new Fault("PAIR_INVALID", "Incorrect pairing code.", 401);
    const deviceName = label(name);
    if (this.list().length >= 8) throw new Fault("DEVICE_LIMIT", "Revoke an old device in Mac management or the Mac terminal first.", 409);
    const id = randomBytes(4).toString("hex"), claim = randomBytes(32).toString("hex");
    this.pending = { id, name: deviceName, claimHash: hash(claim), expiresAt: this.now() + 120_000, approved: false };
    this.challenge = undefined;
    return { id, claim, name: deviceName };
  }
  approve(id: string): void {
    if (!this.pending || this.pending.id !== id || this.pending.expiresAt <= this.now()) throw new Error("No matching live pairing request.");
    this.pending.approved = true;
  }
  pairingState(): { expiresAt: number | null; pending: Omit<Pairing, "claimHash"> | null } {
    const p = this.pending;
    return {
      expiresAt: this.challenge && this.challenge.expiresAt > this.now() && this.challenge.attempts < 5 ? this.challenge.expiresAt : null,
      pending: p && p.expiresAt > this.now() ? { id: p.id, name: p.name, expiresAt: p.expiresAt, approved: p.approved } : null,
    };
  }
  closePairing(): void { this.challenge = undefined; this.pending = undefined; }
  claim(id: unknown, secret: unknown): { approved: boolean; token?: string } {
    const p = this.pending;
    if (!p || id !== p.id || typeof secret !== "string" || secret.length !== 64 || p.expiresAt <= this.now() || !equal(hash(secret), p.claimHash))
      throw new Fault("PAIR_EXPIRED", "Pairing expired. Start again in the Mac terminal.", 401);
    if (!p.approved) return { approved: false };
    const token = randomBytes(32).toString("hex");
    const next = [...this.devices.filter(device => device.expiresAt > this.now()), { id: p.id, name: p.name, tokenHash: hash(token), expiresAt: this.now() + SESSION_MS }];
    this.persist(next); this.pending = undefined;
    return { approved: true, token };
  }
  authenticate(cookie?: string): Device {
    const token = cookie?.split(";").map(x => x.trim()).find(x => x.startsWith("__Host-keyln="))?.slice(13);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Fault("UNAUTHORIZED", "Pair this device with the Mac.", 401);
    const device = this.devices.find(d => equal(d.tokenHash, hash(token)) && d.expiresAt > this.now());
    if (!device) throw new Fault("UNAUTHORIZED", "Session expired or was revoked. Pair this device again.", 401);
    return device;
  }
  list(): Array<Omit<Device, "tokenHash">> {
    return this.devices.filter(d => d.expiresAt > this.now()).map(({ id, name, expiresAt }) => ({ id, name, expiresAt }));
  }
  revoke(id: string): void {
    if (!this.devices.some(device => device.id === id)) throw new Error("Unknown device ID.");
    this.persist(this.devices.filter(device => device.id !== id));
    for (const listener of this.revokeListeners) listener(id);
  }
  revokeAll(): void {
    const ids = this.devices.map(device => device.id);
    this.persist([]); this.closePairing();
    for (const id of ids) for (const listener of this.revokeListeners) listener(id);
  }
  onRevoke(listener: (id: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => { this.revokeListeners.delete(listener); };
  }
  private persist(devices: Device[]): void {
    atomicJSON(this.path, { schemaVersion: 1, devices }); this.devices = devices;
  }
}
