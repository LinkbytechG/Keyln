import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {request} from 'node:https';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {Auth,SESSION_MS} from '../dist/apps/host/auth.js';
import {ConfigStore} from '../dist/apps/host/store.js';
import {Scheduler} from '../dist/apps/host/scheduler.js';
import {createHost} from '../dist/apps/host/server.js';
import {MAX_EVENT_CONNECTIONS,MAX_DEVICE_CONNECTIONS} from '../dist/apps/host/events.js';
import {EVENT_PATH,EVENT_PROTOCOL,MAX_EVENT_MESSAGE_BYTES,parseStateEvent,parseHostEvent} from '../dist/packages/contracts/index.js';
import {seedDir,key,withComponents} from './helpers/layout.mjs';
import {saveRequest} from './helpers/save.mjs';

async function fixture(t,{now=Date.now,heartbeatMs,run,timeout=10000}={}) {
  const dir=mkdtempSync(join(tmpdir(),'keyln-events-'));
  execFileSync(process.execPath,['scripts/setup.mjs'],{env:{...process.env,KEYLN_DATA_DIR:dir},stdio:'pipe'});
  seedDir(dir);const auth=new Auth(dir,now),store=new ConfigStore(dir),origin='https://127.0.0.1:0';
  let executions=0;
  const scheduler=new Scheduler({run:async(...args)=>{executions++;return run ? run(...args) : {ok:true,message:'No native action'};}},Date.now,timeout);
  const server=createHost({auth,store,scheduler,origin,eventHeartbeatMs:heartbeatMs,onPair:()=>{},
    apps:[{id:'test.app',name:'Test App'}],tls:{key:readFileSync(join(dir,'tls/server.key')),cert:readFileSync(join(dir,'tls/server.pem'))}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const clients=[];
  t.after(async()=>{
    scheduler.stop(); server.stopEvents(); for(const client of clients) client.ws.terminate();
    await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
    rmSync(dir,{recursive:true,force:true});
  });
  const ca=readFileSync(join(dir,'tls/rootCA.pem')),port=server.address().port;
  function device(name='Test Surface') {
    const pair=auth.begin(auth.invite(),name); auth.approve(pair.id);
    return {id:pair.id,cookie:`__Host-keyln=${auth.claim(pair.id,pair.claim).token}`};
  }
  const paired=device();
  function connect({cookie=paired.cookie,headers={},path=EVENT_PATH,protocols=EVENT_PROTOCOL,autoPong=true}={}) {
    const values={host:'127.0.0.1:0',origin,cookie,...headers};
    for(const key of Object.keys(values)) if(values[key]===undefined) delete values[key];
    const ws=new WebSocket(`wss://127.0.0.1:${port}${path}`,protocols,{ca,servername:'',handshakeTimeout:1500,headers:values,autoPong});
    const queue=[],waiting=[];
    ws.on('message',(data,binary)=>{const frame={data:data.toString(),binary};const reader=waiting.shift();if(reader)reader(frame);else queue.push(frame);});
    const opened=new Promise(resolve=>{
      ws.once('open',()=>resolve(101));
      ws.once('unexpected-response',(req,res)=>{const status=res.statusCode;res.resume();req.destroy();ws.terminate();resolve(status);});
      ws.once('error',()=>resolve(0));
    });
    const closed=new Promise(resolve=>ws.once('close',(code,reason)=>resolve({code,reason:reason.toString()})));
    ws.on('error',()=>{});
    const client={ws,opened,closed,queue,next:()=>{
      if(queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve,reject)=>{
        const reader=frame=>{clearTimeout(timer);resolve(frame);};
        const timer=setTimeout(()=>{waiting.splice(waiting.indexOf(reader),1);reject(new Error('State event timeout'));},1500);
        waiting.push(reader);
      });
    }};
    clients.push(client);return client;
  }
  function send(path,data,cookie=paired.cookie) {
    return new Promise((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',servername:'',port,ca,path,method:'POST',
        headers:{host:'127.0.0.1:0',origin,'content-type':'application/json','x-keyln-client':'1',cookie}},res=>{
        let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(body)}));
      });req.on('error',reject);req.end(JSON.stringify(data));
    });
  }
  // T94: a page-shaped candidate saved the way the page saves it (only the changed parts, with the revisions it was made on).
  const saveView=(candidate,base=store.get())=>send('/api/configuration/save',saveRequest(base,candidate));
  return {auth,store,paired,device,connect,send,saveView,server,scheduler,port,ca,origin,get executions(){return executions;}};
}
test('WSS rejects unpaired, expired, wrong-origin/Host/protocol and token-in-URL upgrades',{timeout:10000},async t=>{
  let now=1000; const f=await fixture(t,{now:()=>now});
  const cases=[
    [{cookie:''},401],
    [{headers:{origin:undefined}},403],
    [{headers:{origin:'https://evil.example'}},403],
    [{headers:{host:'evil.example'}},403],
    [{headers:{'sec-fetch-site':'cross-site'}},403],
    [{protocols:[]},400],
    [{protocols:'unknown'},400],
    [{protocols:'keyln.events.v1'},400],
    [{protocols:[EVENT_PROTOCOL,'extra']},400],
    [{path:`${EVENT_PATH}?token=not-accepted`},404],
    [{path:'/api/admin/events'},404],
  ];
  for(const [options,status] of cases) assert.equal(await f.connect(options).opened,status);
  const pending=f.auth.begin(f.auth.invite(),'Pending');
  assert.equal(await f.connect({cookie:`__Host-keyln=${pending.claim}`}).opened,401);
  now+=SESSION_MS;
  assert.equal(await f.connect().opened,401);
  assert.equal(f.executions,0);
});
test('WSS sends validated state metadata and publishes saved layouts without exposing actions or credentials',{timeout:10000},async t=>{
  const f=await fixture(t),first=f.connect(); assert.equal(await first.opened,101);
  assert.equal(first.ws.protocol,EVENT_PROTOCOL); assert.equal(first.ws.extensions,'');
  const initialFrame=await first.next(),initial=parseStateEvent(JSON.parse(initialFrame.data));
  assert.equal(initialFrame.binary,false);assert.equal(initial.sequence,1);assert.equal(initial.revision,0);
  first.ws.send(JSON.stringify({type:'sync'}));
  assert.equal(parseStateEvent(JSON.parse((await first.next()).data)).sequence,2);
  const changed=await f.saveView(withComponents(f.store.get(),[key('primary',{type:'app.open',appId:'test.app'},{},{label:'Private button label'})]));
  assert.equal(changed.status,200);
  const update=JSON.parse((await first.next()).data);
  assert.deepEqual(Object.keys(update).sort(),['busy','instanceId','layoutRevision','revision','sequence','type','version']);
  assert.equal(update.busy,false);assert.equal(update.version,2);
  assert.equal(update.revision,1);assert.equal(update.layoutRevision,0,'a key edit changes the library only');assert.equal(update.sequence,3);assert.equal(update.instanceId,initial.instanceId);
  assert.ok(!JSON.stringify(update).includes(f.paired.cookie));
  const second=f.connect();assert.equal(await second.opened,101);
  assert.equal(parseStateEvent(JSON.parse((await second.next()).data)).sequence,1);
  const base=f.store.get(),config=structuredClone(base);config.widgets[0].pages[0].name='Updated page';
  assert.equal((await f.saveView(config,base)).status,200);
  // A page rename changes the layout only: the library revision stays, the layout's goes up (T94).
  for(const client of [first,second]){const event=parseStateEvent(JSON.parse((await client.next()).data));assert.equal(event.revision,1);assert.equal(event.layoutRevision,1);}
  assert.equal(f.executions,0);
});
test('revocation closes existing WSS sessions immediately and blocks subsequent HTTPS and WSS access',{timeout:10000},async t=>{
  const f=await fixture(t),revoked=f.connect();assert.equal(await revoked.opened,101);await revoked.next();
  const other=f.device('Other Surface'),active=f.connect({cookie:other.cookie});assert.equal(await active.opened,101);await active.next();
  f.auth.revoke(f.paired.id);
  assert.equal((await revoked.closed).code,4001);
  assert.equal(await f.connect().opened,401);
  assert.equal((await f.send('/api/configuration',{})).status,401);
  active.ws.send(JSON.stringify({type:'sync'}));assert.equal(parseStateEvent(JSON.parse((await active.next()).data)).revision,0);
  assert.equal(f.executions,0);
});
test('an expired established session is closed by the heartbeat without another client request',{timeout:10000},async t=>{
  let now=1000;const f=await fixture(t,{now:()=>now,heartbeatMs:50}),client=f.connect();
  assert.equal(await client.opened,101);await client.next();now+=SESSION_MS;
  assert.equal((await client.closed).code,4001);
});
test('WSS rejects malformed, binary, admin and execution messages and oversized frames',{timeout:10000},async t=>{
  const f=await fixture(t);
  const invalid=['{broken',JSON.stringify({type:'approve',id:'anything'}),JSON.stringify({type:'execute',componentId:'primary'}),
    JSON.stringify({type:'sync',command:'unexpected'}),JSON.stringify({type:'sync',version:1}),Buffer.from('{}')];
  for(const message of invalid) {
    const client=f.connect();assert.equal(await client.opened,101);await client.next();client.ws.send(message);
    assert.equal((await client.closed).code,1008);
  }
  const oversized=f.connect();assert.equal(await oversized.opened,101);await oversized.next();
  oversized.ws.send('x'.repeat(MAX_EVENT_MESSAGE_BYTES+1));assert.equal((await oversized.closed).code,1009);
  assert.equal(f.executions,0);assert.equal(f.store.get().revision,0);
});
test('WSS bounds message rate and per-device/global connection counts',{timeout:10000},async t=>{
  const f=await fixture(t),flood=f.connect();assert.equal(await flood.opened,101);await flood.next();
  for(let n=0;n<6;n++) flood.ws.send(JSON.stringify({type:'sync'}));
  assert.equal((await flood.closed).code,1008);
  for(let n=0;n<MAX_DEVICE_CONNECTIONS;n++) {const client=f.connect();assert.equal(await client.opened,101);await client.next();}
  assert.equal(await f.connect().opened,429);
  for(let n=MAX_DEVICE_CONNECTIONS;n<MAX_EVENT_CONNECTIONS;n+=MAX_DEVICE_CONNECTIONS) {
    const device=f.device(`Surface ${n}`);
    for(let slot=0;slot<MAX_DEVICE_CONNECTIONS;slot++){const client=f.connect({cookie:device.cookie});assert.equal(await client.opened,101);await client.next();}
  }
  const extra=f.device('Over limit');assert.equal(await f.connect({cookie:extra.cookie}).opened,429);
  assert.equal(f.executions,0);
});
test('heartbeat removes unresponsive clients and Host shutdown closes upgraded sockets',{timeout:10000},async t=>{
  const f=await fixture(t,{heartbeatMs:80}),alive=f.connect(),silent=f.connect({autoPong:false});
  assert.equal(await alive.opened,101);await alive.next();assert.equal(await silent.opened,101);await silent.next();
  assert.equal((await silent.closed).code,1006);assert.equal(alive.ws.readyState,WebSocket.OPEN);
  f.server.stopEvents();assert.equal((await alive.closed).code,1006);
});

