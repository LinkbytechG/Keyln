import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {importPreview} from '../../dist/apps/host/layout.js';
import {withCustomThemes,v2ToV3,viewFor,applySplit,parseLibraryContent,parseLayoutContent,parseConfigDocument} from '../../dist/packages/contracts/index.js';
import {fromGrid,compat} from './layout.mjs';

// T94: the Host always sends a view with the name and revision of its layout; a fixture written without them gets the ones a fresh Host has.
const withLayoutInfo=config=>{if(config&&typeof config==='object'&&Array.isArray(config.widgets)){if(config.layoutName===undefined)config.layoutName='Surface';if(config.layoutRevision===undefined)config.layoutRevision=0;}return config;};

// The web client run for real (the compiled app.js) against a minimal DOM and a controlled transport. These tests do not provide browser rendering or
// Surface touch evidence. Moved here from client.test.mjs so more than one test file can drive the client.
let scenario=0;
export const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
export async function client(t,{initialPending,initialButton='primary',activeProfile,configuration,scripts=[],shortcuts=[],apps=[{id:'test.app',name:'Fake app'}],autoState=true,iconReply,cachedTheme,deviceTheme,viewport,localSeed,indexedDB,moveMode='insert',dock=false,running,dockOptions}={}) {
  class Element {
    textContent='';value='';hidden=false;disabled=false;checked=false;dataset={};listeners=new Map();
    children=[];attributes=new Map();parentNode=undefined;root=false;id='';scrollTop=0;scrollLeft=0;
    get parentElement(){return this.parentNode;}
    style={setProperty(name,value){this[name]=value;},removeProperty(name){delete this[name];},getPropertyValue(name){return this[name]??'';}};
    get isConnected(){return this.root||!!this.parentNode?.isConnected;}
    addEventListener(type,listener){const list=this.listeners.get(type)||[];list.push(listener);this.listeners.set(type,list);}
    removeEventListener(type,listener){const list=this.listeners.get(type)||[];const index=list.indexOf(listener);if(index>=0)list.splice(index,1);}
    append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node);}}
    replaceChildren(...nodes){for(const node of this.children)node.parentNode=undefined;this.children=[];this.append(...nodes);}
    replaceWith(node){const parent=this.parentNode;if(parent){parent.children[parent.children.indexOf(this)]=node;node.parentNode=parent;this.parentNode=undefined;}else node.root=this.root;}
    contains(node){return !!node&&(node===this||this.children.some(child=>child.contains?.(node)));}
    setAttribute(name,value){this.attributes.set(name,String(value));}
    getAttribute(name){return this.attributes.get(name)??null;}
    removeAttribute(name){this.attributes.delete(name);}
    focus(){f.focused=this.id;globalThis.document.activeElement=this;}
    scrollIntoView(){}
    // T62: a test that drags gives the nodes it touches a box (node.rect = {left,top,width,height}); without one the node has no size.
    getBoundingClientRect(){const r=this.rect??{left:0,top:0,width:0,height:0};return {...r,right:r.left+r.width,bottom:r.top+r.height};}
    showModal(){this.open=true;}
    close(){if(!this.open)return;this.open=false;this.emit('close');}
    click(){if(this.download)f.downloadNames.push(this.download);this.emit('click');}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(item=>item!==this);this.parentNode=undefined;}
    emit(type,properties={}){const event={preventDefault(){},stopPropagation(){},...properties};for(const listener of this.listeners.get(type)||[]) listener(event);this['on'+type]?.(event);}
  }
  const docListeners=new Map(),elements=new Map(),storage=new Map(),local=new Map(),originals=new Map(),timers=new Map();let timerId=0;
  if(cachedTheme)local.set('keyln.theme',cachedTheme);
  // The tests written before T88 drag in Insert mode; the default of the page itself is Swap (a test passes moveMode:null to start from a clean storage).
  if(moveMode)local.set('keyln.moveMode.v1',moveMode);
  if(localSeed)for(const [key,value] of Object.entries(localSeed))local.set(key,value);
  const el=id=>{const find=node=>node.id===id?node:node.children?.map(find).find(Boolean);for(const root of elements.values()){let tree=root;while(tree.parentNode)tree=tree.parentNode;const match=find(tree);if(match&&match!==root)return match;}if(!elements.has(id)){const node=new Element();node.root=true;node.id=id;elements.set(id,node);}return elements.get(id);};
  el('risk-confirm').hidden=true;el('install-panel').hidden=true;el('layout-files-panel').hidden=true;if(initialPending){storage.set('keyln.pending-request',initialPending);storage.set('keyln.pending-button',initialButton);}
  if(activeProfile)storage.set("keyln.active-pages",JSON.stringify({pages:activeProfile}));
  let current;
  const initialTheme=deviceTheme;
  const f={dock,running,dockOptions:{hideKeyedApps:false,align:'center',...dockOptions},activations:[],deviceTheme:initialTheme,el,downloads:[],downloadNames:[],sockets:[],calls:[],intervals:[],timers,storage,local,windowEvents:new Map(),documentEvents:new Map(),execute:deferred(),heldState:undefined,heldResult:undefined,resultFault:undefined};
  current={config:withLayoutInfo(compat(configuration)||fromGrid({revision:4,profiles:[{id:'main',name:'My buttons'}],buttons:[{id:'primary',profileId:'main',position:0,label:'Test app',icon:'app',action:{type:'app.open',appId:'test.app'}}]})),scripts,shortcuts,busy:false,instanceId:randomUUID()};
  Object.defineProperty(f,'state',{enumerable:true,get:()=>current,set:value=>{current={...value,config:withLayoutInfo(compat(value.config))};}});
  const deep=(node,match)=>{for(const child of node.children??[]){if(match(child))return child;const found=deep(child,match);if(found)return found;}return undefined;};
  f.button=(id='primary')=>deep(el('button-grid'),node=>node.dataset?.buttonId===id);
  f.page=id=>deep(el('button-grid'),node=>node.dataset?.pageId===id&&['use-page','page-dot'].includes(node.className));
  const executionId=randomUUID();
  f.execution=(status,extra={})=>({id:executionId,requestId:f.calls.findLast(call=>call.path==='/api/execute')?.data.requestId||initialPending,
    actionType:'app.open',status,createdAt:1,message:'Fake transport only',...(!['accepted','running'].includes(status)?{finishedAt:2}:{}),...extra});
  f.library=async path=>{throw new Error(`Unexpected icon library request: ${path}`);};
  // The v3 document of the layout the fake Host holds (what Export writes).
  f.document=()=>{const config=f.state.config,doc=v2ToV3(config,{layoutName:config.layoutName,theme:f.deviceTheme??undefined});doc.library.revision=config.revision;doc.layouts[0].revision=config.layoutRevision??0;return doc;};
  f.stamp=()=>createHash('sha256').update(JSON.stringify(f.document())).digest('hex');
  f.candidate=input=>{
    const config=f.state.config,doc=v2ToV3(config,{layoutName:config.layoutName});
    const next=applySplit(doc,config.layoutName,{...(input.library?{library:parseLibraryContent(input.library)}:{}),...(input.layout?{layout:parseLayoutContent(input.layout)}:{})});
    return compat({...viewFor(next,config.layoutName),revision:input.libraryRevision,layoutRevision:input.layoutRevision});
  };
  f.count=path=>f.calls.filter(call=>call.path===`/api/${path}`).length;
  f.until=async condition=>{for(let n=0;n<80&&!condition();n++) await new Promise(resolve=>setImmediate(resolve));assert.ok(condition(),'Client did not reach expected state');};
  f.drain=()=>new Promise(resolve=>setImmediate(resolve));
  f.fireTimer=async delay=>{const entry=[...timers].find(([,timer])=>timer.delay===delay);assert.ok(entry,`Missing ${delay}ms timer`);timers.delete(entry[0]);entry[1].callback();await f.drain();};
  class Socket {
    static OPEN=1;static CONNECTING=0;readyState=0;sequence=0;
    constructor(){f.sockets.push(this);queueMicrotask(()=>{if(this.readyState===0){this.readyState=1;this.onopen?.({});if(autoState)this.state();}});}
    push(payload){this.onmessage?.({data:JSON.stringify({version:2,instanceId:f.state.instanceId,sequence:++this.sequence,...payload})});}
    state(extra={}){this.push({type:'state',revision:f.state.config.revision,layoutRevision:f.state.config.layoutRevision??0,busy:f.state.busy,...extra});}
    close(code=1000){this.readyState=3;this.onclose?.({code});}
  }
  const response=value=>({ok:true,status:200,json:async()=>value});
  const globals={
    document:{body:el('body'),documentElement:el('html'),querySelector:()=>null,getElementById:el,createElement:()=>new Element(),createElementNS:()=>new Element(),createTextNode:text=>Object.assign(new Element(),{textContent:text}),querySelectorAll:()=>[],addEventListener:(type,fn)=>{const list=docListeners.get(type)??docListeners.set(type,[]).get(type);list.push(fn);f.documentEvents.set(type,(...args)=>{for(const listener of list)listener(...args);});},removeEventListener:(type,fn)=>{const list=docListeners.get(type);if(list){const i=list.indexOf(fn);if(i>=0)list.splice(i,1);}},hidden:false},window:{matchMedia:()=>({matches:false}),addEventListener:(type,fn)=>f.windowEvents.set(type,fn),...(viewport?{innerWidth:viewport.width,innerHeight:viewport.height}:{})},navigator:{onLine:true},location:Object.assign(new URL('https://127.0.0.1:8940/'),{reload(){f.reloads=(f.reloads||0)+1;}}),
    URL:class extends URL{static createObjectURL(blob){f.downloads.push(blob);return 'blob:owned-layout-test';}static revokeObjectURL(){}},
    Option:class{constructor(text,value){this.text=text;this.value=value;}},WebSocket:Socket,...(indexedDB?{indexedDB}:{}),
    sessionStorage:{setItem:(key,value)=>storage.set(key,value),getItem:key=>storage.get(key)??null,removeItem:key=>storage.delete(key)},
    localStorage:{setItem:(key,value)=>local.set(key,String(value)),getItem:key=>local.get(key)??null,removeItem:key=>local.delete(key)},
    setTimeout:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;},clearTimeout:id=>timers.delete(id),
    setInterval:callback=>{f.intervals.push(callback);return f.intervals.length;},
    fetch:async(path,options)=>{
      const call={path,data:JSON.parse(options.body)};
      // T94: a save request carries only the changed part(s). `call.request` is that request as sent; `call.data` is the whole candidate it describes (the page-shaped view,
      // with the revision numbers it was made on), which is what the tests written before T94 read.
      if(path==='/api/configuration/save'){call.request=call.data;try{call.data=f.candidate(call.request);}catch{/* a malformed request stays as it was */}}
      if(path==='/api/configuration/import'){call.request=call.data;call.data=call.request.config;}
      f.calls.push(call);
      if(path==='/api/configuration'){if(f.configurationFault)return {ok:false,status:f.configurationFault.status,json:async()=>({error:f.configurationFault})};return response(f.heldState?await f.heldState.promise:f.state);}
      if(path==='/api/configuration/export')return response({config:f.document()});
      if(path==='/api/device-theme')return response({theme:f.deviceTheme??null});
      if(path==='/api/device-theme/save'){
        const input=JSON.parse(options.body);
        if(f.heldTheme)await f.heldTheme.promise;
        if(f.themeFault)return {ok:false,status:f.themeFault.status,json:async()=>({error:f.themeFault})};
        if(input.layoutName!==f.state.config.layoutName)return {ok:false,status:409,json:async()=>({error:{code:'CONFIG_CONFLICT',message:'The device layout changed.'}})};
        const previousLayoutRevision=f.state.config.layoutRevision;
        // T94: the theme is the layout's: saving it raises the layout's revision (and nothing else).
        if(f.deviceTheme!==input.theme){f.deviceTheme=input.theme;f.state={...f.state,config:{...f.state.config,layoutRevision:(f.state.config.layoutRevision??0)+1}};}
        return response({theme:input.theme,layoutName:f.state.config.layoutName,previousLayoutRevision,layoutRevision:f.state.config.layoutRevision});
      }
      if(path==='/api/configuration/themes'){
        const input=JSON.parse(options.body);
        if(input.revision!==f.state.config.revision)return {ok:false,status:409,json:async()=>({error:{code:'CONFIG_CONFLICT',message:'Configuration changed. Reconnect and review the latest version.'}})};
        const next=withCustomThemes(f.state.config,input.customThemes);if(JSON.stringify({...next,revision:0})!==JSON.stringify({...f.state.config,revision:0}))next.revision=input.revision+1;
        f.state={...f.state,config:next};return response({config:next});
      }
      if(path==='/api/configuration/preview')return response({...importPreview(JSON.parse(options.body),[{id:'test.app',name:'Fake app'}],()=>{},f.state.config.layoutName),stamp:f.stamp(),revision:f.state.config.revision,layoutRevision:f.state.config.layoutRevision,layoutName:f.state.config.layoutName,instanceId:f.state.instanceId});
      // T115: the Mac Dock setting of the layout, the running apps, and a Dock activation (recorded, accepted).
      if(path==='/api/device-dock')return response({dock:!!f.dock,layoutName:f.state.config.layoutName,options:{...f.dockOptions}});
      if(path==='/api/device-dock/save'){
        const input=JSON.parse(options.body),previousLayoutRevision=f.state.config.layoutRevision;
        if(input.layoutName!==f.state.config.layoutName)return {ok:false,status:409,json:async()=>({error:{code:'CONFIG_CONFLICT',message:'The device layout changed.'}})};
        if(!!f.dock!==input.dock){f.dock=input.dock;f.state={...f.state,config:{...f.state.config,layoutRevision:(f.state.config.layoutRevision??0)+1}};}
        return response({dock:!!f.dock,layoutName:f.state.config.layoutName,previousLayoutRevision,layoutRevision:f.state.config.layoutRevision});
      }
      // T117: the Dock options of the layout (a held or faulty save can be simulated with f.heldDockOptions / f.dockOptionsFault).
      if(path==='/api/device-dock/options'){
        const input=JSON.parse(options.body),previousLayoutRevision=f.state.config.layoutRevision;
        if(f.heldDockOptions)await f.heldDockOptions.promise;
        if(f.dockOptionsFault)return {ok:false,status:f.dockOptionsFault.status,json:async()=>({error:f.dockOptionsFault})};
        if(input.layoutName!==f.state.config.layoutName)return {ok:false,status:409,json:async()=>({error:{code:'CONFIG_CONFLICT',message:'The device layout changed.'}})};
        const next={...f.dockOptions,...input.options};
        if(JSON.stringify(next)!==JSON.stringify(f.dockOptions)){f.dockOptions=next;f.state={...f.state,config:{...f.state.config,layoutRevision:(f.state.config.layoutRevision??0)+1}};}
        return response({options:{...f.dockOptions},layoutName:f.state.config.layoutName,previousLayoutRevision,layoutRevision:f.state.config.layoutRevision});
      }
      if(path==='/api/running-apps')return response(f.running??{status:'ready',apps:[]});
      if(path==='/api/dock/activate'){const input=JSON.parse(options.body);f.activations.push(input);return {ok:true,status:202,json:async()=>({execution:f.execution('accepted',{requestId:input.requestId})})};}
      if(path==='/api/apps/recent')return response(f.heldRecent?await f.heldRecent.promise:f.recent??{status:'observing',appIds:[]});
      if(path==='/api/apps')return response({apps});
      if(path==='/api/app-icons')return iconReply?await iconReply(JSON.parse(options.body)):new Response('',{status:404});
      if(path.startsWith('/api/icon-library'))return await f.library(path,JSON.parse(options.body));
      if(path==='/api/windows')return response(f.heldWindows?await f.heldWindows.promise:{windows:[{title:'Win11X99',minimized:false},{title:'Win10J01',minimized:true}]});
      if(path==='/api/configuration/save'||path==='/api/configuration/import'){
        const input=JSON.parse(options.body);
        if(f.heldSave) return await f.heldSave.promise;
        if(f.saveFault) return {ok:false,status:f.saveFault.status,json:async()=>({error:f.saveFault})};
        const conflict=()=>({ok:false,status:409,json:async()=>({error:{code:'CONFIG_CONFLICT',message:'Configuration changed.'}})});
        const config=f.state.config;
        if(path==='/api/configuration/import'){
          // Whole-document replacement also checks the reviewed document's stamp.
          if(input.stamp!==f.stamp()||input.config.library.revision!==config.revision) return conflict();
          const document=input.config,name=document.layouts.some(layout=>layout.name===config.layoutName)?config.layoutName:document.defaultLayout,next=parseConfigDocument(document);
          next.library.revision=config.revision+1;next.layouts.find(layout=>layout.name===name).revision=(config.layoutRevision??0)+1;
          f.imported=next;f.state={...f.state,config:compat(viewFor(next,name))};
          return response({config:f.state.config});
        }
        // T94: { libraryRevision, layoutName, layoutRevision, library?, layout? }: a part present is checked against its own revision and each part that changes goes up by one.
        if((input.library&&input.libraryRevision!==config.revision)||(input.layout&&input.layoutRevision!==(config.layoutRevision??0))) return conflict();
        const doc=v2ToV3(config,{layoutName:config.layoutName});doc.library.revision=config.revision;doc.layouts[0].revision=config.layoutRevision??0;
        const split={...(input.library?{library:parseLibraryContent(input.library)}:{}),...(input.layout?{layout:parseLayoutContent(input.layout)}:{})};
        const next=applySplit(doc,config.layoutName,split);
        if(split.library&&JSON.stringify(next.library)!==JSON.stringify(doc.library))next.library.revision=config.revision+1;
        if(split.layout&&JSON.stringify(next.layouts[0])!==JSON.stringify(doc.layouts[0]))next.layouts[0].revision=(config.layoutRevision??0)+1;
        f.state={...f.state,config:compat(viewFor(next,config.layoutName))};
        return response({config:f.state.config});
      }
      if(path==='/api/confirmation'){if(f.heldConfirmation)return response(await f.heldConfirmation.promise);return response({id:randomUUID(),expiresInMs:30000,label:'Owned risky action',summary:'Run once on the Mac.'});}
      if(path==='/api/execute')return response(await f.execute.promise);
      if(path==='/api/result'){
        if(f.resultFault)return {ok:false,status:404,json:async()=>({error:{code:'RESULT_UNKNOWN',message:'Host restarted; result unavailable. Nothing was resent.'}})};
        return response(f.heldResult?await f.heldResult.promise:{execution:f.execution('succeeded')});
      }
      throw new Error(`Unexpected client request: ${path}`);
    },
  };
  for(const [key,value] of Object.entries(globals)){originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  t.after(()=>{for(const [key,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  // Queries instantiate the actual ES module afresh for each isolated scenario.
  await import(`../../dist/apps/web/app.js?scenario=${++scenario}`);
  try{await f.until(()=>f.sockets.length===1&&f.sockets[0].readyState===1);}catch(e){console.log("CALLS",f.calls.map(c=>c.path),"pair:",el("pair-message").textContent,"result:",el("result-title").textContent);throw e;}
  return f;
}
