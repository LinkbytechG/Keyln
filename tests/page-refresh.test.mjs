import test from 'node:test';
import assert from 'node:assert/strict';
// T44: the Refresh button is a widget (widgets/refresh.ts); this module is driven through request() and reports disabled.
import {createPageRefresh} from '../dist/apps/web/page-refresh.js';

function fixture(t, initial={}) {
  const elements=new Map(),previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  class Element {
    disabled=false;hidden=false;open=false;listeners=new Map();
    addEventListener(event,fn){this.listeners.set(event,fn);}
    setAttribute(name,value){this[name]=value;}
    click(){this.listeners.get('click')?.();}
    showModal(){this.open=true;}
    close(){this.open=false;}
    focus(){this.focused=true;}
  }
  const el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{getElementById:el}});
  t.after(()=>previous?Object.defineProperty(globalThis,'document',previous):delete globalThis.document);
  const state={dirty:false,blocked:false,pending:false,online:true,...initial},calls=[];
  const control=createPageRefresh({state:()=>state,discardDraft:()=>{calls.push('discard');state.dirty=false;},reload:()=>calls.push('reload')});
  return {el,state,calls,render:control.render,control};
}

test('clean page reloads once, without discarding a draft',t=>{
  const f=fixture(t);f.control.request();f.control.request();f.el('refresh-confirm').click();
  assert.deepEqual(f.calls,['reload']);assert.equal(f.control.disabled,true);
});
test('unsaved layout needs explicit discard; cancel keeps the draft',t=>{
  const f=fixture(t,{dirty:true});f.control.request();
  assert.equal(f.el('refresh-dialog').open,true);assert.equal(f.el('refresh-cancel').focused,true);
  assert.equal(f.el('refresh-draft-warning').hidden,false);assert.match(f.el('refresh-confirm').textContent,/Discard/);
  f.el('refresh-cancel').click();assert.equal(f.state.dirty,true);assert.deepEqual(f.calls,[]);
  f.control.request();f.el('refresh-confirm').click();
  assert.deepEqual(f.calls,['discard','reload']);assert.equal(f.el('refresh-dialog').open,false);
});
test('pending action and offline state are explained before navigation',t=>{
  const f=fixture(t,{pending:true,online:false});f.control.request();
  assert.equal(f.el('refresh-action-warning').hidden,false);assert.equal(f.el('refresh-offline-warning').hidden,false);
  assert.equal(f.el('refresh-draft-warning').hidden,true);assert.deepEqual(f.calls,[]);
  assert.equal(f.el('refresh-dialog')['aria-describedby'],'refresh-description refresh-action-warning refresh-offline-warning');
  f.el('refresh-cancel').click();assert.equal(f.state.pending,true);
  f.state.online=true;f.control.request();assert.equal(f.el('refresh-offline-warning').hidden,true);
  f.el('refresh-confirm').click();assert.deepEqual(f.calls,['reload']);assert.equal(f.state.pending,true);
});
test('save or image upload blocks reload, including a dialog already open',t=>{
  const f=fixture(t,{dirty:true,blocked:true});f.control.request();assert.deepEqual(f.calls,[]);
  assert.equal(f.control.disabled,true);assert.equal(f.el('refresh-dialog').open,false);
  f.state.blocked=false;f.render();f.control.request();assert.equal(f.el('refresh-dialog').open,true);
  f.state.blocked=true;f.render();f.el('refresh-confirm').click();assert.deepEqual(f.calls,[]);
  f.state.blocked=false;f.render();f.el('refresh-confirm').click();assert.deepEqual(f.calls,['discard','reload']);
});
