import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {request} from 'node:https';
import {randomUUID} from 'node:crypto';
import {parseAction,parseWindows,parseExecution,parseConfig} from '../dist/packages/contracts/index.js';
import {ConfigStore} from '../dist/apps/host/store.js';
import {importPreview} from '../dist/apps/host/layout.js';
import {WorkflowEngine} from '../dist/apps/host/workflow.js';
import {Auth} from '../dist/apps/host/auth.js';
import {Scheduler} from '../dist/apps/host/scheduler.js';
import {createHost} from '../dist/apps/host/server.js';
import {seedDir,primed,withPrimary,components} from './helpers/layout.mjs';
const rule={type:'window.activate',appId:'test.owned',title:'Win11X99',match:'exact'};
const catalog=[{id:rule.appId,name:'Owned app'}];

test('window rules accept literal titles and reject malformed, empty, unbounded or executable selectors',()=>{
 assert.deepEqual(parseAction({...rule,title:'  Win11X99  '}),rule);
 assert.deepEqual(parseAction({...rule,title:'[work].* ${literal}',match:'contains'}),{...rule,title:'[work].* ${literal}',match:'contains'});
 for(const change of [{title:''},{title:'  '},{title:'x'.repeat(257)},{title:'a\nb'},{match:'regex'},{appId:'-inject'},{windowId:12},{script:'activate'}])assert.throws(()=>parseAction({...rule,...change}));
 assert.deepEqual(parseWindows([{title:'One',minimized:true},{title:'One',minimized:false}]),[{title:'One',minimized:true},{title:'One',minimized:false}]);
 for(const value of [[{title:'x',minimized:'yes'}],[{title:'x',minimized:false,pid:1}],Array.from({length:65},()=>({title:'x',minimized:false}))])assert.throws(()=>parseWindows(value));
 const run={id:randomUUID(),requestId:randomUUID(),actionType:'window.activate',status:'succeeded',createdAt:1,finishedAt:2,message:'Focus observed'};assert.deepEqual(parseExecution(run),run);
});

test('window actions round-trip through saved layouts and import without requiring an open window',t=>{
 const directory=mkdtempSync(join(tmpdir(),'keyln-window-store-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 seedDir(directory);const store=new ConfigStore(directory),config=store.get();components(config)[0].action=rule;
 const saved=store.replace(config,catalog);assert.deepEqual(new ConfigStore(directory).get(),saved);assert.equal(saved.version,2);
 assert.deepEqual(importPreview(saved,catalog,()=>{}).issues,[]);
 assert.equal(importPreview(saved,[],()=>{}).issues[0].code,'APP_UNAVAILABLE');
 const unchanged=store.get();components(unchanged)[0].label='Keep unavailable binding';store.replace(unchanged,[]);
 const changed=store.get();components(changed)[0].action.title='New title';assert.throws(()=>store.replace(changed,[]),error=>error.code==='APP_UNAVAILABLE');
 assert.throws(()=>store.replace(store.get(),[],()=>{},true,store.documentStamp()),error=>error.code==='APP_UNAVAILABLE');
});

test('workflow window targets remain bound to subsequent keys and stop on a focus refusal',async()=>{
 const key={type:'keyboard.shortcut',key:'KeyA',modifiers:['command']},config=withPrimary();
 config.workflows=[{id:'windows',name:'Windows',timeoutMs:5000,steps:[rule,key,{type:'app.open',appId:'test.other'},key].map((action,i)=>({id:'s'+i,action,timeoutMs:1000}))}];
 const calls=[];const engine=new WorkflowEngine(async(action,signal,target)=>{calls.push({action,target});return {ok:true,message:'Owned outcome'};});
 const outcome=await engine.run('windows',parseConfig(config),new AbortController().signal);assert.equal(outcome.ok,true);
 assert.deepEqual(calls.map(item=>item.target),[undefined,rule,undefined,'test.other']);
 assert.deepEqual(parseExecution({id:randomUUID(),requestId:randomUUID(),actionType:'workflow.run',status:'succeeded',createdAt:1,finishedAt:Date.now(),message:'Done',workflow:outcome.workflow}).workflow,outcome.workflow);
 const refused=[];const stopped=await new WorkflowEngine(async(action,signal,target)=>{refused.push(target);return target?{ok:false,code:'WINDOW_FOCUS_CHANGED',message:'No keys sent'}:{ok:true,message:'Focused'};}).run('windows',config,new AbortController().signal);
 assert.equal(stopped.code,'WINDOW_FOCUS_CHANGED');assert.equal(refused.length,2);assert.equal(stopped.workflow.steps.length,2);
});

test('window discovery requires live authorization and origin, is read-only, bounded and single-flight',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'keyln-window-http-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 execFileSync(process.execPath,['scripts/setup.mjs'],{env:{...process.env,KEYLN_DATA_DIR:directory},stdio:'pipe'});
 seedDir(directory);const auth=new Auth(directory),store=new ConfigStore(directory),origin='https://127.0.0.1:0';let calls=0,nativeCalls=0,release;
 const scheduler=new Scheduler({run:async()=>{nativeCalls++;return {ok:true,message:'Never called'};}});
 const windows=async id=>{assert.equal(id,rule.appId);calls++;if(release!==undefined)await new Promise(resolve=>release=resolve);return [{title:'Win11X99',minimized:false}];};
 const server=createHost({auth,store,scheduler,origin,apps:catalog,onPair:()=>{},windows,tls:{key:readFileSync(join(directory,'tls/server.key')),cert:readFileSync(join(directory,'tls/server.pem'))}});
 await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
 t.after(async()=>{server.stopEvents();server.closeAllConnections();await new Promise(yes=>server.close(yes));});
 const ca=readFileSync(join(directory,'tls/rootCA.pem')),pending=auth.begin(auth.invite(),'Window fixture');auth.approve(pending.id);const token=auth.claim(pending.id,pending.claim).token,cookie=`__Host-keyln=${token}`;
 const api=(input,headers={})=>new Promise((yes,no)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,ca,path:'/api/windows',method:'POST',headers:{host:'127.0.0.1:0',origin,'x-keyln-client':'1','content-type':'application/json',cookie,...headers}},res=>{let raw='';res.setEncoding('utf8');res.on('data',c=>raw+=c);res.on('end',()=>yes({status:res.statusCode,headers:res.headers,body:JSON.parse(raw)}));});req.on('error',no);req.end(JSON.stringify(input));});
 assert.equal((await api({appId:rule.appId},{cookie:''})).status,401);assert.equal((await api({appId:rule.appId},{origin:'https://wrong.example'})).status,403);assert.equal(calls,0);
 assert.equal((await api({appId:'test.other'})).status,400);assert.equal((await api({appId:rule.appId,all:true})).status,400);assert.equal(calls,0);
 const bytes=readFileSync(join(directory,'config.json')),first=await api({appId:rule.appId});assert.equal(first.status,200);assert.equal(first.headers['cache-control'],'no-store');assert.equal(first.body.windows[0].title,'Win11X99');assert.deepEqual(readFileSync(join(directory,'config.json')),bytes);assert.equal(nativeCalls,0);
 release=true;const slow=api({appId:rule.appId});while(typeof release!=='function')await new Promise(yes=>setImmediate(yes));
 assert.equal((await api({appId:rule.appId})).body.error.code,'BUSY');auth.revoke(auth.list()[0].id);release();assert.equal((await slow).status,401);assert.equal(calls,2);
 assert.equal((await api({appId:rule.appId})).status,401);assert.equal(nativeCalls,0);
});
