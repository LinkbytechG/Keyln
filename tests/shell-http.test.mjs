import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {request} from 'node:https';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {Auth} from '../dist/apps/host/auth.js';
import {LocalAdmin} from '../dist/apps/host/admin.js';
import {ConfigStore} from '../dist/apps/host/store.js';
import {ScriptRegistry} from '../dist/apps/host/scripts.js';
import {actionAdapter} from '../dist/apps/host/shell.js';
import {Scheduler} from '../dist/apps/host/scheduler.js';
import {createHost} from '../dist/apps/host/server.js';
import {EVENT_PATH,EVENT_PROTOCOL,parseHostEvent} from '../dist/packages/contracts/index.js';
import {seedDir,components} from './helpers/layout.mjs';
import {saveRequest} from './helpers/save.mjs';

async function fixture(t,{shortcuts}={}){
  const dir=mkdtempSync(join(tmpdir(),'keyln-shell-http-'));
  execFileSync(process.execPath,['scripts/setup.mjs'],{env:{...process.env,KEYLN_DATA_DIR:dir},stdio:'pipe'});
  seedDir(dir);const auth=new Auth(dir),admin=new LocalAdmin(),store=new ConfigStore(dir),scripts=new ScriptRegistry(dir),adapter=actionAdapter(scripts,shortcuts),logs=[],sockets=[];
  let calls=0;const scheduler=new Scheduler({timeoutMs:adapter.timeoutMs,run:(action,signal,context)=>{calls++;return adapter.run(action,signal,context);}},Date.now,10000,1000,run=>logs.push(JSON.stringify({executionId:run.id,status:run.status,code:run.code})));
  const origin='https://127.0.0.1:0',ca=readFileSync(join(dir,'tls/rootCA.pem'));
  const server=createHost({auth,admin,store,scripts,shortcuts,scheduler,origin,apps:[],onPair:()=>{},tls:{key:readFileSync(join(dir,'tls/server.key')),cert:readFileSync(join(dir,'tls/server.pem'))}});
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  t.after(async()=>{for(const socket of sockets)socket.terminate();scheduler.stop();await scheduler.settled();server.stopEvents();server.closeAllConnections();await new Promise(yes=>server.close(yes));rmSync(dir,{recursive:true,force:true});});
  const connection={hostname:'127.0.0.1',servername:'',port:server.address().port,ca};
  const headers=cookie=>({host:'127.0.0.1:0',origin,'content-type':'application/json','x-keyln-client':'1',cookie});
  function send(path,input={},cookie='',overrides={}){
    return new Promise((yes,no)=>{const req=request({...connection,path,method:'POST',headers:{...headers(cookie),...overrides}},res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>yes({status:res.statusCode,headers:res.headers,body,data:JSON.parse(body)}));});req.on('error',no);req.end(JSON.stringify(input));});
  }
  async function login(){const result=await send('/api/admin/login',{code:admin.invite()});assert.equal(result.status,200);return result.headers['set-cookie'][0].split(';')[0];}
  function device(name){const pair=auth.begin(auth.invite(),name);auth.approve(pair.id);return {id:pair.id,cookie:`__Host-keyln=${auth.claim(pair.id,pair.claim).token}`};}
  function events(cookie){
    const frames=[],socket=new WebSocket(`wss://127.0.0.1:${connection.port}${EVENT_PATH}`,EVENT_PROTOCOL,{ca,servername:'',origin,headers:{cookie,host:'127.0.0.1:0'}});sockets.push(socket);
    socket.on('message',raw=>frames.push(parseHostEvent(JSON.parse(raw.toString()))));socket.on('error',()=>{});return frames;
  }
  async function terminal(device,input){
    const accepted=await send('/api/execute',input,device.cookie);assert.equal(accepted.status,202);
    const deadline=Date.now()+5000;while(Date.now()<deadline){const result=scheduler.get(device.id,input.requestId);if(!['accepted','running'].includes(result.status))return result;await delay(10);}
    throw Error('Owned HTTP Shell test did not finish.');
  }
  // T94: a page-shaped candidate saved the way the page saves it: only the changed part(s), with the revisions it was made on (the stored layout is its base).
  const saveView=(candidate,cookie)=>send('/api/configuration/save',saveRequest(store.get(),candidate),cookie);
  return {dir,auth,admin,store,scripts,scheduler,send,saveView,login,device,events,terminal,connection,headers,logs,get calls(){return calls;}};
}
const definition=(source,extra={})=>({name:'HTTP owned script',kind:'command',source,interpreter:'/bin/sh',parameters:[],timeoutMs:2000,...extra});
async function register(f,cookie,source,extra={}){
  const saved=await f.send('/api/admin/scripts/save',{revision:f.scripts.localState().revision,id:null,definition:definition(source,extra)},cookie);
  assert.equal(saved.status,200);const id=saved.data.id;
  const preview=await f.send('/api/admin/scripts/preview',{id},cookie);assert.equal(preview.status,200);
  const approved=await f.send('/api/admin/scripts/approve',{revision:saved.data.revision,id,version:preview.data.version},cookie);assert.equal(approved.status,200);
  return {type:'shell.run',scriptId:id,version:preview.data.version,args:[]};
}

