import test from 'node:test';
import assert from 'node:assert/strict';

// Actual compiled management handlers; controlled DOM/transport, not browser or hardware evidence.
let scenario=0;
async function fixture(t){
  const nodes=new Map(),originals=new Map();
  class Element {
    value='';textContent='';hidden=false;disabled=false;checked=false;dataset={};children=[];listeners=new Map();
    classList={toggle(){}};
    append(...items){this.children.push(...items);} prepend(...items){this.children.unshift(...items);}
    replaceChildren(...items){this.children=[...items];} setAttribute(){}
    addEventListener(type,listener){const list=this.listeners.get(type)||[];list.push(listener);this.listeners.set(type,list);}
    emit(type){const event={preventDefault(){}};this[`on${type}`]?.(event);for(const listener of this.listeners.get(type)||[])listener(event);}
  }
  const el=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const script={id:'owned-script',name:'Owned script',kind:'command',source:'printf safe',interpreter:'/bin/sh',parameters:[],timeoutMs:1000,version:'a'.repeat(64),status:'unapproved'};
  const f={el,script,calls:[],poll:undefined,state:{origin:'https://127.0.0.1:8940',expiresAt:Date.now()+60000,devices:[],pairing:{expiresAt:null,pending:null},scriptRegistry:{revision:3,scripts:[script]},layout:{available:true,reason:'',backup:{available:true,stamp:'a'.repeat(64),revision:2,pages:1,buttons:1,workflows:0,message:'Owned backup'}}}};
  f.until=async condition=>{for(let n=0;n<80&&!condition();n++)await new Promise(resolve=>setImmediate(resolve));assert.ok(condition());};
  f.drain=()=>new Promise(resolve=>setImmediate(resolve));
  const globals={document:{getElementById:el,createElement:()=>new Element(),querySelectorAll:()=>[],hidden:false},Option:class {constructor(text,value){this.text=text;this.value=value;}},
    setInterval:callback=>{f.poll=callback;return 1;},fetch:async(path,options)=>{
      const input=JSON.parse(options.body);f.calls.push({path,input});
      if(path==='/api/admin/state')return {ok:true,json:async()=>structuredClone(f.state)};
      if(path==='/api/admin/scripts/preview')return {ok:true,json:async()=>({id:script.id,revision:f.state.scriptRegistry.revision,version:script.version,sourceText:'printf reviewed',interpreter:'/bin/sh',timeoutMs:1000,parameters:[{name:'Mode',kind:'choice',choices:['safe','preview']}]})};
      if(path==='/api/admin/logout')return {ok:true,json:async()=>({})};
      if(path==='/api/admin/layout/restore'){
        if(f.restoreUnknown)throw new TypeError('Owned connection lost after upload');
        if(input.stamp!==f.state.layout.backup.stamp)return {ok:false,json:async()=>({error:{code:'BACKUP_CHANGED',message:'Changed backup'}})};
        f.state.layout.available=true;f.state.devices=[];f.state.layout.backup.stamp='b'.repeat(64);
        return {ok:true,json:async()=>({restored:true,devicesRevoked:true,revision:4})};
      }
      if(path==='/api/admin/scripts/approve'&&f.succeedApproval&&input.revision===f.state.scriptRegistry.revision){f.state.scriptRegistry.revision++;script.status='approved';return {ok:true,json:async()=>structuredClone(f.state.scriptRegistry)};}
      return {ok:false,json:async()=>({error:f.apiError??{code:'SCRIPT_CONFLICT',message:'Registry changed. Reload before saving.'}})};
    }};
  for(const [key,value]of Object.entries(globals)){originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  t.after(()=>{for(const [key,value]of originals){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
  await import(`../dist/apps/web/admin.js?scenario=${++scenario}`);await f.until(()=>el('admin-message').textContent.includes('Management session restored'));
  return f;
}

test('management script drafts retain their starting revision across polling and conflict without discarding input',async t=>{
  const f=await fixture(t),{el}=f;
  // A new form starts from the existing registry revision, even before clicking New.
  el('script-name').value='New owned script';el('script-source').value='printf local-draft';el('script-name').emit('input');
  f.state.scriptRegistry.revision=4;f.poll();await f.drain();
  el('script-form').emit('submit');await f.until(()=>el('admin-message').textContent.includes('Registry changed'));
  assert.equal(f.calls.find(call=>call.path.endsWith('/scripts/save')).input.revision,3);
  assert.equal(el('script-source').value,'printf local-draft');assert.equal(el('script-name').value,'New owned script');
  el('script-reset').emit('click');assert.equal(el('script-confirm').hidden,false);el('script-confirm-yes').emit('click');
  el('script-name').value='Reloaded draft';el('script-source').value='printf current';el('script-form').emit('submit');
  await f.until(()=>f.calls.filter(call=>call.path.endsWith('/scripts/save')).length===2);
  assert.equal(f.calls.findLast(call=>call.path.endsWith('/scripts/save')).input.revision,4);
});

test('approval shows the reviewed parameter rules and keeps its preview revision; logout clears private source',async t=>{
  const f=await fixture(t),{el}=f;el('script-list').children[0].children.at(-1).children[0].emit('click');
  el('script-preview').emit('click');await f.until(()=>el('script-review').hidden===false);await f.drain();
  assert.equal(el('script-source-preview').textContent,'printf reviewed');assert.match(el('script-rules-preview').textContent,/Mode.*safe \/ preview/);
  f.state.scriptRegistry.revision=4;f.poll();await f.drain();
  el('script-reviewed').checked=true;el('script-reviewed').emit('change');el('script-approve').emit('click');
  await f.until(()=>f.calls.some(call=>call.path.endsWith('/scripts/approve')));
  assert.equal(f.calls.find(call=>call.path.endsWith('/scripts/approve')).input.revision,3);
  await f.until(()=>el('admin-message').textContent.includes('Registry changed'));el('admin-logout').emit('click');
  await f.until(()=>el('admin-dashboard').hidden===true);
  assert.equal(el('script-source').value,'');assert.equal(el('script-source-preview').textContent,'');assert.equal(el('script-rules-preview').textContent,'');assert.equal(el('script-list').children.length,0);
});

test('successful approval reloads the selected definition and revision before the next edit',async t=>{
  const f=await fixture(t),{el}=f;f.succeedApproval=true;
  el('script-list').children[0].children.at(-1).children[0].emit('click');el('script-preview').emit('click');
  await f.until(()=>el('script-review').hidden===false);await f.drain();
  el('script-reviewed').checked=true;el('script-approve').emit('click');
  await f.until(()=>el('script-message').textContent.includes('This version is approved'));await f.drain();
  assert.equal(el('script-review').hidden,true);assert.equal(el('script-source').value,'printf safe');
  el('script-source').value='printf next';el('script-source').emit('input');el('script-form').emit('submit');
  await f.until(()=>f.calls.some(call=>call.path.endsWith('/scripts/save')));
  assert.equal(f.calls.find(call=>call.path.endsWith('/scripts/save')).input.revision,4,'Own approval must advance the newly loaded form, while polling alone cannot advance an old draft');
});

test('backup restore requires checkbox plus confirmation, cancelling is inert and changed reviews cannot be reused',async t=>{
  const f=await fixture(t),{el}=f;
  el('backup-restore').emit('click');assert.equal(el('backup-confirm').hidden,false);assert.equal(el('backup-confirm-yes').disabled,true);
  el('backup-confirm-yes').emit('click');el('backup-confirm-no').emit('click');assert.equal(f.calls.some(c=>c.path.endsWith('/layout/restore')),false);
  el('backup-restore').emit('click');el('backup-understood').checked=true;el('backup-understood').emit('change');
  f.state.layout.backup.stamp='c'.repeat(64);f.poll();await f.drain();assert.equal(el('backup-confirm').hidden,true);assert.equal(el('backup-understood').checked,false);
  el('backup-confirm-yes').emit('click');assert.equal(f.calls.some(c=>c.path.endsWith('/layout/restore')),false);
  el('backup-restore').emit('click');el('backup-understood').checked=true;el('backup-confirm-yes').emit('click');await f.until(()=>el('admin-message').textContent.includes('Layout recovery complete'));await f.drain();
  const calls=f.calls.filter(c=>c.path.endsWith('/layout/restore'));assert.equal(calls.length,1);assert.deepEqual(calls[0].input,{stamp:'c'.repeat(64),confirm:true});assert.match(el('backup-message').textContent,/All control devices were revoked/);
  el('admin-logout').emit('click');await f.until(()=>el('admin-dashboard').hidden);assert.equal(el('backup-review').textContent,'');assert.equal(el('backup-state').textContent,'');assert.equal(el('backup-message').textContent,'');
});

test('uncertain restore response blocks repeat writes until explicit status review; damaged mode exposes recovery',async t=>{
  const f=await fixture(t),{el}=f;f.state.layout.available=false;f.poll();await f.drain();assert.equal(el('pairing-management').hidden,true);assert.equal(el('scripts-management').hidden,true);assert.match(el('layout-recovery-reason').textContent,/were not reset/);
  f.restoreUnknown=true;el('backup-restore').emit('click');el('backup-understood').checked=true;el('backup-confirm-yes').emit('click');await f.until(()=>el('backup-message').textContent.includes('Do not repeat it'));await f.drain();
  assert.equal(el('backup-restore').disabled,true);el('backup-restore').emit('click');el('backup-confirm-yes').emit('click');assert.equal(f.calls.filter(c=>c.path.endsWith('/layout/restore')).length,1);
  f.poll();await f.drain();assert.equal(el('backup-restore').disabled,true,'Polling alone must not enable another write.');
  el('backup-refresh').emit('click');await f.until(()=>el('backup-message').textContent.includes('Mac state reloaded'));await f.drain();assert.equal(el('backup-restore').disabled,false);
});

test('T28 management translates legacy Host errors while preserving user device names',async t=>{
 const f=await fixture(t),{el}=f;f.state.devices=[{id:'owned-device',name:'Surface 用户',expiresAt:Date.now()+10000}];f.poll();await f.drain();
 f.apiError={code:'DEVICE_NOT_FOUND',message:'设备已撤销或授权已过期，请刷新列表。'};
 const action=()=>el('admin-devices').children[0].children.at(-1).children[0];action().emit('click');action().emit('click');
 await f.until(()=>el('admin-message').textContent.includes('This device was revoked or expired'));
 assert.equal(el('admin-devices').children[0].children[0].textContent,'Surface 用户');assert.equal(f.calls.filter(c=>c.path.endsWith('/revoke')).length,1);
});
