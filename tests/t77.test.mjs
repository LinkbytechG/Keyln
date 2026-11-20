import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as C from '../dist/packages/contracts/index.js';
import {viewOf,withLayoutRevision} from './helpers/layout.mjs';
import {ConfigStore} from '../dist/apps/host/store.js';
import {flowLayout,snapPagesGridU} from '../dist/apps/web/page-view.js';
import {importPreview} from '../dist/apps/host/layout.js';
import {downloadLayout} from '../dist/apps/web/layout-files.js';
import {client} from './helpers/client-harness.mjs';
import {responsiveBoxes,treeFind} from './helpers/responsive-boxes.mjs';

const fixed=(w,h)=>({w:{mode:'fixed',u:w},h:{mode:'fixed',u:h}});
const page=(id,size)=>({id,kind:'pages',size,pages:[{id:`${id}-page`,name:'Page',widgets:[]}]});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
// T97: in the 1368 px wide windows below a top-level Pages box keeps 1u (1px at the standard grid) from the canvas edge, and 2u from another Pages; the frame has no padding.
const EDGE=1,PAGES_GAP=2;
test('T77 migrates legacy dimensions and strictly validates both axes',()=>{
 const config=C.initialView(), legacy=structuredClone(config); legacy.widgets[0].dimensions={w:241,h:428};
 const parsed=viewOf(legacy);assert.deepEqual(parsed.widgets[0].size,fixed(241,428));assert.equal('dimensions' in parsed.widgets[0],false);
 assert.deepEqual(viewOf(config),withLayoutRevision(config));
 for(const size of [{w:{mode:'fixed',u:1.1},h:{mode:'fixed',u:1}},{w:{mode:'fill',min:0},h:{mode:'fill',min:240}},{w:{mode:'percent',pct:0},h:{mode:'fill',min:240}},{w:{mode:'percent',pct:101},h:{mode:'fill',min:240}},{w:{mode:'percent',pct:50},h:{mode:'percent',pct:50}},{w:{mode:'bad'},h:{mode:'fixed',u:1}},{w:{mode:'fixed',u:3841},h:{mode:'fixed',u:1}}]){const c=structuredClone(config);c.widgets[0].size=size;assert.throws(()=>C.parseConfig(c));}
 legacy.widgets[0].size=fixed(241,428);assert.throws(()=>C.parseConfig(legacy));
});
test('T77 host save, restart, backup, restore and whole-layout import preserve explicit modes',t=>{
 const dir=mkdtempSync(join(tmpdir(),'keyln-t77-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const store=new ConfigStore(dir),draft=store.get();draft.widgets[0].size={w:{mode:'percent',pct:50},h:{mode:'fill',min:240}};
 const saved=store.replace(draft,[]);assert.deepEqual(new ConfigStore(dir).get(),saved);assert.deepEqual(importPreview(JSON.parse(JSON.stringify(saved)),[],()=>{}).view,withLayoutRevision(saved));
 const next=structuredClone(saved);next.widgets[0].size=fixed(240,428);store.replace(next,[]);const backup=store.backupState(),restored=store.restoreBackup({stamp:backup.stamp,confirm:true},()=>{});assert.deepEqual(restored.widgets[0].size,saved.widgets[0].size);assert.deepEqual(new ConfigStore(dir).get(),restored);
});
test('T77 whole-layout web export contains the explicit axes and reads back',async t=>{
 const config=C.initialView();config.widgets[0].size={w:{mode:'fill',min:240},h:{mode:'fixed',u:428}};
 const f=await client(t,{configuration:config}),document=C.readConfig(config);downloadLayout(document,'layout.json');assert.equal(f.downloads.length,1);
 // T94: the file is the whole v3 document; the layout's view of it carries the same axes.
 const exported=JSON.parse(await f.downloads[0].text());assert.deepEqual(exported,document);assert.deepEqual(C.readConfig(exported),document);assert.deepEqual(C.viewFor(exported,'Surface').widgets[0].size,config.widgets[0].size);
});
test('T77 sequential rows allocate Fill and clamp Fixed at all viewport widths',()=>{
 for(const width of [375,768,1024,1368,1440]){
  const main=page('main',{w:{mode:'fill',min:240},h:{mode:'fixed',u:428}}),side=page('side',fixed(240,428));
  const layout=flowLayout([main,side],width,'standard',8,14,800),[a,b]=layout.placements;
  if(width===1024||width===1368)assert.equal(a.top,b.top);
  assert.ok(a.left+a.width<=b.left+1e-6||b.left+b.width<=a.left+1e-6||a.top+a.height<=b.top+1e-6||b.top+b.height<=a.top+1e-6);
  near((a.top===b.top?b.left+b.width:a.left+a.width),width-14);
  assert.ok(a.left+a.width<=width-14+1e-6);assert.ok(b.left+b.width<=width-14+1e-6);
  const split=flowLayout([main,{...main,id:'second'}],width,'standard',8,14,800).placements;
  if(split[0].top===split[1].top){near(split[0].width,split[1].width);near(split[1].left+split[1].width,width-14);}
  const percent=flowLayout([page('percent',{w:{mode:'percent',pct:50},h:{mode:'fixed',u:120}})],width,'standard',8,14,800).placements[0];near(percent.width,(width-28+8)/2-8);
  const wide=flowLayout([page('wide',fixed(3840,120))],width,'standard',8,14,800);near(wide.placements[0].width,width-28);assert.equal(wide.overflow,false);
  const heightLayout=flowLayout([page('height',{w:{mode:'fill',min:240},h:{mode:'fill',min:240}})],width,'standard',8,14,800),height=heightLayout.placements[0];near(height.top+height.height,800-14);near(heightLayout.height,800);
 }
});
test('T77 Fill/Fill alone does not extend the visible canvas at common viewport sizes',()=>{
 for(const [width,height] of [[1024,768],[1368,912]]){
  const layout=flowLayout([page('fill',{w:{mode:'fill',min:240},h:{mode:'fill',min:240}})],width,'standard',8,14,height);
  assert.ok(layout.height<=height+1e-7);assert.ok(layout.placements[0].top+layout.placements[0].height<=height-14+1e-7);
 }
});
test('T77 Fill minimum wraps without overlap and height minimum extends the canvas',()=>{
 const items=[page('fixed',fixed(240,120)),page('fill',{w:{mode:'fill',min:900},h:{mode:'fill',min:700}}),page('last',fixed(240,120))];
 const layout=flowLayout(items,768,'standard',8,14,200), [a,b,c]=layout.placements;
 assert.deepEqual(layout.placements.map(p=>p.id),['fixed','fill','last']);
 assert.ok(b.top>a.top);near(b.left+b.width,768-14);assert.ok(c.top>=b.top+b.height);
 assert.ok(b.height>=700*layout.cell/120);assert.ok(layout.height>200);
});
test('T77 percentage presets tile including gaps and distribute the rounding of thirds',()=>{
 for(const width of [375,768,1024,1180,1368,1440])for(const pcts of [[50,50],[33,33,33],[25,25,25,25],[67,33],[75,25]]){
  const items=pcts.map((pct,i)=>page(`p-${i}`,{w:{mode:'percent',pct},h:{mode:'fixed',u:120}})),layout=flowLayout(items,width,'standard',8,14,800),rects=layout.placements;
  assert.ok(rects.every(rect=>Math.abs(rect.top-rects[0].top)<1e-7),`${width}: ${pcts} wrapped`);
  for(let i=1;i<rects.length;i++)near(rects[i].left-(rects[i-1].left+rects[i-1].width),8);
  assert.ok(Math.abs(rects.at(-1).left+rects.at(-1).width-(width-14))<=1);
 }
});
test('T77 snapping sweep uses the interior flow with fractional gutter loss',()=>{
 const keys=[{id:'k',kind:'key',size:'S',label:'Key',icon:'app',action:null}];
 for(const viewport of [1024,1180,1368])for(const lossW of [10,11,12.25]){
  const scale=flowLayout([page('outer',fixed(905,658))],viewport,'standard',8,14).cell/120,loss={w:lossW,h:46};
  for(let dx=-400;dx<=300;dx+=13){
   const raw={w:Math.max(1,Math.round(905+dx/scale)),h:Math.max(1,Math.round(658-200/scale))};
   const snapped=snapPagesGridU(keys,raw,scale,'standard',8,14,loss,'xy'),bodyWidth=snapped.w*scale-loss.w,bodyHeight=snapped.h*scale-loss.h;
   const grid=flowLayout(keys,bodyWidth,'standard',8,14),trailing=bodyWidth-28-(grid.columns*grid.cell+(grid.columns-1)*8);
   assert.ok(trailing>=-1e-6&&trailing<=1+1e-6,`${viewport}/${lossW}/${dx}: width trailing ${trailing}`);
   assert.ok(Math.abs(grid.cell-C.GRID_CELL.standard)<=1,`${viewport}/${dx}: stretched ${grid.cell}`);
   const rows=Math.round((bodyHeight-28+8)/grid.pitch),bottom=bodyHeight-28-(rows*grid.cell+(rows-1)*8);
   assert.ok(bottom>=-1e-6&&bottom<=1+1e-6,`${viewport}/${lossW}/${dx}: bottom trailing ${bottom}`);
  }
 }
});

const outer=f=>treeFind(f.el('button-grid'),n=>n.className==='pages-widget');
const handle=(f,axis)=>treeFind(outer(f),n=>n.className==='pages-resize-handle'&&n.dataset.axis===axis);
const pointer=props=>({pointerId:7,isPrimary:true,button:0,preventDefault(){},stopPropagation(){},...props});
async function editFixture(t,size,extra=[],viewport={width:1368,height:912}){
 const config=C.initialView();if(size)config.widgets[0].size=size;config.widgets.push(...extra);
 config.widgets[0].pages[0].widgets=[{id:'inside',kind:'key',size:'S',label:'Inside',icon:'app',action:null}];
 const f=await client(t,{configuration:config,viewport});f.el('edit-layout').emit('click');await f.drain();responsiveBoxes(f);return f;
}
async function card(f){
 const node=outer(f),label=treeFind(node,n=>n.className==='pages-owner-label');node.emit('click',{target:label,detail:0});await f.drain();
 return {w:Number(f.el('pages-width').value),h:Number(f.el('pages-height').value)};
}
function begin(f,axis){
 responsiveBoxes(f);const node=outer(f),box=node.getBoundingClientRect(),grip=handle(f,axis),start={x:box.left+box.width/2,y:box.top+box.height/2};
 grip.emit('pointerdown',pointer({clientX:start.x,clientY:start.y,target:grip}));return {node,box,grip,start};
}
async function move(f,g,dx,dy,alt=false){
 f.documentEvents.get('pointermove')(pointer({clientX:g.start.x+dx,clientY:g.start.y+dy,altKey:alt}));await f.drain();
}
async function release(f,g,dx,dy,alt=false){
 f.documentEvents.get('pointerup')(pointer({clientX:g.start.x+dx,clientY:g.start.y+dy,altKey:alt}));await f.drain();
}
test('T77 no size retains legacy full-width viewport bands in Use and Edit',async t=>{
 const config=C.initialView();config.widgets.push({id:'other',kind:'pages',pages:[{id:'other-page',name:'Other',widgets:[]}]});
 const f=await client(t,{configuration:config,viewport:{width:1368,height:912}});
 for(const edit of [false,true]){
  if(edit){f.el('edit-layout').emit('click');await f.drain();}
  const frame=f.el('grid-frame'),width=parseFloat(frame.style.width)-2*EDGE,height=parseFloat(frame.style.height)-2*EDGE;
  const nodes=f.el('button-grid').children.filter(n=>n.className==='pages-widget');
  assert.equal(nodes.length,2);
  for(const node of nodes){near(Number(node.style['--kx']),EDGE);near(Number(node.style['--kw']),width);near(Number(node.style['--kh']),height);}
  near(Number(nodes[0].style['--ky']),EDGE);near(Number(nodes[1].style['--ky']),EDGE+height+PAGES_GAP);
 }
});
test('T77 mode switching uses rendered geometry, including a clamped Fixed',async t=>{
 const f=await editFixture(t,fixed(3840,428)),node=outer(f),width=Number(node.style['--kw']),content=parseFloat(f.el('button-grid').style.width)-28,scale=parseFloat(node.style['--cell'])/120;
 await card(f);f.el('pages-width-percent').emit('click');await f.drain();
 assert.equal(Number(f.el('pages-width').value),Math.max(1,Math.min(100,Math.round(width/content*100))));
 const pctNode=outer(f),pctWidth=Number(pctNode.style['--kw']);f.el('pages-width-fixed').emit('click');await f.drain();assert.equal(Number(f.el('pages-width').value),Math.round(pctWidth/scale));
 f.el('pages-height-fill').emit('click');await f.drain();const fillNode=outer(f),height=Number(fillNode.style['--kh']);f.el('pages-height-fixed').emit('click');await f.drain();assert.equal(Number(f.el('pages-height').value),Math.round(height/scale));
});
test('T77 Fixed to percent conversion includes the current gap',async t=>{
 const f=await editFixture(t,fixed(480,360));window.getComputedStyle=()=>({getPropertyValue:()=> '8px'});f.windowEvents.get('resize')();await f.drain();
 const width=Number(outer(f).style['--kw']),content=parseFloat(f.el('button-grid').style.width)-2*EDGE;
 await card(f);f.el('pages-width-percent').emit('click');await f.drain();
 assert.equal(Number(f.el('pages-width').value),Math.round((width+PAGES_GAP)/(content+PAGES_GAP)*100),'T97: the gap that counts is the one between Pages (2u), not the key gap');
});
test('T77 default drag snaps to whole inner columns and rows; Alt retains 1u and Undo',async t=>{
 const f=await editFixture(t,fixed(480,360));window.getComputedStyle=()=>({getPropertyValue:()=> '8px'});f.windowEvents.get('resize')();await f.drain();const g=begin(f,'xy'),scale=g.box.width/480;
 await move(f,g,130*scale,110*scale);await release(f,g,130*scale,110*scale);
 const size=await card(f),innerWidth=size.w*scale-28,innerHeight=size.h*scale-32-28;
 const cell=flowLayout([{id:'key',kind:'key',size:'S',label:'x',icon:'app',action:null}],size.w*scale,'standard',8,14).cell;
 assert.ok(Math.abs((innerWidth+8)/120-Math.round((innerWidth+8)/120))*120<=scale+1e-6);
 assert.ok(Math.abs((innerHeight+8)/(cell+8)-Math.round((innerHeight+8)/(cell+8)))*(cell+8)<=scale+1e-6);
 f.el('edit-undo').emit('click');await f.drain();assert.deepEqual(await card(f),{w:480,h:360});f.el('editor-close').emit('click');await f.drain();
 const alt=begin(f,'xy');await move(f,alt,37*scale,21*scale,true);await release(f,alt,37*scale,21*scale,true);assert.deepEqual(await card(f),{w:517,h:381});
 f.el('edit-undo').emit('click');await f.drain();assert.deepEqual(await card(f),{w:480,h:360});
});
test('T77 percent drags snap to presets or Alt 1%, and keyboard adjusts 1% or 10%',async t=>{
 const f=await editFixture(t,{w:{mode:'percent',pct:50},h:{mode:'fixed',u:360}}),g=begin(f,'x'),content=parseFloat(f.el('button-grid').style.width)-2*EDGE;
 const grid=f.el('button-grid'),label=treeFind(g.node,n=>n.className==='pages-size-live');grid.querySelectorAll=()=>[g.node];g.node.querySelector=()=>label;g.node.querySelectorAll=()=>g.node.children.filter(n=>n.className==='pages-resize-handle');
 await move(f,g,.12*content,0);assert.match(label.textContent,/67% · \d+u/);await release(f,g,.12*content,0);grid.querySelectorAll=undefined;assert.equal((await card(f)).w,67);assert.equal(f.el('pages-percent-67').getAttribute('aria-pressed'),'true');assert.equal(f.el('pages-percent-50').getAttribute('aria-pressed'),'false');f.el('editor-close').emit('click');await f.drain();
 const precise=begin(f,'x');await move(f,precise,-.11*content,0,true);await release(f,precise,-.11*content,0,true);assert.equal((await card(f)).w,56);f.el('editor-close').emit('click');await f.drain();
 responsiveBoxes(f);handle(f,'x').emit('keydown',pointer({key:'ArrowRight'}));await f.drain();responsiveBoxes(f);handle(f,'x').emit('keydown',pointer({key:'ArrowLeft',shiftKey:true}));await f.drain();assert.equal((await card(f)).w,47);
});
test('T77 edges switch to Fill and back, expose readout, and Escape restores the draft',async t=>{
 const f=await editFixture(t,fixed(480,360)),g=begin(f,'x'),grid=f.el('button-grid'),label=treeFind(g.node,n=>n.className==='pages-size-live');
 grid.querySelectorAll=()=>[g.node];g.node.querySelector=()=>label;g.node.querySelectorAll=()=>g.node.children.filter(n=>n.className==='pages-resize-handle');
 const edge=grid.getBoundingClientRect().left+parseFloat(grid.style.width)-EDGE,dx=edge-g.box.right;
 await move(f,g,dx,0,true);assert.match(label.textContent,/Fill · \d+u/);
 await move(f,g,dx-80,0,true);assert.match(label.textContent,/Fixed · \d+u/);
 f.documentEvents.get('keydown')(pointer({key:'Escape'}));await f.drain();grid.querySelectorAll=undefined;assert.deepEqual(await card(f),{w:480,h:360});assert.equal(f.el('save-message').dataset.dirty,'false');
 f.el('editor-close').emit('click');await f.drain();const right=begin(f,'x'),rightDx=edge-right.box.right,scale=right.box.width/480,expectedW=Math.ceil(Math.min((parseFloat(grid.style.width)-2*EDGE)/scale,(right.box.width+rightDx)/scale));await move(f,right,rightDx,0,true);await release(f,right,rightDx,0,true);await card(f);assert.equal(f.el('pages-width-fill').getAttribute('aria-pressed'),'true');assert.equal(Number(f.el('pages-width').value),expectedW);f.el('edit-undo').emit('click');await f.drain();assert.equal(f.el('pages-width-fixed').getAttribute('aria-pressed'),'true');
 f.el('editor-close').emit('click');await f.drain();const bottom=begin(f,'y'),frame=f.el('grid-frame').getBoundingClientRect(),dy=frame.bottom-bottom.box.bottom,expectedH=Math.floor((parseFloat(f.el('grid-frame').style.height)-EDGE-Number(bottom.node.style['--ky']))/scale+1e-9);
 const bottomLabel=treeFind(bottom.node,n=>n.className==='pages-size-live');grid.querySelectorAll=()=>[bottom.node];bottom.node.querySelector=()=>bottomLabel;bottom.node.querySelectorAll=()=>bottom.node.children.filter(n=>n.className==='pages-resize-handle');
 await move(f,bottom,0,dy,true);assert.match(bottomLabel.textContent,/Fill · \d+u/);await move(f,bottom,0,dy-80,true);assert.match(bottomLabel.textContent,/Fixed · \d+u/);await move(f,bottom,0,dy,true);await release(f,bottom,0,dy,true);grid.querySelectorAll=undefined;await card(f);assert.equal(f.el('pages-height-fill').getAttribute('aria-pressed'),'true');assert.equal(Number(f.el('pages-height').value),expectedH);
 f.el('edit-undo').emit('click');await f.drain();assert.equal(f.el('pages-height-fixed').getAttribute('aria-pressed'),'true');assert.equal(f.el('pages-height').value,'360');
});
test('T77 bottom Fill edge caps the minimum and never creates overflow inside its threshold',async t=>{
 for(const [width,height] of [[1024,768],[1368,912]])for(const offset of [-14,-8,0,8,14])await t.test(`${width}x${height} offset ${offset}`,async t=>{
  const f=await editFixture(t,fixed(600,300),[],{width,height}),g=begin(f,'y'),frame=f.el('grid-frame'),box=frame.getBoundingClientRect();
  const dy=box.bottom+offset-g.box.bottom,scale=g.box.width/600,available=parseFloat(frame.style.height),top=Number(g.node.style['--ky']);
  await move(f,g,0,dy,true);await release(f,g,0,dy,true);await card(f);
  assert.equal(f.el('pages-height-fill').getAttribute('aria-pressed'),'true');
  assert.ok(Number(f.el('pages-height').value)>=300);
  assert.ok(Number(f.el('pages-height').value)<=Math.floor((available-EDGE-top)/scale+1e-9));
  assert.ok(parseFloat(f.el('button-grid').style.height)<=available+1e-7);
 });
});
test('T77 width Fill uses content edge, never shrinks, and percent resumes after leaving',async t=>{
 const f=await editFixture(t,{w:{mode:'percent',pct:50},h:{mode:'fixed',u:360}},[page('side',fixed(240,428))]),g=begin(f,'x'),grid=f.el('button-grid'),label=treeFind(g.node,n=>n.className==='pages-size-live');
 grid.querySelectorAll=()=>[g.node];g.node.querySelector=()=>label;g.node.querySelectorAll=()=>g.node.children.filter(n=>n.className==='pages-resize-handle');
 await move(f,g,30,0,true);assert.match(label.textContent,/\d+% · \d+u/);
 const edge=grid.getBoundingClientRect().left+parseFloat(grid.style.width)-EDGE,dx=edge-g.box.right,previous=Number(g.node.style['--kw']);
 await move(f,g,dx,0,true);assert.match(label.textContent,/Fill · \d+u/);assert.ok(Number(g.node.style['--kw'])>=previous-1e-6);
 await move(f,g,dx-100,0,true);assert.match(label.textContent,/\d+% · \d+u/);await release(f,g,dx-100,0,true);grid.querySelectorAll=undefined;await card(f);assert.equal(f.el('pages-width-percent').getAttribute('aria-pressed'),'true');
 f.el('edit-undo').emit('click');await f.drain();f.el('editor-close').emit('click');await f.drain();
 const fill=begin(f,'x'),scale=parseFloat(fill.node.style['--cell'])/120,fillDx=edge-fill.box.right,expected=Math.ceil(Math.min((parseFloat(grid.style.width)-2*EDGE)/scale,(fill.box.width+fillDx)/scale));
 await move(f,fill,fillDx,0,true);await release(f,fill,fillDx,0,true);await card(f);assert.equal(f.el('pages-width-fill').getAttribute('aria-pressed'),'true');assert.equal(Number(f.el('pages-width').value),expected);
});
test('T77 live readout identifies clamped fixed width and resolved modes',async t=>{
 const f=await editFixture(t,fixed(3840,360)),g=begin(f,'y'),grid=f.el('button-grid'),label=treeFind(g.node,n=>n.className==='pages-size-live');
 grid.querySelectorAll=()=>[g.node];g.node.querySelector=()=>label;g.node.querySelectorAll=()=>g.node.children.filter(n=>n.className==='pages-resize-handle');
 await move(f,g,0,20,true);assert.match(label.textContent,/Fixed · \d+u \(clamped\)/);assert.match(label.textContent,/Fixed · \d+u/);
 f.documentEvents.get('keydown')(pointer({key:'Escape'}));await f.drain();grid.querySelectorAll=undefined;
});
