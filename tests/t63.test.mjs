import {responsiveBoxes} from './helpers/responsive-boxes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as C from '../dist/packages/contracts/index.js';
import {tiersFor,defaultTier,tierAfterFormChange,LIBRARY_TYPES,previewsFor} from '../dist/apps/web/library.js';
import {addWidgetAt,addPage,renamePage,removePage,movePage,resizeWidget} from '../dist/apps/web/page-layout.js';
import {client,deferred} from './helpers/client-harness.mjs';
import {key,group,display} from './helpers/layout.mjs';

// T63 (ADR-064): Mac-style Edit. The compiled client run for real against the minimal DOM of the harness and a controlled transport. This is not browser
// rendering, not real touch and not Surface evidence: it checks what Edit does with the draft, not how it looks.
const clone=value=>JSON.parse(JSON.stringify(value));
const base=()=>clone(C.initialView());
const pagesOf=config=>config.widgets.find(widget=>widget.kind==='pages');
const APP={type:'app.open',appId:'test.app'};
const items=()=>[{id:'i1',label:'One',icon:'app',action:null},{id:'i2',label:'Two',icon:'app',action:null}];
// A canvas of 8 × 5 cells: a Pages widget of 4 × 3 at the corner (page A: k1 k2, page B: k3), a key c1, a clock, a text and a group down column 6 and 7, a result at (4,3).
// Free: the 2 × 3 block at columns 4-5 rows 0-2, and the bottom row.
const scene=()=>{
  const config=base();
  config.widgets=[{...pagesOf(base()),pages:[
    {id:'a',name:'A',widgets:[{...key('k1',APP),},{...key('k2',APP),}]},
    {id:'b',name:'B',widgets:[{...key('k3',APP),}]}]},
    {...key('c1',APP),},
    {...display('t1','text','title',{x:6,y:2,size:'M'},{text:'Hello'})},
    {...display('clk','clock','time',{x:6,y:1,size:'M'})},
    {...display('res','clock','time',{x:4,y:3,size:'M'})},
    {...display('g1','text','title',{size:'M'},{text:'Extra'})}];
  return config;
};
const find=(node,match)=>{for(const child of node.children??[]){if(match(child))return child;const found=find(child,match);if(found)return found;}return undefined;};
const findAll=(node,match,out=[])=>{for(const child of node.children??[]){if(match(child))out.push(child);findAll(child,match,out);}return out;};
const key_=(event={})=>({preventDefault(){},stopPropagation(){},...event});

async function world(t,config=scene(),extra={}){
  const f=await client(t,{configuration:C.parseConfig({...config,revision:2}),viewport:{width:1366,height:768},...extra});
  await f.until(()=>f.el('edit-layout').disabled===false&&f.state&&f.sockets[0]?.readyState===1);await f.drain();
  const {el}=f;
  const grid=()=>el('button-grid');
  const saves=()=>f.calls.filter(call=>call.path==='/api/configuration/save');
  const enter=async()=>{el('edit-layout').emit('click');await f.drain();assert.equal(el('shell').dataset.editing,'true');};
  const removeButton=id=>find(grid(),node=>node.dataset?.removeFor===id);
  const removable=()=>findAll(grid(),node=>node.dataset?.removeFor).map(node=>node.dataset.removeFor).sort();
  const size=()=>parseFloat(grid().style['--cell']);
  const surfaces=()=>[grid(),...findAll(grid(),node=>node.className==='button-grid pages-surface')];
  // The harness gives nodes a box only when a test says so: the canvas at 0,0 with square cells, the page group's grid inside it.
  const boxes=()=>responsiveBoxes(f);
  const inner=()=>{boxes();const surface=surfaces()[1];return {surface,cell:parseFloat(surface.style['--cell']),at:(cx,cy)=>[surface.rect.left+(cx+.5)*parseFloat(surface.style['--cell']),surface.rect.top+(cy+.5)*parseFloat(surface.style['--cell'])]};};
  const onCanvas=(cx,cy)=>[(cx+.5)*size(),(cy+.5)*size()];
  // A drag: press on the node, move past the threshold, follow the finger on the document, then let go.
  const drag=(node,from,to,pointerId=1)=>{
    boxes();node.emit('pointerdown',{isPrimary:true,button:0,pointerId,pointerType:'mouse',clientX:from[0],clientY:from[1]});
    node.emit('pointermove',{pointerId,clientX:from[0]+20,clientY:from[1]+20});
    f.documentEvents.get('pointermove')({pointerId,clientX:to[0],clientY:to[1]});
    return {release:async()=>{f.documentEvents.get('pointerup')({pointerId,clientX:to[0],clientY:to[1]});await f.drain();}};
  };
  const save=async()=>{const before=saves().length;el('desk-save').emit('click');await f.until(()=>saves().length>before);await f.drain();return C.parseConfig(saves().at(-1).data);};
  const keydown=event=>f.windowEvents.get('keydown')(key_(event));
  const savedState=()=>C.parseConfig(f.state.config);
  return {f,el,grid,saves,enter,removeButton,removable,size,surfaces,boxes,inner,onCanvas,drag,save,keydown,savedState};
}
const cellOf=(f,id)=>{const node=f.button(id)??find(f.el('button-grid'),n=>n.dataset?.widgetId===id);return [parseFloat(node.style['--kx'])/120,parseFloat(node.style['--ky'])/120];};

