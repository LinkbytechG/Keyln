import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { createServer, isIPv4 } from "node:net";
import { spawnSync } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { defaultDataDir, privateDir } from "./store.js";

// T124 (ADR-108): certificate and address setup, shared by `npm run setup` and the menu bar app's first run.
// OpenSSL is always the system LibreSSL: the result must not depend on whatever `openssl` is first in PATH.
export const OPENSSL = "/usr/bin/openssl";
export const DEFAULT_PORT = 8940;
const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

export interface Candidate { interface: string; address: string }
export interface HostSettings { schemaVersion: 1; address: string; port: number; origin: string }
export interface SetupResult { address: string; port: number; origin: string; caFingerprint: string; caPath: string }
export interface SetupOptions {
  data?: string;
  address: string;
  port?: number;            // default: the port already in host.json, otherwise 8940
  checkPort?: boolean;      // default true: the address and port must be free to bind
  interfaces?: Interfaces;  // tests only
}

/** Private IPv4 addresses assigned to this Mac, then loopback as a last choice. */
export function candidateAddresses(interfaces: Interfaces = networkInterfaces()): Candidate[] {
  const found: Candidate[] = [];
  for (const [name, list] of Object.entries(interfaces))
    for (const item of list ?? []) if ((item.family as unknown) === "IPv4" && !item.internal && PRIVATE_IPV4.test(item.address) && !found.some(entry => entry.address === item.address)) found.push({ interface: name, address: item.address });
  found.push({ interface: "lo0", address: "127.0.0.1" });
  return found;
}
export function validateAddress(address: unknown, interfaces: Interfaces = networkInterfaces()): string {
  const assigned = Object.values(interfaces).flat().some(item => item?.address === address);
  if (typeof address !== "string" || !isIPv4(address) || (address !== "127.0.0.1" && (!assigned || !PRIVATE_IPV4.test(address))))
    throw new Error("Choose 127.0.0.1 or a private IPv4 address assigned to this Mac. Wildcards and public addresses are not allowed.");
  return address;
}
export function validatePort(port: unknown): number {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be 1024–65535.");
  return port;
}
export function canBind(address: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: address, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}
/** host.json as written by setup, or null when it is missing or not valid. */
export function readHostSettings(data: string): HostSettings | null {
  try {
    const value = JSON.parse(readFileSync(join(data, "host.json"), "utf8")) as HostSettings;
    if (value?.schemaVersion !== 1 || typeof value.address !== "string" || !isIPv4(value.address) || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || value.origin !== `https://${value.address}:${value.port}`) return null;
    return value;
  } catch { return null; }
}
export function caFingerprint(data: string): string | null {
  try { return new X509Certificate(readFileSync(join(data, "tls/rootCA.pem"))).fingerprint256; } catch { return null; }
}
function openssl(args: string[]) {
  const result = spawnSync(OPENSSL, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) throw new Error(`OpenSSL failed: ${result.error?.message || result.stderr}`);
}

export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const data = options.data ?? defaultDataDir();
  const address = validateAddress(options.address, options.interfaces);
  const port = validatePort(options.port ?? readHostSettings(data)?.port ?? DEFAULT_PORT);
  privateDir(data);
  const tls = join(data, "tls"); privateDir(tls);
  if (existsSync(join(data, "host.lock"))) throw new Error("Stop Host before changing its setup. If it crashed, start and stop it to clear the stale lock.");
  if (options.checkPort !== false && !(await canBind(address, port))) throw new Error(`${address}:${port} is already in use. Choose another port or stop the program that uses it.`);
  const ca = join(tls, "rootCA.pem"), caKey = join(tls, "rootCA.key");
  if (existsSync(ca) !== existsSync(caKey)) throw new Error("Incomplete CA files. Restore the original pair or move the tls directory aside and re-establish trust.");
  const temporary = mkdtempSync(join(tls, "setup-"));
  try {
    if (!existsSync(ca)) {
      const config = join(temporary, "ca.cnf");
      writeFileSync(config, "[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Keyln Local CA\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n", { mode: 0o600 });
      openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650", "-config", config, "-keyout", join(temporary, "rootCA.key"), "-out", join(temporary, "rootCA.pem")]);
      chmodSync(join(temporary, "rootCA.key"), 0o600); chmodSync(join(temporary, "rootCA.pem"), 0o600);
      renameSync(join(temporary, "rootCA.key"), caKey); renameSync(join(temporary, "rootCA.pem"), ca);
    }
    // An existing CA is never regenerated; it must at least be a certificate with its own key.
    const authority = new X509Certificate(readFileSync(ca));
    if (!authority.checkPrivateKey(createPrivateKey(readFileSync(caKey)))) throw new Error("rootCA.key does not belong to rootCA.pem. Restore the original pair.");
    const config = join(temporary, "server.cnf");
    writeFileSync(config, `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=${address}\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${address}\n`, { mode: 0o600 });
    openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-config", config, "-keyout", join(temporary, "server.key"), "-out", join(temporary, "server.csr")]);
    openssl(["x509", "-req", "-in", join(temporary, "server.csr"), "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-days", "397", "-sha256", "-extfile", config, "-extensions", "server", "-out", join(temporary, "server.pem")]);
    // LibreSSL has no `openssl verify -verify_ip`; check the new certificate with Node before anything is put in place.
    const server = new X509Certificate(readFileSync(join(temporary, "server.pem")));
    if (!server.verify(authority.publicKey) || !server.checkIP(address)) throw new Error("The new server certificate did not verify against the Keyln CA and the chosen address.");
    for (const name of ["server.key", "server.pem"]) { chmodSync(join(temporary, name), 0o600); renameSync(join(temporary, name), join(tls, name)); }
    try { chmodSync(join(tls, "rootCA.srl"), 0o600); } catch { /* no serial file */ }
    const settings: HostSettings = { schemaVersion: 1, address, port, origin: `https://${address}:${port}` };
    writeFileSync(join(data, "host.json.tmp"), JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    renameSync(join(data, "host.json.tmp"), join(data, "host.json"));
    return { address, port, origin: settings.origin, caFingerprint: authority.fingerprint256, caPath: ca };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** The public CA certificate as DER, for installing on a device. Never reads a .key file. */
export function derCertificate(data: string): Buffer {
  return new X509Certificate(readFileSync(join(data, "tls/rootCA.pem"))).raw;
}
