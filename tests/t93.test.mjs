import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as C from '../dist/packages/contracts/index.js';
import {flowLayout} from '../dist/apps/web/page-view.js';
import {rebuildForColumns,rebuildPagesColumns} from '../dist/apps/web/page-layout.js';
import {client} from './helpers/client-harness.mjs';
import {key} from './helpers/layout.mjs';
import {treeFind} from './helpers/responsive-boxes.mjs';

// T93 (ADR-084, amended): changing "Keys per row" must not scramble a hand-made arrangement. The pure rebuild runs on the production flowLayout; the page tests run the compiled client
// against the minimal DOM. They are not browser rendering, real touch or Surface evidence.
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const APP={type:'app.open',appId:'test.app'};
const blank=(id,size='S')=>({id,kind:'blank',size});
const place=(trial,columns)=>flowLayout(trial,2000,'standard',8,14,0,0,columns).placements;
const cells=(widgets,columns)=>Object.fromEntries(place(widgets,columns).map((p,i)=>[widgets[i].id,[p.x,p.y]]).filter(([id])=>!id.startsWith('b')));
const ids=list=>list.map(w=>w.kind==='blank'?'_':w.id);
const range=(from,to)=>Array.from({length:to-from},(_,i)=>key(`k${from+i}`));

test('T93 9 to 10 columns: every key keeps its cell (holes and blanks included) and the new last column is empty',()=>{
  const old=[...range(0,9),blank('b1'),key('k9'),blank('b2'),blank('b3'),key('k10'),...range(11,16),blank('b4','M'),key('k16'),key('k17')];
  const before=cells(old,9),done=rebuildForColumns(old,9,10,place);
  assert.equal(done.moved,0);assert.deepEqual(cells(done.widgets,10),before,'every key on the cell it had');
  assert.ok(Object.values(cells(done.widgets,10)).every(([x])=>x<9),'the tenth column is empty');
  assert.ok(done.widgets.filter(w=>w.kind==='blank').every(w=>w.size==='S'),'blanks are made again as S blanks');assert.notEqual(done.widgets.at(-1).kind,'blank','no trailing blank');
  assert.equal(done.widgets.filter(w=>w.kind!=='blank').length,18,'nothing is lost');
});
test('T93 9 to 8 columns: every key whose cell still fits keeps it; column-9 keys go to the end in (row, column) order',()=>{
  const old=[...range(0,18),blank('b1'),key('k18'),...range(19,23)];
  const before=cells(old,9),done=rebuildForColumns(old,9,8,place),after=cells(done.widgets,8);
  const overflowing=Object.entries(before).filter(([,[x]])=>x>=8).sort((a,b)=>a[1][1]-b[1][1]||a[1][0]-b[1][0]).map(([id])=>id);
  assert.ok(overflowing.length>=2,JSON.stringify(overflowing));assert.equal(done.moved,overflowing.length);
  assert.deepEqual(ids(done.widgets).slice(-overflowing.length),overflowing,'at the end, in the old (row, column) order');
  for(const [id,at] of Object.entries(before))if(!overflowing.includes(id))assert.deepEqual(after[id],at,`${id} keeps its cell`);
  assert.equal(done.widgets.filter(w=>w.kind!=='blank').length,Object.keys(before).length,'nothing is lost');
});
test('T93 mixed sizes (M, Tall, Wide): they keep their cells when they fit and go to the end when they do not',()=>{
  const wide=key('w',null,{size:'Wide'}),old=[key('a'),key('m',null,{size:'M'}),key('t',null,{size:'Tall'}),key('s1'),key('s2'),wide,key('x1'),key('x2'),key('l',null,{size:'L'}),key('y1'),key('y2')];
  for(const [from,to] of [[6,8],[6,5],[7,6],[8,5],[5,9],[6,4],[10,6]]){
    const before=cells(old,from),done=rebuildForColumns(old,from,to,place),after=cells(done.widgets,to),span=Object.fromEntries(place(old,from).map((p,i)=>[old[i].id,p.cols]));
    const tail=ids(done.widgets).slice(ids(done.widgets).length-done.moved);
    for(const [id,at] of Object.entries(before)){
      if(tail.includes(id))continue;
      assert.deepEqual(after[id],at,`${from}->${to}: ${id}`);
    }
    for(const id of Object.keys(before))if(before[id][0]+span[id]>to)assert.ok(tail.includes(id),`${from}->${to}: ${id} no longer fits and goes to the end`);
    const order=Object.entries(before).filter(([id])=>tail.includes(id)).sort((a,b)=>a[1][1]-b[1][1]||a[1][0]-b[1][0]).map(([id])=>id);assert.deepEqual(tail,order,`${from}->${to}: the end is in (row, column) order`);
    assert.equal(Object.keys(after).length,old.length);
  }
  assert.equal(rebuildForColumns(old,6,5,place).moved>0,true,'the Wide key (four columns) cannot sit at its cell in five columns');
  assert.equal(rebuildForColumns(old,5,9,place).moved,0,'more columns: nothing moves');
});
test('T93 more columns or the same: nothing moves; an empty or all-blank page stays empty; display widgets are items like keys',()=>{
  const old=[key('a'),blank('b1'),key('c'),{id:'clock',kind:'clock',size:'M',form:'time'},key('d')];
  assert.deepEqual(cells(rebuildForColumns(old,4,7,place).widgets,7),cells(old,4));assert.deepEqual(cells(rebuildForColumns(old,4,4,place).widgets,4),cells(old,4));
  assert.deepEqual(rebuildForColumns([],5,3,place),{widgets:[],moved:0});assert.deepEqual(rebuildForColumns([blank('b1'),blank('b2')],5,3,place).widgets,[]);
  const fewer=rebuildForColumns(old,5,3,place);assert.equal(fewer.widgets.filter(w=>w.id==='clock').length,1);
});
test('T93 the whole Pages group is rebuilt, page by page, and the count is per page; the other pages\' ids and the group stay',()=>{
  const config=C.parseConfig({...C.initialView(),revision:2,widgets:[{id:'g',kind:'pages',columns:{wide:9,narrow:5},pages:[{id:'a',name:'A',widgets:range(0,10)},{id:'b',name:'B',widgets:[key('b0'),key('b1')]},{id:'c',name:'C',widgets:range(20,29)}]}]});
  const done=rebuildPagesColumns(config,'g',9,8,place);
  assert.deepEqual(done.moved,[{page:'A',count:1},{page:'C',count:1}]);
  const group=done.config.widgets[0];assert.deepEqual(group.pages.map(p=>p.id),['a','b','c']);assert.deepEqual(group.columns,{wide:9,narrow:5},'the value itself is the caller\'s');
  assert.deepEqual(ids(group.pages[1].widgets),['b0','b1']);assert.equal(ids(group.pages[0].widgets).at(-1),'k8');assert.equal(ids(group.pages[2].widgets).at(-1),'k28');
  assert.equal(C.parseConfig(JSON.parse(JSON.stringify(done.config))).widgets.length,1,'the result is a legal layout');
  assert.deepEqual(config.widgets[0].pages[0].widgets.map(w=>w.id),range(0,10).map(w=>w.id),'the input is not changed');
});

