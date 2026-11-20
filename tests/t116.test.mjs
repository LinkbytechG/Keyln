import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {client} from './helpers/client-harness.mjs';
import {fromGrid} from './helpers/layout.mjs';

// T116 (ADR-100): bringing an app or a window to the front is safe to repeat. An unknown result of such a key marks only that key (UNKNOWN with the Mac's words, for
// 8 seconds); no key is locked, the Settings menu stays closed and there is nothing to clear. Shortcuts, scripts, Mac shortcuts and workflows keep the ADR-092 lock
// (tests/t103.test.mjs, tests/client.test.mjs). These tests use the page on the fake transport; they are not browser or Surface evidence.
const grid=(action,label='M90Pro')=>fromGrid({schemaVersion:2,revision:1,profiles:[{id:'main',name:'Main'}],buttons:[{id:'primary',profileId:'main',position:0,label,icon:'app',action}]});
const windowKey=grid({type:'window.activate',appId:'com.microsoft.rdc.macos',title:'M90Pro',match:'exact'});
const rdc=[{id:'com.microsoft.rdc.macos',name:'Windows App'}];
const message='Restoring the selected window was requested but could not be confirmed. Check the Mac; nothing will be retried automatically.';
async function pressUnknown(f,actionType){
  const socket=f.sockets[0];f.button().emit('click');socket.state({busy:true});socket.push({type:'execution',execution:f.execution('accepted',{actionType})});
  socket.push({type:'execution',execution:f.execution('unknown',{actionType,code:'WINDOW_FOCUS_UNCONFIRMED',message})});
  socket.state({busy:false});f.execute.resolve({execution:f.execution('accepted',{actionType})});await f.drain();
}

test('T116 a window key whose result is unknown marks only that key: nothing locks, the menu stays closed, and pressing it again sends again',async t=>{
  const f=await client(t,{configuration:windowKey,apps:rdc}),{el}=f;await f.until(()=>!f.button().disabled);
  await pressUnknown(f,'window.activate');
  assert.equal(f.button().dataset.state,'unknown','the key says UNKNOWN');assert.equal(f.button().disabled,false,'but it is not locked');
  assert.notEqual(el('connection-settings').open,true,'the menu does not open');assert.equal(el('execution-acknowledge').hidden,true,'there is nothing to clear');
  assert.equal(el('execution-diagnostics').dataset.status,'notice');assert.match(el('execution-message').textContent,/Not confirmed/);assert.match(el('execution-message').textContent,/could not be confirmed/);
  assert.equal(el('execution-output').textContent,'WINDOW_FOCUS_UNCONFIRMED');
  assert.equal(f.storage.get('keyln.pending-request'),undefined,'no request is kept for a reload to ask about again');
  // The mark goes away by itself.
  await f.fireTimer(8000);assert.equal(f.button().dataset.state,'ready');
  // Pressing it again is a new, ordinary request.
  f.execute=(await import('./helpers/client-harness.mjs')).deferred();f.button().emit('click');assert.equal(f.count('execute'),2);
});

test('T116 an app key whose result was lost (Host restarted) after a reload is not locked, and the menu opened while checking closes again',async t=>{
  const f=await client(t,{initialPending:randomUUID(),autoState:false}),{el}=f;
  f.resultFault=true;f.sockets[0].state({busy:false});await f.until(()=>f.count('result')===1);await f.drain();
  assert.equal(f.button().disabled,false,'the app key is usable again');assert.equal(f.button().dataset.state,'unknown');
  assert.notEqual(el('connection-settings').open,true,'the menu opened for the check is closed');assert.equal(el('execution-acknowledge').hidden,true);
  assert.equal(el('execution-diagnostics').dataset.status,'notice');assert.equal(f.count('execute'),0,'nothing was resent');
});

test('T116 a shortcut key whose result was lost after a reload still locks until it is cleared',async t=>{
  const shortcut=grid({type:'keyboard.shortcut',key:'KeyK',modifiers:['command']},'Send');
  const f=await client(t,{initialPending:randomUUID(),autoState:false,configuration:shortcut}),{el}=f;
  f.resultFault=true;f.sockets[0].state({busy:false});await f.until(()=>f.count('result')===1);await f.drain();
  assert.equal(f.button().disabled,true);assert.equal(el('connection-settings').open,true);assert.equal(el('execution-acknowledge').hidden,false);
});

test('T116 the Mac Dock is not locked by a window key whose result is unknown',async t=>{
  const apps3=[{appId:'com.apple.finder',name:'Finder',active:true,hidden:false},{appId:'com.example.notes',name:'Notes',active:false,hidden:false}];
  const f=await client(t,{configuration:windowKey,apps:rdc,viewport:{width:1366,height:768},dock:true,running:{status:'ready',apps:apps3}}),{el}=f;
  const dock=()=>[...function* walk(node){for(const child of node.children??[]){if(child.className==='mac-dock-item')yield child;yield* walk(child);}}(el('mac-dock'))];
  await f.until(()=>dock().length===2&&!f.button().disabled);
  await pressUnknown(f,'window.activate');
  assert.equal(el('mac-dock').dataset.locked,'none');assert.ok(dock().every(n=>!n.disabled));
  dock()[1].emit('click');await f.until(()=>f.activations.length===1);assert.equal(f.activations[0].appId,'com.example.notes');
});
