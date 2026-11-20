import test from 'node:test';
import assert from 'node:assert/strict';
import {initialView} from '../dist/packages/contracts/index.js';
import {draggedPagesSize} from '../dist/apps/web/page-view.js';
import {client} from './helpers/client-harness.mjs';
import {responsiveBoxes,treeFind} from './helpers/responsive-boxes.mjs';
const fixed=({w,h})=>({w:{mode:'fixed',u:w},h:{mode:'fixed',u:h}});
const config=(dimensions={w:480,h:360})=>{const c=initialView();const p=c.widgets[0];if(dimensions)p.size=fixed(dimensions);else delete p.size;p.pages[0].widgets=[{id:'inside',kind:'key',size:'S',label:'Inside',icon:'app',action:null}];return c;};
const event=(values={})=>({pointerId:7,isPrimary:true,button:0,clientX:0,clientY:0,preventDefault(){this.defaultPrevented=true;},stopPropagation(){},...values});
const outer=f=>treeFind(f.el('button-grid'),n=>n.className==='pages-widget');
const handle=(f,axis='xy')=>treeFind(outer(f),n=>n.className==='pages-resize-handle'&&n.dataset.axis===axis);
async function edit(t,c=config()){const f=await client(t,{configuration:c,viewport:{width:1368,height:912}});f.el('edit-layout').emit('click');await f.drain();responsiveBoxes(f);return f;}
function begin(f,axis='xy'){responsiveBoxes(f);const node=outer(f),h=handle(f,axis),b=node.getBoundingClientRect(),start={x:b.left+b.width/2,y:b.top+b.height/2};h.emit('pointerdown',event({clientX:start.x,clientY:start.y,target:h}));return{h,node,start,scale:b.width/(cSize(f)?.w??480)};}
// The current fields are loaded by selecting Pages, never by reaching into the editor closure.
function cSize(f){const w=Number(f.el('pages-width').value),h=Number(f.el('pages-height').value);return w&&h?{w,h}:undefined;}
async function card(f){const node=outer(f),label=treeFind(node,n=>n.className==='pages-owner-label');node.emit('click',{target:label,detail:0});await f.drain();return{w:Number(f.el('pages-width').value),h:Number(f.el('pages-height').value)};}
async function close(f){f.el('editor-close').emit('click');await f.drain();}
async function move(f,g,dx,dy){f.documentEvents.get('pointermove')(event({altKey:true,clientX:g.start.x+dx,clientY:g.start.y+dy,target:g.h}));await f.drain();}
async function end(f,g,dx=0,dy=0){f.documentEvents.get('pointerup')(event({altKey:true,clientX:g.start.x+dx,clientY:g.start.y+dy,target:g.h}));await f.drain();}

