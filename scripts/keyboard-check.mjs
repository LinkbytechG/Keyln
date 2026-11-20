import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const probe = process.argv[2] === '--probe';
const helper = resolve('dist/keyln-helper');
if (probe) {
  // Stream the foreground-window instruction while the bounded probe is waiting.
  const result = spawnSync(helper, ['probe-shortcuts'], { stdio: 'inherit', timeout: 20_000 });
  if (result.error) console.error(`Keyboard probe could not finish: ${result.error.message}`);
  process.exit(result.status ?? 1);
}
const result = spawnSync(helper, ['doctor'], { encoding: 'utf8', timeout: 5_000 });
if (result.error) {
  console.error(`Cannot run the Keyln helper: ${result.error.message}. Run npm run build first.`);
  process.exit(1);
}
try {
  const data = JSON.parse(result.stdout);
  console.log(JSON.stringify(data, null, 2));
  if (!probe && (!data.accessibilityTrusted || !data.eventPostingAllowed))
    console.log(`Keyboard permission is not ready. See README.md; helper: ${helper}`);
} catch { console.error('No valid helper response.'); process.exit(1); }
process.exitCode = result.status ?? 1;
