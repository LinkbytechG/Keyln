import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFullScreen,FULLSCREEN_KEY,loadFullScreen,saveFullScreen} from '../dist/apps/web/full-screen.js';
import {settingsWidget} from '../dist/apps/web/widgets/settings.js';
import {installDom} from './helpers/widget-dom.mjs';

// T119 (ADR-103): the per-device "Full screen" setting. A fake document stands in for the Fullscreen API and the three controls.
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fake({supported=true,enabled=true,reject=false,stored,throwing=false}={}){
  const listeners=new Map(),log={requests:[],exits:0,relayouts:0},buttons={};
  for(const id of ['fullscreen-off','fullscreen-on','fullscreen-note']){const l=new Map();buttons[id]={id,disabled:false,textContent:'',attrs:new Map(),listeners:l,
    setAttribute(n,v){this.attrs.set(n,String(v));},getAttribute(n){return this.attrs.get(n)??null;},addEventListener(type,fn){l.set(type,fn);},click(){l.get('click')?.({});}};}
  const doc={fullscreenElement:null,fullscreenEnabled:enabled,
    documentElement:supported?{async requestFullscreen(opts){log.requests.push(opts);if(reject)throw new Error('refused');doc.fullscreenElement=doc.documentElement;doc.fire('fullscreenchange');}}:{},
    async exitFullscreen(){log.exits++;doc.fullscreenElement=null;doc.fire('fullscreenchange');},
    getElementById:id=>buttons[id]??null,
    addEventListener(type,fn,capture){const list=listeners.get(type)??[];list.push({fn,capture});listeners.set(type,list);},
    removeEventListener(type,fn){listeners.set(type,(listeners.get(type)??[]).filter(item=>item.fn!==fn));},
    fire(type,event={}){const e={type,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...event};for(const {fn} of [...(listeners.get(type)??[])])fn(e);return e;},
    count:type=>(listeners.get(type)??[]).length,captured:type=>(listeners.get(type)??[]).every(item=>item.capture===true)};
  const store=new Map(stored?[[FULLSCREEN_KEY,stored]]:[]);
  const storage=throwing?{getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}}:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v))};
  const fs=createFullScreen({doc,storage,relayout:()=>{log.relayouts++;}});
  return {doc,log,buttons,store,fs,off:buttons['fullscreen-off'],on:buttons['fullscreen-on'],note:buttons['fullscreen-note']};
}

test('T119 choosing On requests full screen at once (navigationUI hide), saves On, lays the page out again; Off leaves it',async()=>{
  const x=fake();assert.equal(x.on.getAttribute('aria-pressed'),'false');assert.equal(x.off.getAttribute('aria-pressed'),'true');assert.match(x.note.textContent,/normal window/);
  x.on.click();await tick();
  assert.deepEqual(x.log.requests,[{navigationUI:'hide'}]);assert.equal(x.store.get(FULLSCREEN_KEY),'on');assert.equal(x.on.getAttribute('aria-pressed'),'true');assert.ok(x.log.relayouts>=1,'fullscreenchange re-runs the layout');assert.match(x.note.textContent,/In full screen/);
  x.off.click();await tick();assert.equal(x.log.exits,1);assert.equal(x.store.get(FULLSCREEN_KEY),'off');assert.equal(x.off.getAttribute('aria-pressed'),'true');assert.equal(x.doc.fullscreenElement,null);assert.match(x.note.textContent,/normal window/);
  // Off while not in full screen exits nothing.
  x.off.click();await tick();assert.equal(x.log.exits,1);
});

test('T119 after a load with On stored, the first pointerup requests once; a second one does not; the gesture is not prevented; capture phase',async()=>{
  const x=fake({stored:'on'});assert.equal(x.fs.on,true);assert.equal(x.on.getAttribute('aria-pressed'),'true');assert.match(x.note.textContent,/next touch/);
  assert.equal(x.log.requests.length,0,'nothing without a gesture');assert.ok(x.doc.captured('pointerup')&&x.doc.captured('keydown'));assert.equal(x.doc.count('pointerup'),1);
  const event=x.doc.fire('pointerup');await tick();
  assert.equal(x.log.requests.length,1);assert.equal(event.defaultPrevented,false,'the touch itself goes on');assert.equal(x.doc.count('pointerup'),0);assert.equal(x.doc.count('keydown'),0);
  x.doc.fire('pointerup');x.doc.fire('keydown',{key:'a'});await tick();assert.equal(x.log.requests.length,1,'once per page load');
});

