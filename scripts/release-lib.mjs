import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

// T125 (ADR-109): the pure parts of scripts/app-release.mjs, importable by tests without building anything.

/** Lines of `git status --porcelain` that make the tree dirty (modified, staged or untracked and not ignored). Ignored and excluded files never appear in that output. */
export function dirtyEntries(porcelain) {
  return String(porcelain).split('\n').map(line => line.trimEnd()).filter(line => line.length > 0 && !line.startsWith('!!'));
}

/** `<hex>  <name>` as shasum -a 256 prints it, with a trailing newline. */
export const shaLine = (hex, name) => `${hex}  ${name}\n`;
export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
export const zipName = version => `Keyln-${version}.zip`;

/** Parse a .sha256 file; null when it is not exactly one `<64 hex>  <name>` line. */
export function parseShaLine(text) {
  const match = /^([0-9a-f]{64})  ([^\n/]+)\n$/.exec(String(text));
  return match ? { hex: match[1], name: match[2] } : null;
}

const FORBIDDEN_NAME = [/\.(key|pem|p12|pfx)$/i, /^rootCA/i, /^devices\.json$/, /^host\.json$/, /^\.env(\..*)?$/];
const FORBIDDEN_SEGMENT = new Set(['Keyln_private', '.git']);
/** Paths (relative, slash separated) that must never ship in a release: keys and certificates, device records, host settings, env files, private docs, git data. */
export function forbiddenPaths(paths) {
  return paths.filter(path => {
    const parts = path.split('/').filter(Boolean);
    return parts.some(part => FORBIDDEN_SEGMENT.has(part)) || FORBIDDEN_NAME.some(pattern => pattern.test(basename(path)));
  });
}

/** Every file, directory and symlink under root as relative paths. */
export function listTree(root, prefix = '') {
  const out = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    out.push(relative);
    if (entry.isDirectory()) out.push(...listTree(root, relative));
  }
  return out;
}

/** Names that disagree: input is { name: version }. Returns [] when all are equal strings. */
export function versionMismatches(versions) {
  const entries = Object.entries(versions), first = entries[0]?.[1];
  const bad = entries.filter(([, value]) => typeof value !== 'string' || value === '' || value !== first);
  return typeof first === 'string' && first !== '' && bad.length === 0 ? [] : entries.map(([name, value]) => `${name}=${JSON.stringify(value)}`);
}
