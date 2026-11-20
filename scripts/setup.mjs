import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
let address = '127.0.0.1', port = 8940;
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === '--address') address = args[i + 1];
  else if (args[i] === '--port') port = Number(args[i + 1]);
  else throw new Error('Usage: npm run setup -- [--address PRIVATE_IPV4] [--port 8940]');
}
const local = Object.values(networkInterfaces()).flat().some(item => item?.address === address);
if (!isIPv4(address || '') || (address !== '127.0.0.1' && (!local || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address))))
  throw new Error('Choose 127.0.0.1 or a private IPv4 address assigned to this Mac. Wildcards and public addresses are not allowed.');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be 1024–65535.');
const dir = process.env.KEYLN_DATA_DIR || join(homedir(), 'Library/Application Support/Keyln');
const tls = join(dir, 'tls');
mkdirSync(tls, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); chmodSync(tls, 0o700);
if (existsSync(join(dir, 'host.lock'))) throw new Error('Stop Host before changing its setup. If it crashed, start and stop it to clear the stale lock.');
process.umask(0o077);
function openssl(args) {
  const result = spawnSync('openssl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error(`OpenSSL failed: ${result.error?.message || result.stderr}`);
}
const temporary = mkdtempSync(join(tls, 'setup-'));
try {
  const ca = join(tls, 'rootCA.pem'), caKey = join(tls, 'rootCA.key');
  if (existsSync(ca) !== existsSync(caKey)) throw new Error('Incomplete CA files. Restore the original pair or move the tls directory aside and re-establish trust.');
  if (!existsSync(ca)) {
    const config = join(temporary, 'ca.cnf');
    writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Keyln Local CA\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n');
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650', '-config', config, '-keyout', join(temporary, 'rootCA.key'), '-out', join(temporary, 'rootCA.pem')]);
    renameSync(join(temporary, 'rootCA.key'), caKey); renameSync(join(temporary, 'rootCA.pem'), ca);
  }
  const config = join(temporary, 'server.cnf');
  writeFileSync(config, `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=${address}\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${address}\n`);
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-config', config, '-keyout', join(temporary, 'server.key'), '-out', join(temporary, 'server.csr')]);
  openssl(['x509', '-req', '-in', join(temporary, 'server.csr'), '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-days', '397', '-sha256', '-extfile', config, '-extensions', 'server', '-out', join(temporary, 'server.pem')]);
  for (const name of ['server.key', 'server.pem']) renameSync(join(temporary, name), join(tls, name));
  const settings = { schemaVersion: 1, address, port, origin: `https://${address}:${port}` };
  writeFileSync(join(dir, 'host.json.tmp'), JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  renameSync(join(dir, 'host.json.tmp'), join(dir, 'host.json'));
  openssl(['verify', '-CAfile', ca, '-verify_ip', address, join(tls, 'server.pem')]);
  console.log(`Setup ready for ${settings.origin}\nPublic trust certificate: ${ca}\nCopy only rootCA.pem to Surface and trust it before connecting. Keep all .key files private on this Mac.\nStart with: npm start`);
  const fingerprint = spawnSync('openssl', ['x509', '-in', ca, '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' });
  console.log(fingerprint.stdout.trim());
} finally { rmSync(temporary, { recursive: true, force: true }); }
