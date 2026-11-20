import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {WorkflowEngine} from '../dist/apps/host/workflow.js';
import {Confirmations} from '../dist/apps/host/confirmations.js';
import {Scheduler} from '../dist/apps/host/scheduler.js';
import {parseConfig,parseWorkflows,parseExecution,needsConfirmation} from '../dist/packages/contracts/index.js';
import {key as keyAt,layout,components} from './helpers/layout.mjs';
const app={type:'app.open',appId:'test.owned'},key={type:'keyboard.shortcut',key:'KeyA',modifiers:['command']};
const config=(actions=[app,key,app],extra={})=>parseConfig({...layout([keyAt('primary',{type:'workflow.run',workflowId:'owned'},{},{label:'Owned workflow',icon:'play'})],{revision:1}),workflows:[{id:'owned',name:'Owned',timeoutMs:2000,steps:actions.map((action,index)=>({id:`step${index}`,action,timeoutMs:1000})),...extra}]});
const trigger=()=>({requestId:randomUUID(),componentId:'primary',revision:1});
const until=async predicate=>{for(let i=0;i<500&&!predicate();i++)await delay(5);assert.ok(predicate());};

test('workflow contracts accept empty layouts and reject nesting, loops, missing refs and unbounded execution',()=>{
 const c=config();const old={...c};delete old.workflows;old.widgets=[];assert.deepEqual(parseConfig(old),old);
 const mutations=[c=>c.workflows[0].steps[0].action={type:'workflow.run',workflowId:'owned'},c=>c.workflows[0].timeoutMs=180001,c=>c.workflows[0].steps[0].timeoutMs=60001,c=>c.workflows[0].steps=[],c=>c.workflows[0].repeat=2,c=>c.workflows[0].steps.push(c.workflows[0].steps[0]),c=>components(c)[0].action.workflowId='missing',c=>components(c)[0].requiresConfirmation='yes'];
 for(const mutate of mutations){const bad=structuredClone(c);mutate(bad);assert.throws(()=>parseConfig(bad));}
 assert.throws(()=>parseWorkflows(Array.from({length:33},(_,index)=>({...c.workflows[0],id:`w${index}`}))));
 for(const where of ['button','workflow','step']){const risky=config();if(where==='button')components(risky)[0].requiresConfirmation=true;else if(where==='workflow')risky.workflows[0].requiresConfirmation=true;else risky.workflows[0].steps[1].requiresConfirmation=true;assert.equal(needsConfirmation(risky,components(risky)[0]),true);}
});

test('three steps execute in order, publish bounded progress, and target subsequent keys to the last opened app',async()=>{
 const calls=[],progress=[],engine=new WorkflowEngine(async(action,signal,target)=>{calls.push({action,target});await delay(3);return {ok:true,message:'Owned step done'};});
 const c=config([app,key,{...app,appId:'test.other'},key]);const result=await engine.run('owned',c,new AbortController().signal,value=>{progress.push(value);});
 assert.equal(result.ok,true);assert.deepEqual(calls.map(call=>call.target),[undefined,'test.owned',undefined,'test.other']);
 assert.deepEqual(progress.map(value=>value.steps.map(step=>step.status)),[['running'],['succeeded'],['succeeded','running'],['succeeded','succeeded'],['succeeded','succeeded','running'],['succeeded','succeeded','succeeded'],['succeeded','succeeded','succeeded','running'],['succeeded','succeeded','succeeded','succeeded']]);
 assert.equal(progress[0].steps[0].status,'running','Published snapshots must not mutate later');
});

test('workflow stops on failure and unknown; output budget is shared across steps and raw HTML stays text',async()=>{
 for(const unknown of [false,true]){
  let count=0;const engine=new WorkflowEngine(async()=>++count===2?{ok:false,unknown,code:'OWNED_FAILURE',message:'Stopped'}:{ok:true,message:'First'});
  const result=await engine.run('owned',config(),new AbortController().signal);assert.equal(count,2);assert.equal(result.ok,false);assert.equal(!!result.unknown,unknown);assert.equal(result.workflow.steps.length,2);assert.equal(result.workflow.steps[1].status,unknown?'unknown':'failed');
 }
 const shell={type:'shell.run',scriptId:'owned',version:'a'.repeat(64),args:[]};
 const result=await new WorkflowEngine(async()=>({ok:true,message:'Done',output:{exitCode:0,signal:null,stdout:'<b>'.repeat(1300),stderr:'',truncated:false}})).run('owned',config([shell,shell,shell]),new AbortController().signal);
 assert.equal(result.ok,true);assert.equal(result.workflow.steps.reduce((n,step)=>n+step.output.stdout.length+step.output.stderr.length,0),4096);assert.equal(result.workflow.steps[1].output.truncated,true);assert.equal(result.workflow.steps[2].output.stdout,'');
});

