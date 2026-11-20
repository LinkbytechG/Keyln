import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AppUsage} from '../dist/apps/host/app-usage.js';
import {sortedLibraryApps} from '../dist/apps/web/library-apps.js';
import {parseAppRecent,allComponents} from '../dist/packages/contracts/index.js';
import {client,deferred} from './helpers/client-harness.mjs';
const apps=[{id:'test.a',name:'Alpha'},{id:'test.b',name:'Beta'},{id:'test.c',name:'Gamma'}];
const folder=t=>{const dir=mkdtempSync(join(tmpdir(),'keyln-t71-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
class FakeChild extends EventEmitter {
 stdout=new PassThrough();stderr=new PassThrough();signals=[];closed=false;
 kill(signal){this.signals.push(signal);if(!this.closed){this.closed=true;setImmediate(()=>this.emit('close',null,signal));}return true;}
 line(value){this.stdout.write(JSON.stringify(value)+'\n');}
 ready(){this.line({type:'ready'});}
 app(appId){this.line({type:'activated',appId});}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('T71 native activation stream persists only known bundle ids and Host receipt order, across restart and equal timestamps',async t=>{
 const dir=folder(t),child=new FakeChild(),config='{"untouched":true}';writeFileSync(join(dir,'config.json'),config);const usage=new AppUsage(dir,apps,{child:()=>child,now:()=>100,log:()=>{}});usage.start();usage.start();child.ready();child.app('test.b');child.app('test.a');child.app('unknown.app');child.app('test.b');assert.deepEqual(usage.snapshot().appIds,['test.b','test.a']);assert.equal(usage.snapshot().status,'observing');usage.flush();assert.equal(statSync(usage.path).mode&0o777,0o600);await usage.stop();assert.deepEqual(child.signals,['SIGTERM']);
 const stored=JSON.parse(readFileSync(usage.path));assert.equal(stored.entries.length,2);assert.equal(stored.entries[0].at,100);assert.ok(!readFileSync(usage.path,'utf8').includes('Alpha'));assert.deepEqual(new AppUsage(dir,apps).snapshot().appIds,['test.b','test.a']);assert.equal(readFileSync(join(dir,'config.json'),'utf8'),config);
});
test('T71 damaged usage is preserved separately and never damages or resets configuration',t=>{
 const dir=folder(t);writeFileSync(join(dir,'app-usage.json'),'bad bytes');writeFileSync(join(dir,'config.json'),'original configuration');const usage=new AppUsage(dir,apps,{log:()=>{}});assert.ok(usage.damagedCopy);assert.equal(readFileSync(usage.damagedCopy,'utf8'),'bad bytes');assert.deepEqual(usage.snapshot().appIds,[]);assert.equal(readFileSync(join(dir,'config.json'),'utf8'),'original configuration');usage.terminate();
});
test('T71 partial NDJSON is accepted; invalid, oversized and flooding streams terminate the child and degrade softly',async t=>{
 for(const invalid of [child=>child.stdout.write('x'.repeat(1025)),child=>child.line({type:'activated',appId:'test.a',title:'private'}),child=>child.stderr.write(Buffer.alloc(4097)),child=>{for(let i=0;i<601;i++)child.app(i%2?'test.a':'test.b');}]){
  const child=new FakeChild(),usage=new AppUsage(folder(t),apps,{child:()=>child,retryMs:10000,log:()=>{}});usage.start();child.stdout.write('{"type":');child.stdout.write('"ready"}\n');child.app('test.a');assert.equal(usage.snapshot().status,'observing');invalid(child);await tick();assert.ok(child.signals.includes('SIGKILL'));assert.equal(usage.snapshot().status,'unavailable');await usage.stop();
 }
});
test('T71 observer exit retries with one replacement, and stop cancels retry and flushes pending observations',async t=>{
 const children=[],usage=new AppUsage(folder(t),apps,{child:()=>{const child=new FakeChild();children.push(child);return child;},retryMs:10,log:()=>{}});usage.start();children[0].ready();children[0].app('test.a');children[0].kill('SIGTERM');await new Promise(resolve=>setTimeout(resolve,25));assert.equal(children.length,2);children[1].ready();children[1].app('test.c');await usage.stop();assert.ok(existsSync(usage.path));assert.deepEqual(JSON.parse(readFileSync(usage.path)).entries.map(e=>e.appId),['test.a','test.c']);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(children.length,2);
});
test('T71 usage capacity is bounded, evicts oldest ids, and reply parsing rejects fabricated fields',async t=>{
 let now=0;const catalog=Array.from({length:2050},(_,i)=>({id:`test.app${i}`,name:`App ${i}`})),child=new FakeChild(),usage=new AppUsage(folder(t),catalog,{child:()=>child,now:()=>now,log:()=>{}});usage.start();child.ready();for(const app of catalog){now+=1000;child.app(app.id);}assert.equal(usage.snapshot().appIds.length,2048);assert.equal(usage.snapshot().appIds[0],'test.app2049');assert.ok(!usage.snapshot().appIds.includes('test.app0'));await usage.stop();assert.ok(statSync(usage.path).size<524288);
 assert.deepEqual(parseAppRecent({status:'observing',appIds:['test.a']}),{status:'observing',appIds:['test.a']});for(const value of [{status:'observing',appIds:['test.a','test.a']},{status:'observing',appIds:[],window:'private'},{status:'fake',appIds:[]}])assert.throws(()=>parseAppRecent(value));
});
test('T71 sort uses Mac observation ranks only, stable name fallback, reverse names and bundle-id search',()=>{
 assert.deepEqual(sortedLibraryApps(apps,'','recent',['test.c','unknown','test.b']).map(a=>a.id),['test.c','test.b','test.a']);assert.deepEqual(sortedLibraryApps(apps,'','az',[]).map(a=>a.id),['test.a','test.b','test.c']);assert.deepEqual(sortedLibraryApps(apps,'','za',[]).map(a=>a.id),['test.c','test.b','test.a']);assert.deepEqual(sortedLibraryApps(apps,'test.b','recent',[]),[apps[1]]);
});
const cards=f=>f.el('shelf-previews').children.filter(n=>n.className?.includes('shelf-app-card'));
const open=async(t,extra={})=>{const f=await client(t,{apps,...extra});f.el('edit-layout').emit('click');f.el('shelf-toggle').emit('click');await f.drain();return f;};
const menu=(f,card=cards(f)[0],event='contextmenu',extra={})=>card.emit(event,{clientX:10,clientY:10,...extra});
const chooseWindows=f=>f.el('shelf-app-window-action').emit('click');
const save=async f=>{f.el('desk-save').emit('click');await f.drain();await f.drain();return f.calls.findLast(c=>c.path==='/api/configuration/save')?.data;};
test('T71 merged App cards add complete bindings without settings, and Undo leaves the original config unchanged',async t=>{
 const f=await open(t),before=JSON.stringify(f.state.config);assert.deepEqual(f.el('shelf-types').children.map(n=>n.children[0].textContent),['App','Other Key','Pages','Widget']);cards(f)[0].emit('click');await f.drain();assert.equal(f.el('editor').hidden,true);assert.equal(f.count('execute'),0);assert.equal(f.count('configuration/save'),0);f.el('edit-undo').emit('click');assert.equal(f.el('save-message').dataset.dirty,'false');assert.equal(JSON.stringify(f.state.config),before);
 cards(f)[1].emit('click');const candidate=await save(f);assert.deepEqual(allComponents(candidate).at(-1).action,{type:'app.open',appId:'test.b'});assert.equal(allComponents(candidate).at(-1).size,'S');
});
test('T71 search and Sort keep stable input focus; only open/Recent refresh Mac usage and adding an app does not',async t=>{
 const f=await open(t);assert.equal(f.count('apps/recent'),1);const input=f.el('shelf-search');input.focus();input.value='test.b';input.emit('input');await f.drain();assert.equal(document.activeElement,input);assert.equal(cards(f).length,1);assert.equal(cards(f)[0].dataset.appId,'test.b');assert.equal(f.count('apps/recent'),1);
 input.value='';input.emit('input');f.el('shelf-app-sort').value='za';f.el('shelf-app-sort').emit('change');assert.deepEqual(cards(f).map(n=>n.dataset.appId),['test.c','test.b','test.a']);f.recent={status:'observing',appIds:['test.b']};f.el('shelf-app-sort').value='recent';f.el('shelf-app-sort').emit('change');await f.drain();assert.equal(cards(f)[0].dataset.appId,'test.b');cards(f)[0].emit('click');assert.equal(f.count('apps/recent'),2);assert.equal(f.count('execute'),0);
});
test('T71 right-click, keyboard context and Esc/outside never add an app; window selection binds exact title',async t=>{
 const f=await open(t);menu(f);assert.equal(f.el('shelf-app-menu').hidden,false);assert.equal(f.count('windows'),0);assert.equal(f.el('save-message').dataset.dirty,'false');f.documentEvents.get('keydown')({key:'Escape',preventDefault(){},stopPropagation(){}});assert.equal(f.el('shelf-app-menu').hidden,true);
 menu(f,cards(f)[0],'keydown',{key:'F10',shiftKey:true});assert.equal(f.el('shelf-app-menu').hidden,false);f.documentEvents.get('pointerdown')({target:f.el('body')});assert.equal(f.el('shelf-app-menu').hidden,true);
 menu(f);chooseWindows(f);assert.equal(f.count('windows'),1);await f.drain();await f.drain();f.el('shelf-window-list').children[0].emit('click');await f.drain();assert.equal(f.el('editor').hidden,true);const config=await save(f);assert.deepEqual(allComponents(config).at(-1).action,{type:'window.activate',appId:'test.a',title:'Win11X99',match:'exact'});assert.equal(f.count('execute'),0);
});
test('T71 touch hold opens the same menu without a click; moving past the threshold cancels hold (hold is 400ms since T85)',async t=>{
 const f=await open(t),card=cards(f)[0],down={isPrimary:true,button:0,pointerId:1,pointerType:'touch',clientX:10,clientY:10};card.emit('pointerdown',down);await f.fireTimer(400);card.emit('pointerup',{pointerId:1});card.emit('click');assert.equal(f.el('shelf-app-menu').hidden,false);assert.equal(f.el('save-message').dataset.dirty,'false');f.documentEvents.get('keydown')({key:'Escape',preventDefault(){},stopPropagation(){}});
 cards(f)[0].emit('pointerdown',{...down,pointerId:2});cards(f)[0].emit('pointermove',{pointerId:2,clientX:40,clientY:10});assert.ok(![...f.timers.values()].some(timer=>timer.delay===400));assert.equal(f.el('shelf-app-menu').hidden,true);
});
test('T71 app names cannot resize cards, preserve full title/aria text, and disclose unavailable Mac usage',async t=>{
 const long='A very long application name '.repeat(5),f=await open(t,{apps:[{id:'test.long',name:long}]});assert.equal(cards(f)[0].title,long);assert.equal(cards(f)[0].children[1].title,long);assert.ok(cards(f)[0].getAttribute('aria-label').includes(long));f.recent={status:'unavailable',appIds:[],message:'Observation unavailable'};f.el('shelf-app-sort').value='recent';f.el('shelf-app-sort').emit('change');await f.drain();assert.match(f.el('shelf-app-usage').textContent,/Observation unavailable/);
 const css=readFileSync(new URL('../apps/web/style.css',import.meta.url),'utf8');assert.match(css,/\.shelf-card\.shelf-app-card\{[^}]*border:0;[^}]*background:transparent/,'T84: Launchpad tiles have no frame');assert.match(css,/\.shelf-app-card \.shelf-caption\{[^}]*white-space:nowrap;overflow:hidden;text-overflow:ellipsis/);
});
test('T71 a recent reply cannot replace a pointer-held card before its native click',async t=>{
 const f=await open(t);f.heldRecent=deferred();f.el('shelf-app-sort').value='recent';f.el('shelf-app-sort').emit('change');const card=cards(f)[0];card.emit('pointerdown',{isPrimary:true,button:0,pointerId:1,pointerType:'mouse',clientX:10,clientY:10});f.heldRecent.resolve({status:'observing',appIds:['test.c']});await f.drain();assert.equal(cards(f)[0],card);card.emit('pointerup',{pointerId:1});card.emit('click');assert.equal(f.el('save-message').dataset.dirty,'true');
});

test('T71 longest legal IDs survive a full-capacity persisted reload',async t=>{
 let now=0; const catalog=Array.from({length:2048},(_,i)=>({id:`a${String(i).padStart(4,'0')}${'x'.repeat(250)}`,name:`App ${i}`}));
 const child=new FakeChild(),dir=folder(t),usage=new AppUsage(dir,catalog,{child:()=>child,now:()=>now,log:()=>{}});usage.start();child.ready();for(const app of catalog){now+=1000;child.app(app.id);}await usage.stop();
 assert.ok(statSync(usage.path).size<1048576);const loaded=new AppUsage(dir,catalog,{log:()=>{}});assert.equal(loaded.snapshot().appIds.length,2048);assert.equal(loaded.damagedCopy,undefined);
});
test('T71 observer stops retrying after eight consecutive failures',async t=>{
 let attempts=0;const usage=new AppUsage(folder(t),apps,{child:()=>{attempts++;throw Error('spawn failed');},retryMs:1,log:()=>{}});usage.start();await new Promise(resolve=>setTimeout(resolve,350));assert.equal(attempts,8);assert.equal(usage.snapshot().status,'unavailable');await usage.stop();
});
test('T71 keyboard context dismissal preserves the next normal activation',async t=>{
 const f=await open(t),card=cards(f)[0];menu(f,card,'keydown',{key:'ContextMenu'});f.documentEvents.get('keydown')({key:'Escape',preventDefault(){},stopPropagation(){}});card.emit('click',{detail:0});assert.equal(f.el('save-message').dataset.dirty,'true');
});
test('T71 stale Recent reply cannot reorder a selected name sort',async t=>{
 const f=await open(t);f.heldRecent=deferred();f.el('shelf-app-sort').value='recent';f.el('shelf-app-sort').emit('change');f.el('shelf-app-sort').value='az';f.el('shelf-app-sort').emit('change');f.heldRecent.resolve({status:'observing',appIds:['test.c']});await f.drain();assert.deepEqual(cards(f).map(n=>n.dataset.appId),['test.a','test.b','test.c']);
});
test('T71 releasing outside a held card applies deferred Recent order',async t=>{
 const f=await open(t);f.heldRecent=deferred();f.el('shelf-app-sort').value='recent';f.el('shelf-app-sort').emit('change');const card=cards(f)[0];card.emit('pointerdown',{isPrimary:true,button:0,pointerId:14,pointerType:'mouse',clientX:10,clientY:10});f.heldRecent.resolve({status:'observing',appIds:['test.c']});await f.drain();assert.equal(cards(f)[0],card);f.documentEvents.get('pointerup')({pointerId:14});await f.fireTimer(0);assert.equal(cards(f)[0].dataset.appId,'test.c');
});