test('TLS Shell management requires local administrator role; catalog/configuration never publish source or local paths',async t=>{
  const f=await fixture(t),device=f.device('Owned Surface'),cookie=await f.login(),secret='local-script-source-sentinel';
  const input={revision:0,id:null,definition:definition(`# ${secret}\nprintf safe`)};
  assert.equal((await f.send('/api/admin/scripts/save',input,device.cookie)).status,401);
  assert.equal((await f.send('/api/admin/scripts/save',input,cookie,{origin:'https://evil.example'})).status,403);
  assert.equal((await f.send('/api/admin/scripts/save',{...input,approve:true},cookie)).status,400);
  assert.equal((await f.send('/api/scripts',{},cookie)).status,401);
  assert.equal(f.scripts.localState().scripts.length,0);
  const saved=await f.send('/api/admin/scripts/save',input,cookie);assert.equal(saved.status,200);
  assert.deepEqual((await f.send('/api/scripts',{},device.cookie)).data.scripts,[]);
  const preview=await f.send('/api/admin/scripts/preview',{id:saved.data.id},cookie);
  assert.match(preview.data.sourceText,new RegExp(secret));
  assert.equal((await f.send('/api/admin/scripts/approve',{revision:1,id:saved.data.id,version:'0'.repeat(64)},cookie)).data.error.code,'SCRIPT_CHANGED');
  assert.equal((await f.send('/api/admin/scripts/approve',{revision:1,id:saved.data.id,version:preview.data.version},cookie)).status,200);
  for(const path of ['/api/scripts','/api/configuration']){
    const result=await f.send(path,{},device.cookie);assert.equal(result.status,200);assert.doesNotMatch(result.body,new RegExp(`${secret}|sourceText|interpreter|approvedVersion`));
  }
  assert.equal(f.calls,0);
});

test('real Shell execution returns bounded output only to its device, deduplicates, and logs no arguments or output',async t=>{
  const f=await fixture(t),cookie=await f.login(),owner=f.device('Owner'),other=f.device('Other');
  const action=await register(f,cookie,'printf "private-result-sentinel"');
  const config=f.store.get();components(config)[0].action=action;
  assert.equal((await f.saveView(config,owner.cookie)).status,200);
  const ownerEvents=f.events(owner.cookie),otherEvents=f.events(other.cookie);await delay(40);
  const input={requestId:randomUUID(),componentId:'primary',revision:1};
  const result=await f.terminal(owner,input);assert.equal(result.status,'succeeded');assert.equal(result.output.exitCode,0);assert.equal(result.output.stdout,'private-result-sentinel');
  const queried=await f.send('/api/result',{requestId:input.requestId},owner.cookie);assert.equal(queried.data.execution.output.stdout,result.output.stdout);
  assert.equal((await f.send('/api/result',{requestId:input.requestId},other.cookie)).status,404);
  const duplicate=await f.send('/api/execute',input,owner.cookie);assert.equal(duplicate.data.execution.id,result.id);assert.equal(f.calls,1);
  await delay(30);assert.deepEqual(ownerEvents.filter(item=>item.type==='execution').map(item=>item.execution.status),['accepted','running','succeeded']);
  assert.equal(otherEvents.some(item=>item.type==='execution'),false);assert.doesNotMatch(JSON.stringify(otherEvents),/private-result-sentinel|stdout/);
  assert.doesNotMatch(f.logs.join('\n'),/private-result-sentinel|stdout|source|args/);
  assert.equal((await f.send('/api/execute',{...input,requestId:randomUUID(),command:'printf should-not-run'},owner.cookie)).status,400);assert.equal(f.calls,1);
});