const frame=async client=>parseHostEvent(JSON.parse((await client.next()).data));
const frames=async(client,count)=>{const values=[];for(let n=0;n<count;n++) values.push(await frame(client));return values;};
const configured=async f=>assert.equal((await f.saveView(withComponents(f.store.get(),[key('primary',{type:'app.open',appId:'test.app'},{},{label:'Test'})]))).status,200);
test('execution events are ordered, private to the owning device, and do not repeat on duplicate or busy requests',{timeout:10000},async t=>{
  let finish;const f=await fixture(t,{run:()=>new Promise(resolve=>{finish=resolve;})});await configured(f);
  const owner=f.connect(),sameDevice=f.connect(),other=f.device('Other device'),outsider=f.connect({cookie:other.cookie});
  for(const client of [owner,sameDevice,outsider]) {assert.equal(await client.opened,101);assert.equal((await frame(client)).busy,false);}
  const input={requestId:randomUUID(),componentId:'primary',revision:1};
  const accepted=await f.send('/api/execute',input);assert.equal(accepted.status,202);
  const first=await frames(owner,4),same=await frames(sameDevice,4),otherFrames=await frames(outsider,2);
  assert.deepEqual(first.map(event=>event.sequence),[2,3,4,5]);
  assert.deepEqual(first.filter(event=>event.type==='execution').map(event=>event.execution.status),['accepted','running']);
  assert.deepEqual(first.filter(event=>event.type==='execution').map(event=>event.execution.id),[accepted.data.execution.id,accepted.data.execution.id]);
  assert.deepEqual(same,first);
  assert.ok(otherFrames.every(event=>event.type==='state'&&event.busy===true));
  assert.ok(!JSON.stringify(otherFrames).includes(input.requestId));
  assert.equal((await f.send('/api/result',{requestId:input.requestId},other.cookie)).status,404);
  assert.equal((await f.send('/api/execute',input)).data.execution.status,'running');
  assert.equal((await f.send('/api/execute',{...input,requestId:randomUUID()},other.cookie)).data.error.code,'BUSY');
  assert.equal(f.executions,1);
  owner.ws.send(JSON.stringify({type:'sync'}));assert.equal((await frame(owner)).sequence,6);
  finish({ok:true,message:'Fake completed'});
  const final=await frames(owner,2);assert.equal(final[0].busy,false);
  assert.equal(final[1].execution.status,'succeeded');assert.ok(Number.isSafeInteger(final[1].execution.finishedAt));
  assert.equal(final[1].execution.id,accepted.data.execution.id);
  await frames(sameDevice,2);assert.equal((await frame(outsider)).busy,false);
  assert.equal((await f.send('/api/execute',input)).data.execution.status,'succeeded');
  assert.equal(f.executions,1);
});
test('disconnection recovers only by querying; reconnect and duplicate input never replay a completed action',{timeout:10000},async t=>{
  let finish;const f=await fixture(t,{run:()=>new Promise(resolve=>{finish=resolve;})});await configured(f);
  const old=f.connect();assert.equal(await old.opened,101);await frame(old);
  const input={requestId:randomUUID(),componentId:'primary',revision:1};
  await f.send('/api/execute',input);await frames(old,4);old.ws.close();await old.closed;
  finish({ok:true,message:'Completed while disconnected'});
  await new Promise(resolve=>setImmediate(resolve));
  const resumed=f.connect();assert.equal(await resumed.opened,101);assert.equal((await frame(resumed)).busy,false);
  assert.equal((await f.send('/api/result',{requestId:input.requestId})).data.execution.status,'succeeded');
  assert.equal((await f.send('/api/execute',input)).data.execution.status,'succeeded');
  resumed.ws.send(JSON.stringify({type:'sync'}));const state=await frame(resumed);
  assert.equal(state.type,'state');assert.equal(state.sequence,2);assert.equal(f.executions,1);
  const restarted=new Scheduler({run:async()=>{throw new Error('Must not execute');}});
  assert.throws(()=>restarted.get(f.paired.id,input.requestId),error=>error.code==='RESULT_UNKNOWN');
});
test('failure and timeout are terminal events, release the execution slot, and ignore late adapter completion',{timeout:10000},async t=>{
  for(const outcome of ['failure','timeout']) {
    let finish;const f=await fixture(t,{timeout:30,run:()=>outcome==='failure'?Promise.resolve({ok:false,code:'ACCESSIBILITY_REQUIRED',message:'No input sent'}):new Promise(resolve=>{finish=resolve;})});
    await configured(f);const client=f.connect();assert.equal(await client.opened,101);await frame(client);
    const input={requestId:randomUUID(),componentId:'primary',revision:1};await f.send('/api/execute',input);
    const events=await frames(client,6),executionEvents=events.filter(event=>event.type==='execution');
    assert.deepEqual(executionEvents.map(event=>event.execution.status),['accepted','running',outcome==='failure'?'failed':'unknown']);
    assert.equal(executionEvents.at(-1).execution.code,outcome==='failure'?'ACCESSIBILITY_REQUIRED':'RESULT_UNKNOWN');
    assert.equal(events.at(-2).busy,false);assert.equal(f.scheduler.busy,false);
    if(finish) {finish({ok:true,message:'Too late'});await new Promise(resolve=>setImmediate(resolve));}
    assert.equal(f.scheduler.get(f.paired.id,input.requestId).status,outcome==='failure'?'failed':'unknown');
    client.ws.send(JSON.stringify({type:'sync'}));assert.equal((await frame(client)).type,'state');
    assert.equal((await f.send('/api/execute',{...input,requestId:randomUUID()})).status,202);
  }
});
test('revoking a running device prevents result delivery and a revocation during HTTP upload prevents dispatch',{timeout:10000},async t=>{
  let finish;const f=await fixture(t,{run:()=>new Promise(resolve=>{finish=resolve;})});await configured(f);
  const owner=f.connect();assert.equal(await owner.opened,101);await frame(owner);
  const other=f.device('Observer'),observer=f.connect({cookie:other.cookie});assert.equal(await observer.opened,101);await frame(observer);
  const input={requestId:randomUUID(),componentId:'primary',revision:1};await f.send('/api/execute',input);await frames(owner,4);await frames(observer,2);
  f.auth.revoke(f.paired.id);assert.equal((await owner.closed).code,4001);
  finish({ok:true,message:'An accepted action is not undone'});
  assert.equal((await frame(observer)).busy,false);
  assert.equal((await f.send('/api/result',{requestId:input.requestId})).status,401);
  assert.equal(f.executions,1);

  const g=await fixture(t);await configured(g);
  const payload=JSON.stringify({...input,requestId:randomUUID()});
  let revokeDuringBody;
  const seen=new Promise(resolve=>{revokeDuringBody=resolve;});
  g.server.once('request',req=>req.once('data',()=>{g.auth.revoke(g.paired.id);revokeDuringBody();}));
  let upload;
  const reply=new Promise((resolve,reject)=>{
    upload=request({hostname:'127.0.0.1',servername:'',port:g.port,ca:g.ca,path:'/api/execute',method:'POST',
      headers:{host:'127.0.0.1:0',origin:g.origin,cookie:g.paired.cookie,'content-type':'application/json','content-length':Buffer.byteLength(payload),'x-keyln-client':'1'}},res=>{
      res.resume();res.once('end',()=>resolve(res.statusCode));
    });upload.on('error',reject);upload.write(payload.slice(0,10));
  });
  await seen;upload.end(payload.slice(10));assert.equal(await reply,401);assert.equal(g.executions,0);
});
test('event contracts reject unsupported versions, malformed completion, secret fields and unbounded output',()=>{
  const execution={id:randomUUID(),requestId:randomUUID(),actionType:'keyboard.shortcut',status:'running',createdAt:1,message:'Fake'};
  const event={type:'execution',version:2,instanceId:randomUUID(),sequence:1,execution};
  assert.deepEqual(parseHostEvent(event),event);
  const bad=[{...event,version:1},{...event,sequence:0},{...event,token:'secret'},
    {...event,execution:{...execution,command:'remote input'}},{...event,execution:{...execution,status:'succeeded'}},
    {...event,execution:{...execution,finishedAt:2}},{...event,execution:{...execution,message:'x'.repeat(301)}},
    {...event,execution:{...execution,id:'wrong'}},{...event,execution:{...execution,status:'failed',finishedAt:2,code:'bad code'}}];
  for(const value of bad) assert.throws(()=>parseHostEvent(value));
});
