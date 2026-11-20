import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createAppIconLoader,createIndexedDbStore,loadAppIcon} from '../dist/apps/web/app-icons.js';
import {setKeyIcon} from '../dist/apps/web/presentation.js';
import {sortedLibraryApps} from '../dist/apps/web/library-apps.js';
import {client,deferred} from './helpers/client-harness.mjs';
import {fakeIndexedDB} from './helpers/fake-indexeddb.mjs';

// T84 (ADR-079): Library > App is built and loaded on demand, and icons live on the device's disk (IndexedDB) until a refresh or a reconnect.
// These tests drive the production loader, presentation and Library code; IndexedDB and IntersectionObserver are controlled fakes.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1EAAAAASUVORK5CYII=','base64');png.writeUInt32BE(128,16);png.writeUInt32BE(128,20);
const small=Buffer.from(png);small.writeUInt32BE(64,16);small.writeUInt32BE(64,20);
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const settle=async(n=6)=>{for(let i=0;i<n;i++)await turn();};
const ok=ids=>Response.json({icons:ids.map(appId=>({appId,png:png.toString('base64')}))});
const ids=(body)=>JSON.parse(body.body).appIds;
const mine=list=>list.filter(id=>id.startsWith('t84.'));
const URL_PREFIX='data:image/png;base64,';
const memoryStore=()=>{const data=new Map(),log=[];return {data,log,async get(id){log.push(['get',id]);return data.get(id);},async put(id,bytes){log.push(['put',id]);data.set(id,bytes);},async delete(id){log.push(['delete',id]);data.delete(id);},async clear(){log.push(['clear']);data.clear();}};};
const css=readFileSync(new URL('../apps/web/style.css',import.meta.url),'utf8');
const rule=selector=>{const start=css.indexOf(selector+'{');assert.ok(start>=0,selector);return css.slice(start,css.indexOf('}',start)+1);};

