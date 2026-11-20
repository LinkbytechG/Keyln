import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import * as C from '../dist/packages/contracts/index.js';
import {ConfigStore,configurationFile,OLD_FORMAT_MESSAGE} from '../dist/apps/host/store.js';
import {archiveLegacyData} from '../dist/apps/host/archive.js';
import {importPreview} from '../dist/apps/host/layout.js';
import {flowLayout,insertionAt} from '../dist/apps/web/page-view.js';
import {moveWidget,moveToPage,resizeWidget,addWidgetAt,addWidget,containerOf} from '../dist/apps/web/page-layout.js';
import {client} from './helpers/client-harness.mjs';
import {responsiveBoxes,treeFind,treeAll} from './helpers/responsive-boxes.mjs';
import {key,layout} from './helpers/layout.mjs';
const APP={type:'app.open',appId:'test.app'},apps=[{id:'test.app',name:'Test app'}],clone=value=>JSON.parse(JSON.stringify(value));
const ids=widgets=>widgets.map(widget=>widget.id), page=config=>config.widgets.find(C.isPages).pages[0];
const folder=t=>{const dir=mkdtempSync(join(tmpdir(),'keyln-t65-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
function oldConfig(){
  const oldKey=(id,x,y)=>({...key(id,APP),cell:{x,y}});
  return {format:'keyln.config',version:1,revision:27,canvas:{cols:8,rows:5},widgets:[
    oldKey('outside',6,0),{id:'main',kind:'pages',cell:{x:0,y:1},span:{cols:4,rows:3},pages:[
      {id:'a',name:'AI',widgets:[oldKey('second',2,0),{...oldKey('first',0,0),color:'none',appearance:{glyph:{type:'text',text:'AI'}}},oldKey('third',0,1)]},
      {id:'b',name:'Apps',widgets:[]}]}
  ],customThemes:[{id:'theme-one',name:'Mine',base:'metro',accent:'#123456',background:'#101216',keyBody:'#222222',radius:'rounded',spacing:'normal',font:'metro'}],
  workflows:[{id:'flow',name:'Retained',timeoutMs:3000,steps:[{id:'step',action:APP,timeoutMs:1000}]}]};
}
test('T65 v2 has one ordered model: no canvas/cell/span, strict grid size and no nested Pages',()=>{
  const config=C.initialView();assert.equal(config.version,2);assert.equal(config.gridSize,'standard');assert.deepEqual(C.parseConfig(config),config);
  assert.deepEqual(config.widgets,[{id:'main',kind:'pages',pages:[{id:'page-1',name:'Page 1',widgets:[]}]}]);
  for(const gridSize of C.gridSizes)C.parseConfig({...config,gridSize});
  for(const gridSize of ['huge',0,null,undefined])assert.throws(()=>C.parseConfig({...config,gridSize}));
  for(const mutate of [c=>c.canvas={cols:8,rows:5},c=>c.widgets[0].span={cols:8,rows:5},c=>c.widgets[0].cell={x:0,y:0},c=>page(c).widgets=[c.widgets[0]],c=>page(c).widgets=[{...key('x'),cell:{x:0,y:0}}]]){
    const next=clone(config);mutate(next);assert.throws(()=>C.parseConfig(next));
  }
  assert.throws(()=>C.parseConfig(oldConfig()),error=>error.code==='CONFIG_VERSION');
  const many=clone(config);many.widgets[0].pages=Array.from({length:16},(_,n)=>({id:`page-${n}`,name:`Page ${n}`,widgets:[]}));C.parseConfig(many);
  many.widgets[0].pages.push({id:'extra',name:'Extra',widgets:[]});assert.throws(()=>C.parseConfig(many));many.widgets[0].pages=[];assert.throws(()=>C.parseConfig(many));

});
test('T65 v1 read converts each container by y,x, stable original order and preserves complete content/revision',()=>{
  // T94: reading converts to v3 in memory (one layout named Surface); the page-shaped view of that layout is the v2 document the assertions below look at.
  const old=oldConfig(),before=clone(old),doc=C.readConfig(old),next=C.viewFor(doc,'Surface');
  assert.deepEqual(old,before,'reading never mutates its source');assert.equal(doc.version,3);assert.equal(next.version,2);assert.equal(next.revision,27);assert.equal(doc.library.revision,27);assert.equal(doc.layouts[0].revision,27);
  assert.deepEqual(ids(next.widgets),['outside','main']);assert.deepEqual(ids(page(next).widgets),['first','second','third']);
  assert.deepEqual(next.widgets[1].pages.map(p=>[p.id,p.name]),[['a','AI'],['b','Apps']]);
  assert.deepEqual(next.workflows,old.workflows);assert.deepEqual(next.customThemes,old.customThemes);
  for(const item of C.allComponents(next)){const original=C.allComponents(old).find(w=>w.id===item.id),{cell,...body}=original;assert.deepEqual(item,body);}
  assert.doesNotMatch(JSON.stringify(doc),/"(?:canvas|cell|span)":/);assert.deepEqual(C.readConfig(doc),doc);
});
test('T65 v1 boundary rejects damaged positions, overlaps, unknown fields and nested pages before recursion',()=>{
  for(const mutate of [c=>page(c).widgets[0].cell.x=4,c=>page(c).widgets[1].cell={x:2,y:0},c=>page(c).widgets[0].cell.x=.5,c=>c.widgets[1].span.cols=9,c=>c.widgets[1].extra=true,c=>page(c).widgets=[c.widgets[1]]]){
    const next=oldConfig();mutate(next);assert.throws(()=>C.readConfig(next));
  }
});
test('T65 startup/read do not overwrite v1, archive it or move My icons; the Host refuses to run on it (T94: npm run layout:migrate converts it)',t=>{
  const dir=folder(t),old=oldConfig(),bytes=JSON.stringify(old)+'\n';writeFileSync(join(dir,'config.json'),bytes);writeFileSync(join(dir,'icon-library.json'),'{"icons":[]}');writeFileSync(join(dir,'layout-format.json'),JSON.stringify({format:'keyln.config',version:1}));
  assert.equal(archiveLegacyData(dir,()=>{}),undefined);assert.equal(readFileSync(join(dir,'icon-library.json'),'utf8'),'{"icons":[]}');
  assert.throws(()=>new ConfigStore(dir),error=>error.message===OLD_FORMAT_MESSAGE);
  const store=new ConfigStore(dir,true);assert.equal(store.available,false);assert.equal(store.reason,OLD_FORMAT_MESSAGE);assert.throws(()=>store.get(),error=>error.code==='CONFIG_DAMAGED');
  assert.equal(readFileSync(store.path,'utf8'),bytes);assert.equal(readdirSync(dir).some(n=>n.startsWith('archive-')),false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'layout-format.json'),'utf8')),{format:'keyln.config',version:1},'an unmigrated directory is never marked as v3');
  assert.deepEqual(configurationFile(store.path),C.readConfig(old));assert.equal(configurationFile(store.path).version,3);
  assert.throws(()=>store.replace({...old,revision:28},apps),error=>error.code==='CONFIG_DAMAGED'||error.code==='CONFIG_VERSION');assert.equal(readFileSync(store.path,'utf8'),bytes,'nothing was written');
});
test('T65 v1 backup review/restore and CLI recovery convert without losing content and revoke old devices',t=>{
  const dir=folder(t),store=new ConfigStore(dir),old=oldConfig();writeFileSync(store.backup,JSON.stringify(old));
  const review=store.backupState();assert.equal(review.available,true);let revoked=0;
  const restored=store.restoreBackup({stamp:review.stamp,confirm:true},()=>revoked++);
  assert.equal(revoked,1);assert.equal(restored.revision,28);assert.equal(restored.version,2);assert.deepEqual(ids(page(restored).widgets),['first','second','third']);
  writeFileSync(store.backup,JSON.stringify(old));writeFileSync(store.path,'{broken');
  execFileSync(process.execPath,['dist/apps/host/restore.js'],{env:{...process.env,KEYLN_DATA_DIR:dir},stdio:'pipe'});
  assert.equal(configurationFile(store.path).version,3);assert.deepEqual(JSON.parse(readFileSync(join(dir,'devices.json'))).devices,[]);
  assert.ok(readdirSync(dir).some(name=>name.startsWith('config.before-restore-')));
});
test('T65 import review converts v1, export is v3 (its layout view is v2) and component files remain position-free',()=>{
  const preview=importPreview(oldConfig(),apps,()=>{});assert.equal(preview.config.version,3);assert.equal(preview.view.version,2);assert.equal(preview.issues.length,0);
  const exported=JSON.parse(JSON.stringify(preview.config));assert.deepEqual(C.parseConfigDocument(exported),preview.config);assert.deepEqual(C.parseConfig(preview.view),preview.view);
  const item=C.exportItemFile(preview.view,'first'),asConfig=C.itemFileLayout(C.parseItemFile(item));assert.equal(asConfig.version,2);assert.equal(C.allComponents(asConfig)[0].size,'S');assert.doesNotMatch(JSON.stringify(item),/"cell":/);
});
test('T65 flow preserves monotone row-major order without overlap or backfilling, for every tier/width/size',()=>{
  const widgets=Array.from({length:90},(_,n)=>key(`k${n}`,null,{size:C.sizeTiers[(n*7)%6]})),original=clone(widgets);
  for(const gridSize of C.gridSizes)for(const width of [160,272,320,411,720,1366,2200]){
    const view=flowLayout(widgets,width,gridSize,8);assert.deepEqual(ids(view.placements),ids(widgets));
    for(let n=0;n<view.placements.length;n++){
      const rect=view.placements[n];assert.ok(rect.left+rect.width<=view.width+.01);assert.ok(rect.width>=44&&rect.height>=44);
      assert.ok(!view.placements.slice(0,n).some(other=>C.rectsOverlap(other,rect)));
      if(n)assert.ok(rect.y*view.columns+rect.x>view.placements[n-1].y*view.columns+view.placements[n-1].x,'cursor never goes back');
      assert.deepEqual({cols:rect.cols,rows:rect.rows},C.TIER_SPAN[widgets[n].size]);
    }
    if(width>=272)assert.equal(view.overflow,false);
  }
  const holes=flowLayout([key('a',null,{size:'Tall'}),key('b',null,{size:'M'}),key('c',null,{size:'L'}),key('d')],356,'standard',8);
  assert.deepEqual(holes.placements.map(r=>[r.id,r.x,r.y]),[['a',0,0],['b',1,0],['c',1,1],['d',0,2]],'a skipped hole is never filled by a later component');
  assert.deepEqual(widgets,original);
});
test('T65 square basis uses three bounded sizes, does not grow a few keys to fill the screen and exposes impossible widths',()=>{
  for(const size of C.gridSizes){const view=flowLayout([key('a')],2000,size,8);assert.ok(view.cell<=C.GRID_CELL[size]*1.15);assert.equal(view.placements[0].width,view.placements[0].height);}
  const wide=flowLayout([key('wide',null,{size:'Wide'}),key('small')],272,'large',8);assert.equal(wide.overflow,false);assert.ok(wide.cell>=44);assert.equal(wide.columns,4);
  const tiny=flowLayout([key('wide',null,{size:'Wide'})],100,'standard',8);assert.equal(tiny.overflow,true);assert.equal(tiny.cell,44);assert.equal(tiny.width,200);
  assert.equal(flowLayout([],320,'standard',8).height,0);
});
test('T65 insertion hits rendered scrolled boxes before/after, gaps and empty/tail space',()=>{
  const boxes=[{left:10,top:-100,width:88,height:88},{left:106,top:4,width:88,height:176},{left:10,top:190,width:88,height:88}];
  assert.equal(insertionAt(boxes,110,20),1);assert.equal(insertionAt(boxes,190,20),2);assert.equal(insertionAt(boxes,14,185),2);assert.equal(insertionAt(boxes,300,400),3);assert.equal(insertionAt([],50,50),0);
});
test('T65 pure reorder, cross-container moves, add and resize preserve tiers/contents, reject invalid indices and nesting',()=>{
  const config=layout([key('a',APP),key('b',APP,{size:'Wide'}),key('c',APP)]),original=clone(config),ref={pagesId:'main',pageId:'page-1'};
  let next=moveWidget(config,'a',ref,3);assert.deepEqual(ids(page(next).widgets),['b','c','a']);assert.equal(C.findComponent(next,'b').size,'Wide');
  next=moveWidget(next,'a',ref,0);assert.deepEqual(next,config);next=moveWidget(next,'b',{},0);assert.equal(containerOf(next,'b').pagesId,undefined);assert.equal(next.widgets[0].id,'b');
  next=moveToPage(next,'b','main','page-1');assert.equal(page(next).widgets.at(-1).id,'b');
  assert.throws(()=>moveWidget(config,'a',ref,99));assert.throws(()=>moveWidget(config,'a',ref,-1));assert.throws(()=>moveWidget(config,'main',ref,0));assert.throws(()=>addWidgetAt(config,C.initialView().widgets[0],ref,0));
  const long=layout(Array.from({length:100},(_,n)=>key(`n${n}`)));assert.equal(page(addWidget(long,key('more'),ref).config).widgets.length,101);assert.equal(C.findComponent(resizeWidget(long,'n0','Wide'),'n0').size,'Wide');
  assert.deepEqual(config,original);
});
const config=()=>({...layout([key('a',APP),key('b',APP),...Array.from({length:118},(_,n)=>key(`k${n}`,APP))]),revision:4});
async function world(t,configuration=config(),theme='braun',viewport={width:1366,height:912}){
  const f=await client(t,{configuration,deviceTheme:theme,viewport});await f.until(()=>f.button(C.allComponents(configuration)[0]?.id)?.disabled===false||C.allComponents(configuration).length===0);await f.drain();
  responsiveBoxes(f);return f;
}
const surface=f=>treeFind(f.el('button-grid'),node=>node.className==='button-grid pages-surface');
const order=f=>ids(page(f.state.config).widgets);
const center=node=>{const box=node.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2};};
async function drag(f,id,to,{edit=false}={}){
  responsiveBoxes(f);const node=f.button(id)??treeFind(f.el('button-grid'),n=>n.dataset.widgetId===id),from=center(node),pointerId=71;
  node.emit('pointerdown',{isPrimary:true,button:0,pointerId,pointerType:'mouse',clientX:from.x,clientY:from.y});
  if(!edit)await f.fireTimer(550);
  f.documentEvents.get('pointermove')({pointerId,clientX:to.x,clientY:to.y});
  return {drop:async()=>{f.documentEvents.get('pointerup')({pointerId,clientX:to.x,clientY:to.y});await f.drain();},pointerId};
}
test('T65 all six themes fill their actual content area, square cells reflow across screen widths without saving shared config',async t=>{
  for(const theme of C.themes)await t.test(theme,async t=>{
    const f=await world(t,config(),theme),before=clone(f.state.config);
    for(const [width,height] of [[1366,912],[912,1366],[411,860],[320,480]]){
      window.innerWidth=width;window.innerHeight=height;f.windowEvents.get('resize')();await f.drain();responsiveBoxes(f);
      const inner=surface(f),first=f.button('a').rect,outer=inner.parentElement.parentElement.rect,frame=f.el('grid-frame').rect;
      // T97: a wide window's Pages keeps 1u (1px at the standard grid) from the frame edge and the frame has no padding; a narrow window keeps the frame's 4px padding.
      const room=width>600?2:8;assert.equal(first.width,first.height);assert.equal(outer.width,frame.width-room);assert.equal(outer.height,frame.height-room);
      assert.ok(Number(f.button('a').style['--kw'])>=44);assert.equal(inner.dataset.overflow,'false');
      assert.deepEqual(f.state.config,before);assert.equal(f.count('configuration/save'),0);
    }
  });
});
test('T65 a single Pages fills the canvas; long page scrolls inside, multiple Pages and outside widgets form vertical blocks',async t=>{
  const f=await world(t),inner=surface(f),outer=inner.parentElement.parentElement;
  assert.equal(parseFloat(f.el('button-grid').style.height),outer.rect.height+2,'T97: the Pages keeps 1u above and below');assert.ok(parseFloat(inner.style.height)>inner.parentElement.rect.height,'long content uses its own scroll');
  const next=clone(f.state.config);next.widgets.push(key('outside',APP),{id:'p2',kind:'pages',pages:[{id:'empty',name:'Empty',widgets:[]}]});next.revision++;
  f.state={...f.state,config:next};f.sockets[0].state();await f.until(()=>f.button('outside'));responsiveBoxes(f);
  const groups=treeAll(f.el('button-grid'),n=>n.className==='pages-widget');assert.equal(groups.length,2);assert.ok(groups[1].rect.top>groups[0].rect.top+groups[0].rect.height);assert.ok(parseFloat(f.el('button-grid').style.height)>groups[0].rect.height*2);
});
test('T65 Grid size is a shared draft change with Undo/Save and no automatic writes',async t=>{
  const f=await world(t),{el}=f;el('edit-layout').emit('click');await f.drain();
  el('grid-size').value='large';el('grid-size').emit('change');await f.drain();assert.equal(f.count('configuration/save'),0);assert.equal(el('desk-save').hidden,false);assert.equal(f.state.config.gridSize,'standard');
  el('edit-undo').emit('click');await f.drain();assert.equal(el('grid-size').value,'standard');assert.equal(el('desk-save').hidden,true);
  el('grid-size').value='compact';el('grid-size').emit('change');await f.drain();el('desk-save').emit('click');await f.until(()=>f.state.config.gridSize==='compact');assert.equal(f.count('execute'),0);
});
test('T65 first/earlier/later/last give a scroll-independent draft ordering path with Undo',async t=>{
  const f=await world(t),{el}=f;el('edit-layout').emit('click');await f.drain();f.button('a').emit('click');await f.drain();
  el('order-last').emit('click');await f.drain();assert.equal(f.count('configuration/save'),0);assert.equal(el('order-last').disabled,true);assert.ok(parseFloat(f.button('a').style['--ky'])>0);
  el('edit-undo').emit('click');await f.drain();assert.equal(parseFloat(f.button('a').style['--ky']),14);assert.equal(el('order-first').disabled,true);
  el('order-later').emit('click');await f.drain();el('desk-save').emit('click');await f.until(()=>f.count('configuration/save')===1);assert.deepEqual(order(f).slice(0,2),['b','a']);
});
test('T65 Use long-press inserts after a target, saves v2 order and Undo saves original order without executing',async t=>{
  const f=await world(t),original=order(f),box=f.button('b').rect;
  const held=await drag(f,'a',{x:box.left+box.width-4,y:box.top+20});
  const ghost=treeFind(surface(f),n=>n.className==='drop-ghost');assert.equal(ghost.hidden,false);assert.equal(ghost.style.width,'3px');assert.equal(ghost.dataset.refused,'false');
  await held.drop();await f.until(()=>f.count('configuration/save')===1);assert.deepEqual(order(f).slice(0,2),['b','a']);assert.equal(f.calls.find(c=>c.path==='/api/configuration/save').data.version,2);
  f.el('move-undo').emit('click');await f.until(()=>f.count('configuration/save')===2);assert.deepEqual(order(f),original);assert.equal(f.count('execute'),0);
});
test('T65 Edit drag changes only draft; outside drop/Escape/resize cancel, and saving/409 rules remain in force',async t=>{
  const f=await world(t),{el}=f,original=order(f);el('edit-layout').emit('click');await f.drain();responsiveBoxes(f);const b=f.button('b').rect;
  let held=await drag(f,'a',{x:b.left+b.width-2,y:b.top+20},{edit:true});await held.drop();assert.equal(f.count('configuration/save'),0);assert.equal(el('desk-save').hidden,false);
  el('edit-undo').emit('click');await f.drain();responsiveBoxes(f);held=await drag(f,'a',{x:5000,y:5000},{edit:true});await held.drop();assert.equal(el('desk-save').hidden,true);
  held=await drag(f,'a',{x:b.left+b.width-2,y:b.top+20},{edit:true});f.documentEvents.get('keydown')({key:'Escape',preventDefault(){}});await held.drop();assert.equal(el('desk-save').hidden,true);
  held=await drag(f,'a',{x:b.left+b.width-2,y:b.top+20},{edit:true});window.innerWidth=912;window.innerHeight=1366;f.windowEvents.get('resize')();await held.drop();assert.equal(el('desk-save').hidden,true);
  f.button('a').emit('click',{detail:0});await f.drain();el('order-last').emit('click');await f.drain();f.saveFault={status:409,code:'CONFIG_CONFLICT',message:'Changed'};el('desk-save').emit('click');await f.until(()=>el('reload-layout').hidden===false);assert.deepEqual(order(f),original);assert.equal(el('desk-save').disabled,true);
});
test('T65 hit testing follows scroll, keeps scroll through editing/saving, and edge-scrolls toward the tail',async t=>{
  const f=await world(t),{el}=f;el('edit-layout').emit('click');await f.drain();let body=surface(f).parentElement;body.scrollTop=120;body.emit('scroll');responsiveBoxes(f);
  f.button('a').emit('click');await f.drain();el('button-name').value='Renamed';el('button-name').emit('input');await f.drain();body=surface(f).parentElement;assert.equal(body.scrollTop,120);
  el('desk-save').emit('click');await f.until(()=>f.count('configuration/save')===1);await f.drain();assert.equal(surface(f).parentElement.scrollTop,120);
  responsiveBoxes(f);const visible=treeAll(surface(f),n=>n.dataset.buttonId).find(n=>n.rect.top>=surface(f).parentElement.rect.top+20),id=visible.dataset.buttonId,bounds=surface(f).parentElement.rect;
  const held=await drag(f,id,{x:bounds.left+20,y:bounds.top+bounds.height-2},{edit:true});const before=surface(f).parentElement.scrollTop;await f.fireTimer(32);assert.ok(surface(f).parentElement.scrollTop>before);responsiveBoxes(f);await held.drop();assert.equal(f.count('execute'),0);
});
test('T65 cross-page tabs append to the destination; canvas/page moves and multiple Pages remain non-nested',async t=>{
  const next=config();next.widgets[0].pages.push({id:'other',name:'Other',widgets:[key('other-key',APP)]});next.widgets.push(key('outside',APP));
  const f=await world(t,next);responsiveBoxes(f);const tab=f.page('other').rect;await (await drag(f,'a',{x:tab.left+20,y:tab.top+20})).drop();await f.until(()=>f.count('configuration/save')===1);assert.deepEqual(ids(f.state.config.widgets[0].pages[1].widgets),['other-key','a']);
  f.el('edit-layout').emit('click');await f.drain();responsiveBoxes(f);const held=await drag(f,'b',{x:20,y:200},{edit:true});f.el('grid-frame').scrollTop=parseFloat(f.el('button-grid').style.height)-f.el('grid-frame').rect.height;responsiveBoxes(f);const outer=f.button('outside').rect;f.documentEvents.get('pointermove')({pointerId:held.pointerId,clientX:outer.left+2,clientY:outer.top+20});f.documentEvents.get('pointerup')({pointerId:held.pointerId,clientX:outer.left+2,clientY:outer.top+20});await f.drain();assert.equal(f.count('configuration/save'),1);f.el('desk-save').emit('click');await f.until(()=>f.count('configuration/save')===2);assert.equal(C.locate(f.state.config,'b').parent,undefined);
});
test('T65 measured client sizes exclude native scrollbars from the canvas and page flow',async t=>{
  const f=await world(t),frame=f.el('grid-frame'),inner=surface(f),body=inner.parentElement;
  frame.clientWidth=900;frame.clientHeight=600;body.clientWidth=880;body.clientHeight=500;
  f.windowEvents.get('resize')();await f.drain();
  assert.equal(f.el('button-grid').style.width,'900px','T97: a wide window\'s frame has no padding');assert.equal(f.el('button-grid').style.height,'600px');assert.equal(inner.style.width,'880px');
  const rectangles=treeAll(inner,n=>n.dataset.buttonId).map(n=>({x:Number(n.style['--kx']),w:Number(n.style['--kw'])}));assert.ok(rectangles.every(r=>r.x+r.w<=880+.001));
});
test('T65 same-task scroll then select does not jump before the scroll event, and rebuild captures the actual position',async t=>{
  const f=await world(t),{el}=f;el('edit-layout').emit('click');await f.drain();
  surface(f).parentElement.scrollTop=230;f.button('a').emit('click');await f.drain();assert.equal(surface(f).parentElement.scrollTop,230,'select does not restore stale map data');
  el('button-name').value='New name';el('button-name').emit('input');await f.drain();assert.equal(surface(f).parentElement.scrollTop,230,'a rebuild captures actual DOM scroll before replacement');
});
// T83 (ADR-078): the toolbar floats over the preview and reserves nothing; what the canvas still clears is the open Library, measured from the DOM.
test('T65 Edit keeps the whole canvas under the floating toolbar and clears only the measured Library at 375 and 320 widths',async t=>{
  for(const width of [375,320])await t.test(String(width),async t=>{
    const f=await world(t,config(),'braun',{width,height:812}),{el}=f,row=el('edit-float-row');
    const bottom=()=>parseFloat(el('grid-frame').style.top)+parseFloat(el('grid-frame').style.height),use=bottom();
    row.rect={left:8,top:762,width:width-16,height:50};el('edit-layout').emit('click');await f.drain();assert.equal(bottom(),use,'the toolbar takes no room from the canvas');
    f.button('a').emit('click');await f.drain();row.rect.top=610;el('order-last').emit('click');await f.drain();assert.equal(bottom(),use,'nor does anything else of the tool row');
    el('shelf-panel').rect={left:0,top:300,width,height:512};el('shelf-toggle').emit('click');await f.drain();assert.ok(bottom()<=300-8-28+1,'the open Library is cleared, with room for its resize handle (T86)');assert.ok(bottom()>=300-8-28-1);
    el('shelf-toggle').emit('click');await f.drain();assert.equal(bottom(),use,'closing it gives the room back');assert.equal(f.count('configuration/save'),0);
  });
});
test('T65 insertion marker stays inside the right edge and the lifted clone keeps its actual inherited cell',async t=>{
  const f=await world(t);responsiveBoxes(f);
  const inner=surface(f),width=parseFloat(inner.style.width),right=treeAll(inner,n=>n.dataset.buttonId).find(n=>Math.abs(n.rect.left-inner.rect.left+n.rect.width-(width-14))<.01) /* T97: measured from the page surface (the Pages box itself starts 1u in) */,source=f.button('a');
  assert.ok(right,'the row reaches the content edge inside its safe inset');
  source.cloneNode=()=>{const node=document.createElement('button');node.className=source.className;Object.assign(node.style,source.style);return node;};
  window.getComputedStyle=node=>({getPropertyValue:name=>{if(name==='--gap')return '0px';let at=node;while(at){if(at.style[name])return at.style[name];at=at.parentElement;}return '';}});
  const held=await drag(f,'a',{x:right.rect.left+right.rect.width-1,y:right.rect.top+20});
  const ghost=treeFind(inner,n=>n.className==='drop-ghost'),copy=treeFind(document.body,n=>n.className==='button-grid lift-layer');
  assert.ok(parseFloat(ghost.style.left)+parseFloat(ghost.style.width)<=width);assert.equal(copy.style['--cell'],inner.style['--cell']);
  delete window.getComputedStyle;f.documentEvents.get('keydown')({key:'Escape',preventDefault(){}});await held.drop();assert.equal(f.count('configuration/save'),0);
});
test('T65 disconnect and a second pointer cancel a lift without writing order',async t=>{
  const f=await world(t),box=f.button('b').rect;
  let held=await drag(f,'a',{x:box.left+box.width-2,y:box.top+20});f.documentEvents.get('touchstart')({touches:[{},{}]});await held.drop();assert.equal(f.count('configuration/save'),0);
  held=await drag(f,'a',{x:box.left+box.width-2,y:box.top+20});f.sockets[0].close();await held.drop();assert.equal(f.count('configuration/save'),0);assert.deepEqual(order(f).slice(0,2),['a','b']);
});
