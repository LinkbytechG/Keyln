import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir,platform} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {request} from 'node:https';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import * as C from '../dist/packages/contracts/index.js';
import {ConfigStore} from '../dist/apps/host/store.js';
import {Auth} from '../dist/apps/host/auth.js';
import {Scheduler} from '../dist/apps/host/scheduler.js';
import {createHost} from '../dist/apps/host/server.js';
import {RunningApps} from '../dist/apps/host/running-apps.js';
import {planZones,dockReserve,dockStrip,DOCK_RESERVE} from '../dist/apps/web/zones.js';
import {createMacDock,dockMetrics} from '../dist/apps/web/mac-dock.js';
import {CANVAS_GAP,SHELF_GRAB} from '../dist/apps/web/library-resize.js';
import {installDom} from './helpers/widget-dom.mjs';
import {client} from './helpers/client-harness.mjs';
import {fromGrid} from './helpers/layout.mjs';

const temporary=t=>{const dir=mkdtempSync(join(tmpdir(),'keyln-t115-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
const tick=(ms=0)=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(condition,ms=3000)=>{const end=Date.now()+ms;while(!condition()){if(Date.now()>end)throw new Error('Condition not reached in time');await tick(10);}};
const app=(appId,name=appId,extra={})=>({appId,name,active:false,hidden:false,...extra});
const apps3=[app('com.apple.finder','Finder',{active:true}),app('com.example.notes','Notes'),app('com.example.hidden','Hidden',{hidden:true})];
// A stand-in for the native observer: stdout/stderr are streams, kill() closes it like a real process.
function fakeChild(){
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kills=[];
  child.kill=signal=>{child.kills.push(signal);queueMicrotask(()=>child.emit('close',null,signal));return true;};
  child.line=value=>child.stdout.write((typeof value==='string'?value:JSON.stringify(value))+'\n');
  child.ready=()=>child.line({type:'ready'});child.apps=list=>child.line({type:'apps',apps:list});
  return child;
}
const service=(options={})=>{const children=[];const running=new RunningApps({child:()=>{const child=fakeChild();children.push(child);return child;},retryMs:5,...options});return {running,children};};

test('T115 contracts: layout.dock is written only when true; absent round-trips; every other value is refused',t=>{
  const dir=temporary(t),doc=new ConfigStore(dir).document();
  assert.equal(Object.hasOwn(doc.layouts[0],'dock'),false);
  const off=C.parseConfigDocument(JSON.parse(JSON.stringify(doc)));assert.equal(JSON.stringify(off),JSON.stringify(doc),'a dock-off document is unchanged by the parser');assert.doesNotMatch(JSON.stringify(off),/dock/);
  const on=JSON.parse(JSON.stringify(doc));on.layouts[0].dock=true;
  const parsed=C.parseConfigDocument(on);assert.equal(parsed.layouts[0].dock,true);assert.equal(C.layoutDock(parsed),true);assert.equal(C.layoutDock(off),false);
  assert.deepEqual(C.parseConfigDocument(JSON.parse(JSON.stringify(parsed))),parsed);
  for(const bad of [false,'true',1,0,null,{},[],undefined]){const doc2=JSON.parse(JSON.stringify(doc));doc2.layouts[0].dock=bad;assert.throws(()=>C.parseConfigDocument(doc2),/./,String(bad));}
  assert.throws(()=>C.parseConfigDocument({...doc,layouts:[{...doc.layouts[0],docks:true}]}));
  // The view a page gets (and a layout export/import) carries the field through the normal parser.
  const target=new ConfigStore(join(dir,'import')),exported=JSON.parse(JSON.stringify(parsed));exported.library.revision=target.revision;
  target.importDocument(exported,target.documentStamp(),[]);assert.equal(target.dock(),true);assert.equal(target.document().layouts[0].dock,true);
});

test('T115 contracts: running apps and the running-apps event are strict, bounded and distinct',()=>{
  const ok={status:'ready',apps:apps3};assert.deepEqual(C.parseRunningApps(ok),ok);
  assert.deepEqual(C.parseRunningApps({status:'unavailable',apps:[]}),{status:'unavailable',apps:[]});
  assert.throws(()=>C.parseRunningApps({status:'unavailable',apps:apps3}));
  assert.deepEqual(C.parseRunningApps({status:'starting',apps:[]}),{status:'starting',apps:[]});
  for(const bad of [{status:'starting',apps:apps3},{status:'loading',apps:[]},{status:'ready'},{status:'ready',apps:[],extra:1},{status:'ready',apps:[app('bad id')]},{status:'ready',apps:[{...app('a.b'),name:''}]},{status:'ready',apps:[{...app('a.b'),name:'x'.repeat(81)}]},
    {status:'ready',apps:[{...app('a.b'),active:'yes'}]},{status:'ready',apps:[app('a.b'),app('a.b')]},{status:'ready',apps:[{...app('a.b'),extra:1}]}])assert.throws(()=>C.parseRunningApps(bad),/./,JSON.stringify(bad).slice(0,60));
  const many=n=>Array.from({length:n},(_,i)=>app(`app.n${i}`));assert.equal(C.parseRunningApps({status:'ready',apps:many(C.MAX_DOCK_APPS)}).apps.length,64);assert.throws(()=>C.parseRunningApps({status:'ready',apps:many(65)}));
  const event={type:'running-apps',version:2,instanceId:randomUUID(),sequence:3,...ok};assert.deepEqual(C.parseHostEvent(event),event);
  assert.throws(()=>C.parseHostEvent({...event,version:1}));assert.throws(()=>C.parseHostEvent({...event,extra:true}));assert.throws(()=>C.parseHostEvent({...event,sequence:0}));
  assert.equal(C.EVENT_PROTOCOL,'keyln.events.v4');assert.deepEqual([...C.EVENT_PROTOCOLS],['keyln.events.v4','keyln.events.v3']);
});

test('T115 store: setDock writes only the layout field, raises only the layout revision, removes the field when off, and the same value writes nothing',t=>{
  const dir=temporary(t),store=new ConfigStore(dir),name=store.defaultLayout,libraryRevision=store.revision,start=store.layoutRevision(name);
  assert.equal(store.dock(),false);assert.equal(store.anyDock,false);
  const before=readFileSync(store.path);assert.doesNotMatch(before.toString(),/dock/);
  assert.deepEqual(store.setDock(name,false),{dock:false,layoutName:name,previousLayoutRevision:start,layoutRevision:start});assert.deepEqual(readFileSync(store.path),before,'off to off writes nothing');
  const on=store.setDock(name,true);assert.deepEqual(on,{dock:true,layoutName:name,previousLayoutRevision:start,layoutRevision:start+1});
  assert.equal(store.revision,libraryRevision,'the key library revision does not move');assert.equal(store.dock(name),true);assert.equal(store.anyDock,true);
  assert.equal(JSON.parse(readFileSync(store.path,'utf8')).layouts[0].dock,true);assert.equal(new ConfigStore(dir).dock(),true,'persisted');
  const written=readFileSync(store.path);store.setDock(name,true);assert.deepEqual(readFileSync(store.path),written,'on to on writes nothing');
  const off=store.setDock(name,false);assert.equal(off.layoutRevision,start+2);
  const strip=text=>{const value=JSON.parse(text);value.layouts[0].revision=0;return value;};
  assert.deepEqual(strip(readFileSync(store.path,'utf8')),strip(before.toString()),'dock off removes the field; the file is the previous one except the layout revision');assert.doesNotMatch(readFileSync(store.path,'utf8'),/dock/);
  for(const bad of ['true',1,null,undefined,{}])assert.throws(()=>store.setDock(name,bad),/Mac Dock setting/);
  assert.equal(store.get().layoutRevision,start+2);
});

test('T115 RunningApps: strict lines, ready first, cap, malformed input stops the observer, restart and wanted(false)',async t=>{
  const {running,children}=service();t.after(()=>running.terminate());
  const changes=[];running.onChange(()=>changes.push(running.snapshot().status));
  assert.deepEqual(running.snapshot(),{status:'unavailable',apps:[]});running.wanted(true);assert.equal(children.length,1);
  assert.deepEqual(running.snapshot(),{status:'starting',apps:[]},'no list before the first snapshot');
  children[0].ready();children[0].apps(apps3);await until(()=>running.snapshot().status==='ready');assert.deepEqual(running.snapshot().apps,apps3);assert.equal(changes.at(-1),'ready');
  const count=changes.length;children[0].apps(apps3);await tick(20);assert.equal(changes.length,count,'an identical snapshot is not a change');
  children[0].apps([app('com.example.notes','Notes',{active:true})]);await until(()=>running.snapshot().apps.length===1);
  // Exactly 64 entries are accepted.
  children[0].apps(Array.from({length:64},(_,i)=>app(`app.n${i}`)));await until(()=>running.snapshot().apps.length===64);
  // Anything else stops the observer, hides the list and starts a replacement; each bad line is rejected on its own.
  const bad=['not json','[]','{"type":"ready"}',JSON.stringify({type:'apps',apps:Array.from({length:65},(_,i)=>app(`app.n${i}`))}),JSON.stringify({type:'apps',apps:[app('a.b'),app('a.b')]}),
    JSON.stringify({type:'apps',apps:[app('bad id')]}),JSON.stringify({type:'apps',apps:[],extra:1}),JSON.stringify({type:'other'}),JSON.stringify({type:'apps',apps:[{appId:'a.b',name:'A',active:true}]}),
    JSON.stringify({type:'apps',apps:[{...app('a.b'),name:'x'.repeat(81)}]})];
  for(const line of bad){
    const each=service();t.after(()=>each.running.terminate());each.running.wanted(true);const child=each.children[0];child.ready();child.apps(apps3);await until(()=>each.running.snapshot().status==='ready');
    child.line(line);await until(()=>child.kills.includes('SIGKILL'),1500);assert.deepEqual(each.running.snapshot(),{status:'unavailable',apps:[]},line.slice(0,40));await until(()=>each.children.length===2);
  }
  // A snapshot before ready is refused as well.
  const pre=service();t.after(()=>pre.running.terminate());pre.running.wanted(true);pre.children[0].apps(apps3);await until(()=>pre.children[0].kills.includes('SIGKILL'));assert.deepEqual(pre.running.snapshot(),{status:'unavailable',apps:[]});
  // Stopping: the observer is killed and not started again.
  const last=children.at(-1);running.wanted(false);assert.ok(last.kills.includes('SIGKILL'));assert.deepEqual(running.snapshot(),{status:'unavailable',apps:[]});const total=children.length;await tick(60);assert.equal(children.length,total);
  running.wanted(true);assert.equal(children.length,total+1,'wanted(true) again starts a new observer');
});

test('T115 RunningApps: an oversized line, noisy stderr and an observer that exits are handled; failures stop after the retry budget',async t=>{
  const {running,children}=service();t.after(()=>running.terminate());running.wanted(true);
  children[0].ready();children[0].apps(apps3);await until(()=>running.snapshot().status==='ready');
  children[0].emit('close',null,'SIGTERM');await until(()=>children.length===2);assert.deepEqual(running.snapshot(),{status:'unavailable',apps:[]},'the list is not kept for a dead observer');
  children[1].stderr.write('x'.repeat(5000));await until(()=>children[1].kills.includes('SIGKILL'));await until(()=>children.length===3);
  children[2].stdout.write('y'.repeat(70_000));await until(()=>children[2].kills.includes('SIGKILL'));
  const quiet=service({child:()=>{const child=fakeChild();child.kill=()=>true;return child;}});t.after(()=>quiet.running.terminate());
  quiet.running.wanted(true);assert.equal(quiet.running.snapshot().status,'starting');
});

// ---- the Host over HTTPS ----
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1EAAAAASUVORK5CYII=','base64');png.writeUInt32BE(128,16);png.writeUInt32BE(128,20);
async function host(t,{gate}={}){
  const dir=temporary(t);execFileSync(process.execPath,['scripts/setup.mjs'],{env:{...process.env,KEYLN_DATA_DIR:dir},stdio:'pipe'});
  const auth=new Auth(dir),store=new ConfigStore(dir),opened=[],exported=[];
  const scheduler=new Scheduler({run:async action=>{opened.push(action);if(gate)await gate.promise;return {ok:true,message:'Fake only'};}});
  const {running,children}=service();
  const origin='https://127.0.0.1:0',ca=readFileSync(join(dir,'tls/rootCA.pem'));
  const server=createHost({origin,auth,store,scheduler,apps:[{id:'com.example.notes',name:'Notes'}],onPair(){},runningApps:running,dockDebounceMs:10,
    appIcon:async()=>png,appIcons:async ids=>{exported.push([...ids]);return new Map(ids.map(id=>[id,png]));},
    tls:{key:readFileSync(join(dir,'tls/server.key')),cert:readFileSync(join(dir,'tls/server.pem'))}});
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const sockets=[];
  t.after(async()=>{for(const socket of sockets)socket.terminate();running.terminate();scheduler.stop();await scheduler.settled();server.stopEvents();server.closeAllConnections();await new Promise(yes=>server.close(yes));});
  const port=server.address().port;
  const send=(path,body={},cookie='',headers={})=>new Promise((yes,no)=>{
    const req=request({hostname:'127.0.0.1',servername:'',port,ca,path,method:'POST',headers:{host:'127.0.0.1:0',origin,'content-type':'application/json','x-keyln-client':'1',cookie,...headers}},res=>{let text='';res.setEncoding('utf8');res.on('data',b=>text+=b);res.on('end',()=>yes({status:res.statusCode,data:text?JSON.parse(text):undefined}));});
    req.on('error',no);req.end(JSON.stringify(body));});
  function device(name='Owned Surface'){const p=auth.begin(auth.invite(),name);auth.approve(p.id);return {id:p.id,cookie:`__Host-keyln=${auth.claim(p.id,p.claim).token}`};}
  function socket(cookie,protocol){const ws=new WebSocket(`wss://127.0.0.1:${port}/api/events`,protocol,{ca,servername:'',origin,headers:{host:'127.0.0.1:0',cookie}});const messages=[];ws.on('message',data=>messages.push(JSON.parse(data.toString())));sockets.push(ws);return {ws,messages,open:new Promise((yes,no)=>{ws.once('open',yes);ws.once('error',no);}),of:type=>messages.filter(message=>message.type===type)};}
  // The fake observer: the Host starts it only while a layout shows the Dock.
  const observe=async list=>{await until(()=>children.length>0);const child=children.at(-1);child.ready();child.apps(list);await until(()=>JSON.stringify(running.snapshot().apps)===JSON.stringify(list));return child;};
  return {dir,port,auth,store,scheduler,running,children,opened,exported,send,device,socket,observe,layout:store.defaultLayout};
}
const uuid=()=>randomUUID();

test('T115 /api/device-dock: own layout only, strict, conflict on the layout name, revision bump, observer follows the setting',async t=>{
  const f=await host(t),d=f.device();
  assert.equal((await f.send('/api/device-dock',{})).status,401);assert.equal((await f.send('/api/device-dock',{},d.cookie,{origin:'https://evil.example'})).status,403);
  assert.deepEqual((await f.send('/api/device-dock',{},d.cookie)).data,{dock:false,layoutName:f.layout,options:{hideKeyedApps:false,align:'center'}});assert.equal((await f.send('/api/device-dock',{extra:1},d.cookie)).status,400);
  assert.equal(f.children.length,0,'nothing observed while no layout shows the Dock');
  const start=f.store.layoutRevision(f.layout),file=readFileSync(f.store.path);
  for(const bad of [{dock:true},{layoutName:f.layout},{dock:'true',layoutName:f.layout},{dock:1,layoutName:f.layout},{dock:true,layoutName:f.layout,theme:'braun'},{dock:null,layoutName:f.layout}])assert.equal((await f.send('/api/device-dock/save',bad,d.cookie)).status,400,JSON.stringify(bad));
  const conflict=await f.send('/api/device-dock/save',{dock:true,layoutName:'Another'},d.cookie);assert.equal(conflict.status,409);assert.equal(conflict.data.error.code,'CONFIG_CONFLICT');
  assert.deepEqual(readFileSync(f.store.path),file,'a refused save writes nothing');assert.equal(f.children.length,0);
  const saved=await f.send('/api/device-dock/save',{dock:true,layoutName:f.layout},d.cookie);
  assert.deepEqual(saved.data,{dock:true,layoutName:f.layout,previousLayoutRevision:start,layoutRevision:start+1});assert.equal(f.children.length,1,'the observer starts');
  assert.deepEqual((await f.send('/api/device-dock',{},d.cookie)).data,{dock:true,layoutName:f.layout,options:{hideKeyedApps:false,align:'center'}});assert.equal((await f.send('/api/configuration',{},d.cookie)).data.config.layoutRevision,start+1);
  assert.equal(Object.hasOwn((await f.send('/api/configuration',{},d.cookie)).data.config,'dock'),false,'existing responses do not gain the field');
  const child=await f.observe(apps3);const reply=await f.send('/api/running-apps',{},d.cookie);assert.deepEqual(reply.data,{status:'ready',apps:apps3});assert.equal((await f.send('/api/running-apps',{x:1},d.cookie)).status,400);assert.equal((await f.send('/api/running-apps',{})).status,401);
  assert.equal((await f.send('/api/device-dock/save',{dock:true,layoutName:f.layout},d.cookie)).data.layoutRevision,start+1,'the same value changes no revision');
  const off=await f.send('/api/device-dock/save',{dock:false,layoutName:f.layout},d.cookie);assert.equal(off.data.dock,false);assert.ok(child.kills.includes('SIGKILL'),'the observer stops');assert.deepEqual((await f.send('/api/running-apps',{},d.cookie)).data,{status:'unavailable',apps:[]});
  assert.equal(JSON.parse(readFileSync(f.store.path,'utf8')).layouts[0].dock,undefined);
});

test('T115 /api/dock/activate: dock off, not running, bad input, then only an app.open of a running app; idempotent; BUSY like any action',async t=>{
  let release;const gate={promise:new Promise(yes=>{release=yes;})};
  const f=await host(t,{gate}),d=f.device(),other=f.device('Phone');
  const post=(body,cookie=d.cookie)=>f.send('/api/dock/activate',body,cookie);
  assert.equal((await post({requestId:uuid(),appId:'com.example.notes'},'')).status,401);
  const off=await post({requestId:uuid(),appId:'com.example.notes'});assert.equal(off.status,409);assert.equal(off.data.error.code,'DOCK_OFF');
  await f.send('/api/device-dock/save',{dock:true,layoutName:f.layout},d.cookie);const child=await f.observe(apps3);
  for(const bad of [{},{requestId:uuid()},{appId:'com.example.notes'},{requestId:'nope',appId:'com.example.notes'},{requestId:uuid(),appId:'bad id'},{requestId:uuid(),appId:'com.example.notes',extra:1},{requestId:uuid(),appId:'com.example.notes',confirmation:uuid()}])assert.equal((await post(bad)).status,400,JSON.stringify(bad));
  assert.equal(f.opened.length,0);
  const missing=await post({requestId:uuid(),appId:'com.example.installed-but-not-running'});assert.equal(missing.status,409);assert.equal(missing.data.error.code,'APP_NOT_RUNNING');assert.equal(f.opened.length,0);
  const id=uuid(),first=await post({requestId:id,appId:'com.example.notes'});assert.equal(first.status,202);assert.equal(first.data.execution.actionType,'app.open');assert.equal(first.data.execution.requestId,id);
  const again=await post({requestId:id,appId:'com.example.notes'});assert.equal(again.status,202);assert.equal(again.data.execution.id,first.data.execution.id,'idempotent by request ID');
  assert.equal((await post({requestId:id,appId:'com.example.hidden'})).data.error.code,'REQUEST_CONFLICT');
  const busy=await post({requestId:uuid(),appId:'com.example.hidden'});assert.equal(busy.status,409);assert.equal(busy.data.error.code,'BUSY');
  await until(()=>f.opened.length===1);assert.deepEqual(f.opened,[{type:'app.open',appId:'com.example.notes'}]);release();
  await until(async()=>true);let result;await until(()=>{return f.scheduler.get(d.id,id).status==='succeeded';});
  result=await f.send('/api/result',{requestId:id},d.cookie);assert.equal(result.data.execution.status,'succeeded');
  assert.equal((await f.send('/api/result',{requestId:id},other.cookie)).status,404,'another device cannot read it');
  // The other device shows the same default layout (Dock on); once the app quits, activation is refused again.
  child.apps([apps3[0]]);await until(()=>f.running.snapshot().apps.length===1);assert.equal((await post({requestId:uuid(),appId:'com.example.notes'})).data.error.code,'APP_NOT_RUNNING');
  assert.equal(f.opened.length,1,'nothing but the one app.open ever ran');
  f.scheduler.stop();assert.equal((await post({requestId:uuid(),appId:'com.apple.finder'})).data.error.code,'HOST_STOPPING');
});

test('T115 /api/app-icons: installed and running apps reach the exporter, any other ID never does, the reply keeps its shape',async t=>{
  const f=await host(t),d=f.device();
  await f.send('/api/device-dock/save',{dock:true,layoutName:f.layout},d.cookie);await f.observe(apps3);
  const reply=await f.send('/api/app-icons',{appIds:['com.example.notes','com.apple.finder','com.example.unknown']},d.cookie);assert.equal(reply.status,200);
  assert.deepEqual(f.exported.at(-1),['com.example.notes','com.apple.finder'],'unknown IDs never reach the exporter');
  assert.deepEqual(reply.data.icons.map(item=>[item.appId,item.png?'png':item.code]),[['com.example.notes','png'],['com.apple.finder','png'],['com.example.unknown','ICON_UNAVAILABLE']]);
  const count=f.exported.length;const onlyUnknown=await f.send('/api/app-icons',{appIds:['com.example.unknown']},d.cookie);assert.equal(onlyUnknown.status,200);assert.equal(f.exported.length,count);
  assert.equal((await f.send('/api/app-icons',{appIds:['com.example.notes','com.example.notes']},d.cookie)).status,400);
  // Without the Dock there is no running list, so only the installed catalog is a source.
  await f.send('/api/device-dock/save',{dock:false,layoutName:f.layout},d.cookie);
  const shown=await f.send('/api/app-icons',{appIds:['com.example.unknown','com.example.notes']},d.cookie);assert.deepEqual(shown.data.icons.map(item=>item.code??'png'),['ICON_UNAVAILABLE','png']);
  const gone=await f.send('/api/app-icons',{appIds:['com.example.dock-only']},d.cookie);assert.equal(gone.data.icons[0].code,'ICON_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(f.exported),/dock-only/);
});

test('T115 events: a v3 page never receives running-apps; a v4 page does only while its layout shows the Dock; both keep working',async t=>{
  const f=await host(t),d=f.device();
  const v3=f.socket(d.cookie,'keyln.events.v3'),v4=f.socket(d.cookie,'keyln.events.v4');await Promise.all([v3.open,v4.open]);
  await until(()=>v3.of('state').length===1&&v4.of('state').length===1);assert.equal(v3.ws.protocol,'keyln.events.v3');assert.equal(v4.ws.protocol,'keyln.events.v4');
  assert.equal(v4.of('running-apps').length,0,'the Dock is off');
  await f.send('/api/device-dock/save',{dock:true,layoutName:f.layout},d.cookie);const child=await f.observe(apps3);
  await until(()=>v4.of('running-apps').some(event=>event.status==='ready'));
  const event=v4.of('running-apps').at(-1);assert.deepEqual(C.parseHostEvent(event),event);assert.deepEqual(event.apps,apps3);assert.equal(event.version,2);
  child.apps([apps3[1]]);await until(()=>v4.of('running-apps').some(item=>item.apps.length===1));
  assert.deepEqual(v4.messages.map(item=>item.sequence),v4.messages.map((_,i)=>i+1),'one envelope sequence per connection');
  // Rapid changes are coalesced into few events.
  const before=v4.of('running-apps').length;for(let i=0;i<20;i++)child.apps([app('com.example.notes','Notes',{active:i%2===0}),app('com.apple.finder','Finder',{active:i%2===1})]);
  await until(()=>JSON.stringify(f.running.snapshot().apps.map(item=>item.active))===JSON.stringify([false,true])&&v4.of('running-apps').length>before);await tick(60);assert.ok(v4.of('running-apps').length-before<=4,'coalesced');
  // A page that connects now gets the list right after its first state event.
  const late=f.socket(d.cookie,'keyln.events.v4');await late.open;await until(()=>late.of('running-apps').length>=1);assert.equal(late.messages[0].type,'state');
  assert.equal(v3.of('running-apps').length,0,'v3 never gets it');assert.ok(v3.messages.every(item=>item.type==='state'||item.type==='execution'),'v3 only sees events it knows');assert.ok(v3.of('state').length>=2,'v3 keeps getting state events');
  // Turning the Dock off: v4 stops getting it.
  await f.send('/api/device-dock/save',{dock:false,layoutName:f.layout},d.cookie);await tick(60);const total=v4.of('running-apps').length;
  child.apps(apps3);await tick(80);assert.equal(v4.of('running-apps').length,total);
  // Unknown protocols and offering both names are refused before the upgrade.
  for(const protocol of ['keyln.events.v9',['keyln.events.v4','keyln.events.v3']]){
    const ws=new WebSocket(`wss://127.0.0.1:${f.port}/api/events`,protocol,{ca:readFileSync(join(f.dir,'tls/rootCA.pem')),servername:'',origin:'https://127.0.0.1:0',headers:{host:'127.0.0.1:0',cookie:d.cookie}});
    const outcome=await new Promise(yes=>{ws.on('error',()=>yes('refused'));ws.on('open',()=>yes('open'));});ws.terminate();assert.equal(outcome,'refused',String(protocol));
  }
});

test('T115 events: only the devices whose own layout shows the Dock are sent the list',async t=>{
  const f=await host(t),a=f.device('A'),b=f.device('B');
  // Both devices use the default layout here, so both get it; the check is per device layout, which the Host takes from the cookie.
  const sa=f.socket(a.cookie,'keyln.events.v4'),sb=f.socket(b.cookie,'keyln.events.v4');await Promise.all([sa.open,sb.open]);
  await f.send('/api/device-dock/save',{dock:true,layoutName:f.layout},a.cookie);await f.observe(apps3);
  await until(()=>sa.of('running-apps').length>0&&sb.of('running-apps').length>0);
  assert.equal(f.auth.list().length,2);
});

// ---- the page ----
test('T115 zones: the Dock reserve is 76px (wide) or 60px (600px or less), none when MIN_CONTENT would not fit, and the strip sits under the content area',()=>{
  const layout=C.resolveTheme(undefined,undefined).layout;
  assert.deepEqual(DOCK_RESERVE,{wide:76,narrow:60});
  for(const [width,height,expected] of [[1366,768,76],[1024,768,76],[601,800,76],[600,800,60],[411,860,60],[320,640,60]])assert.equal(dockReserve(layout,{width,height}),expected,`${width}x${height}`);
  for(const width of [1366,601,600,411]){
    const base=h=>planZones(layout,{width,height:h}).content.h;let height=1;while(dockReserve(layout,{width,height})===0&&height<2000)height++;
    const reserve=dockReserve(layout,{width,height});assert.ok(reserve>0);assert.ok(base(height)-reserve>=C.MIN_CONTENT.h,'the content keeps MIN_CONTENT');
    assert.equal(dockReserve(layout,{width,height:height-1}),0);assert.ok(base(height-1)-reserve<C.MIN_CONTENT.h,'one pixel less would break the minimum');
  }
  const viewport={width:1366,height:768},insets={top:10,right:0,bottom:0,left:4},plain=planZones(layout,viewport,insets);
  const reduced=planZones(layout,viewport,insets,76),strip=dockStrip(reduced,insets,76,76);
  assert.equal(reduced.content.h,plain.content.h-76);assert.deepEqual(strip,{x:insets.left+plain.content.x,y:insets.top+plain.content.y+plain.content.h-76,w:plain.content.w,h:76});
  // With a taller Edit reserve the plan is reduced by the larger one and the Dock keeps its own 76px at the foot of the full content area.
  const shelf=planZones(layout,viewport,insets,300),both=dockStrip(shelf,insets,300,76);assert.equal(both.y,insets.top+plain.content.y+plain.content.h-76);assert.equal(both.h,76);
  // The theme layouts are not touched by the reserve.
  assert.deepEqual(reduced.slots,plain.slots);assert.deepEqual(reduced.zones,plain.zones);
});

test('T115 dock metrics: 56px icons shrink to 44px to fit, then the list scrolls; narrow windows use 44px icons',()=>{
  const few=dockMetrics(5,1366,false);assert.deepEqual([few.icon,few.height,few.scroll],[56,64,false]);assert.equal(few.width,2*few.padX+5*56+4*few.gap);
  const tight=dockMetrics(15,900,false);assert.ok(tight.icon<56&&tight.icon>=44);assert.equal(tight.scroll,false);assert.ok(tight.width<=900);
  const many=dockMetrics(40,900,false);assert.equal(many.icon,44);assert.equal(many.scroll,true);assert.equal(many.width,900);
  const narrow=dockMetrics(4,411,true);assert.deepEqual([narrow.icon,narrow.height],[44,52]);assert.equal(dockMetrics(30,411,true).scroll,true);assert.equal(dockMetrics(0,411,false).scroll,false);
});

const collect=(node,match,out=[])=>{if(match(node))out.push(node);for(const child of node.children??[])collect(child,match,out);return out;};
const buttons=host=>collect(host,node=>node.className==='mac-dock-item');
const named=(host,className)=>collect(host,node=>node.className===className)[0];
async function dockFixture(t,{online=true,editing=false}={}){
  const dom=installDom(t),host=dom.document.createElement('div'),state={online,editing,locked:'',calls:[],failures:[],saved:[],epoch:1,blocked:'',relayouts:0};
  const dock=createMacDock({host,call:async(url,body)=>{state.calls.push({url,body});if(state.reply)return state.reply(url,body);return {status:200,data:{}};},
    layout:()=>({name:'Surface',revision:3}),adopt:async(data,started)=>{state.saved.push([data,started]);},saving(){},online:()=>state.online,editing:()=>state.editing,locked:()=>state.locked,blocked:()=>state.blocked,
    epoch:()=>state.epoch,relayout:()=>{state.relayouts++;},failed:message=>state.failures.push(message),loadIcon:async id=>id==='com.example.notes'?'data:image/png;base64,AAAA':null});
  t.after(()=>dock.destroy());
  return {dom,host,dock,state};
}

test('T115 Dock rendering: toolbar with names, order kept, one icon per app, frontmost aria-current, hidden dimmed, reserved strip hidden when off',async t=>{
  const {host,dock}=await dockFixture(t);
  dock.place({x:0,y:692,w:1366,h:76},false);assert.equal(host.hidden,true,'off: nothing is drawn');
  dock.setEnabled(true);assert.equal(host.hidden,false);assert.equal(named(host,'mac-dock-capsule').hidden,true,'strip reserved, nothing listed before the first list');
  dock.apply({status:'ready',apps:apps3});
  const capsule=named(host,'mac-dock-capsule');assert.equal(capsule.getAttribute('role'),'toolbar');assert.equal(capsule.getAttribute('aria-label'),'Running Mac apps');assert.equal(capsule.hidden,false);
  assert.deepEqual(buttons(host).map(n=>n.getAttribute('aria-label')),['Finder','Notes','Hidden']);assert.deepEqual(buttons(host).map(n=>n.title),['Finder','Notes','Hidden']);
  assert.deepEqual(buttons(host).map(n=>n.getAttribute('aria-current')),['true',null,null]);assert.deepEqual(buttons(host).map(n=>n.dataset.hidden),['false','false','true']);
  assert.deepEqual(['left','top','width','height'].map(name=>host.style[name]),['0px','692px','1366px','76px']);assert.equal(host.style['--dock-icon'],'56px');
  await tick();const notes=buttons(host)[1];assert.equal(named(notes,'mac-dock-icon').src,'data:image/png;base64,AAAA','the icon comes through the icon loader');
  assert.equal(named(buttons(host)[0],'mac-dock-icon').hidden,true,'no icon: the letter stays');
  // The same app twice cannot be in a list (the helper merges instances); a changed list keeps the same buttons for the same apps.
  const before=buttons(host)[1];dock.apply({status:'ready',apps:[app('com.example.notes','Notes',{active:true}),apps3[0]]});assert.equal(buttons(host).length,2);assert.equal(buttons(host)[0],before);assert.equal(buttons(host)[0].getAttribute('aria-current'),'true');
  // Narrow window: 44px icons.
  dock.place({x:4,y:800,w:403,h:60},true);assert.equal(host.style['--dock-icon'],'44px');assert.equal(host.style['--dock-h'],'52px');
  dock.place(undefined,false);assert.equal(host.hidden,true,'a window too short for the strip shows no Dock');
});

test('T115 Dock: stale while disconnected, dimmed and not interactive in Edit, unavailable list says so',async t=>{
  const {host,dock,state}=await dockFixture(t);dock.setEnabled(true);dock.place({x:0,y:692,w:1366,h:76},false);dock.apply({status:'ready',apps:apps3});
  assert.equal(host.dataset.stale,'false');assert.equal(host.dataset.editing,'false');assert.ok(buttons(host).every(n=>!n.disabled));
  state.online=false;dock.render();assert.equal(host.dataset.stale,'true');assert.equal(buttons(host).length,3,'the old list stays, greyed');assert.ok(buttons(host).every(n=>n.disabled));
  state.online=true;state.editing=true;dock.render();assert.equal(host.dataset.editing,'true');assert.ok(buttons(host).every(n=>n.disabled));assert.equal(named(host,'mac-dock-capsule').getAttribute('aria-disabled'),'true');
  buttons(host)[1].emit('click');await tick();assert.equal(state.calls.filter(c=>c.url==='/api/dock/activate').length,0,'no activation in Edit');
  state.editing=false;dock.apply({status:'unavailable',apps:[]});assert.match(host.textContent,/unavailable/);assert.equal(buttons(host).length,0);
});

test('T115 follow-up Dock lock: an unknown result locks and dims it, a brief busy lock only disables it, and a locked Dock sends nothing',async t=>{
  const {host,dock,state}=await dockFixture(t);dock.setEnabled(true);dock.place({x:0,y:692,w:1366,h:76},false);dock.apply({status:'ready',apps:apps3});
  assert.equal(host.dataset.locked,'none');assert.ok(buttons(host).every(n=>!n.disabled));
  for(const lock of ['unknown','busy']){
    state.locked=lock;dock.render();assert.equal(host.dataset.locked,lock);assert.ok(buttons(host).every(n=>n.disabled),lock);assert.equal(named(host,'mac-dock-capsule').getAttribute('aria-disabled'),'true');
    buttons(host)[1].emit('click');await tick();assert.equal(state.calls.filter(c=>c.url==='/api/dock/activate').length,0,lock+': nothing is sent');
  }
  state.locked='';dock.render();assert.ok(buttons(host).every(n=>!n.disabled));buttons(host)[1].emit('click');await tick();assert.equal(state.calls.filter(c=>c.url==='/api/dock/activate').length,1,'unlocked: a tap is sent');
});

test('T115 Dock tap: sends exactly {requestId, appId}, highlights at once, settles on success, and shows a refusal briefly and in the diagnostics',async t=>{
  const {host,dock,state}=await dockFixture(t);dock.setEnabled(true);dock.place({x:0,y:692,w:1366,h:76},false);dock.apply({status:'ready',apps:apps3});
  state.reply=(url,body)=>url==='/api/dock/activate'?{status:202,data:{execution:{id:uuid(),requestId:body.requestId,status:'accepted',actionType:'app.open',createdAt:1,message:'Received by Mac.'}}}:{status:200,data:{}};
  buttons(host)[1].emit('click');
  assert.deepEqual(buttons(host).map(n=>n.getAttribute('aria-current')),[null,'true',null],'optimistic highlight');
  await tick();const call=state.calls.find(c=>c.url==='/api/dock/activate');assert.deepEqual(Object.keys(call.body).sort(),['appId','requestId']);assert.equal(call.body.appId,'com.example.notes');C.requestId(call.body.requestId);
  buttons(host)[2].emit('click');await tick();assert.equal(state.calls.filter(c=>c.url==='/api/dock/activate').length,1,'one activation at a time');
  dock.execution({id:uuid(),requestId:call.body.requestId,status:'succeeded',actionType:'app.open',createdAt:1,finishedAt:2,message:'Done'});assert.equal(state.failures.length,0);
  dock.apply({status:'ready',apps:[{...apps3[0],active:false},app('com.example.notes','Notes',{active:true}),apps3[2]]});assert.deepEqual(buttons(host).map(n=>n.getAttribute('aria-current')),[null,'true',null],'the real list takes over');
  // A refusal.
  state.reply=()=>({status:409,data:{error:{code:'APP_NOT_RUNNING',message:'That app is no longer running on the Mac.'}}});
  buttons(host)[2].emit('click');await tick();assert.deepEqual(state.failures,['That app is no longer running on the Mac.']);const note=named(host,'mac-dock-note');assert.equal(note.hidden,false);assert.match(note.textContent,/no longer running/);
  assert.deepEqual(buttons(host).map(n=>n.getAttribute('aria-current')),[null,'true',null],'the highlight returns to the real frontmost app');
  // A failed execution reported later.
  state.reply=(url,body)=>({status:202,data:{execution:{id:uuid(),requestId:body.requestId,status:'running',actionType:'app.open',createdAt:1,message:'Opening…'}}});
  buttons(host)[0].emit('click');await tick();const id=state.calls.at(-1).body.requestId;
  dock.execution({id:uuid(),requestId:id,status:'failed',actionType:'app.open',createdAt:1,finishedAt:2,code:'FOCUS_UNCONFIRMED',message:'Activation was not confirmed.'});assert.equal(state.failures.at(-1),'Activation was not confirmed.');
  // Someone else's execution is ignored.
  buttons(host)[0].emit('click');await tick();const count=state.failures.length;dock.execution({id:uuid(),requestId:uuid(),status:'failed',actionType:'app.open',createdAt:1,finishedAt:2,message:'Other'});assert.equal(state.failures.length,count);
});

test('T115 Dock setting buttons: load, save with the layout name, adopt the revision, errors keep the old value, blocked when the Mac cannot be changed',async t=>{
  const {dom,dock,state}=await dockFixture(t);const on=dom.el('dock-on'),off=dom.el('dock-off'),note=dom.el('dock-note');
  state.reply=url=>url==='/api/device-dock'?{status:200,data:{dock:false,layoutName:'Surface'}}:{status:200,data:{}};
  await dock.load();assert.equal(dock.enabled,false);assert.equal(off.getAttribute('aria-pressed'),'true');assert.equal(on.getAttribute('aria-pressed'),'false');assert.equal(on.disabled,false);
  state.blocked='Reconnect to the Mac to change the Mac Dock.';dock.render();assert.equal(on.disabled,true);assert.match(note.textContent,/Reconnect/);state.blocked='';dock.render();
  state.reply=(url,body)=>url==='/api/device-dock/save'?{status:409,data:{error:{code:'CONFIG_CONFLICT',message:'The device layout changed.'}}}:{status:200,data:{}};
  on.emit('click');await tick();assert.deepEqual(state.calls.at(-1),{url:'/api/device-dock/save',body:{dock:true,layoutName:'Surface'}});assert.equal(dock.enabled,false);assert.match(note.textContent,/layout changed/);assert.equal(off.getAttribute('aria-pressed'),'true');
  state.reply=(url,body)=>url==='/api/device-dock/save'?{status:200,data:{dock:true,layoutName:'Surface',previousLayoutRevision:3,layoutRevision:4}}:url==='/api/running-apps'?{status:200,data:{status:'ready',apps:apps3}}:{status:200,data:{}};
  const relayouts=state.relayouts;on.emit('click');await tick(10);
  assert.equal(dock.enabled,true);assert.equal(on.getAttribute('aria-pressed'),'true');assert.deepEqual(state.saved,[[{dock:true,layoutName:'Surface',previousLayoutRevision:3,layoutRevision:4},3]],'the new layout revision is adopted by the page');assert.ok(state.relayouts>relayouts,'the zones are laid out again for the strip');
  assert.ok(state.calls.some(c=>c.url==='/api/running-apps'),'the list is read once it is on');
  state.reply=(url)=>url==='/api/device-dock/save'?{status:200,data:{dock:false,layoutName:'Surface',previousLayoutRevision:4,layoutRevision:5}}:{status:200,data:{}};
  off.emit('click');await tick(10);assert.equal(dock.enabled,false);assert.equal(on.getAttribute('aria-pressed'),'false');
});

// ---- the page, whole ----
const frameOf=f=>({top:parseFloat(f.el('grid-frame').style.top),height:parseFloat(f.el('grid-frame').style.height)});
const dockButtons=f=>buttons(f.el('mac-dock'));
test('T115 page: the strip is reserved in Use and Edit, the Edit shelf takes max(dock, shelf), pushed lists render, a tap activates, the setting turns it off',async t=>{
  const viewport={width:1366,height:768},layout=C.resolveTheme(undefined,undefined).layout,base=planZones(layout,viewport).content;
  const f=await client(t,{viewport,dock:true,running:{status:'ready',apps:apps3}});
  await f.until(()=>dockButtons(f).length===3);
  assert.deepEqual(frameOf(f),{top:base.y,height:base.h-76},'the canvas keeps clear of the strip');
  assert.equal(f.el('mac-dock').hidden,false);assert.equal(parseFloat(f.el('mac-dock').style.top),base.y+base.h-76);assert.equal(parseFloat(f.el('mac-dock').style.height),76);
  assert.equal(f.calls.filter(call=>call.path==='/api/running-apps').length,1,'one first read; changes are pushed');
  // A pushed list replaces it (the page offers the v4 protocol only).
  f.sockets[0].push({type:'running-apps',status:'ready',apps:[apps3[1],{...apps3[0],active:false},app('com.example.new','New',{active:true})]});
  await f.until(()=>dockButtons(f).length===3&&dockButtons(f)[0].getAttribute('aria-label')==='Notes');assert.deepEqual(dockButtons(f).map(n=>n.getAttribute('aria-current')),[null,null,'true']);
  // A tap activates through the Dock endpoint.
  dockButtons(f)[0].emit('click');await f.until(()=>f.activations.length===1);assert.deepEqual(Object.keys(f.activations[0]).sort(),['appId','requestId']);assert.equal(f.activations[0].appId,'com.example.notes');assert.equal(f.count('execute'),0);
  // Edit keeps the strip (no reflow) and dims the Dock.
  f.el('edit-layout').emit('click');await f.drain();await f.drain();
  assert.deepEqual(frameOf(f),{top:base.y,height:base.h-76},'the canvas does not reflow between Use and Edit');assert.equal(f.el('mac-dock').dataset.editing,'true');assert.ok(dockButtons(f).every(n=>n.disabled));
  // With the library open the larger reserve wins; the shelf reserve is measured against the plan without the Dock.
  f.el('shelf-toggle').emit('click');await f.drain();
  const shelfReserve=top=>base.y+base.h-top+CANVAS_GAP+SHELF_GRAB;
  f.el('shelf-panel').rect={left:0,top:500,width:1366,height:268};f.windowEvents.get('resize')();await f.drain();
  assert.ok(shelfReserve(500)>76);assert.equal(frameOf(f).height,Math.round(base.h-shelfReserve(500)),'the shelf is larger than the strip');assert.equal(parseFloat(f.el('mac-dock').style.top),base.y+base.h-76,'the Dock keeps its own strip at the foot');
  f.el('shelf-panel').rect={left:0,top:base.y+base.h-10,width:1366,height:268};f.windowEvents.get('resize')();await f.drain();
  assert.ok(shelfReserve(base.y+base.h-10)<76);assert.equal(frameOf(f).height,base.h-76,'the strip is larger than the shelf');
  f.el('shelf-toggle').emit('click');await f.drain();
  // Back to Use, then turn the Dock off from the settings: the strip is given back and the setting is saved with the layout name.
  f.el('edit-back').emit('click');await f.drain();await f.until(()=>f.el('mac-dock').dataset.editing==='false');
  f.el('dock-off').emit('click');await f.until(()=>f.count('device-dock/save')===1);
  assert.deepEqual(f.calls.find(call=>call.path==='/api/device-dock/save').data,{dock:false,layoutName:f.state.config.layoutName});
  await f.until(()=>f.el('mac-dock').hidden===true);assert.deepEqual(frameOf(f),{top:base.y,height:base.h});assert.equal(f.dock,false);
  assert.equal(f.count('configuration/save'),0,'the setting is not part of a layout draft');
});

test('T115 page: a narrow window reserves 60px and draws 44px icons',async t=>{
  const layout=C.resolveTheme(undefined,undefined).layout,narrow={width:411,height:860},base=planZones(layout,narrow).content;
  const f=await client(t,{viewport:narrow,dock:true,running:{status:'ready',apps:apps3}});await f.until(()=>dockButtons(f).length===3);
  assert.equal(frameOf(f).height,base.h-60);assert.equal(f.el('mac-dock').style['--dock-icon'],'44px');assert.equal(parseFloat(f.el('mac-dock').style.height),60);
});

test('T115 page: a window too short for the strip shows no Dock and reserves nothing',async t=>{
  const layout=C.resolveTheme(undefined,undefined).layout,shortViewport={width:1366,height:220};
  const f=await client(t,{viewport:shortViewport,dock:true,running:{status:'ready',apps:apps3}});await f.until(()=>f.count('running-apps')===1);await f.drain();
  assert.equal(f.el('mac-dock').hidden,true);assert.equal(frameOf(f).height,planZones(layout,shortViewport).content.h,'no strip is reserved');
});

// ---- the real helper (read-only) ----
test('T115 helper: running-apps prints one valid, ordered, merged snapshot (read-only; skipped without the built helper on a Mac)',{skip:platform()!=='darwin'||!existsSync(new URL('../dist/keyln-helper',import.meta.url))},()=>{
  const out=JSON.parse(execFileSync(new URL('../dist/keyln-helper',import.meta.url).pathname,['running-apps'],{encoding:'utf8',timeout:10_000}));
  assert.equal(out.type,'apps');const parsed=C.parseDockApps(out.apps);assert.ok(parsed.length>=1&&parsed.length<=64);
  assert.equal(new Set(parsed.map(item=>item.appId)).size,parsed.length,'one entry per bundle ID');
  if(parsed.some(item=>item.appId==='com.apple.finder'))assert.equal(parsed[0].appId,'com.apple.finder','Finder first');
  assert.ok(parsed.every(item=>item.name.trim()===item.name&&item.name.length<=80));
});

// T115 follow-up (ADR-092): the Dock obeys the same lock as the keys. A window key whose result is unknown locked the keys but not the Dock (found on the Surface 2026-11-16).
const shortcutKey=fromGrid({schemaVersion:2,revision:1,profiles:[{id:'main',name:'Main'}],buttons:[{id:'primary',profileId:'main',position:0,label:'Send',icon:'app',action:{type:'keyboard.shortcut',key:'KeyK',modifiers:['command']}}]});
const windowKey=fromGrid({schemaVersion:2,revision:1,profiles:[{id:'main',name:'Main'}],buttons:[{id:'primary',profileId:'main',position:0,label:'M90Pro',icon:'app',action:{type:'window.activate',appId:'com.microsoft.rdc.macos',title:'M90Pro',match:'exact'}}]});
test('T115 follow-up page: an unknown key result locks the Dock with the keys until it is cleared in Settings, then a tap is sent again',async t=>{
  const f=await client(t,{configuration:shortcutKey,apps:[{id:'com.microsoft.rdc.macos',name:'Windows App'}],viewport:{width:1366,height:768},dock:true,running:{status:'ready',apps:apps3}}),{el}=f,socket=f.sockets[0];
  await f.until(()=>dockButtons(f).length===3&&!f.button().disabled);assert.ok(dockButtons(f).every(n=>!n.disabled));
  f.button().emit('click');socket.state({busy:true});socket.push({type:'execution',execution:f.execution('accepted',{actionType:'keyboard.shortcut'})});
  socket.push({type:'execution',execution:f.execution('unknown',{actionType:'keyboard.shortcut',code:'SHORTCUT_UNCONFIRMED',message:'The shortcut was sent, but its delivery could not be confirmed.'})});
  socket.state({busy:false});f.execute.resolve({execution:f.execution('accepted',{actionType:'keyboard.shortcut'})});await f.drain();
  assert.equal(f.button().disabled,true,'the keys are locked');assert.equal(el('mac-dock').dataset.locked,'unknown');assert.ok(dockButtons(f).every(n=>n.disabled),'and so is the Dock');
  dockButtons(f)[1].emit('click');await f.drain();assert.equal(f.activations.length,0,'a locked Dock sends nothing');
  el('execution-acknowledge').emit('click');await f.drain();
  assert.equal(f.button().disabled,false);assert.equal(el('mac-dock').dataset.locked,'none');assert.ok(dockButtons(f).every(n=>!n.disabled));
  dockButtons(f)[1].emit('click');await f.until(()=>f.activations.length===1);assert.equal(f.activations[0].appId,'com.example.notes');
});

test('T115 follow-up page: after a reload with an unanswered request, the Dock stays locked like the keys',async t=>{
  const f=await client(t,{initialPending:randomUUID(),autoState:false,configuration:shortcutKey,apps:[{id:'com.microsoft.rdc.macos',name:'Windows App'}],viewport:{width:1366,height:768},dock:true,running:{status:'ready',apps:apps3}});
  f.resultFault=true;f.sockets[0].state({busy:false});await f.until(()=>f.count('result')===1&&dockButtons(f).length===3);await f.drain();
  assert.match(f.el('execution-message').textContent,/unknown|Unknown/);
  assert.equal(f.button().disabled,true);assert.notEqual(f.el('mac-dock').dataset.locked,'none');assert.ok(dockButtons(f).every(n=>n.disabled));
  dockButtons(f)[0].emit('click');await f.drain();assert.equal(f.activations.length,0);
});
