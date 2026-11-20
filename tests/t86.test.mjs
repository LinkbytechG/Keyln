import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {client} from './helpers/client-harness.mjs';
import {SHELF_KEY,SHELF_MIN,SHELF_STEP,SHELF_BIG_STEP,SHELF_GRAB,CANVAS_GAP,shelfLimits,clampShelf,nudgeShelf,loadShelfHeight,saveShelfHeight} from '../dist/apps/web/library-resize.js';

// T86 (ADR-081): the Library's top edge is a handle that changes its height (--shelf-h on the shell), remembered on this device. These tests drive the production module and page
// code against the minimal DOM; they are not browser or Surface touch evidence.
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const css=read('apps/web/style.css'),html=read('apps/web/index.html');
const rule=selector=>{const start=css.indexOf(selector+'{');assert.ok(start>=0,selector);return css.slice(start,css.indexOf('}',start)+1);};
const open=async(t,{width=1366,height=768,local}={})=>{
  const f=await client(t,{viewport:{width,height},...(local?{localSeed:local}:{})});
  f.el('edit-layout').emit('click');f.el('shelf-toggle').emit('click');await f.drain();
  const panel=f.el('shelf-panel'),handle=f.el('shelf-resize'),shell=f.el('shell');
  // The minimal DOM draws nothing: the panel's box follows --shelf-h by hand, as the stylesheet would.
  const sync=()=>{const px=parseFloat(shell.style['--shelf-h']);if(Number.isFinite(px))panel.rect={left:0,top:height-px,width,height:px};};
  if(!shell.style['--shelf-h'])panel.rect={left:0,top:height-244,width,height:244};else sync();
  f.windowEvents.get('resize')();await f.drain();
  const win=globalThis.window;
  return {f,win,panel,handle,shell,sync,height,width,h:()=>shell.style['--shelf-h'],px:()=>parseFloat(shell.style['--shelf-h']),max:()=>Number(handle.getAttribute('aria-valuemax')),
    down:(y,extra={})=>handle.emit('pointerdown',{button:0,isPrimary:true,pointerId:1,pointerType:'mouse',clientY:y,...extra}),
    move:(y,extra={})=>handle.emit('pointermove',{pointerId:1,clientY:y,...extra}),
    up:(extra={})=>handle.emit('pointerup',{pointerId:1,...extra}),
    key:(key,extra={})=>handle.emit('keydown',{key,...extra}),
    saved:()=>f.local.get(SHELF_KEY)};
};
const doc=(f,type,event={})=>{const call=f.documentEvents.get(type);assert.ok(call,`a ${type} listener on the document`);call({preventDefault(){},stopPropagation(){},...event});};

test('T86 limits: at least 120px of Library, at least 120px of canvas below the top of the content area (handle room included)',()=>{
  assert.deepEqual(shelfLimits(768,56),{min:120,max:768-56-120-SHELF_GRAB-CANVAS_GAP});
  assert.equal(shelfLimits(768,56).max,556);
  assert.deepEqual(shelfLimits(375,56),{min:120,max:163},'a phone in landscape');
  assert.deepEqual(shelfLimits(200,56),{min:120,max:120},'a window too small keeps the minimum');
  const limits=shelfLimits(768,56);
  assert.equal(clampShelf(10,limits),120);assert.equal(clampShelf(9999,limits),556);assert.equal(clampShelf(300.6,limits),301);assert.equal(clampShelf(-Infinity,limits),120);
  assert.equal(SHELF_STEP,16);assert.equal(SHELF_BIG_STEP,64);
  assert.equal(nudgeShelf(244,'ArrowUp'),260);assert.equal(nudgeShelf(244,'ArrowDown'),228);assert.equal(nudgeShelf(244,'ArrowUp',true),308);assert.equal(nudgeShelf(244,'ArrowDown',true),180);
  assert.equal(nudgeShelf(244,'ArrowLeft'),undefined);assert.equal(nudgeShelf(244,'a'),undefined);
});
test('T86 storage: a good px value loads; missing, damaged, out of range or unreadable storage gives the stylesheet default; saving never throws',()=>{
  const from=value=>loadShelfHeight({getItem:()=>value});
  assert.equal(from('300'),300);assert.equal(from('244.6'),245);assert.equal(from('120'),120);assert.equal(from('10000'),10000);
  for(const bad of [null,undefined,'','abc','NaN','Infinity','-5','50','119','10001','99999999','1e3','12px','{"h":300}','300 ','0x200'])assert.equal(from(bad),undefined,String(bad));
  assert.equal(loadShelfHeight(undefined),undefined);assert.equal(loadShelfHeight({getItem(){throw new Error('blocked');}}),undefined);
  const log=[],storage={setItem:(k,v)=>log.push(['set',k,v]),removeItem:k=>log.push(['remove',k])};
  assert.equal(saveShelfHeight(storage,300.4),true);assert.equal(saveShelfHeight(storage,undefined),true);assert.deepEqual(log,[['set',SHELF_KEY,'300'],['remove',SHELF_KEY]]);
  assert.equal(SHELF_KEY,'keyln.libraryHeight.v1');
  assert.equal(saveShelfHeight(undefined,300),false);assert.equal(saveShelfHeight({setItem(){throw new Error('quota');},removeItem(){throw new Error('quota');}},300),false);assert.equal(saveShelfHeight({setItem(){throw new Error('quota');},removeItem(){throw new Error('quota');}},undefined),false);
});

