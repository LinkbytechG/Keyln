import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as C from '../dist/packages/contracts/index.js';
import {ConfigStore} from '../dist/apps/host/store.js';
import {importPreview} from '../dist/apps/host/layout.js';
import {flowLayout} from '../dist/apps/web/page-view.js';
import {planEmptyDrop} from '../dist/apps/web/page-layout.js';
import {LIBRARY_TYPES,previewsFor,PAGES_PRESETS} from '../dist/apps/web/library.js';
import {client} from './helpers/client-harness.mjs';
import {key,viewOf,withLayoutRevision} from './helpers/layout.mjs';
import {responsiveBoxes,treeFind} from './helpers/responsive-boxes.mjs';

// T91 (ADR-084): "keys per row" of a Pages widget, for wide and for narrow screens, and the two Pages presets of the Library. The layout rules run on the production flowLayout;
// the page tests run the compiled client against the minimal DOM. They are not browser rendering, real touch or Surface evidence.
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const css=read('apps/web/style.css');
const APP={type:'app.open',appId:'test.app'};
const withColumns=(columns,widgets=[],extra={})=>C.parseConfig({...C.initialView(),revision:2,widgets:[{id:'main',kind:'pages',pages:[{id:'a',name:'A',widgets}],...(columns===undefined?{}:{columns}),...extra}]});
const keys=count=>Array.from({length:count},(_,i)=>key(`k${i}`,APP));
const GAP=8,INSET=14;

