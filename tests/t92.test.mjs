import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as C from '../dist/packages/contracts/index.js';
import {client} from './helpers/client-harness.mjs';
import {key} from './helpers/layout.mjs';

// T92 (ADR-085): the settings card of Edit moves by the grip of its header and collapses to the header bar; both last only while the card stays open. The compiled client runs
// against the minimal DOM (the card's box is given by hand): not browser rendering, real touch or Surface evidence.
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const css=read('apps/web/style.css');
const rule=selector=>{const start=css.indexOf(selector+'{');assert.ok(start>=0,selector);return css.slice(start,css.indexOf('}',start)+1);};
const APP={type:'app.open',appId:'test.app'};
const config=()=>C.parseConfig({...C.initialView(),revision:2,widgets:[{id:'main',kind:'pages',pages:[{id:'a',name:'A',widgets:[key('k1',APP),key('k2',APP),key('k3',APP)]}]}]});
async function open(t,{width=1200,height=800}={}){
  const f=await client(t,{configuration:config(),viewport:{width,height},moveMode:'insert'});
  await f.until(()=>f.el('edit-layout').disabled===false&&f.state&&f.sockets[0]?.readyState===1);await f.drain();
  const {el}=f,card=el('editor'),grip=el('editor-grip'),collapse=el('editor-collapse');
  f.el('edit-layout').emit('click');await f.drain();
  const select=async id=>{f.button(id).emit('click',{detail:0});await f.drain();};
  const box=(left=760,top=300,w=420,h=420)=>{card.rect={left,top,width:w,height:h};};
  box();await select('k1');
  const press=(x,y,pointerId=1)=>grip.emit('pointerdown',{button:0,isPrimary:true,pointerId,pointerType:'mouse',clientX:x,clientY:y});
  const move=(x,y,pointerId=1)=>grip.emit('pointermove',{pointerId,clientX:x,clientY:y});
  const release=(pointerId=1)=>grip.emit('pointerup',{pointerId});
  const at=()=>({left:parseFloat(card.style.left),top:parseFloat(card.style.top),width:parseFloat(card.style.width)});
  return {f,card,grip,collapse,select,box,press,move,release,at,el};
}

