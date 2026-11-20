import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { keyboardKeys, parseAction, parseTrigger, parseConfig } from '../dist/packages/contracts/index.js';
import { key, layout, withComponents, components } from './helpers/layout.mjs';
import { ConfigStore } from '../dist/apps/host/store.js';
import { Scheduler } from '../dist/apps/host/scheduler.js';

const shortcut = { type: 'keyboard.shortcut', key: 'KeyK', modifiers: ['command', 'shift'] };
const fault = code => error => error.code === code;
test('shortcut validation canonicalizes modifiers and rejects arbitrary keys, repeats and extra payload', () => {
  assert.deepEqual(parseAction({ ...shortcut, modifiers: ['shift', 'command'] }), shortcut);
  assert.deepEqual(parseAction({ ...shortcut, modifiers: [] }).modifiers, []);
  assert.deepEqual(parseAction({ ...shortcut, modifiers: ['command', 'option', 'control', 'shift'] }).modifiers.length, 4);
  for (const invalid of [
    { ...shortcut, key: 'hello' }, { ...shortcut, key: 'KeyA;open -a Terminal' },
    { ...shortcut, modifiers: ['command', 'command'] }, { ...shortcut, modifiers: ['fn'] },
    { ...shortcut, modifiers: 'command' }, { ...shortcut, text: 'secret' }, { ...shortcut, keyCode: 40 },
  ]) assert.throws(() => parseAction(invalid), fault('INVALID_INPUT'));
  assert.throws(() => parseTrigger({ requestId: randomUUID(), componentId: 'primary', revision: 1, action: shortcut }), fault('INVALID_INPUT'));
});
test('keyboard configuration persists in the layout and rejects stale edits', t => {
  const dir = mkdtempSync(join(tmpdir(), 'keyln-keyboard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new ConfigStore(dir), apps = [{id:'com.apple.calculator',name:'Calculator'}];
  store.replace(withComponents(store.get(), [key('primary', { type: 'app.open', appId: apps[0].id }, {}, { label: 'Calculator' })]), apps);
  const saved = store.replace(withComponents(store.get(), [key('primary', shortcut, {}, { label: 'My shortcut', icon: 'bolt' })]), apps);
  assert.deepEqual(components(new ConfigStore(dir).get())[0].action, shortcut);
  assert.throws(() => store.replace({ ...store.get(), revision: 1 }, apps), fault('CONFIG_CONFLICT'));
  const restoredApp = store.replace(withComponents(saved, [key('primary', { type: 'app.open', appId: apps[0].id }, {}, { label: 'Calculator' })]), apps);
  assert.equal(components(restoredApp)[0].action.type, 'app.open');
});
test('scheduler snapshots the saved shortcut and reports a known permission failure without retrying', async () => {
  const observed = [];
  const scheduler = new Scheduler({run:async action => { observed.push(action); return {ok:false,code:'ACCESSIBILITY_REQUIRED',message:'No keys were sent.'}; }});
  const config = parseConfig(layout([key('primary',structuredClone(shortcut),{},{label:'Shortcut',icon:'bolt'})],{revision:1}));
  const trigger = {requestId:randomUUID(),componentId:'primary',revision:1};
  const first = scheduler.trigger('surface', trigger, config);
  components(config)[0].action.key = 'KeyQ'; components(config)[0].action.modifiers.push('control');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(observed, [shortcut]);
  const result = scheduler.get('surface', trigger.requestId);
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'ACCESSIBILITY_REQUIRED');
  assert.equal(result.actionType, 'keyboard.shortcut');
  assert.equal(scheduler.trigger('surface', trigger, config).id, first.id);
  assert.equal(observed.length, 1);
});
test('native diagnostics are read-only and its accepted key set matches the wire contract', () => {
  const result = spawnSync('dist/keyln-helper', ['doctor'], {encoding:'utf8',timeout:5000});
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(typeof data.accessibilityTrusted, 'boolean');
  assert.equal(typeof data.eventPostingAllowed, 'boolean');
  assert.equal(typeof data.keyboardLayoutID, 'string');
  assert.deepEqual(data.supportedKeys, [...keyboardKeys].sort());
});
test('native input validation rejects invalid arguments before any key can be posted', () => {
  for (const args of [['shortcut','invalid','command'], ['shortcut','KeyK','command,command'], ['shortcut','KeyK','sudo'], ['shortcut','KeyK','command','extra']]) {
    const result = spawnSync('dist/keyln-helper', args, {encoding:'utf8',timeout:5000});
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).ok, false);
  }
});
