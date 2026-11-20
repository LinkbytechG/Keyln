import test from 'node:test';
import assert from 'node:assert/strict';
import {assembledPage} from './helpers/widget-dom.mjs';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fromGrid} from './helpers/layout.mjs';

// T38: phones. Small keys get a one-line 11px name and a larger icon; the Latest result and Recent activity cards fold into one slim status bar.
// The compiled client runs against the same minimal fake DOM and fake Host as tests/client.test.mjs (copied, trimmed); the stylesheet is read as
// text. None of this is browser rendering or Surface evidence: see Docs/verification/T38.md.
let scenario=0;
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function client(t,{cell=0,phone=false}={}) {
  class Element {
    textContent='';value='';hidden=false;disabled=false;checked=false;dataset={};listeners=new Map();
    children=[];attributes=new Map();parentNode=undefined;root=false;id='';
    style={setProperty(name,value){this[name]=value;},removeProperty(name){delete this[name];}};
    get isConnected(){return this.root||!!this.parentNode?.isConnected;}
    addEventListener(type,listener){const list=this.listeners.get(type)||[];list.push(listener);this.listeners.set(type,list);}
    append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node);}}
    replaceChildren(...nodes){for(const node of this.children)node.parentNode=undefined;this.children=[];this.append(...nodes);}
    contains(node){return !!node&&(node===this||this.children.some(child=>child.contains?.(node)));}
    setAttribute(name,value){this.attributes.set(name,String(value));}
    getAttribute(name){return this.attributes.get(name)??null;}
    removeAttribute(name){this.attributes.delete(name);}
    focus(){}
    scrollIntoView(){}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(item=>item!==this);this.parentNode=undefined;}
    // Every element measures `cell` pixels wide, so the grid can decide whether its cells are small.
    getBoundingClientRect(){return {width:cell,height:cell,left:0,top:0,right:cell,bottom:cell};}
    emit(type,properties={}){const event={preventDefault(){},stopPropagation(){},...properties};for(const listener of this.listeners.get(type)||[]) listener(event);}
  }
  const elements=new Map(),storage=new Map(),local=new Map(),originals=new Map(),timers=new Map();let timerId=0;
  const el=id=>{const find=node=>node.id===id?node:node.children?.map(find).find(Boolean);for(const root of elements.values()){let tree=root;while(tree.parentNode)tree=tree.parentNode;const match=find(tree);if(match&&match!==root)return match;}if(!elements.has(id)){const node=new Element();node.root=true;node.id=id;elements.set(id,node);}return elements.get(id);};
  el('result-card').dataset.status='ready';el('risk-confirm').hidden=true;
  const f={el,sockets:[],calls:[],intervals:[],timers,storage,local,windowEvents:new Map(),documentEvents:new Map(),execute:deferred(),
    state:{config:fromGrid({schemaVersion:2,revision:4,profiles:[{id:'main',name:'My buttons'}],buttons:[{id:'primary',profileId:'main',position:0,label:'Test app',icon:'app',action:{type:'app.open',appId:'test.app'}}]}),scripts:[],shortcuts:[],busy:false,instanceId:randomUUID()}};
  f.button=(id='primary')=>el('button-grid').children.find(node=>node.dataset.buttonId===id);
  f.count=path=>f.calls.filter(call=>call.path===`/api/${path}`).length;
  f.until=async condition=>{for(let n=0;n<80&&!condition();n++) await new Promise(resolve=>setImmediate(resolve));assert.ok(condition(),'Client did not reach expected state');};
  f.drain=()=>new Promise(resolve=>setImmediate(resolve));
  const executionId=randomUUID();
  f.execution=(status,extra={})=>({id:executionId,requestId:f.calls.findLast(call=>call.path==='/api/execute')?.data.requestId,actionType:'app.open',status,createdAt:1,message:'Fake transport only',...(!['accepted','running'].includes(status)?{finishedAt:2}:{}),...extra});
  class Socket {
    static OPEN=1;static CONNECTING=0;readyState=0;sequence=0;
    constructor(){f.sockets.push(this);queueMicrotask(()=>{if(this.readyState===0){this.readyState=1;this.onopen?.({});this.state();}});}
    push(payload){this.onmessage?.({data:JSON.stringify({version:2,instanceId:f.state.instanceId,sequence:++this.sequence,...payload})});}
    state(extra={}){this.push({type:'state',revision:f.state.config.revision,busy:f.state.busy,...extra});}
    close(code=1000){this.readyState=3;this.onclose?.({code});}
  }
  const response=value=>({ok:true,json:async()=>value});
  const windowObject={matchMedia:query=>({matches:phone&&/max-width:\s*600px/.test(query)}),addEventListener:()=>{}};
  if(phone)windowObject.getComputedStyle=()=>({columnGap:'8px',rowGap:'8px',fontSize:'12px',getPropertyValue:()=>'.58'});
  const globals={
    document:{body:el('body'),documentElement:el('html'),querySelector:()=>null,getElementById:el,createElement:()=>new Element(),createElementNS:()=>new Element(),createTextNode:text=>Object.assign(new Element(),{textContent:text}),querySelectorAll:()=>[],addEventListener:()=>{},hidden:false},window:windowObject,navigator:{onLine:true},location:new URL('https://127.0.0.1:8940/'),
    Option:class{constructor(text,value){this.text=text;this.value=value;}},WebSocket:Socket,
    sessionStorage:{setItem:(key,value)=>storage.set(key,value),getItem:key=>storage.get(key)??null,removeItem:key=>storage.delete(key)},
    localStorage:{setItem:(key,value)=>local.set(key,String(value)),getItem:key=>local.get(key)??null,removeItem:key=>local.delete(key)},
    setTimeout:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;},clearTimeout:id=>timers.delete(id),
    setInterval:callback=>{f.intervals.push(callback);return f.intervals.length;},
    fetch:async(path,options)=>{
      f.calls.push({path,data:JSON.parse(options.body)});
      if(path==='/api/configuration')return response(f.state);
      if(path==='/api/apps')return response({apps:[{id:'test.app',name:'Fake app'}]});
      if(path==='/api/app-icons')return new Response('',{status:404});
      if(path==='/api/execute')return response(await f.execute.promise);
      throw new Error(`Unexpected client request: ${path}`);
    },
  };
  for(const [key,value] of Object.entries(globals)){originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  t.after(()=>{for(const [key,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  await import(`../dist/apps/web/app.js?t38=${++scenario}`);
  await f.until(()=>f.sockets.length===1&&f.sockets[0].readyState===1);
  await f.until(()=>el('button-grid').children.some(node=>node.dataset.buttonId&&!node.disabled));
  return f;
}
const html=await assembledPage();
const css=readFileSync(new URL('../apps/web/style.css',import.meta.url),'utf8');
const rule=(selector,from=0)=>{let start=css.indexOf(selector+'{',from);while(start>0&&!/[}\n]/.test(css[start-1]))start=css.indexOf(selector+'{',start+1);assert.ok(start>=0,selector);return css.slice(start,css.indexOf('}',start)+1);};

// T52: an empty slot opens the Add to this page window first; choosing Key at S goes on to the New key popup.
const pick=f=>{assert.ok(f.el('add-size-S').dataset.tier,'the Add to this page window is filled');f.el('add-size-S').emit('click');};
test('T58 small keys: a key under 80px shows its name on one 11px line with an ellipsis and a larger icon, on any screen; the rules read the key, not the grid',()=>{
  assert.match(css,/\.control-tile\[data-small=true\] \.tile-label\{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:11px;line-height:1\.2;margin-top:2px\}/);
  assert.match(css,/\.control-tile\[data-small=true\]\{--icon-scale:\.58\}/,'medium icons are bigger (the desktop value is .5)');
  assert.match(css,/\.control-tile\[data-small=true\]\[data-icon-scale=small\]\{--icon-scale:\.44\}/);assert.match(css,/\.control-tile\[data-small=true\]\[data-icon-scale=large\]\{--icon-scale:\.66\}/);
  assert.doesNotMatch(css,/\.button-grid\[data-small=true\]/,'no grid-level mark is left');
  // T64: the phone status bar of the old side column is gone; nothing of it is left outside the phone media query either.
  assert.doesNotMatch(css,/\.status-bar/,'the status bar styles are gone');
  const source=readFileSync(new URL('../apps/web/console.ts',import.meta.url),'utf8'),view=readFileSync(new URL('../apps/web/page-view.ts',import.meta.url),'utf8');
  assert.match(view,/SMALL_KEY_PX = 80/);assert.match(view,/Math\.min\(box\.width, box\.height\) < SMALL_KEY_PX/);assert.match(source,/tile\.node\.dataset\.small = String\(/);
});
test('T38 desktop rules are untouched: name size, label clamp, result and activity panels',()=>{
  const keys=css.indexOf('/* ---------- keys');
  assert.match(rule('.control-tile',keys),/--fs:clamp\(12px,calc\(\(var\(--cell\) - 100px\) \* 100 \+ 16px\),16px\);/);
  assert.match(rule('.control-tile',keys),/--icon-scale:\.5;--icon-mult:1/);
  assert.match(rule('.control-tile .tile-label',keys),/display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis/,'T102: one line, then an ellipsis');
  assert.match(css,/\.control-tile\[data-icon-scale=small\]\{--icon-scale:\.38\}/);assert.match(css,/\.control-tile\[data-icon-scale=large\]\{--icon-scale:\.62\}/);
});
