import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,statSync,symlinkSync,unlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ScriptRegistry} from '../dist/apps/host/scripts.js';
import {ShellAdapter} from '../dist/apps/host/shell.js';
import {Scheduler} from '../dist/apps/host/scheduler.js';
import {ConfigStore} from '../dist/apps/host/store.js';
import {parseAction,parseExecution,parseShellOutput,parseShellParameters} from '../dist/packages/contracts/index.js';
import {seedDir,withPrimary,components} from './helpers/layout.mjs';

const fault=code=>error=>error.code===code;
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'keyln-shell-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const scripts=new ScriptRegistry(dir);
  const save=(source,parameters=[],overrides={})=>scripts.save({revision:scripts.localState().revision,id:null,
    definition:{name:'Owned safe test',kind:'command',source,interpreter:'/bin/sh',parameters,timeoutMs:3000,...overrides}}).id;
  const approve=id=>{const preview=scripts.preview({id});scripts.approve({revision:scripts.localState().revision,id,version:preview.version});return {type:'shell.run',scriptId:id,version:preview.version,args:[]};};
  return {dir,scripts,save,approve,run:action=>new ShellAdapter(scripts).run(action,new AbortController().signal)};
}
async function until(predicate){const end=Date.now()+2500;while(!predicate()&&Date.now()<end)await delay(15);assert.ok(predicate());}

test('Shell contracts pin one version, bound non-secret positional arguments and reject command overrides',()=>{
  const action={type:'shell.run',scriptId:'safe',version:'a'.repeat(64),args:['literal;$(nothing)']};
  assert.deepEqual(parseAction(action),action);
  for(const invalid of [{...action,command:'echo wrong'},{...action,args:[{}]},{...action,version:'latest'},{...action,args:['a\ncommand']},{...action,args:['x'.repeat(257)]}])
    assert.throws(()=>parseAction(invalid),fault('INVALID_INPUT'));
  for(const rules of [[{name:'x',kind:'regex',pattern:'.*'}],[{name:'x',kind:'integer',min:2,max:1}],[{name:'x',kind:'choice',choices:['a','a']}],[{name:'x',kind:'text',maxLength:257}]])
    assert.throws(()=>parseShellParameters(rules),fault('INVALID_INPUT'));
  assert.throws(()=>parseShellOutput({exitCode:0,signal:null,stdout:'x'.repeat(4097),stderr:'',truncated:true}),fault('INVALID_INPUT'));
  const output={exitCode:0,signal:null,stdout:'ok',stderr:'',truncated:false};
  const execution={id:randomUUID(),requestId:randomUUID(),status:'succeeded',actionType:'shell.run',createdAt:1,finishedAt:2,message:'Done',output};
  assert.deepEqual(parseExecution(execution),execution);
  assert.throws(()=>parseExecution({...execution,actionType:'app.open'}),fault('INVALID_INPUT'));
});

test('local script drafts need a reviewed version, persist approvals and publish only safe catalog metadata',t=>{
  const f=fixture(t),id=f.save('printf "local script body"');
  assert.deepEqual(f.scripts.available(),[]);
  const preview=f.scripts.preview({id});assert.equal(preview.sourceText,'printf "local script body"');
  const action=f.approve(id),catalog=f.scripts.available();
  assert.equal(catalog[0].id,id);assert.deepEqual(Object.keys(catalog[0]),['id','name','version','parameters']);
  assert.doesNotMatch(JSON.stringify(catalog),/local script body|source|interpreter|approvedVersion/);
  assert.equal(new ScriptRegistry(f.dir).prepare(action).bytes.toString(),'printf "local script body"');
  assert.equal(statSync(f.scripts.path).mode&0o777,0o600);assert.equal(statSync(f.dir).mode&0o777,0o700);
});

