import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { NODE_TEAM, NODE_VERSION, checkSignedNode, requireCachedNode } from './node-runtime.mjs';

// T123 (ADR-107): turn the menu bar app from npm run build into the self-contained Keyln.app: official Node, helper and Host runtime inside the bundle.
// Contents/Helpers holds the two executables (Apple's place for helper code, so --strict verification accepts them); the Host runtime is sealed under Contents/Resources/runtime.
const args = process.argv.slice(2);
let out = resolve('dist/Keyln.app');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') { out = args[++i] ?? ''; if (!isAbsolute(out) || !out.endsWith('/Keyln.app')) { console.error('Keyln app: --out needs an absolute path ending in /Keyln.app.'); process.exit(1); } }
  else { console.error('Usage: node scripts/app-build.mjs [--out /absolute/path/Keyln.app]'); process.exit(1); }
}
const fail = message => { console.error('Keyln app: ' + message); process.exit(1); };
const run = (command, commandArgs) => { const result = spawnSync(command, commandArgs, { encoding: 'utf8' }); if (result.status !== 0) fail(`${command} failed: ${(result.stderr || result.stdout || '').trim()}`); return result; };
if (process.platform !== 'darwin') fail('Build the app on the target Mac.');
const base = resolve('dist/Keyln.app');
for (const path of [join(base, 'Contents/MacOS/Keyln'), 'dist/keyln-helper', 'dist/apps/host/main.js', 'dist/apps/host/service-runner.js', 'dist/packages', 'node_modules/ws/package.json'])
  if (!existsSync(path)) fail(`${path} is missing. Run npm run build first.`);
let node;
try { node = requireCachedNode(); } catch (error) { fail(error.message); }

mkdirSync(dirname(out), { recursive: true });
const work = mkdtempSync(join(dirname(out), '.Keyln-build-')), app = join(work, 'Keyln.app');
try {
  cpSync(base, app, { recursive: true, verbatimSymlinks: true });
  rmSync(join(app, 'Contents/Helpers'), { recursive: true, force: true });
  rmSync(join(app, 'Contents/Resources/runtime'), { recursive: true, force: true });
  const helpers = join(app, 'Contents/Helpers'), runtime = join(app, 'Contents/Resources/runtime');
  mkdirSync(helpers, { recursive: true });
  // The Node binary is copied byte for byte and never re-signed: its Node.js Foundation signature is the point.
  copyFileSync(node, join(helpers, 'node')); chmodSync(join(helpers, 'node'), 0o755);
  copyFileSync('dist/keyln-helper', join(helpers, 'keyln-helper')); chmodSync(join(helpers, 'keyln-helper'), 0o755);
  mkdirSync(join(runtime, 'dist'), { recursive: true }); mkdirSync(join(runtime, 'node_modules'));
  cpSync('dist/apps', join(runtime, 'dist/apps'), { recursive: true }); cpSync('dist/packages', join(runtime, 'dist/packages'), { recursive: true });
  cpSync('node_modules/ws', join(runtime, 'node_modules/ws'), { recursive: true });
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
  writeFileSync(join(runtime, '.keyln-runtime.json'), JSON.stringify({ schemaVersion: 2, kind: 'keyln-app-runtime', node: NODE_VERSION }) + '\n');
  run('/bin/chmod', ['-R', 'go-w', runtime]);
  // Inner code first, then the outer app, ad hoc and without --deep so Node keeps its own signature.
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'local.keyln.helper', join(helpers, 'keyln-helper')]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'local.keyln.menubar', app]);
  run('/usr/bin/codesign', ['--verify', '--strict', '--deep', app]);
  try { checkSignedNode(join(helpers, 'node')); } catch (error) { fail(error.message); }
  const bytes = spawnSync('/usr/bin/cmp', [node, join(helpers, 'node')]);
  if (bytes.status !== 0) fail('The bundled Node differs from the cached binary.');
  rmSync(out, { recursive: true, force: true });
  renameSync(app, out);
} finally { rmSync(work, { recursive: true, force: true }); }
console.log(`Built ${out} with Node ${NODE_VERSION} (team ${NODE_TEAM}), the helper and the Host runtime.`);