test('file changes and revoked approvals produce explicit failures without running the changed script',async t=>{
  const f=await fixture(t),cookie=await f.login(),owner=f.device('Owner'),source=join(f.dir,'owned.sh'),marker=join(f.dir,'must-not-run');
  writeFileSync(source,'printf safe');const action=await register(f,cookie,source,{kind:'file'});
  const config=f.store.get();components(config)[0].action=action;assert.equal((await f.saveView(config,owner.cookie)).status,200);
  writeFileSync(source,`printf unsafe > '${marker}'`);
  assert.deepEqual((await f.send('/api/scripts',{},owner.cookie)).data.scripts,[]);
  let result=await f.terminal(owner,{requestId:randomUUID(),componentId:'primary',revision:1});assert.equal(result.status,'failed');assert.equal(result.code,'SCRIPT_CHANGED');assert.equal(existsSync(marker),false);
  assert.equal((await f.send('/api/admin/scripts/revoke',{revision:f.scripts.localState().revision,id:action.scriptId},cookie)).status,200);
  result=await f.terminal(owner,{requestId:randomUUID(),componentId:'primary',revision:1});assert.equal(result.status,'failed');assert.equal(result.code,'SCRIPT_UNAPPROVED');assert.equal(existsSync(marker),false);
  const changed=f.store.get();components(changed)[0].action={...action,args:['not-approved']};
  assert.equal((await f.saveView(changed,owner.cookie)).status,400);assert.equal(f.store.get().revision,1);
});

test('administrator expiry during a script upload is checked again before registration',async t=>{
  const f=await fixture(t),cookie=await f.login(),body=JSON.stringify({revision:0,id:null,definition:definition('printf safe')});
  let req;const result=new Promise((yes,no)=>{req=request({...f.connection,path:'/api/admin/scripts/save',method:'POST',headers:{...f.headers(cookie),'content-length':Buffer.byteLength(body)}},res=>{let text='';res.on('data',part=>text+=part);res.on('end',()=>yes({status:res.statusCode,data:JSON.parse(text)}));});req.on('error',no);req.write(body.slice(0,30));});
  await delay(20);assert.equal((await f.send('/api/admin/logout',{},cookie)).status,200);req.end(body.slice(30));
  assert.equal((await result).status,401);assert.equal(f.scripts.localState().scripts.length,0);assert.equal(f.calls,0);
});

test('TLS risk confirmation is authenticated, one-use, configuration bound and cancelled when the device socket closes',async t=>{
 const f=await fixture(t),cookie=await f.login(),owner=f.device('Owner'),other=f.device('Other'),action=await register(f,cookie,'printf safe');
 const c=f.store.get();components(c)[0].action=action;components(c)[0].requiresConfirmation=true;assert.equal((await f.saveView(c,owner.cookie)).status,200);
 const input={requestId:randomUUID(),componentId:'primary',revision:1};
 assert.equal((await f.send('/api/execute',input,owner.cookie)).data.error.code,'CONFIRMATION_REQUIRED');assert.equal(f.calls,0);
 assert.equal((await f.send('/api/confirmation',input)).status,401);assert.equal((await f.send('/api/confirmation',input,owner.cookie,{origin:'https://evil.example'})).status,403);
 let challenge=(await f.send('/api/confirmation',input,owner.cookie)).data;assert.equal(challenge.expiresInMs,30000);
 const confirmed={...input,confirmation:challenge.id};assert.equal((await f.send('/api/execute',confirmed,other.cookie)).status,409);assert.equal(f.calls,0);
 const result=await f.terminal(owner,confirmed);assert.equal(result.status,'succeeded');assert.equal((await f.send('/api/execute',confirmed,owner.cookie)).data.execution.id,result.id);assert.equal(f.calls,1);
 assert.equal((await f.send('/api/execute',{...confirmed,requestId:randomUUID()},owner.cookie)).status,409);assert.equal(f.calls,1);
 // A live device event channel closing invalidates a pending prompt before it is consumed.
 const next={...input,requestId:randomUUID()};challenge=(await f.send('/api/confirmation',next,owner.cookie)).data;
 const ws=new WebSocket(`wss://127.0.0.1:${f.connection.port}${EVENT_PATH}`,EVENT_PROTOCOL,{...f.connection,origin:'https://127.0.0.1:0',headers:{cookie:owner.cookie,host:'127.0.0.1:0'}});
 await new Promise((yes,no)=>{ws.once('open',yes);ws.once('error',no);});await new Promise(yes=>{ws.once('close',yes);ws.close();});await delay(20);
 assert.equal((await f.send('/api/execute',{...next,confirmation:challenge.id},owner.cookie)).data.error.code,'CONFIRMATION_REQUIRED');assert.equal(f.calls,1);
 const before=f.store.get();challenge=(await f.send('/api/confirmation',next,owner.cookie)).data;components(before)[0].label='Updated review';await f.saveView(before,owner.cookie);
 assert.equal((await f.send('/api/execute',{...next,confirmation:challenge.id},owner.cookie)).data.error.code,'CONFIG_CONFLICT');assert.equal(f.calls,1);
});

