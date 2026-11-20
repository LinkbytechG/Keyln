// T44: a small DOM for the widgets, with real tag names and attributes, so a test can both drive a widget (events, destroy) and read the
// markup it makes. The tests of earlier tasks used to read the same markup from index.html; assembledPage() rebuilds that page
// by putting every widget where index.html has its placeholder, so those source-level checks keep checking the same markup.
import {readFileSync} from 'node:fs';

export class Text {
  parentNode=undefined;
  constructor(data){this.data=String(data);}
  get textContent(){return this.data;}
}
const kebab=name=>name.replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase());
export class Element {
  parentNode=undefined;children=[];attrs=new Map();listeners=new Map();root=false;value='';
  // T115: a stand-in for the inline style (the Dock sets sizes through setProperty); it is not serialized.
  style={setProperty(name,value){this[name]=value;},removeProperty(name){delete this[name];}};
  constructor(tag){
    this.tagName=tag;
    this.dataset=new Proxy({},{
      get:(_,name)=>typeof name==='string'?this.attrs.get('data-'+kebab(name)):undefined,
      set:(_,name,value)=>{this.attrs.set('data-'+kebab(name),String(value));return true;},
      deleteProperty:(_,name)=>{this.attrs.delete('data-'+kebab(name));return true;},
      has:(_,name)=>this.attrs.has('data-'+kebab(String(name))),
    });
  }
  #text(name,value){if(value===undefined)return this.attrs.get(name)??'';this.attrs.set(name,String(value));return undefined;}
  get id(){return this.#text('id');}set id(value){this.#text('id',value);}
  get className(){return this.#text('class');}set className(value){this.#text('class',value);}
  get title(){return this.#text('title');}set title(value){this.#text('title',value);}
  get type(){return this.#text('type');}set type(value){this.#text('type',value);}
  get hidden(){return this.attrs.has('hidden');}set hidden(value){if(value)this.attrs.set('hidden','');else this.attrs.delete('hidden');}
  get disabled(){return this.attrs.has('disabled');}set disabled(value){if(value)this.attrs.set('disabled','');else this.attrs.delete('disabled');}
  get textContent(){return this.children.map(child=>child.textContent).join('');}
  set textContent(value){for(const child of this.children)child.parentNode=undefined;this.children=[];if(value!=='')this.append(new Text(value));}
  get isConnected(){return this.root||!!this.parentNode?.isConnected;}
  setAttribute(name,value){this.attrs.set(name,String(value));}
  getAttribute(name){return this.attrs.get(name)??null;}
  removeAttribute(name){this.attrs.delete(name);}
  append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node);}}
  replaceChildren(...nodes){for(const child of this.children)child.parentNode=undefined;this.children=[];this.append(...nodes);}
  replaceWith(node){const parent=this.parentNode;if(!parent)return;parent.children[parent.children.indexOf(this)]=node;node.parentNode=parent;this.parentNode=undefined;}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=undefined;}
  addEventListener(type,listener){const list=this.listeners.get(type)||[];list.push(listener);this.listeners.set(type,list);}
  removeEventListener(type,listener){this.listeners.set(type,(this.listeners.get(type)||[]).filter(item=>item!==listener));}
  listenerCount(){let n=0;for(const list of this.listeners.values())n+=list.length;return n;}
  emit(type,properties={}){const event={preventDefault(){},stopPropagation(){},...properties};for(const listener of [...(this.listeners.get(type)||[])])listener(event);}
  find(match){if(match(this))return this;for(const child of this.children){const found=child.find?.(match);if(found)return found;}return undefined;}
  all(match,out=[]){if(match(this))out.push(this);for(const child of this.children)child.all?.(match,out);return out;}
}
const escapeText=value=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
export function serialize(node){
  if(node instanceof Text)return escapeText(node.data);
  const attrs=[...node.attrs].map(([name,value])=>value===''&&(name==='hidden'||name==='disabled')?` ${name}`:` ${name}="${value.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}"`).join('');
  return `<${node.tagName}${attrs}>${node.children.map(serialize).join('')}</${node.tagName}>`;
}
// Installs a document that knows tags and ids; the returned el(id) finds a created element anywhere under a placed placeholder.
export function installDom(t){
  const placeholders=new Map(),previous=Object.getOwnPropertyDescriptor(globalThis,'document'),previousOption=Object.getOwnPropertyDescriptor(globalThis,'Option');
  const document={createElement:tag=>new Element(tag),createElementNS:tag=>new Element(tag),createTextNode:text=>new Text(text),
    getElementById:id=>{if(!placeholders.has(id)){const node=new Element('span');node.root=true;node.id=id;placeholders.set(id,node);}return placeholders.get(id);}};
  Object.defineProperty(globalThis,'document',{configurable:true,writable:true,value:document});
  Object.defineProperty(globalThis,'Option',{configurable:true,writable:true,value:class Option extends Element{constructor(text,value){super('option');this.text=text;this.value=value;this.textContent=text;this.setAttribute('value',value);}}});
  const restore=()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;if(previousOption)Object.defineProperty(globalThis,'Option',previousOption);else delete globalThis.Option;};
  if(t)t.after(restore);
  const el=id=>{for(const root of placeholders.values()){const found=root.find(node=>node.id===id&&node!==root);if(found)return found;}return placeholders.get(id)??document.getElementById(id);};
  return {document,el,placeholders,restore};
}
// T62: index.html no longer has widget placeholders (the three system components are made by the page and placed by the theme's zones), so the page's markup
// is the file itself.
export async function assembledPage(){
  return readFileSync(new URL('../../apps/web/index.html',import.meta.url),'utf8');
}
