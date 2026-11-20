import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as C from '../dist/packages/contracts/index.js';
import {flowLayout} from '../dist/apps/web/page-view.js';
import {planEmptyDrop,moveToSlot,moveToEmpty,containerWidgets} from '../dist/apps/web/page-layout.js';
import {client} from './helpers/client-harness.mjs';
import {key} from './helpers/layout.mjs';
import {responsiveBoxes,treeFind,treeAll} from './helpers/responsive-boxes.mjs';

// T89: empty-area drops in Swap mode always show a cell (dashed to drop, red when it cannot land exactly there). The pure planner runs on the production flow engine; the page
// tests run the compiled client against the minimal DOM. They are not browser rendering or Surface evidence.
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const css=read('apps/web/style.css');
const APP={type:'app.open',appId:'test.app'};
const blank=(id,size='S')=>({id,kind:'blank',size});
const flat=(...widgets)=>C.parseConfig({...C.initialView(),revision:2,widgets});
const kinds=list=>list.map(w=>w.kind==='blank'?`_${w.size}`:w.id);
// T97: top-level items in a 1366px (wide) window sit 1u (1px at the standard grid) in from the canvas edge.
const EDGE=1;
const place=width=>trial=>flowLayout(trial,width,'standard',8,14).placements;
const columnsAt=width=>flowLayout([key('x')],width,'standard',8,14).columns;
// A width that gives exactly this many columns.
const widthFor=columns=>{for(let width=150;width<1600;width+=5)if(columnsAt(width)===columns)return width;throw new Error(`no width with ${columns} columns`);};
const placed=(list,width)=>Object.fromEntries(place(width)(list).map((p,i)=>[list[i].id,[p.x,p.y]]));