test('T84 more than 48 icons are all served, and a re-render with other ids while loading still gets its icons',async()=>{
  const calls=[];
  const load=createAppIconLoader(async(_url,options)=>{const batch=ids(options);calls.push(batch);await turn();return ok(batch);},()=>0,null);
  const everything=await Promise.all(Array.from({length:130},(_,i)=>load('t84.many'+i)));
  assert.ok(everything.every(data=>data?.startsWith(URL_PREFIX)),'no 48-entry overflow to null');
  assert.ok(calls.every(batch=>batch.length<=16));
  // The first set is mounted, two batches start, then search/sort replaces it with another set.
  const calls2=[];const second=createAppIconLoader(async(_url,options)=>{const batch=ids(options);calls2.push(batch);await turn();return ok(batch);},()=>0,null);
  const old=new AbortController(),oldResults=Array.from({length:60},(_,i)=>second('t84.old'+i,old.signal));
  await turn();assert.equal(calls2.length,2);old.abort();
  const fresh=new AbortController(),freshResults=await Promise.all(Array.from({length:40},(_,i)=>second('t84.new'+i,fresh.signal)));
  assert.ok(freshResults.every(Boolean),'the new ids get icons even though the old set was still loading');
  const asked=calls2.flat();assert.ok(!asked.some(id=>/^t84\.old(3[2-9]|[45]\d)$/.test(id)),'queued ids of the abandoned set never reach the Mac');
  assert.equal((await Promise.all(oldResults)).filter(Boolean).length,0);
});
test('T84 a null result clears the key, so a later render tries again; the cooldown limits asking and reset lifts it',async t=>{
  let mode='missing';const id='t84.retry'+Date.now();
  const f=await client(t,{iconReply:async body=>mode==='missing'?Response.json({icons:body.appIds.map(appId=>({appId,code:'ICON_UNAVAILABLE'}))}):ok(body.appIds)});
  const target=f.el('owned-icon'),key={id:'k',profileId:'main',position:1,label:'Icon',icon:'app',action:{type:'app.open',appId:id}};
  const asked=()=>f.calls.filter(call=>call.path==='/api/app-icons'&&call.data.appIds.includes(id)).length;
  setKeyIcon(target,key);await settle();assert.equal(asked(),1);assert.equal(target.getAttribute('data-symbol'),'app-window');
  setKeyIcon(target,key);await settle();assert.equal(asked(),1,'inside the cooldown nothing is asked');assert.notEqual(target.getAttribute('data-glyph'),'app');
  loadAppIcon.reset();mode='ok';setKeyIcon(target,key);await settle();
  assert.equal(asked(),2,'the same element and key asked again after the failure');assert.equal(target.getAttribute('data-glyph'),'app');
});
test('T84 ICON_BUSY is retried once after a short wait; other failures and a second busy are not',async()=>{
  let n=0;const started=Date.now();
  const load=createAppIconLoader(async(_url,options)=>{n++;return n===1?Response.json({error:{code:'ICON_BUSY',message:'Icon loading is busy.'}},{status:503}):ok(ids(options));},()=>0,null);
  assert.ok((await load('t84.busy')).startsWith(URL_PREFIX));assert.equal(n,2);assert.ok(Date.now()-started>=400,'waits about 500ms');
  let m=0;const stubborn=createAppIconLoader(async()=>{m++;return Response.json({error:{code:'ICON_BUSY'}},{status:503});},()=>0,null);
  assert.equal(await stubborn('t84.busy2'),null);assert.equal(m,2);
  let k=0;const other=createAppIconLoader(async()=>{k++;return Response.json({error:{code:'OTHER'}},{status:503});},()=>0,null);
  assert.equal(await other('t84.busy3'),null);assert.equal(k,1);
});
test('T84 a batch times out after 6 seconds, not 3',()=>{
  const source=readFileSync(new URL('../apps/web/app-icons.ts',import.meta.url),'utf8');
  assert.match(source,/BATCH_TIMEOUT_MS = 6000/);assert.doesNotMatch(source,/3000/);
});
test('T84 loaded icons are written to IndexedDB; memory keeps 64 and the rest is read back from disk without asking the Mac',async t=>{
  const idb=fakeIndexedDB();globalThis.indexedDB=idb;t.after(()=>{delete globalThis.indexedDB;});
  const calls=[];
  const load=createAppIconLoader(async(_url,options)=>{const batch=ids(options);calls.push(batch);return ok(batch);},()=>0,createIndexedDbStore());
  const names=Array.from({length:70},(_,i)=>'t84.disk'+i);
  assert.ok((await Promise.all(names.map(id=>load(id)))).every(Boolean));await settle();
  assert.equal(calls.length,5);assert.equal(idb.records().size,70,'every validated icon was stored');
  assert.deepEqual([...idb.databases.keys()],['keyln-app-icons']);
  assert.ok(idb.records().get('t84.disk0') instanceof Uint8Array&&idb.records().get('t84.disk0').length>30);
  const gets=()=>idb.log.filter(entry=>entry[0]==='get').length,beforeGets=gets();
  for(const id of names.slice(6))assert.ok(await load(id));
  assert.equal(gets(),beforeGets,'the 64 most recent icons are served from memory');
  const evicted=await load('t84.disk0');await settle();
  assert.ok(evicted.startsWith(URL_PREFIX));assert.equal(calls.length,5,'an evicted icon is not asked of the Mac again');assert.ok(gets()>beforeGets,'it came back from IndexedDB');
});
test('T84 a corrupted or wrong-size stored entry is dropped and fetched again',async()=>{
  const store=memoryStore();let asked=0;
  store.data.set('t84.bad',new Uint8Array([1,2,3]));store.data.set('t84.size',new Uint8Array(small));store.data.set('t84.big',new Uint8Array(70_000));store.data.set('t84.good',new Uint8Array(png));
  const load=createAppIconLoader(async(_url,options)=>{asked++;return ok(ids(options));},()=>0,store);
  assert.ok((await load('t84.good')).startsWith(URL_PREFIX));assert.equal(asked,0,'a valid stored icon needs no request');
  for(const id of ['t84.bad','t84.size','t84.big']){
    const before=asked;assert.ok((await load(id)).startsWith(URL_PREFIX));assert.equal(asked,before+1,id);
    assert.ok(store.log.some(entry=>entry[0]==='delete'&&entry[1]===id),`${id} was deleted`);
  }
  await settle();assert.equal(store.data.get('t84.bad').length,png.length,'the fresh, valid icon replaced the bad entry');
});
test('T84 if the store throws or IndexedDB cannot open, icons still load from memory and the Mac',async t=>{
  const thrower={get(){throw Error('sync');},put(){throw Error('sync');},delete(){throw Error('sync');},clear(){throw Error('sync');}};
  const rejecter={get:async()=>{throw Error('quota');},put:async()=>{throw Error('quota');},delete:async()=>{throw Error('quota');},clear:async()=>{throw Error('quota');}};
  for(const [name,store] of [['throws',thrower],['rejects',rejecter]]){
    let asked=0;const load=createAppIconLoader(async(_url,options)=>{asked++;return ok(ids(options));},()=>0,store);
    assert.ok(await load('t84.'+name),name);assert.ok(await load('t84.'+name),name);assert.equal(asked,1,'the memory copy still serves');
    assert.doesNotThrow(()=>load.reset());await settle();
  }
  const blocked=fakeIndexedDB({fail:true});globalThis.indexedDB=blocked;t.after(()=>{delete globalThis.indexedDB;});
  let asked=0;const load=createAppIconLoader(async(_url,options)=>{asked++;return ok(ids(options));},()=>0,createIndexedDbStore());
  assert.ok(await load('t84.blocked'));assert.equal(asked,1);assert.doesNotThrow(()=>load.reset());
  // A store that never answers cannot hold an icon back for ever.
  const hung={get:()=>new Promise(()=>{}),put:async()=>{},delete:async()=>{},clear:async()=>{}};
  const hungLoad=createAppIconLoader(async(_url,options)=>ok(ids(options)),()=>0,hung);
  assert.ok(await hungLoad('t84.hung'),'a store that never answers is given up on after a short wait');
});
test('T84 reset clears memory, the stored icons and the failure cooldowns',async()=>{
  const store=memoryStore();let asked=0,fail=true,clock=0;
  const load=createAppIconLoader(async(_url,options)=>{asked++;if(fail)throw Error('offline');return ok(ids(options));},()=>clock,store);
  assert.equal(await load('t84.reset'),null);assert.equal(await load('t84.reset'),null);assert.equal(asked,1,'cooldown');
  fail=false;load.reset();await settle();assert.ok(store.log.some(entry=>entry[0]==='clear'));
  assert.ok(await load('t84.reset'),'the cooldown is gone after reset');assert.equal(asked,2);await settle();assert.equal(store.data.size,1);
  load.reset();await settle();assert.equal(store.data.size,0,'the store is emptied');
  assert.ok(await load('t84.reset'));assert.equal(asked,3,'memory was forgotten too, so the Mac is asked again');
});