test('step and whole timeouts abort once, drain the adapter, and never begin a later step',async()=>{
 for(const whole of [false,true]){
  const c=config();if(whole)c.workflows[0].timeoutMs=100;else c.workflows[0].steps[0].timeoutMs=100;
  let calls=0,aborts=0;const engine=new WorkflowEngine(async(action,signal)=>{calls++;return await new Promise(resolve=>signal.addEventListener('abort',()=>{aborts++;setTimeout(()=>resolve({ok:false,unknown:true,message:'Cleaned up'}),10);},{once:true}));});
  const result=await engine.run('owned',c,new AbortController().signal);assert.equal(calls,1);assert.equal(aborts,1);assert.equal(result.unknown,true);assert.equal(result.code,whole?'WORKFLOW_TIMEOUT':'STEP_TIMEOUT');assert.equal(result.workflow.steps[0].status,'unknown');assert.equal(result.halt,undefined);
 }
 const controller=new AbortController();let calls=0;const result=await new WorkflowEngine(async()=>{calls++;return {ok:true,message:'Must not run'};}).run('owned',config(),controller.signal,()=>controller.abort());
 assert.equal(calls,0);assert.equal(result.unknown,true);
});

test('unresponsive workflow cleanup halts the scheduler instead of allowing another action',async()=>{
 const c=config();c.workflows[0].steps[0].timeoutMs=100;let calls=0;
 const engine=new WorkflowEngine(async()=>{calls++;return await new Promise(()=>{});});
 const scheduler=new Scheduler({run:(action,signal,context)=>engine.run(action.workflowId,context.config,signal,context.progress)},Date.now,4000);
 const input=trigger();scheduler.trigger('device',input,c);await until(()=>!scheduler.busy);const result=scheduler.get('device',input.requestId);
 assert.equal(result.status,'unknown');assert.equal(calls,1);assert.throws(()=>scheduler.trigger('device',trigger(),c),error=>error.code==='HOST_STOPPING');
});

test('one workflow owns the global lock, uses its accepted snapshot, deduplicates once, and isolates device results',async()=>{
 const c=config(),calls=[];let release;const wait=new Promise(resolve=>release=resolve);
 const engine=new WorkflowEngine(async action=>{calls.push(structuredClone(action));if(calls.length===1)await wait;return {ok:true,message:'Done'};});
 const scheduler=new Scheduler({run:(action,signal,context)=>engine.run(action.workflowId,context.config,signal,context.progress)});
 const input=trigger(),accepted=scheduler.trigger('one',input,c);assert.throws(()=>scheduler.trigger('two',trigger(),c),error=>error.code==='BUSY');
 c.workflows[0].steps.reverse();c.workflows[0].steps[1].action={...app,appId:'changed.must.not.run'};
 assert.equal(scheduler.trigger('one',input,c).id,accepted.id);await delay(10);release();await until(()=>!scheduler.busy);
 assert.deepEqual(calls,[app,key,app]);const result=scheduler.get('one',input.requestId);assert.equal(result.status,'succeeded');assert.deepEqual(parseExecution(result),result);assert.throws(()=>scheduler.get('two',input.requestId),error=>error.code==='RESULT_UNKNOWN');
});

test('confirmations are one use, short lived, device/request/revision bound and invalidated on disconnect',()=>{
 let now=100;const c=config();components(c)[0].requiresConfirmation=true;const proofs=new Confirmations(()=>now),input=trigger();
 const challenge=proofs.issue('one',input,c),confirmed={...input,confirmation:challenge.id};
 for(const bad of [{...confirmed,requestId:randomUUID()},{...confirmed,componentId:'other'},{...confirmed,revision:2}])assert.throws(()=>proofs.consume('one',bad));
 assert.throws(()=>proofs.consume('two',confirmed));proofs.consume('one',confirmed);assert.throws(()=>proofs.consume('one',confirmed));
 let next=proofs.issue('one',input,c);now=next.expiresAt;assert.throws(()=>proofs.consume('one',{...input,confirmation:next.id}));
 next=proofs.issue('one',input,c);proofs.cancel('one');assert.throws(()=>proofs.consume('one',{...input,confirmation:next.id}));
 assert.throws(()=>proofs.issue('one',{...input,revision:0},c),error=>error.code==='CONFIG_CONFLICT');
});

test('scheduler requires confirmation for risky steps and deduplicates a confirmed execution after consuming it',async()=>{
 const c=config();c.workflows[0].steps[1].requiresConfirmation=true;let calls=0;const engine=new WorkflowEngine(async()=>{calls++;return {ok:true,message:'Done'};});
 const scheduler=new Scheduler({run:(action,signal,context)=>engine.run(action.workflowId,context.config,signal,context.progress)}),proofs=new Confirmations(),input=trigger();
 assert.throws(()=>scheduler.trigger('one',input,c),error=>error.code==='CONFIRMATION_REQUIRED');assert.equal(calls,0);
 const nonce=proofs.issue('one',input,c),confirmed={...input,confirmation:nonce.id};
 const first=scheduler.trigger('one',confirmed,c,()=>proofs.consume('one',confirmed));await until(()=>!scheduler.busy);
 assert.equal(calls,3);assert.equal(scheduler.trigger('one',confirmed,c,()=>{throw Error('must not consume twice');}).id,first.id);assert.equal(calls,3);
});
