import test from 'node:test';
import assert from 'node:assert/strict';
import {createInstallExperience} from '../dist/apps/web/install.js';

function fixture(t,{standalone=false,ios=false,secure=true,protocol='https:'}={}){
  const listeners=new Map(),elements=new Map(),originals=new Map();
  class Element{
    hidden=false;disabled=false;listeners=new Map();textContent='';
    addEventListener(type,fn){this.listeners.set(type,fn);}
    fire(type){return this.listeners.get(type)?.();}
    focus(){this.focused=true;}
    scrollIntoView(){}
    getClientRects(){return this.hidden?[]:[{}];}
  }
  const el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  el('install-panel').hidden=true;
  const display={matches:standalone,addEventListener(type,fn){this.changed=fn;}};
  for(const [key,value]of Object.entries({
    document:{getElementById:el},navigator:{standalone:ios},location:{protocol},
    window:{isSecureContext:secure,matchMedia:()=>display,addEventListener:(type,fn)=>listeners.set(type,fn)},
  })){
    originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  t.after(()=>{for(const [key,descriptor]of originals)descriptor?Object.defineProperty(globalThis,key,descriptor):delete globalThis[key];});
  createInstallExperience();
  return {el,display,fire:(type,event={})=>listeners.get(type)?.(event),offer(choice='dismissed',prompt=async()=>{}){
    const event={preventDefault(){this.prevented=true;},prompt,userChoice:Promise.resolve({outcome:choice})};
    listeners.get('beforeinstallprompt')(event);return event;
  }};
}

test('installation is user initiated; cancellation consumes the prompt without reloading or executing',async t=>{
  const f=fixture(t);let prompts=0;
  assert.equal(f.el('install-panel').hidden,true);assert.equal(f.el('install-confirm').hidden,true);
  f.el('pair-install-open').fire('click');assert.equal(f.el('install-panel').hidden,false);
  const event=f.offer('dismissed',async()=>{prompts++;});assert.equal(event.prevented,true);assert.equal(prompts,0);
  const request=f.el('install-confirm').fire('click');assert.equal(prompts,1);assert.equal(f.el('install-confirm').disabled,true);
  await f.el('install-confirm').fire('click');assert.equal(prompts,1);
  await request;assert.equal(f.el('install-confirm').hidden,true);assert.match(f.el('install-status').textContent,/cancelled/);
  await f.el('install-confirm').fire('click');assert.equal(prompts,1);
  f.el('install-close').fire('click');assert.equal(f.el('install-panel').hidden,true);
});
test('accepted installation is distinguished from appinstalled and suppresses later offers',async t=>{
  const f=fixture(t);let prompts=0;
  f.offer('accepted',async()=>{prompts++;});await f.el('install-confirm').fire('click');
  assert.match(f.el('install-status').textContent,/requested/);assert.equal(prompts,1);
  f.fire('appinstalled');assert.equal(f.el('install-open').hidden,true);assert.match(f.el('install-status').textContent,/was installed/);
  f.offer('accepted',async()=>{prompts++;});await f.el('install-confirm').fire('click');assert.equal(prompts,1);
});
test('a failed prompt recovers to manual browser instructions and permits a fresh browser offer',async t=>{
  const f=fixture(t);let prompts=0;
  f.offer('dismissed',()=>{throw Error('Browser rejected installation');});await f.el('install-confirm').fire('click');
  assert.equal(f.el('install-confirm').disabled,false);assert.equal(f.el('install-confirm').hidden,true);assert.match(f.el('install-status').textContent,/could not start/);
  f.offer('accepted',async()=>{prompts++;});await f.el('install-confirm').fire('click');assert.equal(prompts,1);
});
test('standalone windows hide installation prompts and update when display mode changes',t=>{
  const f=fixture(t,{standalone:true});assert.equal(f.el('install-open').hidden,true);assert.equal(f.el('pair-install-open').hidden,true);
  const event=f.offer();assert.equal(event.prevented,undefined);assert.equal(f.el('install-confirm').hidden,true);
  f.display.matches=false;f.display.changed();assert.equal(f.el('install-open').hidden,false);
  f.display.matches=true;f.display.changed();assert.match(f.el('install-status').textContent,/app window/);
});
test('iOS home-screen mode is recognized without Chromium installation events',t=>{
  const f=fixture(t,{ios:true});assert.equal(f.el('install-open').hidden,true);assert.match(f.el('install-status').textContent,/app window/);
});
test('file pages and untrusted contexts cannot offer installation',t=>{
  const f=fixture(t,{protocol:'file:',secure:false});let prompts=0;
  const event=f.offer('accepted',async()=>{prompts++;});assert.equal(event.prevented,undefined);
  f.el('install-confirm').fire('click');assert.equal(prompts,0);assert.match(f.el('install-status').textContent,/trusted HTTPS/);
});
