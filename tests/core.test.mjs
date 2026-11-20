import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Auth } from '../dist/apps/host/auth.js';
import { ConfigStore, lockDataDir } from '../dist/apps/host/store.js';
import { Scheduler, RETENTION_MS } from '../dist/apps/host/scheduler.js';
import { parseTrigger, parseConfig } from '../dist/packages/contracts/index.js';
import { key, layout, withComponents, components } from './helpers/layout.mjs';

const apps = [{ id: 'com.apple.calculator', name: 'Calculator' }];
// A saved layout holding the one key `primary`, as the Mac stores it (T58: the layout is replaced as a whole; the one-button editing API is gone).
const edit = (store, revision, extra = {}) => store.replace({ ...withComponents(store.get(), [key('primary', { type: 'app.open', appId: apps[0].id }, {}, { label: 'Calculate', icon: 'spark', ...extra })]), revision }, apps);
function directory(t) { const dir = mkdtempSync(join(tmpdir(), 'keyln-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function session(auth) { const p = auth.begin(auth.invite(), 'Surface'); auth.approve(p.id); const token = auth.claim(p.id, p.claim).token; return { id: p.id, cookie: `__Host-keyln=${token}` }; }
const fault = code => error => error.code === code;
const tick = () => new Promise(resolve => setImmediate(resolve));
const trigger = revision => ({ requestId: randomUUID(), revision, componentId: 'primary' });
const configured = parseConfig(layout([key('primary', { type: 'app.open', appId: apps[0].id }, {}, { label: 'Calculate' })], { revision: 1 }));

test('configuration saves atomically, persists across restart, and rejects stale or malicious edits', t => {
  const dir = directory(t), store = new ConfigStore(dir);
  assert.deepEqual(components(store.get()), []);
  const saved = edit(store, 0);
  assert.equal(saved.revision, 1);
  assert.deepEqual(new ConfigStore(dir).get(), saved);
  assert.throws(() => edit(store, 0), fault('CONFIG_CONFLICT'));
  assert.throws(() => store.replace({ ...store.get(), command: 'touch /tmp/not-authorized' }, apps), fault('INVALID_INPUT'));
  assert.throws(() => store.replace(withComponents(store.get(), [key('primary', { type: 'app.open', appId: 'missing.app' })]), apps), fault('APP_UNAVAILABLE'));
  assert.equal(JSON.parse(readFileSync(store.backup)).library.revision, 0);
  components(saved)[0].label = 'external mutation';
  assert.equal(components(store.get())[0].label, 'Calculate');
});
test('write failure preserves active and on-disk configuration', t => {
  const dir = directory(t), store = new ConfigStore(dir);
  mkdirSync(store.backup); // Makes the backup rename fail even when tests run as the file owner.
  assert.throws(() => edit(store, 0), fault('SAVE_FAILED'));
  assert.equal(store.get().revision, 0);
  assert.equal(new ConfigStore(dir).get().revision, 0);
});
test('corrupt configuration fails closed and explicit restore uses the last valid backup', t => {
  const dir = directory(t), store = new ConfigStore(dir);
  const oldSession = session(new Auth(dir));
  edit(store, 0); edit(store, 1, { label: 'Changed' });
  writeFileSync(store.path, '{broken');
  assert.throws(() => new ConfigStore(dir), /damaged/);
  execFileSync(process.execPath, ['dist/apps/host/restore.js'], { env: { ...process.env, KEYLN_DATA_DIR: dir } });
  assert.equal(components(new ConfigStore(dir).get())[0].label, 'Calculate');
  assert.equal(new ConfigStore(dir).get().revision, 1);
  assert.throws(() => new Auth(dir).authenticate(oldSession.cookie), fault('UNAUTHORIZED'));
});
test('missing configuration with a backup cannot silently reset; a second Host cannot share storage', t => {
  const dir = directory(t), store = new ConfigStore(dir);
  edit(store, 0); rmSync(store.path);
  assert.throws(() => new ConfigStore(dir), /backup exists/);
  const unlock = lockDataDir(dir);
  assert.throws(() => lockDataDir(dir), /Another Keyln/); unlock();
});
test('contracts reject unsupported versions, arbitrary actions and trigger overrides', () => {
  assert.throws(() => parseConfig({ ...configured, version: 3 }), fault('CONFIG_VERSION'));
  assert.throws(() => parseConfig(withComponents(configured, [{ ...components(configured)[0], action: { type: 'shell.run', appId: 'anything' } }])), fault('INVALID_INPUT'));
  assert.throws(() => parseTrigger({ ...trigger(1), action: 'shell.run' }), fault('INVALID_INPUT'));
  assert.throws(() => parseTrigger({ ...trigger(1), revision: -1 }), fault('INVALID_INPUT'));
  assert.throws(() => parseTrigger({ ...trigger(1), requestId: '__proto__' }), fault('INVALID_INPUT'));
});
test('pairing requires a live code, explicit local approval and possession of the claim secret', t => {
  const auth = new Auth(directory(t));
  assert.throws(() => auth.begin('12345678', 'Surface'), fault('PAIR_CLOSED'));
  const pair = auth.begin(auth.invite(), 'Surface');
  assert.equal(auth.claim(pair.id, pair.claim).approved, false);
  assert.throws(() => auth.claim(pair.id, '0'.repeat(64)), fault('PAIR_EXPIRED'));
  auth.approve(pair.id);
  assert.equal(auth.claim(pair.id, pair.claim).approved, true);
  assert.throws(() => auth.claim(pair.id, pair.claim), fault('PAIR_EXPIRED'));
});
test('pairing attempt cap, expiry and one-time use are enforced', t => {
  let now = 1000;
  const auth = new Auth(directory(t), () => now), code = auth.invite();
  const wrong = code === '11111111' ? '22222222' : '11111111';
  for (let i = 0; i < 5; i++) assert.throws(() => auth.begin(wrong, 'Surface'), fault('PAIR_INVALID'));
  assert.throws(() => auth.begin(code, 'Surface'), fault('PAIR_CLOSED'));
  const fresh = auth.invite(); now += 120_001;
  assert.throws(() => auth.begin(fresh, 'Surface'), fault('PAIR_CLOSED'));
  const pair = auth.begin(auth.invite(), 'Surface'); now += 120_001;
  assert.throws(() => auth.approve(pair.id), /No matching/);
});
test('device authorization persists as a hash; expiry and revocation invalidate existing sessions', t => {
  const dir = directory(t); let now = 1000;
  const auth = new Auth(dir, () => now), device = session(auth);
  assert.equal(auth.authenticate(device.cookie).id, device.id);
  assert.equal(new Auth(dir, () => now).authenticate(device.cookie).id, device.id);
  const raw = readFileSync(join(dir, 'devices.json'), 'utf8');
  assert.ok(!raw.includes(device.cookie.slice(13)));
  assert.throws(() => auth.authenticate(), fault('UNAUTHORIZED'));
  assert.throws(() => auth.authenticate('__Host-keyln=' + '0'.repeat(64)), fault('UNAUTHORIZED'));
  auth.revoke(device.id);
  assert.throws(() => auth.authenticate(device.cookie), fault('UNAUTHORIZED'));
  assert.throws(() => new Auth(dir, () => now).authenticate(device.cookie), fault('UNAUTHORIZED'));
  const later = session(auth); now += 31 * 86400_000;
  assert.throws(() => auth.authenticate(later.cookie), fault('UNAUTHORIZED'));
});
test('malformed persisted authorization fails closed', t => {
  const dir = directory(t); writeFileSync(join(dir, 'devices.json'), '{broken');
  assert.throws(() => new Auth(dir), /damaged/);
});
test('scheduler acknowledges before completion, deduplicates and rejects concurrent actions', async () => {
  let finish, calls = 0;
  const scheduler = new Scheduler({ run: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const input = trigger(1), first = scheduler.trigger('surface', input, configured);
  assert.equal(first.status, 'accepted'); assert.equal(scheduler.busy, true);
  assert.equal(scheduler.trigger('surface', input, { ...configured, revision: 2 }).id, first.id);
  assert.throws(() => scheduler.trigger('surface', { ...input, revision: 2 }, configured), fault('REQUEST_CONFLICT'));
  assert.throws(() => scheduler.trigger('other', trigger(1), configured), fault('BUSY'));
  assert.throws(() => scheduler.get('other', input.requestId), fault('RESULT_UNKNOWN'));
  await tick(); assert.equal(calls, 1); assert.equal(scheduler.get('surface', input.requestId).status, 'running');
  finish({ ok: true, message: 'Foreground verified' }); await tick();
  assert.equal(scheduler.get('surface', input.requestId).status, 'succeeded');
  assert.equal(scheduler.busy, false);
  scheduler.trigger('surface', input, configured); await tick(); assert.equal(calls, 1);
});
test('stale and unconfigured triggers never reach the adapter', () => {
  let calls = 0; const scheduler = new Scheduler({ run: async () => { calls++; return { ok: true, message: '' }; } });
  assert.throws(() => scheduler.trigger('surface', trigger(0), configured), fault('CONFIG_CONFLICT'));
  assert.throws(() => scheduler.trigger('surface', trigger(1), withComponents(configured, [{ ...components(configured)[0], action: null }])), fault('NOT_CONFIGURED'));
  assert.equal(calls, 0);
});
test('known adapter failure, timeout and a restarted Host report distinct outcomes', async () => {
  const scheduler = new Scheduler({ run: async () => ({ ok: false, code: 'APP_UNAVAILABLE', message: 'Missing app' }) });
  const input = trigger(1); scheduler.trigger('surface', input, configured); await tick();
  assert.equal(scheduler.get('surface', input.requestId).status, 'failed');
  let aborted = false;
  const hung = new Scheduler({ run: (_app, signal) => new Promise(() => signal.addEventListener('abort', () => { aborted = true; })) }, Date.now, 15);
  hung.trigger('surface', input, configured);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(aborted, true); assert.equal(hung.get('surface', input.requestId).status, 'unknown'); assert.equal(hung.busy, false);
  assert.throws(() => new Scheduler({ run: async () => ({ ok: true, message: '' }) }).get('surface', input.requestId), fault('RESULT_UNKNOWN'));
});
test('dedupe history is retained for ten minutes and capacity cannot evict recent executions', async () => {
  let now = 1000; const scheduler = new Scheduler({ run: async () => ({ ok: true, message: 'Done' }) }, () => now, 100, 1);
  const input = trigger(1); scheduler.trigger('surface', input, configured); await tick();
  assert.throws(() => scheduler.trigger('surface', trigger(1), configured), fault('CAPACITY'));
  now += RETENTION_MS - 1; assert.equal(scheduler.get('surface', input.requestId).status, 'succeeded');
  now += 1; assert.throws(() => scheduler.get('surface', input.requestId), fault('RESULT_UNKNOWN'));
});
test('scheduler observers cannot mutate retained results or interrupt execution, and stopping prevents new side effects',async()=>{
  let calls=0;const scheduler=new Scheduler({run:async()=>{calls++;return {ok:true,message:'Fake completion'};}});
  scheduler.onChange(()=>{throw new Error('Disconnected observer');});
  scheduler.onChange((_device,execution)=>{execution.status='failed';});
  const seen=[],unsubscribe=scheduler.onChange((device,execution)=>seen.push({device,status:execution.status}));
  const first=trigger(1);scheduler.trigger('surface',first,configured);await tick();
  assert.deepEqual(seen,[{device:'surface',status:'accepted'},{device:'surface',status:'running'},{device:'surface',status:'succeeded'}]);
  assert.equal(scheduler.get('surface',first.requestId).status,'succeeded');
  unsubscribe();const second=trigger(1);scheduler.trigger('surface',second,configured);scheduler.stop();await tick();
  assert.equal(calls,1);assert.equal(scheduler.get('surface',second.requestId).status,'unknown');
  assert.equal(scheduler.busy,false);assert.equal(seen.length,3);
  assert.throws(()=>scheduler.trigger('surface',trigger(1),configured),fault('HOST_STOPPING'));
});