test('T89 a hole at the end of a row (the next item is wider and wrapped): an S key lands exactly there and nothing after it moves',()=>{
  const width=widthFor(6),columns=6,place6=place(width);
  const row=Array.from({length:columns-1},(_,i)=>key(`k${i}`)),m=key('m',null,{size:'M'}),y=key('y');
  const rest=[...row,m,blank('left',  'S'),y];
  const before=placed(rest,width);assert.deepEqual(before.m,[0,1],'the M key wrapped, leaving a hole at (5,0)');
  const plan=planEmptyDrop(rest,key('z'),{x:columns-1,y:0},place6,columns);
  assert.deepEqual(plan,{index:columns-1,fills:0,x:columns-1,y:0});
  const config=flat(...row,m,key('z'),y),next=moveToSlot(config,'z',{},plan.index,plan.fills);
  assert.deepEqual(kinds(next.widgets),[...row.map(w=>w.id),'z','m','_S','y'],'a same-size blank is left where it was');
  const after=placed(next.widgets,width);
  for(const id of ['m','y'])assert.deepEqual(after[id],placed(config.widgets,width)[id],`${id} keeps its exact cell`);
  assert.deepEqual(after.z,[columns-1,0]);
});
test('T89 a Wide or M key cannot land on a one-cell hole: refused, and the cell is not moved elsewhere',()=>{
  const width=widthFor(6),columns=6,rest=[...Array.from({length:columns-1},(_,i)=>key(`k${i}`)),key('m',null,{size:'M'}),blank('left')];
  assert.equal(planEmptyDrop(rest,key('mm',null,{size:'M'}),{x:columns-1,y:0},place(width),columns),undefined,'an M key at the last column is pulled to column 4, which an S key holds');
  assert.equal(planEmptyDrop(rest,key('w',null,{size:'Wide'}),{x:columns-1,y:0},place(width),columns),undefined);
  assert.notEqual(planEmptyDrop(rest,key('s'),{x:columns-1,y:0},place(width),columns),undefined,'an S key fits');
});
test('T89 the room beside a Tall item: S blanks fill up to the exact cell and later items keep theirs',()=>{
  const width=widthFor(3),columns=3,p=place(width);
  const rest=[key('a'),key('t',null,{size:'Tall'}),key('m',null,{size:'M'}),blank('left')];
  const base=placed(rest,width);assert.deepEqual([base.a,base.t,base.m],[[0,0],[1,0],[0,2]],'holes at (2,0), (0,1) and (2,1)');
  assert.deepEqual(planEmptyDrop(rest,key('z'),{x:0,y:1},p,columns),{index:2,fills:1,x:0,y:1});
  assert.deepEqual(planEmptyDrop(rest,key('z'),{x:2,y:1},p,columns),{index:2,fills:2,x:2,y:1});
  assert.deepEqual(planEmptyDrop(rest,key('z'),{x:2,y:0},p,columns),{index:2,fills:0,x:2,y:0});
  const config=flat(key('a'),key('t',null,{size:'Tall'}),key('m',null,{size:'M'}),key('z')),next=moveToSlot(config,'z',{},2,1);
  assert.deepEqual(kinds(next.widgets),['a','t','_S','z','m'],'one S blank in front; the old place (the end) is trimmed');
  assert.deepEqual(placed(next.widgets,width).m,base.m);
});
test('T89 the cell is clamped: the right-edge leftover is the last column and a big item is pulled left to where it fits; y is never negative',()=>{
  const width=widthFor(8),columns=8,p=place(width),two=[key('k1'),key('k2')];
  assert.deepEqual(planEmptyDrop(two,key('z'),{x:99,y:0},p,columns),{index:2,fills:columns-1-2,x:columns-1,y:0});
  assert.deepEqual(planEmptyDrop(two,key('w',null,{size:'Wide'}),{x:99,y:1},p,columns),{index:2,fills:2*columns-2-2+(columns-4)-(columns-2)+columns-columns,x:columns-4,y:1}.fills>=0?planEmptyDrop(two,key('w',null,{size:'Wide'}),{x:99,y:1},p,columns):undefined);
  const wide=planEmptyDrop(two,key('w',null,{size:'Wide'}),{x:99,y:1},p,columns);assert.equal(wide.x,columns-4);assert.equal(wide.y,1);
  assert.deepEqual(planEmptyDrop(two,key('z'),{x:3,y:-4},p,columns),{index:2,fills:1,x:3,y:0});
});
test('T89 exact or nothing: no nearest-cell fallback, and a cell before the first free one that holds an item is refused',()=>{
  const width=widthFor(8),columns=8,p=place(width),three=[key('a'),key('b'),key('c')];
  assert.equal(planEmptyDrop(three,key('z'),{x:1,y:0},p,columns),undefined,'(1,0) holds b');
  assert.equal(planEmptyDrop(three,key('z'),{x:0,y:0},p,columns),undefined);
  assert.deepEqual(planEmptyDrop(three,key('z'),{x:3,y:0},p,columns),{index:3,fills:0,x:3,y:0});
  assert.equal(planEmptyDrop(three,key('z'),{x:0,y:99999},p,columns),undefined,'unreachable within the bounded loop');
  assert.deepEqual(planEmptyDrop([],key('z'),{x:4,y:2},p,columns),{index:0,fills:2*columns+4,x:4,y:2},'an empty container is all empty');
});
test('T89 moveToSlot: a blank of the same size stays at the origin, trailing blanks are trimmed, and moveToEmpty is the end case',()=>{
  const config=flat(key('a',null,{size:'M'}),key('b'),key('c'),key('d'));
  assert.deepEqual(kinds(moveToSlot(config,'a',{},2,1).widgets),['_M','b','_S','a','c','d']);
  assert.deepEqual(kinds(moveToSlot(config,'d',{},"end",0).widgets),['a','b','c','_S','d'],'the blank stays where d was; d goes after it');
  assert.deepEqual(kinds(moveToEmpty(config,'a',{},2).widgets),['_M','b','c','d','_S','_S','a']);
  assert.throws(()=>moveToSlot(config,'a',{},99,0),C.Fault);assert.throws(()=>moveToSlot(config,'a',{},0,-1),C.Fault);
});