test('T75 pointer sizing freezes scale, rounds to 1u and clamps axes independently',()=>{
 assert.deepEqual(draggedPagesSize({w:480,h:360},60.6,-30.3,1.2,'xy'),{w:531,h:335});
 assert.deepEqual(draggedPagesSize({w:480,h:360},1e6,-1e6,1,'x'),{w:3840,h:360});
 assert.deepEqual(draggedPagesSize({w:480,h:360},1e6,-1e6,1,'y'),{w:480,h:1});
 assert.throws(()=>draggedPagesSize({w:480,h:360},0,0,0,'xy'));assert.throws(()=>draggedPagesSize({w:480,h:360},NaN,0,1,'xy'));
});
test('T75 continuous pointer preview keeps nodes and scroll, blocks save, and is one Undo',async t=>{
 const f=await edit(t);await card(f);await close(f);const g=begin(f),body=treeFind(g.node,n=>n.className==='pages-body');body.scrollTop=42;
 await move(f,g,24*g.scale,12*g.scale);await move(f,g,60*g.scale,30*g.scale);assert.equal(handle(f),g.h);assert.equal(outer(f),g.node);assert.equal(body.scrollTop,42);assert.equal(f.el('desk-save').disabled,true);assert.equal(f.el('edit-undo').disabled,true);
 f.el('desk-save').emit('click');f.el('edit-back').emit('click');f.windowEvents.get('keydown')(event({key:'s',ctrlKey:true}));await f.drain();assert.equal(f.count('configuration/save'),0);assert.equal(f.el('desk').dataset.editing,'true');
 await end(f,g,60*g.scale,30*g.scale);assert.deepEqual(await card(f),{w:540,h:390});assert.ok(f.button('inside'));f.el('edit-undo').emit('click');await f.drain();assert.deepEqual(await card(f),{w:480,h:360});assert.equal(f.el('save-message').dataset.dirty,'false');assert.equal(f.el('edit-undo').disabled,true);
});
test('T75 cancelled drag restores previous edits and Undo history without a resize step',async t=>{
 const f=await edit(t);await card(f);f.el('pages-width').value='501';f.el('pages-width').emit('input');await f.drain();await close(f);const g=begin(f);await move(f,g,50*g.scale,25*g.scale);const esc=event({key:'Escape'});f.documentEvents.get('keydown')(esc);await f.drain();assert.equal(esc.defaultPrevented,true);assert.deepEqual(await card(f),{w:501,h:360});assert.equal(f.el('save-message').dataset.dirty,'true');f.el('edit-undo').emit('click');await f.drain();assert.deepEqual(await card(f),{w:480,h:360});assert.equal(f.el('save-message').dataset.dirty,'false');
});
test('T75 the gesture retains its peak canvas extent until release so native scroll clamping cannot amplify shrinking',async t=>{
 const f=await edit(t,config({w:1500,h:1500}));await card(f);await close(f);const g=begin(f),initial={w:parseFloat(f.el('button-grid').style.width),h:parseFloat(f.el('button-grid').style.height)};await move(f,g,-300*g.scale,-300*g.scale);assert.equal(parseFloat(f.el('button-grid').style.width),initial.w);assert.equal(parseFloat(f.el('button-grid').style.height),initial.h);await move(f,g,300*g.scale,300*g.scale);const peak={w:parseFloat(f.el('button-grid').style.width),h:parseFloat(f.el('button-grid').style.height)};assert.ok(peak.h>initial.h);await move(f,g,-200*g.scale,-200*g.scale);assert.equal(parseFloat(f.el('button-grid').style.width),peak.w);assert.equal(parseFloat(f.el('button-grid').style.height),peak.h);await end(f,g,-200*g.scale,-200*g.scale);assert.ok(parseFloat(f.el('button-grid').style.height)<peak.h);f.el('edit-undo').emit('click');await f.drain();assert.deepEqual(await card(f),{w:1500,h:1500});assert.equal(f.el('save-message').dataset.dirty,'false');
});
test('T75 Fill stays Fill on a click or cancellation, then drag creates valid custom dimensions and saves content',async t=>{
 const f=await edit(t,config(null));let g=begin(f);await end(f,g);await card(f);assert.equal(f.el('pages-width-fill').getAttribute('aria-pressed'),'true');await close(f);
 g=begin(f);await move(f,g,-80,-40);f.documentEvents.get('pointercancel')(event());await f.drain();await card(f);assert.equal(f.el('pages-width-fill').getAttribute('aria-pressed'),'true');await close(f);
 g=begin(f);await move(f,g,-80,-40);await end(f,g,-80,-40);const size=await card(f);assert.equal(f.el('pages-width-fixed').getAttribute('aria-pressed'),'true');assert.ok(Number.isInteger(size.w)&&size.w>=1&&size.w<=3840);assert.ok(Number.isInteger(size.h)&&size.h>=1&&size.h<=3840);f.el('desk-save').emit('click');await f.drain();await f.drain();const saved=f.calls.findLast(c=>c.path==='/api/configuration/save').data;assert.deepEqual(saved.widgets[0].size,fixed(size));assert.equal(saved.widgets[0].pages[0].widgets[0].id,'inside');
});
test('T75 keyboard resize supports 1u and Shift 10u, with separate Undo steps',async t=>{
 const f=await edit(t);await card(f);await close(f);handle(f).emit('keydown',event({key:'ArrowRight'}));await f.drain();responsiveBoxes(f);handle(f).emit('keydown',event({key:'ArrowDown',shiftKey:true}));await f.drain();assert.deepEqual(await card(f),{w:481,h:370});f.el('edit-undo').emit('click');await f.drain();assert.deepEqual(await card(f),{w:481,h:360});f.el('edit-undo').emit('click');await f.drain();assert.deepEqual(await card(f),{w:480,h:360});
});
test('T75 browser interruption restores the draft for capture loss, second pointer, blur and frame resize',async t=>{
 for(const cause of ['capture','second','blur','frame'])await t.test(cause,async t=>{
  const f=await edit(t);await card(f);await close(f);const g=begin(f);await move(f,g,50*g.scale,20*g.scale);
  if(cause==='capture')g.h.emit('lostpointercapture');
  if(cause==='second')f.documentEvents.get('pointerdown')(event({pointerId:8,isPrimary:false}));
  if(cause==='blur')f.windowEvents.get('blur')();
  if(cause==='frame'){f.el('grid-frame').rect.width-=100;f.windowEvents.get('resize')();}
  await f.drain();assert.deepEqual(await card(f),{w:480,h:360});assert.equal(f.el('save-message').dataset.dirty,'false');assert.equal(f.el('edit-undo').disabled,true);assert.equal(f.count('configuration/save'),0);
 });
});
test('T75 a resized draft survives a 409 conflict and never overwrites the newer layout',async t=>{
 const f=await edit(t);await card(f);await close(f);const g=begin(f,'x');await move(f,g,40*g.scale,80*g.scale);await end(f,g,40*g.scale,80*g.scale);f.saveFault={code:'CONFIG_CONFLICT',status:409,message:'Changed'};f.el('desk-save').emit('click');await f.drain();await f.drain();assert.deepEqual(f.calls.findLast(c=>c.path==='/api/configuration/save').data.widgets[0].size,fixed({w:520,h:360}));assert.equal(f.el('save-message').dataset.dirty,'true');assert.equal(f.el('desk-save').disabled,true);assert.equal(f.count('configuration/save'),1);
});
test('T75 resize preserves unrelated unfinished form edits instead of parsing the whole draft mid-gesture',async t=>{
 const f=await edit(t);f.button('inside').emit('click');await f.drain();f.el('button-name').value='';f.el('button-name').emit('input');await f.drain();await close(f);const g=begin(f);await move(f,g,20*g.scale,10*g.scale);await end(f,g,20*g.scale,10*g.scale);assert.deepEqual(await card(f),{w:500,h:370});f.el('desk-save').emit('click');await f.drain();assert.equal(f.count('configuration/save'),0);assert.match(f.el('field-error').textContent,/Button name/);f.el('edit-undo').emit('click');await f.drain();assert.deepEqual(await card(f),{w:480,h:360});f.el('edit-undo').emit('click');await f.drain();assert.equal(f.el('save-message').dataset.dirty,'false');
});
