import test from 'node:test';
import assert from 'node:assert/strict';
import {client} from './helpers/client-harness.mjs';
import {createLibrary} from '../dist/apps/web/library.js';
const cards=f=>f.el('shelf-previews').children.filter(node=>node.className?.includes('shelf-card'));
const type=(f,id)=>f.el('shelf-types').children.find(node=>node.dataset.libraryType===id).emit('click');
const tab=(f,i)=>f.el('shelf-previews').children[0].children[i].emit('click');
const clocks=f=>[...f.timers.values()].filter(timer=>timer.delay>0&&timer.delay<=60000).length;
test('T72 live clock previews survive unchanged renders and clean up on tab, category and close',async t=>{
 const f=await client(t);const shelf=createLibrary({apps:()=>[],online:()=>true,editable:()=>true,windows:async()=>[],place:()=>undefined,drag:()=>false,inspectFile:async()=>{throw Error('unused');},placeFile:()=>undefined,changed:()=>{}});shelf.toggle(true);const before=clocks(f);type(f,'widget');const first=cards(f)[0],clock=first.children[0].children[0];assert.equal(clock.className,'w-clock');assert.ok(clock.children[0].textContent);assert.equal(clocks(f),before+1);shelf.render();assert.equal(cards(f)[0],first);assert.equal(clocks(f),before+1);
 tab(f,1);assert.equal(clocks(f),before);assert.equal(cards(f)[0].children[0].children[0].className,'w-text');assert.equal(cards(f)[0].children[0].children[0].children[0].textContent,'Title');tab(f,0);assert.equal(clocks(f),before+1);type(f,'pages');assert.equal(clocks(f),before);type(f,'widget');assert.equal(clocks(f),before+1);shelf.toggle(false);assert.equal(clocks(f),before);shelf.toggle(true);assert.equal(clocks(f),before+1);shelf.reset();assert.equal(clocks(f),before);
});
for(const [index,kind,form,tier] of [[0,'clock','time','M'],[1,'text','title','M'],[2,'refresh','button','S']]) test(`T72 ${kind} preview adds the selected binding without executing`,async t=>{
 const f=await client(t);f.el('edit-layout').emit('click');f.el('shelf-toggle').emit('click');await f.drain();type(f,'widget');if(index)tab(f,index);const card=cards(f)[0];if(kind==='refresh'){const visual=card.children[0].children[0];assert.equal(visual.className,'quiet page-refresh');assert.equal(visual.id,'');assert.equal(visual.listeners.get('click')?.length??0,0);}card.emit('click');await f.drain();assert.equal(f.count('execute'),0);f.el('desk-save').emit('click');await f.drain();await f.drain();const candidate=f.calls.findLast(c=>c.path==='/api/configuration/save')?.data;const component=candidate.widgets.flatMap(item=>item.kind==='pages'?item.pages.flatMap(page=>page.widgets):[item]).find(item=>item.kind===kind);assert.ok(component);assert.deepEqual([component.kind,component.form,component.size],[kind,form,tier]);if(kind==='text')assert.equal(component.text,'Text');
});
