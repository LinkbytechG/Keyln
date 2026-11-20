import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as C from '../dist/packages/contracts/index.js';
import {viewOf,withLayoutRevision} from './helpers/layout.mjs';
import {ConfigStore} from '../dist/apps/host/store.js';
import {importPreview} from '../dist/apps/host/layout.js';
import {flowLayout,fractionalContentSize} from '../dist/apps/web/page-view.js';
import {moveWidget} from '../dist/apps/web/page-layout.js';
import {client} from './helpers/client-harness.mjs';
import {treeFind} from './helpers/responsive-boxes.mjs';
const make=()=>C.initialView();
const fixed=(w,h)=>({w:{mode:'fixed',u:w},h:{mode:'fixed',u:h}});
const page=(id,w,h)=>({id,kind:'pages',size:fixed(w,h),pages:[{id:id+'-page',name:'Page',widgets:[]}]});
const key=id=>({id,kind:'key',size:'S',label:id,icon:'app',action:null});
const find=(f,p)=>treeFind(f.el('button-grid'),p);
test('T73 v2 validates optional exact Pages dimensions and preserves v1 boundary',()=>{
 const old=make();assert.deepEqual(viewOf(old),withLayoutRevision(old));const value=structuredClone(old);value.widgets[0].dimensions={w:241,h:3840};assert.deepEqual(viewOf(value).widgets[0].size,fixed(241,3840));
 for(const bad of [{w:0,h:120},{w:-1,h:120},{w:120,h:0},{w:120,h:3841},{w:1.1,h:120},{w:240},{w:240,h:240,x:1},null]){const copy=structuredClone(value);copy.widgets[0].dimensions=bad;assert.throws(()=>C.parseConfig(copy));}
 const other=structuredClone(old);other.widgets[0].pages[0].widgets.push({...key('a'),dimensions:{w:240,h:240}});assert.throws(()=>C.parseConfig(other));
 const v1={format:'keyln.config',version:1,revision:0,canvas:{cols:4,rows:4},widgets:[{...page('legacy',240,240),dimensions:{w:240,h:240},cell:{x:0,y:0},span:{cols:4,rows:4}}]};assert.throws(()=>C.readConfig(v1));
});
test('T73 exact u Pages mix with keys and other Pages in order without overlap; wide sizes clamp',()=>{
 const items=[key('a'),page('p',241,360),key('b'),page('q',480,241),key('c')];const layout=flowLayout(items,900,'standard',8,14),scale=layout.cell/120;
 assert.deepEqual(layout.placements.map(x=>x.id),items.map(x=>x.id));for(const [i,a] of layout.placements.entries())for(const b of layout.placements.slice(i+1))assert.ok(a.left+a.width<=b.left+1e-6||b.left+b.width<=a.left+1e-6||a.top+a.height<=b.top+1e-6||b.top+b.height<=a.top+1e-6);
 assert.ok(Math.abs(layout.placements[1].width-241*scale)<1e-8);assert.ok(Math.abs(layout.placements[1].height-360*scale)<1e-8);assert.equal(layout.placements[0].top,layout.placements[1].top);
 const wide=flowLayout([page('wide',3840,240)],320,'standard',8,14);assert.equal(wide.overflow,false);assert.equal(wide.placements[0].width,320-28);
});
test('T73 temporary store restart, revision conflict, backup restore and movement preserve dimensions and page content',t=>{
 const dir=mkdtempSync(join(tmpdir(),'keyln-t73-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const store=new ConfigStore(dir);let draft=store.get();draft.widgets[0].size=fixed(721,481);draft.widgets[0].pages[0].widgets.push(key('inside'));const saved=store.replace(draft,[]);assert.deepEqual(new ConfigStore(dir).get(),saved);assert.throws(()=>store.replace(draft,[]),e=>e.code==='CONFIG_CONFLICT');
 const moved=moveWidget({...saved,widgets:[key('outside'),...saved.widgets]},saved.widgets[0].id,{},0);assert.deepEqual(moved.widgets[0].size,fixed(721,481));assert.equal(moved.widgets[0].pages[0].widgets[0].id,'inside');assert.deepEqual(importPreview(JSON.parse(JSON.stringify(saved)),[],()=>{}).view,withLayoutRevision(saved));
 const next=structuredClone(saved);delete next.widgets[0].size;store.replace(next,[]);const backup=store.backupState();assert.equal(backup.available,true);const restored=store.restoreBackup({stamp:backup.stamp,confirm:true},()=>{});assert.deepEqual(restored.widgets[0].size,fixed(721,481));assert.ok(readFileSync(store.path,'utf8').includes('721'));
});
test('T73 Pages sizing is a draft, blocks invalid input and supports Undo and conflict',async t=>{
 const config=make();config.widgets[0].size=fixed(720,480);const f=await client(t,{configuration:config});f.el('edit-layout').emit('click');await f.drain();let outer=find(f,n=>n.className==='pages-widget'),owner=find(f,n=>n.className==='pages-owner'),label=owner.children[1];assert.equal(label.className,'pages-owner-label');outer.emit('click',{target:label,detail:0});await f.drain();assert.equal(f.el('pages-settings').hidden,false);assert.equal(f.el('pages-width').value,'720');assert.equal(f.el('pages-height').value,'480');
 const width=f.el('pages-width');width.focus();width.value='241';width.emit('input');await f.drain();assert.equal(document.activeElement,width);assert.equal(width.value,'241');width.value='';width.emit('input');await f.drain();assert.equal(f.el('desk-save').disabled,true);assert.match(f.el('pages-size-error').textContent,/whole numbers/);f.el('desk-save').emit('click');await f.drain();assert.equal(f.count('configuration/save'),0);f.el('edit-undo').emit('click');await f.drain();assert.equal(width.value,'241');assert.equal(f.el('pages-size-error').textContent,'');
 f.saveFault={code:'CONFIG_CONFLICT',status:409,message:'Changed'};f.el('desk-save').emit('click');await f.drain();await f.drain();const sent=f.calls.findLast(c=>c.path==='/api/configuration/save').data;assert.deepEqual(sent.widgets[0].size,fixed(241,480));assert.equal(f.el('save-message').dataset.dirty,'true');assert.equal(f.el('desk-save').disabled,true);
});
test('T73 console places custom Pages beside a key and retains its inner contents',async t=>{
 const config=make();config.widgets=[key('outside'),{...config.widgets[0],size:fixed(241,360)}];config.widgets[1].pages[0].widgets.push(key('inside'));const f=await client(t,{configuration:config,viewport:{width:1366,height:768}});await f.drain();const outer=find(f,n=>n.className==='pages-widget'),outside=f.button('outside');assert.ok(outer);assert.ok(f.button('inside'));assert.equal(parseFloat(outer.style['--ky']),parseFloat(outside.style['--ky']));assert.ok(parseFloat(outer.style['--kx'])>parseFloat(outside.style['--kx']));assert.ok(parseFloat(outer.style['--kw'])>0);
});

test('T73 presets, fill and Undo preserve Pages content',async t=>{
 const f=await client(t);f.el('edit-layout').emit('click');await f.drain();const outer=find(f,n=>n.className==='pages-widget'),label=find(f,n=>n.className==='pages-owner-label');outer.emit('click',{target:label,detail:0});await f.drain();f.el('pages-width-percent').emit('click');f.el('pages-percent-75').emit('click');await f.drain();assert.equal(f.el('pages-width').value,'75');f.el('pages-width-fill').emit('click');await f.drain();assert.equal(f.el('pages-width-fill').getAttribute('aria-pressed'),'true');f.el('edit-undo').emit('click');await f.drain();assert.equal(f.el('pages-width').value,'75');f.el('desk-save').emit('click');await f.drain();await f.drain();const sent=f.calls.findLast(c=>c.path==='/api/configuration/save').data;assert.deepEqual(sent.widgets[0].size.w,{mode:'percent',pct:75});assert.deepEqual(sent.widgets[0].pages,f.state.config.widgets[0].pages);
});
test('T73 invalid size remains visible and locatable after selecting a different Pages widget',async t=>{
 const config=make();config.widgets[0].size=fixed(720,480);config.widgets.push(page('second',480,360));const f=await client(t,{configuration:config});f.el('edit-layout').emit('click');await f.drain();
 const outer=id=>find(f,n=>n.className==='pages-widget'&&n.dataset.widgetId===id),label=id=>treeFind(outer(id),n=>n.className==='pages-owner-label');const first=config.widgets[0].id;
 outer(first).emit('click',{target:label(first),detail:0});await f.drain();const width=f.el('pages-width');width.value='';width.emit('input');await f.drain();outer('second').emit('click',{target:label('second'),detail:0});await f.drain();
 assert.equal(f.el('pages-invalid-warning').hidden,false);assert.equal(f.el('pages-fix-invalid').hidden,false);assert.equal(f.el('desk-save').disabled,true);f.el('pages-fix-invalid').emit('click');await f.drain();assert.equal(document.activeElement,width);assert.match(f.el('pages-size-error').textContent,/whole numbers/);width.value='721';width.emit('input');await f.drain();assert.equal(f.el('pages-invalid-warning').hidden,true);assert.equal(f.el('desk-save').disabled,false);f.el('desk-save').emit('click');await f.drain();await f.drain();const sent=f.calls.findLast(c=>c.path==='/api/configuration/save').data;assert.deepEqual(sent.widgets[0].size,fixed(721,480));assert.deepEqual(sent.widgets[1].size,fixed(480,360));
});

test('T73 fractional Pages content width respects the stable scrollbar gutter without a spurious horizontal overflow',()=>{
 const room=fractionalContentSize({width:473.59375,height:311.1953125},{width:474,height:311},{width:463,height:311});assert.deepEqual(room,{width:462.59375,height:311.1953125});
 const layout=flowLayout(Array.from({length:24},(_,i)=>key(`inner-${i}`)),room.width,'standard',8,14);assert.equal(layout.overflow,false);assert.ok(layout.width<=room.width);assert.equal(Math.round(layout.width),463);
 const short=fractionalContentSize({width:473.59375,height:311.1953125},{width:474,height:311},{width:463,height:300});assert.equal(short.height,300.1953125);
});
