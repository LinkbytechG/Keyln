import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import * as C from '../dist/packages/contracts/index.js';
import {Scheduler} from '../dist/apps/host/scheduler.js';
import {importPreview} from '../dist/apps/host/layout.js';
import {flowLayout} from '../dist/apps/web/page-view.js';
import {swapWidgets,moveToPageSwap,moveToEmpty,planEmptyDrop,replaceBlank,trimBlanks,moveWidget,removeWidget,moveToPage,containerWidgets} from '../dist/apps/web/page-layout.js';
import {MOVE_MODE_KEY,loadMoveMode,saveMoveMode,DEFAULT_MOVE_MODE} from '../dist/apps/web/move-mode.js';
import {LIBRARY_TYPES,previewsFor} from '../dist/apps/web/library.js';
import {client} from './helpers/client-harness.mjs';
import {key,display,viewOf} from './helpers/layout.mjs';
import {responsiveBoxes,treeFind,treeAll} from './helpers/responsive-boxes.mjs';

// T88 (ADR-083): Swap moving and blanks. The pure rules run on the production page-layout; the page tests run the compiled client against the minimal DOM. They are not browser
// rendering, real touch or Surface evidence.
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const css=read('apps/web/style.css');
const APP={type:'app.open',appId:'test.app'};
const blank=(id,size='S')=>({id,kind:'blank',size});
const flat=(...widgets)=>C.parseConfig({...C.initialView(),revision:2,widgets});
const pagesCfg=(a,b=[])=>C.parseConfig({...C.initialView(),revision:2,widgets:[{id:'main',kind:'pages',pages:[{id:'a',name:'A',widgets:a},{id:'b',name:'B',widgets:b}]}]});
const ids=list=>list.map(w=>w.id);
const kinds=list=>list.map(w=>w.kind==='blank'?`_${w.size}`:w.id);

// ---- the format ---------------------------------------------------------------------------------------------------------------------------------
test('T88 a blank is {id, kind:"blank", size}: valid at the top level and on a page, strict everywhere, never nested; version stays 2',()=>{
  const config=pagesCfg([key('k1'),blank('b1','M'),key('k2')]),top=flat(key('t1'),blank('b2','Wide'),key('t2'));
  assert.equal(config.version,2);assert.deepEqual(config.widgets[0].pages[0].widgets[1],{id:'b1',kind:'blank',size:'M'});assert.deepEqual(top.widgets[1],{id:'b2',kind:'blank',size:'Wide'});
  assert.deepEqual(C.parseConfig(JSON.parse(JSON.stringify(config))),config,'it round-trips');
  const bad=value=>assert.throws(()=>C.parseConfig({...C.initialView(),revision:2,widgets:[value]}),error=>error instanceof C.Fault&&error.code==='INVALID_INPUT');
  for(const extra of [{label:'x'},{icon:'app'},{action:null},{text:'x'},{form:'time'},{color:'blue'}])bad({...blank('x'),...extra});
  bad({id:'x',kind:'blank'});bad({id:'x',kind:'blank',size:'Huge'});bad({...blank('x'),size:7});bad({kind:'blank',size:'S'});
  assert.throws(()=>C.parseConfig({...config,widgets:[{...config.widgets[0],pages:[{id:'a',name:'A',widgets:[{id:'g',kind:'pages',pages:[]}]}]}]}),C.Fault);
  assert.throws(()=>C.parseConfig({...C.initialView(),widgets:[blank('d'),blank('d')]}),C.Fault,'ids stay unique');
  for(const size of C.sizeTiers)C.parseConfig({...C.initialView(),widgets:[blank('x',size)]});
  assert.equal(C.isBlank(blank('x')),true);assert.equal(C.isBlank(key('k')),false);
  assert.deepEqual(C.allComponents(config).map(item=>item.id),['k1','k2'],'a blank is not a component: nothing can run it');
  assert.equal(C.findComponent(config,'b1'),undefined);
  assert.deepEqual(C.widgetSpan(blank('x','Wide')),{cols:4,rows:1});
});
test('T88 an older Host or page rejects a blank with the ordinary refusal (a Fault, never a crash); the page treats it as a connection problem to refresh',()=>{
  // What a page from before T88 does with the new kind: the same parser, a kind it does not know.
  assert.throws(()=>C.parseConfig({...C.initialView(),widgets:[{id:'z',kind:'banana',size:'S'}]}),error=>error instanceof C.Fault&&error.code==='INVALID_INPUT'&&error.status===400&&/supported component type/.test(error.message));
  const app=read('apps/web/app.ts');assert.match(app,/error\.status >= 400 && error\.status < 500\) reconnect\.stop\(\); else reconnect\.failed\(\)/,'a 4xx fault stops the retry loop and shows "Connection unavailable" with the message');
  assert.match(app,/result\("rejected", "Connection unavailable", \(error as Error\)\.message\)/);
});
test('T88 the Host carries blanks through import, export and storage and never runs one',async()=>{
  const config=pagesCfg([key('k1',APP),blank('b1'),key('k2',APP)]),preview=importPreview(JSON.parse(JSON.stringify(config)),[{id:'test.app',name:'Fake app'}],()=>{});
  assert.ok(preview);assert.deepEqual(C.parseConfig(JSON.parse(JSON.stringify(viewOf(JSON.parse(JSON.stringify(config)))))).widgets,config.widgets,'import and restore keep the blank');
  const calls=[],scheduler=new Scheduler({run:async action=>{calls.push(action.type);return {ok:true,message:'Fake only'};}});
  assert.throws(()=>scheduler.trigger('device',{requestId:randomUUID(),componentId:'b1',revision:2},config),error=>error.code==='BUTTON_UNAVAILABLE');
  assert.deepEqual(calls,[]);scheduler.stop();
  assert.equal(C.allComponents(config).length,2);
});
test('T88 the Library never offers a blank',async t=>{
  assert.deepEqual(LIBRARY_TYPES.map(type=>type.key),['app','other','pages','widget']);assert.ok(previewsFor(LIBRARY_TYPES[2]).every(item=>item.spec.type!=='blank'));
  const f=await client(t,{apps:[{id:'test.app',name:'Fake app'}]});f.el('edit-layout').emit('click');f.el('shelf-toggle').emit('click');await f.drain();
  for(let index=0;index<4;index++){
    f.el('shelf-types').children[index].emit('click');await f.drain();
    const cards=f.el('shelf-previews').children.filter(node=>node.className?.includes('shelf-card'));assert.ok(cards.length>0,`tab ${index} has cards`);
    for(const card of cards)assert.doesNotMatch(`${card.getAttribute('aria-label')} ${card.dataset.libraryType} ${card.dataset.form??''}`,/blank|empty/i);
  }
  assert.equal(C.COMPONENT_SIZING.blank.policy,'grid-preset');
});

