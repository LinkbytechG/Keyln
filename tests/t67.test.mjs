import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../dist/packages/contracts/index.js';
import {client} from './helpers/client-harness.mjs';
import {key} from './helpers/layout.mjs';
import {responsiveBoxes,treeFind,treeAll} from './helpers/responsive-boxes.mjs';
const APP={type:'app.open',appId:'test.app'};
const scene=()=>({...C.initialView(),widgets:[key('outside',APP),{id:'main',kind:'pages',pages:[
  {id:'ai',name:'AI',widgets:Array.from({length:32},(_,n)=>key(`key-${n}`,APP))},
  {id:'apps',name:'App',widgets:[]}
]}]});
async function world(t,configuration=scene(),theme='braun',width=1366,height=912){
  const f=await client(t,{configuration,deviceTheme:{theme},viewport:{width,height}});
  await f.until(()=>!f.el('edit-layout').disabled&&f.state&&f.sockets[0]?.readyState===1);await f.drain();responsiveBoxes(f);return f;
}
const inner=f=>treeFind(f.el('button-grid'),n=>n.className==='button-grid pages-surface');
const geometry=f=>treeAll(f.el('button-grid'),n=>n.dataset.buttonId).map(n=>[n.dataset.buttonId,...['--kx','--ky','--kw','--kh'].map(k=>n.style[k])]);

test('T67 Use separates tabs and ordinary components; Edit keeps the same flow geometry without saving',async t=>{
  for(const theme of C.themes)await t.test(theme,async t=>{
    const f=await world(t,scene(),theme),before=structuredClone(f.state.config);
    for(const [width,height] of [[1366,912],[601,768],[375,812],[320,640]]){
      window.innerWidth=width;window.innerHeight=height;f.windowEvents.get('resize')();await f.drain();responsiveBoxes(f);
      const surface=inner(f),pages=surface.parentElement.parentElement,grid=f.el('button-grid');
      // T97: in a wide window the top-level items keep 1u (1px at the standard grid) from the canvas edge; a narrow window keeps the old spacing.
      const wide=width>600,edge=wide?1:0;
      assert.equal(pages.style['--kx'],String(edge),'Pages itself stays full width, 1u in from each side in a wide window');
      assert.equal(pages.style['--kw'],String(parseFloat(grid.style.width)-edge*2));
      assert.equal(surface.dataset.overflow,'false');
      // T97: the canvas's first row has no room above it (y 0, just under the bar); a key in a page keeps 14px below its strip.
      for(const [id,left,top] of [['outside',wide?'1':'14',wide?'1':'0'],['key-0','14','14']]){
        const node=f.button(id);assert.equal(node.style['--kx'],left);assert.equal(node.style['--ky'],top);
        assert.equal(node.rect.width,node.rect.height);assert.ok(node.rect.width>=44);
      }
      assert.equal(f.button('key-0').rect.top-surface.parentElement.rect.top,14,'first row clears the page strip');
      const use=geometry(f);
      f.el('edit-layout').emit('click');await f.drain();assert.deepEqual(geometry(f),use,'same width means same columns and positions');
      f.el('edit-back').emit('click');await f.drain();assert.deepEqual(geometry(f),use);
    }
    assert.deepEqual(f.state.config,before);assert.equal(f.count('configuration/save'),0);assert.equal(f.count('execute'),0);
  });
});

test('T67 single and empty pages keep full Pages bounds with no extra canvas scroll or writes',async t=>{
  for(const empty of [false,true])await t.test(empty?'empty':'one page',async t=>{
    const config=C.initialView();if(!empty)config.widgets[0].pages[0].widgets=[key('single',APP)];
    const f=await world(t,config,'braun',320,640),surface=inner(f),pages=surface.parentElement.parentElement;
    assert.equal(treeAll(pages,n=>n.className?.startsWith('pages-strip')).length,0,'one Use page needs no tabs');
    assert.equal(parseFloat(f.el('button-grid').style.height),pages.rect.height);
    assert.equal(parseFloat(surface.style.height),surface.parentElement.rect.height);
    if(!empty){assert.equal(f.button('single').style['--kx'],'14');assert.equal(f.button('single').style['--ky'],'14');}
    f.el('edit-layout').emit('click');await f.drain();f.el('edit-back').emit('click');await f.drain();
    assert.deepEqual(f.state.config,config);assert.equal(f.count('configuration/save'),0);
  });
});

test('T67 Use long press can drop in the new leading inset, save order and Undo without executing',async t=>{
  const config=scene();config.widgets.shift();const f=await world(t,config,'braun',320,640),surface=inner(f),body=surface.parentElement;
  const original=structuredClone(f.state.config),node=f.button('key-1'),from=node.rect;
  node.emit('pointerdown',{isPrimary:true,button:0,pointerId:67,pointerType:'mouse',clientX:from.left+20,clientY:from.top+20});
  await f.fireTimer(550);
  const to={pointerId:67,clientX:body.rect.left+2,clientY:body.rect.top+2};
  f.documentEvents.get('pointermove')(to);f.documentEvents.get('pointerup')(to);await f.drain();
  await f.until(()=>f.count('configuration/save')===1);
  assert.deepEqual(f.state.config.widgets[0].pages[0].widgets.slice(0,2).map(n=>n.id),['key-1','key-0']);
  assert.doesNotMatch(JSON.stringify(f.calls.find(c=>c.path==='/api/configuration/save').data),/"(?:inset|padding|cell|span)":/);
  f.el('move-undo').emit('click');await f.until(()=>f.count('configuration/save')===2);
  assert.deepEqual(f.state.config.widgets,original.widgets);assert.equal(f.count('execute'),0);
});