// ---- the format ---------------------------------------------------------------------------------------------------------------------------------
test('T91 columns: {wide?, narrow?}, whole numbers 1 to 16, strict; missing means Auto and changes nothing; round-trips through the Host',t=>{
  for(const columns of [{wide:8,narrow:4},{wide:3},{narrow:2},{wide:1,narrow:16}])assert.deepEqual(withColumns(columns).widgets[0].columns,columns);
  const none=withColumns(undefined);assert.equal('columns' in none.widgets[0],false);assert.deepEqual(C.parseConfig(JSON.parse(JSON.stringify(none))),none);
  const bad=value=>assert.throws(()=>withColumns(value),error=>error instanceof C.Fault&&error.code==='INVALID_INPUT');
  for(const value of [{},{wide:0},{wide:17},{narrow:-1},{wide:2.5},{wide:'8'},{wide:null},{wide:true},{wide:8,tall:2},{big:4},null,[],[8,4],8,'8',{wide:Infinity},{wide:NaN}])bad(value);
  assert.throws(()=>C.parseConfig({...C.initialView(),widgets:[{id:'p',kind:'pages',pages:[{id:'q',name:'Q',widgets:[]}],columns:{wide:2},extra:1}]}),C.Fault);
  assert.throws(()=>C.parseConfig({...C.initialView(),widgets:[{id:'p',kind:'pages',pages:[{id:'q',name:'Q',widgets:[{...key('k'),columns:{wide:2}}]}]}]}),C.Fault,'only a Pages widget has it');
  const full=withColumns({wide:6,narrow:3},keys(2),{size:{w:{mode:'fixed',u:480},h:{mode:'fill',min:240}}});
  assert.deepEqual(C.parseConfig(JSON.parse(JSON.stringify(full))),full,'with a size');assert.deepEqual(viewOf(JSON.parse(JSON.stringify(full))),withLayoutRevision(full));
  assert.deepEqual(importPreview(JSON.parse(JSON.stringify(full)),[{id:'test.app',name:'Fake app'}],()=>{}).view,withLayoutRevision(full),'import keeps it');
  const dir=mkdtempSync(join(tmpdir(),'keyln-t91-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new ConfigStore(dir),draft=store.get();draft.widgets[0].columns={wide:5};const saved=store.replace(draft,[]);
  assert.deepEqual(saved.widgets[0].columns,{wide:5});assert.deepEqual(new ConfigStore(dir).get(),saved,'storage and restart keep it');
  assert.equal(C.MAX_PAGES_COLUMNS,16);
});

// ---- the layout ---------------------------------------------------------------------------------------------------------------------------------
test('T91 N columns give exactly N cells across and the cell fills the width: no 15% cap, no Grid size',()=>{
  for(const size of ['compact','standard','large']){
    const auto=flowLayout(keys(6),900,size,GAP,INSET);
    for(const n of [2,5,8,12]){
      const fixed=flowLayout(keys(24),900,size,GAP,INSET,0,0,n);
      assert.equal(fixed.columns,n,`${size} N=${n}`);
      assert.ok(Math.abs(fixed.width-900)<1e-6,'fills the width');assert.equal(fixed.overflow,false);
      assert.ok(Math.abs(n*fixed.cell+(n-1)*GAP+2*INSET-900)<1e-6,`${n} cells and ${n-1} gaps fill the inner width`);
      const first=fixed.placements.slice(0,n+1);assert.deepEqual(first.slice(0,n).map(p=>p.y),Array(n).fill(0));assert.equal(first[n].y,1,'the next key starts a new row');assert.equal(first[n].x,0);
      assert.equal(fixed.raised,false);assert.equal(fixed.floored,false);
    }
    assert.ok(flowLayout(keys(4),900,size,GAP,INSET,0,0,2).cell>auto.cell,'two columns are far bigger than the natural cell: no cap');
  }
  const auto=flowLayout(keys(6),900,'standard',GAP,INSET);assert.equal(auto.raised,undefined);assert.equal(auto.floored,undefined,'Auto sets no flags');
  assert.ok(auto.cell<=C.GRID_CELL.standard*1.15+1e-9,'Auto keeps the 15% cap');
  assert.deepEqual(flowLayout(keys(6),900,'standard',GAP,INSET,0,0,undefined).placements,auto.placements,'no override: nothing changes');
});
test('T91 grid-preset items span cells (keys, blanks, S to Wide) and other kinds scale with the cell',()=>{
  const items=[key('s'),key('m',null,{size:'M'}),{id:'b',kind:'blank',size:'S'},key('w',null,{size:'Wide'}),{id:'c',kind:'clock',size:'M',form:'time'}];
  const layout=flowLayout(items,800,'standard',GAP,INSET,0,0,6),by=Object.fromEntries(layout.placements.map(p=>[p.id,p]));
  assert.deepEqual([by.s.cols,by.m.cols,by.b.cols,by.w.cols],[1,2,1,4]);
  assert.ok(Math.abs(by.m.width-(2*layout.cell+GAP))<1e-6,'M is two cells and the gap between them');
  assert.ok(Math.abs(by.c.width-(2*layout.cell+GAP))<1e-6,'a Clock (M) scales through the same cell');assert.ok(Math.abs(by.c.height-layout.cell)<1e-6);
  assert.ok(layout.placements.every(p=>p.x+p.cols<=6+1e-9),'nothing leaves the six columns');
});
test('T91 N below the widest item is raised to it; a cell under 44px is held at 44px and the flow scrolls sideways',()=>{
  const wide=[key('a'),key('w',null,{size:'Wide'})];
  const raised=flowLayout(wide,900,'standard',GAP,INSET,0,0,2);assert.equal(raised.columns,4);assert.equal(raised.raised,true);
  assert.equal(flowLayout(wide,900,'standard',GAP,INSET,0,0,4).raised,false);assert.equal(flowLayout(wide,900,'standard',GAP,INSET,0,0,9).raised,false);
  const tight=flowLayout(keys(20),300,'standard',GAP,INSET,0,0,16);
  assert.equal(tight.columns,16);assert.equal(tight.cell,44);assert.equal(tight.floored,true);assert.equal(tight.overflow,true);assert.ok(tight.width>300);
  assert.ok(Math.abs(tight.width-(16*44+15*GAP+2*INSET))<1e-6,'exactly the width the 16 columns of 44px need');
  const roomy=flowLayout(keys(20),900,'standard',GAP,INSET,0,0,16);assert.equal(roomy.floored,false);assert.equal(roomy.overflow,false);
});

// ---- the page -----------------------------------------------------------------------------------------------------------------------------------
async function world(t,config,{width=1366,height=900,mode='insert'}={}){
  const f=await client(t,{configuration:C.parseConfig({...config,revision:2}),viewport:{width,height},moveMode:mode});
  await f.until(()=>f.el('edit-layout').disabled===false&&f.state&&f.sockets[0]?.readyState===1);await f.drain();
  const node=id=>treeFind(f.el('button-grid'),n=>n.dataset?.widgetId===id||n.dataset?.buttonId===id),surface=()=>treeFind(f.el('button-grid'),n=>n.className==='button-grid pages-surface');
  const at=id=>({x:parseFloat(node(id).style['--kx']),y:parseFloat(node(id).style['--ky']),w:parseFloat(node(id).style['--kw'])});
  const rows=count=>{const ys=new Set();for(let i=0;i<count;i++)ys.add(at(`k${i}`).y);return ys.size;};
  const perRow=()=>{const first=at('k0').y;let n=0;while(node(`k${n}`)&&at(`k${n}`).y===first)n++;return n;};
  return {f,node,surface,at,rows,perRow,win:globalThis.window};
}

test('T91 page: wide at 601px and narrow at 600px, re-evaluated on resize; nothing is saved by resizing',async t=>{
  const config=withColumns({wide:6,narrow:3},keys(14));
  const wide=await world(t,config,{width:601,height:900});assert.equal(wide.perRow(),6,'601px: wide');
  const narrow=await world(t,config,{width:600,height:900});assert.equal(narrow.perRow(),3,'600px: narrow');
  const w=await world(t,config,{width:900,height:900});assert.equal(w.perRow(),6);
  w.win.innerWidth=500;w.f.windowEvents.get('resize')();await w.f.drain();assert.equal(w.perRow(),3,'a narrower window switches side');
  w.win.innerWidth=700;w.f.windowEvents.get('resize')();await w.f.drain();assert.equal(w.perRow(),6,'and back');
  assert.equal(w.f.count('configuration/save'),0);
  const only=await world(t,withColumns({narrow:3},keys(14)),{width:1200,height:900});assert.ok(only.perRow()>3,'a missing side is Auto: the Grid size decides');
  assert.equal((await world(t,withColumns({wide:6},keys(14)),{width:400,height:900})).perRow(),(await world(t,withColumns(undefined,keys(14)),{width:400,height:900})).perRow(),'only the wide side is set: a narrow screen is Auto');
});
test('T91 page: the cell fills the Pages width with exactly N across; gap and inset as drawn; Auto is untouched',async t=>{
  const w=await world(t,withColumns({wide:5},keys(11)),{width:1200,height:900}),width=parseFloat(w.surface().style.width);
  const k0=w.at('k0'),k4=w.at('k4'),k5=w.at('k5');
  assert.equal(w.perRow(),5);assert.equal(k0.x,INSET);assert.ok(Math.abs(k4.x+k4.w+INSET-width)<.01,'the fifth key ends at the right inset');assert.ok(k5.y>k0.y&&k5.x===INSET);
  const auto=await world(t,withColumns(undefined,keys(11)),{width:1200,height:900});assert.ok(auto.perRow()>5,'Auto: more keys fit in a row');assert.ok(auto.at('k0').w<k0.w,'and they are smaller than five across');
});
test('T91 page: swap, blank and empty-cell planning use N (clamp, ghost and landing)',async t=>{
  const w=await world(t,withColumns({wide:5},keys(3)),{width:1200,height:900,mode:'swap'});
  w.f.el('edit-layout').emit('click');await w.f.drain();responsiveBoxes(w.f);
  const surface=w.surface(),pitch=w.at('k1').x-w.at('k0').x,width=parseFloat(surface.style.width);assert.ok(Math.abs(5*pitch+2*INSET-width)<1,'five columns across the width');
  const source=w.node('k0'),from=[source.rect.left+source.rect.width/2,source.rect.top+source.rect.height/2],right=[surface.rect.left+width-2,surface.rect.top+INSET+pitch/2];
  source.emit('pointerdown',{isPrimary:true,button:0,pointerId:1,pointerType:'mouse',clientX:from[0],clientY:from[1]});source.emit('pointermove',{pointerId:1,clientX:from[0]+20,clientY:from[1]+20});
  w.f.documentEvents.get('pointermove')({pointerId:1,clientX:right[0],clientY:right[1]});
  const ghost=treeFind(w.f.el('button-grid'),n=>n.className==='drop-ghost');
  assert.equal(ghost.dataset.shape,'cell');assert.ok(Math.abs(parseFloat(ghost.style.left)-(INSET+4*pitch))<.01,'the last of the five columns');assert.equal(ghost.dataset.refused,'false');
  w.f.documentEvents.get('pointerup')({pointerId:1,clientX:right[0],clientY:right[1]});await w.f.drain();
  const draftSave=async()=>{w.f.el('desk-save').emit('click');await w.f.until(()=>w.f.count('configuration/save')>0);await w.f.drain();return C.parseConfig(w.f.calls.findLast(c=>c.path==='/api/configuration/save').data);};
  const saved=await draftSave(),list=saved.widgets[0].pages[0].widgets;assert.deepEqual(list.map(x=>x.kind==='blank'?'_':x.id),['_','k1','k2','_','k0'],'a blank at the origin, one S blank up to the fifth column, then the key');
  // The same plan, on the pure planner with the page's own column count.
  const place=trial=>flowLayout(trial,1200,'standard',GAP,INSET,0,0,5).placements;
  assert.deepEqual(planEmptyDrop([key('a'),key('b')],key('z'),{x:99,y:0},place,5),{index:2,fills:2,x:4,y:0});
  assert.deepEqual(planEmptyDrop([key('a'),key('b')],key('z',null,{size:'Wide'}),{x:99,y:0},place,5),undefined,'a Wide key pulled left to column 1 lands on b: refused');
});

test('T91 settings card: Keys per row has two 36px rows (Auto toggle plus a number), live in the draft, errors block Save, Undo and Save work',async t=>{
  const f=await client(t,{configuration:withColumns(undefined,keys(14)),viewport:{width:1200,height:900}}),{el}=f;
  const find=p=>treeFind(el('button-grid'),p);
  el('edit-layout').emit('click');await f.drain();
  const outer=find(n=>n.className==='pages-widget'),label=find(n=>n.className==='pages-owner-label');outer.emit('click',{target:label,detail:0});await f.drain();
  assert.equal(el('pages-settings').hidden,false);assert.match(read('apps/web/index.html'),/<span id="pages-columns-title" class="group-label">Keys per row<\/span>/);
  assert.equal(el('pages-columns-side').textContent,'This screen: wide');assert.equal(el('pages-columns-wide-row').dataset.active,'true');assert.equal(el('pages-columns-narrow-row').dataset.active,'false');
  for(const side of ['wide','narrow']){assert.equal(el(`pages-columns-${side}-auto`).getAttribute('aria-pressed'),'true');assert.equal(el(`pages-columns-${side}`).disabled,true);assert.equal(el(`pages-columns-${side}`).value,'');}
  assert.match(el('pages-columns-note').textContent,/Auto/);
  const perRow=()=>{const ys=[...Array(14).keys()].map(i=>parseFloat(treeFind(el('button-grid'),n=>n.dataset?.buttonId===`k${i}`).style['--ky']));return ys.filter(y=>y===ys[0]).length;};
  const auto=perRow();
  el('pages-columns-wide-auto').emit('click');await f.drain();
  assert.equal(el('pages-columns-wide-auto').getAttribute('aria-pressed'),'false');assert.equal(el('pages-columns-wide').disabled,false);assert.equal(el('pages-columns-wide').value,String(auto),'it starts from the columns the page has now');assert.equal(el('desk-save').hidden,false);
  const input=el('pages-columns-wide');input.focus();input.value='6';input.emit('input');await f.drain();assert.equal(perRow(),6,'a live preview in the draft');
  for(const badValue of ['','0','17','2.5','abc','-3']){
    input.value=badValue;input.emit('input');await f.drain();
    assert.match(el('pages-columns-error').textContent,/whole number from 1 to 16/,JSON.stringify(badValue));assert.equal(el('desk-save').disabled,true,'Save is blocked');assert.equal(input.getAttribute('aria-invalid'),'true');
    assert.equal(el('pages-invalid-warning').hidden,false);
  }
  f.el('desk-save').emit('click');await f.drain();assert.equal(f.count('configuration/save'),0);
  f.el('edit-undo').emit('click');await f.drain();assert.equal(el('pages-columns-error').textContent,'','Undo drops the bad text');assert.equal(el('pages-columns-wide').value,'6');
  input.value='4';input.emit('input');await f.drain();assert.equal(perRow(),4);
  el('pages-columns-narrow-auto').emit('click');await f.drain();assert.equal(el('pages-columns-narrow').value,'4','a narrow row starts at 4 when it is not this screen');
  const narrow=el('pages-columns-narrow');narrow.value='2';narrow.emit('input');await f.drain();
  el('desk-save').emit('click');await f.until(()=>f.count('configuration/save')===1);await f.drain();
  assert.deepEqual(f.calls.findLast(c=>c.path==='/api/configuration/save').data.widgets[0].columns,{wide:4,narrow:2});
  el('pages-columns-wide-auto').emit('click');await f.drain();el('pages-columns-narrow-auto').emit('click');await f.drain();
  el('desk-save').emit('click');await f.until(()=>f.count('configuration/save')===2);await f.drain();
  assert.equal('columns' in f.calls.findLast(c=>c.path==='/api/configuration/save').data.widgets[0],false,'Auto on both sides removes the field');
  assert.match(css,/\.columns-row\{display:grid/);assert.match(css,/#pages-settings \.columns-row input\{min-height:var\(--ctl-h\)/);assert.match(css,/--ctl-h:36px/);
});
test('T91 settings card says when the count was raised to the widest item or held at 44px',async t=>{
  const open=async(config,viewport)=>{const f=await client(t,{configuration:config,viewport});f.el('edit-layout').emit('click');await f.drain();
    const find=p=>treeFind(f.el('button-grid'),p);find(n=>n.className==='pages-widget').emit('click',{target:find(n=>n.className==='pages-owner-label'),detail:0});await f.drain();await f.drain();return f;};
  const raised=await open(withColumns({wide:2},[key('w',APP,{size:'Wide'}),...keys(3)]),{width:1200,height:900});assert.match(raised.el('pages-columns-note').textContent,/widest item needs 4 columns, so this row uses 4/);
  const floored=await open(withColumns({narrow:16},keys(20)),{width:375,height:800});assert.equal(floored.el('pages-columns-side').textContent,'This screen: narrow');assert.match(floored.el('pages-columns-note').textContent,/44px/);
  const plain=await open(withColumns({wide:6},keys(3)),{width:1200,height:900});assert.equal(plain.el('pages-columns-note').textContent,'');
});

// ---- the Library --------------------------------------------------------------------------------------------------------------------------------
test('T91 Library > Pages offers Key pages and Info panel with the right size and columns, each added with fresh ids',async t=>{
  const cards=previewsFor(LIBRARY_TYPES[2]);assert.deepEqual(cards.map(c=>c.caption),['Key pages','Info panel']);assert.deepEqual(cards.map(c=>c.spec.preset),['keys','info']);assert.ok(!JSON.stringify(cards).includes('MainKey'));
  assert.deepEqual(PAGES_PRESETS.keys.size,{w:{mode:'fill',min:240},h:{mode:'fill',min:240}});assert.deepEqual(PAGES_PRESETS.keys.columns,{wide:8,narrow:4});
  assert.deepEqual(PAGES_PRESETS.info.size,{w:{mode:'fixed',u:480},h:{mode:'fill',min:240}});assert.deepEqual(PAGES_PRESETS.info.columns,{wide:2,narrow:2});
  const f=await client(t,{apps:[{id:'test.app',name:'Fake app'}],viewport:{width:1366,height:900}});f.el('edit-layout').emit('click');f.el('shelf-toggle').emit('click');await f.drain();
  f.el('shelf-types').children[2].emit('click');await f.drain();
  const tiles=f.el('shelf-previews').children.filter(n=>n.className?.includes('shelf-card'));assert.equal(tiles.length,2);
  assert.deepEqual(tiles.map(n=>n.children.at(-1).textContent),['Key pages','Info panel']);assert.deepEqual(tiles.map(n=>n.dataset.preset),['keys','info']);
  const drawing=n=>treeFind(n,x=>x.className==='shelf-pages-grid');assert.equal(drawing(tiles[0]).style['--cols'],'8');assert.equal(drawing(tiles[1]).style['--cols'],'2');
  tiles[0].emit('click');await f.drain();tiles[1].emit('click');await f.drain();tiles[1].emit('click');await f.drain();
  f.el('desk-save').emit('click');await f.until(()=>f.count('configuration/save')===1);await f.drain();
  const saved=C.parseConfig(f.calls.findLast(c=>c.path==='/api/configuration/save').data),groups=saved.widgets.filter(w=>w.kind==='pages');
  assert.equal(groups.length,4,'the starting Pages group and three new ones');
  assert.deepEqual([groups[1].size,groups[1].columns],[PAGES_PRESETS.keys.size,PAGES_PRESETS.keys.columns]);
  assert.deepEqual([groups[2].size,groups[2].columns],[PAGES_PRESETS.info.size,PAGES_PRESETS.info.columns]);
  assert.equal(new Set(groups.flatMap(g=>[g.id,...g.pages.map(p=>p.id)])).size,8,'every id is unique');assert.ok(groups.slice(1).every(g=>g.pages.length===1&&g.pages[0].name==='Page 1'));
  assert.match(css,/\.shelf-pages\{/);assert.doesNotMatch(css.slice(css.indexOf('.shelf-pages{'),css.indexOf('.shelf-pages-key{')+160),/#[0-9a-fA-F]{3,8}\b/,'theme tokens only');
});
test('T91 a layout from before T91 is unchanged: no columns, the same flow',()=>{
  const old=C.initialView();assert.equal('columns' in old.widgets[0],false);assert.deepEqual(C.parseConfig(JSON.parse(JSON.stringify(old))),old);
  const a=flowLayout(keys(10),700,'compact',GAP,INSET),b=flowLayout(keys(10),700,'compact',GAP,INSET,0,0,undefined);assert.deepEqual(a,b);
});