// ---- 1. Entering, Done, Esc ----------------------------------------------------------------------------------------------------------------
test('Edit starts from the Use | Edit switch and ends with Done or Esc; with no change nothing is asked and nothing is saved',async t=>{
  const w=await world(t),{f,el}=w;
  assert.equal(el('edit-float').hidden,true,'no floating area in Use mode');
  await w.enter();assert.equal(el('edit-float').hidden,false);
  assert.equal(el('editor').hidden,true,'entering Edit opens nothing');assert.equal(el('shelf-panel').hidden,true);assert.equal(el('desk-save').hidden,true,'Save appears with a change');
  assert.equal(el('edit-undo').disabled,true);
  el('edit-back').emit('click');await f.drain();assert.equal(el('shell').dataset.editing,'false');assert.equal(el('edit-float').hidden,true);
  await w.enter();w.keydown({key:'Escape'});await f.drain();assert.equal(el('shell').dataset.editing,'false','Esc is Done');
  await w.enter();w.keydown({key:'Escape',target:{tagName:'INPUT'}});await f.drain();assert.equal(el('shell').dataset.editing,'true','Esc inside a text field does not leave Edit');
  assert.equal(w.saves().length,0);assert.equal(f.count('execute'),0);
});
test('Done with unsaved changes asks: Save leaves after saving, Discard leaves without saving, Keep editing stays; Esc answers Keep editing',async t=>{
  const w=await world(t),{f,el}=w;await w.enter();
  w.removeButton('k2').emit('click');await f.drain();assert.equal(el('desk-save').hidden,false);assert.equal(el('save-message').dataset.dirty,'true');
  el('edit-back').emit('click');await f.drain();
  assert.equal(el('layout-confirm').hidden,false);assert.equal(el('confirm-save').hidden,false);assert.match(el('confirm-message').textContent,/unsaved changes/);assert.equal(el('shell').dataset.editing,'true');
  w.keydown({key:'Escape'});await f.drain();assert.equal(el('layout-confirm').hidden,true,'Esc closes the question');assert.equal(el('shell').dataset.editing,'true');
  el('edit-back').emit('click');await f.drain();el('confirm-no').emit('click');await f.drain();assert.equal(el('layout-confirm').hidden,true);assert.equal(el('shell').dataset.editing,'true');assert.equal(f.button('k2'),undefined,'the draft is kept');
  el('edit-back').emit('click');await f.drain();el('confirm-yes').emit('click');await f.drain();
  assert.equal(el('shell').dataset.editing,'false');assert.equal(w.saves().length,0,'Discard saves nothing');
  await w.enter();assert.ok(f.button('k2'),'the discarded change is gone');
  w.removeButton('k2').emit('click');await f.drain();el('edit-back').emit('click');await f.drain();el('confirm-save').emit('click');
  await f.until(()=>w.saves().length===1&&el('shell').dataset.editing==='false');
  assert.equal(C.findComponent(C.parseConfig(w.saves()[0].data),'k2'),undefined);assert.equal(w.saves()[0].data.revision,2,'the save carries the revision it was made on');
});
test('the system components are never editable: no "−", no card, no menu; only the widgets of the configuration have a "−"',async t=>{
  const w=await world(t),{f,el}=w;await w.enter();
  assert.deepEqual(w.removable(),['c1','clk','g1','k1','k2','main','res','t1'].sort(),'the page group is one of them; its page tabs and the system parts are not');
  for(const id of ['mode-switch','connection','connection-settings','system-bar']){
    const node=el(id);assert.equal(find(w.grid(),n=>n===node),undefined,`${id} is not inside the canvas`);
    node.emit('click',{target:node});node.emit('contextmenu',{clientX:5,clientY:5});
  }
  assert.equal(el('editor').hidden,true);assert.equal(el('edit-menu').hidden,true);
  assert.equal(C.allComponents(f.state.config).every(item=>!['mode-switch','settings','connection'].includes(item.kind)),true);
});

// ---- 2. The "−" and Undo ---------------------------------------------------------------------------------------------------------------------
test('"−" removes a key or a display widget at once; Undo (the button and Ctrl/Cmd+Z) brings it back; nothing is saved until Save',async t=>{
  const w=await world(t),{f,el}=w;await w.enter();
  assert.equal(w.removeButton('k1').getAttribute('aria-label'),'Remove My first button');
  w.removeButton('k1').emit('click');await f.drain();assert.equal(f.button('k1'),undefined);assert.equal(w.saves().length,0);assert.equal(el('edit-undo').disabled,false);
  el('edit-undo').emit('click');await f.drain();assert.ok(f.button('k1'));assert.equal(el('desk-save').hidden,true,'back to the saved state: no change left');assert.equal(el('edit-undo').disabled,true);
  w.removeButton('t1').emit('click');await f.drain();assert.equal(w.removable().includes('t1'),false);
  w.keydown({key:'z',ctrlKey:true});await f.drain();assert.equal(w.removable().includes('t1'),true,'Ctrl+Z undoes');
  w.removeButton('clk').emit('click');await f.drain();w.keydown({key:'z',metaKey:true});await f.drain();assert.equal(w.removable().includes('clk'),true,'Cmd+Z undoes');
  w.removeButton('k1').emit('click');await f.drain();w.keydown({key:'z',ctrlKey:true,target:{tagName:'INPUT'}});await f.drain();assert.equal(f.button('k1'),undefined,'inside a text field Ctrl+Z is the field\'s own');
  const saved=await w.save();assert.equal(C.findComponent(saved,'k1'),undefined);assert.ok(C.findComponent(saved,'k2'));
});


