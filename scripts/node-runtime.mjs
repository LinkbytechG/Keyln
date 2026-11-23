import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// T123 (ADR-107): the official Node that Keyln.app carries. The tarball is pinned by SHA-256 and only bin/node is extracted; its Node.js Foundation signature must survive untouched.
export const NODE_VERSION = 'v26.13.1';
export const NODE_PLATFORM = 'darwin-arm64';
export const NODE_SHA256 = 'aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735';
export const NODE_TEAM = 'HX7739G8FX';
export const nodeTarball = (version = NODE_VERSION, platform = NODE_PLATFORM) => `node-${version}-${platform}.tar.gz`;
export const nodeUrl = (version = NODE_VERSION, platform = NODE_PLATFORM) => `https://nodejs.org/dist/${version}/${nodeTarball(version, platform)}`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const cacheDir = (base = root) => join(base, '.cache/node', `${NODE_VERSION}-${NODE_PLATFORM}`);
export const cachedNode = (base = root) => join(cacheDir(base), 'node');

export function sha256File(path) {
  return new Promise((done, fail) => { const hash = createHash('sha256'); createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', fail).on('end', () => done(hash.digest('hex'))); });
}
export async function verifyTarball(path, sha256 = NODE_SHA256) {
  const actual = await sha256File(path);
  if (actual !== sha256) throw new Error(`The Node tarball does not match the pinned SHA-256 (got ${actual}).`);
}
// Strict signature check plus the Node.js Foundation team. Throws with the reason.
export function checkSignedNode(path, team = NODE_TEAM) {
  const verify = spawnSync('/usr/bin/codesign', ['--verify', '--strict', path], { encoding: 'utf8' });
  if (verify.status !== 0) throw new Error('The Node binary failed codesign verification: ' + (verify.stderr || '').trim());
  const details = spawnSync('/usr/bin/codesign', ['-dv', path], { encoding: 'utf8' }).stderr ?? '';
  if (!new RegExp(`^TeamIdentifier=${team}$`, 'm').test(details)) throw new Error(`The Node binary is not signed by team ${team}.`);
}
// Extract only bin/node from a verified tarball into <cache>/node, then publish atomically.
export async function installNode({ tarball, base = root, sha256 = NODE_SHA256, verifySignature = checkSignedNode, version = NODE_VERSION, platform = NODE_PLATFORM }) {
  await verifyTarball(tarball, sha256);
  const cache = join(base, '.cache/node'), destination = join(cache, `${version}-${platform}`);
  mkdirSync(cache, { recursive: true });
  const work = mkdtempSync(join(cache, '.extract-'));
  try {
    const member = `node-${version}-${platform}/bin/node`;
    const result = spawnSync('/usr/bin/tar', ['-xzf', tarball, '-C', work, '--strip-components=2', member], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Could not extract bin/node: ' + (result.stderr || '').trim());
    const extracted = join(work, 'node');
    if (!statSync(extracted).isFile()) throw new Error('The tarball did not contain bin/node.');
    verifySignature(extracted);
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    copyFileSync(extracted, join(destination, 'node'));
  } finally { rmSync(work, { recursive: true, force: true }); }
  return join(destination, 'node');
}
async function download(url, file) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
}
export async function fetchNode({ from, base = root, ...options } = {}) {
  if (from) return installNode({ tarball: resolve(from), base, ...options });
  const work = mkdtempSync(join(tmpdir(), 'keyln-node-'));
  try {
    const file = join(work, nodeTarball());
    console.log('Downloading ' + nodeUrl());
    await download(nodeUrl(), file);
    return await installNode({ tarball: file, base, ...options });
  } finally { rmSync(work, { recursive: true, force: true }); }
}
// The cached binary, checked again; app:build calls this and fails with a hint when it is missing.
export function requireCachedNode(base = root) {
  const path = cachedNode(base);
  if (!existsSync(path)) throw new Error('The pinned Node is not cached. Run npm run node:fetch (or npm run node:fetch -- --from <node-' + NODE_VERSION + '-' + NODE_PLATFORM + '.tar.gz>).');
  checkSignedNode(path);
  const version = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 10000 }).stdout.trim();
  if (version !== NODE_VERSION) throw new Error(`The cached Node reports ${version}, not ${NODE_VERSION}. Run npm run node:fetch again.`);
  return path;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let from;
  if (args.length === 2 && args[0] === '--from') from = args[1];
  else if (args.length) { console.error('Usage: npm run node:fetch [-- --from /absolute/path/to/' + nodeTarball() + ']'); process.exit(1); }
  try { console.log('Cached ' + await fetchNode({ from }) + ' (' + NODE_VERSION + ', team ' + NODE_TEAM + ')'); }
  catch (error) { console.error('Keyln node: ' + error.message); process.exit(1); }
}
