import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,mkdirSync,statSync,existsSync} from 'node:fs';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {request} from 'node:https';
import * as C from '../dist/packages/contracts/index.js';
import * as Q from '../dist/packages/contracts/subscription.js';
import {codexQuota,codexWindows,claudeUsage,claudeWindows,CLAUDE_USAGE_ARGS,collectSubscription,SubscriptionUsage,QUOTA_REFRESH_MS} from '../dist/apps/host/subscriptions.js';
import {captureStatus} from '../dist/apps/host/claude-statusline.js';
import {configureClaudeBridge} from '../scripts/subscriptions.mjs';
import {codexUsageWidget,resetText,remainingText} from '../dist/apps/web/widgets/subscription.js';
import {initialDeskState} from '../dist/apps/web/widgets/state.js';
import {createSubscriptionClient} from '../dist/apps/web/subscription-client.js';
import {installDom,Element} from './helpers/widget-dom.mjs';
import {client,deferred} from './helpers/client-harness.mjs';
import {ConfigStore} from '../dist/apps/host/store.js';
import {Auth} from '../dist/apps/host/auth.js';
import {Scheduler} from '../dist/apps/host/scheduler.js';
import {createHost} from '../dist/apps/host/server.js';

const temporary=t=>{const dir=mkdtempSync(join(tmpdir(),'keyln-t112-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
const usage=(provider='codex',at=Date.now())=>({provider,status:'ready',windows:[{id:'short',label:'5-hour',usedPercent:28,windowMinutes:300,resetsAt:at+120000}],updatedAt:at,checkedAt:at,source:provider==='codex'?'codex-app-server':'claude-statusline'});
const display=(kind='codex-usage',size='L')=>({id:'usage',kind,form:'quota',size});
const view=widgets=>({...C.initialView(),widgets});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const auth={loggedIn:true,authMethod:'claude.ai',subscriptionType:'max',email:'fixture@example.invalid'};
const payload={session_id:'fixture-session',prompt_id:'fixture-response',cost:{total_api_duration_ms:123},rate_limits:{five_hour:{used_percentage:23.5,resets_at:1900000000},seven_day:{used_percentage:41.2,resets_at:1900300000}}};

test('T112 layout/store/import round trip only placements, rejects unsupported sizes and runtime quota fields',t=>{
 const dir=temporary(t),store=new ConfigStore(dir),target=new ConfigStore(join(dir,'import'));
 for(const kind of Q.subscriptionKinds)for(const size of ['M','L']){
  const w=display(kind,size),input={...store.get(),widgets:[w]};assert.deepEqual(C.parseConfig(input).widgets,[w]);
  const saved=store.replace(input,[]);assert.deepEqual(saved.widgets,[w]);assert.deepEqual(new ConfigStore(dir).get().widgets,[w]);
  const exported=JSON.parse(JSON.stringify(store.document()));exported.library.revision=target.revision;target.importDocument(exported,target.documentStamp(),[]);assert.deepEqual(target.get().widgets,[w]);
  assert.deepEqual(C.widgetPresetU(w),size==='M'?{w:240,h:120}:{w:240,h:240});
  assert.throws(()=>C.parseConfig(view([{...w,windows:usage().windows}])));
  assert.throws(()=>C.parseConfig(view([{...w,form:'other'}])));
  for(const bad of ['S','Tall','XL','Wide'])assert.throws(()=>C.parseConfig(view([{...w,size:bad}])));
 }
 assert.doesNotMatch(readFileSync(store.path,'utf8'),/usedPercent|resetsAt|sampledAt|observedAt|account/);
});

test('T112 source windows are validated, preserve multiple buckets, zero and missing reset independently',()=>{
 const r=codexWindows({rateLimits:{primary:{usedPercent:100,windowDurationMins:300,resetsAt:1900000000},secondary:null}});
 assert.equal(r.length,1);assert.equal(r[0].usedPercent,100);assert.equal(r[0].resetsAt,1900000000000);
 assert.equal(codexWindows({rateLimits:{primary:{usedPercent:0}}})[0].resetsAt,null);
 const many=codexWindows({rateLimitsByLimitId:{codex:{primary:{usedPercent:1,windowDurationMins:60}},review:{primary:{usedPercent:2,windowDurationMins:1440}}}});
 assert.equal(many.length,2);assert.notEqual(many[0].id,many[1].id);assert.match(many[1].label,/review/);
 for(const n of [-1,101,NaN,Infinity,'5'])assert.throws(()=>codexWindows({rateLimits:{primary:{usedPercent:n}}}));
 assert.throws(()=>codexWindows({rateLimits:{primary:{usedPercent:1,resetsAt:'1900000000'}}}));
 const bad={...usage(),windows:[{...usage().windows[0],usedPercent:-1}]};assert.throws(()=>Q.parseSubscriptionSnapshot(bad));
 for(const providers of [[],['codex','codex'],['unknown'],['claude','codex','claude']])assert.throws(()=>Q.parseSubscriptionProviders(providers));
 assert.throws(()=>Q.parseSubscriptionReply({subscriptions:[usage(),usage()]}));
});

test('T112 Claude capture strips identities and payload, does not freshen idle repeats or accept API-key/free usage',()=>{
 const a=captureStatus(payload,auth,undefined,1000);assert.equal(a.windows.length,2);assert.equal(a.windows[0].usedPercent,23.5);
 assert.equal(captureStatus(payload,auth,a,1000000).observedAt,1000);
 assert.equal(captureStatus({...payload,prompt_id:'next'},auth,a,2000).observedAt,2000);
 assert.equal(captureStatus(payload,{...auth,email:'other@example.invalid'},a,3000).observedAt,3000);
 assert.doesNotMatch(JSON.stringify(a),/fixture-session|fixture-response|fixture@example|total_api_duration/);
 assert.equal(captureStatus(payload,{...auth,authMethod:'api_key'}),undefined);
 assert.equal(captureStatus(payload,{...auth,subscriptionType:'free'}),undefined);
 assert.equal(captureStatus({...payload,rate_limits:{}},auth),undefined);
 assert.equal(captureStatus({...payload,rate_limits:{five_hour:{used_percentage:102,resets_at:1900000000}}},auth),undefined);
});

test('T112 one provider request is coalesced, cached, identity-bound on failure and canceled at stop',async()=>{
 let now=1000,calls=0,identity='a',fail=false,gate=deferred();
 const cache=new SubscriptionUsage(async(provider,signal)=>{calls++;await gate.promise;if(signal.aborted)throw Error('canceled');return {snapshot:fail?{...usage(provider,now),status:'unavailable',windows:[],updatedAt:null,source:null}:usage(provider,now),identity,failed:fail};},()=>now);
 for(let i=0;i<10;i++)assert.equal(cache.read(['codex'])[0].status,'loading');assert.equal(calls,1);
 gate.resolve();await tick();assert.equal(cache.read(['codex'])[0].status,'ready');assert.equal(calls,1);
 now+=QUOTA_REFRESH_MS+1;fail=true;cache.read(['codex']);await tick();assert.equal(cache.read(['codex'])[0].status,'stale');
 now+=QUOTA_REFRESH_MS+1;identity='b';cache.read(['codex']);await tick();assert.deepEqual(cache.read(['codex'])[0].windows,[]);
 await cache.stop();const before=calls;now+=QUOTA_REFRESH_MS;cache.read(['codex']);assert.equal(calls,before);
});

test('T112 Codex process uses only handshake/account/rate-limit reads and enforces timeout',async t=>{
 const dir=temporary(t),file=join(dir,'codex'),log=join(dir,'methods');
 writeFileSync(file,'#!/usr/bin/env node\n'+`const readline=require('node:readline'),fs=require('node:fs');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},m.method+'\\n');if(!m.id)return;const result=m.id===1?{}:m.id===2?{account:{type:'chatgpt',planType:'plus',email:'fixture@example.invalid'}}:{rateLimits:{primary:{usedPercent:42,windowDurationMins:300}}};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});\n`,{mode:0o700});
 const result=await codexQuota(file,new AbortController().signal,2000);assert.equal(result.account.type,'chatgpt');assert.equal(codexWindows(result.limits)[0].usedPercent,42);
 assert.deepEqual(readFileSync(log,'utf8').trim().split('\n'),['initialize','initialized','account/read','account/rateLimits/read']);
 const hung=join(dir,'hung');writeFileSync(hung,'#!/usr/bin/env node\nsetInterval(()=>{},1000);\n',{mode:0o700});
 await assert.rejects(codexQuota(hung,new AbortController().signal,30),/timed out/);
});

test('T112 Claude bridge wraps stdin/stdout, preserves settings, is idempotent and reverses safely',t=>{
 const dir=temporary(t),cfg=join(dir,'claude-config'),data=join(dir,'data'),fake=join(dir,'claude');
 // The installer creates the private config directory; prepare a fixture before testing preservation.
 mkdirSync(cfg,{recursive:true});
 const original={theme:'dark',statusLine:{type:'command',command:'/bin/cat',padding:2},other:{keep:true}};
 writeFileSync(join(cfg,'settings.json'),JSON.stringify(original),{mode:0o600});
 writeFileSync(fake,'#!/usr/bin/env node\nprocess.stdout.write('+JSON.stringify(JSON.stringify(auth))+');\n',{mode:0o700});
 const options={dataDir:data,configDir:cfg,node:process.execPath,claude:fake};
 configureClaudeBridge(options);configureClaudeBridge(options);
 const installed=JSON.parse(readFileSync(join(cfg,'settings.json')));assert.equal(installed.other.keep,true);assert.equal(installed.statusLine.padding,2);
 const bridge=join(data,'subscription-usage'),input=JSON.stringify(payload);
 assert.equal(execFileSync(process.execPath,[join(bridge,'capture.mjs')],{input,encoding:'utf8'}),input);
 const captured=JSON.parse(readFileSync(join(bridge,'claude.json')));assert.equal(captured.windows.length,2);
 assert.equal(lstatMode(join(bridge,'claude.json')),0o600);
 configureClaudeBridge({...options,disconnect:true});assert.deepEqual(JSON.parse(readFileSync(join(cfg,'settings.json'))),original);assert.equal(existsSync(join(bridge,'claude.json')),false);
 configureClaudeBridge(options);const changed={...JSON.parse(readFileSync(join(cfg,'settings.json'))),statusLine:{type:'command',command:'printf user-change'}};writeFileSync(join(cfg,'settings.json'),JSON.stringify(changed));
 assert.throws(()=>configureClaudeBridge({...options,disconnect:true}),/changed/);assert.deepEqual(JSON.parse(readFileSync(join(cfg,'settings.json'))),changed);
});
function lstatMode(path){return statSync(path).mode&0o777;}

test('T112 Claude collector verifies subscription/account, stale capture, logout and missing CLI independently',async t=>{
 const dir=temporary(t),file=join(dir,'claude'),authFile=join(dir,'auth.json'),bridge=join(dir,'subscription-usage'),now=Date.now();mkdirSync(bridge,{mode:0o700});
 const previous=process.env.KEYLN_CLAUDE_PATH;t.after(()=>{if(previous===undefined)delete process.env.KEYLN_CLAUDE_PATH;else process.env.KEYLN_CLAUDE_PATH=previous;});process.env.KEYLN_CLAUDE_PATH=file;
 writeFileSync(file,'#!/usr/bin/env node\nprocess.stdout.write(require("node:fs").readFileSync('+JSON.stringify(authFile)+'));\n',{mode:0o700});writeFileSync(authFile,JSON.stringify(auth),{mode:0o600});
 writeFileSync(join(bridge,'claude.json'),JSON.stringify(captureStatus(payload,auth,undefined,now)),{mode:0o600});
 const collect=at=>collectSubscription('claude',dir,new AbortController().signal,at??now);
 assert.equal((await collect()).snapshot.status,'ready');assert.equal((await collect(now+300001)).snapshot.status,'stale');
 writeFileSync(authFile,JSON.stringify({...auth,email:'changed@example.invalid'}));assert.deepEqual((await collect()).snapshot.windows,[]);
 writeFileSync(authFile,JSON.stringify({loggedIn:false,authMethod:'none'}));assert.equal((await collect()).snapshot.status,'sign-in');
 process.env.KEYLN_CLAUDE_PATH=join(dir,'missing');assert.equal((await collect()).snapshot.status,'not-installed');
});

test('T112 Claude get_usage windows map ISO resets, skip unknown, clamp overage and reject malformed values',()=>{
 const r=claudeWindows({rate_limits_available:true,rate_limits:{five_hour:{utilization:23.5,resets_at:'2030-03-17T10:00:00.000Z'},seven_day:{utilization:104,resets_at:null},seven_day_opus:{utilization:9,resets_at:null},model_scoped:[{display_name:'Fable',utilization:3,resets_at:null}]}});
 assert.deepEqual(r,[{id:'five_hour',label:'5-hour',usedPercent:23.5,windowMinutes:300,resetsAt:Date.parse('2030-03-17T10:00:00.000Z')},{id:'seven_day',label:'Weekly',usedPercent:100,windowMinutes:10080,resetsAt:null}]);
 assert.deepEqual(claudeWindows({rate_limits:{five_hour:{utilization:null,resets_at:null},seven_day:null}}),[]);
 assert.deepEqual(claudeWindows({rate_limits_available:false,rate_limits:null}),[]);
 for(const bad of [{utilization:-1},{utilization:'5'},{utilization:NaN},{utilization:5,resets_at:'not a date'},{utilization:5,resets_at:1900000000}])
  assert.throws(()=>claudeWindows({rate_limits:{five_hour:bad}}));
});

test('T112 Claude usage read sends only one get_usage control request with isolated flags and enforces timeout',async t=>{
 const dir=temporary(t),file=join(dir,'claude'),log=join(dir,'log.json');
 const reply={type:'control_response',response:{subtype:'success',request_id:'keyln-usage',response:{subscription_type:'max',rate_limits_available:true,rate_limits:{five_hour:{utilization:12,resets_at:'2030-01-01T00:00:00Z'}}}}};
 writeFileSync(file,'#!/usr/bin/env node\n'+`const fs=require('node:fs'),input=fs.readFileSync(0,'utf8');fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),input,cwd:process.cwd(),updater:process.env.DISABLE_AUTOUPDATER,user:process.env.USER}));process.stdout.write('not json\\n'+JSON.stringify({type:'system',subtype:'other'})+'\\n'+${JSON.stringify(JSON.stringify(reply))}+'\\n');`,{mode:0o700});
 const savedUser=process.env.USER;delete process.env.USER;t.after(()=>{if(savedUser!==undefined)process.env.USER=savedUser;});
 const usage=await claudeUsage(file,new AbortController().signal,5000);assert.equal(claudeWindows(usage)[0].usedPercent,12);
 const seen=JSON.parse(readFileSync(log,'utf8'));assert.deepEqual(seen.argv,CLAUDE_USAGE_ARGS);assert.equal(seen.updater,'1');assert.equal(seen.user,userInfo().username,'login-startup env without USER still finds the Keychain login');
 for(const flag of ['-p','--restricted','--strict-mcp-config','--no-session-persistence'])assert.ok(seen.argv.includes(flag));assert.equal(seen.argv[seen.argv.indexOf('--tools')+1],'');
 assert.deepEqual(seen.input.trim().split('\n').map(line=>JSON.parse(line)),[{type:'control_request',request_id:'keyln-usage',request:{subtype:'get_usage',skip_behaviors:true}}]);
 const refused=join(dir,'refused');writeFileSync(refused,'#!/usr/bin/env node\nrequire("node:fs").readFileSync(0);process.stdout.write(JSON.stringify({type:"control_response",response:{subtype:"error",request_id:"keyln-usage",error:"unsupported"}})+"\\n");\n',{mode:0o700});
 await assert.rejects(claudeUsage(refused,new AbortController().signal,5000),/unavailable/);
 const hung=join(dir,'hung');writeFileSync(hung,'#!/usr/bin/env node\nsetInterval(()=>{},1000);\n',{mode:0o700});
 await assert.rejects(claudeUsage(hung,new AbortController().signal,30),/unavailable/);
});

test('T112 Claude collector prefers live get_usage, then the opt-in capture, and keeps failures identity-bound',async t=>{
 const dir=temporary(t),file=join(dir,'claude'),authFile=join(dir,'auth.json'),usageFile=join(dir,'usage.json'),calls=join(dir,'calls'),bridge=join(dir,'subscription-usage'),now=Date.now();
 const previous=process.env.KEYLN_CLAUDE_PATH;t.after(()=>{if(previous===undefined)delete process.env.KEYLN_CLAUDE_PATH;else process.env.KEYLN_CLAUDE_PATH=previous;});process.env.KEYLN_CLAUDE_PATH=file;
 writeFileSync(file,'#!/usr/bin/env node\n'+`const fs=require('node:fs'),auth=process.argv[2]==='auth';fs.appendFileSync(${JSON.stringify(calls)},(auth?'auth':'usage')+':'+process.env.USER+'\\n');if(!auth)fs.readFileSync(0);process.stdout.write(fs.readFileSync(auth?${JSON.stringify(authFile)}:${JSON.stringify(usageFile)}));`,{mode:0o700});
 const answer=response=>writeFileSync(usageFile,JSON.stringify({type:'control_response',response:{subtype:'success',request_id:'keyln-usage',response}})+'\n');
 writeFileSync(authFile,JSON.stringify(auth));
 const collect=()=>collectSubscription('claude',dir,new AbortController().signal,now);
 answer({rate_limits_available:true,rate_limits:{five_hour:{utilization:30,resets_at:'2030-01-01T00:00:00Z'},seven_day:{utilization:61,resets_at:'2030-01-05T00:00:00Z'}}});
 let r=await collect();assert.equal(r.snapshot.status,'ready');assert.equal(r.snapshot.source,'claude-code-usage');assert.deepEqual(r.snapshot.windows.map(w=>w.usedPercent),[30,61]);assert.ok(r.identity);assert.equal(r.failed,undefined);
 assert.doesNotMatch(JSON.stringify(r.snapshot),/fixture@example|max/);Q.parseSubscriptionSnapshot(r.snapshot);
 answer({rate_limits_available:false,rate_limits:null});r=await collect();assert.deepEqual([r.snapshot.status,r.snapshot.reason,r.failed],['unavailable','no-quota',undefined]);
 writeFileSync(usageFile,JSON.stringify({type:'control_response',response:{subtype:'error',request_id:'keyln-usage',error:'get_usage is not supported'}})+'\n');
 r=await collect();assert.deepEqual([r.snapshot.status,r.snapshot.reason,r.failed],['unavailable','read-failed',true]);assert.equal(r.identity,(await collect()).identity);
 mkdirSync(bridge,{mode:0o700});writeFileSync(join(bridge,'claude.json'),JSON.stringify(captureStatus(payload,auth,undefined,now)),{mode:0o600});
 r=await collect();assert.equal(r.snapshot.status,'ready');assert.equal(r.snapshot.source,'claude-statusline');
 answer({rate_limits_available:true,rate_limits:{five_hour:{utilization:-5,resets_at:null}}});r=await collect();assert.equal(r.snapshot.source,'claude-statusline','malformed live data falls back');
 writeFileSync(calls,'');writeFileSync(authFile,JSON.stringify({loggedIn:false,authMethod:'none'}));assert.equal((await collect()).snapshot.status,'sign-in');
 writeFileSync(authFile,JSON.stringify({...auth,authMethod:'api_key'}));assert.equal((await collect()).snapshot.status,'not-subscribed');
 const me=userInfo().username;assert.deepEqual(readFileSync(calls,'utf8').trim().split('\n'),['auth:'+me,'auth:'+me],'no usage read without a subscription login');
});

test('T112 Claude setup without prior settings is reversible and does not leave a settings file',t=>{
 const dir=temporary(t),options={dataDir:join(dir,'data'),configDir:join(dir,'config'),node:process.execPath,claude:process.execPath};
 configureClaudeBridge(options);configureClaudeBridge({...options,disconnect:true});assert.equal(existsSync(join(options.configDir,'settings.json')),false);assert.equal(existsSync(join(options.dataDir,'subscription-usage/capture.mjs')),false);
});

test('T112 an obsolete unauthorized quota response cannot erase a newer connection',async t=>{
 const previous=globalThis.document;globalThis.document={hidden:false,addEventListener(){},removeEventListener(){}};
 const gate=deferred(),values=[];let calls=0;
 const c=createSubscriptionClient(v=>values.push(v),async()=>++calls===1?await gate.promise:{ok:true,status:200,json:async()=>({subscriptions:[usage()]})});t.after(()=>{c.stop();globalThis.document=previous;});
 c.sync(['codex'],true);c.sync(['codex'],false);c.sync(['codex'],true);await tick();assert.equal(values.at(-1).codex.status,'ready');gate.resolve({ok:false,status:401});await tick();assert.equal(values.at(-1).codex.status,'ready');
});

test('T112 renderer shows remaining, stale/offline, reset boundary, unavailable and destroys its timer',t=>{
 const dom=installDom(t);const old=Object.getOwnPropertyDescriptor(Element.prototype,'style');Object.defineProperty(Element.prototype,'style',{configurable:true,get(){return {setProperty(){}};}});t.after(()=>{if(old)Object.defineProperty(Element.prototype,'style',old);else delete Element.prototype.style;});
 const handlers=new Set();dom.document.addEventListener=(_,fn)=>handlers.add(fn);dom.document.removeEventListener=(_,fn)=>handlers.delete(fn);
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1000000});
 const w=codexUsageWidget.create({form:'quota',standalone:true,intents:{},create(){}}),state={...initialDeskState('braun'),connection:{online:true},subscriptions:{codex:usage('codex',Date.now())}};
 w.update(state);assert.match(w.element.textContent,/72%/);assert.match(w.element.textContent,/left/);assert.equal(w.element.find(n=>n.getAttribute?.('role')==='meter').getAttribute('aria-valuenow'),'72');
 w.preset('M');assert.equal(w.element.dataset.compact,'true');assert.match(w.element.textContent,/remaining/);
 w.update({...state,subscriptions:{codex:{...state.subscriptions.codex,status:'stale'}}});assert.match(w.element.textContent,/Stale/);
 t.mock.timers.tick(120001);w.update(state);assert.match(w.element.textContent,/Waiting for fresh quota/);assert.doesNotMatch(w.element.textContent,/100%/);
 w.update({...state,subscriptions:{codex:{provider:'codex',status:'sign-in',windows:[],updatedAt:null,checkedAt:null,source:null}}});assert.match(w.element.textContent,/Sign in required/);assert.doesNotMatch(w.element.textContent,/0%/);
 w.destroy();assert.equal(handlers.size,0);t.mock.timers.tick(120000);
 assert.equal(remainingText(0.01),'99.9%');assert.match(resetText(null,0,false),/not reported/);
});

test('T112 quota transport ignores abandoned replies, pauses hidden pages and clears on authorization loss',async t=>{
 const previous=globalThis.document,listeners=new Map();globalThis.document={hidden:false,addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k)};
 const values=[],gate=deferred();let calls=0,unauthorized=false;
 const c=createSubscriptionClient(v=>values.push(v),async()=>{calls++;if(calls===1)await gate.promise;return unauthorized?{ok:false,status:401}:{ok:true,status:200,json:async()=>({subscriptions:[usage()]})};});t.after(()=>{c.stop();globalThis.document=previous;});
 c.sync(['codex'],true);c.sync([],false);gate.resolve();await tick();assert.equal(values.at(-1).codex,undefined);
 c.sync(['codex'],true);await tick();assert.equal(values.at(-1).codex.status,'ready');
 unauthorized=true;globalThis.document.hidden=true;listeners.get('visibilitychange')();globalThis.document.hidden=false;listeners.get('visibilitychange')();await tick();assert.deepEqual(values.at(-1),{});
 c.stop();assert.equal(listeners.size,0);
});

