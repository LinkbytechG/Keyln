import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Scheduler} from '../dist/apps/host/scheduler.js';
import {tileStatus} from '../dist/apps/web/themes.js';
import {client} from './helpers/client-harness.mjs';
import {randomUUID} from 'node:crypto';
import {parseConfig} from '../dist/packages/contracts/index.js';
import {fromGrid,key,layout} from './helpers/layout.mjs';

// T99 (ADR-089): a Windows App session key whose session is not connected shows Windows App's Connection Center on the Mac instead of only failing.
// The Mac side (native/macos-helper/Windows.swift) is covered by tests/window-target-policy.test.mjs and the T99 Mac check; these tests run the compiled
// page against the small DOM and fake transport. They are not browser rendering or Surface touch evidence.
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const css=read('apps/web/style.css'),swift=read('native/macos-helper/Windows.swift');
const sessionKey=(action={type:'window.activate',appId:'com.microsoft.rdc.macos',title:'T640_Win10（T）',match:'exact'})=>fromGrid({schemaVersion:2,revision:1,profiles:[{id:'main',name:'Main'}],
  buttons:[{id:'primary',profileId:'main',position:0,label:'T640',icon:'app',action}]});
const notConnected='This session is not connected in Windows App. Its Connection Center is open on the Mac; connect the session there. No connection was started.';
async function press(t,configuration,outcome){
  const f=await client(t,{configuration,apps:[{id:'com.microsoft.rdc.macos',name:'Windows App'}]}),{el}=f,socket=f.sockets[0];await f.until(()=>!f.button().disabled);
  f.button().emit('click');socket.state({busy:true});socket.push({type:'execution',execution:f.execution('accepted',{actionType:outcome.actionType})});
  socket.push({type:'execution',execution:f.execution('failed',outcome)});socket.state({busy:false});f.execute.resolve({execution:f.execution('accepted',{actionType:outcome.actionType})});await f.drain();
  return {f,el};
}

test('T99 a session that is not connected is a notice: amber "Not connected" on the key, the result line says so, and Settings stays closed',async t=>{
  const {f,el}=await press(t,sessionKey(),{actionType:'window.activate',code:'SESSION_NOT_CONNECTED',message:notConnected});
  assert.equal(f.button().dataset.state,'notice');
  assert.equal(f.button().children[0].children[0].children[0].textContent,'Not connected');
  assert.equal(el('execution-diagnostics').dataset.status,'notice');
  assert.match(el('execution-message').textContent,/^T640 · Not connected · .*Connection Center is open on the Mac/);
  assert.notEqual(el('connection-settings').open,true,'the Settings menu does not open for a notice');
  assert.notEqual(el('execution-diagnostics').open,true);
  assert.match(f.button().title,/Connection Center is open on the Mac/,'the full message is on the key tooltip');
  await f.fireTimer(2000);assert.equal(f.button().dataset.state,'ready');
});

test('T99 every other window failure is still red (since T100 no failure opens Settings)',async t=>{
  const {f,el}=await press(t,sessionKey(),{actionType:'window.activate',code:'WINDOW_NOT_FOUND',message:'No open window matches this title.'});
  assert.equal(f.button().dataset.state,'failed');assert.equal(el('execution-diagnostics').dataset.status,'failed');
  assert.match(el('execution-message').textContent,/Action failed/);assert.notEqual(el('connection-settings').open,true);assert.equal(el('execution-diagnostics').open,true);
});

test('T99 a workflow stopped by a session that is not connected stays a failed workflow',async t=>{
  const configuration=sessionKey({type:'workflow.run',workflowId:'flow'});
  configuration.workflows=[{id:'flow',name:'Flow',timeoutMs:30000,steps:[{id:'s1',action:{type:'window.activate',appId:'com.microsoft.rdc.macos',title:'T640_Win10（T）',match:'exact'},timeoutMs:10000}]}];
  const {f}=await press(t,configuration,{actionType:'workflow.run',code:'SESSION_NOT_CONNECTED',message:`Step 1 of 1: ${notConnected}`});
  assert.equal(f.button().dataset.state,'failed');
});

test('T99 the Host keeps the helper code: a failed window action with SESSION_NOT_CONNECTED, not unknown',async()=>{
  const rule={type:'window.activate',appId:'com.microsoft.rdc.macos',title:'T640_Win10（T）',match:'exact'},seen=[];
  const scheduler=new Scheduler({run:async action=>{seen.push(action);return {ok:false,code:'SESSION_NOT_CONNECTED',message:notConnected};}});
  const configured=parseConfig(layout([key('primary',rule,{},{label:'T640'})],{revision:1})),input={requestId:randomUUID(),revision:1,componentId:'primary'};
  scheduler.trigger('surface',input,configured);await new Promise(resolve=>setImmediate(resolve));await scheduler.settled();
  const execution=scheduler.get('surface',input.requestId);
  assert.deepEqual(seen,[rule]);assert.equal(execution.status,'failed');assert.equal(execution.code,'SESSION_NOT_CONNECTED');assert.equal(execution.message,notConnected);
});

test('T99 every theme draws the notice without the danger colour',()=>{
  for(const theme of ['braun','metro','midnight','standard','classic','widget']){
    const rules=css.split('\n').filter(line=>line.includes(`[data-theme=${theme}]`)&&line.includes('[data-state=notice]'));
    assert.ok(rules.length,`${theme} has a notice rule`);
    for(const rule of rules.filter(line=>!line.includes('[data-state=failed]')))assert.doesNotMatch(rule,/--danger/,`${theme}: ${rule.slice(0,80)}`);
  }
  assert.equal(tileStatus('braun','notice'),'Not connected');assert.equal(tileStatus('midnight','notice'),'Not connected');
  assert.doesNotMatch(css,/\[data-state=notice\][^{]*\{[^}]*animation/,'a notice does not breathe like a running key');
});

test('T99 the helper only shows the Connection Center for Windows App and never presses a connection command',()=>{
  assert.match(swift,/let windowsAppID = "com\.microsoft\.rdc\.macos"/);
  assert.match(swift,/problem\.code == "APP_NOT_RUNNING" && appID == windowsAppID/);
  assert.match(swift,/problem\.code == "WINDOW_NOT_FOUND" && context\.app\.bundleIdentifier == windowsAppID/);
  assert.match(swift,/command == "K" && modifiers == 1/,'matched by ⇧⌘K, not by its localized title');
  assert.doesNotMatch(swift,/连接中心|Connection Center"/,'no title matching');
  assert.equal((swift.match(/"code": "SESSION_NOT_CONNECTED"/g)||[]).length,2);
  assert.match(swift,/try requireWindowRule\(title: title, match: match\)\n\s+return try launchWindowsApp\(\)/,'an invalid rule launches nothing');
});
