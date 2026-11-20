import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {client} from './helpers/client-harness.mjs';
import {responsiveBoxes} from './helpers/responsive-boxes.mjs';
import {watchPress,HOLD_MS,SLOP} from '../dist/apps/web/touch-hold.js';

// T85 (ADR-080): in every Library tab a touch swipe scrolls the list; holding ~400ms lifts the card, then moving drags it onto the canvas and letting go
// opens Activate window (App) or does nothing (other tabs). The mouse is unchanged. These tests drive the production Library and console code against the
// minimal DOM; they are not browser or Surface touch evidence.
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const css=read('apps/web/style.css');
const rule=selector=>{const start=css.indexOf(selector+'{');assert.ok(start>=0,selector);return css.slice(start,css.indexOf('}',start)+1);};
const apps=Array.from({length:6},(_,n)=>({id:`t85.app${n}`,name:`App ${n}`}));
const open=async t=>{const f=await client(t,{apps,viewport:{width:1366,height:768}});f.el('edit-layout').emit('click');f.el('shelf-toggle').emit('click');await f.drain();return f;};
const tab=async(f,index)=>{f.el('shelf-types').children[index].emit('click');await f.drain();};
const TABS=[{name:'App',index:0,pick:'app'},{name:'Other Key',index:1,pick:'other'},{name:'Pages',index:2,pick:'pages'},{name:'Widget',index:3,pick:'widget'}];
const cardsOf=f=>f.el('shelf-previews').children.filter(node=>node.className?.includes('shelf-card'));
const menu=f=>f.el('shelf-app-menu');
const dirty=f=>f.el('save-message').dataset.dirty==='true';
const grid=f=>f.el('button-grid');
const holdTimer=f=>[...f.timers.values()].some(timer=>timer.delay===HOLD_MS);
const touch=(extra={})=>({isPrimary:true,button:0,pointerId:1,pointerType:'touch',clientX:100,clientY:100,...extra});
const down=(card,extra)=>card.emit('pointerdown',touch(extra));
const finger=(x,y,identifier=7)=>{const event={changedTouches:[{identifier,clientX:x,clientY:y}],cancelable:true,prevented:false,preventDefault:()=>{event.prevented=true;}};return event;};
const doc=(f,type,event={})=>{const call=f.documentEvents.get(type);assert.ok(call,`a ${type} listener on the document`);call({preventDefault(){},stopPropagation(){},...event});};
const escape=f=>doc(f,'keydown',{key:'Escape'});