test('T112 Library sample placement/save/Undo uses the real renderer and never executes',async t=>{
 const f=await client(t);f.el('edit-layout').emit('click');f.el('shelf-toggle').emit('click');f.el('shelf-types').children.find(n=>n.dataset.libraryType==='widget').emit('click');
 const tabs=f.el('shelf-previews').children[0];assert.deepEqual(tabs.children.map(n=>n.textContent),['Clock','Text','Refresh','Codex','Claude Code']);tabs.children[3].emit('click');
 const cards=f.el('shelf-previews').children.filter(n=>n.className.includes('shelf-card'));assert.equal(cards.length,2);assert.match(cards[0].children[1].textContent,/Sample data/);assert.equal(f.count('subscriptions'),0,'Library never starts collection');
 cards[1].emit('click');await f.drain();assert.equal(f.count('execute'),0);f.el('edit-undo').emit('click');await f.drain();
 assert.equal(f.count('configuration/save'),0);cards[1].emit('click');await f.drain();f.el('desk-save').emit('click');await f.drain();await f.drain();
 assert.ok(f.state.config.widgets.some(w=>w.kind==='codex-usage')||f.state.config.widgets.some(w=>w.pages?.some(p=>p.widgets.some(w=>w.kind==='codex-usage'))));assert.equal(f.count('execute'),0);
});

