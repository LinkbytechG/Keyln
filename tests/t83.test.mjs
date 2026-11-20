import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {clampBar,nudgeBar,loadBarState,saveBarState,pointerGesture,isDoubleTap,BAR_KEY,DOCKED,BAR_MARGIN} from '../dist/apps/web/edit-bar.js';
import {client} from './helpers/client-harness.mjs';

// T83 (ADR-078): the Edit toolbar floats, moves by its grip, collapses to an icon and remembers its place on this device. The pure rules are tested directly;
// the compiled client runs against the minimal DOM of the harness (no browser rendering, no real touch, no Surface evidence).
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const html=read('apps/web/index.html'),css=read('apps/web/style.css'),app=read('apps/web/app.ts');
const rule=selector=>{const at=css.indexOf(selector+'{');assert.ok(at>=0,`${selector} is defined`);return css.slice(at,css.indexOf('}',at)+1);};
const VIEW={width:1366,height:768};

// ---- pure rules -----------------------------------------------------------------------------------------------------------------------------
test('clampBar keeps the whole bar 8px inside every edge, plus the safe area',()=>{
  const size={width:480,height:50};
  assert.deepEqual(clampBar({right:12,bottom:12},size,VIEW),{right:12,bottom:12},'a place inside stays');
  assert.deepEqual(clampBar({right:-300,bottom:-5},size,VIEW),{right:BAR_MARGIN,bottom:BAR_MARGIN},'past the right and bottom edge');
  assert.deepEqual(clampBar({right:5000,bottom:5000},size,VIEW),{right:VIEW.width-480-8,bottom:VIEW.height-50-8},'past the left and top edge');
  assert.deepEqual(clampBar({right:0,bottom:0},size,VIEW,{top:20,right:10,bottom:34,left:6}),{right:18,bottom:42},'the safe area adds to the margin');
  assert.deepEqual(clampBar({right:5000,bottom:5000},size,VIEW,{top:20,right:10,bottom:34,left:6}),{right:VIEW.width-480-8-6,bottom:VIEW.height-50-8-20});
  assert.deepEqual(clampBar({right:100,bottom:100},{width:900,height:50},{width:600,height:400}),{right:8,bottom:100},'a window too small for the bar pins its right edge');
  assert.equal(BAR_MARGIN,8);
});
test('nudgeBar moves the way the arrow points: 8px, or 32px with Shift',()=>{
  const at={right:100,bottom:100};
  assert.deepEqual(nudgeBar(at,'ArrowLeft'),{right:108,bottom:100});assert.deepEqual(nudgeBar(at,'ArrowRight'),{right:92,bottom:100});
  assert.deepEqual(nudgeBar(at,'ArrowUp'),{right:100,bottom:108});assert.deepEqual(nudgeBar(at,'ArrowDown'),{right:100,bottom:92});
  assert.deepEqual(nudgeBar(at,'ArrowLeft',true),{right:132,bottom:100});assert.deepEqual(nudgeBar(at,'ArrowDown',true),{right:100,bottom:68});
  assert.equal(nudgeBar(at,'Enter'),undefined);assert.equal(nudgeBar(at,'a'),undefined);
});
const memory=()=>{const map=new Map();return {map,getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,String(value))};};
test('the saved place round-trips, and anything missing, damaged or unreadable gives the docked, expanded bar',()=>{
  assert.deepEqual(loadBarState(undefined),DOCKED);assert.deepEqual(loadBarState(memory()),DOCKED,'empty storage');
  const store=memory();
  assert.equal(saveBarState(store,{right:340,bottom:60,docked:false,collapsed:true}),true);
  assert.deepEqual(JSON.parse(store.map.get(BAR_KEY)),{right:340,bottom:60,docked:false,collapsed:true});
  assert.deepEqual(loadBarState(store),{right:340,bottom:60,docked:false,collapsed:true});
  assert.equal(saveBarState(store,{...DOCKED}),true);assert.deepEqual(loadBarState(store),DOCKED,'docked again');
  const throwing={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}};
  assert.deepEqual(loadBarState(throwing),DOCKED);assert.equal(saveBarState(throwing,{...DOCKED}),false,'a blocked write does not throw');assert.equal(saveBarState(undefined,{...DOCKED}),false);
  for(const raw of ['{','null','[]','"x"','{"docked":false}','{"docked":false,"right":"3","bottom":4}','{"docked":false,"right":null,"bottom":4}'])assert.deepEqual(loadBarState({getItem:()=>raw}),DOCKED,raw);
  assert.deepEqual(loadBarState({getItem:()=>'{"docked":false,"right":1e999,"bottom":4,"collapsed":true}'}),{...DOCKED,collapsed:true},'a non-finite place falls back to docked but keeps the collapsed choice');
  assert.deepEqual(loadBarState({getItem:()=>'{"docked":true,"right":50,"bottom":50,"collapsed":true}'}),{...DOCKED,collapsed:true},'docked ignores any stored place');
});
test('a press that stays inside the threshold is a tap; once past it, it is a drag for good',()=>{
  const tap=pointerGesture(6);tap.start(100,100);assert.equal(tap.move(103,102),undefined);assert.equal(tap.move(100,106),undefined,'exactly on the threshold is still a tap');assert.equal(tap.end(),'tap');
  const drag=pointerGesture(6);drag.start(100,100);assert.deepEqual(drag.move(100,107),{dx:0,dy:7});assert.deepEqual(drag.move(100,100),{dx:0,dy:0},'back at the start it is still a drag');assert.equal(drag.end(),'drag');
  assert.equal(drag.end(),undefined,'ended');assert.equal(drag.move(5,5),undefined);
  const gone=pointerGesture(6);gone.start(0,0);gone.move(50,50);gone.cancel();assert.equal(gone.active,false);assert.equal(gone.end(),undefined);
  gone.start(0,0);assert.equal(gone.end(),'tap','a new press starts clean');
});
test('two taps within 350ms are a double tap',()=>{
  assert.equal(isDoubleTap(1000,1200),true);assert.equal(isDoubleTap(1000,1350),true);assert.equal(isDoubleTap(1000,1351),false);assert.equal(isDoubleTap(0,100),false,'no earlier tap');
});

