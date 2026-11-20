import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.KEYLN_DATA_DIR || join(homedir(), 'Library/Application Support/Keyln');
if (process.platform !== 'darwin' || process.getuid?.() === 0)
  throw new Error('Start Keyln as the signed-in Mac user, without sudo. Surface uses the browser only.');

const lock = join(dataDir, 'host.lock');
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid Host lock. Inspect the data directory before continuing.');
  let alive = true;
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
  if (alive) throw new Error(`Keyln is already running (PID ${pid}). No new Host was started from this window. Use Restart-Keyln.command to update; in manual mode you can also type quit in the original Keyln window, and for the background service use npm run service:stop. Reloading the web page does not update the Host.Do not open index.html.`);
  unlinkSync(lock);
}
function run(args) {
  const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && /\.(ts|html|css|swift)$/.test(entry.name) ? [path] : [];
  });
}
const inputs = ['apps', 'packages', 'native'].flatMap(dir => sourceFiles(join(root, dir)));
inputs.push(...['scripts/build.mjs', 'tsconfig.json', 'package.json', 'package-lock.json'].map(path => join(root, path)));
const outputs = ['dist/keyln-helper', 'dist/apps/host/main.js', 'dist/apps/web/app.js',
  'dist/apps/web/index.html', 'dist/apps/web/style.css', 'dist/packages/contracts/index.js',
  'dist/apps/host/admin.js', 'dist/apps/web/admin.js', 'dist/apps/web/admin.html', 'dist/apps/web/admin.css',
  'dist/apps/web/check.js', 'dist/apps/web/check.html', 'dist/apps/web/check.css'].map(path => join(root, path));
const builtAt = existsSync(outputs[0]) ? statSync(outputs[0]).mtimeMs : 0;
if (['node_modules/.bin/tsc', 'node_modules/ws/package.json', 'node_modules/@types/ws/package.json'].some(path => !existsSync(join(root, path))))
  run(['ci', '--ignore-scripts']);
if (outputs.some(path => !existsSync(path)) || inputs.some(path => statSync(path).mtimeMs > builtAt)) {
  console.log('Preparing the current Keyln build…'); run(['run', 'build']);
}
if (['host.json', 'tls/rootCA.pem', 'tls/rootCA.key', 'tls/server.pem', 'tls/server.key'].some(path => !existsSync(join(dataDir, path)))) {
  console.log('Creating the private local Host configuration (loopback by default)…'); run(['run', 'setup']);
}
console.log('Open the HTTPS address printed below. Opening apps/web/index.html directly does not start Keyln.');
