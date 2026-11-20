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

const temporary=t=>{const dir=mkdtempSync(join(tmpdir(),'keyln-t118-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
const tick=(ms=0)=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(condition,ms=3000)=>{const end=Date.now()+ms;while(!condition()){if(Date.now()>end)throw new Error('Condition not reached in time');await tick(10);}};
const app=(appId,name=appId,extra={})=>({appId,name,active:false,hidden:false,...extra});
const apps3=[app('com.apple.finder','Finder',{active:true}),app('com.example.notes','Notes'),app('com.example.hidden','Hidden',{hidden:true})];
const clone=value=>JSON.parse(JSON.stringify(value));


// T118 (ADR-102): the Mac Dock position, Left / Center / Right.
test('T118 contracts: align is stored only as left or right, combined with hideKeyedApps; an absent field round-trips byte-identical; everything else is refused',t=>{
  const dir=temporary(t),doc=new ConfigStore(dir).document();
  const off=C.parseConfigDocument(clone(doc));assert.equal(JSON.stringify(off),JSON.stringify(doc));assert.doesNotMatch(JSON.stringify(off),/dockOptions|align/);
  assert.deepEqual(C.layoutDockOptions(off),{hideKeyedApps:false,align:'center'});
  for(const good of [{align:'left'},{align:'right'},{hideKeyedApps:true,align:'left'},{hideKeyedApps:true,align:'right'},{hideKeyedApps:true}]){
    const d=clone(doc);d.layouts[0].dockOptions=good;const parsed=C.parseConfigDocument(d);assert.deepEqual(parsed.layouts[0].dockOptions,good,JSON.stringify(good));
    assert.equal(JSON.stringify(C.parseConfigDocument(clone(parsed))),JSON.stringify(parsed));}
  const d=clone(doc);d.layouts[0].dockOptions={hideKeyedApps:true,align:'right'};assert.deepEqual(C.layoutDockOptions(C.parseConfigDocument(d)),{hideKeyedApps:true,align:'right'});
  for(const bad of [{},{align:'center'},{align:'Left'},{align:'middle'},{align:''},{align:true},{align:1},{align:null},{align:['left']},{hideKeyedApps:true,align:'center'},{align:'left',other:true}]){
    const d2=clone(doc);d2.layouts[0].dockOptions=bad;assert.throws(()=>C.parseConfigDocument(d2),/./,JSON.stringify(bad));}
  assert.deepEqual(C.dockOptionMap(undefined),{hideKeyedApps:false,align:'center'});
});

test('T118 store: align and the switch merge independently, back to center removes align, both at default remove the field, the revision moves only on change',t=>{
  const dir=temporary(t),store=new ConfigStore(dir),name=store.defaultLayout,start=store.layoutRevision(name),before=readFileSync(store.path);
  assert.deepEqual(store.dockOptions(),{hideKeyedApps:false,align:'center'});
  const same=store.setDockOptions(name,{align:'center'});assert.equal(same.layoutRevision,start);assert.deepEqual(readFileSync(store.path),before,'center to center writes nothing');
  const left=store.setDockOptions(name,{align:'left'});assert.deepEqual(left,{options:{hideKeyedApps:false,align:'left'},layoutName:name,previousLayoutRevision:start,layoutRevision:start+1});
  assert.deepEqual(JSON.parse(readFileSync(store.path,'utf8')).layouts[0].dockOptions,{align:'left'});assert.deepEqual(new ConfigStore(dir).dockOptions(),{hideKeyedApps:false,align:'left'});
  const written=readFileSync(store.path);store.setDockOptions(name,{align:'left'});assert.deepEqual(readFileSync(store.path),written,'the same value writes nothing');
  const both=store.setDockOptions(name,{hideKeyedApps:true});assert.deepEqual(both.options,{hideKeyedApps:true,align:'left'},'the switch keeps align');assert.equal(both.layoutRevision,start+2);
  assert.deepEqual(JSON.parse(readFileSync(store.path,'utf8')).layouts[0].dockOptions,{hideKeyedApps:true,align:'left'});
  const right=store.setDockOptions(name,{align:'right'});assert.deepEqual(right.options,{hideKeyedApps:true,align:'right'},'align keeps the switch');
  const back=store.setDockOptions(name,{align:'center'});assert.deepEqual(back.options,{hideKeyedApps:true,align:'center'});assert.deepEqual(JSON.parse(readFileSync(store.path,'utf8')).layouts[0].dockOptions,{hideKeyedApps:true});
  const two=store.setDockOptions(name,{align:'left',hideKeyedApps:false});assert.deepEqual(two.options,{hideKeyedApps:false,align:'left'});
  const level=store.layoutRevision(name);store.setDockOptions(name,{align:'center'});assert.equal(store.layoutRevision(name),level+1);assert.doesNotMatch(readFileSync(store.path,'utf8'),/dockOptions/,'both at their default: no field');
  const strip=text=>{const v=JSON.parse(text);v.layouts[0].revision=0;return v;};assert.deepEqual(strip(readFileSync(store.path,'utf8')),strip(before.toString()));
  const file=readFileSync(store.path),kept=store.layoutRevision(name);
  for(const bad of [{align:'middle'},{align:true},{align:null},{align:1},{align:'Left'},{hideKeyedApps:'left'},{align:'left',other:1},{}])assert.throws(()=>store.setDockOptions(name,bad),/Mac Dock options|known/,JSON.stringify(bad));
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


test('T118 /api/device-dock/options with align: strict values, conflict on the layout name, saves and is reported by /api/device-dock',async t=>{
  const f=await host(t),d=f.device(),start=f.store.layoutRevision(f.layout),file=readFileSync(f.store.path);
  assert.deepEqual((await f.send('/api/device-dock',{},d.cookie)).data,{dock:false,layoutName:f.layout,options:{hideKeyedApps:false,align:'center'}});
  for(const bad of [{align:'middle'},{align:'Left'},{align:true},{align:1},{align:null},{align:['left']},{align:'left',other:true},{}])assert.equal((await f.send('/api/device-dock/options',{options:bad,layoutName:f.layout},d.cookie)).status,400,JSON.stringify(bad));
  const conflict=await f.send('/api/device-dock/options',{options:{align:'left'},layoutName:'Another'},d.cookie);assert.equal(conflict.status,409);assert.equal(conflict.data.error.code,'CONFIG_CONFLICT');
  assert.deepEqual(readFileSync(f.store.path),file,'a refused save writes nothing');
  const saved=await f.send('/api/device-dock/options',{options:{align:'right'},layoutName:f.layout},d.cookie);assert.equal(saved.status,200);
  assert.deepEqual(saved.data,{options:{hideKeyedApps:false,align:'right'},layoutName:f.layout,previousLayoutRevision:start,layoutRevision:start+1});
  assert.deepEqual((await f.send('/api/device-dock',{},d.cookie)).data,{dock:false,layoutName:f.layout,options:{hideKeyedApps:false,align:'right'}});
  assert.equal((await f.send('/api/device-dock/options',{options:{align:'right'},layoutName:f.layout},d.cookie)).data.layoutRevision,start+1,'the same value changes no revision');
  assert.deepEqual(JSON.parse(readFileSync(f.store.path,'utf8')).layouts[0].dockOptions,{align:'right'});
  const back=await f.send('/api/device-dock/options',{options:{align:'center'},layoutName:f.layout},d.cookie);assert.deepEqual(back.data.options,{hideKeyedApps:false,align:'center'});assert.equal(JSON.parse(readFileSync(f.store.path,'utf8')).layouts[0].dockOptions,undefined);
});
// ---- the Dock in the minimal DOM ----
const collect=(node,match,out=[])=>{if(match(node))out.push(node);for(const child of node.children??[])collect(child,match,out);return out;};
const buttons=h=>collect(h,node=>node.className==='mac-dock-item');
async function fixture(t,{reply}={}){
  const dom=installDom(t),hostEl=dom.document.createElement('div'),state={calls:[],saved:[],blocked:'',reply};
  const dock=createMacDock({host:hostEl,call:async(url,body)=>{state.calls.push({url,body});return state.reply?state.reply(url,body):{status:200,data:{dock:true,layoutName:'Surface',options:{hideKeyedApps:false,align:'center'}}};},
    layout:()=>({name:'Surface',revision:3}),adopt:async(data,started)=>{state.saved.push([data,started]);},saving(){},online:()=>true,editing:()=>false,blocked:()=>state.blocked,epoch:()=>1,relayout(){},failed(){},loadIcon:async()=>null,keyed:()=>[]});
  t.after(()=>dock.destroy());await dock.load();dock.place({x:0,y:692,w:1366,h:76},false);dock.apply({status:'ready',apps:apps3});
  return {dom,hostEl,dock,state};
}
const choice=(dom,v)=>dom.el(`dock-option-align-${v}`);
test('T118 Dock settings: the Position row has Left / Center / Right with aria-pressed; choosing sends {options:{align},layoutName}; the Dock host gets data-align and the side gap',async t=>{
  const {dom,hostEl,dock,state}=await fixture(t);
  assert.deepEqual(DOCK_OPTION_ROWS.map(r=>[r.key,r.kind]),[['hideKeyedApps','switch'],['align','choice']]);assert.deepEqual(DOCK_OPTION_ROWS[1].choices.map(c=>c.value),['left','center','right']);
  dock.render();
  const group=collect(dom.el('dock-options'),n=>n.getAttribute?.('role')==='group')[0];assert.ok(group,'a role=group');assert.ok(group.getAttribute('aria-labelledby'));
  assert.deepEqual(['left','center','right'].map(v=>choice(dom,v).textContent),['Left','Center','Right']);assert.ok(['left','center','right'].every(v=>choice(dom,v).className==='move-choice'));
  const pressed=()=>['left','center','right'].map(v=>choice(dom,v).getAttribute('aria-pressed'));
  assert.deepEqual(pressed(),['false','true','false']);assert.equal(hostEl.dataset.align,'center');assert.equal(hostEl.style['--dock-side'],'12px');
  state.reply=(url,body)=>({status:200,data:{options:{hideKeyedApps:false,align:body.options.align},layoutName:'Surface',previousLayoutRevision:3,layoutRevision:4}});
  choice(dom,'left').emit('click');await tick();
  assert.deepEqual(state.calls.at(-1),{url:'/api/device-dock/options',body:{options:{align:'left'},layoutName:'Surface'}});
  assert.deepEqual(pressed(),['true','false','false']);assert.equal(hostEl.dataset.align,'left');assert.equal(dock.options.align,'left');assert.equal(state.saved.at(-1)[0].layoutRevision,4);
  choice(dom,'right').emit('click');await tick();assert.deepEqual(pressed(),['false','false','true']);assert.equal(hostEl.dataset.align,'right');
  // The same choice sends nothing; a narrow window uses the narrow gap.
  const n=state.calls.length;choice(dom,'right').emit('click');await tick();assert.equal(state.calls.length,n);
  dock.place({x:0,y:700,w:390,h:64},true);assert.equal(hostEl.style['--dock-side'],'8px');
  // Blocked like every Dock option; a refusal keeps the old value.
  state.blocked='Save or discard your draft first.';dock.render();assert.ok(['left','center','right'].every(v=>choice(dom,v).disabled));state.blocked='';dock.render();
  state.reply=()=>({status:409,data:{error:{code:'CONFIG_CONFLICT',message:'The device layout changed.'}}});choice(dom,'left').emit('click');await tick();assert.equal(dock.options.align,'right');assert.match(dom.el('dock-dialog-message').textContent,/layout changed/);assert.equal(hostEl.dataset.align,'right');
  state.reply=()=>({status:200,data:{options:{hideKeyedApps:false,align:'middle'},layoutName:'Surface',previousLayoutRevision:3,layoutRevision:5}});choice(dom,'left').emit('click');await tick();assert.equal(dock.options.align,'right','a bad value in the reply changes nothing');
});

test('T118 Dock: an options map without align reads as center and does not lock the window; a wrong align is not a map',async t=>{
  const {dom,hostEl,dock}=await fixture(t,{reply:()=>({status:200,data:{dock:true,layoutName:'Surface',options:{hideKeyedApps:true}}})});
  assert.equal(dock.options.align,'center');assert.equal(dock.options.hideKeyedApps,true);assert.equal(hostEl.dataset.align,'center');dock.render();assert.equal(dom.el('dock-settings-open').disabled,false);
  assert.equal(choice(dom,'center').getAttribute('aria-pressed'),'true');assert.equal(choice(dom,'center').disabled,false);
  const bad=await fixture(t,{reply:()=>({status:200,data:{dock:true,layoutName:'Surface',options:{hideKeyedApps:true,align:'middle'}}})});bad.dock.render();assert.equal(bad.dom.el('dock-settings-open').disabled,true,'an unreadable map is no map');
});

test('T118 page: choosing Left saves {options:{align:left},layoutName} and the Dock follows; the stored value is read on a new load',async t=>{
  const f=await client(t,{viewport:{width:1366,height:768},dock:true,running:{status:'ready',apps:apps3}});
  await f.until(()=>f.count('device-dock')===1&&!f.el('dock-settings-open').disabled&&f.el('mac-dock').hidden===false);
  assert.equal(f.el('mac-dock').dataset.align,'center');f.el('dock-settings-open').emit('click');
  f.el('dock-option-align-left').emit('click');await f.until(()=>f.count('device-dock/options')===1);
  assert.deepEqual(f.calls.find(c=>c.path==='/api/device-dock/options').data,{options:{align:'left'},layoutName:f.state.config.layoutName});
  await f.until(()=>f.el('mac-dock').dataset.align==='left');assert.equal(f.el('dock-option-align-left').getAttribute('aria-pressed'),'true');assert.equal(f.count('configuration/save'),0);
  const g=await client(t,{viewport:{width:1366,height:768},dock:true,dockOptions:{align:'right'},running:{status:'ready',apps:apps3}});
  await g.until(()=>g.el('mac-dock').dataset.align==='right');
});

test('T118 style: the capsule is aligned by CSS from data-align, with no hex or rgba colors added',()=>{
  const css=readFileSync(new URL('../apps/web/style.css',import.meta.url),'utf8');
  assert.match(css,/\.mac-dock\[data-align=left\]\{justify-content:flex-start\}/);assert.match(css,/\.mac-dock\[data-align=right\]\{justify-content:flex-end\}/);assert.match(css,/padding:0 var\(--dock-side,0\)/);
  assert.doesNotMatch(css.split('\n').filter(l=>/data-align|dock-choices|dock-option-choice/.test(l)).join('\n'),/#[0-9a-f]{3,8}\b|rgba?\(/i);
});
