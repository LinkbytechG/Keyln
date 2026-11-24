import { mkdirSync, copyFileSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
run(resolve('node_modules/.bin/tsc'), []);
// T64: a module that was deleted from the source must not stay in dist (tsc only writes, it never removes). Every compiled file there has a .ts source of the same name.
function prune(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) { prune(path); continue; }
    const match = /^(.*)\.js(\.map)?$/.exec(path);
    if (match && !existsSync(`${match[1].replace(/^dist\//, '')}.ts`)) { rmSync(path); console.log(`Removed stale ${path}`); }
  }
}
for (const dir of ['dist/apps', 'dist/packages']) if (existsSync(dir)) prune(dir);
// T125: the Host reads its version from here (apps/host/version.ts). dist/apps is copied whole into both service layouts.
writeFileSync('dist/apps/host/version.json', JSON.stringify({ version }) + '\n');
mkdirSync('dist/apps/web', { recursive: true });
for (const name of ['index.html', 'style.css', 'admin.html', 'admin.css', 'check.html', 'check.css', 'manifest.webmanifest']) copyFileSync(`apps/web/${name}`, `dist/apps/web/${name}`);
cpSync('apps/web/icons', 'dist/apps/web/icons', {recursive:true});
if (process.platform !== 'darwin') throw new Error('Build the Swift helper on the target Mac.');
mkdirSync('dist/swift-cache', { recursive: true });
run('/usr/bin/xcrun', ['swiftc', '-O', '-module-cache-path', resolve('dist/swift-cache'), 'native/macos-helper/main.swift', 'native/macos-helper/Applications.swift', 'native/macos-helper/AppActivation.swift', 'native/macos-helper/RunningApps.swift', 'native/macos-helper/AppIcon.swift', 'native/macos-helper/Keyboard.swift', 'native/macos-helper/Windows.swift', 'native/macos-helper/Finder.swift', '-o', 'dist/keyln-helper']);
run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'local.keyln.helper', 'dist/keyln-helper']);

// T120: the menu bar app shell. Plain swiftc, a generated Info.plist and an ad-hoc signature; no Xcode project.
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const info = {
  CFBundleIdentifier: 'local.keyln.menubar', CFBundleName: 'Keyln', CFBundleDisplayName: 'Keyln', CFBundleExecutable: 'Keyln',
  CFBundlePackageType: 'APPL', CFBundleInfoDictionaryVersion: '6.0', CFBundleShortVersionString: version, CFBundleVersion: version,
  CFBundleIconFile: 'AppIcon', LSMinimumSystemVersion: '13.0', LSUIElement: true, NSPrincipalClass: 'NSApplication',
};
const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n`
  + Object.entries(info).map(([key, value]) => `<key>${xml(key)}</key>${value === true ? '<true/>' : `<string>${xml(value)}</string>`}\n`).join('') + '</dict></plist>\n';
rmSync('dist/Keyln.app', { recursive: true, force: true });
mkdirSync('dist/Keyln.app/Contents/MacOS', { recursive: true });
mkdirSync('dist/Keyln.app/Contents/Resources', { recursive: true });
const menubarSources = readdirSync('native/macos-menubar').filter(name => name.endsWith('.swift')).sort().map(name => `native/macos-menubar/${name}`);
run('/usr/bin/xcrun', ['swiftc', '-O', '-module-cache-path', resolve('dist/swift-cache'), ...menubarSources, '-o', 'dist/Keyln.app/Contents/MacOS/Keyln']);
writeFileSync('dist/Keyln.app/Contents/Info.plist', plist);
rmSync('dist/AppIcon.iconset', { recursive: true, force: true });
mkdirSync('dist/AppIcon.iconset');
// AppIcon.png (1024, transparent, on Apple's icon grid) is rendered from apps/web/icons/keyln.svg by scripts/generate-app-icons.mjs.
for (const [name, size] of [['16x16', 16], ['16x16@2x', 32], ['32x32', 32], ['32x32@2x', 64], ['128x128', 128], ['128x128@2x', 256], ['256x256', 256], ['256x256@2x', 512], ['512x512', 512], ['512x512@2x', 1024]]) {
  run('/usr/bin/sips', ['-z', String(size), String(size), 'native/macos-menubar/AppIcon.png', '--out', `dist/AppIcon.iconset/icon_${name}.png`]);
}
run('/usr/bin/iconutil', ['-c', 'icns', 'dist/AppIcon.iconset', '-o', 'dist/Keyln.app/Contents/Resources/AppIcon.icns']);
rmSync('dist/AppIcon.iconset', { recursive: true, force: true });
run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'local.keyln.menubar', 'dist/Keyln.app']);
console.log('Built web client, Mac Host, native helper and menu bar app.');
