import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import * as C from '../dist/packages/contracts/index.js';
import {client,deferred} from './helpers/client-harness.mjs';
import {key,layout,viewOf,withLayoutRevision} from './helpers/layout.mjs';
import {createLibrary,revealLibraryTab} from '../dist/apps/web/library.js';
import {planItemImport} from '../dist/apps/web/component-files.js';
const type=(f,id)=>f.el('shelf-types').children.find(node=>node.dataset.libraryType===id).emit('click');
const cards=f=>f.el('shelf-previews').children.filter(node=>node.className?.includes('shelf-card'));
const windowCards=f=>f.el('shelf-window-list').children;
const chooseWindows=f=>{cards(f)[0].emit('contextmenu',{clientX:10,clientY:10});f.el('shelf-app-window-action').emit('click');};
const tab=(f,index)=>f.el('shelf-previews').children[0].children[index].emit('click');
const open=async t=>{const f=await client(t);f.el('edit-layout').emit('click');f.el('shelf-toggle').emit('click');await f.drain();return f;};
const save=async f=>{f.el('desk-save').emit('click');await f.drain();await f.drain();return f.calls.findLast(c=>c.path==='/api/configuration/save')?.data;};
test('T70 retained Library categories, named action tabs, legal null presets, Undo and save remain draft-only',async t=>{
 const f=await open(t);assert.deepEqual(f.el('shelf-types').children.map(n=>n.children[0].textContent),['App','Other Key','Pages','Widget']);
 assert.ok(f.el('shelf-import'));type(f,'other');assert.deepEqual(f.el('shelf-previews').children[0].children.map(n=>n.textContent),['Shortcut','Shell script','Mac shortcut','Workflow']);
 for(let i=0;i<4;i++){tab(f,i);cards(f)[0].emit('click');await f.drain();assert.equal(f.el('action-type').value,['keyboard.shortcut','shell.run','shortcuts.run','workflow.run'][i]);assert.equal(f.count('execute'),0);const draft=await save(f);assert.equal(C.allComponents(draft).at(-1).action,null);}
 type(f,'pages');assert.equal(cards(f)[0].children.at(-1).textContent,'Key pages');
 type(f,'widget');assert.deepEqual(f.el('shelf-previews').children[0].children.map(n=>n.textContent),['Clock','Text','Refresh','Codex','Claude Code']);
 cards(f)[0].emit('click');await f.drain();f.el('edit-undo').emit('click');await f.drain();assert.equal(f.el('save-message').dataset.dirty,'false');
});
test('T70 application target generates one complete app.open key and preserves revision/409 draft',async t=>{
 const f=await open(t);cards(f)[0].emit('click');await f.drain();assert.equal(f.count('execute'),0);assert.equal(f.count('configuration/save'),0);
 f.saveFault={code:'CONFIG_CONFLICT',status:409,message:'Changed'};const candidate=await save(f);const app=C.allComponents(candidate).at(-1);assert.deepEqual(app.action,{type:'app.open',appId:'test.app'});assert.equal(app.size,'S');assert.equal(app.appearance.glyph.type,'app');assert.equal(candidate.revision,4);assert.equal(f.el('desk-save').disabled,true);assert.equal(f.el('save-message').dataset.dirty,'true');
});
test('T70 window guarantees survive the merged App context entry: on-demand exact binding, duplicate rejection and stale replies',async t=>{
 const f=await open(t);assert.equal(f.count('windows'),0);f.heldWindows=deferred();chooseWindows(f);assert.equal(f.count('windows'),1);type(f,'other');f.heldWindows.resolve({windows:[{title:'Old',minimized:false}]});await f.drain();assert.equal(f.el('shelf-windows').open,false);
 type(f,'app');f.heldWindows=deferred();chooseWindows(f);f.heldWindows.resolve({windows:[{title:'Duplicate',minimized:false},{title:'Duplicate',minimized:true},{title:'Unique',minimized:false}]});await f.drain();await f.drain();assert.equal(windowCards(f).filter(n=>n.disabled).length,2);windowCards(f)[2].emit('click');await f.drain();const draft=await save(f);assert.deepEqual(C.allComponents(draft).at(-1).action,{type:'window.activate',appId:'test.app',title:'Unique',match:'exact'});assert.equal(f.count('execute'),0);
});
test('T70 removed models and group item triggers are strictly rejected; retained v1/v2 metadata and workflow item import survive',()=>{
 const config=layout([key('primary',{type:'app.open',appId:'test.app'})],{revision:24,gridSize:'large'});
 assert.deepEqual(viewOf(config),withLayoutRevision(config));
 for(const kind of ['app-group','action-group','media','latest-result','recent-activity']){const bad=structuredClone(config);bad.widgets[0].pages[0].widgets[0].kind=kind;assert.throws(()=>C.parseConfig(bad));assert.throws(()=>C.parseItemFile({format:'keyln.item',version:2,component:{kind,size:'S',label:'Old',icon:'app',action:null}}));assert.throws(()=>C.sizingFor(kind));}
 const id='12345678-1234-4234-8234-123456789abc';assert.throws(()=>C.parseTrigger({requestId:id,componentId:'primary',revision:24,itemId:'old'}));
 const flow={id:'flow',name:'Flow',timeoutMs:2000,steps:[{id:'step',timeoutMs:1000,action:{type:'app.open',appId:'test.app'}}]};config.workflows=[flow];C.allComponents(config)[0].action={type:'workflow.run',workflowId:'flow'};
 const file=C.parseItemFile(C.exportItemFile(config,'primary')),planned=planItemImport(config,{},file);assert.equal(planned.config.workflows.length,2);assert.notEqual(planned.button.action.workflowId,'flow');C.parseConfig(planned.config);
 for(const module of ['groups','group-editor','group-popover','widgets/result']){assert.equal(existsSync(new URL(`../apps/web/${module}.ts`,import.meta.url)),false);assert.equal(existsSync(new URL(`../dist/apps/web/${module}.js`,import.meta.url)),false);assert.ok(!readFileSync(new URL('../apps/host/server.ts',import.meta.url),'utf8').includes(`/apps/web/${module}.js`));}
});
test('T70 window close/offline replies remain inert and error/empty Retry stays explicit',async t=>{
 const f=await open(t);f.heldWindows=deferred();chooseWindows(f);f.el('shelf-window-close').emit('click');f.heldWindows.resolve({windows:[{title:'Late',minimized:false}]});await f.drain();assert.equal(f.el('shelf-windows').open,false);assert.equal(f.count('execute'),0);
 f.heldWindows=deferred();chooseWindows(f);f.heldWindows.resolve({windows:null});await f.drain();await f.drain();assert.match(f.el('shelf-window-note').textContent,/Invalid Mac window list/);
 f.heldWindows=deferred();f.el('shelf-window-retry').emit('click');f.heldWindows.resolve({windows:[]});await f.drain();await f.drain();assert.match(f.el('shelf-window-note').textContent,/No windows found/);
 f.heldWindows=deferred();f.el('shelf-window-retry').emit('click');f.sockets[0].close(1006);f.heldWindows.resolve({windows:[{title:'Offline',minimized:false}]});await f.drain();assert.equal(f.el('shelf-windows').open,false);assert.equal(cards(f).length,0);
});
test('T70 a repeated key clears the previous feedback timer and script output before the next send',async t=>{
 const f=await client(t),{el}=f;f.button().emit('click');const completed=f.execution('succeeded',{actionType:'shell.run',output:{exitCode:0,signal:null,stdout:'Previous output',stderr:'',truncated:false}});f.sockets[0].push({type:'execution',execution:completed});f.execute.resolve({execution:completed});await f.until(()=>!f.button().disabled);
 assert.match(el('execution-output').textContent,/Previous output/);assert.ok([...f.timers.values()].some(timer=>timer.delay===2000));f.execute=deferred();f.button().emit('click');assert.equal(f.count('execute'),2);assert.ok(![...f.timers.values()].some(timer=>timer.delay===2000));assert.equal(el('execution-output').textContent,'');assert.equal(el('execution-output').hidden,true);
});
test('T70 incomplete edits of a configured shell binding block Save instead of clearing the action',async t=>{
 const version='a'.repeat(64),configuration=layout([key('primary',{type:'shell.run',scriptId:'script',version,args:[]})],{revision:4});
 const f=await client(t,{configuration,scripts:[{id:'script',name:'Owned script',version,parameters:[]}]}),{el}=f;
 el('edit-layout').emit('click');f.button().emit('click');el('script-select').value='';el('script-select').emit('change');el('desk-save').emit('click');await f.drain();assert.equal(f.count('configuration/save'),0);assert.equal(el('save-message').dataset.dirty,'true');assert.equal(el('script-select').getAttribute('aria-invalid'),'true');assert.match(el('field-error').textContent,/Choose an action/);
 el('clear-action').emit('click');el('desk-save').emit('click');await f.drain();await f.drain();assert.equal(f.count('configuration/save'),1);assert.equal(C.allComponents(f.calls.find(c=>c.path==='/api/configuration/save').data)[0].action,null,'explicit Clear action still clears the binding');
});