test('TLS workflow runs three real approved Shell steps once, then stops at a failing or timed-out middle step',async t=>{
 const f=await fixture(t),cookie=await f.login(),owner=f.device('Owner'),marker=join(f.dir,'steps.log');
 const first=await register(f,cookie,`printf '1\\n' >> '${marker}'`),second=await register(f,cookie,`printf '2\\n' >> '${marker}'`),third=await register(f,cookie,`printf '3\\n' >> '${marker}'`);
 let c=f.store.get();components(c)[0].action={type:'workflow.run',workflowId:'owned'};c.workflows=[{id:'owned',name:'Real Shell workflow',timeoutMs:4000,steps:[first,second,third].map((action,index)=>({id:`s${index}`,action,timeoutMs:1000}))}];
 assert.equal((await f.saveView(c,owner.cookie)).status,200);
 let input={requestId:randomUUID(),componentId:'primary',revision:1},result=await f.terminal(owner,input);assert.equal(result.status,'succeeded');assert.equal(result.workflow.steps.length,3);assert.equal(readFileSync(marker,'utf8'),'1\n2\n3\n');
 await f.send('/api/execute',input,owner.cookie);assert.equal(readFileSync(marker,'utf8'),'1\n2\n3\n');
 const failure=await register(f,cookie,'exit 7');c=f.store.get();c.workflows[0].steps[1].action=failure;assert.equal((await f.saveView(c,owner.cookie)).status,200);
 result=await f.terminal(owner,{...input,requestId:randomUUID(),revision:2});assert.equal(result.status,'failed');assert.equal(result.workflow.steps.length,2);assert.equal(result.workflow.steps[1].output.exitCode,7);assert.equal(readFileSync(marker,'utf8'),'1\n2\n3\n1\n');
 const slow=await register(f,cookie,`sleep 1; printf late >> '${marker}'`,{timeoutMs:3000});c=f.store.get();c.workflows[0].steps[1]={id:'s1',action:slow,timeoutMs:100};assert.equal((await f.saveView(c,owner.cookie)).status,200);
 result=await f.terminal(owner,{...input,requestId:randomUUID(),revision:3});assert.equal(result.status,'unknown');assert.equal(result.workflow.steps[1].code,'STEP_TIMEOUT');await delay(1100);assert.equal(readFileSync(marker,'utf8'),'1\n2\n3\n1\n1\n');
});

test('TLS Shortcuts catalog is protected and configuration checks stable IDs while preserving existing unavailable bindings',async t=>{
 const id='4FE32199-2549-45B2-B2D7-43BEBA883E06';let entries=[{id,name:'Owned shortcut'}],refreshes=0;
 const shortcuts={state:()=>({shortcuts:entries,shortcutsError:'',shortcutsRefreshing:false}),refresh:async()=>{refreshes++;}};
 const f=await fixture(t,{shortcuts}),owner=f.device('Owner');assert.equal((await f.send('/api/shortcuts/refresh',{})).status,401);
 const state=await f.send('/api/configuration',{},owner.cookie);assert.deepEqual(state.data.shortcuts,entries);
 let c=f.store.get();components(c)[0].action={type:'shortcuts.run',shortcutId:id,timeoutMs:1000};assert.equal((await f.saveView(c,owner.cookie)).status,200);
 entries=[];c=f.store.get();components(c)[0].label='Retained unavailable target';assert.equal((await f.saveView(c,owner.cookie)).status,200);
 c=f.store.get();c.widgets[0].pages[0].widgets.push({...components(c)[0],id:'new'});assert.equal((await f.saveView(c,owner.cookie)).data.error.code,'SHORTCUT_UNAVAILABLE');assert.equal(f.store.get().revision,2);
 assert.equal((await f.send('/api/shortcuts/refresh',{},owner.cookie)).status,200);assert.equal(refreshes,1);assert.equal(f.calls,0);
});
