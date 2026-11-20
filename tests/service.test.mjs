import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync,existsSync,symlinkSync,mkdirSync,chmodSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createServer,connect} from 'node:net';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {servicePaths,serviceNodePath,servicePlist,prepareService,readService,hostAlive,certificateStatus} from '../dist/apps/host/service.js';
import {ConfigStore} from '../dist/apps/host/store.js';
import {LocalAdmin} from '../dist/apps/host/admin.js';
import {localManagement,requestLocalManagement,managementPath} from '../dist/apps/host/local-management.js';
import {rotatingLog,lineSink} from '../dist/apps/host/logging.js';

function directory(t){const dir=mkdtempSync(join(tmpdir(),'keyln-service-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function fixture(t){const dir=directory(t);execFileSync(process.execPath,['scripts/setup.mjs'],{env:{...process.env,KEYLN_DATA_DIR:dir},stdio:'pipe'});new ConfigStore(dir);return {dir,paths:servicePaths(dir,'local.keyln.host.test.1234abcd',join(dir,'agents'))};}
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');

test('user LaunchAgent uses fixed absolute runtime paths, failure restart and private GUI-user settings',t=>{
 const dir=directory(t),paths=servicePaths(join(dir,'Path & space'),'local.keyln.host.test.1234abcd',join(dir,'agents')),path=join(dir,'agent.plist');
 writeFileSync(path,servicePlist(paths,process.execPath));const plist=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',path],{encoding:'utf8'}));
 assert.equal(plist.Label,paths.label);assert.equal(plist.WorkingDirectory,paths.runtime);assert.equal(plist.EnvironmentVariables.KEYLN_DATA_DIR,paths.data);assert.equal(plist.EnvironmentVariables.PATH,'/usr/bin:/bin:/usr/sbin:/sbin');assert.deepEqual(plist.KeepAlive,{SuccessfulExit:false});assert.equal(plist.RunAtLoad,true);assert.equal(plist.ThrottleInterval,15);assert.equal(plist.Umask,63);assert.equal(plist.LimitLoadToSessionType,'Aqua');assert.equal(plist.UserName,undefined);assert.ok(plist.ProgramArguments.every(value=>value.startsWith('/')));assert.ok(!JSON.stringify(plist).includes('Terminal'));
});

test('runtime installation and update preserve private data and install the exact helper outside the source checkout',t=>{
 const {dir,paths}=fixture(t),files=['config.json','host.json','tls/rootCA.pem','tls/server.key'],before=files.map(file=>digest(join(dir,file)));
 const entry=join(dir,'stable-node');symlinkSync(process.execPath,entry);
 const installed=prepareService(paths,process.cwd(),entry);assert.equal(installed.node,entry);assert.equal(installed.uid,process.getuid());assert.equal(readService(paths).runtime,paths.runtime);assert.ok(existsSync(join(paths.runtime,'node_modules/ws/package.json')));assert.equal(digest(join(paths.runtime,'dist/keyln-helper')),digest('dist/keyln-helper'));assert.equal(statSync(paths.plist).mode&0o777,0o600);assert.equal(statSync(join(paths.runtime,'dist/keyln-helper')).mode&0o777,0o700);
 assert.equal(JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',paths.plist],{encoding:'utf8'})).ProgramArguments[0],entry);
 prepareService(paths,process.cwd(),readService(paths).node);assert.equal(readService(paths).node,entry);assert.ok(existsSync(join(paths.runtime+'.previous','.keyln-runtime.json')));assert.deepEqual(files.map(file=>digest(join(dir,file))),before);assert.equal(certificateStatus(dir).matchesAddress,true);assert.equal(certificateStatus(dir).expired,false);
});

test('stable Node entry follows an upgraded target after old version removal and still rejects missing, unsupported or untrusted targets',t=>{
 const dir=directory(t),old=join(dir,'node-26.12.1'),next=join(dir,'node-26.13.0'),entry=join(dir,'node');
 const runtime=(file,version)=>writeFileSync(file,`#!/bin/sh\nprintf '%s\\n' '${version}'\n`,{mode:0o700});
 runtime(old,'v26.12.1');runtime(next,'v26.13.0');symlinkSync(old,entry);assert.equal(serviceNodePath(entry),entry);
 symlinkSync(next,entry+'.new');renameSync(entry+'.new',entry);rmSync(old);assert.equal(serviceNodePath(entry),entry);
 chmodSync(next,0o722);assert.throws(()=>serviceNodePath(entry),/trusted Node binary/);chmodSync(next,0o700);
 runtime(next,'v27.0.0');assert.throws(()=>serviceNodePath(entry),/supported Node 24 or 26/);
 runtime(next,'v24.22.0');assert.equal(serviceNodePath(entry),entry);
 rmSync(next);assert.throws(()=>serviceNodePath(entry),/configured Node entry is missing/);
 assert.throws(()=>serviceNodePath('node'),/absolute Node path/);
});

test('login runner rejects an unsupported Node version before starting a Host',t=>{
 const dir=directory(t),override="Object.defineProperty(process,'version',{value:'v27.0.0'})";
 assert.throws(()=>execFileSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(override),'dist/apps/host/service-runner.js'],{env:{...process.env,KEYLN_DATA_DIR:dir},stdio:'pipe',timeout:5000}),error=>error.status===1);
 const log=readFileSync(join(dir,'logs/host.log'),'utf8');assert.match(log,/v27\.0\.0.*supported Node 24 or 26/);assert.doesNotMatch(log,/Host child started/);assert.equal(existsSync(join(dir,'host.lock')),false);
});

test('service installation refuses an active Host or unrecognized runtime/LaunchAgent without stopping a process or replacing files',t=>{
 const {dir,paths}=fixture(t),lock=join(dir,'host.lock');writeFileSync(lock,String(process.pid),{mode:0o600});assert.equal(hostAlive(dir),true);assert.throws(()=>prepareService(paths,process.cwd()),/Host is running/);assert.doesNotThrow(()=>process.kill(process.pid,0));rmSync(lock);
 mkdirSync(paths.runtime);writeFileSync(join(paths.runtime,'sentinel'),'keep');assert.throws(()=>prepareService(paths,process.cwd()),/unrecognized runtime/);assert.equal(readFileSync(join(paths.runtime,'sentinel'),'utf8'),'keep');rmSync(paths.runtime,{recursive:true});
 mkdirSync(join(dir,'agents'));writeFileSync(paths.plist,'unrelated',{mode:0o600});assert.throws(()=>prepareService(paths,process.cwd()),/unrecognized LaunchAgent/);assert.equal(readFileSync(paths.plist,'utf8'),'unrelated');
});

test('private local management issues bounded one-use admin codes and reads the actual launch context without a network endpoint',async t=>{
 const dir=directory(t),admin=new LocalAdmin();let doctors=0;
 const close=await localManagement(dir,admin,'https://127.0.0.1:8940',async()=>{doctors++;return {safe:true};});t.after(close);
 assert.equal(statSync(managementPath(dir)).mode&0o777,0o600);
 const result=await requestLocalManagement(dir,'admin');assert.match(result.code,/^\d{8}$/);assert.equal(result.expiresInSeconds,120);assert.ok(admin.login(result.code).token);assert.throws(()=>admin.login(result.code));
 const doctor=await requestLocalManagement(dir,'doctor');assert.equal(doctor.uid,process.getuid());assert.equal(doctor.pid,process.pid);assert.deepEqual(doctor.diagnostics,{safe:true});assert.equal(doctors,1);
 await assert.rejects(requestLocalManagement(dir,'execute'));assert.equal(doctors,1);
 const bad=connect(managementPath(dir));await new Promise(yes=>{bad.on('error',()=>{});bad.on('close',yes);bad.on('connect',()=>bad.write('x'.repeat(257)));});
 const again=await requestLocalManagement(dir,'admin');assert.match(again.code,/^\d{8}$/);assert.equal(doctors,1);
});

test('local management and logs never replace unrelated files or follow dangling links',async t=>{
 const dir=directory(t),socket=managementPath(dir);writeFileSync(socket,'keep',{mode:0o600});await assert.rejects(localManagement(dir,new LocalAdmin(),'https://127.0.0.1:8940',async()=>({})),/preserved/);assert.equal(readFileSync(socket,'utf8'),'keep');
 const logs=join(dir,'logs');mkdirSync(logs);const target=join(dir,'not-created');symlinkSync(target,join(logs,'host.log'));assert.throws(()=>rotatingLog(logs),/private files/);assert.equal(existsSync(target),false);
});

test('background logs have two bounded private files and line capture drains oversized chunks without unbounded buffering',t=>{
 const dir=directory(t),log=rotatingLog(dir,1024);for(let i=0;i<30;i++)log('service',`entry ${i} `+'x'.repeat(180));
 for(const file of ['host.log','host.log.1']){assert.ok(statSync(join(dir,file)).size<=1024);assert.equal(statSync(join(dir,file)).mode&0o777,0o600);for(const line of readFileSync(join(dir,file),'utf8').trim().split('\n'))assert.equal(JSON.parse(line).stream,'service');}
 const lines=[],sink=lineSink(line=>lines.push(line));for(let i=0;i<100;i++)sink(Buffer.from('x'.repeat(8192)));sink(Buffer.from('\nnext\n'));assert.equal(lines[0].length,2048);assert.equal(lines[1],'next');assert.equal(lines.length,2);
});

test('installed background runner starts production Host as this user, omits admin codes from logs and shuts down its own child', {timeout:20000},async t=>{
 const {dir,paths}=fixture(t);prepareService(paths,process.cwd());
 const reservation=createServer();await new Promise(yes=>reservation.listen(0,'127.0.0.1',yes));const port=reservation.address().port;await new Promise(yes=>reservation.close(yes));
 writeFileSync(join(dir,'host.json'),JSON.stringify({schemaVersion:1,address:'127.0.0.1',port,origin:`https://127.0.0.1:${port}`}));
 const child=spawn(process.execPath,[join(paths.runtime,'dist/apps/host/service-runner.js')],{cwd:paths.runtime,env:{...process.env,KEYLN_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});child.stdout.resume();child.stderr.resume();const closed=new Promise(yes=>child.once('close',yes));
 try{
  let info;for(let i=0;i<60&&!info;i++){try{info=await requestLocalManagement(dir,'doctor');}catch{await delay(100);}}
  assert.ok(info);assert.equal(info.uid,process.getuid());assert.equal(info.diagnostics.helperPath,join(paths.runtime,'dist/keyln-helper'));
  const admin=await requestLocalManagement(dir,'admin');assert.match(admin.code,/^\d{8}$/);const log=readFileSync(join(paths.logs,'host.log'),'utf8');assert.ok(!log.includes(admin.code));assert.doesNotMatch(log,/Mac management login code:|Pairing code:|tokenHash|sourceText/);
 }finally{child.kill('SIGTERM');let timer;const code=await Promise.race([closed,new Promise(yes=>timer=setTimeout(()=>{child.kill('SIGKILL');yes(null);},8000))]);clearTimeout(timer);if(code===null)await closed;assert.equal(code,0);}
 assert.equal(existsSync(join(dir,'host.lock')),false);assert.equal(existsSync(managementPath(dir)),false);
});