test('T70 unchanged Library paints retain pressed card DOM; catalog, editable and online changes invalidate immediately',async t=>{
 const f=await client(t);let online=true,editable=true,catalog=[{id:'test.app',name:'Fake app'}],placed=0;
 const shelf=createLibrary({apps:()=>catalog,online:()=>online,editable:()=>editable,windows:async()=>[],place:()=>{placed++;},drag:()=>false,inspectFile:async()=>{throw Error('unused');},placeFile:()=>undefined,changed:()=>{}});
 shelf.toggle(true);const original=cards(f)[0],navigation=f.el('shelf-types').children[0];
 original.emit('pointerdown',{isPrimary:true,button:0,pointerId:1,clientX:10,clientY:10,pointerType:'mouse'});
 shelf.render();shelf.render();assert.equal(cards(f)[0],original);assert.equal(f.el('shelf-types').children[0],navigation);
 original.emit('pointerup',{pointerId:1});original.emit('click');assert.equal(placed,1);
 online=false;shelf.render();assert.equal(cards(f).length,0);assert.ok(f.el('shelf-previews').children[0].textContent.includes('Reconnect'));original.emit('click');assert.equal(placed,1,'old cards remain blocked immediately offline');
 const offline=f.el('shelf-previews').children[0],offlineNav=f.el('shelf-types').children[0];shelf.render();shelf.render();assert.equal(f.el('shelf-previews').children[0],offline);assert.equal(f.el('shelf-types').children[0],offlineNav,'repeated offline paints preserve navigation too');
 online=true;shelf.render();const recovered=cards(f)[0];assert.notEqual(recovered,original);shelf.render();assert.equal(cards(f)[0],recovered);
 catalog=[{id:'test.app',name:'Renamed app'}];shelf.render();assert.notEqual(cards(f)[0],recovered);assert.ok(cards(f)[0].children.at(-1).textContent.includes('Renamed app'));
 const beforeLock=cards(f)[0];editable=false;shelf.render();assert.notEqual(cards(f)[0],beforeLock);beforeLock.emit('click');assert.equal(placed,1);
});