test('T85 every Library card scrolls the list by touch, cannot be selected, and shows a lifted state',()=>{
  const card=rule('.shelf-card');
  assert.match(card,/touch-action:pan-y/);assert.doesNotMatch(card,/touch-action:none/);
  assert.match(card,/user-select:none/);assert.match(card,/-webkit-touch-callout:none/);
  const held=rule('.shelf-card[data-held=true]');
  assert.match(held,/transform:scale\(1\.06\)/);assert.match(held,/box-shadow:/);assert.match(held,/var\(--surface-2\)/);assert.doesNotMatch(held,/#[0-9a-fA-F]{3,8}\b/,'theme tokens only');
  assert.ok(css.includes('@media(prefers-reduced-motion:reduce){.shelf-card[data-held=true]{transform:none;transition:none}}'),'no motion when reduced; the highlight stays');
  assert.doesNotMatch(rule('.shelf-tabs'),/touch-action/,'the tab strip keeps its own touch handling');
  assert.ok(css.indexOf('.shelf-card[data-held=true]')>css.indexOf('.shelf-app-card:active'),'the lifted state wins over the pressed one');
  assert.match(read('apps/host/server.ts'),/\["\/apps\/web\/touch-hold\.js", \["\.\.\/\.\.\/apps\/web\/touch-hold\.js"/,'the host serves the module');
});

for(const {name,index,pick} of TABS)test(`T85 ${name}: touch hold lifts, then moving drags onto the canvas; no add and no menu`,async t=>{
  const f=await open(t);await tab(f,index);responsiveBoxes(f);const card=cardsOf(f)[0];assert.ok(card,'a card');
  down(card);assert.ok(holdTimer(f),'the hold timer runs');assert.equal(card.dataset.held,undefined);
  card.emit('pointermove',touch({clientX:105,clientY:100}));assert.equal(grid(f).dataset.lifted,undefined,'no drag before the lift');
  await f.fireTimer(HOLD_MS);assert.equal(card.dataset.held,'true');assert.equal(grid(f).dataset.lifted,undefined,'lifted is not dragging yet');
  card.emit('pointermove',touch({clientX:104,clientY:100}));assert.equal(grid(f).dataset.lifted,undefined,'within the 8px slop');
  card.emit('pointermove',touch({clientX:120,clientY:100}));
  assert.equal(grid(f).dataset.lifted,'true','the existing drag took the card');assert.equal(card.dataset.held,undefined);
  doc(f,'pointermove',{pointerId:1,clientX:300,clientY:300});doc(f,'pointerup',{pointerId:1,clientX:300,clientY:300});await f.drain();
  assert.equal(grid(f).dataset.lifted,undefined);assert.equal(menu(f).hidden,true);assert.equal(f.count('execute'),0);
  card.emit('click');assert.equal(card.dataset.held,undefined);
});

test('T85 App: hold then let go opens Activate window once at the finger and adds nothing',async t=>{
  const f=await open(t),card=cardsOf(f)[0];
  down(card,{clientX:200,clientY:150});await f.fireTimer(HOLD_MS);assert.equal(menu(f).hidden,true,'the menu waits for the release');
  card.emit('pointerup',touch({clientX:200,clientY:150}));
  assert.equal(menu(f).hidden,false);assert.equal(menu(f).style.left,'200px');assert.equal(menu(f).style.top,'150px');assert.equal(card.dataset.held,undefined);
  card.emit('contextmenu',{clientX:200,clientY:150,pointerType:'touch'});card.emit('click');
  assert.equal(dirty(f),false,'the click after a hold never adds');assert.equal(menu(f).hidden,false);
  escape(f);assert.equal(menu(f).hidden,true);
  card.emit('contextmenu',{clientX:200,clientY:150});assert.equal(menu(f).hidden,true,'a touch hold opens no second menu, even when Windows sends contextmenu after the release');
  card.emit('click',{detail:0});assert.equal(dirty(f),true,'a later click adds as usual');
});
for(const {name,index} of TABS.slice(1))test(`T85 ${name}: hold then let go does nothing`,async t=>{
  const f=await open(t);await tab(f,index);const card=cardsOf(f)[0];
  down(card);await f.fireTimer(HOLD_MS);assert.equal(card.dataset.held,'true');
  card.emit('pointerup',touch());card.emit('click');
  assert.equal(dirty(f),false,'no add');assert.equal(menu(f).hidden,true,'no menu');assert.equal(grid(f).dataset.lifted,undefined);assert.equal(card.dataset.held,undefined);
  card.emit('click',{detail:0});assert.equal(dirty(f),true,'the click guard ends; a keyboard click still adds');
});
for(const {name,index} of TABS)test(`T85 ${name}: a quick tap still adds`,async t=>{
  const f=await open(t);await tab(f,index);const card=cardsOf(f)[0];
  down(card);card.emit('pointerup',touch());card.emit('click');await f.drain();
  assert.equal(dirty(f),true);assert.equal(menu(f).hidden,true);assert.equal(holdTimer(f),false,'the tap cleared the timer');
});

test('T85 moving before the hold completes is a scroll: no hold, no drag, no menu; pointercancel does the same',async t=>{
  for(const index of [0,1]){
    const f=await open(t);await tab(f,index);const card=cardsOf(f)[0];
    down(card);card.emit('pointermove',touch({clientX:100,clientY:112}));
    assert.equal(holdTimer(f),false,'the hold timer is cancelled');assert.equal(card.dataset.held,undefined);assert.equal(grid(f).dataset.lifted,undefined);
    card.emit('pointermove',touch({clientX:100,clientY:300}));card.emit('pointerup',touch());assert.equal(menu(f).hidden,true);assert.equal(grid(f).dataset.lifted,undefined);assert.equal(dirty(f),false);
    down(card,{pointerId:2});card.emit('pointercancel',{pointerId:2});assert.equal(holdTimer(f),false,'pointercancel cancels the hold');
    down(card,{pointerId:3});card.emit('lostpointercapture',{pointerId:3});assert.equal(holdTimer(f),false,'lostpointercapture before the lift cancels too');assert.equal(card.dataset.held,undefined);
  }
});

test('T85 touchmove is cancelled from the lift on, and not before',async t=>{
  const f=await open(t),card=cardsOf(f)[0];
  down(card);const early=finger(100,104);card.emit('touchmove',early);assert.equal(early.prevented,false,'the list may still scroll');
  await f.fireTimer(HOLD_MS);const late=finger(100,103);card.emit('touchmove',late);assert.equal(late.prevented,true,'the list may not scroll now');
  const uncancelable=finger(100,103);uncancelable.cancelable=false;card.emit('touchmove',uncancelable);assert.equal(uncancelable.prevented,false,'never called on an event that cannot be cancelled');
  card.emit('pointerup',touch());const after=finger(100,103);card.emit('touchmove',after);assert.equal(after.prevented,false,'scrolling is back once the hold is over');
  const source=read('apps/web/touch-hold.ts');assert.match(source,/card\.addEventListener\("touchmove",[\s\S]*?\{ passive: false \}\);/);
});

test('T85 a touch contextmenu during a hold is prevented and opens nothing; mouse right click and the ContextMenu key still open the App menu',async t=>{
  const f=await open(t),card=cardsOf(f)[0];
  down(card);let blocked=0,stopped=0;const context={clientX:100,clientY:100,preventDefault(){blocked++;},stopPropagation(){stopped++;}};
  card.emit('contextmenu',context);assert.equal(blocked,1);assert.equal(stopped,1);assert.equal(menu(f).hidden,true);
  await f.fireTimer(HOLD_MS);card.emit('contextmenu',{...context,pointerType:'touch'});assert.equal(menu(f).hidden,true);assert.equal(card.dataset.held,'true','the hold goes on');
  card.emit('pointerup',touch());assert.equal(menu(f).hidden,false,'our hold logic opens it, once');escape(f);
  card.emit('contextmenu',{clientX:20,clientY:20,pointerType:'mouse'});assert.equal(menu(f).hidden,false,'right click with a mouse still opens it');assert.equal(menu(f).style.left,'20px');escape(f);
  card.emit('keydown',{key:'ContextMenu'});assert.equal(menu(f).hidden,false,'the keyboard still opens it');escape(f);
  card.emit('keydown',{key:'F10',shiftKey:true});assert.equal(menu(f).hidden,false);
  assert.equal(dirty(f),false);
});
test('T85 other tabs also prevent the touch contextmenu',async t=>{
  const f=await open(t);await tab(f,1);const card=cardsOf(f)[0];let blocked=0;
  down(card);await f.fireTimer(HOLD_MS);card.emit('contextmenu',{preventDefault(){blocked++;},stopPropagation(){}});assert.equal(blocked,1);
  card.emit('contextmenu',{pointerType:'mouse',preventDefault(){blocked++;},stopPropagation(){}});assert.equal(blocked,1,'a mouse right click is left to the browser there');
});

test('T85 the mouse is unchanged: press and move drags at once, click adds, no hold',async t=>{
  const f=await open(t);responsiveBoxes(f);let card=cardsOf(f)[0];
  card.emit('pointerdown',touch({pointerType:'mouse'}));assert.equal(holdTimer(f),false,'no hold timer for a mouse');assert.equal(card.dataset.held,undefined);
  card.emit('pointermove',touch({pointerType:'mouse',clientX:104,clientY:100}));assert.equal(grid(f).dataset.lifted,undefined);
  card.emit('pointermove',touch({pointerType:'mouse',clientX:112,clientY:100}));assert.equal(grid(f).dataset.lifted,'true');
  doc(f,'pointerup',{pointerId:1,clientX:600,clientY:300});await f.drain();card.emit('click');assert.equal(menu(f).hidden,true);
  await f.drain();await tab(f,1);card=cardsOf(f)[0];
  card.emit('pointerdown',touch({pointerType:'mouse'}));card.emit('pointerup',touch({pointerType:'mouse'}));card.emit('click');assert.equal(dirty(f),true,'a click adds');
});

test('T85 after the browser takes the pointer (pointercancel, lostpointercapture) the same finger is followed by touch events: moving drags, letting go resolves',async t=>{
  for(const lost of ['pointercancel','lostpointercapture']){
    const f=await open(t);responsiveBoxes(f);let card=cardsOf(f)[0];
    down(card,{clientX:200,clientY:200});await f.fireTimer(HOLD_MS);card.emit(lost,{pointerId:1});assert.equal(card.dataset.held,'true','still lifted');
    const slide=finger(200,260);doc(f,'touchmove',slide);assert.equal(slide.prevented,true);assert.equal(grid(f).dataset.lifted,'true','moving drags');
    doc(f,'touchend',finger(220,280));await f.drain();assert.equal(grid(f).dataset.lifted,undefined,'letting go drops');assert.equal(menu(f).hidden,true);
    card.emit('click');
    // Let go without moving: the App menu opens at the finger.
    down(card,{clientX:200,clientY:200,pointerId:5});await f.fireTimer(HOLD_MS);card.emit(lost,{pointerId:5});
    doc(f,'touchmove',finger(202,201));assert.equal(grid(f).dataset.lifted,undefined,'inside the slop');
    doc(f,'touchend',finger(202,201));assert.equal(menu(f).hidden,false);assert.equal(menu(f).style.left,'202px');assert.equal(card.dataset.held,undefined);
    escape(f);
    // Other Key: nothing.
    const g=await open(t);await tab(g,1);card=cardsOf(g)[0];down(card,{pointerId:6});await g.fireTimer(HOLD_MS);card.emit(lost,{pointerId:6});doc(g,'touchend',finger(100,100));
    assert.equal(dirty(g),false);assert.equal(menu(g).hidden,true);assert.equal(card.dataset.held,undefined);
  }
});
test('T85 touchcancel with nothing after it cancels the hold cleanly; a second finger, Esc and a new pointer do too',async t=>{
  const f=await open(t),card=cardsOf(f)[0];
  down(card);await f.fireTimer(HOLD_MS);card.emit('pointercancel',{pointerId:1});doc(f,'touchcancel');
  doc(f,'touchmove',finger(100,101));await f.drain();assert.equal(card.dataset.held,'true','a touch event after the cancel shows the finger is down');
  doc(f,'touchcancel');await f.fireTimer(300);assert.equal(card.dataset.held,undefined);assert.equal(menu(f).hidden,true);assert.equal(dirty(f),false);
  doc(f,'touchend',finger(100,100));assert.equal(menu(f).hidden,true,'a stray touchend afterwards does nothing');
  down(card,{pointerId:2});await f.fireTimer(HOLD_MS);doc(f,'touchstart',{touches:[{identifier:1},{identifier:2}]});assert.equal(card.dataset.held,undefined,'a second finger cancels');card.emit('pointerup',touch({pointerId:2}));assert.equal(menu(f).hidden,true);
  down(card,{pointerId:3});await f.fireTimer(HOLD_MS);escape(f);assert.equal(card.dataset.held,undefined,'Esc cancels');card.emit('pointerup',touch({pointerId:3}));assert.equal(menu(f).hidden,true);
  down(card,{pointerId:4});await f.fireTimer(HOLD_MS);card.emit('lostpointercapture',{pointerId:4});doc(f,'pointerdown',{pointerId:9});assert.equal(card.dataset.held,undefined,'a new pointer after the browser took this one cancels');
  down(card,{pointerId:8});doc(f,'touchstart',{touches:[{identifier:1},{identifier:2}]});assert.equal(holdTimer(f),false,'a second finger before the lift cancels too');
});

test('T85 rebuilt cards: a stale card cannot lift or open a menu, and the press ends cleanly',async t=>{
  const f=await open(t),card=cardsOf(f)[0];
  down(card);f.el('shelf-search').value='App 3';f.el('shelf-search').emit('input');await f.drain();
  assert.ok(!card.isConnected,'the old tile was replaced');await f.fireTimer(HOLD_MS);assert.equal(card.dataset.held,undefined,'a detached tile does not lift');
  const fresh=cardsOf(f)[0];down(fresh,{pointerId:2});await f.fireTimer(HOLD_MS);assert.equal(fresh.dataset.held,'true');
  f.el('shelf-search').value='';f.el('shelf-search').emit('input');await f.drain();
  fresh.emit('pointerup',touch({pointerId:2}));assert.equal(menu(f).hidden,true,'no menu from a tile that is gone');
});
test('T85 Library closed or Edit left during a press: no menu and no stuck lift',async t=>{
  const f=await open(t),card=cardsOf(f)[0];
  down(card);await f.fireTimer(HOLD_MS);f.el('shelf-toggle').emit('click');await f.drain();
  card.emit('pointerup',touch());assert.equal(menu(f).hidden,true);
});

test('T85 the helper in isolation: options, begin/end, drag refusal and the click guard',()=>{
  const listeners=new Map(),documentListeners=new Map(),timers=[];
  const card={dataset:{},isConnected:true,addEventListener:(type,fn)=>listeners.set(type,[...(listeners.get(type)||[]),fn]),removeEventListener(){}};
  const saved={document:globalThis.document,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};
  globalThis.document={addEventListener:(type,fn)=>documentListeners.set(type,fn),removeEventListener:type=>documentListeners.delete(type)};
  globalThis.setTimeout=(fn,delay)=>{timers.push({fn,delay});return timers.length;};globalThis.clearTimeout=id=>{if(timers[id-1])timers[id-1].fn=undefined;};
  try{
    const log=[];let taken=false;
    watchPress(card,{enabled:()=>true,drag:pointer=>{log.push(['drag',pointer.touch,pointer.pointerId]);return taken;},click:()=>log.push(['click']),release:(x,y)=>log.push(['release',x,y]),begin:()=>log.push(['begin']),end:()=>log.push(['end'])});
    const emit=(type,event={})=>{for(const fn of listeners.get(type)||[])fn({preventDefault(){},stopPropagation(){},...event});};
    assert.equal(HOLD_MS,400);assert.equal(SLOP,8);
    // a touch press, hold, a drag the console refuses: it ends, and the click that follows is still swallowed
    emit('pointerdown',touch());assert.deepEqual(log.splice(0),[['begin']]);assert.equal(timers.at(-1).delay,400);timers.at(-1).fn();assert.equal(card.dataset.held,'true');
    emit('pointermove',touch({clientX:150}));assert.deepEqual(log.splice(0),[['drag',true,1],['end']]);emit('click');assert.deepEqual(log,[],'a refused touch drag still ends the hold without a click');
    emit('click',{detail:0});assert.deepEqual(log.splice(0),[['click']]);
    // secondary buttons and non-primary pointers are ignored
    emit('pointerdown',touch({button:2}));emit('pointerdown',touch({isPrimary:false}));assert.deepEqual(log,[]);
    // a mouse drag that is taken keeps the press until the pointer is released
    taken=true;emit('pointerdown',touch({pointerType:'mouse',pointerId:3}));log.splice(0);emit('pointermove',touch({pointerType:'mouse',pointerId:3,clientX:120}));assert.deepEqual(log.splice(0),[['drag',false,3]]);
    emit('pointerup',{pointerId:3});assert.deepEqual(log.splice(0),[['end']]);
  }finally{for(const [key,value] of Object.entries(saved))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
});