// ---- the pure rules -----------------------------------------------------------------------------------------------------------------------------
test('T88 swap: two flat widgets trade places in one container and across containers (canvas and pages), keys and display widgets alike',()=>{
  const config=flat(key('k1'),key('k2'),key('k3'));
  assert.deepEqual(ids(swapWidgets(config,'k1','k3').widgets),['k3','k2','k1']);assert.deepEqual(ids(swapWidgets(config,'k3','k1').widgets),['k3','k2','k1']);
  const mixed=pagesCfg([key('k1'),display('c','clock','time',{},{size:'M'}),key('k2')],[key('k3'),display('t','text','title',{},{text:'Hi'})]);
  const same=swapWidgets(mixed,'k1','c');assert.deepEqual(ids(same.widgets[0].pages[0].widgets),['c','k1','k2']);
  const across=swapWidgets(mixed,'k1','t');assert.deepEqual(ids(across.widgets[0].pages[0].widgets),['t','c','k2']);assert.deepEqual(ids(across.widgets[0].pages[1].widgets),['k3','k1']);
  const canvas=C.parseConfig({...mixed,widgets:[key('top'),...mixed.widgets]}),moved=swapWidgets(canvas,'top','k3');
  assert.equal(moved.widgets[0].id,'k3');assert.equal(containerWidgets(moved,{pagesId:'main',pageId:'b'})[0].id,'top');
  assert.deepEqual(config.widgets.map(w=>w.id),['k1','k2','k3'],'the input is not changed');
  assert.throws(()=>swapWidgets(config,'k1','k1'),C.Fault);assert.throws(()=>swapWidgets(config,'k1','nope'),C.Fault);
  const withPages=C.parseConfig({...C.initialView(),widgets:[key('top'),{id:'main',kind:'pages',pages:[{id:'a',name:'A',widgets:[]}]}]});
  assert.throws(()=>swapWidgets(withPages,'top','main'),C.Fault);assert.throws(()=>swapWidgets(withPages,'main','top'),C.Fault,'Pages groups keep Insert behavior');
  assert.equal(swapWidgets(config,'k1','k3').widgets.every(w=>w.size==='S'),true);
});
test('T88 swap with a blank: the component takes the blank\'s place and a blank of the component\'s size appears at its old place',()=>{
  const config=flat(key('k1',null,{size:'Wide'}),blank('b1','S'),key('k2'));
  const a=swapWidgets(config,'k1','b1');
  assert.deepEqual(kinds(a.widgets),['_Wide','k1','k2'],'a Wide blank where the Wide key was');assert.equal(a.widgets[1].size,'Wide','the key keeps its size');
  const b=swapWidgets(config,'b1','k1');assert.deepEqual(kinds(b.widgets),['_Wide','k1','k2'],'dragging the blank onto a key trades them too: the blank takes the size of what left that place');
  assert.deepEqual(ids(b.widgets).slice(1),['k1','k2']);
  const two=flat(blank('b1','S'),blank('b2','Tall'),key('k'));assert.deepEqual(swapWidgets(two,'b1','b2').widgets.map(w=>w.size),['Tall','S','S'],'two blanks just trade');
  const pages=pagesCfg([key('k1'),key('k2')],[blank('pb','M'),key('k3')]);
  const across=swapWidgets(pages,'k1','pb');
  assert.deepEqual(kinds(across.widgets[0].pages[0].widgets),['_S','k2'],'the page it left keeps an S blank');assert.deepEqual(kinds(across.widgets[0].pages[1].widgets),['k1','k3']);
  assert.equal(across.widgets[0].pages[1].widgets[0].size,'S');
});
test('T88 trailing blanks are trimmed by every change; blanks in the middle stay',()=>{
  const config=flat(key('k1'),blank('m'),key('k2'),key('k3'));
  const moved=swapWidgets(config,'k3','k2');assert.deepEqual(ids(moved.widgets),['k1','m','k3','k2']);
  const last=flat(key('k1'),key('k2'),blank('m'),key('k3'));
  assert.deepEqual(kinds(swapWidgets(last,'k3','m').widgets),['k1','k2','k3'],'the blank that moved to the end is gone');
  assert.deepEqual(kinds(removeWidget(flat(key('k1'),blank('m'),key('k2')),'k2').widgets),['k1'],'removing the last item takes the blank before it too');
  assert.deepEqual(kinds(moveWidget(flat(key('k1'),blank('m'),key('k2')),'k2',{},0).widgets),['k2','k1'],'Insert mode trims too');
  const same=flat(key('k1'),key('k2'));assert.equal(trimBlanks(same),same,'nothing to trim: the same object');
  const dirty={...same,widgets:[key('k1'),blank('x'),blank('y')]};assert.deepEqual(ids(trimBlanks(dirty).widgets),['k1']);
  const paged=pagesCfg([key('k1'),blank('p')],[blank('q')]);assert.deepEqual(paged.widgets[0].pages.map(page=>page.widgets.length),[2,1]);assert.deepEqual(trimBlanks(paged).widgets[0].pages.map(page=>page.widgets.length),[1,0]);
});
test('T88 a page tab: the component goes to the end of that page and an S-sized blank (its own size) stays; the same page is refused',()=>{
  const config=pagesCfg([key('k1'),key('k2',null,{size:'M'}),key('k3')],[key('x')]);
  const next=moveToPageSwap(config,'k2','main','b');
  assert.deepEqual(kinds(next.widgets[0].pages[0].widgets),['k1','_M','k3']);assert.deepEqual(ids(next.widgets[0].pages[1].widgets),['x','k2']);
  assert.deepEqual(kinds(moveToPageSwap(config,'k3','main','b').widgets[0].pages[0].widgets),['k1','k2'],'a blank left at the end is trimmed');
  assert.throws(()=>moveToPageSwap(config,'k1','main','a'),C.Fault);
  assert.deepEqual(kinds(moveToPage(config,'k2','main','b').widgets[0].pages[0].widgets),['k1','k3'],'Insert mode: the old behavior');
});
// A real flow: the same engine the canvas uses.
const placeIn=(width=560)=>trial=>flowLayout(trial,width,'standard',8,14).placements;
test('T88 empty area: planEmptyDrop simulates the flow and fills S blanks to reach the exact cell (T89: exact or nothing)',()=>{
  const place=placeIn(900),columns=flowLayout([key('k1')],900,'standard',8,14).columns;
  assert.ok(columns>=7,`${columns} columns`);
  const two=[key('k1'),key('k2')],moved=key('m');
  assert.deepEqual(planEmptyDrop(two,moved,{x:2,y:0},place,columns),{index:2,fills:0,x:2,y:0},'the first free cell needs no filler');
  assert.deepEqual(planEmptyDrop(two,moved,{x:columns-1,y:0},place,columns),{index:2,fills:columns-3,x:columns-1,y:0});
  assert.deepEqual(planEmptyDrop(two,moved,{x:1,y:2},place,columns),{index:2,fills:2*columns-1,x:1,y:2},'rows below are reached with S blanks');
  assert.equal(planEmptyDrop(two,moved,{x:0,y:0},place,columns),undefined,'a cell that holds an item is not a place');
  const wide=key('w',null,{size:'Wide'});
  assert.deepEqual(planEmptyDrop(two,wide,{x:columns-1,y:0},place,columns),{index:2,fills:columns-4-2,x:columns-4,y:0},'a Wide key near the right edge is pulled left to where it fits');
  assert.ok(planEmptyDrop(two,moved,{x:0,y:9999},place,columns)===undefined,'the loop is bounded');
});
test('T88 moving to empty area leaves a blank of the same size where it was, fills S blanks, and puts the component last',()=>{
  const config=pagesCfg([key('k1',null,{size:'M'}),key('k2'),key('k3')],[key('x')]);
  const same=moveToEmpty(config,'k1',{pagesId:'main',pageId:'a'},2);
  assert.deepEqual(kinds(same.widgets[0].pages[0].widgets),['_M','k2','k3','_S','_S','k1']);
  const other=moveToEmpty(config,'k3',{pagesId:'main',pageId:'b'},1);
  assert.deepEqual(kinds(other.widgets[0].pages[0].widgets),['k1','k2'],'the blank left at the end of the source is trimmed');assert.deepEqual(kinds(other.widgets[0].pages[1].widgets),['x','_S','k3']);
  assert.deepEqual(kinds(moveToEmpty(config,'k1',{pagesId:'main',pageId:'a'},0).widgets[0].pages[0].widgets),['_M','k2','k3','k1']);
  assert.throws(()=>moveToEmpty(config,'k1',{pagesId:'main',pageId:'a'},-1),C.Fault);assert.throws(()=>moveToEmpty(config,'k1',{pagesId:'main',pageId:'a'},1.5),C.Fault);
  assert.throws(()=>moveToEmpty(flat(key('t'),{id:'g',kind:'pages',pages:[{id:'p',name:'P',widgets:[]}]}),'g',{},0),C.Fault);
});
test('T88 a Library item dropped on a blank takes its place; nothing else is replaced',()=>{
  const config=pagesCfg([key('k1'),blank('b1','Wide'),key('k2')]);
  const next=replaceBlank(config,key('new'),'b1');assert.deepEqual(ids(next.widgets[0].pages[0].widgets),['k1','new','k2']);
  assert.throws(()=>replaceBlank(config,key('new'),'k1'),C.Fault,'not on a key');assert.throws(()=>replaceBlank(config,key('k2'),'b1'),C.Fault,'ids stay unique');
  assert.throws(()=>replaceBlank(config,{id:'g',kind:'pages',pages:[]},'b1'),C.Fault,'a Pages widget cannot sit on a page');
});