test('T86 the handle is a 44px horizontal separator on the top border with a visible grabber, and never covers the search field',async t=>{
  assert.match(html,/<div id="shelf-resize" class="shelf-resize" role="separator" aria-orientation="horizontal" aria-label="Resize library"[^>]*tabindex="0"/);
  assert.ok(html.indexOf('id="shelf-resize"')>html.indexOf('id="shelf-panel"')&&html.indexOf('id="shelf-resize"')<html.indexOf('id="shelf-types"'),'inside the panel, before its content');
  const handle=rule('.shelf-resize'),top=Number(/top:(-\d+)px/.exec(handle)?.[1]),height=Number(/height:(\d+)px/.exec(handle)?.[1]);
  assert.ok(height>=44,`${height}px tall`);assert.match(handle,/cursor:ns-resize/);assert.match(handle,/touch-action:none/);assert.match(handle,/user-select:none/);assert.match(handle,/position:absolute;left:0;right:0/);
  const padding=Number(/padding:(\d+)px/.exec(rule('.shelf-panel'))?.[1]);
  assert.ok(top+height<=padding,`the handle ends ${top+height}px inside the panel, within its ${padding}px padding: it cannot cover the search field or the category buttons`);
  assert.ok(-top>=28,'most of it lies above the border');assert.equal(SHELF_GRAB,28,'the canvas keeps this much clear of the border');
  const pill=rule('.shelf-resize::before');assert.match(pill,/background:var\(--muted\)/);assert.match(pill,/box-shadow:0 0 0 2px var\(--surface\)/);assert.doesNotMatch(pill,/#[0-9a-fA-F]{3,8}\b/,'theme tokens only');
  const pillTop=Number(/top:(\d+)px/.exec(pill)?.[1]),pillHeight=Number(/height:(\d+)px/.exec(pill)?.[1]);assert.ok(Math.abs(pillTop+pillHeight/2-(-top))<=1,'the grabber is centred on the border line');
  assert.match(rule('.shelf-resize[data-dragging=true]::before'),/var\(--accent\)/);assert.match(rule('.shelf-resize:focus-visible::before'),/outline:2px solid var\(--focus\)/);
  assert.doesNotMatch(css,/\.shelf-resize[^{]*\{[^}]*display:none/,'never hidden in a narrow layout');
  for(const [width,height] of [[1366,768],[375,812],[812,375]]){
    const w=await open(t,{width,height});
    assert.equal(w.handle.getAttribute('role'),'separator');assert.equal(w.handle.getAttribute('aria-orientation'),'horizontal');assert.equal(w.handle.getAttribute('aria-label'),'Resize library');assert.equal(w.handle.tabIndex,0);
    assert.equal(w.handle.getAttribute('aria-valuemin'),'120');assert.ok(w.max()>=120);assert.equal(w.handle.getAttribute('aria-valuenow'),'244');
  }
});

test('T86 dragging up grows the Library and dragging down shrinks it, live, inside the limits, and the height is remembered',async t=>{
  const w=await open(t);assert.equal(w.h(),undefined,'untouched, the stylesheet decides');
  w.down(524);w.move(523);assert.equal(w.h(),undefined,'a press that stays within 3px resizes nothing');assert.equal(w.shell.dataset.shelfResizing,undefined);
  w.move(424);assert.equal(w.h(),'344px');assert.equal(w.shell.dataset.shelfResizing,'true');assert.equal(w.handle.dataset.dragging,'true');assert.equal(w.handle.getAttribute('aria-valuenow'),'344');
  w.move(600);assert.equal(w.h(),'168px');w.move(900);assert.equal(w.h(),'120px','not below the minimum');
  w.move(-500);assert.equal(w.px(),w.max(),'not above the maximum');assert.ok(w.px()<=768-120-SHELF_GRAB-CANVAS_GAP);
  w.move(450);assert.equal(w.h(),'318px');assert.equal(w.saved(),undefined,'nothing is stored while dragging');
  w.up();assert.equal(w.saved(),'318');assert.equal(w.shell.dataset.shelfResizing,undefined);assert.equal(w.handle.dataset.dragging,undefined);assert.equal(w.h(),'318px');
  w.move(100);assert.equal(w.h(),'318px','a released handle does not follow the pointer');
  assert.equal(w.f.count('execute'),0);assert.equal(w.f.count('configuration/save'),0,'the Mac and the layout are not involved');
});
test('T86 moves are throttled to animation frames and the last one wins',async t=>{
  const w=await open(t),frames=[],win=globalThis.window;win.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};
  w.down(524);w.move(500);w.move(480);w.move(450);assert.equal(w.h(),undefined,'nothing is written between frames');assert.equal(frames.length,1,'one frame is asked for');
  frames.shift()();assert.equal(w.h(),'318px');w.move(400);w.up();assert.equal(w.h(),'368px','letting go writes the last move at once');assert.equal(w.saved(),'368');
});
test('T86 the canvas, docked toolbar and settings card follow the height through --shelf-h',async t=>{
  const w=await open(t),{f}=w;
  const bottom=()=>parseFloat(f.el('grid-frame').style.top)+parseFloat(f.el('grid-frame').style.height);
  f.windowEvents.get('resize')();await f.drain();const before=bottom();
  assert.ok(before<=w.panel.rect.top-CANVAS_GAP-SHELF_GRAB+1,'the canvas clears the Library and its handle');
  w.down(524);w.move(424);w.sync();f.windowEvents.get('resize')();await f.drain();
  assert.ok(bottom()<before-90,'a taller Library takes room from the canvas as it is dragged');assert.ok(bottom()<=w.panel.rect.top-CANVAS_GAP-SHELF_GRAB+1);
  w.move(580);w.sync();f.windowEvents.get('resize')();await f.drain();assert.ok(bottom()>before+50,'a shorter one gives it back');w.up();
  assert.match(rule('.shell[data-shelf=true] .edit-toolbar[data-docked=true]'),/bottom:calc\(12px \+ var\(--shelf-grab\) \+ var\(--shelf-h\) \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(rule('.shell[data-shelf=true] .edit-float'),/--float-bottom:calc\(12px \+ var\(--edit-toolbar-h\) \+ 8px \+ var\(--shelf-grab\) \+ var\(--shelf-h\)/);
  assert.match(rule('.shelf-panel'),/height:var\(--shelf-h\)/);assert.match(css,/\.shell\{--shelf-h:244px;--edit-toolbar-h:50px\}/,'the stylesheet default is unchanged');
  assert.ok(css.includes('.shell{--shelf-grab:28px}'));
  assert.ok(/\.shell\[data-shelf-resizing=true\] :is\([^)]*\.shelf-main[^)]*\.button-grid[^)]*\)\{pointer-events:none\}/.test(css),'while dragging, the cards and the canvas do not react');
  assert.match(read('apps/web/app.ts'),/libraryResize\.refit\(\)/);
});

test('T86 double tap or double click on the handle, and Home, go back to the stylesheet height and forget the stored one',async t=>{
  for(const how of ['taps','dblclick','home']){
    const w=await open(t);w.down(524);w.move(424);w.up();assert.equal(w.saved(),'344');w.sync();
    if(how==='taps'){w.down(400,{pointerType:'touch'});w.up();assert.equal(w.h(),'344px','one tap does nothing');w.down(400,{pointerType:'touch'});w.up();}
    else if(how==='dblclick')w.handle.emit('dblclick');else w.key('Home');
    assert.equal(w.h(),undefined,how);assert.equal(w.saved(),undefined,how);
  }
  const w=await open(t);w.down(524);w.move(424);w.up();w.sync();w.down(400);w.move(300);w.up();assert.equal(w.saved(),'444','a drag between two taps is not a double tap');
});
test('T86 arrow keys change the height by 16px (Shift: 64px), End is the maximum, and each is remembered',async t=>{
  const w=await open(t);
  w.key('ArrowUp');assert.equal(w.h(),'260px');assert.equal(w.saved(),'260');w.sync();
  w.key('ArrowDown');assert.equal(w.h(),'244px');w.sync();
  w.key('ArrowUp',{shiftKey:true});assert.equal(w.h(),'308px');w.sync();
  w.key('ArrowDown',{shiftKey:true});w.sync();w.key('ArrowDown',{shiftKey:true});w.sync();w.key('ArrowDown',{shiftKey:true});assert.equal(w.h(),'120px','stops at the minimum');w.sync();
  w.key('End');assert.equal(w.px(),w.max());assert.equal(w.saved(),String(w.max()));w.sync();
  w.key('ArrowUp',{shiftKey:true});assert.equal(w.px(),w.max(),'stops at the maximum');
  let prevented=0;w.handle.emit('keydown',{key:'ArrowUp',preventDefault(){prevented++;}});assert.equal(prevented,1);
  w.handle.emit('keydown',{key:'a',preventDefault(){prevented++;}});assert.equal(prevented,1,'other keys are left alone');
  w.key('Home');assert.equal(w.h(),undefined);
});
test('T86 Esc during a drag restores the height from before the drag and is not Esc for the page',async t=>{
  const w=await open(t,{local:{[SHELF_KEY]:'300'}}),{f}=w;
  assert.equal(w.h(),'300px','the remembered height is applied');w.sync();
  w.down(468);w.move(368);assert.equal(w.h(),'400px');
  let prevented=0,stopped=0;doc(f,'keydown',{key:'Escape',preventDefault(){prevented++;},stopPropagation(){stopped++;}});
  assert.ok(prevented>=1&&stopped>=1);assert.equal(w.h(),'300px');assert.equal(w.saved(),'300');assert.equal(w.shell.dataset.shelfResizing,undefined);assert.equal(w.shell.dataset.editing,'true','still in Edit');
  w.move(200);assert.equal(w.h(),'300px','the press is over');w.up();assert.equal(w.saved(),'300');
  // From the default: Esc takes the inline height away again.
  const d=await open(t);d.down(524);d.move(424);assert.equal(d.h(),'344px');doc(d.f,'keydown',{key:'Escape'});assert.equal(d.h(),undefined);assert.equal(d.saved(),undefined);
  // Esc with no drag is not ours.
  prevented=0;doc(d.f,'keydown',{key:'Escape',preventDefault(){prevented++;}});assert.equal(prevented,0);
});
test('T86 a remembered height is applied clamped; one the window cannot hold is only shown clamped, and clamped again when the window changes',async t=>{
  const w=await open(t,{local:{[SHELF_KEY]:'5000'}});
  assert.equal(w.px(),w.max(),'shown clamped');assert.equal(w.saved(),'5000','the stored value is kept');
  w.win.innerHeight=500;w.f.windowEvents.get('resize')();await w.f.drain();
  assert.ok(w.px()<=500-120-SHELF_GRAB-CANVAS_GAP,'clamped again for the smaller window');assert.equal(w.saved(),'5000');
  w.win.innerHeight=1200;w.f.windowEvents.get('resize')();await w.f.drain();assert.ok(w.px()>600,'and larger again when the window is');assert.ok(w.px()<=1200-120-SHELF_GRAB-CANVAS_GAP);assert.equal(w.saved(),'5000');
  // A bad stored value is the stylesheet default.
  for(const bad of ['abc','50','99999'])assert.equal((await open(t,{local:{[SHELF_KEY]:bad}})).h(),undefined,bad);
});
test('T86 storage that throws never breaks the page or the drag',async t=>{
  const w=await open(t),original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{value:{getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');},removeItem(){throw new Error('blocked');}},configurable:true,writable:true});
  t.after(()=>Object.defineProperty(globalThis,'localStorage',original));
  w.down(524);w.move(424);w.up();assert.equal(w.h(),'344px','the height is still set for this session');w.key('Home');assert.equal(w.h(),undefined);
});

test('T86 a touch drag follows the finger by touch events when the system takes the pointer (pointercancel), and ends on touchend or after a bare touchcancel',async t=>{
  const finger=(y,identifier=3)=>{const event={changedTouches:[{identifier,clientX:50,clientY:y}],cancelable:true,prevented:false,preventDefault:()=>{event.prevented=true;}};return event;};
  const w=await open(t),{f}=w;
  w.down(524,{pointerType:'touch'});w.move(480,{pointerType:'touch'});assert.equal(w.h(),'288px');
  const early=finger(470);doc(f,'touchmove',early);assert.equal(early.prevented,true,'the page does not scroll under the finger');assert.equal(w.h(),'288px','pointer events still lead');
  w.handle.emit('pointercancel',{pointerId:1});
  doc(f,'touchmove',finger(430));assert.equal(w.h(),'338px','the finger is followed');doc(f,'touchmove',finger(430,9));assert.equal(w.h(),'338px','another finger is not');
  doc(f,'touchend',finger(424));assert.equal(w.saved(),'338');assert.equal(w.shell.dataset.shelfResizing,undefined);
  // touchcancel and nothing after it: the press ends where it got to.
  w.sync();w.down(500,{pointerType:'touch',pointerId:2});w.handle.emit('pointermove',{pointerId:2,clientY:450});w.handle.emit('pointercancel',{pointerId:2});doc(f,'touchcancel');
  doc(f,'touchmove',finger(400));assert.equal(w.shell.dataset.shelfResizing,'true','a touch event after the cancel shows the finger is down');
  doc(f,'touchcancel');await f.fireTimer(300);assert.equal(w.shell.dataset.shelfResizing,undefined);assert.ok(w.saved());
});
test('T86 only the primary button and primary pointer start a drag',async t=>{
  const w=await open(t);
  w.down(524,{button:2});w.move(424);assert.equal(w.h(),undefined);w.down(524,{isPrimary:false});w.move(424);assert.equal(w.h(),undefined);
  w.down(524);w.handle.emit('pointermove',{pointerId:7,clientY:424});assert.equal(w.h(),undefined,'another pointer does not move it');w.up({pointerId:7});assert.equal(w.shell.dataset.shelfResizing,undefined);
  w.move(424);assert.equal(w.h(),'344px');w.up();
});

test('T86 the T85 card gestures and the canvas stay quiet while the handle is dragged, and the handle works at the Library minimum in narrow layouts',async t=>{
  for(const [width,height] of [[375,812],[812,375],[1366,768]]){
    const w=await open(t,{width,height}),{f}=w;
    w.down(height-244);w.move(height-244+900);assert.equal(w.px(),120,`${width}x${height}: at the minimum`);w.sync();
    assert.equal(w.panel.rect.top,height-120,'the border is where the handle is');
    // The handle lies above the panel's top: its strip is not inside the panel content area.
    w.up();w.down(height-120);w.move(height-120-40);assert.equal(w.px(),Math.min(160,w.max()),'still reachable and draggable from the minimum');w.up();
    w.key('End');assert.ok(w.px()>=120);
    // While dragging, a card press (touch hold) does not start anything: pointer-events:none, and the drag owns the pointer.
    w.down(height-w.px());assert.equal(w.shell.dataset.shelfResizing,undefined,'not before the 3px');w.move(height-w.px()-10);assert.equal(w.shell.dataset.shelfResizing,'true');
    w.up();
  }
  const tabs=rule('.shelf-tabs');assert.doesNotMatch(tabs,/touch-action/);
});
test('T86 the host serves the module and the stylesheet has no literal colors for the handle',()=>{
  assert.match(read('apps/host/server.ts'),/\["\/apps\/web\/library-resize\.js", \["\.\.\/\.\.\/apps\/web\/library-resize\.js"/);
  const lines=css.split('\n').filter(line=>/shelf-resize/.test(line));assert.ok(lines.length>=6);for(const line of lines)assert.doesNotMatch(line,/#[0-9a-fA-F]{3,8}\b/);
});