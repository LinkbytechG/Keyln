import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkSignedNode, sha256File } from './node-runtime.mjs';
import { dirtyEntries, forbiddenPaths, listTree, shaLine, versionMismatches, zipName } from './release-lib.mjs';

// T125 (ADR-109): package dist/Keyln.app as dist/release/Keyln-<version>.zip plus its SHA-256 file, then unpack the zip and check it again.
// It never uploads, tags, pushes or creates a GitHub release.
const fail = message => { console.error('Keyln release: ' + message); process.exit(1); };
const run = (command, args) => { const result = spawnSync(command, args, { encoding: 'utf8' }); if (result.status !== 0) fail(`${command} ${args[0] ?? ''} failed: ${(result.stderr || result.stdout || '').trim()}`); return result.stdout.trim(); };
const plistVersion = app => run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents/Info.plist')]);
const markerVersion = app => { try { return JSON.parse(readFileSync(join(app, 'Contents/Resources/runtime/.keyln-runtime.json'), 'utf8')).version; } catch { return undefined; } };

async function main() {
  const allowDirty = process.argv.slice(2).includes('--allow-dirty');
  if (process.argv.slice(2).some(value => value !== '--allow-dirty')) fail('Usage: node scripts/app-release.mjs [--allow-dirty]');
  if (process.platform !== 'darwin') fail('Package the app on a Mac.');
  const app = resolve('dist/Keyln.app'), nodePath = join(app, 'Contents/Helpers/node');
  if (!existsSync(nodePath)) fail('dist/Keyln.app with the bundled Node is missing. Run node scripts/app-build.mjs first (or npm run app:release).');
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const mismatch = versionMismatches({ 'package.json': version, 'Info.plist': plistVersion(app), 'runtime marker': markerVersion(app) });
  if (mismatch.length) fail('Version mismatch: ' + mismatch.join(', ') + '. Rebuild with npm run build and node scripts/app-build.mjs.');

  const dirty = dirtyEntries(run('/usr/bin/git', ['status', '--porcelain']));
  if (dirty.length && !allowDirty) fail(`The working tree has ${dirty.length} uncommitted change(s); commit them or pass --allow-dirty:\n  ` + dirty.slice(0, 10).join('\n  '));
  const commit = run('/usr/bin/git', ['rev-parse', '--short=12', 'HEAD']) + (dirty.length ? '-dirty' : '');

  try { checkSignedNode(nodePath); } catch (error) { fail(error.message); }
  run('/usr/bin/codesign', ['--verify', '--strict', '--deep', app]);

  const out = resolve('dist/release'), zip = join(out, zipName(version)), shaFile = zip + '.sha256';
  mkdirSync(out, { recursive: true });
  rmSync(zip, { force: true }); rmSync(shaFile, { force: true });
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
  const hex = await sha256File(zip);
  writeFileSync(shaFile, shaLine(hex, zipName(version)));

  // Unpack what a downloader would get and check that, not the build folder.
  const work = mkdtempSync(join(tmpdir(), 'keyln-release-'));
  try {
    run('/usr/bin/ditto', ['-x', '-k', zip, work]);
    const extracted = join(work, 'Keyln.app');
    if (!existsSync(extracted)) fail('The zip does not contain Keyln.app at its top level.');
    run('/usr/bin/codesign', ['--verify', '--strict', '--deep', extracted]);
    try { checkSignedNode(join(extracted, 'Contents/Helpers/node')); } catch (error) { fail('Extracted app: ' + error.message); }
    if (spawnSync('/usr/bin/cmp', [nodePath, join(extracted, 'Contents/Helpers/node')]).status !== 0) fail('The extracted Node differs from the one in dist/Keyln.app.');
    const unpacked = versionMismatches({ 'package.json': version, 'Info.plist': plistVersion(extracted), 'runtime marker': markerVersion(extracted) });
    if (unpacked.length) fail('Extracted app version mismatch: ' + unpacked.join(', '));
    const hits = forbiddenPaths(listTree(work));
    if (hits.length) fail('The package contains files that must never ship:\n  ' + hits.slice(0, 20).join('\n  '));
  } finally { rmSync(work, { recursive: true, force: true }); }

  console.log(`Release package: ${zip}\nSize: ${statSync(zip).size} bytes\nSHA-256: ${hex}\nChecksum file: ${shaFile}\nCommit: ${commit}\nVersion: ${version}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
