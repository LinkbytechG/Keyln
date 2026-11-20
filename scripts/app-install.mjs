import { cpSync, existsSync, mkdirSync, renameSync, rmSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// T120: copy dist/Keyln.app into ~/Applications (or --target). It never touches the LaunchAgent service, the data directory or /Applications.
const args = process.argv.slice(2);
let target = join(homedir(), 'Applications'), open = true;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--no-open') open = false;
  else if (args[i] === '--target') { target = args[++i] ?? ''; if (!isAbsolute(target)) { console.error('Keyln app: --target needs an absolute directory.'); process.exit(1); } }
  else { console.error('Usage: node scripts/app-install.mjs [--target /absolute/dir] [--no-open]'); process.exit(1); }
}
if (target === '/Applications') { console.error('Keyln app: /Applications is not used; install to ~/Applications.'); process.exit(1); }
const source = resolve('dist/Keyln.app');
if (!existsSync(join(source, 'Contents/MacOS/Keyln'))) { console.error('Keyln app: dist/Keyln.app is missing. Run npm run build first.'); process.exit(1); }

const run = (command, commandArgs) => spawnSync(command, commandArgs, { encoding: 'utf8' });
mkdirSync(target, { recursive: true });
const installed = join(target, 'Keyln.app'), staged = mkdtempSync(join(target, '.Keyln-install-'));
try {
  const copy = join(staged, 'Keyln.app');
  cpSync(source, copy, { recursive: true, verbatimSymlinks: true });
  const check = run('/usr/bin/codesign', ['--verify', '--strict', copy]);
  if (check.status !== 0) throw new Error('The copied app failed codesign verification: ' + (check.stderr || '').trim());
  // Quit only a menu app running from this exact path. The service is not touched.
  const executable = join(installed, 'Contents/MacOS/Keyln');
  const found = run('/usr/bin/pgrep', ['-f', executable]).stdout.split('\n').map(Number).filter(pid => pid > 0 && pid !== process.pid);
  for (const pid of found) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  for (let i = 0; i < 30 && found.some(pid => { try { process.kill(pid, 0); return true; } catch { return false; } }); i++) await delay(100);
  const old = join(staged, 'old.app');
  if (existsSync(installed)) renameSync(installed, old);
  try { renameSync(copy, installed); } catch (error) { if (existsSync(old)) renameSync(old, installed); throw error; }
} finally { rmSync(staged, { recursive: true, force: true }); }
console.log('Installed ' + installed);
if (open) {
  const result = run('/usr/bin/open', [installed]);
  if (result.status !== 0) { console.error('Keyln app: installed, but open failed: ' + (result.stderr || '').trim()); process.exit(1); }
}
