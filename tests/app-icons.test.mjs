import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request} from 'node:https';
import {createHash} from 'node:crypto';
import {AppIcons,validateAppIcon,ICON_CACHE_BYTES,ICON_CACHE_ITEMS,ICON_CACHE_MS} from '../dist/apps/host/app-icons.js';
import {Auth} from '../dist/apps/host/auth.js';
import {ConfigStore} from '../dist/apps/host/store.js';
import {Scheduler} from '../dist/apps/host/scheduler.js';
import {createHost} from '../dist/apps/host/server.js';
import {parseConfig,MAX_CONFIG_BYTES,viewFor} from '../dist/packages/contracts/index.js';
import {key,withPrimary,withComponents,components} from './helpers/layout.mjs';
import {importPreview} from '../dist/apps/host/layout.js';
import {appIconReference,createAppIconLoader} from '../dist/apps/web/app-icons.js';

// Header-only samples exercise bounds. Real AppKit PNG decoding is verified on Surface.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1EAAAAASUVORK5CYII=','base64');
png.writeUInt32BE(128,16);png.writeUInt32BE(128,20);
const clone=value=>JSON.parse(JSON.stringify(value));
const gate=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return{promise,resolve};};

test('native AppKit exports five catalog icons without opening apps; paths and unknown IDs are rejected',()=>{
 const catalog=JSON.parse(execFileSync('./dist/keyln-helper',['list'],{encoding:'utf8',timeout:10000}));
 const hashes=new Set();
 for(const id of ['com.apple.Safari','com.microsoft.rdc.macos','com.apple.finder','com.apple.Terminal','com.apple.calculator']){
  assert.ok(catalog.some(app=>app.id===id),id);
  const result=JSON.parse(execFileSync('./dist/keyln-helper',['icon',id],{encoding:'utf8',timeout:10000}));
  const data=Buffer.from(result.png,'base64');assert.deepEqual(validateAppIcon(data),data);assert.ok(data.length>1000,id);
  hashes.add(createHash('sha256').update(data).digest('hex'));
 }
 assert.equal(hashes.size,5,'Five real AppKit icons must not all be blank or generic copies.');
 for(const id of ['/Applications/Safari.app','file:///etc/passwd','com.keyln.not-installed']){
  try{execFileSync('./dist/keyln-helper',['icon',id],{stdio:'pipe',timeout:10000});assert.fail('Expected rejection');}
  catch(error){assert.equal(error.status,1);assert.equal(JSON.parse(error.stdout).ok,false);}
 }
});
test('Host icon cache enforces item/byte bounds and expires; oversize and invalid PNGs are not retained',async()=>{
 let clock=0,calls=0;const counts=new Map();
 const large=Buffer.concat([png,Buffer.alloc(65_536-png.length)]);
 const cache=new AppIcons(async id=>{calls++;counts.set(id,(counts.get(id)||0)+1);return large;},()=>clock);
 for(let n=0;n<ICON_CACHE_BYTES/65_536+2;n++)await cache.get('test.byte'+n);
 const before=calls;await cache.get('test.byte0');assert.equal(calls,before+1,'8 MiB budget evicts oldest before item limit');
 await cache.get('test.byte'+(ICON_CACHE_BYTES/65_536+1));assert.equal(counts.get('test.byte'+(ICON_CACHE_BYTES/65_536+1)),1);
 clock=ICON_CACHE_MS;await cache.get('test.byte'+(ICON_CACHE_BYTES/65_536+1));assert.equal(counts.get('test.byte'+(ICON_CACHE_BYTES/65_536+1)),2);
 const small=new AppIcons(async id=>{counts.set(id,(counts.get(id)||0)+1);return png;});
 for(let n=0;n<=ICON_CACHE_ITEMS;n++)await small.get('test.item'+n);
 await small.get('test.item0');assert.equal(counts.get('test.item0'),2,'512 item budget');
 for(const invalid of [Buffer.alloc(65_537),Buffer.from('<svg/>'),(()=>{const p=Buffer.from(png);p.writeUInt32BE(256,16);return p;})()]){
  let attempts=0;const cache=new AppIcons(async()=>{attempts++;return invalid;});
  await assert.rejects(cache.get('test.invalid'));await assert.rejects(cache.get('test.invalid'));assert.equal(attempts,2);
 }
});
test('Host icon export coalesces one ID, caps parallel work at two, and releases after failure',async()=>{
 const a=gate(),b=gate();let calls=0;
 const cache=new AppIcons(async id=>{calls++;return await(id==='test.a'?a.promise:b.promise);});
 const first=cache.get('test.a'),same=cache.get('test.a'),second=cache.get('test.b');
 await assert.rejects(cache.get('test.c'),e=>e.code==='ICON_BUSY');assert.equal(calls,2);
 a.resolve(png);assert.deepEqual(await first,png);assert.deepEqual(await same,png);b.resolve(png);await second;
 assert.deepEqual(await cache.get('test.c'),png);assert.equal(calls,3);
});
test('icon TLS API protects even cache hits and revocation during export; unknown IDs never reach Helper',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'keyln-icon-http-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 execFileSync(process.execPath,['scripts/setup.mjs'],{env:{...process.env,KEYLN_DATA_DIR:dir},stdio:'pipe'});
 const auth=new Auth(dir),store=new ConfigStore(dir),origin='https://127.0.0.1:0',calls=[];let held;
 const server=createHost({origin,auth,store,scheduler:new Scheduler({run:async()=>{assert.fail('No action allowed');}}),
  apps:[{id:'test.allowed',name:'Allowed'},{id:'test.delayed',name:'Delayed'}],appIcon:async id=>{calls.push(id);return held?await held.promise:png;},
  tls:{key:readFileSync(join(dir,'tls/server.key')),cert:readFileSync(join(dir,'tls/server.pem'))},onPair:()=>{}});
 await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
 t.after(()=>new Promise(yes=>{server.closeAllConnections();server.close(yes);}));
 const pair=auth.begin(auth.invite(),'Icon TLS test');auth.approve(pair.id);const token=auth.claim(pair.id,pair.claim).token;
 const cookie='__Host-keyln='+token,ca=readFileSync(join(dir,'tls/rootCA.pem'));
 function send(value,headers={},method='POST',path='/api/app-icon'){
  return new Promise((yes,no)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,ca,servername:'',method,path,
   headers:{host:'127.0.0.1:0',origin,'content-type':'application/json','x-keyln-client':'1',cookie,...headers}},res=>{
    const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>yes({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',no);req.end(method==='POST'?JSON.stringify(value):undefined);});
 }
 for(const headers of [{cookie:''},{origin:'https://evil.test'},{'x-keyln-client':''},{'sec-fetch-site':'cross-site'},{host:'evil.test'}])
  assert.ok([401,403].includes((await send({appId:'test.allowed'},headers)).status));
 assert.deepEqual(calls,[]);
 for(const value of [{appId:'test.outside'},{appId:'../etc/passwd'},{appId:'file:///etc/passwd'},{appId:'test.allowed',path:'/etc/passwd'}])assert.ok((await send(value)).status>=400);
 assert.deepEqual(calls,[]);assert.equal((await send({}, {},'GET')).status,405);
 const response=await send({appId:'test.allowed'});assert.equal(response.status,200);assert.equal(response.headers['content-type'],'image/png');assert.equal(response.headers['cache-control'],'no-store');assert.deepEqual(response.body,png);
 assert.equal((await send({appId:'test.allowed'})).status,200);assert.deepEqual(calls,['test.allowed']);
 assert.equal((await send({appId:'test.allowed'},{cookie:''})).status,401);
 held=gate();const pending=send({appId:'test.delayed'});while(calls.length<2)await new Promise(r=>setImmediate(r));
 auth.revoke(auth.list()[0].id);held.resolve(png);assert.equal((await pending).status,401);
 assert.equal((await send({appId:'test.allowed'})).status,401);
 const module=await send({}, {},'GET','/apps/web/app-icons.js');assert.equal(module.status,200);
});
test('app icon references save/import/backup/restore with no embedded images',t=>{
 const dir=mkdtempSync(join(tmpdir(),'keyln-icon-layout-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new ConfigStore(dir),catalog=[{id:'test.app',name:'App'}],empty=store.get();
 const config=withComponents(clone(empty),[key('primary',{type:'app.open',appId:'test.app'},{},{appearance:{glyph:{type:'app'}}})]);
 const saved=store.replace(config,catalog);assert.equal(saved.revision,1);assert.deepEqual(new ConfigStore(dir).get(),saved);
 assert.deepEqual(importPreview(saved,catalog,()=>{}).view,saved);assert.deepEqual(viewFor(JSON.parse(readFileSync(store.backup)),'Surface'),empty);
 assert.ok(Buffer.byteLength(JSON.stringify(saved))<MAX_CONFIG_BYTES);assert.doesNotMatch(JSON.stringify(saved),/data:image|png|path/);
 for(const glyph of [{type:'app',appId:'other'},{type:'app',url:'http://bad'},{type:'builtin',data:'bad'}])assert.throws(()=>parseConfig(withComponents(config,[{...components(config)[0],appearance:{glyph}}])));
 components(config)[0].appearance.glyph={type:'builtin'};assert.deepEqual(parseConfig(config),config);
 store.replace(withComponents(saved,[{...components(saved)[0],label:'Changed'}]),catalog);let revoked=false;
 const restored=store.restoreBackup({stamp:store.backupState().stamp,confirm:true},()=>revoked=true);assert.equal(revoked,true);assert.deepEqual(components(restored)[0].appearance,{glyph:{type:'app'}});
});
test('display references replace only pristine defaults and explicit App sources without mutating buttons',()=>{
 const button={...components(withPrimary())[0],action:{type:'app.open',appId:'test.app'}},before=clone(button);
 assert.equal(appIconReference(button),'test.app');assert.deepEqual(button,before);
 assert.equal(appIconReference({...button,action:{type:'window.activate',appId:'test.window',title:'Work',match:'exact'}}),'test.window');
 for(const extra of [{icon:'folder'},{color:'blue'},{appearance:{}},{appearance:{glyph:{type:'text',text:'AI'}}},{appearance:{glyph:{type:'image',data:'original'}}},{appearance:{glyph:{type:'builtin'}}}])assert.equal(appIconReference({...button,...extra}),undefined);
 assert.equal(appIconReference({...button,color:'red',appearance:{glyph:{type:'app'}}}),'test.app');
 assert.equal(appIconReference({...button,action:null}),undefined);
});
test('client batches IDs, shares consumers, bounds requests/cache and validates replies',async()=>{
 const calls=[],gates=[];let active=0,peak=0,clock=0;
 const reply=ids=>Response.json({icons:ids.map(appId=>({appId,png:png.toString('base64')}))});
 const fetcher=async(url,options)=>{const ids=JSON.parse(options.body).appIds;calls.push({url,options,ids});active++;peak=Math.max(peak,active);const g=gate();gates.push(g);await g.promise;active--;return reply(ids);};
 const load=createAppIconLoader(fetcher,()=>clock),first=load('test.a'),same=load('test.a'),second=load('test.b');
 await new Promise(r=>setImmediate(r));assert.equal(calls.length,1);assert.deepEqual(calls[0].ids,['test.a','test.b']);gates[0].resolve();
 assert.equal(await first,'data:image/png;base64,'+png.toString('base64'));assert.equal(await same,await first);await second;
 const many=Array.from({length:34},(_,i)=>load('test.parallel'+i));await new Promise(r=>setImmediate(r));assert.equal(calls.length,3);
 assert.equal(calls[1].ids.length,16);assert.equal(calls[2].ids.length,16);gates[1].resolve();gates[2].resolve();
 while(calls.length<4)await new Promise(r=>setImmediate(r));gates[3].resolve();await Promise.all(many);assert.equal(peak,2);
 for(const call of calls){assert.equal(call.url,'/api/app-icons');assert.equal(call.options.method,'POST');assert.equal(call.options.credentials,'same-origin');assert.equal(call.options.headers['X-Keyln-Client'],'1');assert.deepEqual(Object.keys(JSON.parse(call.options.body)),['appIds']);assert.ok(call.ids.length<=16);}
 assert.equal(await load('/etc/passwd'),null);
 let failures=0;const failing=createAppIconLoader(async()=>{failures++;throw Error('offline');},()=>clock);
 assert.equal(await failing('test.missing'),null);assert.equal(await failing('test.missing'),null);assert.equal(failures,1);clock=30_000;await failing('test.missing');assert.equal(failures,2);
 let reads=0;const lru=createAppIconLoader(async(_url,options)=>{reads++;return reply(JSON.parse(options.body).appIds);});
 for(let i=0;i<65;i++)await lru('test.app'+i);await lru('test.app0');assert.equal(reads,66,'T84: memory keeps the 64 most recent icons (no disk here), so the oldest is asked again');await lru('test.app64');assert.equal(reads,66);
 for(const response of [new Response('<svg/>',{headers:{'content-type':'image/svg+xml'}}),new Response(Buffer.alloc(1_410_001),{headers:{'content-type':'application/json'}}),Response.json({icons:[{appId:'test.invalid',png:'not-png'}]}),Response.json({icons:[{appId:'test.other',png:png.toString('base64')}]}),Response.json({icons:[{appId:'test.invalid',code:'PATH /private/file'}]})]){
  assert.equal(await createAppIconLoader(async()=>response)('test.invalid'),null);
 }
});
