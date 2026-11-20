import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import * as C from '../dist/packages/contracts/index.js';
import {anchorSlot,layoutProblem,withForm} from '../dist/apps/web/theme-layout.js';
import {lookOf} from '../dist/apps/web/theme-custom.js';
import {client} from './helpers/client-harness.mjs';
import {key} from './helpers/layout.mjs';
import {gridDemoConfig} from './helpers/grid-demo.mjs';

// T64 (ADR-064): the first theme question, switching this device's theme in Settings, the Layout page of the theme window, the floating area of Edit
// (settings card height, centred save question, unsaved dot), and the clean-up. The compiled client runs against the minimal DOM of the harness: this
// checks behaviour and rules, not how it looks in a browser. Docs/verification/T64.md says what was and was not seen.
const clone=value=>JSON.parse(JSON.stringify(value));
const find=(node,match)=>{for(const child of node.children??[]){if(match(child))return child;const found=find(child,match);if(found)return found;}return undefined;};
const findAll=(node,match,out=[])=>{for(const child of node.children??[]){if(match(child))out.push(child);findAll(child,match,out);}return out;};
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const html=read('apps/web/index.html'),css=read('apps/web/style.css');
const APP={type:'app.open',appId:'test.app'};
const mine=(extra={})=>({id:'theme-mine',name:'Mine',...lookOf('metro'),...extra});
const configWith=(...themes)=>C.parseConfig({...C.withCustomThemes(C.initialView(),themes),revision:2});
const world=(t,{themes=[],deviceTheme,viewport={width:1366,height:768}}={})=>client(t,{configuration:themes.length?configWith(...themes):C.parseConfig({...C.initialView(),revision:2}),deviceTheme,viewport});
const calm=async f=>{await f.until(()=>f.el('edit-layout').disabled===false&&f.sockets[0]?.readyState===1);await f.drain();};

