import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {request} from 'node:https';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {Auth} from '../dist/apps/host/auth.js';
import {LocalAdmin} from '../dist/apps/host/admin.js';
import {ConfigStore} from '../dist/apps/host/store.js';
import {ScriptRegistry} from '../dist/apps/host/scripts.js';
import {Scheduler} from '../dist/apps/host/scheduler.js';
import {createHost} from '../dist/apps/host/server.js';
import {seedDir,components} from './helpers/layout.mjs';
import {viewFor} from '../dist/packages/contracts/index.js';

async function fixture(t,{damaged=false,run}={}){
 const dir=mkdtempSync(join(tmpdir(),'keyln-layout-http-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 execFileSync(process.execPath,['scripts/setup.mjs'],{env:{...process.env,KEYLN_DATA_DIR:dir},stdio:'pipe'});
 seedDir(dir);const original=new ConfigStore(dir);{const next=original.get();next.widgets[0].pages[0].name='Current layout';original.replace(next,[]);}
 if(damaged)writeFileSync(original.path,'{"broken":');
 const auth=new Auth(dir),admin=new LocalAdmin(),store=new ConfigStore(dir,true),scripts=new ScriptRegistry(dir);
 let calls=0;const scheduler=new Scheduler({run:async(...args)=>{calls++;return run?await run(...args):{ok:true,message:'Fake only'};}});
 const origin='https://127.0.0.1:0',ca=readFileSync(join(dir,'tls/rootCA.pem'));
 const server=createHost({auth,admin,store,scripts,scheduler,origin,apps:[{id:'local.keyln.owned',name:'Owned app'}],onPair:()=>{},tls:{key:readFileSync(join(dir,'tls/server.key')),cert:readFileSync(join(dir,'tls/server.pem'))}});
 await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
 const sockets=[];
 t.after(async()=>{for(const socket of sockets)socket.terminate();scheduler.stop();await scheduler.settled();server.stopEvents();server.closeAllConnections();await new Promise(yes=>server.close(yes));});
 const connection={hostname:'127.0.0.1',servername:'',port:server.address().port,ca};
 const headers=cookie=>({host:'127.0.0.1:0',origin,'content-type':'application/json','x-keyln-client':'1',cookie});
 function send(path,input={},cookie='',overrides={}){return new Promise((yes,no)=>{
  const req=request({...connection,path,method:'POST',headers:{...headers(cookie),...overrides}},res=>{let body='';res.setEncoding('utf8');res.on('data',part=>body+=part);res.on('end',()=>yes({status:res.statusCode,headers:res.headers,body,data:JSON.parse(body)}));});req.on('error',no);req.end(Buffer.isBuffer(input)?input:JSON.stringify(input));
 });}
 async function login(){const response=await send('/api/admin/login',{code:admin.invite()});assert.equal(response.status,200);return response.headers['set-cookie'][0].split(';')[0];}
 function device(name='Owned Surface'){const p=auth.begin(auth.invite(),name);auth.approve(p.id);return {id:p.id,cookie:`__Host-keyln=${auth.claim(p.id,p.claim).token}`};}
 function socket(cookie){const ws=new WebSocket(`wss://127.0.0.1:${connection.port}/api/events`,'keyln.events.v3',{ca,servername:'',origin,headers:{host:'127.0.0.1:0',cookie}});sockets.push(ws);return ws;}
 return {dir,store,auth,admin,scripts,scheduler,server,send,login,device,socket,connection,headers,get calls(){return calls;}};
}

test('TLS layout export and import are protected, complete, revision-bound and never execute actions',async t=>{
 const f=await fixture(t),d=f.device(),admin=await f.login(),before=readFileSync(f.store.path);
 for(const path of ['export','preview','import']){
  assert.equal((await f.send(`/api/configuration/${path}`)).status,401);
  assert.equal((await f.send(`/api/configuration/${path}`,{},admin)).status,401);
  assert.equal((await f.send(`/api/configuration/${path}`,{},d.cookie,{origin:'https://evil.example'})).status,403);
 }
 let c=f.store.get();c.widgets[0].pages.push({id:'other',name:'Second page',widgets:[]});components(c)[0].action={type:'workflow.run',workflowId:'flow'};components(c)[0].requiresConfirmation=true;
 c.workflows=[{id:'flow',name:'Round trip',timeoutMs:4000,requiresConfirmation:true,steps:[{id:'app',action:{type:'app.open',appId:'local.keyln.owned'},timeoutMs:1000},{id:'key',action:{type:'keyboard.shortcut',key:'KeyA',modifiers:['command']},timeoutMs:1000}]}];
 const preview=await f.send('/api/configuration/preview',{...c,revision:900},d.cookie);assert.equal(preview.status,200);assert.equal(preview.data.revision,c.revision);assert.equal(preview.data.config.version,3,'the reviewed document is v3');assert.equal(preview.data.config.library.revision,900);assert.equal(preview.data.view.revision,900);assert.equal(preview.data.layoutName,'Surface');assert.deepEqual(preview.data.issues,[]);assert.deepEqual(readFileSync(f.store.path),before);
 assert.equal((await f.send('/api/configuration/import',{config:preview.data.config,stamp:preview.data.stamp},d.cookie)).data.error.code,'CONFIG_CONFLICT');
 const imported=await f.send('/api/configuration/import',{config:c,stamp:preview.data.stamp},d.cookie);assert.equal(imported.status,200);assert.deepEqual(imported.data.config,{...c,revision:c.revision+1,layoutRevision:c.layoutRevision+1});
 const exported=await f.send('/api/configuration/export',{},d.cookie);assert.equal(exported.data.config.version,3);assert.deepEqual(viewFor(exported.data.config,'Surface'),imported.data.config);assert.deepEqual(exported.data.config,f.store.document());assert.doesNotMatch(exported.body,/tokenHash|privateKey|sourceText|interpreter|executionId/);
 const unchanged=readFileSync(f.store.path);
 for(const bad of [{...c,version:99},{...c,devices:[]},{...c,widgets:[{...c.widgets[0],pages:[{...c.widgets[0].pages[0],widgets:[components(c)[0],components(c)[0]]}]}]},{...c,workflows:[]},{...c,canvas:{cols:1,rows:1}}]){
  assert.equal((await f.send('/api/configuration/preview',bad,d.cookie)).status,400);assert.equal((await f.send('/api/configuration/import',{config:bad,stamp:f.store.documentStamp()},d.cookie)).status,400);assert.deepEqual(readFileSync(f.store.path),unchanged);
 }
 assert.equal((await f.send('/api/configuration/export',{includeSecrets:true},d.cookie)).status,400);
 const invalid=Buffer.concat([Buffer.from('{"format":"keyln.config","x":"'),Buffer.from([255]),Buffer.from('"}')]);assert.equal((await f.send('/api/configuration/preview',invalid,d.cookie)).data.error.code,'INVALID_JSON');
 assert.equal(f.calls,0);
});

test('T109 R2 TLS import requires the reviewed whole-document stamp and rejects another layout changing',async t=>{
 const f=await fixture(t),d=f.device(),doc=f.store.document();doc.layouts.push({...structuredClone(doc.layouts[0]),name:'Phone'});
 f.store.importDocument(doc,f.store.documentStamp(),[]);
 const candidate=f.store.document(),review=(await f.send('/api/configuration/preview',candidate,d.cookie)).data;
 assert.match(review.stamp,/^[a-f0-9]{64}$/);const visible=f.store.get();
 f.store.setTheme('Phone','metro');assert.deepEqual(f.store.get(),visible,'the calling device layout and library did not change');
 const before=readFileSync(f.store.path);
 assert.equal((await f.send('/api/configuration/import',{config:candidate,stamp:review.stamp},d.cookie)).data.error.code,'CONFIG_CONFLICT');
 assert.equal((await f.send('/api/configuration/import',candidate,d.cookie)).data.error.code,'CONFIG_VERSION');
 assert.equal((await f.send('/api/configuration/import',{config:candidate},d.cookie)).data.error.code,'INVALID_INPUT');
 assert.deepEqual(readFileSync(f.store.path),before);
 const fresh=(await f.send('/api/configuration/preview',candidate,d.cookie)).data;
 assert.equal((await f.send('/api/configuration/import',{config:candidate,stamp:fresh.stamp},d.cookie)).status,200);assert.equal(f.calls,0);
});

test('old-format files are refused outright and missing/revoked Shell versions must be rebound without importing approval',async t=>{
 const f=await fixture(t),d=f.device();
 const saved=f.scripts.save({revision:0,id:null,definition:{name:'Owned source',kind:'command',source:'printf source-must-stay-local',interpreter:'/bin/sh',parameters:[],timeoutMs:1000}}),review=f.scripts.preview({id:saved.id});
 f.scripts.approve({revision:saved.revision,id:saved.id,version:review.version});
 const action={type:'shell.run',scriptId:saved.id,version:review.version,args:[]},c=f.store.get();components(c)[0].action=action;
 assert.equal((await f.send('/api/configuration/import',{config:c,stamp:f.store.documentStamp()},d.cookie)).status,200);
 const exported=await f.send('/api/configuration/export',{},d.cookie);assert.doesNotMatch(exported.body,/source-must-stay-local|approvedVersion|interpreter/);
 f.scripts.revoke({revision:f.scripts.localState().revision,id:saved.id});const registry=JSON.stringify(f.scripts.localState()),bytes=readFileSync(f.store.path);
 const preview=await f.send('/api/configuration/preview',f.store.get(),d.cookie);assert.equal(preview.status,200);assert.equal(preview.data.issues.length,1);assert.match(preview.data.issues[0].message,/never registers or approves/);
 assert.equal((await f.send('/api/configuration/import',{config:f.store.get(),stamp:f.store.documentStamp()},d.cookie)).status,400);assert.deepEqual(readFileSync(f.store.path),bytes);assert.equal(JSON.stringify(f.scripts.localState()),registry);
 const legacy={schemaVersion:1,revision:0,button:{id:'primary',label:'Old layout',icon:'app',action:null}};
 for(const old of [legacy,{schemaVersion:10,revision:f.store.get().revision,profiles:[],buttons:[]}]){
  assert.equal((await f.send('/api/configuration/preview',old,d.cookie)).data.error.code,'CONFIG_VERSION');
  assert.equal((await f.send('/api/configuration/import',{config:old,stamp:f.store.documentStamp()},d.cookie)).data.error.code,'CONFIG_VERSION');
 }
 assert.equal(f.calls,0);
});

test('TLS import rechecks authorization after upload and both import and restore reject a running action',async t=>{
 let release;const f=await fixture(t,{run:()=>new Promise(yes=>release=yes)}),d=f.device(),admin=await f.login();
 const body=JSON.stringify(f.store.get());let upload;const started=new Promise(yes=>f.server.once('request',yes));
 const late=new Promise((yes,no)=>{upload=request({...f.connection,path:'/api/configuration/import',method:'POST',headers:{...f.headers(d.cookie),'content-length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>yes(res.statusCode));});upload.on('error',no);upload.write(body.slice(0,20));});
 await started;f.auth.revoke(d.id);upload.end(body.slice(20));assert.equal(await late,401);
 const other=f.device('Other');let c=f.store.get();components(c)[0].action={type:'app.open',appId:'local.keyln.owned'};f.store.replace(c,[{id:'local.keyln.owned',name:'Owned'}]);
 const active=f.store.get();f.scheduler.trigger(other.id,{requestId:randomUUID(),componentId:'primary',revision:active.revision},active);
 try{
  assert.equal((await f.send('/api/configuration/import',active,other.cookie)).data.error.code,'BUSY');
  const backup=f.store.backupState();assert.equal((await f.send('/api/admin/layout/restore',{stamp:backup.stamp,confirm:true},admin)).data.error.code,'BUSY');assert.ok(f.auth.authenticate(other.cookie));
 }finally{release({ok:true,message:'Owned fake completed'});await f.scheduler.settled();}
 assert.equal(f.calls,1);
});

test('TLS local restore requires reviewed files and explicit confirmation, closes every old control session, and keeps admin login',async t=>{
 const f=await fixture(t),d=f.device(),other=f.device('Other'),admin=await f.login(),backup=JSON.parse(readFileSync(f.store.backup));
 for(const path of ['backup','restore'])assert.equal((await f.send(`/api/admin/layout/${path}`,{},d.cookie)).status,401);
 const state=(await f.send('/api/admin/state',{},admin)).data;assert.equal(state.layout.backup.available,true);
 assert.equal((await f.send('/api/admin/layout/backup',{},admin)).data.config.layouts[0].widgets[0].pages[0].name,backup.layouts[0].widgets[0].pages[0].name);
 for(const input of [{stamp:state.layout.backup.stamp,confirm:false},{stamp:'stale',confirm:true},{stamp:state.layout.backup.stamp,confirm:true,devices:[]}])assert.equal((await f.send('/api/admin/layout/restore',input,admin)).status>=400,true);
 assert.ok(f.auth.authenticate(d.cookie));
 const ws=f.socket(d.cookie);await new Promise((yes,no)=>{ws.once('open',yes);ws.once('error',no);});const closed=new Promise(yes=>ws.once('close',yes));
 const pending=f.auth.begin(f.auth.invite(),'Pending');const revision=f.store.get().revision;
 const restored=await f.send('/api/admin/layout/restore',{stamp:state.layout.backup.stamp,confirm:true},admin);assert.equal(restored.status,200);assert.equal(restored.data.revision,revision+1);assert.equal(await closed,4001);
 const layoutRevision=f.store.layoutRevision();
 assert.deepEqual(f.store.get(),{...viewFor(backup,'Surface'),revision:revision+1,layoutRevision});assert.equal(layoutRevision,2,'every revision moves past the one the Host held (library 0 to 1, layout 1 to 2)');assert.deepEqual(JSON.parse(readFileSync(f.store.backup)),backup);
 for(const cookie of [d.cookie,other.cookie])assert.equal((await f.send('/api/configuration',{},cookie)).status,401);
 assert.throws(()=>f.auth.claim(pending.id,pending.claim));assert.equal((await f.send('/api/admin/state',{},admin)).status,200);assert.equal(new Auth(f.dir).list().length,0);assert.equal(f.calls,0);
});

test('TLS damaged-layout mode serves local recovery while refusing pairing, control and WSS; restore never silently resets',async t=>{
 const f=await fixture(t,{damaged:true}),d=f.device(),admin=await f.login(),broken=readFileSync(f.store.path);
 for(const path of ['/api/configuration','/api/configuration/import','/api/execute','/api/pair','/api/pair/status'])assert.equal((await f.send(path,{},d.cookie)).data.error.code,'CONFIG_DAMAGED');
 assert.equal((await f.send('/api/admin/invite',{},admin)).status,503);
 const ws=f.socket(d.cookie);const rejected=await new Promise((yes,no)=>{ws.once('unexpected-response',(_,res)=>{res.resume();yes(res.statusCode);});ws.once('open',()=>no(Error('Recovery must not open WSS.')));ws.on('error',()=>{});});assert.equal(rejected,503);
 const state=(await f.send('/api/admin/state',{},admin)).data;assert.equal(state.layout.available,false);assert.deepEqual(readFileSync(f.store.path),broken);
 assert.equal((await f.send('/api/admin/layout/restore',{stamp:state.layout.backup.stamp,confirm:true},admin)).status,200);assert.equal(f.store.available,true);
 assert.equal((await f.send('/api/configuration',{},d.cookie)).status,401);const newDevice=f.device('After recovery');assert.equal((await f.send('/api/configuration',{},newDevice.cookie)).status,200);assert.equal(f.calls,0);
});

test('production Host boots damaged layout into recovery, restores without restarting and revokes persisted control sessions', {timeout:20000},async t=>{
 const f=await fixture(t,{damaged:true}),d=f.device();await new Promise(yes=>{f.server.stopEvents();f.server.closeAllConnections();f.server.close(yes);});
 const origin=`https://127.0.0.1:${f.connection.port}`;writeFileSync(join(f.dir,'host.json'),JSON.stringify({schemaVersion:1,address:'127.0.0.1',port:f.connection.port,origin}));
 const child=spawn(process.execPath,['dist/apps/host/main.js'],{env:{...process.env,KEYLN_DATA_DIR:f.dir},stdio:['pipe','pipe','pipe']});child.stdin.on('error',()=>{});child.stderr.resume();
 const closed=new Promise(yes=>child.once('close',yes));
 const ready=new Promise((yes,no)=>{let output='';const timer=setTimeout(()=>no(Error('Owned recovery startup timed out.')),12000);child.stdout.on('data',part=>{output+=part;const match=output.match(/Mac management login code: ([0-9]{8}) /);if(match){clearTimeout(timer);yes(match[1]);output='';}if(output.length>8192){clearTimeout(timer);no(Error('Unexpected startup output.'));}});child.once('error',()=>{clearTimeout(timer);no(Error('Owned recovery startup failed.'));});child.once('close',()=>{clearTimeout(timer);no(Error('Owned recovery exited before ready.'));});});
 const send=(path,input={},cookie='')=>f.send(path,input,cookie,{host:`127.0.0.1:${f.connection.port}`,origin});
 try{
  const login=await send('/api/admin/login',{code:await ready}),cookie=login.headers['set-cookie'][0].split(';')[0];assert.equal(login.status,200);
  assert.equal((await send('/api/configuration',{},d.cookie)).status,503);const state=(await send('/api/admin/state',{},cookie)).data;assert.equal(state.layout.available,false);
  assert.equal((await send('/api/admin/layout/restore',{stamp:state.layout.backup.stamp,confirm:true},cookie)).status,200);
  assert.equal((await send('/api/configuration',{},d.cookie)).status,401);assert.equal((await send('/api/admin/state',{},cookie)).data.layout.available,true);
  assert.equal((await send('/api/admin/invite',{},cookie)).status,200);assert.equal(new Auth(f.dir).list().length,0);
 }finally{child.stdin.end('quit\n');let timer;const code=await Promise.race([closed,new Promise(yes=>timer=setTimeout(()=>{child.kill('SIGKILL');yes(null);},4000))]);clearTimeout(timer);if(code===null)await closed;assert.equal(code,0);assert.equal(existsSync(join(f.dir,'host.lock')),false);}
});