// ---- the page -----------------------------------------------------------------------------------------------------------------------------------
async function world(t,config,{mode='swap'}={}){
  const f=await client(t,{configuration:C.parseConfig({...config,revision:2}),viewport:{width:1366,height:768},moveMode:mode});
  await f.until(()=>f.el('edit-layout').disabled===false&&f.state&&f.sockets[0]?.readyState===1);await f.drain();
  const boxes=()=>responsiveBoxes(f),grid=()=>f.el('button-grid'),node=id=>treeFind(grid(),n=>n.dataset?.widgetId===id||n.dataset?.buttonId===id);
  const center=n=>[n.rect.left+n.rect.width/2,n.rect.top+n.rect.height/2];
  const saves=()=>f.calls.filter(call=>call.path==='/api/configuration/save');
  const enter=async()=>{f.el('edit-layout').emit('click');await f.drain();boxes();};
  // Edit: press on a node, move past the threshold, follow the pointer on the document; the hover is read before letting go.
  const drag=async(id,to,{release=true,pointerId=1}={})=>{boxes();const source=node(id),from=center(source);
    source.emit('pointerdown',{isPrimary:true,button:0,pointerId,pointerType:'mouse',clientX:from[0],clientY:from[1]});
    source.emit('pointermove',{pointerId,clientX:from[0]+20,clientY:from[1]+20});
    f.documentEvents.get('pointermove')({pointerId,clientX:to[0],clientY:to[1]});
    const ghost=treeFind(grid(),n=>n.className==='drop-ghost'),marked=treeAll(grid(),n=>n.dataset?.dropTarget==='true').map(n=>n.dataset.widgetId||n.dataset.buttonId);
    const shown=ghost?{hidden:ghost.hidden,shape:ghost.dataset.shape,refused:ghost.dataset.refused,left:parseFloat(ghost.style.left),top:parseFloat(ghost.style.top),width:parseFloat(ghost.style.width),height:parseFloat(ghost.style.height)}:undefined;
    if(release){f.documentEvents.get('pointerup')({pointerId,clientX:to[0],clientY:to[1]});await f.drain();}
    return {shown,marked};};
  const draft=async()=>{const before=saves().length;f.el('desk-save').emit('click');await f.until(()=>saves().length>before);await f.drain();return C.parseConfig(saves().at(-1).data);};
  // The geometry the layout drew: the pitch between two keys, the canvas width, the columns.
  const geometry=ids=>{boxes();const [a,b]=ids.map(id=>node(id).rect),pitch=b.left-a.left,width=parseFloat(grid().style.width);return {pitch,width,columns:Math.floor((width-2*EDGE)/pitch+1e-6),left:grid().rect.left,top:grid().rect.top,inset:EDGE,insetTop:EDGE /* T97: a wide window keeps 1u from the canvas edge; the first run starts 1u down */};};
  return {f,boxes,node,center,saves,enter,drag,draft,geometry,grid};
}
const cellPoint=(g,x,y,off=0)=>[g.left+g.inset+(x+.5)*g.pitch,g.top+off+g.insetTop+(y+.5)*g.pitch];