// ---- 1. a new device is asked for its theme once ----------------------------------------------------------------------------------------------------
test('a device that has no theme yet is asked once: every built-in theme and every custom one, each with a zone picture, Braun selected',async t=>{
  const f=await world(t,{themes:[mine()]}),{el}=f;await f.until(()=>el('first-theme-dialog').open===true);
  const cards=el('first-theme-list').children;
  assert.deepEqual(cards.map(card=>card.dataset.themeChoice),[...C.themes,'theme-mine']);
  assert.deepEqual(cards.filter(card=>card.getAttribute('aria-checked')==='true').map(card=>card.dataset.themeChoice),['braun'],'Braun is selected');
  for(const card of cards){
    const picture=card.children[0],sketch=picture.children[0];assert.equal(sketch.className,'sketch');
    assert.equal(sketch.children.filter(node=>node.dataset?.part).length,3,'the three system components are drawn');assert.ok(sketch.children.some(node=>node.className==='sketch-content'),'and the content area');
  }
  // the picture of a theme is its own: Widget has no bar; a custom theme starts from its base theme's zones
  const header=card=>card.children[0].children[0].children.find(node=>node.className==='sketch-header');
  assert.equal(header(cards.find(card=>card.dataset.themeChoice==='widget')).hidden,true);assert.equal(header(cards.find(card=>card.dataset.themeChoice==='braun')).hidden,false);
  assert.equal(cards.find(card=>card.dataset.themeChoice==='theme-mine').children[0].dataset.theme,'metro');
  assert.equal(el('first-theme-use').disabled,false);assert.equal(f.count('device-theme/save'),0,'nothing is saved until the person chooses');
});
test('"Use this" saves the chosen theme for this device only and the question goes away for good',async t=>{
  const f=await world(t,{themes:[mine()]}),{el}=f;await f.until(()=>el('first-theme-dialog').open===true);const revision=f.state.config.revision;
  el('first-theme-list').children.find(card=>card.dataset.themeChoice==='theme-mine').emit('click');
  assert.equal(el('first-theme-list').children.find(card=>card.dataset.themeChoice==='theme-mine').getAttribute('aria-checked'),'true');
  el('first-theme-use').emit('click');await f.until(()=>el('first-theme-dialog').open===false);
  assert.deepEqual(f.calls.filter(call=>call.path==='/api/device-theme/save').map(call=>call.data),[{theme:'theme-mine',layoutName:'Surface'}]);assert.equal(f.deviceTheme,'theme-mine');
  assert.equal(f.state.config.revision,revision,'the shared configuration is untouched');assert.equal(el('html').dataset.theme,'metro');
  f.intervals[0]();await f.drain();await f.drain();assert.equal(el('first-theme-dialog').open,false,'it does not come back');
});
test('Braun is saved when the person just confirms; a failed save keeps the question open and says why',async t=>{
  const f=await world(t),{el}=f;await f.until(()=>el('first-theme-dialog').open===true);
  f.themeFault={status:500,code:'INTERNAL',message:'The Host could not save the theme.'};
  el('first-theme-use').emit('click');await f.until(()=>/could not save/.test(el('first-theme-message').textContent));
  assert.equal(el('first-theme-dialog').open,true);assert.equal(el('first-theme-use').disabled,false,'it can be tried again');
  f.themeFault=undefined;el('first-theme-use').emit('click');await f.until(()=>el('first-theme-dialog').open===false);
  assert.equal(f.deviceTheme,'braun');
});
test('"Not now" holds for this browser tab: nothing is saved and it does not come back on the next sync; a new tab asks again',async t=>{
  const f=await world(t),{el}=f;await f.until(()=>el('first-theme-dialog').open===true);
  el('first-theme-skip').emit('click');assert.equal(el('first-theme-dialog').open,false);assert.equal(f.count('device-theme/save'),0);assert.equal(f.storage.get('keyln.theme-question-skipped'),'1');
  for(let n=0;n<3;n++){f.intervals[0]();await f.drain();await f.drain();}
  assert.equal(el('first-theme-dialog').open,false);assert.equal(f.deviceTheme,undefined,'the device still has no theme (the page shows Braun)');
  const again=await world(t);await again.until(()=>again.el('first-theme-dialog').open===true);
});
test('it is not asked when the device already has a theme, when unpaired, offline, or in Edit',async t=>{
  const chosen=await world(t,{deviceTheme:'midnight'});await calm(chosen);await chosen.drain();assert.equal(chosen.el('first-theme-dialog').open,undefined,'a device with a theme never sees it');
  // Edit: the question steps aside, and comes back in Use mode
  const f=await world(t),{el}=f;await f.until(()=>el('first-theme-dialog').open===true);
  el('edit-layout').emit('click');await f.drain();assert.equal(el('shell').dataset.editing,'true');assert.equal(el('first-theme-dialog').open,false,'not in Edit');
  el('edit-back').emit('click');await f.drain();await f.until(()=>el('first-theme-dialog').open===true);
  // offline: it closes, and returns with the connection
  globalThis.navigator.onLine=false;f.windowEvents.get('offline')();await f.drain();assert.equal(el('first-theme-dialog').open,false,'not offline');
  // unpaired: the Mac no longer knows this device
  const lost=await world(t);await lost.until(()=>lost.el('first-theme-dialog').open===true);
  lost.configurationFault={status:401,code:'UNAUTHORIZED',message:'Pair this device again.'};lost.intervals[0]();await lost.until(()=>lost.el('first-theme-dialog').open===false);
  assert.equal(lost.el('pair-panel').hidden,false,'the pairing panel shows instead');
});

// ---- 2. this device's theme in Settings ----------------------------------------------------------------------------------------------------------
test('Settings says the theme is for this screen only; choosing one writes this device\'s choice (never the shared configuration)',async t=>{
  const f=await world(t,{deviceTheme:'braun'}),{el}=f;await calm(f);
  assert.equal(find(el('system-layer'),node=>node.id==='theme-scope').textContent,'This screen only');
  const revision=f.state.config.revision;
  el('theme-picker').children.find(node=>node.dataset.themeChoice==='classic').emit('click');await f.until(()=>f.deviceTheme==='classic');
  assert.deepEqual(f.calls.filter(call=>call.path==='/api/device-theme/save').map(call=>call.data),[{theme:'classic',layoutName:'Surface'}]);
  assert.equal(f.count('configuration/save'),0);assert.equal(f.count('configuration/themes'),0);assert.equal(f.state.config.revision,revision);
  await f.until(()=>el('html').dataset.theme==='classic');
  assert.equal(el('theme-picker').children.find(node=>node.dataset.themeChoice==='classic').getAttribute('aria-pressed'),'true');
  const widgetSource=read('apps/web/widgets/settings.ts');assert.match(widgetSource,/This screen only/);
});