test('T70 offline cache retains nodes while the merged window dialog invalidates its pending reply',async t=>{
 const f=await client(t),reply=deferred();let online=true,placed=0;const shelf=createLibrary({apps:()=>[{id:'test.app',name:'Fake app'}],online:()=>online,editable:()=>true,windows:()=>reply.promise,place:()=>{placed++;},drag:()=>false,inspectFile:async()=>{throw Error('unused');},placeFile:()=>undefined,changed:()=>{}});shelf.toggle(true);chooseWindows(f);online=false;shelf.render();const offline=f.el('shelf-previews').children[0];shelf.render();assert.equal(f.el('shelf-previews').children[0],offline);reply.resolve([{title:'Stale',minimized:false}]);await f.drain();shelf.render();assert.equal(f.el('shelf-previews').children[0],offline);assert.equal(f.el('shelf-windows').open,false);assert.equal(placed,0);
});

test('T70 tabs occupy their own row, narrow tabs scroll horizontally, and window controls form a toolbar',async t=>{
 const f=await open(t);type(f,'other');const tabs=f.el('shelf-previews').children[0];assert.equal(tabs.className,'shelf-tabs');assert.equal(tabs.getAttribute('role'),'tablist');assert.ok(cards(f).length>0);tabs.children[0].emit('keydown',{key:'End'});assert.equal(f.el('shelf-previews').children[0].children[3].getAttribute('aria-selected'),'true');assert.equal(document.activeElement,f.el('shelf-previews').children[0].children[3]);
 const css=readFileSync(new URL('../apps/web/style.css',import.meta.url),'utf8'),html=readFileSync(new URL('../apps/web/index.html',import.meta.url),'utf8');
 assert.match(css,/\.shelf-tabs\{flex:0 0 100%;width:100%;min-width:0;/);assert.match(css,/\.shelf-window-tools\{flex:0 0 100%;width:100%;min-width:0;/);assert.match(css,/\.shelf-tabs,\.shelf-window-tools\{flex-wrap:nowrap;overflow-x:auto;/);assert.match(css,/\.shelf-tabs button\{flex:0 0 auto;white-space:nowrap\}/);assert.ok(html.includes('A key saved earlier'));assert.ok(!html.includes('A key or group saved earlier'));
});

test('T70 active-tab focus precedes local horizontal reveal and Home restores the leading tab without page scrolling',()=>{
 const calls=[],tabs={scrollLeft:0,getBoundingClientRect(){calls.push('frame');return {left:12,right:308};}};
 const workflow={focus(options){calls.push('focus');assert.deepEqual(options,{preventScroll:true});},getBoundingClientRect(){calls.push('tab');return {left:307.85-tabs.scrollLeft,right:390.37-tabs.scrollLeft};}};
 revealLibraryTab(tabs,workflow,true);assert.deepEqual(calls,['focus','frame','tab']);assert.ok(Math.abs(tabs.scrollLeft-82.37)<1e-6);assert.ok(workflow.getBoundingClientRect().right<=308);
 const home={focus:workflow.focus,getBoundingClientRect(){return {left:12-tabs.scrollLeft,right:92-tabs.scrollLeft};}};
 revealLibraryTab(tabs,home,true);assert.equal(tabs.scrollLeft,0);
});