// ---- the page -----------------------------------------------------------------------------------------------------------------------------------
const group=(columns,pages)=>C.parseConfig({...C.initialView(),revision:2,widgets:[{id:'g',kind:'pages',...(columns?{columns}:{}),pages}]});
async function open(t,config,{width=1200,height=900}={}){
  const f=await client(t,{configuration:config,viewport:{width,height},moveMode:'insert'}),{el}=f;
  await f.until(()=>f.el('edit-layout').disabled===false&&f.state&&f.sockets[0]?.readyState===1);await f.drain();
  el('edit-layout').emit('click');await f.drain();
  const find=p=>treeFind(el('button-grid'),p);find(n=>n.className==='pages-widget').emit('click',{target:find(n=>n.className==='pages-owner-label'),detail:0});await f.drain();await f.drain();
  // The draft is read through the page: the keys' cells as drawn (column and row from the boxes the flow gave them).
  const keysAt=()=>{const nodes=[],walk=n=>{for(const c of n.children??[]){if(c.dataset?.buttonId)nodes.push(c);walk(c);}};walk(el('button-grid'));
    const first=nodes[0],second=nodes[1],pitch=Math.max(1,parseFloat(second?.style['--kx'])-parseFloat(first?.style['--kx']))||1;
    return Object.fromEntries(nodes.map(n=>[n.dataset.buttonId,[Math.round((parseFloat(n.style['--kx'])-14)/pitch),Math.round((parseFloat(n.style['--ky'])-14)/pitch)]]));};
  const type=async(side,text)=>{const input=el(`pages-columns-${side}`);input.focus();input.value=text;input.emit('input');await f.drain();};
  const saved=async()=>{const before=f.count('configuration/save');el('desk-save').emit('click');await f.until(()=>f.count('configuration/save')>before);await f.drain();return C.parseConfig(f.calls.findLast(c=>c.path==='/api/configuration/save').data);};
  // Pressing Undo takes the focus out of the field (the harness does not move focus by itself).
  const undo=async()=>{globalThis.document.activeElement=undefined;el(`pages-columns-wide`).emit('blur');f.el('edit-undo').emit('click');await f.drain();};
  return {f,el,find,keysAt,type,saved,undo};
}
const nineByTwo=()=>[...range(0,9),blank('b1'),key('k9'),blank('b2'),...range(10,13)].map(w=>w.kind==='key'?{...w,action:APP}:w);