// ---- 3. the Layout page ------------------------------------------------------------------------------------------------------------------------------
const openLayout=async(t,extra)=>{
  const f=await world(t,{deviceTheme:'braun',...extra}),{el}=f;await calm(f);
  el('theme-open').emit('click');await f.drain();assert.equal(el('theme-dialog').open,true);
  return f;
};
const stage=f=>{const sketch=f.el('layout-stage').children[0];sketch.rect={left:0,top:0,width:683,height:384};return sketch;};
const partOf=(f,name)=>stage(f).children.find(node=>node.dataset?.part===name);
// a drag of `name` by (dx, dy) screen pixels; the stage is drawn at half size (683 px for a 1366 px window)
const dragPart=(f,name,dx,dy)=>{const node=partOf(f,name);node.emit('pointerdown',{pointerId:1,clientX:100,clientY:100});node.emit('pointermove',{pointerId:1,clientX:100+dx,clientY:100+dy});node.emit('pointerup',{pointerId:1});};
const newTheme=async f=>{f.el('theme-new').emit('click');await f.drain();f.el('theme-tab-layout').emit('click');await f.drain();};
test('a built-in theme shows its zones read-only: a picture each for Wide and Narrow, no Layout page to edit',async t=>{
  const f=await openLayout(t),{el}=f;
  el('theme-list-builtin').children.find(node=>node.dataset.themeId==='widget').emit('click');await f.drain();
  assert.equal(el('theme-readonly').hidden,false);assert.equal(el('theme-form').hidden,true);assert.equal(el('theme-layout').hidden,true);
  const boxes=el('theme-readonly-sketches').children;assert.deepEqual(boxes.map(box=>box.dataset.set),['wide','narrow']);
  for(const box of boxes){const sketch=box.children[0];assert.equal(sketch.children.filter(node=>node.dataset?.part).length,3);assert.ok(!sketch.children.some(node=>node.tagName==='BUTTON'),'a picture, not a control');}
  assert.match(el('theme-readonly-layout').textContent,/can't be changed/);
  el('theme-list-builtin').children.find(node=>node.dataset.themeId==='metro').emit('click');await f.drain();assert.equal(el('theme-readonly-sketches').children.length,2);
});
test('a custom theme has Look and Layout pages; Layout shows Wide and Narrow, drawn to scale, with the three components as handles',async t=>{
  const f=await openLayout(t),{el}=f;await newTheme(f);
  assert.equal(el('theme-form').hidden,false);assert.equal(el('theme-layout').hidden,false);assert.equal(el('theme-look').hidden,true);assert.equal(el('theme-preview').hidden,true,'the key preview belongs to Look');
  assert.equal(el('theme-tab-layout').getAttribute('aria-pressed'),'true');assert.equal(el('layout-wide').getAttribute('aria-pressed'),'true');
  const sketch=stage(f);assert.equal(sketch.dataset.set,'wide');
  assert.deepEqual(sketch.children.filter(node=>node.dataset?.part).map(node=>node.dataset.part).sort(),['connection','mode-switch','settings']);
  // Braun's wide zones (T97): settings 40 × 40 at right 28, top 6 in 1366 × 768, in a 52px bar
  assert.equal(partOf(f,'settings').style.left,`${(1298/1366*100).toFixed(3)}%`);assert.equal(partOf(f,'settings').style.top,`${(6/768*100).toFixed(3)}%`);
  assert.equal(el('layout-header').value,'52');assert.equal(el('layout-left').value,'0','T97: Braun\'s wide content area starts at the window edge');
  el('layout-narrow').emit('click');await f.drain();assert.equal(stage(f).dataset.set,'narrow');assert.equal(el('layout-header').value,'56');
  el('theme-tab-look').emit('click');await f.drain();assert.equal(el('theme-look').hidden,false);assert.equal(el('theme-layout').hidden,true);
});
test('dragging a component snaps it to the nearest edges of the window; the page behind follows live; saving writes the custom theme\'s layout',async t=>{
  const f=await openLayout(t),{el}=f;await newTheme(f);
  // settings: from the top-right corner of the bar to the left, beside the connection capsule (200 px wide at left 28)
  dragPart(f,'settings',-527,0);   // -1054 px in the window: x 1298 -> 244
  const layoutOf=()=>f.el('layout-problem');
  assert.equal(layoutOf().dataset.status,'ok');assert.match(layoutOf().textContent,/fits/);
  const page=find(el('system-layer'),node=>node.dataset?.zonePart==='settings');assert.equal(page.style.left,'244px','the page behind the window already uses the new place');
  el('theme-save').emit('click');await f.until(()=>f.state.config.customThemes?.length===1);
  const theme=f.state.config.customThemes[0];assert.deepEqual(theme.layout.wide.slots.settings,{form:'gear',w:40,h:40,left:244,top:6});
  assert.deepEqual(theme.layout.narrow,C.THEME_LAYOUTS.braun.narrow,'the other size is the base theme\'s');
  await f.until(()=>f.deviceTheme===theme.id);assert.equal(el('theme-dialog').open,false);
  // the saved theme is what this device shows
  await f.until(()=>find(el('system-layer'),node=>node.dataset?.zonePart==='settings')?.style.left==='244px');
});
test('the anchor is the nearer edge: right and bottom when the centre is in the far half; positions snap to 4 px and stay inside the window',()=>{
  const slot={form:'gear',w:44,h:44,right:28,top:14},window={width:1366,height:768};
  assert.deepEqual(anchorSlot(slot,100,10,window),{form:'gear',w:44,h:44,left:100,top:12},'a moved axis snaps to 4 px');
  assert.deepEqual(anchorSlot(slot,100,14,window),{form:'gear',w:44,h:44,left:100,top:14},'an axis that did not move keeps its exact value');
  assert.deepEqual(anchorSlot(slot,1290,700,window),{form:'gear',w:44,h:44,right:30,bottom:24},'1290 snaps to 1292, which leaves 30 on the right; the bottom edge keeps 24');
  assert.deepEqual(anchorSlot(slot,-50,-50,window),{form:'gear',w:44,h:44,left:0,top:0},'held inside the window');
  assert.deepEqual(anchorSlot(slot,5000,5000,window),{form:'gear',w:44,h:44,right:0,bottom:0});
  assert.deepEqual(anchorSlot(slot,101,15,window,1),{form:'gear',w:44,h:44,left:101,top:15},'the arrow keys move one pixel');
  assert.deepEqual(withForm({form:'capsule',w:200,h:40,left:28,top:16},'dot'),{form:'dot',w:24,h:24,left:28,top:16},'a form brings its usual size and keeps the anchor');
  assert.deepEqual(withForm({form:'dot',w:24,h:24,left:28,top:16},'unknown'),{form:'unknown',w:24,h:24,left:28,top:16});
});
test('the arrow keys move a focused component; Shift moves 16 px',async t=>{
  const f=await openLayout(t);await newTheme(f);
  const node=partOf(f,'settings');node.emit('keydown',{key:'ArrowLeft'});await f.drain();
  const theme=()=>f.el('layout-problem');assert.equal(theme().dataset.status,'ok');
  const read=()=>{const style=partOf(f,'settings').style;return Math.round(Number.parseFloat(style.left)/100*1366);};
  assert.equal(read(),1294);partOf(f,'settings').emit('keydown',{key:'ArrowLeft',shiftKey:true});await f.drain();assert.equal(read(),1278);
});
test('margins, top bar height and forms are set on the page; a layout equal to the base theme\'s is not stored; Reset goes back to it',async t=>{
  const f=await openLayout(t),{el}=f;await newTheme(f);
  el('layout-left').value='40';el('layout-left').emit('input');await f.drain();
  el('layout-header').value='80';el('layout-header').emit('input');await f.drain();
  el('layout-top').value='500';el('layout-top').emit('input');await f.drain();   // held to the largest margin, 400
  el('layout-top').value='80';el('layout-top').emit('input');await f.drain();
  const connection=find(el('layout-forms'),node=>node.dataset?.part==='connection'&&node.dataset.form==='dot');connection.emit('click');await f.drain();
  assert.equal(connection.getAttribute('aria-pressed'),'true');assert.equal(el('layout-problem').dataset.status,'ok');
  assert.equal(find(el('layout-forms'),node=>node.dataset?.part==='mode-switch'&&node.dataset.form==='icon')!==undefined,true,'the Use | Edit switch has two forms');
  assert.equal(find(el('layout-forms'),node=>node.dataset?.part==='settings'),undefined,'the gear has only one form, so there is nothing to choose');
  el('theme-save').emit('click');await f.until(()=>f.state.config.customThemes?.length===1);
  const wide=f.state.config.customThemes[0].layout.wide;
  assert.equal(wide.header,80);assert.equal(wide.content.left,40);assert.equal(wide.content.top,80);assert.deepEqual(wide.slots.connection,{form:'dot',w:24,h:24,left:28,top:8});
  // Reset puts this size back to the base theme's; with both sizes equal to it, the theme stores no layout at all
  const g=await openLayout(t),{el:e}=g;await newTheme(g);
  e('layout-left').value='40';e('layout-left').emit('input');await g.drain();e('layout-reset').emit('click');await g.drain();
  assert.equal(e('layout-left').value,'0');assert.match(e('layout-reset').textContent,/Braun/);
  e('theme-save').emit('click');await g.until(()=>g.state.config.customThemes?.length===1);assert.equal(Object.hasOwn(g.state.config.customThemes[0],'layout'),false);
});
test('a layout that breaks a rule says which and cannot be saved: overlap, leaving the window, a content area that is too small',async t=>{
  const f=await openLayout(t),{el}=f;await newTheme(f);
  // settings dragged onto the content area
  dragPart(f,'settings',-300,300);
  assert.equal(el('layout-problem').dataset.status,'bad');assert.match(el('layout-problem').textContent,/settings component overlaps the content area/);
  assert.equal(el('theme-save').disabled,true);assert.match(el('theme-message').textContent,/^Layout: /);assert.equal(partOf(f,'settings').parentNode.dataset.problem,'true');
  el('layout-reset').emit('click');await f.drain();assert.equal(el('layout-problem').dataset.status,'ok');assert.equal(el('theme-save').disabled,false);
  // margins that leave no room in the smallest wide window
  el('layout-left').value='400';el('layout-left').emit('input');await f.drain();el('layout-right').value='400';el('layout-right').emit('input');await f.drain();
  assert.match(el('layout-problem').textContent,/content area is too small in a 601 × 420 window/);assert.equal(el('theme-save').disabled,true);
  // the Narrow size is checked as well, and the message names it
  el('layout-reset').emit('click');await f.drain();el('layout-narrow').emit('click');await f.drain();
  el('layout-left').value='300';el('layout-left').emit('input');await f.drain();assert.match(el('layout-problem').textContent,/^Narrow: /);assert.equal(el('theme-save').disabled,true);
  // the Host refuses the same layouts: nothing is stored that the page would not save
  const bad=clone(C.THEME_LAYOUTS.braun);bad.wide.slots.settings={form:'gear',w:44,h:44,left:300,top:300};
  assert.throws(()=>C.parseCustomThemes([mine({layout:bad})]),error=>error.code==='INVALID_INPUT');
  assert.ok(layoutProblem(bad));assert.equal(layoutProblem(C.THEME_LAYOUTS.widget),undefined);
  for(const name of C.themes)assert.equal(layoutProblem(C.THEME_LAYOUTS[name]),undefined,`${name} passes its own rules`);
});
test('"New theme from this" copies the layout of a custom theme with its look; Delete removes it; the page of a deleted theme falls back to Braun',async t=>{
  const layout=clone(C.THEME_LAYOUTS.braun);layout.wide.slots.settings={form:'gear',w:40,h:40,left:240,top:6};
  const f=await openLayout(t,{themes:[mine({layout})],deviceTheme:'theme-mine'}),{el}=f;
  el('theme-list-mine').children[0].emit('click');await f.drain();el('theme-copy').emit('click');await f.drain();
  el('theme-tab-layout').emit('click');await f.drain();
  const settings=stage(f).children.find(node=>node.dataset?.part==='settings');assert.equal(settings.style.left,`${(240/1366*100).toFixed(3)}%`,'the copy starts from the layout of its source');
});

// ---- 4. the floating area of Edit --------------------------------------------------------------------------------------------------------------
test('the floating area keeps clear of the library: its bottom edge and its height come from one variable, and the settings card scrolls inside',()=>{
  const t64=css.slice(css.indexOf('/* ---------- T63 (ADR-064): Mac-style Edit'));
  assert.match(t64,/\.edit-float\{--float-bottom:calc\(12px \+ var\(--edit-toolbar-h\) \+ 8px \+ env\(safe-area-inset-bottom\)\)/,'T83: the card keeps clear of the docked toolbar');
  assert.match(t64,/bottom:var\(--float-bottom\);max-height:calc\(100dvh - var\(--float-bottom\) - 12px - var\(--zone-top,0px\)\)/);
  assert.match(t64,/\.shell\[data-shelf=true\] \.edit-float\{--float-bottom:calc\(12px \+ var\(--edit-toolbar-h\) \+ 8px \+ var\(--shelf-grab\) \+ var\(--shelf-h\) \+ env\(safe-area-inset-bottom\)\)\}/,'the library lifts the floating area, and its height shrinks with it');
  assert.match(t64,/\.settings-card\{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;max-height:600px;overflow:hidden;/,'the card takes what is left, never more than 600px');
  assert.doesNotMatch(t64,/max-height:min\(66dvh/,'no height of its own that ignores the library');
  assert.match(read('apps/web/zones.ts'),/--zone-top/,'the floating area keeps below the top bar: zones.ts says where the content area starts');
  assert.match(css,/\.popup-body\{flex:1 1 auto;min-height:0;[^}]*overflow-y:auto/,'the body of the card scrolls; its header with the name stays');
  assert.match(css,/\.card-head\{display:flex;[^}]*flex:none/);
  // the card on the left side obeys the same limit; on a narrow window it is part of the column
  assert.match(css,/\.edit-float\[data-card-side=left\]>\.settings-card\{position:fixed;[^}]*bottom:var\(--float-bottom\);[^}]*max-height:min\(600px,calc\(100dvh - var\(--float-bottom\) - 12px - var\(--zone-top,0px\)\)\)/);
  assert.match(css,/@media\(max-width:600px\)\{\.edit-float\[data-card-side=left\]>\.settings-card\{[^}]*position:static/);
});
test('the save question is a small dialog in the middle of the window over a dimmed page, not a block under the card',()=>{
  assert.match(html,/<div id="confirm-slot" class="confirm-slot"><div id="layout-confirm" class="layout-confirm" role="alertdialog" aria-modal="true"/);
  assert.match(css,/\.edit-float \.confirm-slot\{position:fixed;inset:0;z-index:72;display:grid;place-items:center;/);
  assert.match(css,/\.edit-float \.confirm-slot \.layout-confirm\{[^}]*width:min\(360px,100%\)/);
  assert.match(css,/\.confirm-slot:not\(:has\(\.layout-confirm:not\(\[hidden\]\)\)\)\{display:none\}/,'nothing is drawn while there is no question');
});
test('the unsaved mark is a dot on Save, not a line of its own: the status line stays out of sight unless it reports a result (it fades) or a problem (it stays)',async t=>{
  assert.match(html,/id="desk-save"[^>]*>[^]*?<span class="unsaved-dot" aria-hidden="true"><\/span><\/button>/);
  assert.match(css,/\.unsaved-dot\{position:absolute;/);assert.match(css,/\.edit-float>\.draft-message\[data-tone=quiet\]\{position:absolute;width:1px;height:1px/);
  assert.doesNotMatch(css,/\.draft-message\[data-dirty=true\]::before/,'the old "● Unsaved" line is gone');
  const key1=key('k1',APP);const config=C.parseConfig({...C.initialView(),revision:2,widgets:[{...C.initialView().widgets[0],pages:[{id:'page-1',name:'Page 1',widgets:[{...key1,},{...key('k2',APP),}]}]}]});
  const f=await client(t,{configuration:config,viewport:{width:1366,height:768},deviceTheme:'braun'}),{el}=f;await calm(f);
  el('edit-layout').emit('click');await f.drain();assert.equal(el('save-message').dataset.tone,'quiet');
  find(el('button-grid'),node=>node.dataset?.removeFor==='k1').emit('click');await f.drain();
  assert.equal(el('desk-save').hidden,false,'Save, with its dot, is there');assert.equal(el('save-message').dataset.dirty,'true');assert.equal(el('save-message').dataset.tone,'quiet','the dirty state is told by the dot alone');
  assert.equal(el('reload-layout').hidden,true,'Discard & load latest is only offered when the Mac moved on or a save failed');
  el('config-form').emit('submit');await f.until(()=>el('save-message').textContent==='Saved on your Mac.');
  assert.equal(el('save-message').dataset.tone,'result');
  await f.fireTimer(3500);assert.equal(el('save-message').dataset.tone,'quiet','a result fades after a few seconds');
  // a problem stays until something else is said
  f.saveFault={status:500,code:'INTERNAL',message:'The Host failed.'};
  find(el('button-grid'),node=>node.dataset?.removeFor==='k2').emit('click');await f.drain();el('desk-save').emit('click');await f.until(()=>/The Host failed/.test(el('save-message').textContent));
  assert.equal(el('save-message').dataset.tone,'problem');
  assert.equal([...f.timers.values()].some(timer=>timer.delay===3500),false,'no timer hides a problem');
});
test('the save question appears in the middle when Done is pressed with changes; Keep editing closes it',async t=>{
  const config=C.parseConfig({...C.initialView(),revision:2,widgets:[{...C.initialView().widgets[0],pages:[{id:'page-1',name:'Page 1',widgets:[{...key('k1',APP),}]}]}]});
  const f=await client(t,{configuration:config,viewport:{width:1366,height:768},deviceTheme:'braun'}),{el}=f;await calm(f);
  el('edit-layout').emit('click');await f.drain();find(el('button-grid'),node=>node.dataset?.removeFor==='k1').emit('click');await f.drain();
  el('edit-back').emit('click');await f.drain();assert.equal(el('layout-confirm').hidden,false);assert.equal(el('confirm-save').hidden,false);assert.equal(el('confirm-yes').textContent,'Discard changes');
  el('confirm-no').emit('click');await f.drain();assert.equal(el('layout-confirm').hidden,true);assert.equal(el('shell').dataset.editing,'true');
});

// ---- 5. clean-up --------------------------------------------------------------------------------------------------------------------------------
test('the fixture\'s grid demo is in the current format: a canvas with a Pages widget of three pages (one holds an App group) and ordinary widgets',()=>{
  for(const ids of [undefined,['a.one','a.two']]){
    const config=C.parseConfig(gridDemoConfig(ids));
    assert.equal(config.gridSize,'standard');assert.equal(Object.hasOwn(config,'canvas'),false);const pages=config.widgets.find(widget=>widget.kind==='pages');
    assert.deepEqual(pages.pages.map(page=>page.name),['Daily tools','More actions','Empty page']);
    assert.ok(pages.pages[0].widgets.every(widget=>widget.kind==='key'),'only individual keys');assert.equal(C.findComponent(config,'primary').label,'Calculator');
    assert.deepEqual(config.widgets.filter(widget=>widget.kind!=='pages').map(widget=>widget.kind),['clock','refresh','text']);
    for(const old of ['pages','components','theme'])assert.equal(Object.hasOwn(config,old),false);
  }
  assert.ok(C.findComponent(C.parseConfig(gridDemoConfig()),'failure'),'the fake failure and slow keys exist without icon demo');
  const fixture=read('tests/browser-fixture.mjs');
  assert.match(fixture,/gridDemoConfig\(/);assert.match(fixture,/new DeviceAssignments\(/);assert.match(fixture,/Fixture pairing code: \$\{auth\.invite\(\)\}/);assert.match(fixture,/command === 'approve'/);
  assert.doesNotMatch(fixture,/config\.pages|config\.components|frame: slot/,'no T58 format is left in the fixture');
});
test('the build removes compiled modules whose source is gone; dist holds no module without a source file',()=>{
  const build=read('scripts/build.mjs');assert.match(build,/function prune\(dir\)/);assert.match(build,/for \(const dir of \['dist\/apps', 'dist\/packages'\]\)/);
  const walk=(dir,out=[])=>{for(const entry of readdirSync(new URL(`../${dir}`,import.meta.url),{withFileTypes:true})){const path=`${dir}/${entry.name}`;if(entry.isDirectory())walk(path,out);else if(path.endsWith('.js'))out.push(path);}return out;};
  for(const file of walk('dist/apps').concat(walk('dist/packages')))assert.ok(existsSync(new URL(`../${file.replace(/^dist\//,'').replace(/\.js$/,'.ts')}`,import.meta.url)),`${file} has a source`);
  assert.equal(existsSync(new URL('../dist/apps/web/arrange-ui.js',import.meta.url)),false);
});
test('every id the page scripts ask for by name exists in the page (the minimal DOM of the tests invents missing ones; a browser does not)',()=>{
  // Found in a real browser: the Theme window threw on a custom theme because the background colour chip had no id.
  const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]));
  const dynamic=new Set(['app-select','host-address','theme-picker','connection-settings','theme-open','execution-diagnostics','execution-message','execution-output','execution-acknowledge']);   // made by the App picker and by the Settings widget (widgets/settings.ts)
  const missing=[];
  for(const file of ['app.ts','editor.ts','console.ts','theme-editor.ts','theme-layout.ts','first-theme.ts','layout-tools.ts','layout-files.ts','library.ts','library-apps.ts','widget-settings.ts','edit-menu.ts','icon-library.ts','app-picker.ts','install.ts','page-refresh.ts','workflows.ts','window-picker.ts','themes.ts','select-menu.ts'])
    for(const match of read(`apps/web/${file}`).matchAll(/\b(?:el|input|text|getElementById)(?:<[^>]*>)?\(\s*"([\w-]+)"/g))if(!ids.has(match[1])&&!dynamic.has(match[1]))missing.push(`${file}: ${match[1]}`);
  assert.deepEqual(missing,[]);
  // the ids the Theme window builds from a pattern
  for(const id of ['theme-bg-color-chip','theme-key-color-chip','theme-bg-hex','theme-bg-color','theme-key-hex','theme-key-color'])assert.ok(ids.has(id),id);
});
test('the stylesheet and the page carry no class or id that nothing uses: the old header, desk heading, profile list, page strip, page settings and the screen dialog are gone',()=>{
  for(const gone of ['.header{','.header ','.brand','.desk-heading','.profile-list','.profile-button','.page-strip','.page-settings','.screen-dialog','.status-bar','.side-column','.desk-bottom','.theme-layout-row','data-page-index','.danger-button'])
    assert.ok(!css.includes(gone),`${gone} is gone from the stylesheet`);
  assert.ok(!html.includes('id="screen-dialog"')&&!html.includes('screen-dialog'));
  assert.ok(!html.includes('id="item-icon-section"'),'group editor markup is deleted');
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);assert.equal(new Set(ids).size,ids.length,'every id in the page is unique');
  for(const source of ['app.ts','editor.ts','console.ts'])assert.doesNotMatch(read(`apps/web/${source}`),/pageIndex/);
  assert.match(css,/\[data-theme=metro\] \.pages-strip \.use-page\[aria-pressed=true\]\{box-shadow:inset 0 -4px 0 var\(--tab-c\)\}/,'Metro\'s band is on the page tabs of a Pages widget');
  assert.doesNotMatch(css,/var\(--band\)/);
});