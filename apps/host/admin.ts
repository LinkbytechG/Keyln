import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Fault } from "../../packages/contracts/index.js";

export const ADMIN_SESSION_MS = 30 * 60 * 1000;
export const ADMIN_COOKIE = "__Host-keyln-admin";
const digest = (value: string) => createHash("sha256").update(value).digest();

// The configured IPv4 address is assigned to this Mac and checked at startup.
// A local TCP peer is only an additional boundary, never administrator proof.
export function requireLocalAdminPeer(request: IncomingMessage, address: string): void {
  if (request.socket.remoteAddress?.replace(/^::ffff:/, "") !== address)
    throw new Fault("LOCAL_ADMIN_ONLY", "Open the management page on the Mac running Keyln.", 403);
}

export class LocalAdmin {
  private challenge?: { hash: Buffer; expiresAt: number; attempts: number };
  private readonly sessions = new Map<string, number>();
  constructor(private now = Date.now) {}

  invite(): string {
    const code = String(randomInt(10_000_000, 100_000_000));
    this.challenge = { hash: digest(code), expiresAt: this.now() + 120_000, attempts: 0 };
    return code;
  }

  login(code: unknown): { token: string; expiresAt: number } {
    const challenge = this.challenge;
    if (!challenge || challenge.expiresAt <= this.now() || challenge.attempts >= 5)
      throw new Fault("ADMIN_LOGIN_CLOSED", "The management login code has expired or has no attempts left. Get a new one with Mac Management in the Keyln menu bar app, npm run service:admin, or by typing admin in the Keyln window.", 429);
    challenge.attempts++;
    if (typeof code !== "string" || !/^\d{8}$/.test(code) || !timingSafeEqual(digest(code), challenge.hash))
      throw new Fault("ADMIN_CODE_INVALID", "The management login code is wrong. Use the code shown on this Mac.", 401);
    this.prune();
    if (this.sessions.size >= 4)
      throw new Fault("ADMIN_SESSION_LIMIT", "Too many management sessions are open. Log out of another management page first.", 409);
    this.challenge = undefined;
    const token = randomBytes(32).toString("hex"), expiresAt = this.now() + ADMIN_SESSION_MS;
    this.sessions.set(digest(token).toString("hex"), expiresAt);
    return { token, expiresAt };
  }

  authenticate(cookie?: string): number {
    this.prune();
    const expiresAt = this.sessions.get(this.key(cookie));
    if (!expiresAt) throw new Fault("ADMIN_UNAUTHORIZED", "Log in with this Mac's management login code. You need to log in again after the Host restarts or the session expires.", 401);
    return expiresAt;
  }

  logout(cookie?: string): void {
    this.authenticate(cookie);
    this.sessions.delete(this.key(cookie));
  }

  clear(): void { this.challenge = undefined; this.sessions.clear(); }

  private key(cookie?: string): string {
    const values = cookie?.split(";").map(value => value.trim()).filter(value => value.startsWith(`${ADMIN_COOKIE}=`)) ?? [];
    const token = values.length === 1 ? values[0]!.slice(ADMIN_COOKIE.length + 1) : "";
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Fault("ADMIN_UNAUTHORIZED", "Log in to the Mac management page first.", 401);
    return digest(token).toString("hex");
  }

  private prune(): void {
    for (const [key, expiresAt] of this.sessions) if (expiresAt <= this.now()) this.sessions.delete(key);
  }
}