test('T92 the card header has a grip (44px target) and a collapse button; the card starts in its default place, expanded',async t=>{
  const w=await open(t);assert.equal(w.card.hidden,false);assert.equal(w.card.dataset.moved,undefined);assert.equal(w.card.dataset.collapsed,'false');
  assert.equal(w.collapse.getAttribute('aria-expanded'),'true');assert.equal(w.collapse.getAttribute('aria-label'),'Collapse settings');
  const html=read('apps/web/index.html');
  assert.match(html,/<header class="card-head"><button id="editor-grip" class="edit-grip card-grip"[^>]*aria-label="Move settings card"/);
  assert.match(html,/id="editor-collapse" class="icon-close card-collapse"[^>]*aria-expanded="true" aria-controls="config-form"/);
  assert.match(rule('.card-head .card-grip::before'),/inset:-4px -6px/,'36px + 8px = 44px');assert.match(rule('.card-collapse::before'),/inset:-4px/);
  assert.match(css,/\.card-head \.icon-close,\.theme-dialog-head \.icon-close\{width:var\(--ctl-h\)/,'36px to look at');
  assert.match(rule('.edit-grip'),/touch-action:none/);
});
test('T92 dragging the grip moves the card anywhere inside the window and clamps it at the edges (safe area included)',async t=>{
  const w=await open(t);
  w.press(100,100);w.move(101,100);assert.equal(w.card.dataset.moved,undefined,'under 3px is not a drag');
  w.move(-100,0);assert.equal(w.card.dataset.moved,'true');assert.equal(w.card.dataset.dragging,'true');assert.deepEqual(w.at(),{left:560,top:200,width:420});
  w.move(-9000,-9000);assert.deepEqual([w.at().left,w.at().top],[8,8],'the margin from the top and left edge');
  w.move(9000,9000);assert.deepEqual([w.at().left,w.at().top],[1200-420-8,800-420-8],'and from the bottom and right');
  assert.match(w.card.style['max-height'],/px$/);assert.ok(parseFloat(w.card.style['max-height'])>=120,'the body scrolls inside; the header never leaves the window');
  w.release();assert.equal(w.card.dataset.dragging,undefined);const settled=w.at();w.move(100,100);assert.deepEqual(w.at(),settled,'a released grip does not follow');
  // a second drag starts from where the card is now
  w.press(500,500,2);w.move(450,480,2);w.release(2);assert.deepEqual([w.at().left,w.at().top],[settled.left-50,settled.top-20]);
  // a cancelled press keeps where it got to and is never a tap
  w.press(10,10,3);w.move(30,30,3);const before=w.at();w.grip.emit('pointercancel',{pointerId:3});assert.deepEqual(w.at(),before);assert.equal(w.card.dataset.dragging,undefined);
  // another pointer and the secondary button are not ours
  w.grip.emit('pointerdown',{button:2,isPrimary:true,pointerId:4,clientX:0,clientY:0});w.move(400,400,4);assert.deepEqual(w.at(),before);
});
test('T92 a drag moves nothing else: the card stays open, no component moves or is selected, no draft appears, nothing is saved',async t=>{
  const w=await open(t),{f}=w;
  w.press(100,100);w.move(-200,-200);w.release();
  assert.equal(w.card.hidden,false,'the card stays open');assert.equal(f.el('desk-save').hidden,true,'no change to the draft');assert.equal(f.count('configuration/save'),0);
  assert.equal(f.el('button-grid').dataset.lifted,undefined);assert.equal(f.el('editor-title').textContent,'Key');
});
test('T92 arrow keys move the focused grip 8px (Shift: 32px), Home puts the card back, and so does a double tap',async t=>{
  const w=await open(t),key=(name,extra={})=>w.grip.emit('keydown',{key:name,...extra});
  key('ArrowLeft');assert.deepEqual([w.at().left,w.at().top],[752,300]);key('ArrowUp');assert.deepEqual([w.at().left,w.at().top],[752,292]);
  key('ArrowRight',{shiftKey:true});assert.deepEqual([w.at().left,w.at().top],[772,292],'Shift+Right: 32px, but the window edge (8px margin) stops it at 772');key('ArrowDown',{shiftKey:true});assert.deepEqual([w.at().left,w.at().top],[772,324]);
  let prevented=0;w.grip.emit('keydown',{key:'ArrowLeft',preventDefault(){prevented++;}});assert.equal(prevented,1);w.grip.emit('keydown',{key:'a',preventDefault(){prevented++;}});assert.equal(prevented,1,'other keys are left alone');
  for(let i=0;i<200;i++)key('ArrowLeft',{shiftKey:true});assert.equal(w.at().left,8,'it stops at the margin');
  key('Home');assert.equal(w.card.dataset.moved,undefined);assert.equal(w.card.style.left,undefined);assert.equal(w.card.style.width,undefined,'the default place again');
  w.press(0,0);w.move(-80,-80);w.release();assert.equal(w.card.dataset.moved,'true');
  w.press(0,0);w.release();assert.equal(w.card.dataset.moved,'true','one tap does nothing');w.press(0,0);w.release();assert.equal(w.card.dataset.moved,undefined,'a double tap puts it back');
  w.press(0,0);w.move(-80,-80);w.release();w.press(0,0);w.release();assert.equal(w.card.dataset.moved,'true','a drag between two taps is not a double tap');
});

test('T92 collapse: the body is hidden, not destroyed; field values and the draft stay; aria-expanded and the label flip; focus moves to the button',async t=>{
  const w=await open(t),{f}=w,name=f.el('button-name');
  name.value='Renamed';name.emit('input');await f.drain();assert.equal(f.el('desk-save').hidden,false);const draft=JSON.stringify(f.state.config);
  w.collapse.emit('click');assert.equal(w.card.dataset.collapsed,'true');assert.equal(w.collapse.getAttribute('aria-expanded'),'false');assert.equal(w.collapse.getAttribute('aria-label'),'Expand settings');assert.equal(w.collapse.title,'Expand settings');
  assert.equal(f.focused,'editor-collapse','focus is on the button');assert.equal(name.value,'Renamed','the field keeps its text');assert.equal(f.el('desk-save').hidden,false,'the draft is kept');assert.equal(JSON.stringify(f.state.config),draft);
  assert.equal(w.card.hidden,false,'still open');
  const hide=rule('.settings-card[data-collapsed=true]>:not(.card-head),.settings-card[data-collapsed=true]>#config-form');assert.match(hide,/display:none/);
  w.collapse.emit('click');assert.equal(w.card.dataset.collapsed,'false');assert.equal(w.collapse.getAttribute('aria-expanded'),'true');assert.equal(name.value,'Renamed');
});
test('T92 a collapsed card keeps its place; expanding it near the bottom pulls it back inside the window',async t=>{
  const w=await open(t);
  w.press(0,0);w.move(0,350);w.release();const moved=w.at();assert.equal(moved.top,372,'clamped to the bottom margin');
  w.box(moved.left,moved.top,420,52);w.collapse.emit('click');assert.deepEqual(w.at().top,moved.top,'collapsing keeps the place');
  w.box(moved.left,moved.top,420,420);w.collapse.emit('click');
  assert.equal(w.card.dataset.collapsed,'false');assert.ok(w.at().top+420<=800-8,'expanded, it is whole inside the window');
  const tall=await open(t);tall.press(0,0);tall.move(-100,-100);tall.release();const place=tall.at();tall.collapse.emit('click');tall.collapse.emit('click');assert.deepEqual([tall.at().left,tall.at().top],[place.left,place.top],'room enough: it does not move');
});
test('T92 closing the card forgets the place and the collapse: the next opening is the default place, expanded (by ×, empty canvas, Done)',async t=>{
  const w=await open(t),{f}=w;
  const dirty=async()=>{w.press(0,0);w.move(-150,-50);w.release();w.collapse.emit('click');assert.equal(w.card.dataset.moved,'true');assert.equal(w.card.dataset.collapsed,'true');};
  await dirty();f.el('editor-close').emit('click');await f.drain();assert.equal(w.card.hidden,true);
  w.box();await w.select('k2');assert.equal(w.card.hidden,false);assert.equal(w.card.dataset.moved,undefined,'× then reopen: default place');assert.equal(w.card.dataset.collapsed,'false');assert.equal(w.card.style.left,undefined);
  await dirty();f.el('button-grid').emit('click',{target:f.el('button-grid'),detail:1});await f.drain();assert.equal(w.card.hidden,true,'a tap on empty canvas closes it');
  await w.select('k3');assert.equal(w.card.dataset.moved,undefined);assert.equal(w.card.dataset.collapsed,'false');
  await dirty();f.el('edit-back').emit('click');await f.drain();assert.equal(w.card.hidden,true,'Done');
  f.el('edit-layout').emit('click');await f.drain();w.box();await w.select('k1');assert.equal(w.card.dataset.moved,undefined,'Done and reopen');assert.equal(w.card.dataset.collapsed,'false');
  assert.equal(f.local.size>0?[...f.local.keys()].some(k=>/card/i.test(k)):false,false,'nothing about the card is stored');
});
test('T92 tapping a component while the card is open keeps the card where it is and opens it out',async t=>{
  const w=await open(t);
  w.press(0,0);w.move(-120,-60);w.release();const place=w.at();w.collapse.emit('click');assert.equal(w.card.dataset.collapsed,'true');
  await w.select('k2');assert.equal(w.card.dataset.collapsed,'false','a different component: expanded');assert.deepEqual([w.at().left,w.at().top],[place.left,place.top],'and in the same place');assert.equal(w.el('editor').dataset.moved,'true');
  w.collapse.emit('click');await w.select('k2');assert.equal(w.card.dataset.collapsed,'false','the same component again: expanded too');
  w.collapse.emit('click');w.f.el('edit-undo').emit('click');await w.f.drain();assert.equal(w.card.dataset.collapsed,'true','an unrelated change does not open it out');
});
test('T92 narrow (a bottom sheet): no grip move, nothing positioned, collapse still works',async t=>{
  const w=await open(t,{width:375,height:800});
  w.press(100,100);w.move(10,10);w.release();w.grip.emit('keydown',{key:'ArrowLeft'});assert.equal(w.card.dataset.moved,undefined);assert.equal(w.card.style.left,undefined);assert.equal(w.card.style.width,undefined);
  w.collapse.emit('click');assert.equal(w.card.dataset.collapsed,'true');assert.equal(w.collapse.getAttribute('aria-expanded'),'false');w.collapse.emit('click');assert.equal(w.card.dataset.collapsed,'false');
  assert.match(css,/@media\(max-width:600px\)\{\.card-head \.card-grip\{display:none\}\}/);
  assert.match(css,/@media\(min-width:601px\)\{\.edit-float\[data-card-side\]>\.settings-card\[data-moved=true\]\{position:fixed;right:auto;bottom:auto\}\}/,'the free place is only for wide windows');
  // A card moved on a wide window becomes the bottom sheet when the window narrows.
  const v=await open(t);v.press(0,0);v.move(-50,-50);v.release();assert.equal(v.card.dataset.moved,'true');
  globalThis.window.innerWidth=500;v.f.windowEvents.get('resize')();await v.f.drain();assert.equal(v.card.dataset.moved,undefined);assert.equal(v.card.style.width,undefined);
  globalThis.window.innerWidth=1200;v.f.windowEvents.get('resize')();await v.f.drain();assert.equal(v.card.dataset.moved,'true','the place is remembered while the card is open');
});
test('T92 layers and motion: the gear menu still draws above the card; the card is not animated; theme tokens only',()=>{
  assert.match(css,/\.system-layer:has\(>details\.connection-settings\[open\]\)\{z-index:70\}/);assert.match(rule('.edit-float'),/z-index:60/);
  const block=css.slice(css.indexOf('/* T92 (ADR-085)'),css.indexOf('.menu-item[data-danger'));
  assert.doesNotMatch(block,/transition|animation/,'no animation on collapse or move');assert.doesNotMatch(block,/#[0-9a-fA-F]{3,8}\b/,'tokens only');
  assert.match(css,/\.edit-toolbar\{position:fixed;[^}]*z-index:62/,'the Edit toolbar still floats above');
});
test('T92 the host serves the new module',()=>{
  assert.match(read('apps/host/server.ts'),/\["\/apps\/web\/card-move\.js", \["\.\.\/\.\.\/apps\/web\/card-move\.js"/);
});

test('the collapsed card hides the form even against the id rule that shows it', () => {
  const css = readFileSync(new URL('../apps/web/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.settings-card #config-form\{display:flex/);
  assert.match(css, /\.settings-card\[data-collapsed=true\]>#config-form\{display:none\}|\.settings-card\[data-collapsed=true\]>#config-form[,{][^}]*display:none/);
});
