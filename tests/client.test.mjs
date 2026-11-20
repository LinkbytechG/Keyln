import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {importPreview} from '../dist/apps/host/layout.js';
import {targetKeyName} from '../dist/apps/web/editor.js';
import {readFileSync,readdirSync} from 'node:fs';
import {setKeyIcon} from '../dist/apps/web/presentation.js';
import {rankApplications} from '../dist/apps/web/app-picker.js';
import {withCustomThemes,allComponents} from '../dist/packages/contracts/index.js';
import {fromGrid} from './helpers/layout.mjs';
import {client,deferred} from './helpers/client-harness.mjs';

test('client keeps disconnected results unknown, never resends, and ignores pre-revocation state responses',async t=>{
  const f=await client(t),{el}=f;await f.until(()=>!f.button().disabled);
  f.button().emit('click');assert.equal(f.count('execute'),1);const accepted=f.execution('accepted');
  f.sockets.at(-1).close(1006);assert.equal(el('execution-diagnostics').dataset.status,'unknown');assert.equal(f.button().disabled,true);
  f.execute.resolve({execution:accepted});await f.until(()=>![...f.timers.values()].some(timer=>timer.delay===4000));
  assert.equal(el('execution-diagnostics').dataset.status,'unknown');assert.equal(f.count('result'),0);
  el('connection-button').emit('click');await f.until(()=>el('execution-diagnostics').dataset.status==='succeeded'&&f.sockets.length===2);
  assert.equal(f.count('execute'),1);assert.equal(f.count('result'),1);assert.equal(el('connection').textContent,'Mac connected');
  f.heldState=deferred();f.intervals[0]();f.sockets.at(-1).close(4001);assert.equal(el('pair-panel').hidden,false);
  f.heldState.resolve(f.state);await f.until(()=>!el('connection-button').disabled);
  assert.equal(el('connection').textContent,'Pairing required');assert.equal(el('pair-panel').hidden,false);assert.equal(el('desk').hidden,true);
  assert.match(el('pair-message').textContent,/expired or was revoked/);assert.equal(f.sockets.length,2);assert.equal(f.count('execute'),1);
});
test('client waits for event readiness, renders progress without polling, and a late HTTP acknowledgment cannot replace completion',async t=>{
  const f=await client(t,{autoState:false}),{el}=f,socket=f.sockets[0];
  assert.equal(f.button().disabled,true);socket.state();assert.equal(f.button().disabled,false);
  f.button().emit('click');const accepted=f.execution('accepted');
  socket.state({busy:true});socket.push({type:'execution',execution:accepted});assert.equal(el('execution-diagnostics').dataset.status,'accepted');
  socket.push({type:'execution',execution:f.execution('running')});assert.equal(el('execution-diagnostics').dataset.status,'running');
  socket.push({type:'execution',execution:f.execution('failed',{requestId:randomUUID()})});assert.equal(el('execution-diagnostics').dataset.status,'running');
  socket.state({busy:false});socket.push({type:'execution',execution:f.execution('succeeded')});assert.equal(el('execution-diagnostics').dataset.status,'succeeded');
  f.execute.resolve({execution:accepted});await f.until(()=>!f.button().disabled);
  assert.equal(el('execution-diagnostics').dataset.status,'succeeded');assert.equal(f.count('execute'),1);assert.equal(f.count('result'),0);
  assert.ok(![...f.timers.values()].some(timer=>timer.delay===400));
  socket.state({busy:true});assert.equal(f.button().disabled,true);socket.state({busy:false});assert.equal(f.button().disabled,false);
  f.heldState=deferred();f.intervals[0]();socket.state({busy:true});f.heldState.resolve(f.state);await f.until(()=>!el('connection-button').disabled);
  assert.equal(f.button().disabled,true,'Late idle HTTP state must not overwrite newer busy event');
});
test('recovery query cannot regress newer pushed results, and malformed stream events disable execution',async t=>{
  const id=randomUUID(),f=await client(t,{initialPending:id,autoState:false}),{el}=f,socket=f.sockets[0];
  f.heldResult=deferred();socket.state({busy:true});await f.until(()=>f.count('result')===1);
  socket.push({type:'execution',execution:f.execution('running')});socket.state({busy:false});
  socket.push({type:'execution',execution:f.execution('succeeded',{actionType:'keyboard.shortcut'})});
  // T33 fix: the readout is titled with the key's name; the line under it carries the state.
  assert.match(el('execution-message').textContent,/^Test app ·/);assert.match(el('execution-message').textContent,/Shortcut sent/);
  f.heldResult.resolve({execution:f.execution('running')});await f.drain();
  assert.equal(el('execution-diagnostics').dataset.status,'succeeded');assert.equal(f.count('execute'),0);assert.equal(f.count('result'),1);
  socket.push({type:'execution',execution:f.execution('accepted'),token:'not-allowed'});
  assert.equal(socket.readyState,3);assert.equal(f.button().disabled,true);
});
// T116 (ADR-100): an app or window key whose result is lost no longer locks the page; the lock is kept for actions that are not safe to repeat, such as a shortcut.
const shortcutKey=fromGrid({revision:4,profiles:[{id:'main',name:'My buttons'}],buttons:[{id:'primary',profileId:'main',position:0,label:'Test app',icon:'app',action:{type:'keyboard.shortcut',key:'KeyK',modifiers:['command']}}]});
test('Host restart leaves lost results unknown, ignores the old socket, and requires deliberate acknowledgment',async t=>{
  const f=await client(t,{configuration:shortcutKey}),{el}=f;f.button().emit('click');const old=f.sockets[0],accepted=f.execution('accepted');
  old.close(1006);f.execute.resolve({execution:accepted});await f.until(()=>![...f.timers.values()].some(timer=>timer.delay===4000));
  f.state={...f.state,instanceId:randomUUID()};f.resultFault=true;el('connection-button').emit('click');
  await f.until(()=>f.count('result')===1&&!el('connection-button').disabled);await f.drain();
  assert.equal(el('execution-diagnostics').dataset.status,'unknown');assert.equal(f.button().disabled,true);assert.equal(f.count('execute'),1);
  old.push({type:'execution',execution:f.execution('succeeded')});assert.equal(el('execution-diagnostics').dataset.status,'unknown');
  el('execution-acknowledge').emit('click');assert.equal(f.button().disabled,false);assert.equal(f.count('execute'),1);
});
test('manual reconnect clears a stale connection rejection when there is no pending or unknown action',async t=>{
  const f=await client(t),{el}=f;f.sockets[0].close(1006);assert.equal(el('execution-diagnostics').dataset.status,'rejected');
  el('connection-button').emit('click');await f.until(()=>f.sockets.length===2&&el('connection').textContent==='Mac connected');
  assert.equal(el('execution-diagnostics').dataset.status,'ready');assert.match(el('execution-message').textContent,/^Ready ·/);assert.equal(f.count('execute'),0);
});
test('automatic reconnect only queries a lost request; a restarted Host leaves unknown until acknowledged',async t=>{
  const f=await client(t,{configuration:shortcutKey}),{el}=f;f.button().emit('click');const old=f.sockets[0];old.close(1006);f.execute.resolve({execution:f.execution('accepted')});await f.drain();
  await f.fireTimer(1000);await f.until(()=>el('execution-diagnostics').dataset.status==='succeeded'&&f.sockets.length===2);
  assert.equal(f.count('execute'),1);assert.equal(f.count('result'),1);assert.equal(el('connection-recovery').hidden,true);
  f.execute=deferred();f.button().emit('click');f.sockets.at(-1).close(1006);f.execute.resolve({execution:f.execution('accepted')});await f.drain();
  f.state={...f.state,instanceId:randomUUID()};f.resultFault=true;await f.fireTimer(1000);await f.until(()=>f.count('result')===2&&!el('connection-button').disabled);
  assert.equal(el('connection').textContent,'Mac connected');assert.equal(el('execution-diagnostics').dataset.status,'unknown');assert.equal(f.button().disabled,true);assert.equal(f.count('execute'),2);
});
test('automatic reconnect waits for initial WSS state and backs off when an open socket never supplies it',async t=>{
  const f=await client(t,{autoState:false}),{el}=f;f.sockets[0].state();f.sockets[0].close(1006);await f.fireTimer(1000);
  assert.equal(f.sockets.length,2);assert.equal(f.button().disabled,true);assert.match(el('connection-recovery').textContent,/attempt 1\/6/);
  await f.fireTimer(4000);assert.equal(f.sockets[1].readyState,3);await f.fireTimer(2000);assert.equal(f.sockets.length,3);
  f.sockets[2].state();assert.equal(f.button().disabled,false);assert.equal(el('connection-recovery').hidden,true);assert.equal(f.count('execute'),0);
});
test('offline and background pause reconnection; online and foreground resync preserve an unsaved draft',async t=>{
  const f=await client(t),{el}=f;el('edit-layout').emit('click');el('button-name').value='Preserved local draft';el('button-name').emit('input');
  navigator.onLine=false;f.windowEvents.get('offline')();assert.equal(f.button().disabled,false,'Editing remains possible while execution is offline');
  const calls=f.count('configuration');assert.ok(![...f.timers.values()].some(timer=>timer.delay===1000));navigator.onLine=true;f.windowEvents.get('online')();await f.fireTimer(0);await f.until(()=>el('connection').textContent==='Mac connected');
  assert.equal(el('button-name').value,'Preserved local draft');assert.equal(f.count('configuration'),calls+1);assert.equal(f.count('configuration/save'),0);
  document.hidden=true;f.documentEvents.get('visibilitychange')();assert.equal(el('connection').textContent,'Disconnected');document.hidden=false;f.documentEvents.get('visibilitychange')();await f.fireTimer(0);await f.until(()=>el('connection').textContent==='Mac connected');
  assert.equal(el('button-name').value,'Preserved local draft');assert.equal(f.count('execute'),0);
  f.documentEvents.get('freeze')();f.documentEvents.get('resume')();await f.fireTimer(0);await f.until(()=>el('connection').textContent==='Mac connected');assert.equal(el('button-name').value,'Preserved local draft');
});
test('revocation stops automatic reconnect and network/visibility events cannot bypass pairing',async t=>{
  const f=await client(t),{el}=f;f.sockets[0].close(4001);const before=f.count('configuration');f.windowEvents.get('online')();f.documentEvents.get('visibilitychange')();await f.drain();
  assert.equal(f.count('configuration'),before);assert.equal(el('pair-panel').hidden,false);assert.equal(el('connection').textContent,'Pairing required');assert.equal(f.count('execute'),0);
});
test('a disconnected background sync releases Reconnect immediately and cannot invalidate the replacement connection',async t=>{
  const f=await client(t),{el}=f,oldRead=deferred();f.heldState=oldRead;f.intervals[0]();
  assert.equal(f.count('configuration'),2);
  f.windowEvents.get('offline')();const canReconnect=!el('connection-button').disabled;
  f.heldState=undefined;el('connection-button').emit('click');await f.drain();
  const socketCount=f.sockets.length;
  oldRead.reject(new Error('Old network request failed after Wi-Fi returned'));await f.drain();await f.drain();
  assert.equal(canReconnect,true,'Offline sync must not leave the recovery control disabled');
  assert.equal(socketCount,2,'Reconnect starts a fresh sync without waiting for the old read');
  assert.equal(el('connection').textContent,'Mac connected');assert.equal(f.button().disabled,false);assert.equal(f.count('execute'),0);
});
test('a late pre-disconnect execution request failure cannot tear down a recovered connection',async t=>{
  const f=await client(t),{el}=f;f.button().emit('click');f.sockets[0].close(1006);
  el('connection-button').emit('click');await f.until(()=>f.sockets.length===2&&el('execution-diagnostics').dataset.status==='succeeded');
  f.execute.reject(new Error('Old request timed out after reconnect'));await f.drain();await f.drain();
  assert.equal(el('connection').textContent,'Mac connected');assert.equal(f.button().disabled,false);
  assert.equal(el('execution-diagnostics').dataset.status,'succeeded');assert.equal(f.count('execute'),1);assert.equal(f.count('result'),1);
});
test('a late acknowledgment from an abandoned connection cannot replace recovered running progress with unknown',async t=>{
  const f=await client(t),{el}=f;f.button().emit('click');f.sockets[0].close(1006);
  f.heldResult=deferred();el('connection-button').emit('click');await f.until(()=>f.sockets.length===2&&f.count('result')===1);
  f.heldResult.resolve({execution:f.execution('running')});await f.until(()=>el('execution-diagnostics').dataset.status==='running');
  f.execute.resolve({execution:f.execution('accepted')});await f.drain();await f.drain();
  assert.equal(el('connection').textContent,'Mac connected');assert.equal(el('execution-diagnostics').dataset.status,'running');
  assert.equal(el('execution-acknowledge').hidden,true);assert.equal(f.count('execute'),1);assert.equal(f.count('result'),1);
  f.sockets.at(-1).push({type:'execution',execution:f.execution('succeeded')});assert.equal(el('execution-diagnostics').dataset.status,'succeeded');
});

