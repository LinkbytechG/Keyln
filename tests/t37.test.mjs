import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fromGrid} from './helpers/layout.mjs';

// T37: choosing a Mac app in a window with a grid of large icons instead of a drop-down list. The compiled client runs against the same
// minimal fake DOM and fake Host as tests/client.test.mjs (copied, trimmed); the markup and stylesheet are read as text.
// None of this is browser rendering or Surface evidence: see Docs/verification/T37.md.
let scenario=0;
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const APPS=[{id:'a.zebra',name:'Zebra'},{id:'a.alpha',name:'Alpha'},{id:'test.app',name:'Fake app'},{id:'com.vendor.Helper',name:'Vendor Helper'}];
async function client(t,{configuration,apps=APPS}={}) {
  class Element {
    textContent='';value='';hidden=false;disabled=false;checked=false;dataset={};listeners=new Map();
    children=[];attributes=new Map();parentNode=undefined;root=false;id='';
    style={setProperty(name,value){this[name]=value;},removeProperty(name){delete this[name];}};
    get isConnected(){return this.root||!!this.parentNode?.isConnected;}
    addEventListener(type,listener){const list=this.listeners.get(type)||[];list.push(listener);this.listeners.set(type,list);}
    append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node);}}
    replaceChildren(...nodes){for(const node of this.children)node.parentNode=undefined;this.children=[];this.append(...nodes);}
    replaceWith(node){const parent=this.parentNode;if(parent){parent.children[parent.children.indexOf(this)]=node;node.parentNode=parent;this.parentNode=undefined;}else node.root=this.root;}
    contains(node){return !!node&&(node===this||this.children.some(child=>child.contains?.(node)));}
    setAttribute(name,value){this.attributes.set(name,String(value));}
    getAttribute(name){return this.attributes.get(name)??null;}
    removeAttribute(name){this.attributes.delete(name);}
    focus(){f.focused=this.id;globalThis.document.activeElement=this;}
    scrollIntoView(){}
    showModal(){this.open=true;}
    close(){if(!this.open)return;this.open=false;this.emit('close');}
    click(){this.emit('click');}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(item=>item!==this);this.parentNode=undefined;}
    emit(type,properties={}){const event={preventDefault(){},stopPropagation(){},...properties};for(const listener of this.listeners.get(type)||[]) listener(event);this['on'+type]?.(event);}
  }
  const elements=new Map(),storage=new Map(),local=new Map(),originals=new Map(),timers=new Map();let timerId=0;
  const el=id=>{const find=node=>node.id===id?node:node.children?.map(find).find(Boolean);for(const root of elements.values()){let tree=root;while(tree.parentNode)tree=tree.parentNode;const match=find(tree);if(match&&match!==root)return match;}if(!elements.has(id)){const node=new Element();node.root=true;node.id=id;elements.set(id,node);}return elements.get(id);};
  el('result-card').dataset.status='ready';el('risk-confirm').hidden=true;
  const f={el,sockets:[],calls:[],intervals:[],timers,storage,local,windowEvents:new Map(),documentEvents:new Map(),execute:deferred(),
    state:{config:configuration||fromGrid({schemaVersion:2,revision:4,profiles:[{id:'main',name:'My buttons'}],buttons:[{id:'primary',profileId:'main',position:0,label:'Test app',icon:'app',action:{type:'app.open',appId:'test.app'}}]}),scripts:[],shortcuts:[],busy:false,instanceId:randomUUID()}};
  f.button=(id='primary')=>el('button-grid').children.find(node=>node.dataset.buttonId===id);
  f.count=path=>f.calls.filter(call=>call.path===`/api/${path}`).length;
  f.until=async condition=>{for(let n=0;n<80&&!condition();n++) await new Promise(resolve=>setImmediate(resolve));assert.ok(condition(),'Client did not reach expected state');};
  class Socket {
    static OPEN=1;static CONNECTING=0;readyState=0;sequence=0;
    constructor(){f.sockets.push(this);queueMicrotask(()=>{if(this.readyState===0){this.readyState=1;this.onopen?.({});this.state();}});}
    push(payload){this.onmessage?.({data:JSON.stringify({version:2,instanceId:f.state.instanceId,sequence:++this.sequence,...payload})});}
    state(extra={}){this.push({type:'state',revision:f.state.config.revision,busy:f.state.busy,...extra});}
    close(code=1000){this.readyState=3;this.onclose?.({code});}
  }
  const response=value=>({ok:true,json:async()=>value});
  const globals={
    document:{body:el('body'),documentElement:el('html'),querySelector:()=>null,getElementById:el,createElement:()=>new Element(),createElementNS:()=>new Element(),createTextNode:text=>Object.assign(new Element(),{textContent:text}),querySelectorAll:()=>[],addEventListener:(type,fn)=>f.documentEvents.set(type,fn),hidden:false},window:{matchMedia:()=>({matches:false}),addEventListener:(type,fn)=>f.windowEvents.set(type,fn)},navigator:{onLine:true},location:new URL('https://127.0.0.1:8940/'),
    Option:class{constructor(text,value){this.text=text;this.value=value;}},WebSocket:Socket,
    sessionStorage:{setItem:(key,value)=>storage.set(key,value),getItem:key=>storage.get(key)??null,removeItem:key=>storage.delete(key)},
    localStorage:{setItem:(key,value)=>local.set(key,String(value)),getItem:key=>local.get(key)??null,removeItem:key=>local.delete(key)},
    setTimeout:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;},clearTimeout:id=>timers.delete(id),
    setInterval:callback=>{f.intervals.push(callback);return f.intervals.length;},
    fetch:async(path,options)=>{
      f.calls.push({path,data:JSON.parse(options.body)});
      if(path==='/api/configuration')return response(f.state);
      if(path==='/api/apps')return response({apps});
      if(path==='/api/app-icons')return new Response('',{status:404});
      if(path==='/api/configuration/save'){
        const input=JSON.parse(options.body);
        if(input.revision!==f.state.config.revision)return {ok:false,status:409,json:async()=>({error:{code:'CONFIG_CONFLICT',message:'Configuration changed.'}})};
        f.state={...f.state,config:{...input,revision:input.revision+1}};return response({config:f.state.config});
      }
      if(path==='/api/execute')return response(await f.execute.promise);
      throw new Error(`Unexpected client request: ${path}`);
    },
  };
  for(const [key,value] of Object.entries(globals)){originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  t.after(()=>{for(const [key,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  await import(`../dist/apps/web/app.js?t37=${++scenario}`);
  await f.until(()=>f.sockets.length===1&&f.sockets[0].readyState===1);
  await f.until(()=>el('button-grid').children.some(node=>node.dataset.buttonId&&!node.disabled));
  return f;
}
const html=readFileSync(new URL('../apps/web/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../apps/web/style.css',import.meta.url),'utf8');
const tiles=f=>f.el('app-dialog-grid').children.filter(node=>node.dataset.appId);
const action=(f,type)=>f.el('action-options').children.find(node=>node.dataset.actionType===type).emit('click');
const saved=async f=>{await f.until(()=>f.count('configuration/save')>=1&&f.el('save-message').textContent==='Saved on your Mac.');};

// T52: an empty slot opens the Add to this page window first; choosing Key at S goes on to the New key popup.
const pick=f=>{assert.equal(f.el('add-dialog').open,true,'the Add to this page window is open');f.el('add-size-S').emit('click');};
test('T37 markup and stylesheet: a field button, one shared native dialog with a header, search and grid; the old combobox is gone',()=>{
  assert.match(html,/<div id="app-fields"><label for="app-select">Mac application<\/label><div id="app-select-host"><\/div><\/div>/);
  assert.doesNotMatch(html,/<input id="app-select"|role="combobox"|app-select-results/);
  const dialog=html.slice(html.indexOf('<dialog id="app-dialog"'),html.indexOf('</dialog>',html.indexOf('<dialog id="app-dialog"')));
  assert.match(dialog,/^<dialog id="app-dialog" class="app-dialog" aria-labelledby="app-dialog-title">/);
  const order=['id="app-dialog-title">Choose a Mac app<','id="app-dialog-close"','id="app-dialog-search"','id="app-dialog-status"','id="app-dialog-grid"'].map(needle=>dialog.indexOf(needle));
  assert.ok(order.every(index=>index>=0),'every part is there');assert.deepEqual([...order].sort((a,b)=>a-b),order,'title and close, search, status, grid');
  assert.match(dialog,/<button id="app-dialog-close" class="icon-close" type="button" aria-label="Close app picker">/);assert.match(dialog,/<input id="app-dialog-search" type="search"[^>]*aria-label="Search Mac apps"/);
  assert.doesNotMatch(dialog,/<form|autofocus/,'no form, and no autofocus attribute: focus is decided in code');
  assert.ok(html.indexOf('<dialog id="app-dialog"')>html.indexOf('</main>'),'the picker sits outside the key popup and the layout');
  const rule=(selector,from=0)=>{let start=css.indexOf(selector+'{',from);while(start>0&&!/[}\n]/.test(css[start-1]))start=css.indexOf(selector+'{',start+1);assert.ok(start>=0,selector);return css.slice(start,css.indexOf('}',start)+1);};
  assert.match(rule('.app-dialog'),/width:min\(960px,calc\(100vw - 32px\)\)/);assert.match(rule('.app-dialog'),/height:80dvh/);assert.match(css,/\.app-dialog\[open\]\{display:flex;flex-direction:column\}/);assert.match(css,/\.app-dialog::backdrop\{background:#000b\}/);
  assert.match(rule('.app-dialog-grid'),/grid-template-columns:repeat\(auto-fill,minmax\(104px,1fr\)\)/);assert.match(rule('.app-dialog-grid'),/overflow-y:auto/);
  assert.match(rule('.app-tile .tile-icon'),/width:64px;height:64px/);assert.match(rule('.app-tile'),/min-height:116px/);assert.match(rule('.app-tile-name'),/-webkit-line-clamp:2/);assert.match(rule('.app-tile-name'),/^\.app-tile-name\{flex:none;/,'the name keeps its natural height of up to two lines; the tile grows instead');assert.doesNotMatch(rule('.app-tile'),/(^|[;{])height:/,'a tile has no fixed height');
  assert.match(rule('.app-field'),/min-height:40px/,'T79: the Mac application field is a compact 40px');assert.match(rule('.app-field .tile-icon'),/width:24px;height:24px/);
  const sheet=css.slice(css.indexOf('@media(max-width:600px){\n  .app-dialog{'));assert.match(sheet.slice(0,sheet.indexOf('\n}\n')),/\.app-dialog\{width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;border:0;border-radius:0\}/,'full screen on a phone');
});