// ---- 3. The settings card ----------------------------------------------------------------------------------------------------------------------
const widgetNode=(f,id)=>find(f.el('button-grid'),node=>node.dataset?.widgetId===id&&node.className==='canvas-widget');
const stripOf=f=>find(f.el('button-grid'),node=>(node.className??'').startsWith('pages-strip'));
// In a browser an event on the empty strip bubbles to the Pages widget that listens; the fake DOM does not bubble, so the event goes to the widget with the strip as its target.
const onStrip=(f,type,event={})=>find(f.el('button-grid'),node=>node.className==='pages-widget').emit(type,{target:stripOf(f),...event});
test('a tap on a component opens its small settings card (size row first); a tap on empty canvas or empty page area opens nothing and closes an open card',async t=>{
  const w=await world(t),{f,el}=w;await w.enter();
  el('button-grid').emit('click',{target:el('button-grid')});el('grid-frame').emit('click',{target:el('grid-frame')});assert.equal(el('editor').hidden,true,'a tap on empty canvas opens nothing');assert.equal(el('desk-save').hidden,true);
  f.button('k1').emit('click');await f.drain();
  assert.equal(el('editor').hidden,false);assert.equal(el('editor-title').textContent,'Key');assert.equal(el('editor-sub').textContent,'My first button');assert.equal(el('button-name').value,'My first button');
  assert.equal(el('card-size').hidden,false);assert.equal(el('size-S').getAttribute('aria-pressed'),'true');assert.equal(el('button-fields').hidden,false);assert.equal(el('more-settings').hidden,false);
  assert.equal(el('save-message').dataset.dirty,'false','opening a card changes nothing');
  // Another component replaces the card; a tap on empty page area closes it.
  f.button('k2').emit('click');await f.drain();assert.equal(el('editor').hidden,false);assert.equal(el('button-name').value,'My first button');
  const {surface}=w.inner();surface.emit('click',{target:surface});await f.drain();assert.equal(el('editor').hidden,true,'empty page area closes the card');
  f.button('k1').emit('click');await f.drain();assert.equal(el('editor').hidden,false);
  el('button-grid').emit('click',{target:el('button-grid')});await f.drain();assert.equal(el('editor').hidden,true,'empty canvas closes the card');
  f.button('k1').emit('click');await f.drain();el('editor-close').emit('click');await f.drain();assert.equal(el('editor').hidden,true);
  assert.equal(w.saves().length,0);assert.equal(f.count('execute'),0,'a tap in Edit never runs an action');
});
test('the card shows what a type needs: a key its name, icon and action; a display widget its form and words; a Pages widget its size and pages',async t=>{
  const w=await world(t),{f,el}=w;await w.enter();
  f.button('k1').emit('click');await f.drain();
  assert.equal(el('display-settings').hidden,true);assert.equal(el('pages-settings').hidden,true);assert.equal(el('action-section').hidden,false);
  widgetNode(f,'t1').emit('click');await f.drain();
  assert.equal(el('editor-title').textContent,'Text');assert.equal(el('display-settings').hidden,false);assert.equal(el('button-fields').hidden,true);assert.equal(el('display-text-field').hidden,false);assert.equal(el('display-text').value,'Hello');
  assert.deepEqual(el('display-forms').children.map(node=>node.dataset.form),['title','note']);
  el('display-text').value='Goodbye';el('display-text').emit('input');await f.drain();
  const saved=await w.save();assert.equal(C.locate(saved,'t1').widget.text,'Goodbye');
  widgetNode(f,'clk').emit('click');await f.drain();assert.equal(el('display-text-field').hidden,true,'only Text has words');
  onStrip(f,'click');await f.drain();
  assert.equal(el('editor-title').textContent,'Pages');assert.equal(el('pages-settings').hidden,false);assert.equal(el('card-size').hidden,true,'Pages automatically fill their area');
  assert.equal(el('pages-list').children.length,2);
});


// ---- 4. The quick menu --------------------------------------------------------------------------------------------------------------------------
const press=(node,x=10,y=10,pointerId=1)=>node.emit('pointerdown',{isPrimary:true,button:0,pointerId,pointerType:'mouse',clientX:x,clientY:y});
test('a long press or a right click on a component opens the quick menu: sizes, Edit, Remove; a long press is no tap and no drag',async t=>{
  const w=await world(t),{f,el}=w;await w.enter();
  press(f.button('k1'));await f.fireTimer(550);
  const menu=el('edit-menu');assert.equal(menu.hidden,false);assert.equal(el('edit-menu-scrim').hidden,false);
  const row=menu.children[0];assert.deepEqual(row.children.map(node=>node.dataset.tier),['S','M','L','Tall','Wide']);assert.equal(row.children[0].getAttribute('aria-pressed'),'true');
  assert.deepEqual(menu.children.slice(1).map(node=>node.textContent),['Edit','Remove']);assert.equal(el('editor').hidden,true,'a long press opens no card');
  f.button('k1').emit('pointerup',{pointerId:1});f.button('k1').emit('click',{detail:1});await f.drain();assert.equal(el('editor').hidden,true,'letting go after the long press is not a tap');
  // A size from the menu changes the draft only.
  row.children.find(node=>node.dataset.tier==='L').emit('click');await f.drain();assert.equal(menu.hidden,true);assert.equal(el('desk-save').hidden,false);assert.equal(w.saves().length,0);
  const resized=await w.save();assert.equal(C.findComponent(resized,'k1').size,'L');
  // Right click: Edit opens the card; Remove removes.
  f.button('k2').emit('contextmenu',{clientX:30,clientY:30});assert.equal(menu.hidden,false);
  menu.children.find(node=>node.textContent==='Edit').emit('click');await f.drain();assert.equal(menu.hidden,true);assert.equal(el('editor').hidden,false);assert.equal(el('editor-sub').textContent,'My first button');
  f.button('k2').emit('contextmenu',{clientX:30,clientY:30});menu.children.find(node=>node.textContent==='Remove').emit('click');await f.drain();assert.equal(f.button('k2'),undefined);
  // A fixed-size clock has no size row; a tap outside or Esc closes its menu without choosing.
  widgetNode(f,'clk').emit('contextmenu',{clientX:50,clientY:50});assert.deepEqual(menu.children.map(node=>node.textContent),['Edit','Remove']);
  menu.emit('keydown',{key:'Escape'});assert.equal(menu.hidden,true);assert.equal(el('shell').dataset.editing,'true','Esc closed the menu, not Edit');
  widgetNode(f,'clk').emit('contextmenu',{clientX:50,clientY:50});el('edit-menu-scrim').emit('click');assert.equal(menu.hidden,true);
  // A Pages widget's menu has no sizes.
  onStrip(f,'contextmenu',{clientX:5,clientY:5});assert.deepEqual(menu.children.map(node=>node.textContent),['Edit','Remove']);
});

// ---- 5. Dragging ------------------------------------------------------------------------------------------------------------------------------
const ghosts=(node)=>findAll(node,n=>n.className==='drop-ghost');