const pagesConfig=()=>fromGrid({revision:4,profiles:[{id:'main',name:'Daily'},{id:'more',name:'More'},{id:'empty',name:'Empty page'}],buttons:[
  {id:'tail',profileId:'main',position:11,label:'Last slot',icon:'play',action:{type:'app.open',appId:'test.app'}},
  {id:'other',profileId:'more',position:5,label:'Other page key',icon:'spark',action:{type:'keyboard.shortcut',key:'KeyK',modifiers:['command']}},
  {id:'primary',profileId:'main',position:0,label:'First key',icon:'app',action:{type:'app.open',appId:'test.app'}},
  {id:'blank',profileId:'main',position:3,label:'Not configured',icon:'bolt',action:null},
]});
test('window execution reports its confirmed outcome with a window-specific success title',async t=>{
 const configuration=fromGrid({schemaVersion:2,revision:1,profiles:[{id:'main',name:'Main'}],buttons:[{id:'primary',profileId:'main',position:0,label:'Window',icon:'app',action:{type:'window.activate',appId:'test.app',title:'Win11X99',match:'exact'}}]});
 const f=await client(t,{configuration}),{el}=f;await f.until(()=>!f.button().disabled);f.button().emit('click');f.execute.resolve({execution:f.execution('succeeded',{actionType:'window.activate'})});
 await f.until(()=>el('execution-diagnostics').dataset.status==='succeeded');assert.match(el('execution-message').textContent,/^Window ·/);assert.match(el('execution-message').textContent,/Window activated/);assert.equal(f.count('execute'),1);
});













test('a changed script catalog preserves its stale saved binding and draft; choosing the new approved version is explicit',async t=>{
  const script={id:'script-fixture',name:'Approved test',version:'a'.repeat(64),parameters:[{name:'Message',kind:'text',maxLength:10}]};
  const config=pagesConfig();config.components[0].action={type:'shell.run',scriptId:script.id,version:script.version,args:['saved']};
  const f=await client(t,{configuration:config,scripts:[script]}),{el}=f;el('edit-layout').emit('click');f.button('tail').emit('click');
  el('button-name').value='My draft';el('button-name').emit('input');
  f.state={...f.state,scripts:[{...script,version:'b'.repeat(64)}]};f.intervals[0]();
  await f.until(()=>el('script-select').value==='__unavailable');
  assert.equal(el('button-name').value,'My draft');assert.equal(f.state.config.components[0].action.version,script.version);
  el('config-form').emit('submit');await f.until(()=>el('save-message').textContent==='Saved on your Mac.');
  assert.equal(f.state.config.components[0].action.version,script.version,'Saving an unrelated label must not silently rebind a script');
  el('script-select').value=script.id;el('script-select').emit('change');
  el('script-args').children[1].value='too-long-argument';el('script-args').children[1].emit('input');
  el('config-form').emit('submit');await f.drain();assert.equal(f.count('configuration/save'),1);
  el('script-args').children[1].value='new';el('script-args').children[1].emit('input');el('config-form').emit('submit');
  await f.until(()=>f.state.config.components[0].action.version==='b'.repeat(64));
  assert.deepEqual(f.state.config.components[0].action.args,['new']);assert.equal(f.count('execute'),0);
});

test('a native tap click survives small finger movement, while movement alone never sends an action',async t=>{
  const f=await client(t),button=f.button();await f.until(()=>!button.disabled);
  button.emit('pointerdown',{isPrimary:true,button:0,clientX:150,clientY:100});
  button.emit('pointermove',{clientX:162,clientY:106});
  button.emit('pointermove',{clientX:151,clientY:101});
  assert.equal(f.count('execute'),0,'Pointer motion is never an execution source');
  assert.ok(![...f.timers.values()].some(timer=>timer.delay===550),'Moving cancels long-press editing');
  button.emit('pointerup',{clientX:151,clientY:101});
  button.emit('click');
  assert.equal(f.count('execute'),1,'An ordinary native click on the same key must send once despite finger jitter');
  button.emit('click');assert.equal(f.count('execute'),1,'A pending action must not be sent again');
  f.execute.resolve({execution:f.execution('succeeded')});await f.drain();
});

test('a canceled touch consumes a stale pointer click, and the next deliberate tap works',async t=>{
  const f=await client(t),button=f.button();await f.until(()=>!button.disabled);
  button.emit('pointerdown',{isPrimary:true,button:0,clientX:150,clientY:100});
  button.emit('pointercancel');button.emit('click');
  assert.equal(f.count('execute'),0,'A canceled touch cannot become an action');
  button.emit('pointerdown',{isPrimary:true,button:0,clientX:150,clientY:100});
  button.emit('pointerup',{clientX:150,clientY:100});button.emit('click');
  assert.equal(f.count('execute'),1,'Cancellation must not disable the next tap');
  f.execute.resolve({execution:f.execution('succeeded')});await f.drain();
});

test('keyboard activation is not swallowed by an earlier canceled pointer gesture',async t=>{
  const f=await client(t),button=f.button();await f.until(()=>!button.disabled);
  button.emit('pointerdown',{isPrimary:true,button:0,clientX:150,clientY:100});
  button.emit('pointercancel');assert.equal(f.count('execute'),0);
  button.emit('click',{detail:0});
  assert.equal(f.count('execute'),1,'Keyboard activation is independent of canceled touch input');
  f.execute.resolve({execution:f.execution('succeeded')});await f.drain();
});



const riskyConfig=()=>{const config=pagesConfig();config.components[2].requiresConfirmation=true;return config;};
test('high risk cancel sends no action; confirmation sends one matching reference and never a body or automatic retry',async t=>{
 const f=await client(t,{configuration:riskyConfig()}),{el}=f;
 f.button().emit('click');await f.until(()=>!el('risk-confirm').hidden);assert.equal(f.count('confirmation'),1);assert.equal(f.count('execute'),0);assert.equal(f.storage.has('keyln.pending-request'),false);assert.equal(el('shell').inert,true);
 el('risk-cancel').emit('click');assert.equal(el('risk-confirm').hidden,true);assert.equal(el('shell').inert,false);assert.equal(f.count('execute'),0);
 f.button().emit('click');await f.until(()=>!el('risk-confirm').hidden);el('risk-run').emit('click');el('risk-run').emit('click');assert.equal(f.count('execute'),1);
 const sent=f.calls.find(call=>call.path==='/api/execute').data,asked=f.calls.filter(call=>call.path==='/api/confirmation').at(-1).data;
 assert.equal(sent.requestId,asked.requestId);assert.equal(sent.revision,asked.revision);assert.equal(sent.componentId,'primary');assert.match(sent.confirmation,/^[0-9a-f-]{36}$/);assert.equal(Object.keys(sent).length,4);
 f.execute.resolve({execution:f.execution('succeeded')});await f.drain();assert.equal(f.count('execute'),1);
});
test('risk confirmation expires, is cancelled by offline or changed revision, and is never restored by reconnect',async t=>{
 const f=await client(t,{configuration:riskyConfig()}),{el}=f;
 f.button().emit('click');await f.until(()=>!el('risk-confirm').hidden);const expiry=[...f.timers.values()].find(timer=>timer.delay>29000&&timer.delay<=30000);assert.ok(expiry);expiry.callback();assert.equal(el('risk-confirm').hidden,true);assert.equal(f.count('execute'),0);
 f.button().emit('click');await f.until(()=>!el('risk-confirm').hidden);f.windowEvents.get('offline')();assert.equal(el('risk-confirm').hidden,true);assert.equal(el('shell').inert,false);
 el('connection-button').emit('click');await f.until(()=>f.sockets.length===2&&!f.button().disabled);el('risk-run').emit('click');assert.equal(f.count('execute'),0);
 f.button().emit('click');await f.until(()=>!el('risk-confirm').hidden);f.state.config={...f.state.config,revision:5};f.sockets.at(-1).state();await f.drain();assert.equal(el('risk-confirm').hidden,true);el('risk-run').emit('click');assert.equal(f.count('execute'),0);
});
test('a delayed confirmation reply from a disconnected connection cannot open or execute a stale prompt',async t=>{
 const f=await client(t,{configuration:riskyConfig()}),{el}=f;f.heldConfirmation=deferred();f.button().emit('click');assert.equal(f.count('confirmation'),1);
 f.windowEvents.get('offline')();el('connection-button').emit('click');await f.until(()=>f.sockets.length===2&&!f.button().disabled);
 f.heldConfirmation.resolve({id:randomUUID(),expiresInMs:30000,label:'Old',summary:'Old'});await f.drain();assert.equal(el('risk-confirm').hidden,true);assert.equal(f.count('execute'),0);
});
test('workflow progress shows completed, failed and unrun steps; full bounded Shell output does not disconnect events',async t=>{
 const configuration=pagesConfig();configuration.components[2].action={type:'workflow.run',workflowId:'flow'};configuration.workflows=[{id:'flow',name:'Flow',timeoutMs:3000,steps:[0,1,2].map(i=>({id:`s${i}`,timeoutMs:1000,action:{type:'app.open',appId:'test.app'}}))}];
 const f=await client(t,{configuration}),{el}=f;f.button().emit('click');
 const steps=[{id:'s0',actionType:'shell.run',status:'succeeded',startedAt:1,finishedAt:2,message:'Done',output:{exitCode:0,signal:null,stdout:'<x>'.repeat(1300),stderr:'',truncated:false}},{id:'s1',actionType:'app.open',status:'failed',startedAt:2,finishedAt:3,message:'Owned failure',code:'APP_UNAVAILABLE'}];
 const completed=f.execution('failed',{actionType:'workflow.run',workflow:{id:'flow',totalSteps:3,steps}});f.sockets[0].push({type:'execution',execution:completed});
 assert.equal(f.sockets[0].readyState,1);assert.equal(el('execution-output').hidden,false);assert.match(el('execution-output').textContent,/Step 1 · succeeded/);assert.match(el('execution-output').textContent,/Step 2 · failed/);assert.match(el('execution-output').textContent,/Step 3 · not-run/);assert.match(el('execution-output').textContent,/<x>/);
 f.execute.resolve({execution:completed});await f.drain();assert.equal(f.count('execute'),1);
});



