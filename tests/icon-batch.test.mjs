import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request} from 'node:https';
import {AppIcons,appIconIds,ICON_CACHE_MS,MAX_ICON_BATCH} from '../dist/apps/host/app-icons.js';
import {createAppIconLoader} from '../dist/apps/web/app-icons.js';
import {nativeAppIcons} from '../dist/apps/host/native.js';
import {Auth} from '../dist/apps/host/auth.js';
import {ConfigStore} from '../dist/apps/host/store.js';
import {Scheduler} from '../dist/apps/host/scheduler.js';
import {createHost} from '../dist/apps/host/server.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1EAAAAASUVORK5CYII=','base64');png.writeUInt32BE(128,16);png.writeUInt32BE(128,20);
const gate=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return{promise,resolve};};
const turn=()=>new Promise(r=>setImmediate(r));
const reply=ids=>Response.json({icons:ids.map(appId=>({appId,png:png.toString('base64')}))});

test('native batch policy scans once and rejects bad counts, IDs and bundle mismatch',t=>{
 const dir=mkdtempSync(join(tmpdir(),'keyln-batch-policy-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const binary=join(dir,'icon-policy');
 execFileSync('/usr/bin/xcrun',['swiftc','-O','-module-cache-path',join(dir,'cache'),'tests/icon-batch-probe/main.swift','native/macos-helper/Applications.swift','native/macos-helper/AppIcon.swift','-o',binary],{stdio:'pipe',timeout:60000});
 assert.deepEqual(JSON.parse(execFileSync(binary,[],{encoding:'utf8'})),{ok:true,validBatchScans:1,invalidBeforeScan:5,bundleMismatchRejected:true});
 for(const values of [[],Array.from({length:17},(_,i)=>'test.'+i),['test.same','test.same'],['/etc/passwd']])assert.throws(()=>appIconIds(values));
});
test('native batch exports real icons together, with isolated unavailable results and no path inputs',async()=>{
 const ids=['com.apple.Safari','com.microsoft.rdc.macos','com.apple.finder','com.apple.Terminal','com.apple.calculator'];
 const result=await nativeAppIcons([...ids,'com.keyln.not-installed']);assert.equal(result.size,5);
 for(const id of ids){assert.ok(result.get(id).length>1000);assert.equal(result.get(id).readUInt32BE(16),128);}
 for(const values of [[],Array.from({length:17},(_,i)=>'test.'+i),['test.same','test.same'],['../../etc/passwd']])await assert.rejects(nativeAppIcons(values));
});
test('Host batches share IDs, cap two exports / 32 in-flight IDs, and do not extend the one-hour TTL on hits',async()=>{
 const a=gate(),b=gate(),calls=[];let clock=0;
 const cache=new AppIcons(async()=>assert.fail('Must use batch reader'),()=>clock,async ids=>{calls.push(ids);await(calls.length===1?a.promise:b.promise);return new Map(ids.map(id=>[id,png]));});
 const ids=Array.from({length:16},(_,i)=>'test.a'+i),other=Array.from({length:16},(_,i)=>'test.b'+i);
 const first=cache.getMany(ids),same=cache.getMany(ids.slice(0,3)),second=cache.getMany(other);await turn();assert.equal(calls.length,2);
 await assert.rejects(cache.getMany(['test.extra']),e=>e.code==='ICON_BUSY');assert.equal(calls.flat().length,32);
 a.resolve();b.resolve();assert.ok((await first).every(data=>data.equals(png)));await same;await second;
 clock=300_001;await cache.getMany(ids);assert.equal(calls.length,2,'still cached beyond the former five minutes');
 clock=ICON_CACHE_MS-1;await cache.getMany(ids);assert.equal(calls.length,2);
 clock=ICON_CACHE_MS;await cache.getMany(ids);assert.equal(calls.length,3,'hits must not reset export time');
 let afterRestart=0;const restarted=new AppIcons(async()=>{afterRestart++;return png;});await restarted.get(ids[0]);assert.equal(afterRestart,1,'new Host cache starts empty');
});
test('Host batch retains good items, rejects malformed PNGs, and releases failure slots without caching failures',async()=>{
 let calls=0;const cache=new AppIcons(async()=>assert.fail('batch only'),Date.now,async ids=>{calls++;return new Map(ids.filter(id=>id!=='test.missing').map(id=>[id,id==='test.bad'?Buffer.alloc(65_537):png]));});
 const result=await cache.getMany(['test.good','test.bad','test.missing']);assert.ok(result[0].equals(png));assert.deepEqual(result.slice(1),[null,null]);
 await cache.getMany(['test.good']);assert.equal(calls,1);await cache.getMany(['test.bad','test.missing']);assert.equal(calls,2);
 await assert.rejects(cache.get('test.bad'));await assert.rejects(cache.getMany(Array.from({length:17},(_,i)=>'test.'+i)));assert.equal(calls,3);
});
test('batch TLS isolates unknown IDs, preserves every origin/auth boundary and checks post-export revocation',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'keyln-batch-tls-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 execFileSync(process.execPath,['scripts/setup.mjs'],{env:{...process.env,KEYLN_DATA_DIR:dir},stdio:'pipe'});
 const auth=new Auth(dir),store=new ConfigStore(dir),origin='https://127.0.0.1:0',calls=[];let held;
 const scheduler=new Scheduler({run:async()=>assert.fail('No action allowed')});
 const apps=Array.from({length:17},(_,i)=>({id:'test.app'+i,name:'App '+i}));
 const large=Buffer.concat([png,Buffer.alloc(65_536-png.length,255)]);
 const server=createHost({origin,auth,store,scheduler,apps,appIcon:async()=>png,appIcons:async ids=>{calls.push(ids);if(held)await held.promise;return new Map(ids.map(id=>[id,large]));},tls:{key:readFileSync(join(dir,'tls/server.key')),cert:readFileSync(join(dir,'tls/server.pem'))},onPair:()=>{}});
 await new Promise(yes=>server.listen(0,'127.0.0.1',yes));t.after(()=>{scheduler.stop();server.stopEvents();return new Promise(yes=>{server.closeAllConnections();server.close(yes);});});
 const pair=auth.begin(auth.invite(),'Batch test');auth.approve(pair.id);const cookie='__Host-keyln='+auth.claim(pair.id,pair.claim).token,ca=readFileSync(join(dir,'tls/rootCA.pem'));
 function send(value,extra={},path='/api/app-icons') {return new Promise((yes,no)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,ca,servername:'',method:'POST',path,headers:{host:'127.0.0.1:0',origin,'content-type':'application/json','x-keyln-client':'1',cookie,...extra}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>yes({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',no);req.end(JSON.stringify(value));});}
 for(const extra of [{cookie:''},{origin:'https://evil.test'},{'x-keyln-client':''},{'sec-fetch-site':'cross-site'},{host:'evil.test'}])assert.ok([401,403].includes((await send({appIds:['test.app0']},extra)).status));
 for(const body of [{appIds:[]},{appIds:apps.map(a=>a.id)},{appIds:['test.app0','test.app0']},{appIds:['../../etc/passwd']},{appIds:['test.app0'],path:'/etc/passwd'},{appId:'test.app0'}])assert.equal((await send(body)).status,400);
 assert.deepEqual(calls,[]);
 for(let i=0;i<2;i++){
  const unknown=await send({appIds:['not.installed']});assert.equal(unknown.status,200);
  assert.deepEqual(JSON.parse(unknown.body),{icons:[{appId:'not.installed',code:'ICON_UNAVAILABLE'}]});
 }
 assert.deepEqual(calls,[],'unknown-only batches must bypass the exporter and cache');
 const mixed=await send({appIds:['not.installed','test.app0']});assert.equal(mixed.status,200);
 assert.deepEqual(JSON.parse(mixed.body),{icons:[{appId:'not.installed',code:'ICON_UNAVAILABLE'},{appId:'test.app0',png:large.toString('base64')}]});
 assert.deepEqual(calls,[['test.app0']],'only installed IDs reach the Helper');
 assert.equal((await send({appIds:['test.app0','not.installed']})).status,200);assert.equal(calls.length,1,'the good icon remains cached without caching or exporting unknown IDs');
 const value=await send({appIds:apps.slice(0,16).map(a=>a.id)});assert.equal(value.status,200);assert.equal(value.headers['cache-control'],'no-store');assert.equal(value.headers['x-content-type-options'],'nosniff');assert.equal(JSON.parse(value.body).icons.length,16);assert.ok(value.body.length<=1_410_000);assert.equal(calls.length,2);
 const foundationEscaped=value.body.toString().replaceAll('/','\\/');assert.ok(Buffer.byteLength(foundationEscaped)>1_410_000);assert.ok(Buffer.byteLength(foundationEscaped)<2*1_410_000,'Native pipe budget must cover Foundation escaping without relaxing the HTTP bound');
 assert.equal((await send({appIds:['test.app0']})).status,200);assert.equal((await send({appId:'test.app0'},{},'/api/app-icon')).status,200);assert.equal(calls.length,2);
 assert.equal((await send({appIds:['test.app0']},{cookie:''})).status,401);
 held=gate();const pending=send({appIds:['test.app16']});while(calls.length<3)await turn();auth.revoke(auth.list()[0].id);held.resolve();assert.equal((await pending).status,401);assert.equal((await send({appIds:['test.app0']})).status,401);
});
test('client keeps installed icons from a mixed batch when an unavailable binding falls back',async()=>{
 const calls=[],load=createAppIconLoader(async(_url,options)=>{
  calls.push(JSON.parse(options.body).appIds);
  return Response.json({icons:[{appId:'test.good',png:png.toString('base64')},{appId:'not.installed',code:'ICON_UNAVAILABLE'}]});
 });
 const [good,missing]=await Promise.all([load('test.good'),load('not.installed')]);
 assert.ok(good?.startsWith('data:image/png;base64,'));assert.equal(missing,null);
 assert.deepEqual(calls,[['test.good','not.installed']]);
 assert.equal(await load('test.good'),good);assert.equal(calls.length,1);
});
test('queued icon subscriptions cancel without poisoning a shared visible consumer or a later retry',async()=>{
 const calls=[],gates=[],load=createAppIconLoader(async(_url,options)=>{const ids=JSON.parse(options.body).appIds;calls.push(ids);const g=gate();gates.push(g);await g.promise;return reply(ids);});
 const discarded=new AbortController(),cancelled=load('test.cancel',discarded.signal);discarded.abort();assert.equal(await cancelled,null);await turn();assert.equal(calls.length,0);
 const kept=new AbortController(),shared=new AbortController(),a=load('test.shared',kept.signal),b=load('test.shared',shared.signal);shared.abort();assert.equal(await b,null);await turn();assert.deepEqual(calls,[['test.shared']]);gates[0].resolve();assert.ok(await a);
 const inflight=Array.from({length:32},(_,i)=>load('test.running'+i));await turn();assert.equal(calls.length,3);
 const close=new AbortController(),search=new AbortController(),offscreen=new AbortController();
 const unused=[load('test.closed',close.signal),load('test.oldQuery',search.signal),load('test.offscreen',offscreen.signal)];close.abort();search.abort();offscreen.abort();assert.deepEqual(await Promise.all(unused),[null,null,null]);
 gates[1].resolve();gates[2].resolve();await Promise.all(inflight);await turn();assert.equal(calls.length,3,'cancelled queued IDs must not reach fetch');
 const retry=load('test.closed');await turn();assert.equal(calls.length,4);gates[3].resolve();assert.ok(await retry,'cancelling must not create a failure cooldown');
 const already=new AbortController();already.abort();assert.equal(await load('test.never',already.signal),null);
});
test('started batches may finish after unsubscribe, stay bounded and remain reusable',async()=>{
 const running=gate(),calls=[],abort=new AbortController();const load=createAppIconLoader(async(_url,options)=>{calls.push(options);await running.promise;return reply(JSON.parse(options.body).appIds);});
 const pending=load('test.started',abort.signal);await turn();abort.abort();assert.equal(await pending,null);assert.equal(calls[0].signal.aborted,false);
 running.resolve();await turn();assert.ok(await load('test.started'));assert.equal(calls.length,1);
 const held=gate();let count=0;const limited=createAppIconLoader(async(_url,options)=>{count++;await held.promise;return reply(JSON.parse(options.body).appIds);});
 const entries=Array.from({length:49},(_,i)=>limited('test.limit'+i));await turn();assert.equal(count,2,'T84: the queue holds every request; only two batches run');held.resolve();assert.ok((await Promise.all(entries)).every(Boolean),'T84: no 48-entry overflow to null');assert.equal(count,4);
 assert.equal(MAX_ICON_BATCH,16);
});