// ---- the setting --------------------------------------------------------------------------------------------------------------------------------
test('T88 the setting: Swap by default; only "insert" selects Insert; damaged, missing or throwing storage is Swap; saving never throws',()=>{
  assert.equal(MOVE_MODE_KEY,'keyln.moveMode.v1');assert.equal(DEFAULT_MOVE_MODE,'swap');
  const from=value=>loadMoveMode({getItem:()=>value});
  assert.equal(from('insert'),'insert');assert.equal(from('swap'),'swap');for(const bad of [null,undefined,'','INSERT','1','{"mode":"insert"}','insert '])assert.equal(from(bad),'swap',String(bad));
  assert.equal(loadMoveMode(undefined),'swap');assert.equal(loadMoveMode({getItem(){throw new Error('blocked');}}),'swap');
  const log=[];assert.equal(saveMoveMode({setItem:(k,v)=>log.push([k,v])},'insert'),true);assert.deepEqual(log,[[MOVE_MODE_KEY,'insert']]);
  assert.equal(saveMoveMode(undefined,'swap'),false);assert.equal(saveMoveMode({setItem(){throw new Error('quota');}},'swap'),false);
});
test('T88 the gear menu has a 36px two-choice "Moving keys" control for this screen only; it saves per device and follows the stored value',async t=>{
  const f=await client(t,{moveMode:null}),{el}=f;
  assert.equal(el('move-mode-swap').getAttribute('aria-pressed'),'true','Swap is the default');assert.equal(el('move-mode-insert').getAttribute('aria-pressed'),'false');
  assert.equal(el('move-mode-swap').textContent,'Swap');assert.equal(el('move-mode-insert').textContent,'Insert');assert.match(el('move-mode-note').textContent,/trades places/);
  el('move-mode-insert').emit('click');assert.equal(f.local.get('keyln.moveMode.v1'),'insert');assert.equal(el('move-mode-insert').getAttribute('aria-pressed'),'true');assert.equal(el('move-mode-swap').getAttribute('aria-pressed'),'false');assert.match(el('move-mode-note').textContent,/close up/);
  el('move-mode-swap').emit('click');assert.equal(f.local.get('keyln.moveMode.v1'),'swap');
  assert.equal((await client(t,{moveMode:'insert'})).el('move-mode-insert').getAttribute('aria-pressed'),'true','the stored choice is shown');
  assert.equal((await client(t,{moveMode:'nonsense'})).el('move-mode-swap').getAttribute('aria-pressed'),'true','bad storage is Swap');
  const widget=read('apps/web/widgets/settings.ts');assert.ok(widget.indexOf('moving')>widget.indexOf('theme-section'),'near the Theme section');assert.match(widget,/text: "This screen only"/);
  const choice=/\.move-choice\{([^}]*)\}/.exec(css)[1];assert.match(choice,/min-height:var\(--ctl-h\)/);assert.match(css,/--ctl-h:36px/);assert.doesNotMatch(choice,/#[0-9a-fA-F]{3,8}\b/);
});