test('a late reconnect query cannot move workflow step progress backwards',async t=>{
 const id=randomUUID(),f=await client(t,{initialPending:id,autoState:false}),{el}=f;f.heldResult=deferred();f.sockets[0].state({busy:true});await f.until(()=>f.count('result')===1);
 const first={id:'first',actionType:'app.open',status:'running',startedAt:1,message:'Starting'},done={...first,status:'succeeded',finishedAt:2,message:'Opened'},second={id:'second',actionType:'keyboard.shortcut',status:'running',startedAt:2,message:'Sending'};
 const newer=f.execution('running',{actionType:'workflow.run',workflow:{id:'flow',totalSteps:3,steps:[done,second]}});f.sockets[0].push({type:'execution',execution:newer});
 assert.match(el('execution-output').textContent,/Step 1 · succeeded/);assert.match(el('execution-output').textContent,/Step 2 · running/);assert.match(el('execution-output').textContent,/Step 3 · not-run/);
 f.heldResult.resolve({execution:f.execution('running',{actionType:'workflow.run',workflow:{id:'flow',totalSteps:3,steps:[first]}})});await f.drain();
 assert.match(el('execution-output').textContent,/Step 1 · succeeded/);assert.match(el('execution-output').textContent,/Step 2 · running/);assert.match(el('execution-output').textContent,/Step 3 · not-run/);assert.equal(f.count('execute'),0);assert.equal(f.count('result'),1);
});

const upload=(f,text)=>{const bytes=new TextEncoder().encode(text);f.el('layout-import-file').files=[{size:bytes.length,arrayBuffer:async()=>bytes.buffer}];f.el('layout-import-file').emit('change');};
test('malformed, future and oversized layout files never create drafts or save; changed Mac state invalidates a preview',async t=>{
 const f=await client(t),{el}=f;
 for(const value of ['{broken',JSON.stringify({...f.state.config,schemaVersion:99}),JSON.stringify({...f.state.config,devices:[]})]){upload(f,value);await f.drain();await f.drain();assert.match(el('layout-file-message').textContent,/File rejected/);assert.equal(f.count('configuration/preview'),0);}
 el('layout-import-file').files=[{size:262145,arrayBuffer:async()=>{throw Error('must not read');}}];el('layout-import-file').emit('change');await f.drain();assert.match(el('layout-file-message').textContent,/256 KiB/);
 upload(f,JSON.stringify(f.state.config));await f.until(()=>!el('layout-import-preview').hidden);f.state.config={...f.state.config,revision:5};f.intervals[0]();await f.drain();await f.drain();assert.equal(el('layout-import-load').disabled,true);el('layout-import-load').emit('click');assert.equal(el('editor').hidden,true);assert.equal(f.count('configuration/import'),0);
});
test('configuration damage shows recovery instructions, disables controls, and revoked sessions can return to pairing afterward',async t=>{
 const f=await client(t),{el}=f;f.configurationFault={status:503,code:'CONFIG_DAMAGED',message:'Recover on the Mac'};f.intervals[0]();await f.drain();await f.drain();
 assert.equal(el('configuration-recovery').hidden,false);assert.equal(el('pair-panel').hidden,true);assert.equal(el('desk').hidden,true);assert.equal(f.button().disabled,true);assert.equal(f.count('execute'),0);
 f.configurationFault={status:401,code:'UNAUTHORIZED',message:'Pair again'};el('connection-button').emit('click');await f.drain();await f.drain();assert.equal(el('configuration-recovery').hidden,true);assert.equal(el('pair-panel').hidden,false);assert.equal(f.count('execute'),0);
});