test('file content, path and parameter edits invalidate approvals and stale previews cannot approve changed bytes',t=>{
  const f=fixture(t),path=join(f.dir,'owned.sh');writeFileSync(path,'printf first');
  const id=f.save(path,[],{kind:'file'}),first=f.approve(id),preview=f.scripts.preview({id});
  writeFileSync(path,'printf changed');assert.deepEqual(f.scripts.available(),[]);
  assert.throws(()=>f.scripts.prepare(first),fault('SCRIPT_CHANGED'));
  assert.throws(()=>f.scripts.approve({revision:f.scripts.localState().revision,id,version:preview.version}),fault('SCRIPT_CHANGED'));
  const current=f.approve(id);assert.notEqual(current.version,first.version);
  assert.throws(()=>f.scripts.prepare(first),fault('SCRIPT_CHANGED'));
  const stored=f.scripts.localState().scripts[0],{id:_,approvedVersion,version,status,error,...definition}=stored;
  f.scripts.save({revision:f.scripts.localState().revision,id,definition:{...definition,parameters:[{name:'Mode',kind:'choice',choices:['safe']}]}});
  assert.deepEqual(f.scripts.available(),[]);assert.throws(()=>f.scripts.prepare(current),fault('SCRIPT_UNAPPROVED'));
  assert.throws(()=>f.scripts.revoke({revision:0,id}),fault('SCRIPT_CONFLICT'));
});

test('file approval rejects links, directories, oversize and non-UTF8 files without executing them',t=>{
  const f=fixture(t),target=join(f.dir,'owned.sh'),link=join(f.dir,'linked.sh');writeFileSync(target,'printf safe');symlinkSync(target,link);
  for(const path of [link,f.dir]){const id=f.save(path,[],{kind:'file'});assert.throws(()=>f.scripts.preview({id}),fault('SCRIPT_UNAVAILABLE'));}
  writeFileSync(target,Buffer.alloc(65537,65));let id=f.save(target,[],{kind:'file'});assert.throws(()=>f.scripts.preview({id}),fault('SCRIPT_UNAVAILABLE'));
  writeFileSync(target,Buffer.from([0xff,0xfe,0xfd]));assert.throws(()=>f.scripts.preview({id}),fault('SCRIPT_UNAVAILABLE'));
  unlinkSync(target);assert.throws(()=>f.scripts.preview({id}),fault('SCRIPT_UNAVAILABLE'));
});

test('safe temporary Shell execution passes arguments literally and does not inherit Host secrets',async t=>{
  const f=fixture(t),marker=join(f.dir,'must-not-exist'),literal=`hello; $(touch ${marker})`;
  const id=f.save('printf "%s\\n%s" "$1" "${KEYLN_TEST_SENTINEL-unset}"',[{name:'Value',kind:'text',maxLength:256}]);
  const action={...f.approve(id),args:[literal]},prior=process.env.KEYLN_TEST_SENTINEL;process.env.KEYLN_TEST_SENTINEL='private-host-sentinel';
  try{const result=await f.run(action);assert.equal(result.ok,true);assert.equal(result.output.exitCode,0);assert.equal(result.output.stdout,literal+'\nunset');assert.equal(existsSync(marker),false);}
  finally{if(prior===undefined)delete process.env.KEYLN_TEST_SENTINEL;else process.env.KEYLN_TEST_SENTINEL=prior;}
});

test('all three allowed Mac shells receive the approved snapshot and positional arguments',async t=>{
  const f=fixture(t);
  for(const interpreter of ['/bin/zsh','/bin/bash','/bin/sh']){
    const id=f.save('printf "%s:%s" "$#" "$1"',[{name:'Literal value',kind:'text',maxLength:80}],{interpreter});
    const result=await f.run({...f.approve(id),args:['--literal; $(no evaluation)']});
    assert.equal(result.ok,true,interpreter);assert.equal(result.output.stdout,'1:--literal; $(no evaluation)',interpreter);
  }
});

