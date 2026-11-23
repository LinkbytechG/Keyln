import { cpSync, existsSync, mkdirSync, renameSync, rmSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// T123 (ADR-107): install the self-contained dist/Keyln.app into ~/Applications (or --target) and switch the login service to its bundled Node and runtime.
// --app-only keeps the T120 behaviour: copy the app and leave the service, LaunchAgent and data directory alone.
const args = process.argv.slice(2);
let target = join(homedir(), 'Applications'), open = true, appOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--no-open') open = false;
  else if (args[i] === '--app-only') appOnly = true;
  else if (args[i] === '--target') { target = args[++i] ?? ''; if (!isAbsolute(target)) { console.error('Keyln app: --target needs an absolute directory.'); process.exit(1); } }
  else { console.error('Usage: node scripts/app-install.mjs [--target /absolute/dir] [--no-open] [--app-only]'); process.exit(1); }
}
if (target === '/Applications') { console.error('Keyln app: /Applications is not used; install to ~/Applications.'); process.exit(1); }
const source = resolve('dist/Keyln.app');
if (!existsSync(join(source, 'Contents/MacOS/Keyln'))) { console.error('Keyln app: dist/Keyln.app is missing. Run npm run build first.'); process.exit(1); }
if (!appOnly && !existsSync(join(source, 'Contents/Helpers/node'))) { console.error('Keyln app: dist/Keyln.app has no bundled Node. Run npm run node:fetch, then npm run app:build.'); process.exit(1); }

const run = (command, commandArgs) => spawnSync(command, commandArgs, { encoding: 'utf8' });
// Quit only a menu app running from this exact path. The service is not touched here.
function quitMenuApp(installed) {
  const executable = join(installed, 'Contents/MacOS/Keyln');
  const found = run('/usr/bin/pgrep', ['-f', executable]).stdout.split('\n').map(Number).filter(pid => pid > 0 && pid !== process.pid);
  for (const pid of found) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  return found;
}
const gone = pids => !pids.some(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
const installed = join(target, 'Keyln.app');

if (appOnly) {
  mkdirSync(target, { recursive: true });
  const staged = mkdtempSync(join(target, '.Keyln-install-'));
  try {
    const copy = join(staged, 'Keyln.app');
    cpSync(source, copy, { recursive: true, verbatimSymlinks: true });
    const check = run('/usr/bin/codesign', ['--verify', '--strict', copy]);
    if (check.status !== 0) throw new Error('The copied app failed codesign verification: ' + (check.stderr || '').trim());
    const found = quitMenuApp(installed);
    for (let i = 0; i < 30 && !gone(found); i++) await delay(100);
    const old = join(staged, 'old.app');
    if (existsSync(installed)) renameSync(installed, old);
    try { renameSync(copy, installed); } catch (error) { if (existsSync(old)) renameSync(old, installed); throw error; }
  } finally { rmSync(staged, { recursive: true, force: true }); }
} else {
  let service, appService, cli;
  try {
    service = await import('../dist/apps/host/service.js'); appService = await import('../dist/apps/host/app-service.js'); cli = await import('../dist/apps/host/service-cli.js');
  } catch (error) { console.error('Keyln app: ' + (error.code === 'ERR_MODULE_NOT_FOUND' ? 'Run npm run build first.' : error.message)); process.exit(1); }
  try {
    if (process.platform !== 'darwin' || process.getuid?.() === 0) throw new Error('Use the signed-in Mac user, without sudo.');
    // KEYLN_DATA_DIR and KEYLN_SERVICE_LABEL (a local.keyln.host.test.<8 hex> label) select an isolated installation, exactly as for the other service commands.
    const paths = service.servicePaths(undefined, process.env.KEYLN_SERVICE_LABEL || service.SERVICE_LABEL);
    const quit = path => { const found = quitMenuApp(path); const end = Date.now() + 3000; while (!gone(found) && Date.now() < end) spawnSync('/bin/sleep', ['0.1']); };
    await appService.installApp(paths, source, target, appService.appLifecycle(cli.ready, quit));
    console.log('Keyln login service now runs from ' + installed + ' (bundled Node). The previous app, if any, is kept at ' + join(target, '.Keyln.app.previous') + '. Logs: ' + paths.logs);
  } catch (error) { console.error('Keyln app: ' + error.message); process.exit(1); }
}
console.log('Installed ' + installed);
if (open) {
  const result = run('/usr/bin/open', [installed]);
  if (result.status !== 0) { console.error('Keyln app: installed, but open failed: ' + (result.stderr || '').trim()); process.exit(1); }
}