// ---- the compiled client ---------------------------------------------------------------------------------------------------------------------
async function world(t,{localSeed,width=1366,height=768}={}){
  const f=await client(t,{viewport:{width,height},localSeed});
  await f.until(()=>f.el('edit-layout').disabled===false&&f.state&&f.sockets[0]?.readyState===1);await f.drain();
  const el=f.el,bar=el('edit-toolbar'),saved=()=>JSON.parse(f.local.get(BAR_KEY)??'null');
  const press=(node,x,y,id=1)=>node.emit('pointerdown',{button:0,isPrimary:true,pointerId:id,clientX:x,clientY:y});
  const moveTo=(node,x,y,id=1)=>node.emit('pointermove',{pointerId:id,clientX:x,clientY:y});
  const lift=(node,x,y,id=1)=>node.emit('pointerup',{pointerId:id,clientX:x,clientY:y});
  // The page measures the bar through getBoundingClientRect; the harness has no layout, so a test says where it is (right/bottom edge distances).
  const place=(right,bottom,w=480,h=50)=>{bar.rect={left:width-right-w,top:height-bottom-h,width:w,height:h};};
  const enter=async()=>{el('edit-layout').emit('click');await f.drain();};
  return {f,el,bar,saved,press,moveTo,lift,place,enter,width,height};
}
test('Use mode hides the bar; Edit shows it docked and expanded, in the order of the sketch',async t=>{
  const w=await world(t),{el,bar}=w;
  assert.equal(bar.hidden,true);assert.equal(el('edit-float').hidden,true);
  await w.enter();assert.equal(bar.hidden,false);assert.equal(bar.dataset.docked,'true');assert.equal(bar.dataset.collapsed,'false');
  assert.equal(el('edit-float-row').hidden,false);assert.equal(el('edit-chip').hidden,true);assert.equal(el('edit-collapse').getAttribute('aria-expanded'),'true');
  assert.equal(bar.style.right,undefined,'docked: the stylesheet places it');
  assert.equal(el('desk-save').hidden,true,'no Save without changes');
  el('edit-back').emit('click');await w.f.drain();assert.equal(bar.hidden,true);
});
test('collapse leaves a 44px icon; tapping it expands; neither touches the draft, the Library or the saved layout',async t=>{
  const w=await world(t),{f,el,bar}=w;await w.enter();
  el('shelf-toggle').emit('click');await f.drain();assert.equal(el('shelf-toggle').getAttribute('aria-pressed'),'true');
  el('grid-size').value='large';el('grid-size').emit('change');await f.drain();assert.equal(el('desk-save').hidden,false);
  el('edit-collapse').emit('click');await f.drain();
  assert.equal(bar.dataset.collapsed,'true');assert.equal(el('edit-float-row').hidden,true);assert.equal(el('edit-chip').hidden,false);assert.equal(el('edit-chip').getAttribute('aria-expanded'),'false');
  assert.equal(el('edit-chip').dataset.dirty,'true','the unsaved dot is on the icon');assert.match(el('edit-chip').getAttribute('aria-label'),/^Show Edit toolbar/);
  assert.equal(el('shelf-toggle').getAttribute('aria-pressed'),'true','the Library stays open');assert.equal(el('grid-size').value,'large','the draft is kept');assert.equal(el('desk-save').hidden,false);
  assert.equal(w.saved().collapsed,true);
  el('edit-chip').emit('click');await f.drain();
  assert.equal(bar.dataset.collapsed,'false');assert.equal(el('edit-float-row').hidden,false);assert.equal(el('edit-chip').hidden,true);assert.equal(w.saved().collapsed,false);
  assert.equal(f.count('configuration/save'),0);assert.equal(f.count('execute'),0);
});
test('the unsaved dot follows the draft; Undo to a clean draft clears it',async t=>{
  const w=await world(t),{f,el}=w;await w.enter();
  assert.equal(el('edit-chip').dataset.dirty,'false');assert.equal(el('edit-chip').getAttribute('aria-label'),'Show Edit toolbar');
  el('grid-size').value='large';el('grid-size').emit('change');await f.drain();assert.equal(el('edit-chip').dataset.dirty,'true');assert.equal(el('edit-chip').getAttribute('aria-label'),'Show Edit toolbar, unsaved changes');
  el('edit-undo').emit('click');await f.drain();assert.equal(el('edit-chip').dataset.dirty,'false');
});
test('the icon: a tap expands, a drag beyond 6px moves it and does not expand; the grip drags at once',async t=>{
  const w=await world(t),{f,el,bar}=w;await w.enter();el('edit-collapse').emit('click');await f.drain();
  const chip=el('edit-chip');w.place(12,12,44,44);
  // a tap: down, a little shake, up, then the click the browser sends
  w.press(chip,1320,730);w.moveTo(chip,1323,732);w.lift(chip,1323,732);chip.emit('click');await f.drain();
  assert.equal(bar.dataset.collapsed,'false','a tap expands');assert.equal(bar.dataset.docked,'true','and does not move it');
  el('edit-collapse').emit('click');await f.drain();w.place(12,12,44,44);
  // a drag: 40px up and left
  w.press(chip,1320,730);w.moveTo(chip,1300,710);w.moveTo(chip,1280,690);assert.equal(bar.dataset.dragging,'true');
  w.lift(chip,1280,690);chip.emit('click');await f.drain();
  assert.equal(bar.dataset.collapsed,'true','the click that ends a drag does not expand');assert.equal(bar.dataset.docked,'false');
  assert.equal(bar.style.right,'52px');assert.equal(bar.style.bottom,'52px');assert.equal(bar.dataset.dragging,undefined);
  assert.deepEqual(w.saved(),{right:52,bottom:52,docked:false,collapsed:true});
  w.place(52,52,44,44);chip.emit('click');await f.drain();assert.equal(bar.dataset.collapsed,'false','the next plain click expands');
  // the grip: moves as soon as it passes 3px, and never expands or collapses anything
  const grip=el('edit-grip');w.place(52,52);
  w.press(grip,500,700);w.moveTo(grip,502,700);assert.equal(bar.dataset.dragging,undefined,'2px is a tap');w.moveTo(grip,520,690);
  w.lift(grip,520,690);await f.drain();
  assert.equal(bar.style.right,String(52-20)+'px');assert.equal(bar.style.bottom,String(52+10)+'px');assert.equal(bar.dataset.collapsed,'false');
  assert.equal(f.count('configuration/save'),0);
});
test('a drag cannot leave the window, and a second pointer or a right button does not start one',async t=>{
  const w=await world(t),{el,bar}=w;await w.enter();const grip=el('edit-grip');w.place(12,12);
  w.press(grip,1300,740);w.moveTo(grip,5000,5000);w.lift(grip,5000,5000);
  assert.equal(bar.style.right,'8px');assert.equal(bar.style.bottom,'8px','pinned 8px from the right and bottom edge');
  w.place(8,8);w.press(grip,1300,740);w.moveTo(grip,-5000,-5000);w.lift(grip,-5000,-5000);
  assert.equal(bar.style.right,String(1366-480-8)+'px');assert.equal(bar.style.bottom,String(768-50-8)+'px','pinned 8px from the left and top edge');
  w.place(100,100);grip.emit('pointerdown',{button:2,isPrimary:true,pointerId:1,clientX:1,clientY:1});w.moveTo(grip,200,200);assert.equal(bar.style.bottom,String(768-50-8)+'px','a right-button press moves nothing');
  grip.emit('pointerdown',{button:0,isPrimary:false,pointerId:2,clientX:1,clientY:1});w.moveTo(grip,200,200,2);assert.equal(bar.style.bottom,String(768-50-8)+'px','a second finger moves nothing');
});
test('arrow keys on the grip move the bar 8px (Shift 32px); Home, and a double tap, dock it again',async t=>{
  const w=await world(t),{el,bar}=w;await w.enter();const grip=el('edit-grip');
  w.place(12,12);
  let prevented=0;const key=(name,shiftKey=false)=>grip.emit('keydown',{key:name,shiftKey,preventDefault(){prevented++;}});
  key('ArrowLeft');assert.equal(bar.style.right,'20px');assert.equal(bar.style.bottom,'12px');assert.equal(bar.dataset.docked,'false');
  w.place(20,12);key('ArrowUp',true);assert.equal(bar.style.bottom,'44px');assert.equal(bar.style.right,'20px');
  w.place(20,44);key('ArrowRight');assert.equal(bar.style.right,'12px');
  w.place(8,44);key('ArrowRight');assert.equal(bar.style.right,'8px','the keyboard cannot push it out of the window either');
  assert.equal(prevented,4);key('Tab');assert.equal(prevented,4,'other keys are left alone');
  assert.deepEqual(w.saved(),{right:8,bottom:44,docked:false,collapsed:false});
  key('Home');assert.equal(bar.dataset.docked,'true');assert.equal(bar.style.right,undefined);assert.equal(bar.style.bottom,undefined);assert.deepEqual(w.saved(),{...DOCKED});
  w.place(12,12);key('ArrowLeft');assert.equal(bar.dataset.docked,'false');
  // double tap on the grip
  w.place(20,12);w.press(grip,500,700);w.lift(grip,500,700);assert.equal(bar.dataset.docked,'false','one tap does not');
  w.press(grip,500,700);w.lift(grip,500,700);assert.equal(bar.dataset.docked,'true','two quick taps dock it');assert.equal(bar.style.right,undefined);
});
test('the place is remembered per device: restored, shown clamped when the window is small, and kept for a larger window',async t=>{
  const seed=JSON.stringify({right:1300,bottom:20,docked:false,collapsed:false});
  const w=await world(t,{localSeed:{[BAR_KEY]:seed}}),{f,el,bar}=w;
  w.place(1300,20);await w.enter();
  assert.equal(bar.dataset.docked,'false');assert.equal(bar.style.right,String(1366-480-8)+'px','a window that cannot hold the saved place shows it clamped');
  assert.equal(bar.style.bottom,'20px');
  window.innerWidth=2000;f.windowEvents.get('resize')();await f.drain();
  assert.equal(bar.style.right,'1300px','the saved place returns when the window is large again');
  window.innerWidth=1366;f.windowEvents.get('resize')();await f.drain();assert.equal(bar.style.right,String(1366-480-8)+'px','and is clamped again when it shrinks');
  assert.equal(el('edit-chip').hidden,true);
});
test('a collapsed choice is restored; damaged or blocked storage gives the docked bar; nothing reaches the Mac',async t=>{
  const a=await world(t,{localSeed:{[BAR_KEY]:JSON.stringify({right:12,bottom:12,docked:true,collapsed:true})}});await a.enter();
  assert.equal(a.bar.dataset.collapsed,'true');assert.equal(a.el('edit-chip').hidden,false);assert.equal(a.el('edit-float-row').hidden,true);
  const b=await world(t,{localSeed:{[BAR_KEY]:'{not json'}});await b.enter();assert.equal(b.bar.dataset.docked,'true');assert.equal(b.bar.dataset.collapsed,'false');
  // blocked storage: reading and writing both throw, the bar still works
  const f=await client(t,{viewport:{width:1366,height:768}});
  await f.until(()=>f.el('edit-layout').disabled===false&&f.state&&f.sockets[0]?.readyState===1);await f.drain();
  globalThis.localStorage.setItem=()=>{throw new Error('blocked');};globalThis.localStorage.getItem=()=>{throw new Error('blocked');};
  f.el('edit-layout').emit('click');await f.drain();f.el('edit-collapse').emit('click');await f.drain();
  assert.equal(f.el('edit-toolbar').dataset.collapsed,'true','collapsing works without storage');f.el('edit-chip').emit('click');await f.drain();assert.equal(f.el('edit-toolbar').dataset.collapsed,'false');
  for(const call of [...a.f.calls,...f.calls])assert.doesNotMatch(call.path,/edit-?bar|toolbar/i,'no request mentions the toolbar');
  assert.equal(a.f.count('configuration/save'),0);
});

