import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as C from '../dist/packages/contracts/index.js';
import {viewOf} from './helpers/layout.mjs';
const {viewFor}=C;
import {ConfigStore} from '../dist/apps/host/store.js';
import {importPreview} from '../dist/apps/host/layout.js';
import {formatClock, clockWidget} from '../dist/apps/web/widgets/display.js';
import {createRegistry} from '../dist/apps/web/widgets/registry.js';
import {registerSystemWidgets} from '../dist/apps/web/widgets/system.js';
import {resizeWidget} from '../dist/apps/web/page-layout.js';
import {installDom} from './helpers/widget-dom.mjs';
import {client} from './helpers/client-harness.mjs';

const clock=(form='time',size='M')=>({id:'clock',kind:'clock',size,form});
const config=widget=>({...C.initialView(),widgets:[{id:'pages',kind:'pages',pages:[{id:'page',name:'Page',widgets:[widget]}]}]});
const inside=value=>value.widgets[0].pages[0].widgets[0];
const find=(node,match)=>match(node)?node:node.children?.map(child=>find(child,match)).find(Boolean);

test('T78 legacy clocks normalize in pages, rendering, import and storage',t=>{
  installDom(t); document.addEventListener=()=>{}; document.removeEventListener=()=>{};
  const registry=createRegistry({refresh(){},reconnect(){},setMode(){}});registerSystemWidgets(registry);
  for(const [form,sizes] of [['time',['S','M','Wide']],['time-date',['M','L','Wide']]]) for(const size of sizes){
    const input=config(clock(form,size)), parsed=viewOf(input);
    assert.deepEqual(inside(parsed),clock());
    assert.deepEqual(inside(importPreview(input,[],()=>{}).view),clock());
    assert.deepEqual(C.widgetPresetU(inside(parsed)),{w:240,h:120});
    const widget=registry.create('clock',inside(parsed).form,true);
    assert.ok(widget.element.find(node=>node.className==='clock-time').textContent);
    assert.ok(widget.element.find(node=>node.className==='clock-date').getAttribute('aria-label'));
    widget.destroy();
  }
  assert.deepEqual(C.DISPLAY_FORMS.clock,['time']);
  assert.deepEqual(C.sizingFor('clock','time').offeredPresets,['M']);
  assert.throws(()=>C.sizingFor('clock','time-date'));
  assert.throws(()=>resizeWidget(config(clock()),'clock','L'));
  for(const bad of [{...clock(),form:'unknown'},{...clock(),size:'huge'},{...clock(),size:{w:240,h:120}},{...clock(),text:'x'},{id:'clock',kind:'clock',size:'M'}]) assert.throws(()=>C.parseConfig(config(bad)));
});

test('T78 save writes canonical v2 clocks and restore normalizes a legacy backup',t=>{
  const dir=mkdtempSync(join(tmpdir(),'keyln-t78-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  // T94: the Host never runs on a v2 file, so the legacy clock arrives as a save (normalized by the parser) and as a v2 backup (normalized when it is read).
  const input=config(clock('time-date','Wide'));
  const store=new ConfigStore(dir);
  const saved=store.replace(input,[]);assert.deepEqual(inside(saved),clock());
  assert.deepEqual(inside(viewFor(JSON.parse(readFileSync(store.path)),'Surface')),clock());
  writeFileSync(store.backup,JSON.stringify(input));
  const restored=store.restoreBackup({stamp:store.backupState().stamp,confirm:true},()=>{});
  assert.deepEqual(inside(restored),clock());assert.deepEqual(inside(viewFor(JSON.parse(readFileSync(store.path)),'Surface')),clock());
});


test('T78 local calendar date and ISO week across year boundaries',()=>{
  for(const [year,month,day,expected] of [[2026,10,28,'Oct 28  Wed  Week 44'],[2026,12,31,'Dec 31  Thu  Week 53'],[2027,1,1,'Jan 1  Fri  Week 53'],[2027,1,4,'Jan 4  Mon  Week 1'],[2023,1,1,'Jan 1  Sun  Week 52']]){
    assert.deepEqual(formatClock(new Date(year,month-1,day,9,3)),{time:'09:03',date:expected});
  }
});

test('T78 clock ticks on each minute boundary and rolls at local midnight',t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:new Date(2026,11,31,23,59,42).getTime()});
  const dom=installDom(t);dom.document.addEventListener=()=>{};dom.document.removeEventListener=()=>{};
  const widget=clockWidget.create({form:'time',standalone:true,intents:{refresh(){},reconnect(){},setMode(){}},create(){}});
  const time=widget.element.find(node=>node.className==='clock-time'),date=widget.element.find(node=>node.className==='clock-date');
  assert.equal(time.textContent,'23:59');assert.deepEqual(date.children.map(group=>group.textContent),['Dec 31','Thu','Week 53']);assert.equal(date.getAttribute('aria-label'),'Dec 31  Thu  Week 53');
  t.mock.timers.tick(17_999);assert.equal(time.textContent,'23:59');
  t.mock.timers.tick(1);assert.equal(time.textContent,'00:00');assert.deepEqual(date.children.map(group=>group.textContent),['Jan 1','Fri','Week 53']);assert.equal(date.getAttribute('aria-label'),'Jan 1  Fri  Week 53');
  t.mock.timers.tick(59_999);assert.equal(time.textContent,'00:00');t.mock.timers.tick(1);assert.equal(time.textContent,'00:01');
  t.mock.timers.tick(60_000);assert.equal(time.textContent,'00:02');widget.destroy();
});

test('T78 library has one live clock card, adds M and hides clock controls',async t=>{
  const f=await client(t);f.el('edit-layout').emit('click');f.el('shelf-toggle').emit('click');await f.drain();
  f.el('shelf-types').children.find(node=>node.dataset.libraryType==='widget').emit('click');
  const cards=f.el('shelf-previews').children.filter(node=>node.className?.includes('shelf-card'));
  assert.equal(cards.length,1);assert.deepEqual([cards[0].dataset.form,cards[0].dataset.tier],['time','M']);assert.equal(cards[0].getAttribute('aria-label'),'Add Clock');
  const preview=cards[0].children[0].children[0];assert.equal(preview.className,'w-clock');assert.ok(preview.children[0].textContent);assert.deepEqual(preview.children[1].children.length,3);assert.ok(preview.children[1].getAttribute('aria-label'));
  cards[0].emit('click');await f.drain();
  const node=find(f.el('button-grid'),n=>n.dataset?.widgetId&&n.children?.some(child=>child.className==='w-clock'));
  assert.ok(node);node.emit('click');await f.drain();
  assert.equal(f.el('card-size').hidden,true);assert.equal(f.el('display-form-field').hidden,true);
  node.emit('contextmenu',{clientX:20,clientY:20});assert.deepEqual(f.el('edit-menu').children.map(child=>child.textContent),['Edit','Remove']);
  f.el('desk-save').emit('click');await f.drain();await f.drain();
  const saved=f.calls.findLast(call=>call.path==='/api/configuration/save').data;
  const added=saved.widgets.flatMap(item=>item.kind==='pages'?item.pages.flatMap(page=>page.widgets):[item]).find(item=>item.kind==='clock');
  assert.deepEqual([added.form,added.size],['time','M']);
});
