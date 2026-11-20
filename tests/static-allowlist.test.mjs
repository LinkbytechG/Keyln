import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every module a page imports, directly or not, must be served by the Host; one missing file stops the whole page from starting.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const served = new Set([...readFileSync(join(root, 'apps/host/server.ts'), 'utf8').matchAll(/\["(\/(?:apps|packages)\/[^"]+\.js)"/g)].map(match => match[1]));

function closure(entry) {
  const seen = new Set(), queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(join(root, file), 'utf8');
    for (const [, spec] of source.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)\.js"/g)) {
      const next = relative(root, resolve(join(root, dirname(file)), `${spec}.ts`));
      if (existsSync(join(root, next))) queue.push(next);
    }
  }
  return [...seen].map(file => `/${file.replace(/\.ts$/, '.js')}`);
}

test('every module the pages import is in the Host static allowlist', () => {
  for (const entry of ['apps/web/app.ts', 'apps/web/admin.ts', 'apps/web/check.ts']) {
    const missing = closure(entry).filter(path => !served.has(path));
    assert.deepEqual(missing, [], `${entry} imports modules the Host does not serve`);
  }
});
