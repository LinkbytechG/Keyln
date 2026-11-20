import test from 'node:test';
import assert from 'node:assert/strict';
import {client} from './helpers/client-harness.mjs';
import {fromGrid} from './helpers/layout.mjs';

// T103 (ADR-092): an unknown result locks every key until it is cleared, and the clear button is in the Settings menu, so the menu opens for it.
// Failures still stay on the key (T100). These tests use the page on the fake transport; they are not browser or Surface evidence.
const safari={type:'window.activate',appId:'com.apple.Safari',title:'Mac_S — Paperclip',match:'exact'};
// T116 (ADR-100): a window or app key whose result is unknown no longer locks the page, so the lock and its menu are shown with a shortcut key.
const shortcut=fromGrid({schemaVersion:2,revision:1,profiles:[{id:'main',name:'Main'}],buttons:[{id:'primary',profileId:'main',position:0,label:'Mac_S',icon:'app',action:{type:'keyboard.shortcut',key:'KeyK',modifiers:['command']}}]});
const configuration=fromGrid({schemaVersion:2,revision:1,profiles:[{id:'main',name:'Main'}],buttons:[{id:'primary',profileId:'main',position:0,label:'Mac_S',icon:'app',action:safari}]});

test('T103 an unknown result opens the Settings menu with the clear button; clearing unlocks the keys',async t=>{
  const f=await client(t,{configuration:shortcut,apps:[{id:'com.apple.Safari',name:'Safari'}]}),{el}=f,socket=f.sockets[0];await f.until(()=>!f.button().disabled);
  const scrolled=[];el('execution-acknowledge').scrollIntoView=options=>scrolled.push(options);
  f.button().emit('click');socket.state({busy:true});socket.push({type:'execution',execution:f.execution('accepted',{actionType:'keyboard.shortcut'})});
  socket.push({type:'execution',execution:f.execution('unknown',{actionType:'keyboard.shortcut',code:'SHORTCUT_UNCONFIRMED',message:'The shortcut was sent, but its delivery could not be confirmed.'})});
  socket.state({busy:false});f.execute.resolve({execution:f.execution('accepted',{actionType:'keyboard.shortcut'})});await f.drain();
  assert.equal(f.button().dataset.state,'unknown');assert.equal(f.button().disabled,true,'keys stay locked');
  assert.equal(el('connection-settings').open,true,'the menu opens');assert.equal(el('execution-acknowledge').hidden,false,'the clear button shows');
  await f.fireTimer(0);assert.deepEqual(scrolled.at(-1),{block:'nearest'},'the menu scrolls to the clear button');
  el('execution-acknowledge').emit('click');await f.drain();
  assert.equal(f.button().disabled,false,'clearing unlocks the keys');assert.match(el('execution-message').textContent,/No action was resent/);
});

test('T103 a failed key still leaves the Settings menu closed',async t=>{
  const f=await client(t,{configuration,apps:[{id:'com.apple.Safari',name:'Safari'}]}),{el}=f,socket=f.sockets[0];await f.until(()=>!f.button().disabled);
  f.button().emit('click');socket.state({busy:true});socket.push({type:'execution',execution:f.execution('accepted',{actionType:'window.activate'})});
  socket.push({type:'execution',execution:f.execution('failed',{actionType:'window.activate',code:'WINDOW_NOT_FOUND',message:'No open window matches.'})});
  socket.state({busy:false});f.execute.resolve({execution:f.execution('accepted',{actionType:'window.activate'})});await f.drain();
  assert.equal(f.button().dataset.state,'failed');assert.notEqual(el('connection-settings').open,true);
});
