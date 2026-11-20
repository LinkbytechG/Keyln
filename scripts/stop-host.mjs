// Explicit manual restart support. Never terminates a process from a PID alone.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

try {
  if (process.platform !== 'darwin' || process.getuid?.() === 0) throw new Error('Run this as the signed-in Mac user, without sudo.');
  const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const dir = process.env.KEYLN_DATA_DIR || join(homedir(), 'Library/Application Support/Keyln');
  const lock = join(dir, 'host.lock');
  if (!existsSync(lock)) { console.log('Keyln is not running. You can start it.'); process.exit(0); }
  const pid = Number(readFileSync(lock, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('Invalid Host lock. Inspect the data directory on this Mac.');
  function alive() {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  }
  if (!alive()) { console.log('The old Host has exited. The launcher will clear the stale lock.'); process.exit(0); }
  const field = name => execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', `${name}=`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const executable = field('comm'), command = field('command'), birth = field('lstart');
  const workingDirectory = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').find(line => line.startsWith('n'))?.slice(1);
  const entries = ['dist/apps/host/main.js', join(root, 'dist/apps/host/main.js')];
  const expected = new Set([executable, basename(executable), process.execPath].flatMap(node => entries.map(entry => `${node} ${entry}`)));
  if (Number(field('uid')) !== process.getuid() || basename(executable) !== 'node' || !workingDirectory || realpathSync(workingDirectory) !== root || !expected.has(command))
    throw new Error('The process in the lock could not be confirmed as this project\'s Keyln Host. Nothing was stopped.');
  if (!existsSync(lock) || Number(readFileSync(lock, 'utf8')) !== pid || field('lstart') !== birth || field('command') !== command)
    throw new Error('The Host process changed. Try again shortly; no stop signal was sent.');
  console.log(`Stopping Keyln Host (PID ${pid})…`);
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 8000;
  while (alive() && Date.now() < deadline) await delay(100);
  if (alive()) throw new Error('The Host has not exited and was not force-quit. Check the original Keyln window and try again.');
  console.log('The old Keyln Host has exited. You can start the new version.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not check or stop the Keyln Host.');
  process.exitCode = 1;
}