test('T93 page: 9 to 10 keeps every cell, one Undo step restores the order and the value, and the card says nothing was moved',async t=>{
  const w=await open(t,group({wide:9},[{id:'a',name:'A',widgets:nineByTwo()}]));
  const before=w.keysAt();assert.equal(Math.max(...Object.values(before).map(([x])=>x)),8);
  await w.type('wide','10');
  const after=w.keysAt();assert.deepEqual(after,before,'every key on the cell it had');assert.equal(w.el('desk-save').hidden,false);assert.equal(w.el('pages-columns-note').textContent,'','nothing moved to the end');
  await w.undo();assert.equal(w.el('pages-columns-wide').value,'9');assert.deepEqual(w.keysAt(),before);
  assert.equal(w.f.el('edit-undo').disabled,true,'one Undo step');assert.equal(w.el('desk-save').hidden,true,'back to what was saved');
  await w.type('wide','10');const saved=await w.saved();assert.equal(saved.widgets[0].columns.wide,10);assert.ok(saved.widgets[0].pages[0].widgets.some(item=>item.kind==='blank'),'the holes became blanks');
});
test('T93 page: 9 to 8 moves the column-9 keys to the end with the right count; other keys keep their cells',async t=>{
  const twoRows=[...range(0,18)].map(w=>({...w,action:APP}));
  const w=await open(t,group({wide:9},[{id:'a',name:'A',widgets:twoRows}]));
  const before=w.keysAt();await w.type('wide','8');const after=w.keysAt();
  for(const id of Object.keys(before))if(!['k8','k17'].includes(id))assert.deepEqual(after[id],before[id],`${id} keeps its cell`);
  assert.equal(w.el('pages-columns-note').textContent.startsWith('2 keys moved to the end of the page.'),true,w.el('pages-columns-note').textContent);
  w.f.el('edit-undo').emit('click');await w.f.drain();assert.equal(w.el('pages-columns-note').textContent.includes('moved'),false,'Undo takes the note away');
  await w.type('wide','8');const order=(await w.saved()).widgets[0].pages[0].widgets.map(i=>i.id);assert.deepEqual(order.slice(-2),['k8','k17'],'at the end in (row, column) order');
  const one=await open(t,group({wide:9},[{id:'a',name:'A',widgets:range(0,9).map(k=>({...k,action:APP}))}]));await one.type('wide','8');assert.match(one.el('pages-columns-note').textContent,/^1 key moved to the end of the page\./);
});
test('T93 page: a group with several pages names the pages that were affected',async t=>{
  const w=await open(t,group({wide:9},[{id:'a',name:'Keys',widgets:range(0,9).map(k=>({...k,action:APP}))},{id:'b',name:'More',widgets:range(30,40).map(k=>({...k,action:APP}))}]));
  await w.type('wide','8');assert.match(w.el('pages-columns-note').textContent,/2 keys moved to the end of their pages: Keys \(1\), More \(1\)\./);
});
test('T93 page: typing "1" then "0" for 10 rebuilds from the arrangement before the edit, never 9 to 1 to 10; a commit starts a new session',async t=>{
  const w=await open(t,group({wide:9},[{id:'a',name:'A',widgets:nineByTwo()}]));
  const before=w.keysAt();
  await w.type('wide','1');assert.notDeepEqual(w.keysAt(),before,'a column of one is a big change (the preview)');
  await w.type('wide','10');assert.deepEqual(w.keysAt(),before,'10 is rebuilt from the original 9: every key is back on its cell');
  await w.type('wide','');assert.equal(w.f.el('desk-save').disabled,true,'an empty field is invalid');await w.type('wide','10');assert.deepEqual(w.keysAt(),before);
  await w.type('wide','9');assert.deepEqual(w.keysAt(),before,'back to the start value: the same arrangement');assert.equal(w.el('desk-save').hidden,true,'the draft is what was saved: nothing to save');
  await w.type('wide','10');assert.equal(w.el('desk-save').hidden,false);
  await w.undo();assert.equal(w.f.el('edit-undo').disabled,true,'the whole edit was one Undo step');assert.equal(w.el('pages-columns-wide').value,'9');
  // a committed edit ends the session: the next one rebuilds from the state it finds
  const v=await open(t,group({wide:9},[{id:'a',name:'A',widgets:nineByTwo()}]));
  await v.type('wide','10');v.el('pages-columns-wide').emit('change');await v.type('wide','11');assert.deepEqual(v.keysAt(),before,'10 then 11: each step keeps the cells');
  await v.undo();assert.equal(v.el('pages-columns-wide').value,'10','two commits, two Undo steps');
  // something else changing the draft in the middle of an edit starts the session again from the draft as it is
  const x=await open(t,group({wide:9},[{id:'a',name:'A',widgets:nineByTwo()}]));
  await x.type('wide','10');x.f.el('grid-size').value='large';x.f.el('grid-size').emit('change');await x.f.drain();await x.type('wide','11');
  assert.equal((await x.saved()).gridSize,'large','the other change survived the next keystroke');
});
test('T93 page: Auto to a number rebuilds nothing (the field starts at the count on show), a number back to Auto rebuilds nothing, the other side is untouched',async t=>{
  const ordered=config=>JSON.stringify(config.widgets[0].pages[0].widgets);
  const w=await open(t,group(undefined,[{id:'a',name:'A',widgets:nineByTwo()}])),original=ordered(group(undefined,[{id:'a',name:'A',widgets:nineByTwo()}]));
  w.el('pages-columns-wide-auto').emit('click');await w.f.drain();assert.ok(Number(w.el('pages-columns-wide').value)>=1);assert.equal(w.el('pages-columns-note').textContent.includes('moved'),false);
  w.el('pages-columns-narrow-auto').emit('click');await w.f.drain();assert.equal(w.el('pages-columns-narrow').value,'4','the narrow side is not in use here: just the value');
  const first=await w.saved();assert.equal(ordered(first),original,'the order is untouched');assert.equal(first.widgets[0].columns.narrow,4);
  const v=await open(t,group({wide:9,narrow:5},[{id:'a',name:'A',widgets:nineByTwo()}]));
  v.el('pages-columns-wide-auto').emit('click');await v.f.drain();const toAuto=await v.saved();assert.deepEqual(toAuto.widgets[0].columns,{narrow:5},'Auto removes the wide count');assert.equal(ordered(toAuto),original,'to Auto: nothing rebuilt');
  const u=await open(t,group({wide:9,narrow:5},[{id:'a',name:'A',widgets:nineByTwo()}]));
  await u.type('wide','8');const s=await u.saved();assert.deepEqual(s.widgets[0].columns,{wide:8,narrow:5},'only the wide side changed; narrow keeps its count');
});