test('T119 after the user leaves full screen later gestures do not re-request; On again does',async()=>{
  const x=fake({stored:'on'});x.doc.fire('pointerup');await tick();assert.equal(x.log.requests.length,1);
  x.doc.fullscreenElement=null;x.doc.fire('fullscreenchange');await tick();assert.match(x.note.textContent,/left full screen/);
  x.doc.fire('pointerup');x.doc.fire('keydown',{key:'Enter'});await tick();assert.equal(x.log.requests.length,1);
  x.on.click();await tick();assert.equal(x.log.requests.length,2,'choosing On again asks again');assert.equal(x.doc.fullscreenElement!==null,true);
});

test('T119 a key press also works as the gesture and is not prevented; a bare modifier or Escape does not use up the try',async()=>{
  const x=fake({stored:'on'});
  x.doc.fire('keydown',{key:'Shift'});x.doc.fire('keydown',{key:'Escape'});await tick();assert.equal(x.log.requests.length,0);assert.equal(x.doc.count('keydown'),1);
  const event=x.doc.fire('keydown',{key:'a'});await tick();assert.equal(x.log.requests.length,1);assert.equal(event.defaultPrevented,false);
});

test('T119 Off stored: no listeners, no request; choosing Off removes a waiting gesture',async()=>{
  const x=fake({stored:'off'});assert.equal(x.doc.count('pointerup'),0);x.doc.fire('pointerup');await tick();assert.equal(x.log.requests.length,0);
  const y=fake({stored:'on'});assert.equal(y.doc.count('pointerup'),1);y.off.click();assert.equal(y.doc.count('pointerup'),0);y.doc.fire('pointerup');await tick();assert.equal(y.log.requests.length,0);assert.equal(y.store.get(FULLSCREEN_KEY),'off');
});

test('T119 an unsupported browser disables the choices and says so',async()=>{
  for(const x of [fake({supported:false,stored:'on'}),fake({enabled:false,stored:'on'})]){
    assert.equal(x.on.disabled,true);assert.equal(x.off.disabled,true);assert.match(x.note.textContent,/not available in this browser/);assert.equal(x.doc.count('pointerup'),0);
    x.on.click();await tick();assert.equal(x.log.requests.length,0);assert.equal(x.on.getAttribute('aria-pressed'),'false');}
});

test('T119 a rejected request shows a note and keeps the setting; the next On tries again',async()=>{
  const x=fake({reject:true});x.on.click();await tick();
  assert.match(x.note.textContent,/refused full screen\. Tap On again/);assert.equal(x.store.get(FULLSCREEN_KEY),'on');assert.equal(x.on.getAttribute('aria-pressed'),'true');
  x.on.click();await tick();assert.equal(x.log.requests.length,2);
  const y=fake({reject:true,stored:'on'});y.doc.fire('pointerup');await tick();assert.match(y.note.textContent,/refused/);assert.equal(y.fs.on,true);
});

test('T119 storage that throws is tolerated: the setting reads Off and choosing still works for this load',async()=>{
  assert.equal(loadFullScreen({getItem(){throw new Error('x');}}),false);assert.equal(saveFullScreen({setItem(){throw new Error('x');}},true),false);assert.equal(loadFullScreen(undefined),false);assert.equal(saveFullScreen(undefined,true),false);
  const x=fake({throwing:true});assert.equal(x.fs.on,false);x.on.click();await tick();assert.equal(x.log.requests.length,1);assert.equal(x.on.getAttribute('aria-pressed'),'true');
});

test('T119 the gear menu has a Full screen section after Moving keys with the scope chip and two choices; the manifest is untouched',t=>{
  const dom=installDom(t);dom.document.addEventListener=()=>{};dom.document.removeEventListener=()=>{};const widget=settingsWidget.create({}),html=widget.element;
  const text=node=>node.textContent;const all=(node,out=[])=>{out.push(node);for(const c of node.children??[])all(c,out);return out;};
  const titles=all(html).filter(n=>n.tagName==='strong').map(text);assert.ok(titles.indexOf('Full screen')>titles.indexOf('Moving keys'));assert.ok(titles.indexOf('Full screen')<titles.indexOf('Mac Dock'));
  const section=all(html).find(n=>n.tagName==='section'&&n.getAttribute?.('aria-labelledby')==='fullscreen-title');assert.ok(section);assert.ok(all(section).some(n=>text(n)==='This screen only'&&n.className==='theme-scope'));
  const ids=all(section).filter(n=>n.tagName==='button').map(n=>[n.id,n.className,n.getAttribute('aria-pressed')]);assert.deepEqual(ids,[['fullscreen-off','move-choice','true'],['fullscreen-on','move-choice','false']]);
  assert.ok(all(section).some(n=>n.id==='fullscreen-note')&&all(section).some(n=>n.getAttribute?.('role')==='group'));
  assert.doesNotMatch(readFileSync(new URL('../apps/web/manifest.webmanifest',import.meta.url),'utf8'),/"display":\s*"fullscreen"/,'the manifest keeps its display mode');
  widget.destroy();
});