// ---- 6. The component library ---------------------------------------------------------------------------------------------------------------
const card=(f,type,pick={})=>{
  const category=type==='key'?'other':['clock','text','refresh'].includes(type)?'widget':type;
  f.el('shelf-types').children.find(node=>node.dataset.libraryType===category).emit('click');
  if(category==='widget'){const index=['clock','text','refresh'].indexOf(type);f.el('shelf-previews').children[0].children[index].emit('click');}
  return f.el('shelf-previews').children.find(node=>Object.entries(pick).every(([name,value])=>node.dataset[name]===value));
};

test('a click on a preview card puts the component in the first free place of the page that is showing, then the canvas; a key opens its card, a display widget does not',async t=>{
  const w=await world(t),{f,el}=w;await w.enter();el('shelf-toggle').emit('click');
  card(f,'key',{tier:'S'}).emit('click');await f.drain();
  assert.equal(el('editor').hidden,false,'a new key opens its card to be named');assert.equal(el('button-name').value,'New button');assert.equal(el('desk-save').hidden,false);
  card(f,'clock',{form:'time',tier:'M'}).emit('click');await f.drain();
  card(f,'text',{form:'note',tier:'M'}).emit('click');await f.drain();
  const saved=await w.save();
  const added=C.allComponents(saved).find(item=>item.label==='New button');assert.equal(C.locate(saved,added.id).page.id,'a');assert.equal(pagesOf(saved).pages[0].widgets[2].id,added.id,'appended before the later clock and text');assert.equal(added.action,null);assert.equal(added.size,'S');
  const clock=C.locate(saved,'clk')&&saved.widgets.concat(pagesOf(saved).pages.flatMap(page=>page.widgets)).filter(item=>item.kind==='clock'&&!['clk','res'].includes(item.id))[0];
  assert.deepEqual([clock.form,clock.size],['time','M']);
  assert.equal(new Set(C.allComponents(saved).map(item=>item.id)).size,C.allComponents(saved).length);
  // On another page the card goes to that page.
  f.page('b').emit('click');await f.drain();card(f,'key',{tier:'M'}).emit('click');await f.drain();const next=await w.save();
  const onB=C.allComponents(next).filter(item=>C.locate(next,item.id).page?.id==='b');assert.equal(onB.length,2);assert.equal(onB.find(item=>item.id!=='k3').size,'M');
});


test('Import from file… reads and checks a component file first; only the button adds it to the draft, with fresh ids; a bad file says why and adds nothing',async t=>{
  const w=await world(t),{f,el}=w;await w.enter();el('shelf-toggle').emit('click');
  const file=value=>{const bytes=new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value));return {name:'x.keyln-item.json',size:bytes.length,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};};
  el('shelf-import-file').files=[file('not json')];el('shelf-import-file').emit('change');await f.until(()=>/File rejected/.test(el('shelf-message').textContent));assert.equal(el('desk-save').hidden,true);
  el('shelf-import-file').files=[file(C.exportItemFile(C.parseConfig(w.f.state.config),'k1'))];el('shelf-import-file').emit('change');
  await f.until(()=>find(el('shelf-previews'),node=>node.dataset?.shelfImportAdd));
  assert.equal(el('desk-save').hidden,true,'checked, not added');assert.match(el('shelf-previews').children[0].children[0].textContent,/Key “My first button” · S/);
  find(el('shelf-previews'),node=>node.dataset?.shelfImportAdd).emit('click');await f.drain();
  assert.equal(el('desk-save').hidden,false);assert.equal(el('editor').hidden,false,'the added key opens its card');
  const saved=await w.save();const copies=C.allComponents(saved).filter(item=>item.label==='My first button');assert.equal(copies.length,5,'k1 k2 k3 c1 and the new one all carry the helper\'s label');assert.equal(new Set(copies.map(item=>item.id)).size,5);
  assert.equal(w.saves().length,1);assert.equal(f.count('execute'),0);
});