// ---- markup and stylesheet -------------------------------------------------------------------------------------------------------------------
test('markup: one toolbar row in the order of the sketch, the grid size shows its value only, and the card column no longer holds the buttons',()=>{
  const bar=html.slice(html.indexOf('<div id="edit-toolbar"'),html.indexOf('<section id="shelf-panel"'));
  assert.match(bar,/^<div id="edit-toolbar" class="edit-toolbar" data-docked="true" data-collapsed="false" hidden>/);
  assert.match(bar,/<div id="edit-float-row" class="edit-float-row" role="toolbar" aria-label="Edit mode controls">/);
  const ids=[...bar.matchAll(/<(?:button|select) id="([^"]+)"/g)].map(match=>match[1]);
  assert.deepEqual(ids,['edit-grip','edit-settings','shelf-toggle','edit-back','edit-undo','desk-save','grid-size','edit-collapse','edit-chip']);
  assert.match(bar,/id="edit-grip"[^>]*aria-label="Move toolbar"/);
  assert.match(bar,/id="shelf-toggle"[^>]*aria-label="Component library" aria-pressed="false" aria-controls="shelf-panel"><span class="ui-icon" data-ui-icon="plus" aria-hidden="true"><\/span><\/button>/,'the plus is only an icon');
  assert.doesNotMatch(bar,/>Library</);assert.match(bar,/id="edit-back"[^>]*>[^]*?<span class="edit-float-label">Done<\/span>/);assert.match(bar,/id="edit-undo"[^>]*>[^]*?<span class="edit-float-label">Undo<\/span>/);
  assert.match(bar,/id="edit-collapse"[^>]*aria-label="Collapse toolbar" aria-expanded="true"/);
  assert.match(bar,/id="edit-chip"[^>]*aria-label="Show Edit toolbar" aria-expanded="false"[^>]*hidden><span class="ui-icon" data-ui-icon="pencil"[^>]*><\/span><span class="unsaved-dot" aria-hidden="true"><\/span><\/button>/);
  assert.match(bar,/<span id="grid-size-scope" class="sr-only">All screens · all pages<\/span>/,'the scope is kept for assistive technology');
  assert.match(bar,/<select id="grid-size"[^>]*aria-describedby="grid-size-scope" aria-label="Grid size — shared by the canvas and all pages on every device" title="Grid size/);
  assert.doesNotMatch(bar,/<label|<small|edit-save-slot|grid-size-row/,'no visible label or second line');
  assert.match(bar,/<option value="compact">Compact<\/option><option value="standard">Standard<\/option><option value="large">Large<\/option>/);
  // the column keeps the card, the notices, the save message and the question
  const column=html.slice(html.indexOf('<div id="edit-float"'),html.indexOf('<div id="edit-toolbar"'));
  for(const id of ['editor','save-message','confirm-slot','reload-layout'])assert.match(column,new RegExp(`id="${id}"`),id);
  for(const id of ['edit-float-row','shelf-toggle','edit-back','edit-undo','desk-save','grid-size'])assert.doesNotMatch(column,new RegExp(`id="${id}"`),id);
  for(const name of ['undo','save','chevron-right','check','pencil','settings','plus'])assert.match(read('apps/web/icon-paths.ts'),new RegExp(`"${name}":\\{"viewBox"`),`${name} icon exists`);
  assert.match(read('apps/host/server.ts'),/\["\/apps\/web\/edit-bar\.js", \["\.\.\/\.\.\/apps\/web\/edit-bar\.js"/,'the host serves the module');
});
test('style: z-order, sizes, grip and icon, docked place, card offset',()=>{
  const z=name=>Number(new RegExp(`${name}\\{[^}]*z-index:(\\d+)`).exec(css)[1]);
  assert.equal(z('\\.edit-toolbar'),62);
  assert.ok(z('\\.shelf-panel')<z('\\.edit-toolbar')&&z('\\.edit-float')<z('\\.edit-toolbar'),'above the library and the card');
  assert.ok(z('\\.edit-toolbar')<z('\\.edit-menu')&&z('\\.edit-toolbar')<z('\\.edit-float \\.confirm-slot'),'below the quick menu and the save question');
  assert.match(css,/\.system-layer:has\(>details\.connection-settings\[open\]\)\{z-index:70\}/);assert.ok(z('\\.edit-toolbar')<70,'below the raised gear layer');
  // docked: 12px from the right and bottom, above the open Library; moved: edit-bar.ts writes right/bottom
  assert.match(rule('.edit-toolbar'),/position:fixed;right:calc\(12px \+ env\(safe-area-inset-right\)\);bottom:calc\(12px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css,/\.shell\[data-shelf=true\] \.edit-toolbar\[data-docked=true\]\{bottom:calc\(12px \+ var\(--shelf-grab\) \+ var\(--shelf-h\) \+ env\(safe-area-inset-bottom\)\)\}/);
  assert.match(rule('.edit-float-row'),/display:flex;align-items:center;gap:6px;/);assert.match(rule('.edit-float-row'),/padding:6px;/);
  assert.match(rule('.edit-float-row'),/border:1px solid var\(--line\);border-radius:var\(--radius-panel\);background:color-mix\(in srgb,var\(--surface\) 92%,transparent\)/);
  assert.match(rule('.edit-float-button'),/min-height:var\(--ctl-h\)/);
  assert.match(css,/\.edit-float-row \.edit-grid-size\{[^}]*width:100px;[^}]*min-height:var\(--ctl-h\);[^}]*padding:0 4px 0 10px/);
  // the grip and the icon are the only things that take a touch away from scrolling; buttons stay buttons
  assert.match(rule('.edit-grip'),/touch-action:none/);assert.match(rule('.edit-grip'),/height:var\(--ctl-h\)/);assert.match(rule('.edit-grip'),/cursor:grab/);
  assert.match(css,/\.edit-grip::before\{content:"";position:absolute;inset:0 -6px\}/,'a 36px wide hit area for a 24px grip');
  assert.match(rule('.edit-chip'),/width:44px;height:44px/);assert.match(rule('.edit-chip'),/border-radius:50%/);assert.match(rule('.edit-chip'),/touch-action:none/);
  assert.match(rule('.edit-chip .unsaved-dot'),/width:8px;height:8px;background:var\(--accent\)/);assert.match(rule('.edit-chip .ui-icon'),/width:18px;height:18px/);
  assert.doesNotMatch(rule('.edit-float-button'),/touch-action:none/);
  // the card keeps its own place with room for the docked bar (12 + bar + 8), and the Library lifts both
  assert.match(css,/\.shell\{--shelf-h:244px;--edit-toolbar-h:50px\}/);
  assert.match(css,/\.edit-float\{--float-bottom:calc\(12px \+ var\(--edit-toolbar-h\) \+ 8px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css,/\.edit-float\[data-card-side=left\]>\.settings-card\{position:fixed;[^}]*bottom:var\(--float-bottom\)/,'the left-side card still uses the same offset');
  // no literal colors, no new !important, no animation in the T83 rules
  const end='.edit-chip[data-dirty=true] .unsaved-dot{display:block}',block=css.slice(css.indexOf('/* T83 (ADR-078)'),css.indexOf(end)+end.length)+css.slice(css.indexOf('/* Narrow windows keep the bar in one row'),css.indexOf('/* Keep at least two touch rows'));
  assert.ok(block.length>1500);assert.doesNotMatch(block,/#[0-9a-fA-F]{3,8}\b|\brgba?\(|!important|animation|transition/);
});
test('narrow windows: the bar still fits one row at 375px with Save showing (the arithmetic of the stylesheet)',()=>{
  const num=(source,pattern)=>Number(pattern.exec(source)[1]);
  const m520=css.slice(css.indexOf('@media(max-width:520px){\n  .edit-float-row'),css.indexOf('@media(max-width:420px)'));
  const m420=css.slice(css.indexOf('@media(max-width:420px){\n  .edit-float-row'),css.indexOf('/* Keep at least two touch rows'));
  assert.match(m520,/:is\(#edit-undo,#desk-save\) \.edit-narrow-icon\{display:inline-flex\}/);assert.match(m420,/#edit-back \.edit-narrow-icon\{display:inline-flex\}/);
  const ctl=36,grip=num(m520,/\.edit-grip\{width:(\d+)px\}/),select=num(m520,/\.edit-grid-size\{width:(\d+)px/),gap=num(m520,/gap:(\d+)px;padding:\d+px/),pad=num(m420,/padding:(\d+)px\}/);
  assert.deepEqual([grip,select,gap,pad],[20,84,4,3]);
  // grip + Settings, Library, Done, Undo, Save and Collapse at 36px + the select + 7 gaps + both paddings and borders
  const row=grip+6*ctl+select+7*gap+2*pad+2;
  assert.equal(row,356);assert.ok(row<=375-2*BAR_MARGIN,'inside the 359px a 375px window leaves');
  // from 421px to 520px Done keeps its text (about 46px instead of 36px) with 4px padding: still inside
  const mid=grip+5*ctl+46+select+7*gap+2*4+2;assert.equal(mid,368);assert.ok(mid<=421-2*BAR_MARGIN);
  // above 520px nothing changes: the whole row with text (Done about 58px, Undo 57, Save 54, the 100px select) is about 457px, so it fits from about 473px
  const wide=24+2*ctl+58+57+54+100+ctl+7*6+2*6+2;assert.equal(wide,457);assert.ok(wide<=521-2*BAR_MARGIN);
  assert.match(rule('.edit-float-row'),/max-width:100%;[^}]*overflow-x:auto/,'a window narrower than all this scrolls the row instead of clipping it');
});
test('the canvas reserves nothing for the toolbar; only the open Library is measured',()=>{
  assert.doesNotMatch(app,/EDIT_RESERVE|el\("edit-float-row"\)\.getBoundingClientRect/);assert.match(app,/if \(!editor\.active \|\| !library\.open\) return 0;/);
  assert.match(app,/observeEdit\.observe\(el\("shelf-panel"\)\);/);assert.match(app,/controlDesk\.refit\(\); editBar\.refit\(\);/,'one resize path serves the canvas and the bar');
});