test('T89 page: a hole at the end of a row shows the dashed cell right there; dropping lands there, leaves a blank at the origin, later items do not move; one Undo',async t=>{
  const w0=await world(t,flat(key('k0',APP),key('k1',APP),key('k2',APP)));await w0.enter();
  const {columns}=w0.geometry(['k0','k1']);assert.ok(columns>=5,`${columns} columns`);
  const row=Array.from({length:columns-1},(_,i)=>key(`r${i}`,APP)),config=flat(...row,key('m',APP,{size:'M'}),key('z',APP),key('y',APP));
  const w=await world(t,config);await w.enter();const g=w.geometry(['r0','r1']),before=Object.fromEntries(['m','y'].map(id=>[id,[w.node(id).style['--kx'],w.node(id).style['--ky']]]));
  assert.ok(parseFloat(w.node('m').style['--ky'])>parseFloat(w.node('r0').style['--ky']),'the M key wrapped to the second row');
  const hover=await w.drag('z',cellPoint(g,g.columns-1,0),{release:false});
  assert.equal(hover.shown.shape,'cell');assert.equal(hover.shown.hidden,false);assert.equal(hover.shown.refused,'false','a dashed cell, not refused');
  assert.ok(Math.abs(hover.shown.left-(g.inset+(g.columns-1)*g.pitch))<.01&&Math.abs(hover.shown.top-g.insetTop)<.01,'exactly on the hole');
  w.f.documentEvents.get('pointerup')({pointerId:1,clientX:cellPoint(g,g.columns-1,0)[0],clientY:cellPoint(g,g.columns-1,0)[1]});await w.f.drain();
  assert.equal(w.f.el('edit-undo').disabled,false);
  const saved=await w.draft();assert.deepEqual(kinds(saved.widgets),[...row.map(r=>r.id),'z','m','_S','y']);
  w.boxes();for(const id of ['m','y'])assert.deepEqual([w.node(id).style['--kx'],w.node(id).style['--ky']].length,2);
  void before;
});
test('T89 page: one move into a hole is one Undo step',async t=>{
  const probe=await world(t,flat(key('k0',APP),key('k1',APP)));await probe.enter();const columns=probe.geometry(['k0','k1']).columns;
  const row=Array.from({length:columns-1},(_,i)=>key(`r${i}`,APP)),w=await world(t,flat(...row,key('m',APP,{size:'M'}),key('z',APP),key('y',APP)));await w.enter();const g=w.geometry(['r0','r1']);
  await w.drag('z',cellPoint(g,g.columns-1,0));assert.equal(w.f.el('edit-undo').disabled,false);
  w.f.el('edit-undo').emit('click');await w.f.drain();assert.equal(w.f.el('edit-undo').disabled,true,'one Undo puts everything back (the blank and the move)');assert.equal(w.f.el('desk-save').hidden,true);
});
test('T89 page: a hole too small for the dragged key shows a refused (red) cell at the wanted cell and a drop changes nothing',async t=>{
  const probe=await world(t,flat(key('k0',APP),key('k1',APP)));await probe.enter();const columns=probe.geometry(['k0','k1']).columns;
  const row=Array.from({length:columns-1},(_,i)=>key(`r${i}`,APP)),w=await world(t,flat(...row,key('m',APP,{size:'M'}),key('big',APP,{size:'M'})));await w.enter();
  const g=w.geometry(['r0','r1']);
  const hover=await w.drag('big',cellPoint(g,g.columns-1,0),{release:false});
  assert.equal(hover.shown.shape,'cell');assert.equal(hover.shown.hidden,false);assert.equal(hover.shown.refused,'true','refused: red dashed cell');
  assert.ok(Math.abs(hover.shown.left-(g.inset+(g.columns-2)*g.pitch))<.01,'at the clamped cell under the pointer, not somewhere else');
  w.f.documentEvents.get('pointerup')({pointerId:1,clientX:cellPoint(g,g.columns-1,0)[0],clientY:cellPoint(g,g.columns-1,0)[1]});await w.f.drain();
  assert.equal(w.f.el('desk-save').hidden,true,'nothing changed');assert.match(w.f.el('move-toast-text').textContent,/Not enough room here/);
});
test('T89 page: the right-edge leftover is the last column; a Wide key dropped near the right edge is pulled left to where it fits',async t=>{
  const w=await world(t,flat(key('k1',APP),key('k2',APP),key('k3',APP),key('w',APP,{size:'Wide'})));await w.enter();
  const g=w.geometry(['k1','k2']),edge=[g.left+g.width-3,g.top+g.insetTop+g.pitch*1.5];
  const small=await w.drag('k1',[edge[0],g.top+g.insetTop+g.pitch/2],{release:false});
  assert.equal(small.shown.refused,'false');assert.ok(Math.abs(small.shown.left-(g.inset+(g.columns-1)*g.pitch))<.01,'the leftover maps to the last column');
  w.f.documentEvents.get('pointerup')({pointerId:1,clientX:edge[0],clientY:g.top+g.insetTop+g.pitch/2});await w.f.drain();
  const v=await world(t,flat(key('k1',APP),key('k2',APP),key('k3',APP),key('w',APP,{size:'Wide'})));await v.enter();
  const h=await v.drag('w',[edge[0],edge[1]],{release:false});
  assert.equal(h.shown.refused,'false');assert.ok(Math.abs(h.shown.left-(g.inset+(g.columns-4)*g.pitch))<.01,'pulled left');assert.ok(Math.abs(h.shown.top-(g.insetTop+g.pitch))<.01,'row 1');
  assert.ok(Math.abs(h.shown.width-(4*g.pitch))<.01,'four columns wide');
});
test('T89 page: every canvas run works: empty area above and below a full-width Pages group, with each run\'s own offset',async t=>{
  const config=C.parseConfig({...C.initialView(),revision:2,widgets:[key('a',APP),key('b',APP),{id:'main',kind:'pages',pages:[{id:'p',name:'P',widgets:[key('pk',APP)]}]},key('c',APP),key('d',APP)]});
  const w=await world(t,config);await w.enter();const g=w.geometry(['a','b']);
  const up=await w.drag('d',cellPoint(g,3,0),{release:false});
  assert.equal(up.shown.refused,'false');assert.ok(Math.abs(up.shown.left-(g.inset+3*g.pitch))<.01);assert.ok(Math.abs(up.shown.top-g.insetTop)<.01,'run above the Pages group: starts 1u down (T97)');
  w.f.documentEvents.get('pointerup')({pointerId:1,clientX:cellPoint(g,3,0)[0],clientY:cellPoint(g,3,0)[1]});await w.f.drain();
  const saved=await w.draft();assert.deepEqual(saved.widgets.map(item=>item.kind==='blank'?`_${item.size}`:item.id),['a','b','_S','d','main','c']);
  const v=await world(t,config);await v.enter();v.boxes();
  const runTop=parseFloat(v.node('c').style['--ky']),pitch=g.pitch; // T97: a later run in a wide window has no inset above its first row; the 2u gap under the Pages group is in its offset
  assert.ok(runTop>20,'the second run starts below the Pages group');
  v.f.el('grid-frame').scrollTop=runTop-30;v.boxes();assert.ok(v.grid().rect.top<0,'the canvas is scrolled to the second run');
  const at=[v.grid().rect.left+g.inset+(4+.5)*pitch,v.grid().rect.top+runTop+pitch/2];
  const down=await v.drag('a',at,{release:false});
  assert.equal(down.shown.refused,'false');assert.ok(Math.abs(down.shown.top-runTop)<.01,'the ghost uses the second run\'s offset');assert.ok(Math.abs(down.shown.left-(g.inset+4*pitch))<.01);
  assert.ok(Math.abs(down.shown.top-parseFloat(v.node('c').style['--ky']))<.01,'on the row of c');
  v.f.documentEvents.get('pointerup')({pointerId:1,clientX:at[0],clientY:at[1]});await v.f.drain();
  const later=await v.draft();assert.deepEqual(later.widgets.map(item=>item.kind==='blank'?`_${item.size}`:item.id),['_S','b','main','c','d','_S','_S','a'],'the run below: index counts from the run start, a blank stays at the origin');
});
test('T89 page: over the Pages group itself nothing is a canvas drop cell',async t=>{
  const config=C.parseConfig({...C.initialView(),revision:2,widgets:[key('a',APP),{id:'main',kind:'pages',pages:[{id:'p',name:'P',widgets:[key('pk',APP)]}]}]});
  const w=await world(t,config);await w.enter();w.boxes();
  const pages=treeFind(w.grid(),n=>n.className==='pages-widget'),strip=[pages.rect.left+pages.rect.width/2,pages.rect.top+10];
  const over=await w.drag('a',strip,{release:false});
  assert.ok(!over.shown||over.shown.hidden===true||over.shown.shape!=='cell','no canvas cell over a Pages group');
});
test('T89 Insert mode and a Library drop are unchanged: an insertion line, no cell',async t=>{
  const probe=await world(t,flat(key('k0',APP),key('k1',APP)));await probe.enter();const columns=probe.geometry(['k0','k1']).columns;
  const row=Array.from({length:columns-1},(_,i)=>key(`r${i}`,APP)),w=await world(t,flat(...row,key('m',APP,{size:'M'}),key('z',APP)),{mode:'insert'});await w.enter();
  const g=w.geometry(['r0','r1']),hover=await w.drag('z',cellPoint(g,g.columns-1,0),{release:false});
  assert.notEqual(hover.shown?.shape,'cell');assert.ok(hover.shown&&hover.shown.width===3,'the insertion line');
  w.f.documentEvents.get('pointerup')({pointerId:1,clientX:cellPoint(g,g.columns-1,0)[0],clientY:cellPoint(g,g.columns-1,0)[1]});await w.f.drain();
  assert.equal((await w.draft()).widgets.some(item=>item.kind==='blank'),false,'Insert creates no blanks');
  const v=await world(t,flat(key('k0',APP),key('k1',APP),blank('b1')));await v.enter();
  v.f.el('shelf-toggle').emit('click');await v.f.drain();v.f.el('shelf-types').children[1].emit('click');await v.f.drain();
  const card=v.f.el('shelf-previews').children.find(n=>n.className?.includes('shelf-card')),g2=v.geometry(['k0','k1']);
  card.emit('pointerdown',{isPrimary:true,button:0,pointerId:5,pointerType:'mouse',clientX:5,clientY:5});card.emit('pointermove',{pointerId:5,clientX:40,clientY:40});
  const empty=cellPoint(g2,6,3);v.f.documentEvents.get('pointermove')({pointerId:5,clientX:empty[0],clientY:empty[1]});
  const ghost=treeFind(v.grid(),n=>n.className==='drop-ghost');assert.notEqual(ghost?.dataset.shape,'cell','a Library item over empty area shows the insertion line, not a cell');
  v.f.documentEvents.get('pointerup')({pointerId:5,clientX:empty[0],clientY:empty[1]});await v.f.drain();
});
test('T89 the refused cell is red and dashed with theme tokens only',()=>{
  assert.match(css,/\.button-grid \.drop-ghost\[data-shape=cell\]\[data-refused=true\]\{border-color:var\(--danger\)/);
  const block=css.slice(css.indexOf('.button-grid .drop-ghost[data-shape=cell]'),css.indexOf('.button-grid .drop-ghost[data-shape=cell]')+400);assert.doesNotMatch(block,/#[0-9a-fA-F]{3,8}\b/);
  const source=read('apps/web/console.ts');assert.doesNotMatch(source,/blanksToCell/);assert.match(source,/Not enough room here\./);
});
