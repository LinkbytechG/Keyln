import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// T41: styled menus for the selects of Edit. The enhancer (dist/apps/web/select-menu.js) runs against a small fake DOM written for this file:
// a select with options, optgroups, value/selectedIndex/disabled, labels, events that bubble, and a dialog. Nothing here is browser rendering,
// the Popover API of a real browser, or touch evidence: see Docs/verification/T41.md.
let scenario=0;
function world({popover=false,narrow=false,top=100,geometry=false}={}){
  class Node{
    constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.attributes=new Map();this.dataset={};this.listeners=new Map();this.style={};this.className='';this.id='';this.textContent='';this.disabled=false;this.tabIndex=0;}
    get parentElement(){return this.parentNode;}
    append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
    after(...nodes){const parent=this.parentNode;let at=parent.children.indexOf(this);for(const node of nodes){node.remove();node.parentNode=parent;parent.children.splice(++at,0,node);}}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(item=>item!==this);this.parentNode=null;}
    replaceChildren(...nodes){for(const node of this.children)node.parentNode=null;this.children=[];this.append(...nodes);}
    setAttribute(name,value){this.attributes.set(name,String(value));}
    getAttribute(name){return this.attributes.get(name)??null;}
    removeAttribute(name){this.attributes.delete(name);}
    addEventListener(type,listener){const list=this.listeners.get(type)||[];list.push(listener);this.listeners.set(type,list);}
    removeEventListener(type,listener){this.listeners.set(type,(this.listeners.get(type)||[]).filter(item=>item!==listener));}
    dispatchEvent(event){if(!event.target)Object.defineProperty(event,'target',{value:this,configurable:true});for(let node=this;node;node=event.bubbles?node.parentNode:null){for(const listener of node.listeners.get(event.type)||[])listener(event);if(event.stopped)break;}return !event.defaultPrevented;}
    closest(selector){for(let node=this;node;node=node.parentNode)if(selector.startsWith('.')?node.className.split(' ').includes(selector.slice(1)):node.tagName.toLowerCase()===selector)return node;return null;}
    focus(){document.activeElement=this;}
    scrollIntoView(){this.scrolled=true;}
    getBoundingClientRect(){return {left:20,top,right:220,bottom:top+44,width:200,height:44};}
    get scrollHeight(){return 400;}
    get offsetTop(){return geometry&&/select-option/.test(this.className)?Number(this.dataset.index)*44:undefined;}
    get offsetHeight(){return geometry&&/select-option/.test(this.className)?44:undefined;}
    get clientHeight(){return geometry&&/select-menu/.test(this.className)?320:0;}
    scrollTop=0;
    get isConnected(){let node=this;while(node.parentNode)node=node.parentNode;return node===body;}
  }
  class Option extends Node{constructor(text,value){super('option');this.text=text;this.value=value;}}
  class Select extends Node{
    constructor(){super('select');this._index=0;this.labels=[];}
    replaceChildren(...nodes){super.replaceChildren(...nodes);this._index=0;}
    get options(){return this.children.flatMap(child=>child.tagName==='OPTGROUP'?child.children:[child]);}
    get selectedIndex(){return this.options.length?this._index:-1;}
    set selectedIndex(value){this._index=value;}
    get value(){return this.options[this.selectedIndex]?.value??'';}
    set value(value){this._index=this.options.findIndex(option=>option.value===value);}
  }
  const body=new Node('body');
  const document={body,activeElement:undefined,createElement:tag=>{
    const node=tag==='select'?new Select():new Node(tag);
    if(popover&&tag==='div'){node.showPopover=()=>{node.popoverOpen=true;};node.hidePopover=()=>{node.popoverOpen=false;node.hidden=true;};}
    return node;
  }};
  const windowObject={innerHeight:800,innerWidth:1000,matchMedia:()=>({matches:narrow}),addEventListener(){},removeEventListener(){}};
  const fire=(node,type,properties={})=>{const event={type,bubbles:true,defaultPrevented:false,stopped:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},...properties};node.dispatchEvent(event);return event;};
  return {Node,Option,Select,body,document,windowObject,fire};
}
async function load(t,options){
  const w=world(options),originals=new Map();
  for(const [key,value] of Object.entries({document:w.document,window:w.windowObject})){originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  t.after(()=>{for(const [key,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  const module=await import(`../dist/apps/web/select-menu.js?t41=${++scenario}`);
  return {...w,...module};
}
// A field like those of the key popup: a label for the select, both inside a dialog inside the body.
function field(w,{id='shortcut-key',captions=['Alpha','Bravo','Charlie'],inDialog=true}={}){
  const dialog=new w.Node('dialog'),label=new w.Node('label'),select=w.document.createElement('select');
  label.textContent='Key';label.htmlFor=id;select.id=id;select.labels=[label];
  select.replaceChildren(...captions.map((text,index)=>new w.Option(text,`v${index}`)));
  if(inDialog){dialog.append(label,select);w.body.append(dialog);}else w.body.append(label,select);
  return {select,label,dialog};
}
const menuOf=w=>w.body.children.concat(w.body.children.flatMap(child=>child.children)).find(node=>/select-layer/.test(node.className));
const rowsOf=layer=>layer.children[0].children.filter(node=>/select-option/.test(node.className));

test('T41 enhancing keeps the native select as the source of truth and adds a labelled button that shows the chosen option',async t=>{
  const w=await load(t),{select,label,dialog}=field(w);
  const button=w.enhanceSelect(select);
  assert.ok(button);assert.equal(dialog.children.indexOf(button),dialog.children.indexOf(select)+1,'the button follows the select');
  assert.ok(dialog.children.includes(select),'the native select stays in the document');assert.match(select.className,/select-native/);assert.equal(select.getAttribute('aria-hidden'),'true');assert.equal(select.tabIndex,-1);
  assert.equal(button.className,'select-button');assert.equal(button.type,'button');assert.equal(button.getAttribute('aria-haspopup'),'listbox');assert.equal(button.getAttribute('aria-expanded'),'false');
  assert.equal(button.getAttribute('aria-labelledby'),`${label.id} ${button.id}`,'the name is the label of the field, then the chosen text');assert.ok(label.id);
  assert.equal(button.children[0].textContent,'Alpha');assert.equal(button.children[1].getAttribute('aria-hidden'),'true');
  assert.equal(w.enhanceSelect(select),button,'enhancing twice changes nothing');
  const bare=w.document.createElement('select');assert.equal(w.enhanceSelect(bare),undefined,'a select that is not in the page is left alone');assert.doesNotMatch(bare.className,/select-native/);
  const plain=Object.assign(new w.Node('select'),{after:undefined});plain.parentNode=w.body;assert.equal(w.enhanceSelect(plain),undefined,'a minimal DOM without after() is left alone');
  const named=w.document.createElement('select');named.setAttribute('aria-label','Active page');w.body.append(named);const unlabeled=w.enhanceSelect(named);
  assert.equal(unlabeled.getAttribute('aria-label'),'Active page');
});
test('T41 the button follows value, selectedIndex, rebuilt options and disabled',async t=>{
  const w=await load(t),{select}=field(w),button=w.enhanceSelect(select),text=()=>button.children[0].textContent;
  select.value='v2';assert.equal(text(),'Charlie');select.selectedIndex=1;assert.equal(text(),'Bravo');
  select.replaceChildren(new w.Option('One','1'),new w.Option('Two','2'));assert.equal(text(),'One','options rebuilt');
  select.value='2';assert.equal(text(),'Two');select.value='nope';assert.equal(text(),'','a value no option has shows nothing');
  select.disabled=true;assert.equal(button.disabled,true);select.disabled=false;assert.equal(button.disabled,false);
  button.dispatchEvent({type:'click',bubbles:true});select.disabled=true;assert.equal(button.disabled,true);
});
test('T41 opening lists one row per option with the current one marked, disabled ones disabled, and optgroups as headings',async t=>{
  const w=await load(t,{popover:true}),{select,dialog}=field(w),button=w.enhanceSelect(select);
  const group=new w.Node('optgroup');group.label='More';const extra=new w.Option('Delta','v3');extra.disabled=true;group.append(extra);select.append(group);select.value='v1';
  button.dispatchEvent({type:'click',bubbles:true});
  const layer=menuOf(w);assert.ok(layer);assert.equal(layer.parentNode,dialog,'inside a modal dialog the menu lives in the dialog, or the page outside it is inert');
  assert.equal(layer.getAttribute('popover'),'manual');assert.equal(layer.popoverOpen,true,'in the top layer');
  const menu=layer.children[0];assert.equal(menu.getAttribute('role'),'listbox');assert.equal(button.getAttribute('aria-expanded'),'true');assert.equal(document.activeElement,menu);
  const rows=rowsOf(layer);assert.equal(rows.length,4);assert.deepEqual(rows.map(row=>row.getAttribute('aria-selected')),['false','true','false','false']);
  assert.equal(rows[1].scrolled,true,'the current option is scrolled into view');assert.equal(rows[3].getAttribute('aria-disabled'),'true');assert.equal(rows[0].getAttribute('role'),'option');
  assert.equal(menu.children.find(node=>/select-heading/.test(node.className)).textContent,'More');assert.equal(menu.getAttribute('aria-activedescendant'),rows[1].id);
  assert.equal(rows[0].children[1].textContent,'Alpha');assert.equal(rows[1].children[0].textContent,'✓');
  // Placed under the button: it is 100px from the top with room below.
  assert.equal(menu.style.top,'148px');assert.equal(menu.style.left,'20px');assert.equal(menu.style.width,'200px');assert.equal(menu.style.maxHeight,'320px');
  const plain=await load(t),second=field(plain,{id:'plain'}),again=plain.enhanceSelect(second.select);again.dispatchEvent({type:'click',bubbles:true});
  assert.equal(menuOf(plain).getAttribute('popover'),null,'without the Popover API the layer is a fixed element');
});
test('T41 on open the current option is centered in the list (K among 73 options), not left below the fold; arrows keep it in view',async t=>{
  const w=await load(t,{geometry:true}),letters=Array.from({length:73},(_,index)=>`Option ${index}`),{select}=field(w,{captions:letters}),button=w.enhanceSelect(select);
  select.selectedIndex=10;button.dispatchEvent({type:'click',bubbles:true});
  const menu=menuOf(w).children[0],rows=rowsOf(menuOf(w));
  assert.equal(menu.scrollTop,10*44-(320-44)/2,'centered: row 10 sits at offsetTop 440, the list is 320 tall');assert.ok(menu.scrollTop>0,'not left at the top');
  assert.equal(menu.getAttribute('aria-activedescendant'),rows[10].id,'the active descendant is the current option');
  for(let n=0;n<10;n++)w.fire(menu,'keydown',{key:'ArrowDown'});
  assert.ok(rows[20].offsetTop+44<=menu.scrollTop+320&&rows[20].offsetTop>=menu.scrollTop,'moving down scrolls the active row into view');
  w.fire(menu,'keydown',{key:'End'});assert.equal(menu.scrollTop,73*44-320);
  w.fire(menu,'keydown',{key:'Home'});assert.equal(menu.scrollTop,0);
});
test('T41 the menu opens upward near the bottom of the screen and becomes a bottom sheet on a phone',async t=>{
  const near=await load(t,{top:700}),a=field(near,{inDialog:false}),buttonA=near.enhanceSelect(a.select);buttonA.dispatchEvent({type:'click',bubbles:true});
  const menuA=menuOf(near).children[0];assert.equal(menuA.style.bottom,'104px');assert.equal(menuA.style.top,'auto');assert.equal(menuOf(near).parentNode,near.body,'outside a dialog it lives in the body');
  const phone=await load(t,{narrow:true}),b=field(phone,{inDialog:false}),buttonB=phone.enhanceSelect(b.select);buttonB.dispatchEvent({type:'click',bubbles:true});
  assert.equal(menuOf(phone).dataset.sheet,'true','at 600px and below it is a sheet');assert.equal(menuOf(phone).children[0].style.top,undefined);
});
test('T41 choosing a row sets the value, fires input then change (bubbling), closes the menu and returns focus to the button',async t=>{
  const w=await load(t),{select,dialog}=field(w),button=w.enhanceSelect(select),seen=[];
  dialog.addEventListener('input',event=>seen.push(['input',event.target===select,select.value]));dialog.addEventListener('change',event=>seen.push(['change',event.target===select,select.value]));
  button.dispatchEvent({type:'click',bubbles:true});
  const layer=menuOf(w),rows=rowsOf(layer);
  w.fire(rows[2],'click');
  assert.deepEqual(seen,[['input',true,'v2'],['change',true,'v2']]);assert.equal(select.value,'v2');assert.equal(button.children[0].textContent,'Charlie');
  assert.equal(menuOf(w),undefined);assert.equal(button.getAttribute('aria-expanded'),'false');assert.equal(document.activeElement,button);
  // A disabled option cannot be chosen.
  select.append(Object.assign(new w.Option('Off','off'),{disabled:true}));button.dispatchEvent({type:'click',bubbles:true});
  w.fire(rowsOf(menuOf(w))[3],'click');assert.equal(select.value,'v2');assert.ok(menuOf(w),'the menu stays open');assert.equal(seen.length,2);
});
test('T41 keyboard: Enter, Space and the arrows open; arrows, Home and End move and skip disabled rows; Enter and Space choose',async t=>{
  const w=await load(t),{select}=field(w,{captions:['Alpha','Bravo','Charlie','Delta']}),button=w.enhanceSelect(select);
  select.options[2].disabled=true;
  const opened=w.fire(button,'keydown',{key:'ArrowDown'});assert.equal(opened.defaultPrevented,true);assert.ok(menuOf(w));
  const menu=menuOf(w).children[0],key=name=>w.fire(menu,'keydown',{key:name}),active=()=>menu.getAttribute('aria-activedescendant');
  assert.equal(active(),rowsOf(menuOf(w))[0].id);
  key('ArrowDown');assert.equal(active(),rowsOf(menuOf(w))[1].id);key('ArrowDown');assert.equal(active(),rowsOf(menuOf(w))[3].id,'the disabled row is skipped');
  key('ArrowDown');assert.equal(active(),rowsOf(menuOf(w))[3].id,'no wrap past the last');key('Home');assert.equal(active(),rowsOf(menuOf(w))[0].id);key('End');assert.equal(active(),rowsOf(menuOf(w))[3].id);
  key('ArrowUp');assert.equal(active(),rowsOf(menuOf(w))[1].id);
  key('Enter');assert.equal(select.value,'v1');assert.equal(menuOf(w),undefined);assert.equal(document.activeElement,button);
  for(const open of ['Enter',' ','ArrowUp']){w.fire(button,'keydown',{key:open});assert.ok(menuOf(w),`${JSON.stringify(open)} opens`);w.fire(menuOf(w).children[0],'keydown',{key:'Escape'});assert.equal(menuOf(w),undefined);}
  w.fire(button,'keydown',{key:'ArrowDown'});w.fire(menuOf(w).children[0],'keydown',{key:'d'});w.fire(menuOf(w).children[0],'keydown',{key:' '});assert.equal(select.value,'v3','type-ahead then Space');
  w.fire(button,'keydown',{key:'x'});assert.equal(menuOf(w),undefined,'other keys do not open it');
});
test('T41 Esc closes only the menu: the key is stopped before the dialog sees it, and a cancel from the dialog closes the menu instead of the dialog',async t=>{
  const w=await load(t),{select,dialog}=field(w),button=w.enhanceSelect(select);let dialogSaw=0,cancelled=0;
  dialog.addEventListener('keydown',()=>{dialogSaw++;});
  button.dispatchEvent({type:'click',bubbles:true});
  const esc=w.fire(menuOf(w).children[0],'keydown',{key:'Escape'});
  assert.equal(esc.defaultPrevented,true);assert.equal(esc.stopped,true);assert.equal(dialogSaw,0,'the dialog never sees the Esc');assert.equal(menuOf(w),undefined);assert.equal(document.activeElement,button);
  button.dispatchEvent({type:'click',bubbles:true});
  dialog.addEventListener('cancel',()=>{cancelled++;});
  const cancel=w.fire(dialog,'cancel');
  assert.equal(cancel.defaultPrevented,true,'the dialog is told not to close');assert.equal(menuOf(w),undefined,'the menu closed instead');
  const after=w.fire(dialog,'cancel');assert.equal(after.defaultPrevented,false,'with no menu open the dialog closes as it always did');void cancelled;
});
test('T41 a tap outside the menu closes it, a second click on the button toggles, and a disabled select does not open',async t=>{
  const w=await load(t),{select}=field(w),button=w.enhanceSelect(select);
  button.dispatchEvent({type:'click',bubbles:true});const layer=menuOf(w);w.fire(layer,'click',{target:layer});assert.equal(menuOf(w),undefined,'outside tap');assert.equal(select.value,'v0','nothing chosen');
  button.dispatchEvent({type:'click',bubbles:true});button.dispatchEvent({type:'click',bubbles:true});assert.equal(menuOf(w),undefined,'toggled shut');
  select.disabled=true;button.dispatchEvent({type:'click',bubbles:true});assert.equal(menuOf(w),undefined);
});
test('T41 rebuilding the options while the menu is open redraws it; the label focuses the visible button',async t=>{
  const w=await load(t),{select}=field(w),button=w.enhanceSelect(select);
  button.dispatchEvent({type:'click',bubbles:true});select.replaceChildren(new w.Option('Only','o'));
  assert.equal(rowsOf(menuOf(w)).length,1);assert.equal(rowsOf(menuOf(w))[0].children[1].textContent,'Only');
  w.fire(menuOf(w).children[0],'keydown',{key:'Escape'});
  select.dispatchEvent({type:'focus',bubbles:false});assert.equal(document.activeElement,button);
  const click=w.fire(select,'click');assert.equal(click.defaultPrevented,true,'a click that reaches the hidden select does nothing');
});