test('a successful shell also cleans up background children before releasing the result',async t=>{
  const f=fixture(t),pidFile=join(f.dir,'normal-child.pid');
  const id=f.save('/bin/sleep 10 </dev/null >/dev/null 2>&1 & printf "%s" "$!" > "$1"; exit 0',
    [{name:'Owned pid file',kind:'text',maxLength:256}]);
  const result=await f.run({...f.approve(id),args:[pidFile]});assert.equal(result.ok,true);
  const pid=Number(readFileSync(pidFile,'utf8'));assert.ok(Number.isInteger(pid)&&pid>1);
  await until(()=>{try{process.kill(pid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}});
});

test('parameter rules reject extra, invalid choice and out-of-range values before any process starts',async t=>{
  const f=fixture(t),marker=join(f.dir,'should-not-run');
  const id=f.save(`printf ran > '${marker}'`,[{name:'Mode',kind:'choice',choices:['safe']},{name:'Count',kind:'integer',min:1,max:3}]);
  const action=f.approve(id);
  for(const args of [[],['unsafe','1'],['safe','4'],['safe','1.5'],['safe','1','extra']]){
    const result=await f.run({...action,args});assert.equal(result.ok,false);assert.equal(result.code,'SCRIPT_ARGUMENTS');assert.equal(existsSync(marker),false);
  }
  f.scripts.revoke({revision:f.scripts.localState().revision,id});
  assert.equal((await f.run({...action,args:['safe','1']})).code,'SCRIPT_UNAPPROVED');
});

test('nonzero exit and large output remain bounded, plain text and distinct from successful completion',async t=>{
  const f=fixture(t);
  let result=await f.run(f.approve(f.save('printf "problem" >&2; exit 7')));
  assert.equal(result.ok,false);assert.equal(result.code,'SHELL_EXIT');assert.equal(result.output.exitCode,7);assert.equal(result.output.stderr,'problem');
  result=await f.run(f.approve(f.save('/usr/bin/yes x | /usr/bin/head -c 20000')));
  assert.equal(result.ok,true);assert.equal(result.output.truncated,true);assert.ok(result.output.stdout.length+result.output.stderr.length<=4096);
});

test('timeout kills its managed process group and stays unknown even if TERM could be handled',async t=>{
  const f=fixture(t),pidFile=join(f.dir,'owned-child.pid');
  const id=f.save('trap "" TERM; /bin/sleep 10 & child=$!; printf "%s" "$child" > "$1"; wait',
    [{name:'Owned pid file',kind:'text',maxLength:256}],{timeoutMs:150});
  const started=Date.now(),result=await f.run({...f.approve(id),args:[pidFile]});
  assert.equal(result.ok,false);assert.equal(result.unknown,true);assert.equal(result.code,'SHELL_TIMEOUT');assert.ok(Date.now()-started<2000);
  const pid=Number(readFileSync(pidFile,'utf8'));assert.ok(Number.isInteger(pid)&&pid>1);
  await until(()=>{try{process.kill(pid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}});
});

test('scheduler holds busy through Shell abort cleanup',async t=>{
  const f=fixture(t),action=f.approve(f.save('/bin/sleep 10'));
  const shell=new ShellAdapter(f.scripts),scheduler=new Scheduler({run:(action,signal)=>shell.run(action,signal)},Date.now,30);
  const config=withPrimary();components(config)[0].action=action;
  const requestId=randomUUID();scheduler.trigger('owned',{requestId,componentId:'primary',revision:0},config);
  await delay(60);assert.equal(scheduler.busy,true);
  await until(()=>!scheduler.busy);assert.equal(scheduler.get('owned',requestId).status,'unknown');
  assert.equal(scheduler.get('owned',requestId).code,'RESULT_UNKNOWN');
});

test('execution output is private data and observers cannot mutate the retained nested result',async()=>{
  const output={exitCode:0,signal:null,stdout:'bounded owned output',stderr:'',truncated:false};
  const scheduler=new Scheduler({run:async()=>({ok:true,message:'Done',output})});
  const config=withPrimary();components(config)[0].action={type:'shell.run',scriptId:'owned',version:'a'.repeat(64),args:[]};
  scheduler.onChange((_,execution)=>{if(execution.output)execution.output.stdout='observer modification';});
  const requestId=randomUUID();scheduler.trigger('owned',{requestId,componentId:'primary',revision:0},config);await until(()=>!scheduler.busy);
  assert.equal(scheduler.get('owned',requestId).output.stdout,output.stdout);
  const copy=scheduler.get('owned',requestId);copy.output.stdout='read modification';
  assert.equal(scheduler.get('owned',requestId).output.stdout,output.stdout);
  assert.throws(()=>scheduler.get('other-device',requestId),fault('RESULT_UNKNOWN'));
});

test('unapproved registry bindings cannot be newly saved and corrupt registries are preserved',t=>{
  const f=fixture(t);seedDir(f.dir);const store=new ConfigStore(f.dir),config=store.get();components(config)[0].action={type:'shell.run',scriptId:'absent',version:'a'.repeat(64),args:[]};
  assert.throws(()=>store.replace(config,[]),fault('SCRIPT_UNAVAILABLE'));assert.equal(store.get().revision,0);
  const broken='{invalid registry';writeFileSync(f.scripts.path,broken);
  assert.throws(()=>new ScriptRegistry(f.dir),/preserved/);assert.equal(readFileSync(f.scripts.path,'utf8'),broken);
});