// ---- 7. The Pages widget in Edit ------------------------------------------------------------------------------------------------------------
const tabs=f=>findAll(f.el('button-grid'),node=>node.dataset?.pageId&&node.className==='use-page');
const addTab=(f,id='main')=>find(f.el('button-grid'),node=>node.dataset?.addPage===id);
const onePage=()=>{const config=scene();pagesOf(config).pages=[{id:'a',name:'A',widgets:[{...key('k1',APP),}]}];return config;};
test('"＋" after the page tabs adds a page and shows it; with one page the strip is there in Edit only; the page is a draft change',async t=>{
  const w=await world(t,onePage()),{f,el}=w;
  assert.equal(stripOf(f),undefined,'Use mode: one page has no strip');
  await w.enter();assert.ok(stripOf(f),'Edit: the strip carries the "+"');assert.equal(tabs(f).length,1);
  addTab(f).emit('click');await f.drain();
  assert.equal(tabs(f).length,2);assert.equal(tabs(f)[1].getAttribute('aria-pressed'),'true','the new page is showing');assert.equal(tabs(f)[1].textContent,'Page 2');assert.equal(f.button('k1'),undefined,'and it is empty');
  assert.equal(el('desk-save').hidden,false);assert.equal(w.saves().length,0);
  el('edit-undo').emit('click');await f.drain();assert.equal(tabs(f).length,1);
  addTab(f).emit('click');await f.drain();const saved=await w.save();assert.deepEqual(pagesOf(saved).pages.map(page=>page.name),['A','Page 2']);assert.equal(new Set(pagesOf(saved).pages.map(page=>page.id)).size,2);
  // 16 pages at most.
  for(let n=0;n<14;n++){addTab(f).emit('click');await f.drain();}
  assert.equal(tabs(f).length,16);addTab(f).emit('click');await f.drain();assert.equal(tabs(f).length,16);assert.match(el('save-message').textContent,/up to 16 pages/);
});
test('a long press or right click on a page tab opens the page menu: Rename (the card, with the name focused), Move left, Move right, Delete; the last page cannot be deleted',async t=>{
  const w=await world(t),{f,el}=w;await w.enter();const menu=el('edit-menu');
  press(f.page('b'));await f.fireTimer(550);
  assert.deepEqual(menu.children.map(node=>node.textContent),['Rename','Move left','Move right','Delete']);assert.equal(menu.children[2].disabled,true,'B is the last: nothing to its right');assert.equal(menu.children[1].disabled,false);
  menu.children[0].emit('click');await f.drain();
  assert.equal(el('editor-title').textContent,'Pages');const row=find(el('pages-list'),node=>node.dataset?.pageId==='b');assert.equal(globalThis.document.activeElement,row.children[0],'the name of the page is ready to type');
  // typing renames; a run of typing is one Undo step
  for(const text of ['R','Re','Ren']){row.children[0].value=text;row.children[0].emit('input');}
  await f.drain();assert.equal(f.page('b').textContent,'Ren');assert.equal(row.children[0].value,'Ren','typing does not rebuild the field');
  el('edit-undo').emit('click');await f.drain();assert.equal(f.page('b').textContent,'B','one Undo for the whole run');
  // order
  f.page('a').emit('contextmenu',{clientX:3,clientY:3});assert.equal(menu.children[1].disabled,true,'A is first');menu.children[2].emit('click');await f.drain();
  assert.deepEqual(tabs(f).map(node=>node.dataset.pageId),['b','a']);
  // delete: a page with components asks first; the last page cannot go
  f.page('b').emit('contextmenu',{clientX:3,clientY:3});menu.children[3].emit('click');await f.drain();assert.match(el('confirm-message').textContent,/Delete this page and the components on it/);
  el('confirm-no').emit('click');await f.drain();assert.equal(tabs(f).length,2);
  f.page('b').emit('contextmenu',{clientX:3,clientY:3});menu.children[3].emit('click');await f.drain();el('confirm-yes').emit('click');await f.drain();
  assert.deepEqual(tabs(f).map(node=>node.dataset.pageId),['a']);
  f.page('a').emit('contextmenu',{clientX:3,clientY:3});assert.equal(menu.children[3].disabled,true,'the last page has no Delete');
  const saved=await w.save();assert.deepEqual(pagesOf(saved).pages.map(page=>page.id),['a']);assert.equal(C.findComponent(saved,'k3'),undefined);
  // an empty page goes without a question
  const empty=await world(t,onePage());await empty.enter();addTab(empty.f).emit('click');await empty.f.drain();
  empty.f.page(tabs(empty.f)[1].dataset.pageId);tabs(empty.f)[1].emit('contextmenu',{clientX:3,clientY:3});empty.el('edit-menu').children[3].emit('click');await empty.f.drain();
  assert.equal(empty.el('layout-confirm').hidden,true);assert.equal(tabs(empty.f).length,1);
});



// ---- 8. Saving, discarding, conflicts, failures ------------------------------------------------------------------------------------------------
test('Save sends the draft with the revision it was made on; the same name, an action, a failed check and Enter in the card all go through the one Save',async t=>{
  const w=await world(t),{f,el}=w;await w.enter();
  f.button('k1').emit('click');await f.drain();
  el('button-name').value='Renamed';el('button-name').emit('input');await f.drain();assert.equal(el('desk-save').hidden,false);assert.equal(el('desk-save').disabled,false);assert.equal(w.saves().length,0);
  assert.equal(f.button('k1').children[2].textContent,'Renamed','the canvas follows the card at once');
  el('config-form').emit('submit');await f.until(()=>el('save-message').textContent==='Saved on your Mac.');
  assert.equal(w.saves().length,1);assert.equal(w.saves()[0].data.revision,2);assert.equal(C.findComponent(w.savedState(),'k1').label,'Renamed');
  assert.equal(el('desk-save').hidden,true);assert.equal(el('editor').hidden,false,'the card stays open after a save');assert.equal(el('button-name').value,'Renamed');assert.equal(el('edit-undo').disabled,true,'Undo starts again after a save');
  // Ctrl/Cmd+S saves too, and a name that is not valid is not sent
  el('button-name').value='';el('button-name').emit('input');w.keydown({key:'s',ctrlKey:true});await f.drain();
  assert.equal(w.saves().length,1);assert.match(el('field-error').textContent,/Button name must contain 1–40/);assert.equal(el('button-name').getAttribute('aria-invalid'),'true');
  el('button-name').value='Back';el('button-name').emit('input');w.keydown({key:'s',metaKey:true});await f.until(()=>w.saves().length===2);assert.equal(w.saves()[1].data.revision,3);
});
test('while a save is in flight everything holds still; a failure keeps the draft and locks Save until the latest layout is loaded; Discard restores the saved layout',async t=>{
  const w=await world(t),{f,el}=w;await w.enter();
  w.removeButton('k2').emit('click');await f.drain();
  const held=deferred();f.heldSave=held;el('desk-save').emit('click');await f.until(()=>w.saves().length===1);
  assert.equal(el('desk-save').disabled,true);assert.equal(el('edit-undo').disabled,true);w.removeButton('k1').emit('click');await f.drain();assert.ok(f.button('k1'),'a "−" does nothing while saving');
  assert.equal(el('edit-back').disabled===true,false);el('edit-back').emit('click');await f.drain();assert.equal(el('shell').dataset.editing,'true','Done waits for the save');
  // the answer is lost: the draft stays and nothing is retried
  held.reject(new Error('network'));await f.until(()=>/draft was kept/.test(el('save-message').textContent));
  assert.equal(f.button('k2'),undefined);assert.equal(el('desk-save').disabled,true,'locked until the latest layout is loaded');assert.equal(el('reload-layout').hidden,false);assert.equal(w.saves().length,1);
  assert.equal(f.count('execute'),0);
  // load latest: confirm, then the saved layout is back
  f.heldSave=undefined;el('reload-layout').emit('click');await f.drain();assert.match(el('confirm-message').textContent,/Discard this draft and load the latest/);assert.equal(el('confirm-save').hidden,true);
  el('confirm-yes').emit('click');await f.until(()=>el('save-message').textContent==='Latest saved layout loaded.');
  assert.ok(f.button('k2'),'the saved layout is back');assert.equal(el('desk-save').hidden,true);
  // a Host error (500) is the same
  f.saveFault={status:500,code:'INTERNAL',message:'The Host failed.'};w.removeButton('k2').emit('click');await f.drain();el('desk-save').emit('click');await f.until(()=>/The Host failed\..*draft was kept/.test(el('save-message').textContent));
  el('config-form').emit('submit');await f.drain();assert.equal(w.saves().length,2,'no second try');
});
test('a conflict (409) never overwrites the Mac: the draft is kept, saving is locked, and only an explicit Discard & load latest moves on',async t=>{
  const w=await world(t),{f,el}=w;await w.enter();
  w.removeButton('k2').emit('click');await f.drain();
  f.state={...f.state,config:{...f.state.config,revision:3}};
  el('desk-save').emit('click');await f.until(()=>/Configuration changed on the Mac\. Your draft was kept/.test(el('save-message').textContent));
  assert.equal(f.state.config.revision,3,'nothing was written');assert.equal(f.button('k2'),undefined);assert.equal(el('desk-save').disabled,true);assert.equal(el('reload-layout').hidden,false);
  el('reload-layout').emit('click');await f.drain();el('confirm-yes').emit('click');await f.until(()=>el('save-message').textContent==='Latest saved layout loaded.');
  assert.ok(f.button('k2'));assert.equal(w.savedState().revision,3);
  // the Mac moves on while the draft is open: the warning says so, the draft keeps its revision, and Save then conflicts
  w.removeButton('k1').emit('click');await f.drain();f.state={...f.state,config:{...f.state.config,revision:4}};f.intervals[0]();await f.until(()=>el('layout-warning').hidden===false);
  assert.match(el('layout-warning').textContent,/Mac layout changed/);assert.equal(f.button('k1'),undefined,'the draft is not replaced under the person');
  // a clean Edit session simply follows the Mac
  el('reload-layout').emit('click');await f.drain();el('confirm-yes').emit('click');await f.until(()=>el('layout-warning').hidden===true);
  const next=clone(f.state.config);next.widgets[0].pages[0].widgets.push({...key('fresh',APP),});next.revision=5;f.state={...f.state,config:next};f.intervals[0]();await f.until(()=>f.button('fresh'));
});
test('the draft survives going offline and coming back; the Mac layout\'s apps, scripts and shortcuts stay selectable in the card',async t=>{
  const w=await world(t),{f,el}=w;await w.enter();
  f.button('k1').emit('click');await f.drain();el('button-name').value='Kept draft';el('button-name').emit('input');
  navigator.onLine=false;f.windowEvents.get('offline')();await f.drain();assert.equal(el('desk-save').disabled,true,'cannot save offline');assert.equal(el('shell').dataset.editing,'true');
  navigator.onLine=true;f.windowEvents.get('online')();await f.fireTimer(0);await f.until(()=>el('connection').textContent==='Mac connected');
  assert.equal(el('button-name').value,'Kept draft');assert.equal(w.saves().length,0);await f.until(()=>el('desk-save').disabled===false);
  // Test on Mac is for the saved key only
  assert.equal(el('test-key').disabled,true,'a draft cannot be tested');await w.save();await f.until(()=>el('test-key').disabled===false);
  el('test-key').emit('click');await f.until(()=>f.count('execute')===1);assert.equal(f.calls.findLast(call=>call.path==='/api/execute').data.componentId,'k1');
});

