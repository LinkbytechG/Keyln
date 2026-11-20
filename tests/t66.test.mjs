import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../dist/packages/contracts/index.js';
import {flowLayout} from '../dist/apps/web/page-view.js';
import {client} from './helpers/client-harness.mjs';
import {key} from './helpers/layout.mjs';
import {responsiveBoxes,treeFind,treeAll} from './helpers/responsive-boxes.mjs';
const APP={type:'app.open',appId:'test.app'};
const scene=()=>({...C.initialView(),widgets:[key('outside',APP),{id:'main',kind:'pages',pages:[{id:'ai',name:'AI',widgets:Array.from({length:24},(_,n)=>key(`key-${n}`,APP))},{id:'apps',name:'App',widgets:[]}]}]});
async function world(t,width=1366,height=768){
  const f=await client(t,{configuration:scene(),deviceTheme:{theme:'braun'},viewport:{width,height}});
  await f.until(()=>!f.el('edit-layout').disabled&&f.state&&f.sockets[0]?.readyState===1);await f.drain();
  return f;
}
const find=(f,predicate)=>treeFind(f.el('button-grid'),predicate);
const inner=f=>find(f,n=>n.className==='button-grid pages-surface');

test('T66 Edit safe geometry exposes each 44px corner target and preserves flow tiers at responsive widths',()=>{
  for(const size of C.gridSizes)for(const width of [188,288,375,768,1366]){
    const widgets=['S','M','L','XL','Tall','Wide'].map((tier,n)=>({...key(`k${n}`,APP),size:tier}));
    const edit=flowLayout(widgets,width,size,8,14);
    for(const p of edit.placements){
      assert.ok(p.left-14>=0&&p.top-14>=0,'the full hit box starts inside the scroll surface');
      assert.ok(p.left-14+44<=edit.width&&p.top-14+44<=edit.height,'the full hit box ends inside the scroll surface');
      assert.ok(p.width>=44&&p.height>=44);
      assert.ok(Math.abs(p.width-((C.TIER_SPAN[widgets.find(w=>w.id===p.id).size].cols*edit.pitch)-8))<1e-9);
    }
    assert.deepEqual(edit.placements.map(p=>p.id),widgets.map(p=>p.id));
    assert.ok(edit.width<=width+.5||edit.overflow,'impossible widths explicitly scroll');
  }
});

test('T66 page and top-level safety stays in rendered geometry; Undo/Save keep position-free data',async t=>{
  const f=await world(t),before=structuredClone(f.state.config);
  // T97: a top-level key in a wide window sits 1u (1px) from the canvas edge, left and top (a key inside a page keeps its 14px).
  assert.equal(f.button('outside').style['--kx'],'1');assert.equal(f.button('key-0').style['--kx'],'14');
  assert.equal(f.button('outside').style['--ky'],'1');assert.equal(f.button('key-0').style['--ky'],'14');
  f.el('edit-layout').emit('click');await f.drain();responsiveBoxes(f);
  for(const id of ['outside','key-0']){
    const node=f.button(id),minus=find(f,n=>n.dataset.removeFor===id);
    assert.equal(node.style['--kx'],id==='outside'?'1':'14');
    assert.equal(minus.rect.width,44);assert.equal(minus.rect.height,44);
    // T97: the 44px target of a "−" on an item 1u from the canvas edge reaches past the edge; the badge is drawn inward (clamped to 3px) so its 22px disc (centred, 11px in) is whole inside the canvas.
    // Anywhere else (a page) the whole target is inside the surface.
    if(id==='outside'){assert.ok(minus.rect.left+11>=node.parentElement.rect.left&&minus.rect.top+11>=node.parentElement.rect.top,'the disc is inside the canvas');}
    else assert.ok(minus.rect.left>=node.parentElement.rect.left&&minus.rect.top>=node.parentElement.rect.top);
  }
  inner(f).parentElement.scrollTop=140;inner(f).parentElement.emit('scroll');
  find(f,n=>n.dataset.removeFor==='key-0').emit('click');await f.drain();
  assert.equal(inner(f).parentElement.scrollTop,140);assert.equal(f.count('configuration/save'),0);
  f.el('edit-undo').emit('click');await f.drain();assert.ok(f.button('key-0'));assert.equal(f.el('desk-save').hidden,true);
  f.el('grid-size').value='compact';f.el('grid-size').emit('change');await f.drain();
  f.el('desk-save').emit('click');await f.until(()=>f.count('configuration/save')===1&&f.state.config.gridSize==='compact'&&f.el('desk-save').hidden);await f.drain();
  assert.deepEqual(f.state.config.widgets,before.widgets);assert.equal(f.state.config.gridSize,'compact');
  assert.doesNotMatch(JSON.stringify(f.state.config),/"(?:cell|inset|padding|span)":/);
  f.el('edit-back').emit('click');await f.drain();assert.equal(f.button('outside').style['--kx'],'1');assert.equal(f.button('key-0').style['--kx'],'14');
});