// T25: compiled client handlers, controlled transport; not browser geometry evidence.
// T52: an empty slot first opens the Add to this page window; choosing Key at a size (S by default) goes on to the New key popup.
function pick(f,tier='S'){assert.equal(f.el('add-dialog').open,true,'the Add to this page window is open');f.el(`add-size-${tier}`).emit('click');}
function newKey(f,slot=1,type='app.open') {
  f.el('button-grid').children[slot].emit('click');pick(f);
  f.el('action-options').children.find(node=>node.dataset.actionType===type).emit('click');
  // T37: an Open app / Activate window action on a new key with no app opens the App picker. Most tests go on without it.
  if(f.el('app-dialog').open)f.el('app-dialog').emit('cancel');
  return f.button(f.el('button-grid').children[slot].dataset.buttonId);
}
function chooseApp(f,id='test.app') {
  f.el('app-select').emit('click');
  f.el('app-dialog-grid').children.find(node=>node.dataset.appId===id).emit('click');
}
// R2: abandoned untouched placeholders must never become persisted buttons.
const draftKeys=f=>f.el('button-grid').children.filter(node=>node.dataset.buttonId);
const emptyDraft=(f,slot=1)=>{f.el('button-grid').children[slot].emit('click');pick(f);return f.el('button-grid').children[slot].dataset.buttonId;};
const shortcutSave=f=>f.windowEvents.get('keydown')({metaKey:true,key:'s',preventDefault(){}});
test('T26 entering Edit, turning to an empty page and tapping empty canvas create no key and open no card',async t=>{
 const f=await client(t,{configuration:pagesConfig()}),{el}=f;el('edit-layout').emit('click');f.page('empty').emit('click');
 assert.equal(draftKeys(f).length,0);assert.equal(el('save-message').dataset.dirty,'false');assert.equal(el('desk-save').hidden,true);
 assert.equal(el('editor').hidden,true);
 el('button-grid').emit('click',{target:el('button-grid')});
 assert.equal(draftKeys(f).length,0);assert.equal(el('editor').hidden,true);assert.equal(f.count('configuration/save'),0);assert.equal(f.count('execute'),0);
});
test('T26 grid keeps full user labels and accessible names in Use and Edit for both cell widths',async t=>{
 const names=['M90Pro（Local LAN）','T640_Win10（T）','Chatgpt 聊天'];
 const configuration=fromGrid({schemaVersion:3,revision:4,profiles:[{id:'main',name:'Names'}],buttons:names.flatMap((label,row)=>[1,2].map((columns,index)=>({id:row===0&&index===0?'primary':`label-${row}-${columns}`,profileId:'main',position:row*4+index,label,icon:'app',size:{columns,rows:1},action:{type:'app.open',appId:'test.app'}})))});
 const f=await client(t,{configuration});
 for(const editing of [false,true]){
  if(editing)f.el('edit-layout').emit('click');
  for(const key of configuration.components){const tile=f.button(key.id);assert.equal(tile.children[2].textContent,key.label);assert.ok(tile.getAttribute('aria-label').includes(key.label));assert.ok(tile.title.includes(key.label));}
 }
 assert.equal(f.count('configuration/save'),0);assert.equal(f.count('execute'),0);
});
test('T26 console HTML and scripts use English UI; management and measurement pages are separate',()=>{
 const root=new URL('../apps/web/',import.meta.url),files=['index.html',...readdirSync(root).filter(name=>name.endsWith('.ts')&&!['admin.ts','check.ts'].includes(name))];
 // T32: icon-keywords.ts holds the Chinese side of the Chinese-English keyword table. Outside that table and its comments it is English like the rest.
 for(const name of files.filter(name=>name!=='icon-keywords.ts'))assert.doesNotMatch(readFileSync(new URL(name,root),'utf8'),/\p{Script=Han}/u,name);
 const keywords=readFileSync(new URL('icon-keywords.ts',root),'utf8');assert.match(keywords,/\p{Script=Han}/u);
 assert.doesNotMatch(keywords.replace(/^\/\/.*$/gm,'').replace(/const TABLE = `[^`]*`;/,''),/\p{Script=Han}/u,'icon-keywords.ts: Chinese only inside the table');
 const html=readFileSync(new URL('index.html',root),'utf8');assert.doesNotMatch(html,/empty-slot-add/);assert.match(html,/<section id="editor" class="settings-card" hidden aria-labelledby="editor-title">/);assert.doesNotMatch(html,/Review other draft changes|id="add-dialog"|id="edit-bar"|<dialog id="editor"/);
});
test('T27 stale icon responses cannot replace a changed glyph; a failed request leaves an executable fallback',async t=>{
 const held=deferred(),id='test.stale'+Date.now();
 const f=await client(t,{iconReply:()=>held.promise}),target=f.el('owned-icon');
 const key={id:'icon-key',profileId:'main',position:1,label:'Icon',icon:'app',action:{type:'app.open',appId:id}};
 setKeyIcon(target,key);assert.equal(target.getAttribute('data-symbol'),'app-window');
 setKeyIcon(target,{...key,appearance:{glyph:{type:'text',text:'AI'}}});
 const data=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1EAAAAASUVORK5CYII=','base64');data.writeUInt32BE(128,16);data.writeUInt32BE(128,20);
 held.resolve(Response.json({icons:[{appId:key.action.appId,png:data.toString('base64')}]}));for(let n=0;n<4;n++)await f.drain();
 assert.equal(target.getAttribute('data-glyph'),'text');assert.equal(target.textContent,'AI');
 f.button().emit('click');assert.equal(f.count('execute'),1);f.execute.resolve({execution:f.execution('succeeded')});await f.until(()=>f.el('execution-diagnostics').dataset.status==='succeeded');
 assert.equal(f.count('execute'),1);
});

test('T28 App ranking keeps every utility searchable, prefers page/recent bindings, then sorts names',()=>{
 const apps=[{id:'helper.aos',name:'AOSUIPrefPaneLauncher'},{id:'com.apple.Safari',name:'Safari'},{id:'com.microsoft.rdc.macos',name:'Windows App'},{id:'helper.ard',name:'ARDAgent'},{id:'local.notes',name:'Notes'},{id:'local.alpha',name:'Alpha'}];
 const ranked=rankApplications(apps,'',{used:['com.microsoft.rdc.macos'],recent:['com.apple.Safari']});
 assert.deepEqual(ranked.map(a=>a.id),['com.microsoft.rdc.macos','com.apple.Safari','local.alpha','local.notes','helper.aos','helper.ard']);
 assert.deepEqual(ranked.map(a=>a.group),['On this page','Recently used','All apps','All apps','System utilities','System utilities']);
 for(const [query,id]of [['Safari','com.apple.Safari'],['windows app','com.microsoft.rdc.macos'],['AOSUIPrefPaneLauncher','helper.aos'],['ARDAgent','helper.ard'],['ＣＯＭ.apple.safari','com.apple.Safari']])assert.equal(rankApplications(apps,query,{used:[],recent:[]})[0].id,id);
 assert.equal(new Set(ranked.map(a=>a.id)).size,apps.length);assert.equal(apps[0].name,'AOSUIPrefPaneLauncher');
});

// T30: hidden pages, cross-page key moves and JPEG/SVG icon input. Compiled handlers with a fake DOM;
// no browser rendering, canvas pixels or Surface evidence.
const hiddenConfig=(...hidden)=>{const config=pagesConfig();for(const id of hidden.length?hidden:['more'])config.pages.find(profile=>profile.id===id).hidden=true;return config;};
const navigation=f=>({tabs:f.el('use-pages').children.map(node=>node.dataset.pageId),dots:f.el('page-dots').children.map(node=>node.dataset.pageId),switcher:f.el('page-switcher').children.map(option=>option.value)});
const lastSave=f=>f.calls.findLast(call=>call.path==='/api/configuration/save').data;
const swipe=(f,from,to)=>{f.el('button-grid').emit('pointerdown',{isPrimary:true,button:0,clientX:from,clientY:100});f.el('button-grid').emit('pointerup',{clientX:to,clientY:105});};
const card=(f,id)=>f.el('key-page-cards').children.find(node=>node.dataset.pageId===id);
const styleChoice=(f,group,value)=>f.el(group).children.find(node=>node.dataset.value===value).emit('click');
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

// T31: the Icon library panel. Compiled handlers with a fake DOM, a fake Host and a stub canvas; no network, no real rendering.
const libReply=value=>({ok:true,json:async()=>value});
const libFailure=(status,code,message)=>({ok:false,status,json:async()=>({error:{code,message}})});
const vector=(body='<path d="M3 10l9-7l9 7v10H3z"/>')=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><g fill="none" stroke="currentColor" stroke-width="2">${body}</g></svg>`;
const SETS={'material-symbols':['Material Symbols','Apache-2.0'],lucide:['Lucide','ISC'],tabler:['Tabler Icons','MIT'],ph:['Phosphor','MIT'],fluent:['Fluent UI System Icons','MIT'],'simple-icons':['Simple Icons','CC0-1.0'],logos:['SVG Logos','CC0-1.0'],devicon:['Devicon','MIT']};
const CURATED=['material-symbols','lucide','tabler','ph','fluent','simple-icons'];
// The shape the Mac sends: set name and licence travel with every icon.
const libIcon=(set,name,addedAt,svg=vector())=>({id:`${set}:${name}`,set,name,svg,setName:SETS[set]?.[0]??set,license:SETS[set]?.[1]??'Unknown license',...(addedAt===undefined?{}:{addedAt})});
const ownVector=(color='#111')=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path fill="${color}" d="M3 10l9-7l9 7v10H3z"/></svg>`;
const unpack=url=>Buffer.from(url.split(',')[1],'base64').toString();
function libraryHost(f,{stored=[],found=[],search,add,remove}={}) {
  const host={stored:[...stored],requests:[]};
  f.library=async(path,data)=>{
    host.requests.push({path,data});
    if(path==='/api/icon-library')return libReply({icons:host.stored,sets:[]});
    if(path==='/api/icon-library/search')return search?await search(data):libReply({results:found.filter(item=>data.scope==='all'||CURATED.includes(item.set)).filter(item=>!data.set||item.set===data.set).map(({addedAt,...item})=>item)});
    if(path==='/api/icon-library/add'){
      if(add)return await add(data,host);
      const item=found.find(candidate=>candidate.id===data.id),icon={...item,addedAt:1_700_000_000_000+host.stored.length};host.stored.push(icon);return libReply({icon});
    }
    if(path==='/api/icon-library/remove'){
      if(remove)return await remove(data,host);
      const had=host.stored.some(item=>item.id===data.id);host.stored=host.stored.filter(item=>item.id!==data.id);return libReply({removed:had});
    }
    throw new Error(`Unexpected ${path}`);
  };
  return host;
}
async function openLibrary(f,key){
  f.el('edit-layout').emit('click');f.button(key).emit('click');
  f.el('icon-source').value='library';f.el('icon-source').emit('change');
  await f.until(()=>/My icons|^$/.test(f.el('library-message').textContent)&&f.el('library-search').disabled===false&&f.count('icon-library')>=1);
}
const gridIds=node=>node.children.map(child=>child.dataset.iconId);
const typeQuery=(f,text,set='')=>{f.el('library-query').value=text;f.el('library-query').emit('input');f.el('library-set').value=set;f.el('library-set').emit('change');};
const online=f=>f.el('library-tab-online').emit('click');
test('T31 choosing Icon library lists My icons from the Mac as <img> thumbnails and filters them without any request',async t=>{
  const f=await client(t),{el}=f,host=libraryHost(f,{stored:[libIcon('lucide','house',100),libIcon('tabler','camera',300),libIcon('simple-icons','demobrand',200)]});
  const html=document.body.children.length;
  await openLibrary(f,'primary');
  assert.equal(f.count('icon-library'),1);assert.deepEqual(host.requests[0],{path:'/api/icon-library',data:{}});
  assert.equal(el('library-icon-fields').hidden,false);for(const id of ['image-icon-fields','text-icon-fields','icon-library','app-icon-note'])assert.equal(el(id).hidden,true,id);
  assert.equal(el('icon-source').value,'library');assert.equal(el('library-mine').hidden,false);assert.equal(el('library-online').hidden,true);
  assert.deepEqual(gridIds(el('library-grid')),['tabler:camera','simple-icons:demobrand','lucide:house'],'newest first');
  const first=el('library-grid').children[0];assert.equal(first.getAttribute('aria-label'),'Tabler Icons · camera · MIT');assert.equal(first.children.length,1);
  const src=first.children[0].src;assert.match(src,/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/);
  const shown=unpack(src);assert.doesNotMatch(shown,/currentColor/i);assert.match(shown,/stroke="#EEEFF1"/);assert.doesNotMatch(src,/blob:/);
  assert.equal(document.body.children.length,html,'nothing is added to the page body');assert.equal(el('library-selected').hidden,true);
  el('library-filter').value='lucide';el('library-filter').emit('input');assert.deepEqual(gridIds(el('library-grid')),['lucide:house']);
  el('library-filter').value='  Tabler   camera ';el('library-filter').emit('input');assert.deepEqual(gridIds(el('library-grid')),['tabler:camera']);
  el('library-filter').value='nothing here';el('library-filter').emit('input');assert.deepEqual(gridIds(el('library-grid')),[]);assert.equal(el('library-empty').hidden,false);assert.match(el('library-empty').textContent,/No icons match/);
  let prevented=false;el('library-filter').emit('keydown',{key:'Enter',preventDefault(){prevented=true;}});assert.equal(prevented,true,'Enter in the filter must not submit the layout form');
  el('library-filter').value='';el('library-filter').emit('input');assert.equal(el('library-grid').children.length,3);assert.equal(f.count('icon-library'),1,'filtering is local');
  assert.equal(f.count('configuration/save'),0);assert.equal(f.count('execute'),0);assert.equal(el('desk-save').hidden,true,'browsing icons does not change the draft');
});
test('T31 an empty My icons says how to fill it, and a failed load keeps the panel usable',async t=>{
  const f=await client(t),{el}=f;libraryHost(f);
  await openLibrary(f,'primary');assert.equal(el('library-empty').hidden,false);assert.match(el('library-empty').textContent,/My icons is empty/);assert.equal(el('library-grid').children.length,0);
  f.library=async()=>libFailure(500,'HOST_ERROR','The Host could not complete this request.');
  el('icon-source').value='builtin';el('icon-source').emit('change');el('icon-source').value='library';el('icon-source').emit('change');
  await f.until(()=>el('library-message').dataset.tone==='error');assert.match(el('library-message').textContent,/could not complete/);assert.equal(el('library-search').disabled,false);
});
test('T32 searching starts only from the Search button or Enter, opens the results window, locks the controls meanwhile, and sends scope and set',async t=>{
  const f=await client(t),{el}=f,held=deferred();
  const host=libraryHost(f,{search:async()=>{await held.promise;return libReply({results:[libIcon('lucide','house'),libIcon('simple-icons','demobrand'),{id:'evil:x',set:'evil',name:'x',svg:vector()},{...libIcon('lucide','script'),svg:vector('<script>alert(1)</script>')}]});}});
  await openLibrary(f,'primary');online(f);
  assert.equal(el('library-online').hidden,false);assert.equal(el('library-mine').hidden,true);assert.equal(el('library-tab-online').getAttribute('aria-pressed'),'true');assert.equal(el('library-tab-mine').getAttribute('aria-pressed'),'false');
  for(const id of ['library-set','library-dialog-set']){
    assert.deepEqual(el(id).children.map(option=>option.value),['','material-symbols','lucide','tabler','ph','fluent','simple-icons'],id);
    assert.equal(el(id).children[0].text,'All curated sets');assert.match(el(id).children[2].text,/^Lucide · ISC$/);
  }
  for(const text of ['h','ho','hom','home'])typeQuery(f,text);
  assert.equal(f.count('icon-library/search'),0,'typing never searches');assert.notEqual(el('library-dialog').open,true);
  typeQuery(f,'h');el('library-search').emit('click');assert.equal(f.count('icon-library/search'),0);assert.match(el('library-message').textContent,/2 to 64 characters/);assert.equal(el('library-message').dataset.tone,'error');assert.notEqual(el('library-dialog').open,true,'a too-short word does not open the window');
  typeQuery(f,'  home  ');el('library-search').emit('click');
  assert.equal(el('library-dialog').open,true,'Search opens the results window');assert.equal(el('library-dialog-title').textContent,'Results for “home”');
  assert.equal(el('library-status').textContent,'Searching…');assert.equal(el('library-results').getAttribute('aria-busy'),'true');
  for(const id of ['library-search','library-scope-curated','library-scope-all','library-dialog-set','library-search-all'])assert.equal(el(id).disabled,true,`${id} is locked while searching`);
  assert.equal(el('library-dialog-close').disabled,false,'the window can always be closed');
  el('library-search').emit('click');el('library-query').emit('keydown',{key:'Enter',preventDefault(){}});el('library-scope-all').emit('click');await f.drain();
  assert.equal(f.count('icon-library/search'),1,'a second request cannot start while one is running');assert.deepEqual(host.requests.at(-1).data,{query:'home',scope:'curated'});
  held.resolve();await f.until(()=>!el('library-scope-all').disabled);
  assert.deepEqual(gridIds(el('library-results')),['lucide:house','simple-icons:demobrand'],'unsafe results and sets outside the curated six are ignored in a curated search');
  assert.equal(el('library-status').textContent,'2 icons found. Tap one to save it to My icons.');assert.equal(el('library-results').getAttribute('aria-busy'),'false');assert.equal(el('library-search').disabled,false);
  assert.match(unpack(el('library-results').children[0].children[0].src),/stroke="#EEEFF1"/);
  const tile=el('library-results').children[1];assert.equal(tile.getAttribute('aria-label'),'Simple Icons · demobrand · CC0-1.0');assert.equal(tile.title,'Simple Icons · demobrand · CC0-1.0');
  assert.deepEqual(tile.children.slice(1).map(node=>node.textContent),['Simple Icons','CC0-1.0'],'each result shows its set and licence');
  assert.equal(el('library-suggest').hidden,true);assert.equal(el('library-examples').hidden,true);assert.equal(el('library-license-note').hidden,true);assert.equal(el('library-dialog-sets').hidden,false);
  el('library-dialog-close').emit('click');assert.equal(el('library-dialog').open,false);
  // Enter in the box searches (and never submits the layout form); the chosen set is sent.
  let prevented=false;typeQuery(f,'camera','lucide');el('library-query').emit('keydown',{key:'a',preventDefault(){prevented=true;}});assert.equal(prevented,false);assert.equal(f.count('icon-library/search'),1);
  el('library-query').emit('keydown',{key:'Enter',preventDefault(){prevented=true;}});assert.equal(prevented,true);await f.until(()=>f.count('icon-library/search')===2);
  assert.deepEqual(host.requests.at(-1).data,{query:'camera',scope:'curated',set:'lucide'});assert.equal(el('library-dialog').open,true);assert.equal(el('library-dialog-set').value,'lucide');
  await f.until(()=>!el('library-search').disabled);
  assert.equal(f.count('configuration/save'),0);assert.equal(f.count('execute'),0);
});
test('T32 empty results, a busy Host and an offline Mac give clear messages in the window while My icons keeps working',async t=>{
  const f=await client(t),{el}=f;
  const host=libraryHost(f,{stored:[libIcon('lucide','house',1)],search:async data=>data.query==='nothing'?libReply({results:[]}):data.query==='busy'?libFailure(409,'BUSY','Icon search is busy. Try again in a moment.'):
    libFailure(503,'ICON_SEARCH_UNAVAILABLE','Searching online icons needs your Mac to reach the internet. My icons still works offline.')});
  await openLibrary(f,'primary');online(f);
  typeQuery(f,'nothing');el('library-search').emit('click');await f.until(()=>/^No icons/.test(el('library-status').textContent));
  assert.equal(el('library-status').textContent,'No icons in the curated sets for “nothing”.');assert.equal(el('library-results').children.length,0);assert.equal(el('library-suggest').hidden,false,'the wider search is offered');
  el('library-dialog-close').emit('click');
  typeQuery(f,'busy');el('library-search').emit('click');await f.until(()=>/busy/.test(el('library-status').textContent));assert.equal(el('library-status').dataset.tone,'error');assert.equal(el('library-scope-all').disabled,false);assert.equal(el('library-search-all').parentNode===undefined||el('library-suggest').hidden,true,'an error is not "no results"');
  el('library-dialog-close').emit('click');
  typeQuery(f,'offline');el('library-search').emit('click');await f.until(()=>/internet/.test(el('library-status').textContent));
  assert.equal(el('library-status').textContent,'Searching online icons needs your Mac to reach the internet. My icons still works offline.');assert.equal(el('library-status').dataset.tone,'error');assert.equal(el('library-search').disabled,false);
  assert.equal(el('library-dialog').open,true,'the window stays open so the person can retry or close it');
  el('library-dialog-close').emit('click');
  el('library-tab-mine').emit('click');assert.deepEqual(gridIds(el('library-grid')),['lucide:house']);el('library-grid').children[0].emit('click');assert.equal(el('library-selected').hidden,false);
  assert.equal(el('library-use').disabled,false,'a saved icon can still be used with no internet');assert.equal(host.requests.filter(request=>request.path.endsWith('/add')).length,0);
});
test('T32 tapping a result saves it into My icons once, selects it, closes the window and shows its set, license and trademark note',async t=>{
  const f=await client(t),{el}=f,found=[libIcon('lucide','house'),libIcon('simple-icons','demobrand')],adding=deferred();
  const host=libraryHost(f,{found,add:async(data,h)=>{await adding.promise;const item=found.find(candidate=>candidate.id===data.id),icon={...item,addedAt:1_700_000_000_000+h.stored.length};h.stored.push(icon);return libReply({icon});}});
  await openLibrary(f,'primary');online(f);typeQuery(f,'house');el('library-search').emit('click');await f.until(()=>el('library-results').children.length===2);
  const lucide=el('library-results').children.find(node=>node.dataset.iconId==='lucide:house');assert.equal(lucide.dataset.saved,'false');
  lucide.emit('click');assert.equal(el('library-status').textContent,'Saving Lucide · house to My icons…');assert.equal(el('library-dialog').open,true,'the window stays until the icon is saved');
  assert.equal(el('library-search').disabled,true);lucide.emit('click');await f.drain();assert.equal(host.requests.filter(request=>request.path.endsWith('/add')).length,1,'a second tap while saving is ignored');
  adding.resolve();await f.until(()=>/^Saved/.test(el('library-message').textContent));
  assert.deepEqual(host.requests.at(-1),{path:'/api/icon-library/add',data:{id:'lucide:house'}});
  assert.equal(el('library-dialog').open,false,'the window closes and the panel shows the choice');
  assert.equal(el('library-selected').hidden,false);assert.equal(el('library-selected-name').textContent,'house');assert.equal(el('library-selected-set').textContent,'Lucide · ISC');
  assert.equal(el('library-brand-note').hidden,true);assert.equal(el('library-message').textContent,'Saved Lucide · house to My icons.');
  assert.equal(el('library-use').disabled,false);assert.equal(el('library-remove').disabled,false);assert.equal(el('library-search').disabled,false);
  assert.equal(el('library-preview-frame').style['--library-preview-bg'],undefined,'the preview sits on the dark key body (the stylesheet default); only Classic paints a colored plate');
  assert.match(unpack(el('library-preview').src),/stroke="#F1EFE8"/);assert.equal(el('library-color').value,'#F1EFE8');assert.equal(el('library-color').disabled,false);assert.equal(el('library-color-reset').disabled,true);assert.equal(el('library-own-colors').hidden,true);
  // Searching again shows the saved icon with its dot; tapping it only selects it and does not download again.
  el('library-search').emit('click');await f.until(()=>el('library-results').children.length===2);
  const again=el('library-results').children.find(node=>node.dataset.iconId==='lucide:house');assert.equal(again.dataset.saved,'true');assert.equal(again.getAttribute('aria-pressed'),'true');
  el('library-results').children.find(node=>node.dataset.iconId==='simple-icons:demobrand').emit('click');adding.resolve();
  await f.until(()=>el('library-selected-name').textContent==='demobrand');assert.equal(el('library-selected-set').textContent,'Simple Icons · CC0-1.0');assert.equal(el('library-brand-note').hidden,false);assert.equal(el('library-dialog').open,false);
  el('library-search').emit('click');await f.until(()=>el('library-results').children.length===2);
  el('library-results').children.find(node=>node.dataset.iconId==='lucide:house').emit('click');await f.drain();
  assert.equal(host.requests.filter(request=>request.path.endsWith('/add')).length,2,'an icon that is already saved is not downloaded again');assert.equal(el('library-selected-name').textContent,'house');assert.equal(el('library-dialog').open,false);assert.equal(el('library-message').textContent,'Lucide · house selected.');
  el('library-tab-mine').emit('click');assert.deepEqual(gridIds(el('library-grid')).sort(),['lucide:house','simple-icons:demobrand']);
  assert.equal(f.count('configuration/save'),0);assert.equal(el('desk-save').hidden,true,'saving to My icons does not touch the layout draft');
  const html=readFileSync(new URL('../apps/web/index.html',import.meta.url),'utf8');assert.match(html,/<p id="library-brand-note" class="field-note" hidden>Brand logos are trademarks of their owners\.<\/p>/);
});
test('T32 a full My icons or a rejected download is reported in the window and nothing is selected',async t=>{
  const f=await client(t),{el}=f;
  libraryHost(f,{found:[libIcon('lucide','house'),libIcon('lucide','camera')],add:async data=>data.id==='lucide:house'?libFailure(409,'ICON_LIBRARY_FULL','My icons holds at most 500 icons. Remove some first.'):libReply({icon:{...libIcon('lucide','other'),addedAt:5}})});
  await openLibrary(f,'primary');online(f);typeQuery(f,'house');el('library-search').emit('click');await f.until(()=>el('library-results').children.length===2);
  el('library-results').children[0].emit('click');await f.until(()=>el('library-status').dataset.tone==='error');
  assert.equal(el('library-status').textContent,'My icons holds at most 500 icons. Remove some first.');assert.equal(el('library-selected').hidden,true);assert.equal(el('library-search').disabled,false);assert.equal(el('library-dialog').open,true,'the window stays open after a failure');
  el('library-results').children[1].emit('click');await f.until(()=>/cannot be used/.test(el('library-status').textContent));assert.equal(el('library-selected').hidden,true,'a reply for a different icon is refused');
  el('library-dialog-close').emit('click');el('library-tab-mine').emit('click');assert.equal(el('library-grid').children.length,0);
});
test('T31 the default icon color follows the key look, and returning to the key shows the stored image as My image',async t=>{
  const f=await client(t,{configuration:pagesConfig()}),{el}=f,stubs=imageStubs(t);
  libraryHost(f,{stored:[libIcon('lucide','house',9)]});
  await openLibrary(f,'primary');el('library-grid').children[0].emit('click');assert.equal(el('library-color').value,'#F1EFE8');
  styleChoice(f,'icon-style','outline');assert.equal(el('library-color').value,'#617C96');assert.equal(el('library-preview-frame').style['--library-preview-bg'],undefined);
  el('custom-color-enabled').checked=true;el('custom-color-enabled').emit('change');el('key-tint').value='#102030';el('key-tint').emit('input');assert.equal(el('library-color').value,'#102030');
  el('library-use').emit('click');await f.until(()=>stubs.images.length===1&&el('library-message').dataset.tone==='ok');assert.match(unpack(stubs.images[0].url),/stroke="#102030"/);
  f.button('tail').emit('click');assert.equal(el('library-message').textContent,'','a different key starts with a clean panel');assert.equal(el('icon-source').value,'builtin');assert.equal(el('library-icon-fields').hidden,true);
  f.button('primary').emit('click');assert.equal(el('icon-source').value,'image','the glyph is a stored image, so the key reopens as My image');
  el('icon-source').value='library';el('icon-source').emit('change');await f.until(()=>f.count('icon-library')===2);assert.equal(el('library-color').value,'#102030');
});
test('T31 replies for a key or page the person has left are dropped',async t=>{
  const f=await client(t,{configuration:pagesConfig()}),{el}=f,held=deferred(),adding=deferred(),stubs=imageStubs(t);
  const host=libraryHost(f,{stored:[libIcon('tabler','camera',1)],search:async()=>{await held.promise;return libReply({results:[libIcon('lucide','house')]});},
    add:async data=>{await adding.promise;const icon={...libIcon('lucide','house'),addedAt:7};host.stored.push(icon);return libReply({icon});}});
  await openLibrary(f,'primary');online(f);typeQuery(f,'house');el('library-search').emit('click');assert.equal(el('library-search').disabled,true);
  assert.equal(el('library-dialog').open,true);f.button('tail').emit('click');assert.equal(el('library-dialog').open,false,'choosing another key closes the results window');
  assert.equal(el('library-search').disabled,false,'the new key is not stuck waiting for the old search');assert.equal(el('library-message').textContent,'');
  held.resolve();await f.drain();await f.drain();
  assert.equal(el('library-results').children.length,0,'late results are not shown');assert.equal(el('library-message').textContent,'');
  // The same for a page change.
  el('icon-source').value='library';el('icon-source').emit('change');await f.until(()=>f.count('icon-library')===2&&!el('library-search').disabled);online(f);
  const second=deferred();host.requests.length=0;
  f.library=async(path,data)=>{host.requests.push({path,data});if(path==='/api/icon-library/search'){await second.promise;return libReply({results:[libIcon('lucide','late')]});}return libReply({icons:host.stored,sets:[]});};
  typeQuery(f,'late');el('library-search').emit('click');assert.equal(el('library-dialog').open,true);f.page('more').emit('click');f.button('other').emit('click');assert.equal(el('library-dialog').open,false,'so does a page change');
  second.resolve();await f.drain();await f.drain();assert.equal(el('library-results').children.length,0);assert.equal(el('library-search').disabled,false);
  // A download that finishes after the key changed is stored on the Mac but does not select anything here.
  f.library=async(path,data)=>{host.requests.push({path,data});if(path==='/api/icon-library/search')return libReply({results:[libIcon('lucide','house')]});if(path.endsWith('/add')){await adding.promise;const icon={...libIcon('lucide','house'),addedAt:7};host.stored.push(icon);return libReply({icon});}return libReply({icons:host.stored,sets:[]});};
  f.page('main').emit('click');f.button('tail').emit('click');el('icon-source').value='library';el('icon-source').emit('change');await f.until(()=>!el('library-search').disabled);online(f);
  typeQuery(f,'house');el('library-search').emit('click');await f.until(()=>el('library-results').children.length===1);
  el('library-results').children[0].emit('click');f.button('primary').emit('click');adding.resolve();await f.drain();await f.drain();
  assert.equal(el('library-selected').hidden,true);assert.equal(el('library-message').textContent,'');assert.equal(stubs.images.length,0);assert.equal(el('desk-save').hidden,true);
  assert.equal(host.stored.length,2,'the Mac did store the icon');
});
test('T31 undecodable or tainted library icons leave the draft as it was, and Remove deletes from My icons only',async t=>{
  const f=await client(t),{el}=f;
  let stubs=imageStubs(t,{svgFails:true});
  const host=libraryHost(f,{stored:[libIcon('lucide','house',9),libIcon('tabler','camera',8)]});
  await openLibrary(f,'primary');el('library-grid').children[0].emit('click');
  el('library-use').emit('click');await f.until(()=>el('library-message').dataset.tone==='error');assert.match(el('library-message').textContent,/could not be decoded/);assert.equal(el('desk-save').hidden,true);assert.equal(el('library-use').disabled,false);
  stubs=imageStubs(t,{tainted:true});el('library-use').emit('click');await f.until(()=>/cannot be converted safely/.test(el('library-message').textContent));assert.equal(el('desk-save').hidden,true);
  assert.equal(host.requests.filter(request=>request.path.endsWith('/remove')).length,0);
  el('library-remove').emit('click');assert.equal(el('library-remove').disabled,true);await f.until(()=>/^Removed/.test(el('library-message').textContent));
  assert.deepEqual(host.requests.at(-1),{path:'/api/icon-library/remove',data:{id:'lucide:house'}});
  assert.equal(el('library-message').textContent,'Removed Lucide · house from My icons. Keys that already use it are not changed.');
  assert.equal(el('library-selected').hidden,true);assert.deepEqual(gridIds(el('library-grid')),['tabler:camera']);assert.equal(el('desk-save').hidden,true,'removing an icon from My icons does not touch the layout');
  el('library-grid').children[0].emit('click');host.stored=[];
  el('library-remove').emit('click');await f.until(()=>/^Removed/.test(el('library-message').textContent));assert.equal(el('library-grid').children.length,0);assert.match(el('library-empty').textContent,/My icons is empty/);
  void stubs;
});
test('T31 a failed remove reports the Mac error and keeps the icon',async t=>{
  const f=await client(t),{el}=f;
  libraryHost(f,{stored:[libIcon('lucide','house',9)],remove:async()=>libFailure(503,'ICON_LIBRARY_UNAVAILABLE','My icons could not be opened or repaired on the Mac.')});
  await openLibrary(f,'primary');el('library-grid').children[0].emit('click');el('library-remove').emit('click');
  await f.until(()=>el('library-message').dataset.tone==='error');assert.equal(el('library-message').textContent,'My icons could not be opened or repaired on the Mac.');
  assert.deepEqual(gridIds(el('library-grid')),['lucide:house']);assert.equal(el('library-selected').hidden,false);assert.equal(el('library-remove').disabled,false);
});
test('T31 markup, source choices and source code keep the SVG out of the DOM and the CSP unchanged',()=>{
  const html=readFileSync(new URL('../apps/web/index.html',import.meta.url),'utf8'),css=readFileSync(new URL('../apps/web/style.css',import.meta.url),'utf8');
  assert.match(html,/<input id="icon-source" type="hidden" value="app">/);assert.doesNotMatch(html,/<select id="icon-source"/);
  assert.match(html,/<div id="icon-tabs" class="icon-tabs" role="tablist"[^>]*>\s*<button id="icon-tab-app"[^>]*role="tab"[^>]*>App icon<\/button>\s*<button id="icon-tab-builtin"[^>]*role="tab"[^>]*>Built-in icon<\/button>\s*<button id="icon-tab-text"[^>]*role="tab"[^>]*>Text \/ Emoji<\/button>\s*<button id="icon-tab-image"[^>]*role="tab"[^>]*>My image<\/button>\s*<\/div>/);
  const appearance=html.slice(html.indexOf('<section id="key-icon-section"'),html.indexOf('<p id="field-error"'));
  for(const id of ['library-icon-fields','library-tab-mine','library-tab-online','library-filter','library-grid','library-empty','library-query','library-set','library-search','library-message','library-selected','library-preview','library-selected-name','library-selected-set','library-brand-note','library-color','library-color-reset','library-use','library-remove'])assert.ok(appearance.includes(`id="${id}"`),id);
  assert.match(html,/<button id="library-tab-mine" type="button" aria-pressed="true">My icons<\/button><button id="library-tab-online" type="button" aria-pressed="false">Search online<\/button>/);
  assert.match(html,/<button id="library-use" class="solid" type="button" disabled>Use on this key<\/button>/);assert.match(html,/Remove from My icons/);assert.match(html,/id="library-search" class="quiet" type="button">Search<\/button>/);assert.match(html,/<label for="library-color">Icon color<\/label>/);
  assert.match(html,/id="library-query" type="search" maxlength="64"/);
  assert.match(css,/\.library-icon\{[^}]*min-height:52px/);assert.match(css,/\.library-tabs button\{min-height:var\(--ctl-h\)/);assert.match(css,/\.library-dialog \.library-tabs button\{min-height:44px\}/,'the search-results window keeps 44px tabs (T79)');assert.match(css,/\.library-grid\{[^}]*minmax\(52px,1fr\)/);
  for(const name of ['icon-library.ts','layout-tools.ts'])assert.doesNotMatch(readFileSync(new URL('../apps/web/'+name,import.meta.url),'utf8'),/createObjectURL|DOMParser|innerHTML|outerHTML|insertAdjacentHTML|blob:|eval\(|new Function/,name);
  const server=readFileSync(new URL('../apps/host/server.ts',import.meta.url),'utf8');
  assert.match(server,/default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; manifest-src 'self'; connect-src 'self' \$\{eventOrigin\}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'/);
  assert.match(server,/"\/apps\/web\/icon-library\.js"/);
  const layout=readFileSync(new URL('../apps/web/layout-tools.ts',import.meta.url),'utf8');
  assert.equal(layout.match(/toDataURL\(/g).length,1,'one canvas conversion shared by uploads and the Icon library');assert.equal(layout.match(/function rasterIcon/g).length,1);
});

// T32: the results window, all Iconify sets, Chinese keywords and icons that keep their own colors.
const cutIn=(f,text,set='')=>{typeQuery(f,text,set);f.el('library-search').emit('click');};
const requestsOf=host=>host.requests.filter(request=>request.path.endsWith('/search')).map(request=>request.data);
const closeWindow=f=>f.el('library-dialog-close').emit('click');
test('T32 no curated result offers Search all Iconify sets; the wider search shows every set, its licence and the licence note, and Curated sets goes back',async t=>{
  const f=await client(t),{el}=f,codex=[libIcon('logos','codex',undefined,ownVector()),libIcon('devicon','codex',undefined,ownVector('#5061f7')),libIcon('devicon','codex-plain'),libIcon('lucide','house')];
  // A fake Iconify: matches the word in the icon name, and honors scope and set like the Mac does.
  const host=libraryHost(f,{search:async data=>libReply({results:[...codex,libIcon('tabler','home')].filter(item=>item.name.includes(data.query)||data.query==='house'&&item.name==='house').filter(item=>data.scope==='all'||CURATED.includes(item.set)).filter(item=>!data.set||item.set===data.set)})});
  await openLibrary(f,'primary');online(f);cutIn(f,'codex');await f.until(()=>/^No icons/.test(el('library-status').textContent));
  assert.equal(el('library-status').textContent,'No icons in the curated sets for “codex”.');assert.equal(el('library-results').children.length,0);
  assert.equal(el('library-suggest').hidden,false);assert.equal(el('library-search-all').disabled,false);
  assert.equal(el('library-license-note').hidden,true,'the licence note is for the wider search');assert.equal(el('library-scope-curated').getAttribute('aria-pressed'),'true');assert.deepEqual(requestsOf(host),[{query:'codex',scope:'curated'}]);
  el('library-search-all').emit('click');
  assert.equal(el('library-status').textContent,'Searching…');assert.equal(el('library-search-all').disabled,true);
  await f.until(()=>/found/.test(el('library-status').textContent));
  assert.deepEqual(requestsOf(host).at(-1),{query:'codex',scope:'all'},'the same words are searched again in all sets, without a set filter');
  assert.deepEqual(gridIds(el('library-results')),['logos:codex','devicon:codex','devicon:codex-plain'],'Iconify order, variants of one icon are all kept');
  assert.equal(el('library-status').textContent,'3 icons found. Tap one to save it to My icons.');assert.equal(el('library-dialog-title').textContent,'Results for “codex”');
  assert.equal(el('library-scope-all').getAttribute('aria-pressed'),'true');assert.equal(el('library-scope-curated').getAttribute('aria-pressed'),'false');assert.equal(el('library-dialog-sets').hidden,true,'a set filter only applies to the curated sets');
  assert.equal(el('library-license-note').hidden,false);assert.equal(el('library-suggest').hidden,true);
  const tiles=el('library-results').children;
  assert.deepEqual(tiles.map(node=>node.children.slice(1).map(caption=>caption.textContent)),[['SVG Logos','CC0-1.0'],['Devicon','MIT'],['Devicon','MIT']],'every result shows its set name and licence');
  assert.equal(tiles[0].getAttribute('aria-label'),'SVG Logos · codex · CC0-1.0');assert.deepEqual(tiles.map(node=>node.dataset.own),['true','true','false']);
  assert.match(unpack(tiles[0].children[0].src),/fill="#111"/,'a colored logo keeps its colors in the thumbnail');assert.doesNotMatch(unpack(tiles[0].children[0].src),/EEEFF1/);
  assert.match(unpack(tiles[2].children[0].src),/stroke="#EEEFF1"/,'a single-color icon is drawn light on the dark tile');
  // Back to the curated sets.
  el('library-scope-curated').emit('click');await f.until(()=>/^No icons/.test(el('library-status').textContent));assert.deepEqual(requestsOf(host).at(-1),{query:'codex',scope:'curated'});
  assert.equal(el('library-license-note').hidden,true);assert.equal(el('library-dialog-sets').hidden,false);assert.equal(el('library-suggest').hidden,false);
  // With a curated hit there is nothing to suggest, and the set filter re-runs the search and follows into the panel.
  closeWindow(f);cutIn(f,'house');await f.until(()=>el('library-results').children.length===1);assert.equal(el('library-suggest').hidden,true);
  el('library-dialog-set').value='tabler';el('library-dialog-set').emit('change');await f.until(()=>/^No icons/.test(el('library-status').textContent));
  assert.deepEqual(requestsOf(host).at(-1),{query:'house',scope:'curated',set:'tabler'});assert.equal(el('library-set').value,'tabler');assert.equal(el('library-status').textContent,'No icons in Tabler Icons for “house”.');assert.equal(el('library-suggest').hidden,false);
  el('library-search-all').emit('click');await f.until(()=>/found/.test(el('library-status').textContent));assert.deepEqual(requestsOf(host).at(-1),{query:'house',scope:'all'},'the set filter is not sent with the wider search');
  assert.equal(f.count('configuration/save'),0);
});
test('T32 the "first 12 icon sets" note appears only when the Mac says icons were dropped; a full set count alone proves nothing',async t=>{
  const f=await client(t),{el}=f;
  const twelve=Array.from({length:12},(_,i)=>libIcon(`set${i}`,'a'));
  libraryHost(f,{search:async data=>libReply(data.query==='cut'?{results:twelve,truncated:true}:data.query==='whole'?{results:twelve,truncated:false}:data.query==='silent'?{results:twelve}:
    data.query==='odd'?{results:twelve,truncated:'yes'}:data.query==='curated'?{results:CURATED.map(set=>libIcon(set,'a')),truncated:true}:{results:[],truncated:true})});
  const note=' Only the first 12 icon sets are shown; try a more specific word.',found=count=>`${count} icons found. Tap one to save it to My icons.`;
  const wider=async word=>{cutIn(f,word);await f.until(()=>/^No icons/.test(el('library-status').textContent));el('library-search-all').emit('click');await f.until(()=>/found|any Iconify set/.test(el('library-status').textContent));};
  await openLibrary(f,'primary');online(f);
  await wider('cut');assert.equal(el('library-status').textContent,found(12)+note,'icons were dropped: say so');
  assert.deepEqual(el('library-results').children.map(node=>node.children.slice(1).map(caption=>caption.textContent)[1]),Array(12).fill('Unknown license'),'a set without a licence says so');
  closeWindow(f);await wider('whole');assert.equal(el('library-status').textContent,found(12),'twelve sets and nothing dropped: no note');
  closeWindow(f);await wider('silent');assert.equal(el('library-status').textContent,found(12),'a reply without the flag: no note');
  closeWindow(f);await wider('odd');assert.equal(el('library-status').textContent,found(12),'only true counts');
  // The note belongs to the all-sets search: back in the curated sets there is none, even if the reply claimed it.
  closeWindow(f);cutIn(f,'curated');await f.until(()=>/found/.test(el('library-status').textContent));assert.equal(el('library-status').textContent,found(6),'six curated sets');
  closeWindow(f);cutIn(f,'nothing');await f.until(()=>/^No icons/.test(el('library-status').textContent));el('library-search-all').emit('click');await f.until(()=>/any Iconify set/.test(el('library-status').textContent));
  assert.equal(el('library-status').textContent,'No icons found for “nothing” in any Iconify set. Try another English word.');assert.equal(el('library-suggest').hidden,true,'nothing wider to offer');
});
test('T32 Chinese words are converted on this device: only English reaches the Mac, the title shows both, and an unknown word makes no request',async t=>{
  const f=await client(t),{el}=f,host=libraryHost(f,{found:[libIcon('lucide','house'),libIcon('lucide','camera')]});
  await openLibrary(f,'primary');online(f);
  cutIn(f,'主页');await f.until(()=>/found/.test(el('library-status').textContent));
  assert.deepEqual(requestsOf(host),[{query:'home',scope:'curated'}]);assert.equal(el('library-dialog-title').textContent,'Results for “home” (主页)');
  closeWindow(f);cutIn(f,'  主页   camera ');await f.until(()=>f.count('icon-library/search')===2);assert.deepEqual(requestsOf(host).at(-1),{query:'home camera',scope:'curated'});assert.equal(el('library-dialog-title').textContent,'Results for “home camera” (主页 camera)');
  await f.until(()=>/found|^No/.test(el('library-status').textContent)&&!el('library-search').disabled);closeWindow(f);
  cutIn(f,'网易云音乐');await f.until(()=>f.count('icon-library/search')===3);assert.deepEqual(requestsOf(host).at(-1),{query:'netease',scope:'curated'});await f.until(()=>!el('library-search').disabled);closeWindow(f);
  // English is untouched and the title does not repeat it.
  cutIn(f,'Camera');await f.until(()=>f.count('icon-library/search')===4);assert.deepEqual(requestsOf(host).at(-1),{query:'Camera',scope:'curated'});assert.equal(el('library-dialog-title').textContent,'Results for “Camera”');await f.until(()=>!el('library-search').disabled);closeWindow(f);
  // Nothing known: no request, a clear message and English examples that search when tapped.
  const before=f.count('icon-library/search');
  cutIn(f,'龘龘');assert.equal(f.count('icon-library/search'),before,'no request for words that cannot be converted');
  assert.equal(el('library-dialog').open,true);assert.equal(el('library-status').textContent,'Iconify only understands English keywords.');assert.equal(el('library-dialog-title').textContent,'Results for “龘龘”');
  assert.equal(el('library-examples').hidden,false);assert.deepEqual(el('library-examples').children.map(node=>node.textContent),['home','settings','camera','music','github','wifi']);
  assert.ok(el('library-examples').children.length>=4&&el('library-examples').children.length<=6);assert.equal(el('library-suggest').hidden,true);assert.equal(el('library-results').children.length,0);
  assert.ok(el('library-examples').children.every(node=>node.disabled===false));
  el('library-examples').children[2].emit('click');await f.until(()=>f.count('icon-library/search')===before+1);
  assert.deepEqual(requestsOf(host).at(-1),{query:'camera',scope:'curated'});assert.equal(el('library-dialog-title').textContent,'Results for “camera”');assert.equal(el('library-query').value,'camera');assert.equal(el('library-examples').hidden,true);
  await f.until(()=>/found/.test(el('library-status').textContent));closeWindow(f);
  // A script that is neither English nor Chinese gets the same message; a single leftover letter is just "too short".
  cutIn(f,'привет');assert.equal(el('library-status').textContent,'Iconify only understands English keywords.');assert.equal(f.count('icon-library/search'),before+1);closeWindow(f);
  cutIn(f,'龘 a');assert.equal(el('library-dialog').open,false);assert.match(el('library-message').textContent,/2 to 64 characters/);assert.equal(f.count('icon-library/search'),before+1);
  // Whatever was sent is English: printable ASCII words only.
  for(const data of requestsOf(host))assert.match(data.query,/^[\x20-\x7e]{2,64}$/);
  // Scope buttons with nothing to search do nothing but keep the window consistent.
  cutIn(f,'龘龘');el('library-scope-all').emit('click');assert.equal(f.count('icon-library/search'),before+1);assert.equal(el('library-scope-all').getAttribute('aria-pressed'),'true');
  assert.equal(f.count('configuration/save'),0);
});
test('T32 while the results window is open the draft cannot be saved by shortcut or Enter; Esc and the Close button drop a search in flight',async t=>{
  const f=await client(t),{el}=f,held=deferred();
  const host=libraryHost(f,{search:async data=>{if(data.query==='slow')await held.promise;return libReply({results:[libIcon('lucide','house')]});}});
  await openLibrary(f,'primary');online(f);
  el('button-name').value='Renamed';el('button-name').emit('input');assert.equal(el('desk-save').hidden,false);
  cutIn(f,'slow');assert.equal(el('library-dialog').open,true);
  let prevented=false;f.windowEvents.get('keydown')({metaKey:true,key:'s',preventDefault(){prevented=true;}});await f.drain();
  assert.equal(f.count('configuration/save'),0,'the save shortcut does nothing behind the window');assert.equal(prevented,false);
  let enter=false;el('library-query').emit('keydown',{key:'Enter',preventDefault(){enter=true;}});assert.equal(enter,true,'Enter in the search box never reaches the layout form');await f.drain();assert.equal(f.count('configuration/save'),0);
  // Esc: the browser closes the dialog; the search that was still running is dropped.
  const dialog=el('library-dialog');dialog.emit('cancel');dialog.close();
  assert.equal(dialog.open,false);assert.equal(el('library-search').disabled,false,'the panel is usable again at once');assert.equal(el('library-results').children.length,0);
  held.resolve();await f.drain();await f.drain();assert.equal(el('library-results').children.length,0,'a late answer is not shown');assert.equal(el('library-dialog').open,false,'and does not reopen the window');
  assert.equal(host.requests.filter(request=>request.path.endsWith('/add')).length,0);
  // The next search is not disturbed by the old one.
  cutIn(f,'house');await f.until(()=>el('library-results').children.length===1);assert.equal(el('library-status').textContent,'1 icon found. Tap one to save it to My icons.');
  // Close button while idle; the shortcut works again once the window is gone.
  closeWindow(f);assert.equal(el('library-dialog').open,false);assert.equal(el('library-results').children.length,0,'closing clears the results');
  f.windowEvents.get('keydown')({metaKey:true,key:'s',preventDefault(){}});await f.until(()=>f.count('configuration/save')===1);
  assert.equal(f.count('execute'),0);
});
test('T32 the results window is a modal dialog with large controls, a status line above the grid, and no horizontal overflow rules',()=>{
  const html=readFileSync(new URL('../apps/web/index.html',import.meta.url),'utf8'),css=readFileSync(new URL('../apps/web/style.css',import.meta.url),'utf8'),source=readFileSync(new URL('../apps/web/icon-library.ts',import.meta.url),'utf8');
  const dialog=html.slice(html.indexOf('<dialog id="library-dialog"'),html.indexOf('</dialog>',html.indexOf('<dialog id="library-dialog"')));
  assert.match(dialog,/^<dialog id="library-dialog" class="library-dialog" aria-labelledby="library-dialog-title">/);
  const order=['library-dialog-title','library-dialog-close','library-scope-curated','library-scope-all','library-dialog-set','library-status','library-search-all','library-examples','library-results','library-license-note'].map(id=>dialog.indexOf(`id="${id}"`));
  assert.ok(order.every(index=>index>=0),'every part is in the window');assert.deepEqual([...order].sort((a,b)=>a-b),order,'title and Close, scope, set filter, status line, then the grid');
  assert.doesNotMatch(dialog,/<form|<input/,'nothing in the window can submit a form');
  assert.match(dialog,/<button id="library-dialog-close" class="quiet" type="button" aria-label="Close search results">Close<\/button>/);
  assert.match(dialog,/<button id="library-scope-curated" type="button" aria-pressed="true">Curated sets<\/button><button id="library-scope-all" type="button" aria-pressed="false">All Iconify sets<\/button>/);
  assert.match(dialog,/id="library-search-all" class="solid" type="button">Search all Iconify sets<\/button>/);assert.match(dialog,/Licenses vary by icon set\. Brand logos are trademarks of their owners\./);
  assert.ok(html.indexOf('<dialog id="library-dialog"')>html.indexOf('</main>'),'the dialog sits outside the layout form and the editor');
  assert.equal(html.match(/id="library-results"/g).length,1,'the grid moved from the panel into the window');
  assert.match(css,/\.library-dialog\[open\]\{display:flex;flex-direction:column\}/);assert.match(css,/\.library-dialog::backdrop/);assert.match(css,/#library-dialog-close\{[^}]*min-width:44px;min-height:44px/);
  assert.match(css,/\.library-results\{[^}]*grid-template-columns:repeat\(auto-fill,minmax\(64px,1fr\)\)[^}]*overflow:auto/);assert.match(css,/\.library-results \.library-icon\{[^}]*min-height:92px/);
  assert.match(css,/@media\(max-width:600px\)\{\.library-dialog\{width:calc\(100% - 16px\);height:calc\(100dvh - 16px\)/);assert.match(css,/\.library-icon\[data-own=true\]\{background:#E7E9EE\}/);
  assert.match(css,/\.library-examples \.quiet\{min-height:44px/);assert.match(css,/\.library-suggest \.solid\{width:100%/);
  assert.match(source,/dialog\.showModal\(\)/);assert.doesNotMatch(source,/innerHTML|outerHTML|insertAdjacentHTML|DOMParser|blob:|createObjectURL/);
  assert.match(readFileSync(new URL('../apps/host/server.ts',import.meta.url),'utf8'),/"\/apps\/web\/icon-keywords\.js"/);
  assert.match(html,/id="library-own-colors" class="field-note" hidden>This icon uses its own colors\.<\/p>/);
});

// T33: themes. Compiled handlers with the same fake DOM and Host as above; no rendering, so colors and layout are checked in tests/t33.test.mjs (tokens) and by the screenshots in the T33 record.
const themedDefault=theme=>fromGrid({revision:4,profiles:[{id:'main',name:'My buttons'}],buttons:[{id:'primary',profileId:'main',position:0,label:'Test app',icon:'app',action:{type:'app.open',appId:'test.app'}}]});
const themeOptions=f=>f.el('theme-picker').children;
for(const [theme,words] of Object.entries({braun:['Executing…','Done','Failed'],metro:['Running','Done','Failed'],midnight:['In progress','Arrived · done','Delayed · failed'],standard:['Executing…','Done','Failed'],classic:['Executing…','Done','Failed']}))
  test(`T33 ${theme}: the status carrier of a key reads the state in the theme's words${theme==='classic'?', and the action line shows the state as it always did':', while the action line stays put'}`,async t=>{
    const f=await client(t,{configuration:themedDefault(theme),deviceTheme:theme}),{el}=f,socket=f.sockets[0];await f.until(()=>!f.button().disabled);
    const status=()=>f.button().children[0].children[0].children[0].textContent,action=()=>f.button().children[3].textContent,classic=theme==='classic';
    await f.until(()=>el('html').dataset.theme===theme);assert.equal(status(),'Ready');assert.equal(action(),'Open app');assert.equal(f.button().children[0].children.length,2,'status text and lamp');assert.equal(f.button().children[0].children[1].className,'tile-lamp');
    f.button().emit('click');socket.state({busy:true});socket.push({type:'execution',execution:f.execution('accepted')});socket.push({type:'execution',execution:f.execution('running')});
    assert.equal(f.button().dataset.state,'running');assert.equal(status(),words[0]);assert.equal(action(),classic?'Executing…':'Open app');
    assert.equal(f.button().children[0].children[0].children[0].dataset.short,theme==='midnight'?'Running':undefined,'only Midnight carries a short word for keys under 100px');
    socket.state({busy:false});socket.push({type:'execution',execution:f.execution('succeeded')});f.execute.resolve({execution:f.execution('accepted')});await f.drain();
    assert.equal(f.button().dataset.state,'succeeded');assert.equal(status(),words[1]);assert.equal(action(),classic?'Opened · just now':'Open app');
    await f.fireTimer(2000);assert.equal(f.button().dataset.state,'ready');assert.equal(status(),'Ready');assert.equal(action(),'Open app');
    f.execute=deferred();f.button().emit('click');socket.state({busy:true});socket.push({type:'execution',execution:f.execution('accepted')});socket.push({type:'execution',execution:f.execution('failed',{message:'Fake failure'})});socket.state({busy:false});f.execute.resolve({execution:f.execution('accepted')});await f.drain();
    assert.equal(f.button().dataset.state,'failed');assert.equal(status(),words[2]);assert.equal(action(),classic?'Fake failure':'Open app','only Classic puts the Mac message on the key; the other themes leave it to the result panel');
    assert.equal(el('execution-diagnostics').dataset.status,'failed');assert.match(el('execution-message').textContent,/Fake failure/);
    assert.equal(f.count('execute'),2);
  });
test('T33 fill rules: built-in symbols and text fill the key with its color, App icons and images sit on the dark body, and a custom color is used as chosen',async t=>{
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1EAAAAASUVORK5CYII=';
  const action={type:'app.open',appId:'test.app'},configuration=fromGrid({schemaVersion:4,revision:4,profiles:[{id:'main',name:'Fill'}],buttons:[
    {id:'sym',profileId:'main',position:0,label:'Symbol',icon:'play',color:'green',action},
    {id:'txt',profileId:'main',position:1,label:'Text',icon:'app',action,appearance:{glyph:{type:'text',text:'AI'}}},
    {id:'img',profileId:'main',position:2,label:'Image',icon:'app',action,appearance:{glyph:{type:'image',data:png}}},
    {id:'app',profileId:'main',position:3,label:'App',icon:'app',action},
    {id:'big',profileId:'main',position:4,size:{columns:2,rows:2},label:'Large',icon:'bolt',color:'red',action},
    {id:'ring',profileId:'main',position:6,label:'Outline',icon:'play',color:'blue',action,appearance:{style:'outline'}},
    {id:'plain',profileId:'main',position:7,label:'Plain',icon:'play',color:'orange',action,appearance:{style:'plain'}},
    {id:'dark',profileId:'main',position:10,label:'Dark tint',icon:'play',action,appearance:{tint:'#102030'}},
    {id:'light',profileId:'main',position:11,label:'Light tint',icon:'play',action,appearance:{tint:'#F0E060'}},
  ]});
  const f=await client(t,{configuration}),{el}=f;await f.until(()=>!f.button('sym').disabled);
  const facts=id=>[f.button(id).dataset.glyphKind,f.button(id).dataset.fill];
  assert.deepEqual(facts('sym'),['builtin','solid']);assert.deepEqual(facts('txt'),['text','solid']);assert.deepEqual(facts('img'),['image','body']);assert.deepEqual(facts('app'),['app','body']);
  assert.deepEqual(facts('big'),['builtin','solid']);assert.deepEqual(facts('ring'),['builtin','body']);assert.deepEqual(facts('plain'),['builtin','body']);
  assert.equal(f.button('sym').dataset.color,'green');assert.equal(f.button('ring').dataset.iconStyle,'outline');
  assert.equal(f.button('big').style['--span-c'],'2');assert.equal(f.button('big').style['--span-r'],'2');assert.equal(f.button('sym').style['--span-c'],'1');assert.equal(Number(f.button('big').style['--kw']),2*Number(f.button('sym').style['--kw']),'the large key spans two responsive square cells');
  assert.equal(f.button('dark').style['--fill'],'#102030');assert.equal(f.button('dark').style['--ink'],'#EEEFF1');assert.equal(f.button('dark').style['--tone'],'#102030');assert.ok(f.button('dark').style['--ink-2']);
  assert.equal(f.button('light').style['--fill'],'#F0E060');assert.equal(f.button('light').style['--ink'],'#141414');assert.equal(f.button('sym').style['--fill'],undefined,'palette keys take their colors from the theme');
  assert.equal(f.button('txt').children[1].getAttribute('data-glyph'),'text');assert.equal(f.button('txt').children[1].style['--glyph-chars'],'2');assert.equal(f.button('img').children[1].getAttribute('data-glyph'),'image');
  assert.equal(f.button('sym').children[1].getAttribute('data-symbol'),'play');
  assert.equal(f.count('execute'),0);
});

// T33 fix round: the result readout, busy keys, drawn marks and the page indicator.



// T102: names are one line at the stylesheet's size, so no page-wide label size is ever set, however long a name is.
test('T102 long names never shrink the page: no --page-fs is set',async t=>{
  const observers=[],had=globalThis.ResizeObserver;globalThis.ResizeObserver=class{constructor(callback){observers.push(callback);}observe(){}};
  t.after(()=>{globalThis.ResizeObserver=had;});
  const names=['Screenshot','Supercalifragilistic morning setup','Mute mic'];
  const f=await client(t,{configuration:fromGrid({schemaVersion:2,revision:4,profiles:[{id:'main',name:'Daily'}],buttons:names.map((label,position)=>({id:`k${position}`,profileId:'main',position,label,icon:'app',action:{type:'app.open',appId:'test.app'}}))})});
  await f.until(()=>!f.button('k0').disabled);
  window.getComputedStyle=()=>({fontSize:'12px',columnGap:'0',rowGap:'0',getPropertyValue:()=>'.58'});
  for(const id of ['k0','k1','k2']){const label=f.button(id).children[2];label.getBoundingClientRect=()=>({width:40});}
  const host=f.button('k0'),before=host.children.length;
  observers.forEach(callback=>callback());
  assert.equal(f.el('button-grid').style['--page-fs'],undefined);assert.equal(host.children.length,before,'nothing is measured into the key');
  assert.equal(f.button('k1').children[2].textContent,names[1],'the whole name stays in the label; the stylesheet cuts it with an ellipsis');
  assert.match(f.button('k1').title,/Supercalifragilistic morning setup/,'and the tooltip has it');
});

test('T33 while one key runs the others read busy and are disabled; they recover when it finishes',async t=>{
  const f=await client(t,{configuration:pagesConfig()}),{el}=f,socket=f.sockets[0];await f.until(()=>!f.button('tail').disabled);
  const states=()=>['tail','primary','blank'].map(id=>f.button(id).dataset.state);
  assert.deepEqual(states(),['ready','ready','unconfigured']);
  f.button('tail').emit('click');socket.state({busy:true});socket.push({type:'execution',execution:f.execution('accepted')});socket.push({type:'execution',execution:f.execution('running')});
  assert.deepEqual(states(),['running','busy','unconfigured'],'the running key shows its state; the others that could run read busy');assert.equal(f.button('primary').disabled,true);assert.equal(f.button('primary').children[0].children[0].children[0].textContent,'Mac busy');
  assert.equal(el('html').dataset.theme,'braun');
  socket.state({busy:false});socket.push({type:'execution',execution:f.execution('succeeded')});f.execute.resolve({execution:f.execution('accepted')});await f.drain();
  assert.deepEqual(states(),['succeeded','ready','unconfigured']);assert.equal(f.button('primary').disabled,false);
});
test('T34 the Use|Edit switch is live in both modes: Use is pressed in Use mode, Edit while editing, both stay enabled, and Use in Use mode changes nothing',async t=>{
  const f=await client(t),{el}=f;await f.until(()=>!f.button().disabled);
  const pressed=()=>[el('use-mode').getAttribute('aria-pressed'),el('edit-layout').getAttribute('aria-pressed')];
  assert.equal(el('shell').dataset.editing,'false');assert.deepEqual(pressed(),['true','false'],'Use mode: Use is the current half');
  assert.ok(!el('use-mode').hidden&&!el('edit-layout').hidden,'both halves are shown in Use mode');assert.ok(!el('use-mode').disabled&&!el('edit-layout').disabled);
  el('use-mode').emit('click');assert.equal(el('shell').dataset.editing,'false');assert.deepEqual(pressed(),['true','false'],'Use in Use mode is a no-op');assert.equal(el('editor').hidden,true);
  el('edit-layout').emit('click');assert.equal(el('shell').dataset.editing,'true');assert.deepEqual(pressed(),['false','true'],'Edit mode: Edit is the current half');
  assert.ok(!el('use-mode').hidden&&!el('edit-layout').hidden&&!el('use-mode').disabled,'both halves are still shown and Use works');
  el('edit-layout').emit('click');assert.equal(el('shell').dataset.editing,'true','Edit in Edit mode does not restart the draft');
  el('use-mode').emit('click');assert.equal(el('shell').dataset.editing,'false');assert.deepEqual(pressed(),['true','false'],'back to Use mode with nothing to keep');
  assert.equal(f.count('execute'),0);
});

test('T25 automatic names cover all six targets, respecting the existing label limit',()=>{
  const config={workflows:[{id:'flow',name:'Daily workflow'}]},button=action=>({action});
  const apps=[{id:'app',name:'App name'}],scripts=[{id:'script',name:'Approved script'}],shortcuts=[{id:'shortcut',name:'Mac shortcut'}];
  const cases=[[{type:'app.open',appId:'app'},'App name'],[{type:'window.activate',title:'M90Pro（Local LAN）'},'M90Pro（Local LAN）'],[{type:'keyboard.shortcut',key:'KeyK',modifiers:['command']},'⌘K'],[{type:'shell.run',scriptId:'script'},'Approved script'],[{type:'shortcuts.run',shortcutId:'shortcut'},'Mac shortcut'],[{type:'workflow.run',workflowId:'flow'},'Daily workflow']];
  for(const [action,name]of cases)assert.equal(targetKeyName(button(action),config,apps,scripts,shortcuts),name);
  assert.equal(targetKeyName(button(null),config,apps,scripts,shortcuts),undefined);
  assert.equal(targetKeyName(button({type:'window.activate',title:'A'.repeat(39)+'😀'}),config,[],[],[]),'A'.repeat(39));
});