// ---- 9. Icon upload and the Icon library inside the new card (the flows T62 left without tests) -----------------------------------------
function imageStubs(t,{svgFails=false,tainted=false}={}) {
  const draws=[],images=[],bitmaps=[],png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1EAAAAASUVORK5CYII=';
  const canvas={width:0,height:0,getContext:()=>({clearRect(){},drawImage:(...args)=>draws.push(args)}),toDataURL:()=>{if(tainted)throw Object.assign(new Error('tainted'),{name:'SecurityError'});return png;}};
  const original=document.createElement;document.createElement=tag=>tag==='canvas'?canvas:original(tag);
  globalThis.createImageBitmap=async file=>{const bitmap={width:file.width||640,height:file.height||480,closed:false,close(){this.closed=true;}};bitmaps.push(bitmap);return bitmap;};
  globalThis.Image=class{constructor(){images.push(this);}set src(value){this.url=value;queueMicrotask(()=>svgFails?this.onerror?.({}):this.onload?.({}));}};
  t.after(()=>{delete globalThis.createImageBitmap;delete globalThis.Image;});
  return {draws,images,bitmaps,png,canvas};
}
const jpegBytes=(width,height)=>Uint8Array.from([0xff,0xd8,0xff,0xe0,0,4,0,0,0xff,0xc0,0,11,8,height>>8,height&255,width>>8,width&255,1,1,0x11,0,0xff,0xd9]);
const picture=(name,type,bytes,extra={})=>({name,type,size:bytes.length,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),text:async()=>new TextDecoder().decode(bytes),...extra});
const svgFile=(text,name='icon.svg',type='image/svg+xml')=>picture(name,type,new TextEncoder().encode(text));
async function choose(f,file,done=/./){f.el('icon-source').value='image';f.el('icon-source').emit('change');f.el('icon-image-file').files=[file];f.el('icon-image-file').emit('change');
  await f.until(()=>f.el('icon-upload-message').textContent!=='Preparing icon on this device…'&&done.test(f.el('icon-upload-message').textContent));}