test('T66 Pages removal belongs to a fixed named parent header, independent from child tabs and component badges',async t=>{
  const f=await world(t);f.el('edit-layout').emit('click');await f.drain();
  const owner=find(f,n=>n.className==='pages-owner'),tabs=find(f,n=>n.className==='pages-tabs');
  assert.equal(owner.parentElement,tabs.parentElement);assert.equal(owner.children[1].textContent,'Pages');
  const remove=owner.children[0];assert.equal(remove.dataset.removeFor,'main');
  assert.equal(remove.getAttribute('aria-label'),'Remove Pages group and all its pages');assert.equal(remove.title,remove.getAttribute('aria-label'));
  assert.ok(!tabs.contains(remove));assert.equal(treeAll(tabs,n=>n.dataset.removeFor).length,0);
  owner.parentElement.parentElement.emit('click',{target:owner});await f.drain();assert.equal(f.el('editor').hidden,false);
  remove.emit('click');await f.drain();assert.match(f.el('confirm-message').textContent,/Pages widget, its 2 pages and the 24 components/);
  f.el('confirm-no').emit('click');await f.drain();assert.ok(f.button('key-0'));
  f.page('apps').emit('click');await f.drain();assert.equal(inner(f).dataset.pageId,'apps');
  find(f,n=>n.dataset.addPage==='main').emit('click');await f.drain();assert.equal(treeAll(f.el('button-grid'),n=>n.className==='use-page').length,3);
  assert.equal(f.count('configuration/save'),0);assert.equal(f.count('execute'),0);
});

test('T66 canvas stays whole under the floating toolbar when Save toggles; the rising library takes its measured room (T83)',async t=>{
  for(const width of [320,768,1366])await t.test(String(width),async t=>{
    const f=await world(t,width,812),el=f.el,row=el('edit-float-row');
    const bottom=()=>parseFloat(el('grid-frame').style.top)+parseFloat(el('grid-frame').style.height),use=bottom();
    row.rect={left:8,top:750,width:width-16,height:50};
    el('edit-layout').emit('click');await f.drain();
    assert.equal(bottom(),use,'the toolbar reserves nothing');
    const cleanBottom=bottom();el('grid-size').value='large';el('grid-size').emit('change');await f.drain();
    assert.equal(el('desk-save').hidden,false);assert.equal(bottom(),cleanBottom,'Save appearing widens the bar (it grows, it reserves nothing)');
    el('shelf-panel').rect={left:0,top:370,width,height:442};el('shelf-toggle').emit('click');await f.drain();assert.ok(bottom()<=363);
    assert.equal(f.count('configuration/save'),0);
  });
});


test('T66 a scrolled page tab hidden behind the fixed Pages controls cannot receive a drop',async t=>{
  const f=await world(t);f.el('edit-layout').emit('click');await f.drain();responsiveBoxes(f);
  const owner=find(f,n=>n.className==='pages-owner'),tab=f.page('ai'),source=f.button('outside');
  // Simulate horizontal scrolling: the first tab's box lies behind the fixed owner,
  // outside its own scrolling viewport. It must not act as an invisible target.
  tab.rect={...tab.rect,left:owner.rect.left,width:owner.rect.width};
  const at={x:owner.rect.left+20,y:owner.rect.top+20},start=source.rect;
  source.emit('pointerdown',{target:source,isPrimary:true,button:0,pointerId:91,pointerType:'mouse',clientX:start.left+30,clientY:start.top+30});
  source.emit('pointermove',{pointerId:91,clientX:start.left+50,clientY:start.top+30});
  f.documentEvents.get('pointermove')({pointerId:91,clientX:at.x,clientY:at.y});
  f.documentEvents.get('pointerup')({pointerId:91,clientX:at.x,clientY:at.y});await f.drain();
  assert.equal(f.el('desk-save').hidden,true);assert.equal(f.button('outside').parentElement,f.el('button-grid'));
  assert.equal(f.count('configuration/save'),0);assert.equal(f.count('execute'),0);
});