test('T112 HTTPS quota route rejects unpaired/cross-origin/invalid requests and never changes config or executes',async t=>{
 const dir=temporary(t);execFileSync(process.execPath,['scripts/setup.mjs'],{env:{...process.env,KEYLN_DATA_DIR:dir},stdio:'pipe'});
 const authService=new Auth(dir),store=new ConfigStore(dir),scheduler=new Scheduler({run:async()=>{throw Error('must not execute');}}),before=readFileSync(store.path);let reads=0;
 const origin='https://127.0.0.1:0',server=createHost({origin,auth:authService,store,scheduler,apps:[],onPair(){},subscriptions:{read:ids=>{reads++;return ids.map(id=>usage(id));}},tls:{key:readFileSync(join(dir,'tls/server.key')),cert:readFileSync(join(dir,'tls/server.pem'))}});
 await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});t.after(async()=>{scheduler.stop();server.stopEvents();server.closeAllConnections();await new Promise(yes=>server.close(yes));});
 const p=authService.begin(authService.invite(),'Owned fixture');authService.approve(p.id);const cookie='__Host-keyln='+authService.claim(p.id,p.claim).token;
 const send=(body,headers={})=>new Promise((yes,no)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,ca:readFileSync(join(dir,'tls/rootCA.pem')),path:'/api/subscriptions',method:'POST',headers:{host:'127.0.0.1:0',origin,'content-type':'application/json','x-keyln-client':'1',...headers}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>yes({status:res.statusCode,text}));});req.on('error',no);req.end(JSON.stringify(body));});
 assert.equal((await send({providers:['codex']})).status,401);assert.equal(reads,0);
 assert.equal((await send({providers:['codex']},{cookie,origin:'https://evil.invalid'})).status,403);
 for(const body of [{providers:['bad']},{providers:['codex','codex']},{providers:['codex'],command:'bad'}])assert.equal((await send(body,{cookie})).status,400);
 const response=await send({providers:['codex','claude']},{cookie});assert.equal(response.status,200);assert.equal(reads,1);assert.doesNotMatch(response.text,/fixture@example|token|account|authMethod/);assert.deepEqual(readFileSync(store.path),before);
 authService.revoke(p.id);assert.equal((await send({providers:['codex']},{cookie})).status,401);assert.equal(reads,1);
});