// ---- the page -----------------------------------------------------------------------------------------------------------------------------------
async function world(t,config,{mode='swap',width=1366,height=768}={}){
  const f=await client(t,{configuration:C.parseConfig({...config,revision:2}),viewport:{width,height},moveMode:mode});
  await f.until(()=>f.el('edit-layout').disabled===false&&f.state&&f.sockets[0]?.readyState===1);await f.drain();
  const boxes=()=>responsiveBoxes(f),node=id=>treeFind(f.el('button-grid'),n=>n.dataset?.widgetId===id||n.dataset?.buttonId===id);
  const center=n=>[n.rect.left+n.rect.width/2,n.rect.top+n.rect.height/2];
  const saves=()=>f.calls.filter(call=>call.path==='/api/configuration/save');
  const enter=async()=>{f.el('edit-layout').emit('click');await f.drain();};
  // Edit: press on a node, move past the threshold, follow the pointer on the document, let go.
  const drag=async(id,to,pointerId=1)=>{boxes();const source=node(id),from=center(source);
    source.emit('pointerdown',{isPrimary:true,button:0,pointerId,pointerType:'mouse',clientX:from[0],clientY:from[1]});
    source.emit('pointermove',{pointerId,clientX:from[0]+20,clientY:from[1]+20});
    f.documentEvents.get('pointermove')({pointerId,clientX:to[0],clientY:to[1]});
    const hover={ghost:treeFind(f.el('button-grid'),n=>n.className==='drop-ghost'),marked:treeAll(f.el('button-grid'),n=>n.dataset?.dropTarget==='true').map(n=>n.dataset.widgetId||n.dataset.buttonId)};
    f.documentEvents.get('pointerup')({pointerId,clientX:to[0],clientY:to[1]});await f.drain();return hover;};
  const draft=async()=>{const before=saves().length;f.el('desk-save').emit('click');await f.until(()=>saves().length>before);await f.drain();return C.parseConfig(saves().at(-1).data);};
  return {f,boxes,node,center,saves,enter,drag,draft};
}
const topIds=config=>kinds(config.widgets);
const pageIds=(config,index=0)=>kinds(config.widgets[0].pages[index].widgets);