// ---- the Library ----
class Observer {
  static all=[];targets=new Set();disconnects=0;
  constructor(callback,options){this.callback=callback;this.options=options;Observer.all.push(this);}
  observe(node){this.targets.add(node);}unobserve(node){this.targets.delete(node);}
  disconnect(){this.targets.clear();this.disconnects++;}takeRecords(){return [];}
  deliver(nodes,visible=true){this.callback(nodes.map(target=>({target,isIntersecting:visible})));}
}
const apps=Array.from({length:435},(_,i)=>({id:`t84.lib${String(i).padStart(3,'0')}`,name:`App ${String(i).padStart(3,'0')}`}));
async function library(t,extra={}){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'IntersectionObserver');Observer.all=[];
  Object.defineProperty(globalThis,'IntersectionObserver',{value:Observer,configurable:true,writable:true});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'IntersectionObserver',previous);else delete globalThis.IntersectionObserver;});
  loadAppIcon.reset();
  const f=await client(t,{apps,...extra});f.el('edit-layout').emit('click');f.el('shelf-toggle').emit('click');await f.drain();
  const previews=f.el('shelf-previews');
  return {f,previews,tiles:()=>previews.children.filter(node=>node.className?.includes('shelf-app-card')),sentinel:()=>previews.children.find(node=>node.className==='shelf-app-sentinel'),
    observer:()=>Observer.all.find(observer=>observer.options?.root===previews)};
}
test('T84 the Library builds a first slice of 435 apps, appends on the sentinel, and asks for icons only for tiles in view',async t=>{
  const batches=[];
  const lib=await library(t,{iconReply:async body=>{if(mine(body.appIds).length)batches.push(mine(body.appIds));return ok(body.appIds);}}),{f}=lib;
  assert.equal(lib.tiles().length,72,'only a first slice is built');assert.ok(lib.sentinel());assert.equal(lib.observer().options.rootMargin,'100% 0px');
  await settle();assert.equal(batches.length,0,'nothing is asked before a tile is in view');
  assert.ok(lib.observer().targets.has(lib.sentinel()));assert.ok(lib.tiles().every(tile=>lib.observer().targets.has(tile)));
  lib.observer().deliver(lib.tiles().slice(0,20));await settle();
  assert.deepEqual(batches.flat(),apps.slice(0,20).map(app=>app.id),'visible tiles only, in list order');
  assert.equal(lib.tiles()[0].children[0].getAttribute('data-glyph'),'app');assert.equal(lib.tiles()[40].children[0].getAttribute('data-glyph'),null);
  // Out of view before the batch starts: nothing is sent for it.
  lib.observer().deliver(lib.tiles().slice(40,46));lib.observer().deliver(lib.tiles().slice(40,46),false);await settle();assert.equal(batches.flat().length,20);
  // Scrolling to the end of the slice appends the next one; the sentinel moves and is watched again.
  let seen=72;
  for(let n=0;n<5;n++){const old=lib.sentinel();lib.observer().deliver([old]);seen=Math.min(435,seen+72);assert.equal(lib.tiles().length,seen);assert.ok(lib.sentinel());assert.ok(lib.observer().targets.has(lib.sentinel()));assert.equal(lib.previews.children.at(-1),lib.sentinel(),'the sentinel stays last');}
  assert.equal(lib.tiles().length,432);lib.observer().deliver([lib.sentinel()]);assert.equal(lib.tiles().length,435);assert.equal(lib.sentinel(),undefined,'no sentinel once every app is built');
  assert.deepEqual(lib.tiles().map(tile=>tile.dataset.appId),apps.map(app=>app.id));
  assert.equal(f.count('execute'),0);
});
test('T84 search and sort cover every app, rebuild from a first slice and stop the old tiles',async t=>{
  const gate=deferred(),batches=[];
  const lib=await library(t,{iconReply:async body=>{if(mine(body.appIds).length)batches.push(mine(body.appIds));await gate.promise;return ok(body.appIds);}}),{f}=lib;
  lib.observer().deliver(lib.tiles().slice(0,10));await settle();assert.equal(batches.length,1);
  const disconnects=lib.observer().disconnects;
  // A re-render while those icons are still loading: sort Z-A rebuilds the tiles.
  f.el('shelf-app-sort').value='za';f.el('shelf-app-sort').emit('change');await f.drain();
  assert.ok(lib.observer().disconnects>disconnects,'the old tiles are no longer watched');assert.equal(lib.tiles().length,72);assert.equal(lib.tiles()[0].dataset.appId,'t84.lib434');
  lib.observer().deliver(lib.tiles().slice(0,5));await settle();
  gate.resolve();await settle();
  assert.equal(lib.tiles()[0].children[0].getAttribute('data-glyph'),'app','the new set still gets icons while the old batch was loading');
  // Search reaches apps that were never built.
  const search=f.el('shelf-search');search.value='App 4';search.emit('input');await f.drain();
  const expected=sortedLibraryApps(apps,'App 4','za',[]);assert.ok(expected.length>72);assert.equal(lib.tiles().length,72);assert.ok(lib.sentinel());
  search.value='App 433';search.emit('input');await f.drain();assert.deepEqual(lib.tiles().map(tile=>tile.dataset.appId),['t84.lib433']);assert.equal(lib.sentinel(),undefined);
  // Closing the Library stops the watching.
  const before=lib.observer().disconnects;f.el('shelf-toggle').emit('click');await f.drain();assert.ok(lib.observer().disconnects>before);assert.equal(lib.observer().targets.size,0);
});
test('T84 a tile whose icon failed asks again when it comes back into view',async t=>{
  let mode='missing';const batches=[];
  const lib=await library(t,{iconReply:async body=>{if(mine(body.appIds).length)batches.push(mine(body.appIds));return mode==='missing'?Response.json({icons:body.appIds.map(appId=>({appId,code:'ICON_UNAVAILABLE'}))}):ok(body.appIds);}});
  const tile=lib.tiles()[0];lib.observer().deliver([tile]);await settle();assert.equal(batches.length,1);assert.notEqual(tile.children[0].getAttribute('data-glyph'),'app');
  lib.observer().deliver([tile],false);loadAppIcon.reset();mode='ok';
  lib.observer().deliver([tile]);await settle();assert.equal(batches.length,2);assert.equal(tile.children[0].getAttribute('data-glyph'),'app');
  lib.observer().deliver([tile],false);lib.observer().deliver([tile]);await settle();assert.equal(batches.length,2,'an icon already shown is not asked for again');
});
test('T84 tiles keep tap, drag, menu and press behavior and are frameless',async t=>{
  const lib=await library(t),{f}=lib,tile=lib.tiles()[3];
  assert.equal(tile.title,'App 003');assert.equal(tile.children[1].title,'App 003');assert.equal(tile.getAttribute('aria-label'),'Add App 003');assert.equal(tile.getAttribute('aria-haspopup'),'menu');
  tile.emit('click');await f.drain();assert.equal(f.el('save-message').dataset.dirty,'true');
  tile.emit('contextmenu',{clientX:10,clientY:10});assert.equal(f.el('shelf-app-menu').hidden,false);
});
test('T84 tiles have no frame, border or background, a 56px icon, a 44px+ target, and hover only where hovering exists',()=>{
  const tile=rule('.shelf-card.shelf-app-card');
  assert.match(tile,/--app-icon:56px/);assert.match(tile,/border:0/);assert.match(tile,/background:transparent/);assert.match(tile,/box-shadow:none/);assert.doesNotMatch(tile,/border:1px|border-color|background:var\(--(bg|key|surface)/);
  const height=Number(/min-height:(\d+)px/.exec(tile)?.[1]);assert.ok(height>=44,`min-height ${height}px`);
  assert.match(rule('.shelf-app-card .shelf-target-icon'),/width:var\(--app-icon\);height:var\(--app-icon\)/);
  assert.match(rule('.shelf-app-card .shelf-caption'),/white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center/);
  assert.ok(/\.shelf-card\.shelf-app-card:focus-visible\{outline:2px solid var\(--focus\)/.test(css));
  assert.ok(/\.shelf-app-card:active\{transform:scale\(\.96\);opacity:\.8\}/.test(css));
  assert.ok(css.includes('@media(prefers-reduced-motion:reduce){.shelf-card.shelf-app-card{transition:none}.shelf-app-card:active{transform:none}}'),'reduced motion');
  assert.equal(css.split('.shelf-app-card:hover').length,2,'one hover rule');assert.ok(/@media\(hover:hover\)\{\.shelf-app-card:hover\{background:var\(--surface-2\)\}\}/.test(css));
  const grid=css.match(/\.shelf-previews\{display:grid;grid-template-columns:repeat\(auto-fill,minmax\((\d+)px,1fr\)\)/);assert.ok(grid,'an even grid');
  assert.ok(375-20>=4*Number(grid[1]),'four columns fit a 375px phone');
  assert.ok(!/\.shelf-app-card[^{]*\{[^}]*#[0-9a-fA-F]{3,8}/.test(css.replace(/\/\*[^]*?\*\//g,'')),'theme tokens only');
});
test('T84 the reset happens on page load and after a restored connection, not on a routine sync',async t=>{
  const idb=fakeIndexedDB();
  idb.databases.set('keyln-app-icons',new Map([['t84.stale',new Uint8Array(png)]]));
  const f=await client(t,{indexedDB:idb});await settle();
  assert.equal(idb.records().size,0,'a page load starts empty');
  idb.records().set('t84.kept',new Uint8Array(png));
  f.sockets[0].state();f.state={...f.state};await f.drain();await settle();
  assert.equal(idb.records().size,1,'an ordinary state event does not clear');
  f.sockets[0].close(1006);await f.fireTimer(1000);await f.until(()=>f.sockets.length===2);await settle();
  assert.equal(idb.records().size,0,'a reconnect clears the stored icons');
});
