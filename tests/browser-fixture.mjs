// UI testing ONLY: loopback HTTP, production handlers and a fake adapter.
// Only the explicit --app-icons mode reads native icons. All actions use the fake adapter below.
// --grid-demo fills the fixture with a sample configuration in the current format (tests/helpers/grid-demo.mjs). A pairing code is printed at start; enter it on the page, then type `approve <id>`.
// A device paired here has no theme yet and is asked for one (T64). It listens on 127.0.0.1:8942 by default; pass --port=N when that port is taken (for example by the real service).
// --icon-demo swaps in a fake Iconify (no network): search "offline" fails like a Mac without internet, "slow" waits 3 seconds then returns the stand-ins, "many" returns 48 icons.
// "sets" (all-sets scope) returns icons from more sets than the Mac keeps, so the results window shows the "Only the first 12 icon sets" note; "many" stays within the limit and shows none.
// "codex" has no curated icon: it finds nothing in the curated sets and three stand-ins (logos:codex and devicon:codex in their own colors, ooui:logo-codex single-color with no licence) in All Iconify sets.
// --icon-real instead uses the REAL Iconify client and DOES reach the internet (api.iconify.design, search words and icon names only). Manual testing only; never used by automated tests.
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Auth } from '../dist/apps/host/auth.js';
import { ConfigStore } from '../dist/apps/host/store.js';
import { Scheduler } from '../dist/apps/host/scheduler.js';
import { createHost } from '../dist/apps/host/server.js';
import { LocalAdmin } from '../dist/apps/host/admin.js';
import { ScriptRegistry } from '../dist/apps/host/scripts.js';
import {installedApps,nativeAppIcon,nativeAppIcons} from '../dist/apps/host/native.js';
import {IconLibrary,IconifyClient} from '../dist/apps/host/icon-library.js';
import {Fault,ICON_PREFIX_LIMIT} from '../dist/packages/contracts/index.js';
import {DeviceAssignments} from '../dist/apps/host/device-assignments.js';
import {gridDemoConfig} from './helpers/grid-demo.mjs';

const dir = mkdtempSync(join(tmpdir(), 'keyln-browser-'));
const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.slice(7)) || 8942;
if ([8940,8941].includes(port)) throw Error('The browser fixture must use a non-production port (default 8942).');
const addDemo = process.argv.includes('--add-demo');
const iconDemo = process.argv.includes('--app-icons');
const iconDemoFake = process.argv.includes('--icon-demo'), iconReal = process.argv.includes('--icon-real');
if (iconDemoFake && iconReal) { console.error('Use either --icon-demo (fake Iconify, no network) or --icon-real (real Iconify, needs internet), not both.'); process.exit(1); }
const iconLibraryDemo = iconDemoFake || iconReal;
const shellDemo = process.argv.includes('--shell-demo'), scripts = shellDemo ? new ScriptRegistry(dir) : undefined;
let auth = new Auth(dir), store = new ConfigStore(dir), admin, executionCount = 0;
const apps = [{ id: 'test.calculator', name: 'Calculator (test fixture)' }, { id: 'test.failure', name: 'Unavailable app (test fixture)' },
  { id: 'test.slow', name: 'Slow action (test fixture)' }];
