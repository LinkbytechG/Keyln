import test from 'node:test';
import assert from 'node:assert/strict';
import {createReconnect,RECONNECT_DELAYS} from '../dist/apps/web/reconnect.js';
async function fixture(t,connect=async()=>false){
 const saved=[globalThis.setTimeout,globalThis.clearTimeout],timers=new Map();let id=0,calls=0;const flags={online:true,visible:true};
 globalThis.setTimeout=(callback,delay)=>{timers.set(++id,{callback,delay});return id;};globalThis.clearTimeout=id=>timers.delete(id);
 t.after(()=>{[globalThis.setTimeout,globalThis.clearTimeout]=saved;});
 const controller=createReconnect({connect:async()=>{calls++;return await connect();},changed(){},online:()=>flags.online,visible:()=>flags.visible});
 return {controller,flags,timers,get calls(){return calls;},async fire(){assert.equal(timers.size,1);const [id,timer]=[...timers][0];timers.delete(id);timer.callback();await new Promise(yes=>setImmediate(yes));return timer.delay;}};
}
test('reconnect has one timer, six bounded backoff attempts and no automatic restart after exhaustion',async t=>{
 const f=await fixture(t);f.controller.failed();f.controller.failed();
 for(const delay of RECONNECT_DELAYS){assert.equal(await f.fire(),delay);f.controller.failed();}
 assert.equal(f.calls,6);assert.equal(f.timers.size,0);assert.equal(f.controller.state.phase,'exhausted');
 f.controller.manual();await new Promise(yes=>setImmediate(yes));assert.equal(f.calls,7);assert.equal(f.timers.size,1);
});
test('successful HTTP alone does not reset retries; only ready state does, and authorization stop survives wake events',async t=>{
 const f=await fixture(t,async()=>true);f.controller.failed();await f.fire();assert.equal(f.controller.state.phase,'connecting');assert.equal(f.timers.size,0);
 f.controller.failed();assert.equal(await f.fire(),2000);f.controller.recovered();assert.equal(f.controller.state.phase,'idle');assert.equal(f.controller.state.attempt,0);
 f.controller.stop();f.controller.wake();f.controller.failed();assert.equal(f.timers.size,0);assert.equal(f.calls,2);
});
test('pause cancels stale async work, suppresses hidden/offline timers and coalesces wake triggers',async t=>{
 let resolve;const f=await fixture(t,()=>new Promise(yes=>resolve=yes));f.controller.failed();await f.fire();f.flags.online=false;f.controller.pause();resolve(false);await new Promise(yes=>setImmediate(yes));assert.equal(f.timers.size,0);
 f.flags.online=true;f.flags.visible=false;f.controller.wake();assert.equal(f.timers.size,0);f.flags.visible=true;f.controller.wake();f.controller.wake();assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].delay,0);
});
