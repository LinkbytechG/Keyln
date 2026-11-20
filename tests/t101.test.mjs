import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as C from '../dist/packages/contracts/index.js';
import {client,deferred} from './helpers/client-harness.mjs';

// T101: Library › App › Activate window stays open after a window is added, so several can be added in a row; the close button, Esc or a click outside
// the list closes it. These tests run the compiled page against the small DOM; they are not browser rendering or Surface touch evidence.
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const cards=f=>f.el('shelf-previews').children.filter(node=>node.className?.includes('shelf-card'));
const windowCards=f=>f.el('shelf-window-list').children;
const open=async t=>{const f=await client(t);f.el('edit-layout').emit('click');f.el('shelf-toggle').emit('click');await f.drain();return f;};
const chooseWindows=async(f,windows)=>{f.heldWindows=deferred();cards(f)[0].emit('contextmenu',{clientX:10,clientY:10});f.el('shelf-app-window-action').emit('click');f.heldWindows.resolve({windows});await f.drain();await f.drain();};
const save=async f=>{f.el('desk-save').emit('click');await f.drain();await f.drain();return f.calls.findLast(c=>c.path==='/api/configuration/save')?.data;};
const rows=[{title:'Win11X99',minimized:false},{title:'Mail',minimized:true},{title:'Notes',minimized:false}];

test('T101 adding a window keeps the list open, marks it Added and lets more be added',async t=>{
  const f=await open(t);await chooseWindows(f,rows);
  windowCards(f)[0].emit('click');await f.drain();
  assert.equal(f.el('shelf-windows').open,true,'still open');
  assert.equal(windowCards(f)[0].disabled,true);assert.equal(windowCards(f)[0].dataset.added,'true');assert.equal(windowCards(f)[0].children[1].textContent,'Added');
  assert.match(windowCards(f)[0].getAttribute('aria-label'),/^Added window Win11X99/);
  assert.match(f.el('shelf-window-note').textContent,/Added “Win11X99” to the draft/);
  windowCards(f)[0].emit('click');await f.drain();
  windowCards(f)[2].emit('click');await f.drain();assert.equal(f.el('shelf-windows').open,true);
  const keys=C.allComponents(await save(f)).filter(item=>item.action?.type==='window.activate').map(item=>item.action.title);
  assert.deepEqual(keys,['Win11X99','Notes'],'two keys, the first not added twice');
  assert.equal(f.count('execute'),0);
});

test('T101 Retry keeps the Added marks; reopening the list starts fresh',async t=>{
  const f=await open(t);await chooseWindows(f,rows);windowCards(f)[1].emit('click');await f.drain();
  f.heldWindows=deferred();f.el('shelf-window-retry').emit('click');f.heldWindows.resolve({windows:rows});await f.drain();await f.drain();
  assert.equal(windowCards(f)[1].dataset.added,'true');assert.equal(windowCards(f)[0].disabled,false);
  f.el('shelf-window-close').emit('click');assert.equal(f.el('shelf-windows').open,false);
  await chooseWindows(f,rows);assert.equal(windowCards(f)[1].disabled,false,'a new opening offers every window again');assert.equal(windowCards(f)[1].children[1].textContent,'Minimized');
});

test('T101 a click outside the list closes it; a click inside its box does not',async t=>{
  const f=await open(t);await chooseWindows(f,rows);const dialog=f.el('shelf-windows');dialog.rect={left:100,top:100,width:400,height:300};
  dialog.emit('click',{target:dialog,clientX:300,clientY:390});assert.equal(dialog.open,true,'on the dialog padding, inside the box');
  dialog.emit('click',{target:windowCards(f)[2],clientX:20,clientY:20});assert.equal(dialog.open,true,'a click that started on a card is not outside');
  dialog.emit('click',{target:dialog,clientX:20,clientY:20});assert.equal(dialog.open,false,'on the backdrop');
});

test('T101 the source and style say the list stays open',()=>{
  const source=read('apps/web/library-apps.ts');
  assert.doesNotMatch(source,/if \(problem\) \{ windowNote\.textContent = problem; return; \} closeWindows\(\);/,'adding no longer closes the list');
  assert.match(read('apps/web/style.css'),/\.shelf-window-card\[data-added=true\]\{opacity:1;border-color:var\(--ok\)\}/);
});