if (addDemo) apps.push({id:'test.notes',name:'Notes fixture'},{id:'test.safari',name:'Safari fixture'},{id:'test.windows',name:'Windows App fixture'});
if (iconDemo) apps.splice(0,apps.length,...(await installedApps()).filter(app=>['com.apple.Safari','com.microsoft.rdc.macos','com.apple.finder','com.apple.Terminal','com.apple.calculator'].includes(app.id)));
if (process.argv.includes('--grid-demo')) {
  // The current format: a responsive canvas with a scrolling Pages widget (three pages, one with an App group) and ordinary widgets around it (tests/helpers/grid-demo.mjs).
  store.replace(gridDemoConfig(iconDemo ? apps.map(app => app.id) : undefined), apps);
  console.log('GRID DEMO: temporary sample canvas, pages and fake actions only. No production data is used.');
}
// Fake Iconify for --icon-demo: eleven hand-drawn stand-ins in the style of each set (all use currentColor), no network, no real brand artwork.
const demoSvg = (box, body, size = box) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}" width="${size}" height="${size}">${body}</svg>`;
const stroke = body => `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">${body}</g>`;
const demoIcons = [
  ['lucide:house', 'home house', demoSvg(24, stroke('<path d="M3 10l9-7l9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M9 21v-8h6v8"/>'))],
  ['lucide:camera', 'camera photo', demoSvg(24, stroke('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'))],
  ['lucide:wifi-off', 'wifi offline network', demoSvg(24, stroke('<path d="M2 8.8a15 15 0 0 1 4-2.4M22 8.8a15 15 0 0 0-8-3.7M5 12.9a10 10 0 0 1 3-2M19 12.9a10 10 0 0 0-5-2.8M8.5 16.4a5 5 0 0 1 7 0M12 20h.01M2 2l20 20"/>'))],
  ['tabler:home', 'home house', demoSvg(24, stroke('<path d="M5 12H3l9-9l9 9h-2M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/><path d="M9 21v-6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v6"/>'))],
  ['tabler:player-play', 'play media video', demoSvg(24, stroke('<path d="M7 4v16l13-8z"/>'))],
  ['ph:house', 'home house', demoSvg(256, '<path fill="currentColor" d="M219.31 108.68l-80-80a16 16 0 0 0-22.62 0l-80 80A15.87 15.87 0 0 0 32 120v96a8 8 0 0 0 8 8h64a8 8 0 0 0 8-8v-56h32v56a8 8 0 0 0 8 8h64a8 8 0 0 0 8-8v-96a15.87 15.87 0 0 0-4.69-11.32"/>')],
  ['ph:camera', 'camera photo', demoSvg(256, '<path fill="currentColor" d="M208 56h-27.72l-13.63-20.44A8 8 0 0 0 160 32H96a8 8 0 0 0-6.65 3.56L75.71 56H48a24 24 0 0 0-24 24v112a24 24 0 0 0 24 24h160a24 24 0 0 0 24-24V80a24 24 0 0 0-24-24m-80 128a40 40 0 1 1 40-40a40 40 0 0 1-40 40"/>')],
  ['fluent:home-24-regular', 'home house', demoSvg(24, '<path fill="currentColor" d="M12 2.6l9 6.9V21h-6.5v-6.5h-5V21H3V9.5zm0 1.9L4.5 10.3V19.5h4.5V13h6v6.5h4.5V10.3z"/>')],
  ['fluent:speaker-mute-24-regular', 'volume mute sound speaker', demoSvg(24, '<path fill="currentColor" d="M3 9v6h4l5 4V5L7 9zm11 .5l1-1l2.5 2.5l2.5-2.5l1 1L18.5 12l2.5 2.5l-1 1l-2.5-2.5l-2.5 2.5l-1-1l2.5-2.5z"/>')],
  ['material-symbols:home', 'home house', demoSvg(24, '<path fill="currentColor" d="M4 21V9l8-6l8 6v12h-6v-7h-4v7z"/>')],
  ['simple-icons:demobrand', 'brand logo company', demoSvg(24, '<path fill="currentColor" d="M12 0a12 12 0 1 0 0 24a12 12 0 0 0 0-24m-5 7h10v2H7zm0 4h10v2H7zm0 4h6v2H7z"/>')],
  // Not in the six curated sets: only found with "All Iconify sets". Hand-drawn stand-ins, not real brand artwork.
  ['logos:codex', 'codex logo brand', demoSvg(256, '<rect width="224" height="224" x="16" y="16" rx="52" fill="#111"/><path fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round" stroke-width="22" d="M96 88l-40 40l40 40M160 88l40 40l-40 40"/>')],
  ['devicon:codex', 'codex logo', demoSvg(128, '<circle cx="64" cy="64" r="56" fill="#5061f7"/><path fill="#fff" d="M40 52h48v8H40zm0 16h48v8H40zm0 16h28v8H40z"/>')],
  ['ooui:logo-codex', 'codex logo', demoSvg(20, '<circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path fill="currentColor" d="M6 7h8v1.6H6zm0 3h8v1.6H6zm0 3h5v1.6H6z"/>')],
];
// Details Iconify would report for non-curated sets (the Mac reads them from the same /search answer). `ooui` deliberately has none, so it shows "Unknown license".
const demoSets = {logos: {setName: 'SVG Logos', license: 'CC0-1.0'}, devicon: {setName: 'Devicon', license: 'MIT'}};
const curatedPrefixes = ['material-symbols', 'lucide', 'tabler', 'ph', 'fluent', 'simple-icons'];
const demoById = new Map(demoIcons.map(([id, tags, svg]) => [id, {id, tags, svg}]));
const demoItem = id => { const [set, name] = id.split(':'); return {id, set, name, svg: demoById.get(id).svg, ...(demoSets[set] ?? {setName: set, license: ''})}; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Like the Mac: keep icons of the first ICON_PREFIX_LIMIT distinct sets in the given order and say whether any were dropped.
const capSets = items => {
  const sets = new Set(), results = []; let truncated = false;
  for (const item of items) {
    if (!sets.has(item.set) && sets.size >= ICON_PREFIX_LIMIT) { truncated = true; continue; }
    sets.add(item.set); results.push(item);
  }
  return {results, truncated};
};
const demoSetSvg = new Map();
const demoSource = {
  async search(query, scope, set) {
    let words = query.toLowerCase().split(/\s+/);
    if (words.includes('offline')) throw new Fault('ICON_SEARCH_UNAVAILABLE', 'Searching online icons needs your Mac to reach the internet. My icons still works offline.', 503);
    if (words.includes('slow')) { await pause(3000); words = words.filter(word => word !== 'slow'); if (!words.length) words = ['home', 'camera', 'play', 'volume', 'brand']; }
    // "All Iconify sets" also searches the non-curated stand-ins; a curated search (optionally one set) never sees them.
    const inScope = id => scope === 'all' || curatedPrefixes.includes(id.split(':')[0]);
    if (words.includes('sets')) {
      // Fourteen sets with one icon each: more than the Mac keeps, so an all-sets search is truncated (a curated one is empty).
      if (scope !== 'all') return {results: [], truncated: false};
      return capSets(Array.from({length: 14}, (_, i) => { const [id, , svg] = demoIcons[i % demoIcons.length]; const name = id.replace(':', '-'), demo = `demoset${i}:${name}`; demoSetSvg.set(demo, svg); return {id: demo, set: `demoset${i}`, name, svg, setName: `Demo set ${i}`, license: 'MIT'}; }));
    }
    if (words.includes('many')) {
      // 48 results for layout checks: the stand-ins repeated under distinct valid names.
      return capSets(Array.from({length: 48}, (_, i) => { const [id, , svg] = demoIcons[i % demoIcons.length]; const [s, n] = id.split(':'); return {id: `${s}:${n}-${i}`, set: s, name: `${n}-${i}`, svg, ...(demoSets[s] ?? {setName: s, license: ''})}; })
        .filter(item => inScope(item.id) && (!set || item.set === set)));
    }
    const hits = demoIcons.filter(([id, tags]) => inScope(id) && (!set || id.startsWith(`${set}:`)) && words.some(word => `${id} ${tags}`.includes(word)));
    return capSets(hits.map(([id]) => demoItem(id)));
  },
  async icon(id) {
    if (demoSetSvg.has(id)) return demoSetSvg.get(id);
    const base = demoById.get(id) ?? demoById.get(id.replace(/-\d+$/, ''));
    if (!base) throw new Fault('ICON_NOT_FOUND', 'That icon is not available as plain SVG. Choose another one.', 404);
    return base.svg;
  },
};
// --icon-real: the production Iconify client. It really connects to api.iconify.design (up to 9 requests per search).
const realSource = iconReal ? new IconifyClient() : undefined;
const demoLibrary = iconLibraryDemo ? new IconLibrary(dir) : undefined;
if (iconDemoFake) console.log('ICON DEMO: fake Iconify, no network. Search home, camera, play, volume, brand, wifi; "codex" is only found in All Iconify sets; "sets" in All Iconify sets is cut at the 12-set limit; "offline" fails, "slow" waits 3 s, "many" returns 48. Chinese words such as 主页 are converted by the page before the fake Iconify sees them.');
if (iconReal) console.log('ICON REAL: this uses the REAL Iconify client and CONNECTS TO THE INTERNET (https://api.iconify.design, search words and icon names only, at most 9 requests per search). For manual testing only; the layout, devices and library are still temporary fixture data.');
function makeScheduler() { return new Scheduler({ run: async action => {
  if (action.type === 'shell.run') {
    try { scripts.prepare(action); }
    catch (error) { return {ok:false,code:error.code,message:error.message}; }
  }
  executionCount++;
  await new Promise(resolve => setTimeout(resolve, action.type === 'app.open' && action.appId === 'test.slow' ? 2500 : 700));
  if (action.type === 'shell.run') return {ok:true,message:'Test fixture only: no script was executed.',
    output:{exitCode:0,signal:null,stdout:`FAKE OUTPUT: ${action.args.join(' | ')}`,stderr:'',truncated:false}};
  return action.type === 'app.open' && action.appId === 'test.failure' ? { ok: false, code: 'APP_UNAVAILABLE', message: 'Test fixture: application unavailable.' } :
    { ok: true, message: 'Test fixture only: no Mac action was performed.' };
} }); }
let scheduler, fakeHttps, server;
function uiCredentials() {
  const path = join(dir,'ui-credentials.json');
  writeFileSync(path, JSON.stringify({adminCode:admin.invite(),pairCode:auth.invite()}), {mode:0o600});
  console.log(`SHELL UI FIXTURE ONLY: ${path}`);
}
function launch() {
  // Reconstruct authorization and configuration from the same temporary disk data.
  auth = new Auth(dir); admin = new LocalAdmin(); store = new ConfigStore(dir); scheduler = makeScheduler();
  fakeHttps = createHost({ origin: `http://127.0.0.1:${port}`, tls: {}, auth, admin, store, scheduler,
  apps, scripts, assignments: new DeviceAssignments(dir, () => {}),
  ...(iconDemo?{appIcon:nativeAppIcon,appIcons:nativeAppIcons}:{}),
  ...(iconLibraryDemo?{iconSearch:realSource ?? demoSource,iconLibrary:demoLibrary}:{}),
  ...(addDemo ? {windows:async()=>[{title:'M90Pro（Local LAN）',minimized:true},{title:'T640_Win10（T）',minimized:false}]} : {}),
  onPair: (id, name) => console.log(`Request ${id} from ${JSON.stringify(name)}. Type approve ${id}.`),
});
const handler = fakeHttps.listeners('request')[0];
server = createServer((req, res) => {
  // A separate cookie name and plain transport are confined to this no-side-effect fixture.
  if (req.headers.cookie) req.headers.cookie = req.headers.cookie.replace('keyln-fixture-admin=', '__Host-keyln-admin=').replace('keyln-fixture=', '__Host-keyln=');
  const setHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) => setHeader(name, name.toLowerCase() === 'set-cookie' ? String(value).replace('__Host-keyln-admin=', 'keyln-fixture-admin=').replace('__Host-keyln=', 'keyln-fixture=').replace('; Secure', '') : value);
  handler(req, res);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`NO SIDE EFFECTS: http://127.0.0.1:${port}. Type admin, pair, approve <id>, devices, revoke <id>, stats, restart, quit.`);
  // T64: a pairing code is printed at once; open the page, enter it, then type `approve <id>` with the request id shown here. A new device has no theme yet and is asked for one.
  console.log(`Fixture pairing code: ${auth.invite()} (2 minutes, 5 attempts). After the page sends it, type: approve <id>`);
  if (shellDemo) uiCredentials();
  if (addDemo) console.log('ADD DEMO: temporary configuration; App/window actions are simulated. Type pair to get a code, then approve the displayed request ID.');
});
server.on('upgrade', (req, socket, head) => {
  if (req.headers.cookie) req.headers.cookie = req.headers.cookie.replace('keyln-fixture=', '__Host-keyln=');
  fakeHttps.emit('upgrade', req, socket, head);
});
}
launch();
const terminal = createInterface({ input: process.stdin, output: process.stdout });
terminal.on('line', line => {
  const [command, id] = line.trim().split(/\s+/);
  try {
    if (command === 'pair') console.log(`Fixture pairing code: ${auth.invite()}`);
    else if (command === 'ui' && shellDemo) uiCredentials();
    else if (command === 'admin') console.log(`Fixture admin login code: ${admin.invite()}`);
    else if (command === 'approve') auth.approve(id);
    else if (command === 'devices') console.log(auth.list());
    else if (command === 'revoke') auth.revoke(id);
    else if (command === 'stats') console.log(JSON.stringify({fixtureExecutions:executionCount,revision:store.get().revision,devices:auth.list().length}));
    else if (command === 'restart') closeHost(() => { launch(); console.log(`Fixture state restarted from disk: revision ${store.get().revision}, ${auth.list().length} device(s). Code changes require quit and a new process.`); });
    else if (command === 'quit') stop();
  } catch (error) { console.log(error.message); }
});
function closeHost(done) { scheduler.stop(); fakeHttps.stopEvents(); server.closeAllConnections(); server.close(done); }
function stop() { terminal.close(); closeHost(() => { rmSync(dir, { recursive: true, force: true }); process.exit(0); }); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
