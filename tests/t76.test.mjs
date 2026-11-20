import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as C from '../dist/packages/contracts/index.js';
import {viewOf,withLayoutRevision} from './helpers/layout.mjs';
import {ConfigStore} from '../dist/apps/host/store.js';
import {importPreview} from '../dist/apps/host/layout.js';
import {flowLayout} from '../dist/apps/web/page-view.js';
import {client} from './helpers/client-harness.mjs';
import {responsiveBoxes,treeFind} from './helpers/responsive-boxes.mjs';
const key={id:'inside',kind:'key',size:'S',label:'App',icon:'app',action:null};
const fixed=(w,h)=>({w:{mode:'fixed',u:w},h:{mode:'fixed',u:h}});
const make=(w=120,h=120)=>{const c=C.initialView();c.widgets[0].size=fixed(w,h);c.widgets[0].pages[0].widgets=[structuredClone(key)];return c;};
const outer=f=>treeFind(f.el('button-grid'),n=>n.className==='pages-widget');
const event=x=>({pointerId:7,isPrimary:true,button:0,preventDefault(){},stopPropagation(){},...x});
test('T76 Pages accepts positive integer sizes below 240u across restart and file import; a default App key remains 120u square',t=>{
 assert.deepEqual(C.widgetPresetU(key),{w:120,h:120});for(const size of [[1,1],[120,120],[239,50]])assert.deepEqual(viewOf(make(...size)),withLayoutRevision(make(...size)));
 const dir=mkdtempSync(join(tmpdir(),'keyln-t76-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const store=new ConfigStore(dir),draft=store.get();draft.widgets[0].size=fixed(1,1);draft.widgets[0].pages[0].widgets=[structuredClone(key)];const saved=store.replace(draft,[]);assert.deepEqual(new ConfigStore(dir).get(),saved);assert.deepEqual(importPreview(saved,[],()=>{}).view,withLayoutRevision(saved));
});
test('T76 tiny Pages retain exact outer u geometry beside ordinary components without imposing a visual size floor',()=>{
 const c=make(1,1),items=[c.widgets[0],{...key,id:'outside'}],layout=flowLayout(items,900,'standard',12,14),scale=layout.cell/120,[small,next]=layout.placements;assert.ok(Math.abs(small.width-scale)<1e-9);assert.ok(Math.abs(small.height-scale)<1e-9);assert.ok(next.left>=small.left+small.width);assert.equal(next.width,120*scale);assert.deepEqual(c.widgets[0].size,fixed(1,1));
});
test('T76 1u draft has keyboard recovery and saves all existing content',async t=>{
 const f=await client(t,{configuration:make(),viewport:{width:1368,height:912}});f.el('edit-layout').emit('click');await f.drain();let node=outer(f);node.emit('keydown',event({key:'Enter',target:node}));await f.drain();f.el('pages-width').value='1';f.el('pages-width').emit('input');f.el('pages-height').value='1';f.el('pages-height').emit('input');await f.drain();node=outer(f);assert.equal(node.dataset.tiny,'true');assert.equal(node.dataset.compact,'true');assert.equal(node.tabIndex,0);assert.equal(f.el('pages-width').min,'1');f.el('editor-close').emit('click');await f.drain();node.emit('keydown',event({key:'Enter',target:node}));await f.drain();assert.equal(f.el('editor').hidden,false);assert.equal(f.el('pages-width').value,'1');f.el('desk-save').emit('click');await f.drain();await f.drain();const saved=f.calls.findLast(c=>c.path==='/api/configuration/save').data;assert.deepEqual(saved.widgets[0].size,fixed(1,1));assert.deepEqual(saved.widgets[0].pages[0].widgets,[key]);
});
test('T76 dragging below the old floor keeps capture nodes and remains one Undo',async t=>{
 const f=await client(t,{configuration:make(),viewport:{width:1368,height:912}});f.el('edit-layout').emit('click');await f.drain();responsiveBoxes(f);const node=outer(f),grip=treeFind(node,n=>n.className==='pages-resize-handle'&&n.dataset.axis==='xy'),b=node.getBoundingClientRect(),scale=b.width/120,x=b.left+b.width/2,y=b.top+b.height/2;grip.emit('pointerdown',event({clientX:x,clientY:y,target:grip}));f.documentEvents.get('pointermove')(event({altKey:true,clientX:x-60*scale,clientY:y-60*scale}));await f.drain();assert.equal(outer(f),node);f.documentEvents.get('pointerup')(event({altKey:true,clientX:x-60*scale,clientY:y-60*scale}));await f.drain();let page=outer(f);page.emit('keydown',event({key:'Enter',target:page}));await f.drain();assert.equal(f.el('pages-width').value,'60');assert.equal(f.el('pages-height').value,'60');f.el('edit-undo').emit('click');await f.drain();assert.equal(f.el('pages-width').value,'120');assert.equal(f.el('pages-height').value,'120');assert.equal(f.el('save-message').dataset.dirty,'false');assert.equal(f.count('configuration/save'),0);
});
