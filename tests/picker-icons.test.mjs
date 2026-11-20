import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppPicker} from '../dist/apps/web/app-picker.js';
import {loadAppIcon} from '../dist/apps/web/app-icons.js';

// Production App picker window + loader, controlled IntersectionObserver notifications, no native exports.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1EAAAAASUVORK5CYII=','base64');png.writeUInt32BE(128,16);png.writeUInt32BE(128,20);
const turn=()=>new Promise(r=>setImmediate(r));let sequence=0;
function fixture(t){
 class Element {
  children=[];attributes=new Map();listeners=new Map();dataset={};className='';id='';value='';hidden=false;disabled=false;open=false;parentNode=null;root=false;
  style={setProperty(){},removeProperty(){}};
  get isConnected(){return this.root||!!this.parentNode?.isConnected;}
  setAttribute(k,v){this.attributes.set(k,String(v));}getAttribute(k){return this.attributes.get(k)??null;}removeAttribute(k){this.attributes.delete(k);}
  append(...nodes){for(const n of nodes){n.parentNode=this;this.children.push(n);}}
  replaceChildren(...nodes){for(const n of this.children)n.parentNode=null;this.children=[];this.append(...nodes);}
  contains(n){return n===this||this.children.some(c=>c.contains(n));}
  addEventListener(type,fn){const set=this.listeners.get(type)||new Set();set.add(fn);this.listeners.set(type,set);}
  removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
  emit(type,extra={}){for(const fn of this.listeners.get(type)||[])fn({preventDefault(){},stopPropagation(){},...extra});}
  showModal(){this.open=true;}close(){if(!this.open)return;this.open=false;this.emit('close');}
  focus(){}scrollIntoView(){}
 }
 const observers=[],calls=[],gates=[],registry=new Map();
 const byId=id=>{if(!registry.has(id)){const node=new Element();node.id=id;node.root=true;registry.set(id,node);}return registry.get(id);};
 class Observer {
  targets=new Set();records=[];taken=0;
  constructor(callback){this.callback=callback;observers.push(this);}
  observe(n){this.targets.add(n);}disconnect(){this.targets.clear();}takeRecords(){this.taken++;return this.records.splice(0);}
  deliver(nodes,visible=true){this.callback(nodes.map(target=>({target,isIntersecting:visible})));}
 }
 const replacements={document:{createElement:()=>new Element(),createElementNS:()=>new Element(),getElementById:byId},IntersectionObserver:Observer,fetch:async(_url,options)=>{
  const ids=JSON.parse(options.body).appIds;calls.push(ids);let resolve;const promise=new Promise(yes=>resolve=yes);gates.push({resolve});await promise;return Response.json({icons:ids.map(appId=>({appId,png:png.toString('base64')}))});
 }};
 const old=new Map();for(const[k,v]of Object.entries(replacements)){old.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{value:v,configurable:true,writable:true});}
 const number=++sequence,host=new Element(),apps=Array.from({length:60},(_,i)=>({id:`test.picker${number}.app${i}`,name:`App ${i}`}));
 const picker=createAppPicker(host,'picker-field',()=>assert.fail('Icon loading must not change binding'));picker.set(apps,'');
 const grid=byId('app-dialog-grid'),search=byId('app-dialog-search'),dialog=byId('app-dialog');
 const state={picker,host,apps,grid,search,dialog,calls,gates,get observer(){return observers[0];},tiles:()=>grid.children.filter(node=>node.dataset.appId),open(){host.children[0].emit('click');},async flush(){for(let n=0;n<5;n++)await turn();}};
 t.after(async()=>{picker.setDisabled(true);for(const g of gates)g.resolve();await state.flush();for(const[k,d]of old){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}});
 return state;
}
test('closing the App picker removes queued icons before fetch and clears observer records',async t=>{
 const f=fixture(t);f.open();const rows=f.tiles();f.observer.deliver(rows.slice(0,16));f.observer.records.push(...rows);
 f.dialog.emit('cancel');await f.flush();assert.equal(f.calls.length,0);assert.equal(f.observer.records.length,0);assert.ok(f.observer.taken>0);assert.equal(f.dialog.open,false);assert.equal(f.grid.children.length,0);
});
test('search rerender cancels old queues and ignores late observations for removed tiles',async t=>{
 const f=fixture(t);f.open();const rows=f.tiles();f.observer.deliver(rows.slice(0,16));await turn();f.observer.deliver(rows.slice(16,32));await turn();assert.equal(f.calls.length,2);
 f.observer.deliver(rows.slice(32,48));f.search.value=f.apps[48].name;f.search.emit('input');
 f.observer.deliver(rows.slice(32,48)); // Even an already scheduled stale callback must be harmless.
 for(const g of f.gates)g.resolve();await f.flush();assert.equal(f.calls.length,2);assert.equal(f.tiles().length,1);
 f.observer.deliver(f.tiles());await turn();assert.equal(f.calls.length,3);assert.deepEqual(f.calls[2],[f.apps[48].id]);f.gates[2].resolve();await f.flush();assert.equal(f.tiles()[0].children[0].getAttribute('data-glyph'),'app');
});
test('leaving view cancels only that tile; a shared grid consumer survives, and reentry can load later',async t=>{
 const f=fixture(t);f.open();const rows=f.tiles();f.observer.deliver(rows.slice(0,16));await turn();f.observer.deliver(rows.slice(16,32));await turn();
 const offscreen=rows[32].dataset.appId,sharedId=rows[33].dataset.appId;f.observer.deliver(rows.slice(32,40));const shared=loadAppIcon(sharedId);f.observer.deliver(rows.slice(32,34),false);
 f.gates[0].resolve();f.gates[1].resolve();await f.flush();assert.equal(f.calls.length,3);assert.ok(!f.calls[2].includes(offscreen));assert.ok(f.calls[2].includes(sharedId));
 f.gates[2].resolve();assert.ok(await shared);await f.flush();f.observer.deliver([rows[32]]);await turn();assert.equal(f.calls.length,4);assert.deepEqual(f.calls[3],[offscreen]);f.gates[3].resolve();await f.flush();
});