test('T88 Edit, Swap: dropping a key on another key trades places; the target is highlighted and there is no insertion line; one Undo step',async t=>{
  const w=await world(t,flat(key('k1',APP),key('k2',APP),key('k3',APP)));await w.enter();
  const hover=await w.drag('k1',(w.boxes(),w.center(w.node('k3'))));
  assert.deepEqual(hover.marked,['k3'],'the target is outlined');assert.ok(!hover.ghost||hover.ghost.hidden===true,'no insertion line');
  assert.equal(w.f.el('button-grid').dataset.lifted,undefined);
  assert.deepEqual(topIds(await w.draft()),['k3','k2','k1']);
  w.f.el('edit-undo').emit('click');await w.f.drain();assert.equal(w.f.el('edit-undo').disabled,true,'one move is one Undo step');
  assert.deepEqual(w.f.button('k1')&&['k1','k2','k3'].map(id=>w.f.button(id)?.dataset.buttonId),['k1','k2','k3']);
});
test('T88 Edit, Swap: dropping on a blank puts the key there and leaves a blank of the key\'s size; dropping on empty area fills S blanks',async t=>{
  const config=flat(key('k1',APP,{size:'S'}),blank('b1'),key('k2',APP),key('k3',APP));
  const w=await world(t,config);await w.enter();
  await w.drag('k1',(w.boxes(),w.center(w.node('b1'))));
  assert.deepEqual(topIds(await w.draft()),['_S','k1','k2','k3'],'trade with the blank');
  const v=await world(t,flat(key('k1',APP),key('k2',APP),key('k3',APP)));await v.enter();v.boxes();
  const pitch=v.node('k2').rect.left-v.node('k1').rect.left,last=v.node('k3').rect;
  const hover=await v.drag('k1',[last.left+2.5*pitch+pitch/2-last.width/2+last.width/2,last.top+last.height/2]);
  assert.ok(hover.ghost&&hover.ghost.dataset.shape==='cell'&&hover.ghost.hidden===false,'a ghost cell shows where it will land');
  const saved=await v.draft();assert.equal(saved.widgets.at(-1).id,'k1');assert.equal(saved.widgets[0].kind,'blank','the old place is a blank');assert.equal(saved.widgets[0].size,'S');
  assert.ok(saved.widgets.slice(3,-1).every(item=>item.kind==='blank'&&item.size==='S'),'S blanks fill the gap');assert.ok(saved.widgets.length>=5);
});
test('T88 Edit, Swap: a page tab keeps "append to that page" and leaves a blank; Insert mode closes the gap as before',async t=>{
  const config=pagesCfg([key('k1',APP),key('k2',APP),key('k3',APP)],[key('x',APP)]);
  const w=await world(t,config);await w.enter();w.boxes();
  await w.drag('k2',(w.boxes(),w.center(w.f.page('b'))));
  const saved=await w.draft();assert.deepEqual(pageIds(saved,0),['k1','_S','k3']);assert.deepEqual(pageIds(saved,1),['x','k2']);
  const v=await world(t,config,{mode:'insert'});await v.enter();v.boxes();
  await v.drag('k2',(v.boxes(),v.center(v.f.page('b'))));
  const insert=await v.draft();assert.deepEqual(pageIds(insert,0),['k1','k3']);assert.deepEqual(pageIds(insert,1),['x','k2']);
});
test('T88 Edit, Swap across containers: a canvas key dropped on a key of a page trades with it',async t=>{
  const config=C.parseConfig({...C.initialView(),revision:2,widgets:[key('top',APP),{id:'main',kind:'pages',pages:[{id:'a',name:'A',widgets:[key('k1',APP),key('k2',APP)]}]}]});
  const w=await world(t,config);await w.enter();
  const hover=await w.drag('top',(w.boxes(),w.center(w.node('k2'))));
  assert.deepEqual(hover.marked,['k2']);
  const saved=await w.draft(),group=saved.widgets.find(item=>item.kind==='pages');assert.deepEqual(saved.widgets.map(item=>item.id),['k2','main']);assert.deepEqual(kinds(group.pages[0].widgets),['k1','top']);
});
test('T88 Edit, Insert mode is unchanged: an insertion line, and the order closes up',async t=>{
  const w=await world(t,flat(key('k1',APP),key('k2',APP),key('k3',APP)),{mode:'insert'});await w.enter();
  const k3=(w.boxes(),w.node('k3').rect);
  const hover=await w.drag('k1',[k3.left+k3.width*0.9,k3.top+k3.height/2]);
  assert.deepEqual(hover.marked,[]);assert.ok(hover.ghost&&hover.ghost.dataset.shape===undefined);
  assert.deepEqual(topIds(await w.draft()),['k2','k3','k1']);
});