const lastSave=f=>f.calls.findLast(call=>call.path==='/api/configuration/save').data;
const editKey=async(t,extra={})=>{const w=await world(t,onePage(),extra);await w.enter();w.f.button('k1').emit('click');await w.f.drain();return w;};
test('a JPEG is checked from its header, decoded on this device and stored only as a converted icon; wrong or oversized files change nothing',async t=>{
  const w=await editKey(t),{f,el}=w,stubs=imageStubs(t);
  await choose(f,picture('photo.JPG','image/jpeg',jpegBytes(640,480),{width:640,height:480}),/Image ready/);
  assert.deepEqual(stubs.draws[0].slice(1),[0,0,192,144]);assert.equal(stubs.bitmaps[0].closed,true);assert.equal(w.saves().length,0);assert.equal(el('desk-save').hidden,false,'the picture is a draft change');
  el('config-form').emit('submit');await f.until(()=>el('save-message').textContent==='Saved on your Mac.');
  const saved=lastSave(f);assert.deepEqual(C.findComponent(saved,'k1').appearance.glyph,{type:'image',data:stubs.png});assert.doesNotMatch(JSON.stringify(saved),/jpe?g|svg/i);
  for(const [bytes,pattern] of [[jpegBytes(4000,3000),/within 2048/],[jpegBytes(1,2049),/within 2048/],[Uint8Array.from([0xff,0xd8,0xff,0xe0,1,2,3]),/Choose a PNG, WebP, JPEG or SVG/],[new Uint8Array(32),/Choose a PNG, WebP, JPEG or SVG/]]) {
    stubs.bitmaps.length=0;await choose(f,picture('bad.jpg','image/jpeg',bytes),pattern);assert.equal(stubs.bitmaps.length,0,'rejected before decoding');
  }
  await choose(f,{...picture('big.jpg','image/jpeg',jpegBytes(10,10)),size:2*1024*1024+1},/within 2 MiB/);assert.equal(f.count('execute'),0);
});
test('an SVG is decoded only as a data: image with currentColor replaced, in the ink of the key\'s look; nothing is inserted into the page',async t=>{
  const w=await editKey(t),{f,el}=w,stubs=imageStubs(t);
  const body=document.body.children.length,grid=el('button-grid').children.length;
  const text='<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12" fill="none" stroke="currentColor"><script>alert(1)</script><path d="M2 2h20" stroke="currentColor"/></svg>';
  await choose(f,svgFile(text),/Image ready/);
  assert.equal(stubs.images.length,1);const url=stubs.images[0].url;assert.match(url,/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/);
  const decoded=Buffer.from(url.split(',')[1],'base64').toString();assert.ok(!/currentColor/i.test(decoded));assert.equal(decoded.match(/#F1EFE8/g).length,2,'a one-color SVG on a default key is drawn in the light ink');
  assert.match(decoded,/ width="192" height="96"/);assert.doesNotMatch(decoded,/<\?xml/);assert.doesNotMatch(url,/blob:/);
  assert.deepEqual(stubs.draws[0].slice(1),[0,0,192,96]);assert.equal(document.body.children.length,body);assert.equal(el('button-grid').children.length,grid);
  el('config-form').emit('submit');await f.until(()=>el('save-message').textContent==='Saved on your Mac.');
  assert.deepEqual(C.findComponent(lastSave(f),'k1').appearance.glyph,{type:'image',data:stubs.png});assert.doesNotMatch(JSON.stringify(lastSave(f)),/svg/i);
  // the ink follows the look at upload time
  const icon='<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0h10v10z" fill="currentColor"/></svg>';
  el('icon-style-outline').emit('click');await choose(f,svgFile(icon,'outline.svg',''),/Image ready/);
  assert.match(Buffer.from(stubs.images.at(-1).url.split(',')[1],'base64').toString(),/fill="#617C96"/,'an outline key draws the icon in its theme tone');
  el('custom-color-enabled').checked=true;el('custom-color-enabled').emit('change');el('key-tint').value='#102030';el('key-tint').emit('input');
  el('icon-style-tile').emit('click');await choose(f,svgFile(icon),/Image ready/);
  assert.match(Buffer.from(stubs.images.at(-1).url.split(',')[1],'base64').toString(),/fill="#102030"/,'a custom color is used as chosen');
});
test('a tainted canvas, an undecodable SVG or a hostile file gives a clear message and leaves the draft as it was; the key can still be saved by another change',async t=>{
  const w=await editKey(t),{f,el}=w;let stubs;
  const icon='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8z"/></svg>';
  stubs=imageStubs(t,{tainted:true});await choose(f,svgFile(icon),/cannot be converted safely/);
  assert.equal(el('desk-save').hidden,true);assert.equal(el('save-message').dataset.dirty,'false');
  stubs=imageStubs(t,{svgFails:true});await choose(f,svgFile(icon),/could not be decoded/);assert.equal(el('desk-save').hidden,true);assert.equal(w.saves().length,0);
  for(const [file,pattern] of [[svgFile('<html><body>hi</body></html>'),/not an SVG/],[svgFile('plain'),/not an SVG/]]){await choose(f,file,pattern);assert.equal(el('desk-save').hidden,true);}
  el('icon-source').value='builtin';el('icon-source').emit('change');el('button-name').value='Still saves';el('button-name').emit('input');
  el('config-form').emit('submit');await f.until(()=>el('save-message').textContent==='Saved on your Mac.');assert.equal(C.findComponent(w.savedState(),'k1').label,'Still saves');assert.ok(stubs);
});
test('a choice of "My image" that has no picture yet blocks Save with a message; discarding the draft resets the source for the next key',async t=>{
  const w=await editKey(t),{f,el}=w;imageStubs(t);
  el('icon-source').value='image';el('icon-source').emit('change');el('button-name').value='Changed';el('button-name').emit('input');
  el('config-form').emit('submit');await f.drain();assert.equal(w.saves().length,0);assert.match(el('design-message').textContent,/Choose an image/);
  el('edit-back').emit('click');await f.drain();el('confirm-yes').emit('click');await f.drain();assert.equal(el('shell').dataset.editing,'false');
  await w.enter();f.button('k1').emit('click');await f.drain();assert.notEqual(el('icon-source').value,'image','the next session starts from what the key really has');
  el('button-name').value='Plain change';el('button-name').emit('input');el('config-form').emit('submit');await f.until(()=>w.saves().length===1);
});
const libIcon=(set,name,addedAt)=>({id:`${set}:${name}`,set,name,svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><g fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10l9-7l9 7v10H3z"/></g></svg>',setName:'Lucide',license:'ISC',...(addedAt===undefined?{}:{addedAt})});
test('Icon library inside the card: "Use on this key" paints the icon in the key\'s ink, stores only a converted image, and the draft is saved with the rest',async t=>{
  const w=await editKey(t),{f,el}=w,stubs=imageStubs(t);
  f.library=async path=>{if(path==='/api/icon-library')return {ok:true,json:async()=>({icons:[libIcon('lucide','house',9)],sets:[]})};throw new Error(path);};
  el('icon-source').value='library';el('icon-source').emit('change');
  await f.until(()=>el('library-grid').children.length===1&&el('library-search').disabled===false);
  el('library-grid').children[0].emit('click');assert.equal(el('library-use').disabled,false);
  const body=document.body.children.length;el('library-use').emit('click');
  await f.until(()=>/^Icon ready/.test(el('library-message').textContent));
  assert.equal(stubs.images.length,1);const rendered=Buffer.from(stubs.images[0].url.split(',')[1],'base64').toString();assert.doesNotMatch(rendered,/currentColor/i);assert.match(rendered,/stroke="#F1EFE8"/);
  assert.equal(document.body.children.length,body,'the SVG never enters the page');assert.equal(el('desk-save').hidden,false);
  el('config-form').emit('submit');await f.until(()=>el('save-message').textContent==='Saved on your Mac.');
  assert.deepEqual(C.findComponent(lastSave(f),'k1').appearance.glyph,{type:'image',data:stubs.png});assert.doesNotMatch(JSON.stringify(lastSave(f)),/svg|currentColor|house/i);assert.equal(f.count('execute'),0);
});

// ---- 10. Markup, style and documents ---------------------------------------------------------------------------------------------------------
const html=readFileSync(new URL('../apps/web/index.html',import.meta.url),'utf8'),css=readFileSync(new URL('../apps/web/style.css',import.meta.url),'utf8');
const t63css=css.slice(css.indexOf('/* ---------- T63 (ADR-064): Mac-style Edit'));
test('markup: one floating area (Settings, Library, Undo, Save, Done), a settings card, a library panel and a menu; the old toolbar, the Add window and the modal editor are gone',()=>{
  for(const id of ['edit-float','edit-settings','shelf-toggle','edit-undo','desk-save','edit-back','editor','card-size','key-size-options','more-settings','shelf-panel','shelf-search','shelf-types','shelf-previews','shelf-import','shelf-import-file','edit-menu','edit-menu-scrim','display-forms','display-text','grid-size','order-first','order-last','pages-list','pages-add','confirm-save','save-message','reload-layout'])
    assert.match(html,new RegExp(`id="${id}"`),id);
  for(const gone of ['id="edit-bar"','id="add-component"','id="add-dialog"','id="desk-reload"','id="desk-message"','id="new-key-actions"','id="add-review"','id="save-test-key"','<dialog id="editor"','key-preview'])assert.ok(!html.includes(gone),gone);
  assert.match(html,/<section id="editor" class="settings-card" hidden/);
  // T83 (ADR-078): the buttons are one floating toolbar row: grip, Settings, Library, Done, Undo, Save, (Grid size), Collapse; the collapsed icon follows
  const floatArea=html.slice(html.indexOf('<div id="edit-float-row" class="edit-float-row" role="toolbar"'),html.indexOf('<section id="shelf-panel"'));
  assert.deepEqual([...floatArea.matchAll(/<button id="([^"]+)"/g)].map(match=>match[1]),['edit-grip','edit-settings','shelf-toggle','edit-back','edit-undo','desk-save','edit-collapse','edit-chip']);
  // the card: size row first, then the common fields, More… last
  assert.ok(html.indexOf('id="card-size"')<html.indexOf('id="button-name"')&&html.indexOf('id="button-name"')<html.indexOf('id="more-settings"'));
  assert.match(html,/<summary>More…<\/summary>/);
  for(const source of ['add-dialog','edit-bar','key-popup'])assert.ok(!new RegExp(`\\.${source}\\b`).test(css),`.${source} is gone from the stylesheet`);
  const editorSource=readFileSync(new URL('../apps/web/editor.ts',import.meta.url),'utf8');
  assert.doesNotMatch(editorSource,/showModal|addDialog|pruneUntouched|additions|readyToAdd/);
});
test('style: the T63 rules use theme tokens only; wobble only without reduced motion; the "−" has a 44px tap area; narrow windows get a full-width library and card',()=>{
  assert.ok(t63css.length>1000);
  assert.doesNotMatch(t63css,/#[0-9a-fA-F]{3,8}\b/,'no literal colors');assert.doesNotMatch(t63css,/\brgba?\(/);
  assert.match(t63css,/@media\(prefers-reduced-motion:no-preference\)\{[^@]*animation:edit-wobble/);
  assert.doesNotMatch(t63css.replace(/@media\(prefers-reduced-motion:no-preference\)\{[\s\S]*?\n\}\n/,''),/animation:edit-wobble/,'the wobble lives only inside the no-preference query');
  assert.match(t63css,/\.edit-remove\{--pitch[^}]*width:44px;height:44px/s);
  const narrow=t63css.slice(t63css.indexOf('@media(max-width:600px){\n  .shell{--shelf-h'));
  assert.match(narrow,/\.shelf-panel\{grid-template-columns:minmax\(0,1fr\)/);assert.match(narrow,/\.edit-float\{width:calc\(100vw - 16px\)/);assert.match(narrow,/--shelf-h:min\(52dvh,400px\)/);
  assert.match(t63css,/\.shelf-card\{[^}]*min-height:44px/,'.shelf-card is a 44px target (a preview, not a button)');assert.match(t63css,/\.shelf-type\{[^}]*min-height:40px/,'.shelf-type is 40px (T80, ADR-077)');
  for(const rule of ['.menu-item','.menu-size','.form-choice','.pages-row-button'])assert.match(t63css,new RegExp(`${rule.replace('.','\\.')}\\{[^}]*min-height:var\\(--ctl-h\\)`),`${rule} is a 36px control (T79, ADR-076)`);
  assert.match(css,/\.edit-float-button\{[^}]*min-height:var\(--ctl-h\)/,'T80, ADR-077');
});
// ---- round 2: the real order of mouse events ---------------------------------------------------------------------------------------------------


// ---- round 3: hold first, then drag ------------------------------------------------------------------------------------------------------------
