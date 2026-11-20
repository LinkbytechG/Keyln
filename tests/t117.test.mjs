import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {request} from 'node:https';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {WebSocket} from 'ws';
import * as C from '../dist/packages/contracts/index.js';
import {ConfigStore} from '../dist/apps/host/store.js';
import {Auth} from '../dist/apps/host/auth.js';
import {Scheduler} from '../dist/apps/host/scheduler.js';
import {createHost} from '../dist/apps/host/server.js';
import {RunningApps} from '../dist/apps/host/running-apps.js';
import {createMacDock,DOCK_OPTION_ROWS} from '../dist/apps/web/mac-dock.js';
import {installDom} from './helpers/widget-dom.mjs';
import {client} from './helpers/client-harness.mjs';
import {fromGrid} from './helpers/layout.mjs';

// T117 (ADR-101): the Mac Dock settings window and its first option, "Hide apps that have an Open app key".
const temporary=t=>{const dir=mkdtempSync(join(tmpdir(),'keyln-t117-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
const tick=(ms=0)=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(condition,ms=3000)=>{const end=Date.now()+ms;while(!condition()){if(Date.now()>end)throw new Error('Condition not reached in time');await tick(10);}};
const app=(appId,name=appId,extra={})=>({appId,name,active:false,hidden:false,...extra});
const apps3=[app('com.apple.finder','Finder',{active:true}),app('com.example.notes','Notes'),app('com.example.hidden','Hidden',{hidden:true})];
const clone=value=>JSON.parse(JSON.stringify(value));

test('T117 contracts: layout.dockOptions is written only with known options set to true; absent round-trips byte-identical; every other value is refused',t=>{
  const dir=temporary(t),doc=new ConfigStore(dir).document();
  assert.equal(Object.hasOwn(doc.layouts[0],'dockOptions'),false);
  const off=C.parseConfigDocument(clone(doc));assert.equal(JSON.stringify(off),JSON.stringify(doc),'a document without the field is unchanged by the parser');assert.doesNotMatch(JSON.stringify(off),/dockOptions/);
  assert.deepEqual(C.DOCK_OPTION_KEYS,['hideKeyedApps','align']);
  const on=clone(doc);on.layouts[0].dockOptions={hideKeyedApps:true};
  const parsed=C.parseConfigDocument(on);assert.deepEqual(parsed.layouts[0].dockOptions,{hideKeyedApps:true});assert.deepEqual(C.layoutDockOptions(parsed),{hideKeyedApps:true,align:'center'});assert.deepEqual(C.layoutDockOptions(off),{hideKeyedApps:false,align:'center'});
  assert.equal(C.layoutDock(parsed),false,'independent of dock');assert.deepEqual(C.parseConfigDocument(clone(parsed)),parsed);assert.equal(JSON.stringify(C.parseConfigDocument(clone(parsed))),JSON.stringify(parsed));
  const both=clone(on);both.layouts[0].dock=true;assert.equal(C.parseConfigDocument(both).layouts[0].dock,true);
  for(const bad of [{},{hideKeyedApps:false},{hideKeyedApps:1},{hideKeyedApps:'true'},{hideKeyedApps:null},{other:true},{hideKeyedApps:true,other:true},{hideKeyedApps:true,other:false},[],true,false,'x',null,0]){
    const doc2=clone(doc);doc2.layouts[0].dockOptions=bad;assert.throws(()=>C.parseConfigDocument(doc2),/./,JSON.stringify(bad));}
  assert.throws(()=>C.parseConfigDocument({...doc,layouts:[{...doc.layouts[0],dockOption:{hideKeyedApps:true}}]}));
  const target=new ConfigStore(join(dir,'import')),exported=clone(parsed);exported.library.revision=target.revision;
  target.importDocument(exported,target.documentStamp(),[]);assert.deepEqual(target.dockOptions(),{hideKeyedApps:true,align:'center'});assert.deepEqual(target.document().layouts[0].dockOptions,{hideKeyedApps:true});
});

test('T117 store: setDockOptions merges, writes nothing for the same value, removes the field with the last option, raises only the layout revision and survives the Dock being turned off',t=>{
  const dir=temporary(t),store=new ConfigStore(dir),name=store.defaultLayout,libraryRevision=store.revision,start=store.layoutRevision(name);
  assert.deepEqual(store.dockOptions(),{hideKeyedApps:false,align:'center'});
  const before=readFileSync(store.path);
  assert.deepEqual(store.setDockOptions(name,{hideKeyedApps:false}),{options:{hideKeyedApps:false,align:'center'},layoutName:name,previousLayoutRevision:start,layoutRevision:start});assert.deepEqual(readFileSync(store.path),before,'off to off writes nothing');
  const on=store.setDockOptions(name,{hideKeyedApps:true});assert.deepEqual(on,{options:{hideKeyedApps:true,align:'center'},layoutName:name,previousLayoutRevision:start,layoutRevision:start+1});
  assert.equal(store.revision,libraryRevision,'the key library revision does not move');assert.deepEqual(store.dockOptions(name),{hideKeyedApps:true,align:'center'});
  assert.deepEqual(JSON.parse(readFileSync(store.path,'utf8')).layouts[0].dockOptions,{hideKeyedApps:true});assert.deepEqual(new ConfigStore(dir).dockOptions(),{hideKeyedApps:true,align:'center'},'persisted');
  const written=readFileSync(store.path);store.setDockOptions(name,{hideKeyedApps:true});assert.deepEqual(readFileSync(store.path),written,'on to on writes nothing');
  // The Dock itself is independent: turning it on and off keeps the options.
  store.setDock(name,true);assert.deepEqual(store.dockOptions(),{hideKeyedApps:true,align:'center'});store.setDock(name,false);assert.deepEqual(store.dockOptions(),{hideKeyedApps:true,align:'center'},'kept when the Dock is turned off');assert.equal(store.dock(),false);
  const level=store.layoutRevision(name);
  const off=store.setDockOptions(name,{hideKeyedApps:false});assert.equal(off.layoutRevision,level+1);assert.doesNotMatch(readFileSync(store.path,'utf8'),/dockOptions/,'the last option off removes the field');
  const strip=text=>{const value=JSON.parse(text);value.layouts[0].revision=0;return value;};assert.deepEqual(strip(readFileSync(store.path,'utf8')),strip(before.toString()),'the file is the previous one except the layout revision');
  // An option not named keeps its value; bad input is refused and writes nothing.
  store.setDockOptions(name,{hideKeyedApps:true});const kept=store.layoutRevision(name),file=readFileSync(store.path);
  for(const bad of [undefined,null,'x',[],{},{hideKeyedApps:'true'},{hideKeyedApps:1},{hideKeyedApps:null},{other:true},{hideKeyedApps:true,other:false}])assert.throws(()=>store.setDockOptions(name,bad),/Mac Dock options|known/,JSON.stringify(bad));
  assert.deepEqual(readFileSync(store.path),file);assert.equal(store.layoutRevision(name),kept);
});

// ---- the Host over HTTPS ----
function fakeChild(){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=signal=>{queueMicrotask(()=>child.emit('close',null,signal));return true;};return child;}
async function host(t){
  const dir=temporary(t);execFileSync(process.execPath,['scripts/setup.mjs'],{env:{...process.env,KEYLN_DATA_DIR:dir},stdio:'pipe'});
  const auth=new Auth(dir),store=new ConfigStore(dir),scheduler=new Scheduler({run:async()=>({ok:true,message:'Fake only'})});
  const running=new RunningApps({child:fakeChild,retryMs:5});
  const origin='https://127.0.0.1:0',ca=readFileSync(join(dir,'tls/rootCA.pem'));
  const server=createHost({origin,auth,store,scheduler,apps:[{id:'com.example.notes',name:'Notes'}],onPair(){},runningApps:running,dockDebounceMs:10,
    tls:{key:readFileSync(join(dir,'tls/server.key')),cert:readFileSync(join(dir,'tls/server.pem'))}});
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const sockets=[];
  t.after(async()=>{for(const socket of sockets)socket.terminate();running.terminate();scheduler.stop();await scheduler.settled();server.stopEvents();server.closeAllConnections();await new Promise(yes=>server.close(yes));});
  const port=server.address().port;
  const send=(path,body={},cookie='',headers={})=>new Promise((yes,no)=>{
    const req=request({hostname:'127.0.0.1',servername:'',port,ca,path,method:'POST',headers:{host:'127.0.0.1:0',origin,'content-type':'application/json','x-keyln-client':'1',cookie,...headers}},res=>{let text='';res.setEncoding('utf8');res.on('data',b=>text+=b);res.on('end',()=>yes({status:res.statusCode,data:text?JSON.parse(text):undefined}));});
    req.on('error',no);req.end(JSON.stringify(body));});
  const device=(name='Owned Surface')=>{const p=auth.begin(auth.invite(),name);auth.approve(p.id);return {id:p.id,cookie:`__Host-keyln=${auth.claim(p.id,p.claim).token}`};};
  const socket=cookie=>{const ws=new WebSocket(`wss://127.0.0.1:${port}/api/events`,'keyln.events.v4',{ca,servername:'',origin,headers:{host:'127.0.0.1:0',cookie}});const messages=[];ws.on('message',data=>messages.push(JSON.parse(data.toString())));sockets.push(ws);return {ws,messages,open:new Promise((yes,no)=>{ws.once('open',yes);ws.once('error',no);}),of:type=>messages.filter(message=>message.type===type)};};
  return {dir,store,running,send,device,socket,layout:store.defaultLayout};
}

test('T117 /api/device-dock/options: paired only, strict, conflict on the layout name, saves, publishes, and /api/device-dock reports the options',async t=>{
  const f=await host(t),d=f.device();
  assert.deepEqual((await f.send('/api/device-dock',{},d.cookie)).data,{dock:false,layoutName:f.layout,options:{hideKeyedApps:false,align:'center'}});
  assert.equal((await f.send('/api/device-dock/options',{options:{hideKeyedApps:true},layoutName:f.layout})).status,401);
  assert.equal((await f.send('/api/device-dock/options',{options:{hideKeyedApps:true},layoutName:f.layout},d.cookie,{origin:'https://evil.example'})).status,403);
  const start=f.store.layoutRevision(f.layout),file=readFileSync(f.store.path);
  for(const bad of [{},{options:{hideKeyedApps:true}},{layoutName:f.layout},{options:{},layoutName:f.layout},{options:{hideKeyedApps:'true'},layoutName:f.layout},{options:{hideKeyedApps:1},layoutName:f.layout},{options:{other:true},layoutName:f.layout},
    {options:{hideKeyedApps:true,other:true},layoutName:f.layout},{options:true,layoutName:f.layout},{options:null,layoutName:f.layout},{options:[],layoutName:f.layout},{options:{hideKeyedApps:true},layoutName:f.layout,dock:true},{hideKeyedApps:true,layoutName:f.layout}])
    assert.equal((await f.send('/api/device-dock/options',bad,d.cookie)).status,400,JSON.stringify(bad));
  const conflict=await f.send('/api/device-dock/options',{options:{hideKeyedApps:true},layoutName:'Another'},d.cookie);assert.equal(conflict.status,409);assert.equal(conflict.data.error.code,'CONFIG_CONFLICT');
  assert.deepEqual(readFileSync(f.store.path),file,'a refused save writes nothing');
  const live=f.socket(d.cookie);await live.open;await until(()=>live.of('state').length>0);const states=live.of('state').length;
  const saved=await f.send('/api/device-dock/options',{options:{hideKeyedApps:true},layoutName:f.layout},d.cookie);
  assert.equal(saved.status,200);assert.deepEqual(saved.data,{options:{hideKeyedApps:true,align:'center'},layoutName:f.layout,previousLayoutRevision:start,layoutRevision:start+1});
  await until(()=>live.of('state').length>states&&live.of('state').at(-1).layoutRevision===start+1);
  assert.deepEqual((await f.send('/api/device-dock',{},d.cookie)).data,{dock:false,layoutName:f.layout,options:{hideKeyedApps:true,align:'center'}});
  assert.equal(f.running.snapshot().status,'unavailable','the options do not start the observer');
  const same=await f.send('/api/device-dock/options',{options:{hideKeyedApps:true},layoutName:f.layout},d.cookie);assert.equal(same.data.layoutRevision,start+1,'the same value changes no revision');
  assert.equal((await f.send('/api/configuration',{},d.cookie)).data.config.layoutRevision,start+1);assert.equal(Object.hasOwn((await f.send('/api/configuration',{},d.cookie)).data.config,'dockOptions'),false,'existing responses do not gain the field');
  assert.deepEqual(JSON.parse(readFileSync(f.store.path,'utf8')).layouts[0].dockOptions,{hideKeyedApps:true});
  const off=await f.send('/api/device-dock/options',{options:{hideKeyedApps:false},layoutName:f.layout},d.cookie);assert.deepEqual(off.data.options,{hideKeyedApps:false,align:'center'});assert.equal(JSON.parse(readFileSync(f.store.path,'utf8')).layouts[0].dockOptions,undefined);
});

// ---- the Dock in the minimal DOM ----
const collect=(node,match,out=[])=>{if(match(node))out.push(node);for(const child of node.children??[])collect(child,match,out);return out;};
const buttons=h=>collect(h,node=>node.className==='mac-dock-item');
async function fixture(t,{keyed=[],options}={}){
  const dom=installDom(t),hostEl=dom.document.createElement('div'),state={keyed,calls:[],saved:[],blocked:'',reply:undefined};
  const dock=createMacDock({host:hostEl,call:async(url,body)=>{state.calls.push({url,body});return state.reply?state.reply(url,body):{status:200,data:{dock:false,layoutName:'Surface',options:{hideKeyedApps:false}}};},
    layout:()=>({name:'Surface',revision:3}),adopt:async(data,started)=>{state.saved.push([data,started]);},saving(){},online:()=>true,editing:()=>false,blocked:()=>state.blocked,
    epoch:()=>1,relayout(){},failed(){},loadIcon:async()=>null,keyed:()=>state.keyed});
  t.after(()=>dock.destroy());
  await dock.load();dock.setEnabled(true);dock.place({x:0,y:692,w:1366,h:76},false);dock.apply({status:'ready',apps:apps3});
  if(options)state.reply=(url)=>({status:200,data:{dock:true,layoutName:'Surface',options}});
  return {dom,hostEl,dock,state};
}
const names=h=>buttons(h).map(n=>n.dataset.appId);

test('T117 Dock filtering: the apps of the keys named by the page are left out, the option off shows them again, nothing left says so',async t=>{
  const {hostEl,dock,state}=await fixture(t,{keyed:['com.apple.finder','com.example.notes']});
  assert.deepEqual(names(hostEl),['com.apple.finder','com.example.notes','com.example.hidden'],'off: nothing is filtered');
  state.reply=(url,body)=>({status:200,data:{options:{hideKeyedApps:body.options.hideKeyedApps},layoutName:'Surface',previousLayoutRevision:3,layoutRevision:4}});
  await dock.setOption('hideKeyedApps',true);assert.deepEqual(names(hostEl),['com.example.hidden']);assert.equal(dock.options.hideKeyedApps,true);
  assert.deepEqual(state.calls.at(-1),{url:'/api/device-dock/options',body:{options:{hideKeyedApps:true},layoutName:'Surface'}});assert.deepEqual(state.saved.at(-1)[0].layoutRevision,4);
  // A key added later is seen at the next paint; the Dock's own list is untouched.
  state.keyed=['com.apple.finder','com.example.notes','com.example.hidden'];dock.render();assert.equal(buttons(hostEl).length,0);
  const line=collect(hostEl,node=>node.className==='mac-dock-empty');assert.equal(line.length,1);assert.equal(line[0].textContent,'All running apps have keys');
  const capsule=collect(hostEl,node=>node.className==='mac-dock-capsule')[0];assert.equal(capsule.hidden,false,'the strip is kept, with the line in the capsule');
  dock.apply({status:'ready',apps:apps3.slice(0,1)});assert.match(collect(hostEl,node=>node.className==='mac-dock-empty')[0].textContent,/All running apps have keys/);
  // Nothing running at all is not "all keyed": the capsule stays hidden as before.
  dock.apply({status:'ready',apps:[]});assert.equal(collect(hostEl,node=>node.className==='mac-dock-capsule')[0].hidden,true);assert.equal(collect(hostEl,node=>node.className==='mac-dock-empty').length,0);
  dock.apply({status:'ready',apps:apps3});
  await dock.setOption('hideKeyedApps',false);assert.deepEqual(names(hostEl),['com.apple.finder','com.example.notes','com.example.hidden'],'off again: they are back');
  assert.equal(collect(hostEl,node=>node.className==='mac-dock-empty').length,0);
});

test('T117 Dock options: rows come from the table, the window opens and closes, saving is blocked like the Dock setting, errors are shown, a bad reply changes nothing',async t=>{
  const {dom,dock,state}=await fixture(t);
  assert.deepEqual(DOCK_OPTION_ROWS.map(row=>row.key),['hideKeyedApps','align']);assert.ok(DOCK_OPTION_ROWS.every(row=>row.label&&row.description));
  const opener=dom.el('dock-settings-open'),message=dom.el('dock-dialog-message'),dialog=dom.el('dock-dialog'),gear=dom.el('connection-settings');
  gear.open=true;dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;dialog.emit('close');};let focused;opener.focus=()=>{focused=opener;};
  dock.render();const toggle=collect(dom.el('dock-options'),node=>node.id==='dock-option-hideKeyedApps')[0];assert.ok(toggle,'a row for the option');
  assert.equal(toggle.getAttribute('role'),'switch');assert.equal(toggle.getAttribute('aria-checked'),'false');assert.ok(collect(dom.el('dock-options'),n=>n.textContent===DOCK_OPTION_ROWS[0].label).length>0);assert.ok(collect(dom.el('dock-options'),n=>n.textContent===DOCK_OPTION_ROWS[0].description).length>0);
  assert.equal(opener.disabled,false);opener.emit('click');assert.equal(dock.settingsOpen,true);assert.equal(dialog.open,true);assert.equal(gear.open,false,'the gear menu steps aside');
  // Esc (cancel) closes, gives the gear menu and focus back.
  dialog.emit('cancel');assert.equal(dock.settingsOpen,false);assert.equal(dialog.open,false);assert.equal(focused,opener);assert.equal(gear.open,true);
  opener.emit('click');assert.equal(dock.settingsOpen,true);dom.el('dock-dialog-close').emit('click');assert.equal(dock.settingsOpen,false);assert.equal(dialog.open,false);
  opener.emit('click');state.blocked='Save or discard your draft first.';dock.render();assert.equal(toggle.disabled,true);assert.equal(message.textContent,'Save or discard your draft first.');
  toggle.emit('click');await tick();assert.equal(state.calls.filter(c=>c.url==='/api/device-dock/options').length,0,'blocked: nothing is sent');
  await dock.setOption('hideKeyedApps',true);assert.equal(state.calls.filter(c=>c.url==='/api/device-dock/options').length,0);
  state.blocked='';dock.render();assert.equal(toggle.disabled,false);
  state.reply=()=>({status:409,data:{error:{code:'CONFIG_CONFLICT',message:'The device layout changed.'}}});toggle.emit('click');await tick();
  assert.equal(dock.options.hideKeyedApps,false);assert.match(message.textContent,/layout changed/);assert.equal(toggle.getAttribute('aria-checked'),'false');
  state.reply=()=>({status:200,data:{options:{hideKeyedApps:'yes'},layoutName:'Surface',previousLayoutRevision:3,layoutRevision:4}});toggle.emit('click');await tick();assert.equal(dock.options.hideKeyedApps,false);assert.match(message.textContent,/earlier connection|saved setting/);
  state.reply=()=>undefined;toggle.emit('click');await tick();assert.equal(dock.options.hideKeyedApps,false);assert.match(message.textContent,/could not be confirmed/);
  state.reply=()=>({status:200,data:{options:{hideKeyedApps:true},layoutName:'Surface',previousLayoutRevision:3,layoutRevision:4}});toggle.emit('click');await tick();
  assert.equal(dock.options.hideKeyedApps,true);assert.equal(toggle.getAttribute('aria-checked'),'true');assert.equal(message.textContent,'');
  assert.equal(state.calls.filter(c=>c.url==='/api/device-dock/save').length,0,'the Dock itself is untouched');
});

test('T117 Dock options: an older Host without options leaves the window unavailable',async t=>{
  const dom=installDom(t),hostEl=dom.document.createElement('div');
  const dock=createMacDock({host:hostEl,call:async()=>({status:200,data:{dock:false,layoutName:'Surface'}}),layout:()=>({name:'Surface',revision:3}),adopt:async()=>{},saving(){},online:()=>true,editing:()=>false,blocked:()=>'',epoch:()=>1,relayout(){},failed(){}});
  t.after(()=>dock.destroy());await dock.load();dock.render();assert.equal(dom.el('dock-settings-open').disabled,true);
  dom.el('dock-settings-open').emit('click');assert.equal(dock.settingsOpen,false);
});

// ---- the page, whole ----
const dockButtons=f=>buttons(f.el('mac-dock'));
const ids=f=>dockButtons(f).map(n=>n.dataset.appId);
// Notes opens with a key on the first page, a window key points at Hidden (it must not hide it), Finder is opened by a key on the second page.
const keyedLayout=fromGrid({schemaVersion:2,revision:1,profiles:[{id:'main',name:'Main'},{id:'two',name:'Two'}],buttons:[
  {id:'primary',profileId:'main',position:0,label:'Notes',icon:'app',action:{type:'app.open',appId:'com.example.notes'}},
  {id:'win',profileId:'main',position:1,label:'Win',icon:'app',action:{type:'window.activate',appId:'com.example.hidden',title:'Doc',match:'exact'}},
  {id:'later',profileId:'two',position:0,label:'Finder',icon:'app',action:{type:'app.open',appId:'com.apple.finder'}}]});
const pageApps=[{id:'com.example.notes',name:'Notes'},{id:'com.apple.finder',name:'Finder'},{id:'com.example.hidden',name:'Hidden'}];
const gridEdit=async f=>{f.el('edit-layout').emit('click');await f.drain();f.el('grid-size').value='compact';f.el('grid-size').emit('change');await f.drain();};
const switchOf=f=>collect(f.el('dock-options'),node=>node.id==='dock-option-hideKeyedApps')[0];

test('T117 page: the gear button opens the window; the switch saves {options, layoutName}, hides only app.open apps (any page) and shows them again',async t=>{
  const f=await client(t,{configuration:keyedLayout,apps:pageApps,viewport:{width:1366,height:768},dock:false,running:{status:'ready',apps:apps3}});
  await f.until(()=>f.count('device-dock')===1&&!f.el('dock-settings-open').disabled);
  assert.equal(f.el('dock-settings-open').getAttribute('aria-haspopup'),'dialog');assert.equal(f.el('dock-settings-open').textContent,'Dock settings…');
  assert.equal(f.el('mac-dock').hidden,true,'the option is usable while the Dock is off');
  f.el('dock-settings-open').emit('click');assert.equal(f.el('dock-dialog').open,true);assert.ok(switchOf(f));assert.equal(switchOf(f).getAttribute('aria-checked'),'false');
  const start=f.state.config.layoutRevision;
  switchOf(f).emit('click');await f.until(()=>f.count('device-dock/options')===1);
  assert.deepEqual(f.calls.find(call=>call.path==='/api/device-dock/options').data,{options:{hideKeyedApps:true},layoutName:f.state.config.layoutName});
  await f.until(()=>switchOf(f).getAttribute('aria-checked')==='true');assert.equal(f.state.config.layoutRevision,start+1);assert.equal(f.count('device-dock/save'),0);assert.equal(f.count('configuration/save'),0,'not part of a layout draft');
  // Turn the Dock on: Notes (key on page one) and Finder (key on page two) are out; Hidden stays, its key is a window key.
  f.el('dock-on').emit('click');await f.until(()=>f.count('device-dock/save')===1);await f.until(()=>f.el('mac-dock').hidden===false&&ids(f).length>0);
  assert.deepEqual(ids(f),['com.example.hidden']);
  switchOf(f).emit('click');await f.until(()=>f.count('device-dock/options')===2);assert.deepEqual(f.calls.filter(call=>call.path==='/api/device-dock/options').at(-1).data.options,{hideKeyedApps:false});
  await f.until(()=>ids(f).length===3);assert.deepEqual(ids(f),['com.apple.finder','com.example.notes','com.example.hidden']);
});

test('T117 page: with every running app keyed the capsule says so; the option is read again on a new load',async t=>{
  const f=await client(t,{configuration:keyedLayout,apps:pageApps,viewport:{width:1366,height:768},dock:true,dockOptions:{hideKeyedApps:true},running:{status:'ready',apps:apps3.slice(0,2)}});
  await f.until(()=>f.el('mac-dock').hidden===false&&collect(f.el('mac-dock'),n=>n.className==='mac-dock-empty').length===1);
  assert.equal(collect(f.el('mac-dock'),n=>n.className==='mac-dock-empty')[0].textContent,'All running apps have keys');assert.equal(dockButtons(f).length,0);assert.equal(f.el('mac-dock').hidden,false,'the strip stays');
  f.sockets[0].push({type:'running-apps',status:'ready',apps:apps3});await f.until(()=>ids(f).length===1);assert.deepEqual(ids(f),['com.example.hidden']);
  f.el('dock-settings-open').emit('click');assert.equal(switchOf(f).getAttribute('aria-checked'),'true');
});

test('T117 page: the window is blocked while a draft is unsaved or the Mac is not reachable, and Esc or the close button give focus back',async t=>{
  const f=await client(t,{configuration:keyedLayout,apps:pageApps,viewport:{width:1366,height:768},dock:true,running:{status:'ready',apps:apps3}});
  await f.until(()=>!f.el('dock-settings-open').disabled&&dockButtons(f).length===3);
  f.el('dock-settings-open').emit('click');assert.equal(f.el('dock-dialog').open,true);
  f.el('dock-dialog').emit('cancel');assert.equal(f.el('dock-dialog').open,false);assert.equal(globalThis.document.activeElement,f.el('dock-settings-open'));
  f.el('dock-settings-open').emit('click');assert.equal(f.el('dock-dialog').open,true);f.el('dock-dialog-close').emit('click');assert.equal(f.el('dock-dialog').open,false);assert.equal(f.focused,'dock-settings-open');
  await gridEdit(f);f.el('dock-settings-open').emit('click');
  assert.equal(switchOf(f).disabled,true);assert.equal(f.el('dock-dialog-message').textContent,'Save or discard your draft first.');
  switchOf(f).emit('click');await f.drain();assert.equal(f.count('device-dock/options'),0);
  assert.equal(f.count('configuration/save'),0);
});

test('T117 page: a failed save is shown in the window and keeps the old value; a save for another layout is refused',async t=>{
  const f=await client(t,{configuration:keyedLayout,apps:pageApps,viewport:{width:1366,height:768},dock:true,running:{status:'ready',apps:apps3}});
  await f.until(()=>!f.el('dock-settings-open').disabled&&dockButtons(f).length===3);f.el('dock-settings-open').emit('click');
  f.dockOptionsFault={status:500,code:'INTERNAL',message:'Could not write the options.'};
  switchOf(f).emit('click');await f.until(()=>/Could not write/.test(f.el('dock-dialog-message').textContent));
  assert.equal(switchOf(f).getAttribute('aria-checked'),'false');assert.equal(dockButtons(f).length,3);
  f.dockOptionsFault=undefined;switchOf(f).emit('click');await f.until(()=>switchOf(f).getAttribute('aria-checked')==='true');assert.equal(f.el('dock-dialog-message').textContent,'');assert.deepEqual(ids(f),['com.example.hidden']);
});