test('T88 Use mode: a blank is empty space of its size: not seen, not focusable, not announced, not a button, and it keeps its place in the flow',async t=>{
  const w=await world(t,pagesCfg([key('k1',APP),blank('b1','M'),key('k2',APP)]));
  w.boxes();const hole=w.node('b1'),k1=w.node('k1'),k2=w.node('k2');
  assert.ok(hole,'it is in the DOM so the flow keeps its place');assert.equal(hole.dataset.kind,'blank');assert.equal(hole.getAttribute('aria-hidden'),'true');
  assert.equal(hole.getAttribute('tabindex'),null);assert.equal(hole.getAttribute('role'),null);assert.equal(hole.dataset.editing,undefined);assert.equal(hole.textContent,'');assert.equal(hole.children.length,0);
  assert.equal(treeFind(w.f.el('button-grid'),n=>n.dataset?.removeFor==='b1'),undefined,'no "−" in Use');
  assert.equal(hole.listeners.size,0,'no listeners: nothing to press');
  assert.ok(parseFloat(hole.style['--kw'])>parseFloat(k1.style['--kw'])*1.5,'an M blank is as wide as an M key');
  assert.ok(parseFloat(k2.style['--kx'])>=parseFloat(hole.style['--kx'])+parseFloat(hole.style['--kw'])-.5,'the next key sits after it');
  const rule=/\.canvas-widget\[data-kind=blank\]\{([^}]*)\}/.exec(css)[1];assert.match(rule,/visibility:hidden/);assert.match(rule,/pointer-events:none/);
  assert.match(w.f.el('button-grid').getAttribute('aria-label'),/2 components/,'a blank is not counted');
});
test('T88 Edit: a blank is a faint dashed square with a "−" that removes it; it opens no settings card and its menu is only Remove',async t=>{
  const w=await world(t,pagesCfg([key('k1',APP),blank('b1','L'),key('k2',APP)]));await w.enter();w.boxes();
  const hole=w.node('b1');assert.equal(hole.dataset.editing,'true');assert.equal(hole.getAttribute('aria-hidden'),null);assert.equal(hole.getAttribute('aria-label'),'Empty space');
  const rule=/\.canvas-widget\[data-kind=blank\]\[data-editing=true\]\{([^}]*)\}/.exec(css)[1];assert.match(rule,/border:1\.5px dashed var\(--line\)/);assert.match(rule,/border-radius:var\(--radius-key\)/);assert.match(rule,/visibility:visible/);assert.doesNotMatch(rule,/#[0-9a-fA-F]{3,8}\b/);
  hole.emit('click',{detail:1});await w.f.drain();assert.equal(w.f.el('editor').hidden,true,'no settings card');
  hole.emit('contextmenu',{clientX:10,clientY:10});assert.deepEqual(w.f.el('edit-menu').children.map(n=>n.textContent),['Remove']);
  w.f.el('edit-menu').children[0].emit('click');await w.f.drain();assert.equal(w.node('b1'),undefined,'Remove from the menu');
  const v=await world(t,pagesCfg([key('k1',APP),blank('b1','L'),key('k2',APP)]));await v.enter();
  const minus=treeFind(v.f.el('button-grid'),n=>n.dataset?.removeFor==='b1');assert.ok(minus);assert.match(minus.getAttribute('aria-label'),/empty space/);
  minus.emit('click');await v.f.drain();assert.equal(v.node('b1'),undefined);assert.deepEqual(pageIds(await v.draft()),['k1','k2'],'later items move up');
});
test('T88 Use, Swap: a long-press move trades places and saves once; Undo saves once more; Insert keeps its behavior',async t=>{
  const config=pagesCfg([key('k1',APP),key('k2',APP),key('k3',APP)]);
  const w=await world(t,config);w.boxes();
  const press=async(id,to)=>{w.boxes();const node=w.node(id),from=w.center(node);node.emit('pointerdown',{isPrimary:true,button:0,pointerId:1,pointerType:'mouse',clientX:from[0],clientY:from[1]});await w.f.fireTimer(550);
    w.f.documentEvents.get('pointermove')({pointerId:1,clientX:to[0],clientY:to[1]});w.f.documentEvents.get('pointerup')({pointerId:1,clientX:to[0],clientY:to[1]});await w.f.drain();await w.f.drain();};
  w.boxes();await press('k1',w.center(w.node('k3')));
  assert.equal(w.saves().length,1,'one save');assert.deepEqual(pageIds(C.parseConfig(w.saves()[0].data)),['k3','k2','k1']);
  assert.equal(w.f.el('move-undo').hidden,false);w.f.el('move-undo').emit('click');await w.f.drain();await w.f.drain();
  assert.equal(w.saves().length,2,'Undo is one more save');assert.deepEqual(pageIds(C.parseConfig(w.saves()[1].data)),['k1','k2','k3']);
  const v=await world(t,config,{mode:'insert'});v.boxes();
  const node=v.node('k1'),from=v.center(node);node.emit('pointerdown',{isPrimary:true,button:0,pointerId:1,pointerType:'mouse',clientX:from[0],clientY:from[1]});await v.f.fireTimer(550);
  const k3=v.node('k3').rect;v.f.documentEvents.get('pointermove')({pointerId:1,clientX:k3.left+k3.width*.9,clientY:k3.top+k3.height/2});v.f.documentEvents.get('pointerup')({pointerId:1,clientX:k3.left+k3.width*.9,clientY:k3.top+k3.height/2});await v.f.drain();await v.f.drain();
  assert.deepEqual(pageIds(C.parseConfig(v.saves()[0].data)),['k2','k3','k1']);
});
test('T88 Use, Swap: a key dropped on empty space leaves a blank behind and saves once',async t=>{
  const w=await world(t,flat(key('k1',APP),key('k2',APP),key('k3',APP)));w.boxes();
  const pitch=w.node('k2').rect.left-w.node('k1').rect.left,last=w.node('k3').rect,node=w.node('k1'),from=w.center(node);
  node.emit('pointerdown',{isPrimary:true,button:0,pointerId:1,pointerType:'mouse',clientX:from[0],clientY:from[1]});await w.f.fireTimer(550);
  const to=[last.left+pitch*1.5+last.width/2,last.top+last.height/2];
  w.f.documentEvents.get('pointermove')({pointerId:1,clientX:to[0],clientY:to[1]});w.f.documentEvents.get('pointerup')({pointerId:1,clientX:to[0],clientY:to[1]});await w.f.drain();await w.f.drain();
  assert.equal(w.saves().length,1);const saved=C.parseConfig(w.saves()[0].data);assert.equal(saved.widgets[0].kind,'blank');assert.equal(saved.widgets.at(-1).id,'k1');
});
test('T88 Library, Swap: an item dropped on a blank takes its place; on a key or empty area it inserts and deletes nothing',async t=>{
  const lib=async(world)=>{world.f.el('shelf-toggle').emit('click');await world.f.drain();world.f.el('shelf-types').children[1].emit('click');await world.f.drain();return world.f.el('shelf-previews').children.find(n=>n.className?.includes('shelf-card'));};
  const dragCard=async(world,card,to)=>{card.emit('pointerdown',{isPrimary:true,button:0,pointerId:5,pointerType:'mouse',clientX:5,clientY:5});card.emit('pointermove',{pointerId:5,clientX:40,clientY:40});
    world.f.documentEvents.get('pointermove')({pointerId:5,clientX:to[0],clientY:to[1]});world.f.documentEvents.get('pointerup')({pointerId:5,clientX:to[0],clientY:to[1]});await world.f.drain();};
  const onBlank=await world(t,pagesCfg([key('k1',APP),blank('b1'),key('k2',APP)]));await onBlank.enter();
  const card=await lib(onBlank);onBlank.boxes();await dragCard(onBlank,card,onBlank.center(onBlank.node('b1')));
  const placed=await onBlank.draft();assert.equal(placed.widgets[0].pages[0].widgets.length,3,'the blank is replaced, nothing else');assert.equal(placed.widgets[0].pages[0].widgets[1].kind,'key');assert.deepEqual(ids(placed.widgets[0].pages[0].widgets).filter((id,i)=>i!==1),['k1','k2']);
  const onKey=await world(t,pagesCfg([key('k1',APP),blank('b1'),key('k2',APP)]));await onKey.enter();
  const card2=await lib(onKey);onKey.boxes();await dragCard(onKey,card2,onKey.center(onKey.node('k2')));
  const inserted=await onKey.draft(),list=inserted.widgets[0].pages[0].widgets;assert.equal(list.length,4,'inserted');assert.ok(['k1','b1','k2'].every(id=>ids(list).includes(id)),'no existing component is replaced');
});
test('T88 the host serves the move-mode module',()=>{
  assert.match(read('apps/host/server.ts'),/\["\/apps\/web\/move-mode\.js", \["\.\.\/\.\.\/apps\/web\/move-mode\.js"/);
});

test('a blank under a held key is visible as a drop target in Use too', () => {
  const css = readFileSync(new URL('../apps/web/style.css', import.meta.url), 'utf8');
  const rule = css.match(/\.canvas-widget\[data-kind=blank\]\[data-drop-target=true\]\{([^}]*)\}/);
  assert.ok(rule, 'blank drop-target rule exists');
  assert.match(rule[1], /visibility:visible/);
  assert.match(css, /\.canvas-widget\[data-drop-target=true\]\{outline:2px dashed var\(--accent\)/);
});
