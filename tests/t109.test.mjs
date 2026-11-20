import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import childProcess from 'node:child_process';
import * as C from '../dist/packages/contracts/index.js';
import {ConfigStore} from '../dist/apps/host/store.js';
import {WorkflowEngine} from '../dist/apps/host/workflow.js';
import {createWindowPicker} from '../dist/apps/web/window-picker.js';
import {client,deferred} from './helpers/client-harness.mjs';
import {installDom} from './helpers/widget-dom.mjs';

// T109: regressions for T108's six findings. No valid native action or installed login service is operated.
const apps=[{id:'test.app',name:'Fixture app'}],clone=value=>JSON.parse(JSON.stringify(value));
const fault=code=>error=>error.code===code;
function document(){
  const doc=C.initialConfig();doc.library.revision=4;doc.layouts[0].revision=7;
  doc.library.keys=['a','b'].map(id=>({id,kind:'key',label:id.toUpperCase(),icon:'app',action:{type:'app.open',appId:'test.app'}}));
  doc.layouts[0].widgets[0].pages[0].widgets=['a','b'].map(id=>({id,kind:'key',size:'S'}));
  return C.parseConfigDocument(doc);
}
function storeIn(t,doc=document()){
  const dir=mkdtempSync(join(tmpdir(),'keyln-t109-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(join(dir,'config.json'),JSON.stringify(doc,null,2)+'\n',{mode:0o600});return new ConfigStore(dir);
}
const order=config=>C.allComponents(config).map(key=>key.id);
const save=(store,base,draft)=>store.save({libraryRevision:base.revision,layoutName:base.layoutName,layoutRevision:base.layoutRevision,...C.splitView(base,draft)},apps);

test('T109 R1 a concurrent layout change during theme save keeps the draft baseline and remote order',async t=>{
  const f=await client(t,{configuration:C.viewFor(document(),'Surface'),deviceTheme:'braun'});await f.drain();
  f.el('edit-layout').emit('click');f.el('grid-size').value='compact';f.el('grid-size').emit('change');await f.drain();
  f.heldTheme=deferred();f.el('theme-picker').children.find(node=>node.dataset.themeChoice==='classic').emit('click');
  await f.until(()=>f.count('device-theme/save')===1);
  const moved=clone(f.state.config);moved.widgets[0].pages[0].widgets.reverse();moved.layoutRevision=8;
  f.state={...f.state,config:moved};f.sockets[0].state();f.heldTheme.resolve();
  await f.until(()=>f.el('reload-layout').hidden===false);await f.drain();
  assert.equal(f.el('grid-size').value,'compact','the local draft is kept');
  assert.deepEqual(order(f.state.config),['b','a']);assert.equal(f.state.config.layoutRevision,9);
  f.el('desk-save').emit('click');await f.drain();await f.drain();
  assert.deepEqual(order(f.state.config),['b','a'],'a stale save never overwrites the remote order');
  const request=f.calls.findLast(call=>call.path==='/api/configuration/save')?.request;
  if(request)assert.equal(request.layoutRevision,7,'the original baseline was not advanced');
  assert.equal(f.count('execute'),0);
  // Real store checks the same stale draft independently from the controlled transport.
  const store=storeIn(t),base=store.get(),remote=clone(base),draft=clone(base);
  remote.widgets[0].pages[0].widgets.reverse();save(store,base,remote);store.setTheme('Surface','classic');draft.gridSize='compact';
  assert.throws(()=>save(store,base,draft),fault('CONFIG_CONFLICT'));assert.deepEqual(order(store.get()),['b','a']);
});

test('T109 R1 reading the own theme revision before its HTTP reply does not falsely stale a draft',async t=>{
  const f=await client(t,{configuration:C.viewFor(document(),'Surface'),deviceTheme:'braun'});await f.drain();
  f.el('edit-layout').emit('click');f.el('grid-size').value='compact';f.el('grid-size').emit('change');
  const transport=globalThis.fetch,reply=deferred();
  globalThis.fetch=async(path,options)=>{const result=await transport(path,options);if(path==='/api/device-theme/save')await reply.promise;return result;};
  try{
    f.el('theme-picker').children.find(node=>node.dataset.themeChoice==='classic').emit('click');await f.until(()=>f.deviceTheme==='classic');
    f.intervals[0]();await f.until(()=>f.el('reload-layout').hidden===false);
    reply.resolve();await f.until(()=>f.el('reload-layout').hidden===true);
    assert.equal(f.el('grid-size').value,'compact');f.el('desk-save').emit('click');await f.until(()=>f.el('save-message').textContent==='Saved on your Mac.');
    assert.equal(f.calls.findLast(call=>call.path==='/api/configuration/save').request.layoutRevision,8);
  }finally{reply.resolve();globalThis.fetch=transport;}
});

test('T109 R1 a late theme response cannot update a replacement connection',async t=>{
  const f=await client(t,{deviceTheme:'braun'});await f.drain();f.heldTheme=deferred();
  f.el('theme-picker').children.find(node=>node.dataset.themeChoice==='classic').emit('click');await f.until(()=>f.count('device-theme/save')===1);
  f.sockets[0].close();f.heldTheme.resolve();await f.drain();await f.drain();
  assert.equal(f.el('html').dataset.theme,'braun');assert.equal(f.count('execute'),0);
});

test('T109 R2 reviewed whole-document imports reject changes in any layout, including themes',t=>{
  const doc=document();doc.layouts.push({...clone(doc.layouts[0]),name:'Phone',revision:2});
  const store=storeIn(t,doc),reviewed=store.document(),stamp=store.documentStamp();
  store.setTheme('Phone','metro');const current=store.document(),bytes=readFileSync(store.path);
  assert.equal(store.revision,reviewed.library.revision);assert.throws(()=>store.importDocument(reviewed,stamp,apps),fault('CONFIG_CONFLICT'));
  assert.throws(()=>store.importDocument(reviewed,undefined,apps),fault('CONFIG_CONFLICT'));
  assert.throws(()=>store.replace(store.get(),apps,undefined,true),fault('CONFIG_CONFLICT'));
  assert.deepEqual(store.document(),current);assert.deepEqual(readFileSync(store.path),bytes);
  const moved=clone(store.get());moved.widgets[0].pages[0].widgets.reverse();const base=store.get(),secondStamp=store.documentStamp();save(store,base,moved);
  assert.throws(()=>store.importDocument(reviewed,secondStamp,apps),fault('CONFIG_CONFLICT'));
  const next=store.importDocument(reviewed,store.documentStamp(),apps);assert.equal(next.library.revision,5);
});

test('T109 R2 the client carries the reviewed stamp through draft edits and replacement confirmation',async t=>{
  const f=await client(t),file=f.document(),stamp=f.stamp(),bytes=Buffer.from(JSON.stringify(file));
  f.el('layout-files-open').emit('click');f.el('layout-import-file').files=[{size:bytes.length,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}];
  f.el('layout-import-file').emit('change');await f.until(()=>!f.el('layout-import-preview').hidden);
  f.el('layout-import-load').emit('click');await f.drain();f.el('desk-save').emit('click');await f.drain();f.el('confirm-yes').emit('click');
  await f.until(()=>f.el('save-message').textContent==='Saved on your Mac.');
  const request=f.calls.find(call=>call.path==='/api/configuration/import').request;
  assert.equal(request.stamp,stamp);assert.equal(request.config.version,3);assert.equal(f.count('execute'),0);
});

function atBudget(doc,budget){
  const bytes=()=>Buffer.byteLength(JSON.stringify(doc,null,2)+'\n');
  while(bytes()<=budget){const id=`padding-${doc.library.keys.length}`;doc.library.keys.push({id,kind:'key',label:'Padding',icon:'app',action:{type:'app.open',appId:'a'.repeat(255)}});}
  let excess=bytes()-budget;
  for(const key of [...doc.library.keys].reverse()){
    if(key.action?.type!=='app.open')continue;
    const shrink=Math.min(excess,key.action.appId.length-1);key.action.appId=key.action.appId.slice(shrink);excess-=shrink;if(!excess)break;
  }
  assert.equal(excess,0);assert.equal(bytes(),budget);return C.parseConfigDocument(doc);
}
test('T109 R3 an oversized theme save keeps both files, memory and restart availability',t=>{
  const store=storeIn(t,atBudget(document(),C.MAX_CONFIG_BYTES-1)),before=store.document(),bytes=readFileSync(store.path);
  writeFileSync(store.backup,JSON.stringify(C.initialConfig()));const backup=readFileSync(store.backup);
  assert.throws(()=>store.setTheme('Surface','midnight'),fault('TOO_LARGE'));
  assert.deepEqual(readFileSync(store.path),bytes);assert.deepEqual(readFileSync(store.backup),backup);assert.deepEqual(store.document(),before);
  assert.equal(new ConfigStore(dirname(store.path),true).available,true);
});
test('T109 R3 the final size check includes revision digit growth in ordinary saves',t=>{
  const doc=document();doc.layouts[0].revision=9;const store=storeIn(t,atBudget(doc,C.MAX_CONFIG_BYTES)),base=store.get(),draft=clone(base),bytes=readFileSync(store.path);
  draft.widgets[0].pages[0].widgets.reverse();assert.throws(()=>save(store,base,draft),fault('TOO_LARGE'));
  assert.deepEqual(readFileSync(store.path),bytes);assert.equal(store.layoutRevision(),9);assert.deepEqual(order(store.get()),['a','b']);
});
test('T109 R3 an oversized restored revision is rejected before revoking devices or archiving files',t=>{
  const store=storeIn(t),doc=document();doc.library.revision=9;doc.layouts[0].revision=9;
  writeFileSync(store.backup,JSON.stringify(atBudget(doc,C.MAX_CONFIG_BYTES-1),null,2)+'\n');
  const reviewed=store.backupState(),before=readFileSync(store.path);let revoked=0;
  assert.equal(reviewed.available,true);assert.throws(()=>store.restoreBackup({stamp:reviewed.stamp,confirm:true},()=>revoked++),fault('TOO_LARGE'));
  assert.equal(revoked,0);assert.deepEqual(readFileSync(store.path),before);assert.equal(store.revision,4);
});

test('T109 R4 a Finder workflow carries the folder to the final shortcut check and preserves pathless commands',async t=>{
  const captured=[],original=childProcess.execFile;
  childProcess.execFile=(file,args,options,callback)=>{captured.push([...args]);queueMicrotask(()=>callback(null,JSON.stringify({ok:true,message:'Transport stub only.'})));return {};};
  syncBuiltinESMExports();t.after(()=>{childProcess.execFile=original;syncBuiltinESMExports();});
  const {nativeAdapter}=await import('../dist/apps/host/native.js');
  const engine=new WorkflowEngine((action,signal,target)=>target?nativeAdapter.runTargeted(action,target,signal):nativeAdapter.run(action,signal));
  const config=C.initialView(),window={type:'window.activate',appId:C.FINDER_APP_ID,title:'Reports',match:'exact',path:'/tmp/TeamA/Reports'};
  config.workflows=[{id:'flow',name:'Fixture',timeoutMs:3000,steps:[{id:'focus',action:window,timeoutMs:1000},{id:'key',action:{type:'keyboard.shortcut',key:'KeyK',modifiers:['command']},timeoutMs:1000}]}];
  assert.equal((await engine.run('flow',config,new AbortController().signal)).ok,true);
  assert.deepEqual(captured[1],['shortcut-window',C.FINDER_APP_ID,'exact','Reports',window.path,'KeyK','command']);
  await nativeAdapter.runTargeted({type:'keyboard.shortcut',key:'KeyA',modifiers:[]},{type:'window.activate',appId:'test.app',title:'A',match:'exact'},new AbortController().signal);
  assert.deepEqual(captured[2],['shortcut-window','test.app','exact','A','KeyA','']);
});

test('T109 R6 window choices distinguish Finder paths, merge one folder and preserve title ambiguity elsewhere',()=>{
  const rows=[{title:'Reports',path:'/tmp/A/Reports',minimized:false},{title:'Reports',path:'/tmp/B/Reports',minimized:false},{title:'Reports',path:'/tmp/A/Reports',minimized:true}];
  const finder=C.windowChoices(C.FINDER_APP_ID,rows);assert.equal(finder.length,2);assert.ok(finder.every(item=>!item.ambiguous));assert.notEqual(finder[0].id,finder[1].id);
  assert.ok(C.windowChoices('test.app',rows).every(item=>item.ambiguous));
  assert.ok(C.windowChoices(C.FINDER_APP_ID,rows.map(({path,...row})=>row)).every(item=>item.ambiguous));
});
test('T109 R6 the Library adds both same-title folders and tracks Added by path across Retry',async t=>{
  const f=await client(t,{apps:[{id:C.FINDER_APP_ID,name:'Finder'}]});f.el('edit-layout').emit('click');f.el('shelf-toggle').emit('click');await f.drain();
  const card=f.el('shelf-previews').children.find(node=>node.dataset.appId===C.FINDER_APP_ID);f.heldWindows=deferred();
  card.emit('contextmenu',{clientX:10,clientY:10});f.el('shelf-app-window-action').emit('click');
  const rows=[{title:'Reports',path:'/tmp/A/Reports',minimized:false},{title:'Reports',path:'/tmp/B/Reports',minimized:false}];
  f.heldWindows.resolve({windows:[...rows,rows[0]]});await f.drain();await f.drain();
  let cards=f.el('shelf-window-list').children;assert.equal(cards.length,2);assert.ok(cards.every(node=>!node.disabled));assert.match(cards[0].title,/\/tmp\/A\/Reports/);
  cards[0].emit('click');await f.drain();assert.equal(cards[0].disabled,true);assert.equal(cards[1].disabled,false);
  f.heldWindows=deferred();f.el('shelf-window-retry').emit('click');f.heldWindows.resolve({windows:[rows[1],rows[0]]});await f.drain();await f.drain();
  cards=f.el('shelf-window-list').children;assert.equal(cards[0].disabled,false);assert.equal(cards[1].dataset.added,'true');
  cards[0].emit('click');f.el('shelf-window-close').emit('click');f.el('desk-save').emit('click');await f.until(()=>f.el('save-message').textContent==='Saved on your Mac.');
  assert.deepEqual(C.allComponents(f.state.config).filter(key=>key.action?.type==='window.activate').map(key=>key.action.path).sort(),rows.map(row=>row.path).sort());assert.equal(f.count('execute'),0);
});
test('T109 R6 the settings picker exposes paths and fills the correct folder',async t=>{
  const {el,document}=installDom(t),rows=[{title:'Reports',path:'/tmp/A/Reports',minimized:false},{title:'Reports',path:'/tmp/B/Reports',minimized:false}];
  const picker=createWindowPicker(document.getElementById('host'),'folder',{appId:()=>C.FINDER_APP_ID,load:async()=>rows,changed:()=>{}});
  el('folder-read').emit('click');await new Promise(resolve=>setImmediate(resolve));
  const select=el('folder-choices');assert.ok(select.children.slice(1).every(option=>!option.disabled));
  select.value='1';select.emit('change');assert.equal(picker.path,rows[1].path);assert.equal(picker.title,'Reports');
});
