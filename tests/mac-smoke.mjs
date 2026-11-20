// Explicit native integration check. Always owns a new temporary Host and data directory.
// Opens Calculator once; never posts a shortcut, reads production data or changes trust.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { EVENT_PATH, EVENT_PROTOCOL, parseConfig, parseExecution, parseHostEvent } from '../dist/packages/contracts/index.js';

if (process.platform !== 'darwin' || process.getuid?.() === 0)
  throw new Error('Run as the signed-in Mac user, without sudo. This check opens Calculator once.');
for (const path of ['dist/apps/host/main.js','dist/keyln-helper'])
  if (!existsSync(path)) throw new Error('Run npm run build first.');
const dir = mkdtempSync(join(tmpdir(), 'keyln-m1-native-'));
const env = { ...process.env, KEYLN_DATA_DIR: dir };
const sockets = new Set();
let host, cookie = '', ca, origin;
const calls = new Map();
const within = async (promise, ms, name) => {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${name} timed out.`)),ms);})]); }
  finally { clearTimeout(timer); }
};
async function freePort() {
  const server = createServer();
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const port = server.address().port;
  await new Promise(resolve=>server.close(resolve));return port;
}
async function startHost() {
  const child = spawn(process.execPath,['dist/apps/host/main.js'],{env,stdio:['pipe','pipe','pipe']});
  child.stdin.on('error',()=>{});
  const waiters = new Set();let ended = false;
  const closed = new Promise(resolve=>child.once('close',(code,signal)=>{ended=true;resolve({code,signal});
    for(const waiter of waiters)waiter.reject(new Error('Temporary Host exited before the expected response.'));}));
  const lines = createInterface({input:child.stdout});
  lines.on('line',line=>{for(const waiter of [...waiters]){const match=line.match(waiter.pattern);if(match){waiters.delete(waiter);waiter.resolve(match);}}});
  // Do not echo pairing codes, claims or cookies from the owned test process.
  child.stderr.on('data',()=>{});
  const wait = (pattern,ms=15_000)=>within(new Promise((resolve,reject)=>{
    if(ended){reject(new Error('Temporary Host is not running.'));return;}
    const waiter={pattern,resolve,reject};waiters.add(waiter);
  }),ms,'Temporary Host response');
  host = {child,closed,wait};
  child.once('error',()=>{for(const waiter of waiters)waiter.reject(new Error('Could not start the temporary Host.'));});
  await wait(/^Keyln is listening at /);
}
async function stopHost(strict=false) {
  if(!host)return;
  const owned=host;host=undefined;
  owned.child.stdin.end('quit\n');
  let exit;
  try { exit=await within(owned.closed,5000,'Temporary Host shutdown'); }
  catch { owned.child.kill('SIGKILL');exit=await within(owned.closed,3000,'Temporary Host cleanup'); }
  if(strict)assert.equal(exit.code,0,'Production entry point shut down cleanly');
}
function api(path, value = {}, headers = {}) {
  calls.set(path,(calls.get(path)||0)+1);
  return new Promise((resolve, reject) => {
    const req = request(`${origin}/api/${path}`, { ca, method: 'POST', timeout: 4000,
      headers: { origin, 'content-type': 'application/json', 'x-keyln-client': '1', cookie, ...headers },
    }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
        try { resolve({status:res.statusCode,data:JSON.parse(body)}); } catch { reject(new Error('Invalid temporary Host response.')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Network timeout'))); req.on('error', reject); req.end(JSON.stringify(value));
  });
}
async function ok(path, value={}) {
  const reply=await api(path,value);assert.ok(reply.status>=200&&reply.status<300,`${path}: ${reply.status} ${reply.data.error?.code||''}`);
  return reply.data;
}
function events() {
  const ws=new WebSocket(`${origin.replace('https:','wss:')}${EVENT_PATH}`,EVENT_PROTOCOL,{ca,origin,headers:{cookie}});
  sockets.add(ws);const frames=[],waiters=new Set();let sequence=0,problem;
  const fail=error=>{problem=error;for(const waiter of waiters)waiter.reject(error);waiters.clear();};
  ws.on('message',raw=>{
    try {
      const event=parseHostEvent(JSON.parse(raw.toString()));assert.ok(event.sequence>sequence);sequence=event.sequence;
      assert.ok(frames.length<128,'Bounded test event history');frames.push(event);
      for(const waiter of [...waiters])if(waiter.predicate(event)){waiters.delete(waiter);waiter.resolve(event);}
    } catch(error){fail(error);}
  });
  ws.on('error',()=>fail(new Error('Temporary authenticated WSS connection failed.')));
  const closed=new Promise(resolve=>ws.once('close',code=>{sockets.delete(ws);resolve(code);}));
  return {ws,frames,closed,wait(predicate,ms=4000){
    const existing=frames.find(predicate);if(existing)return Promise.resolve(existing);
    if(problem)return Promise.reject(problem);
    let waiter;
    return within(new Promise((resolve,reject)=>{waiter={predicate,resolve,reject};waiters.add(waiter);}),ms,'WSS event')
      .finally(()=>waiters.delete(waiter));
  }};
}
async function cleanup() {
  for(const ws of sockets)ws.terminate();
  await stopHost();rmSync(dir,{recursive:true,force:true});
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void cleanup().finally(()=>process.exit(130));});

try {
  console.log('Mac M1 smoke: temporary loopback Host; opens Calculator once. No shortcut keys are posted.');
  const port=await freePort();origin=`https://127.0.0.1:${port}`;
  const setup=spawnSync(process.execPath,['scripts/setup.mjs','--port',String(port)],{env,encoding:'utf8',timeout:15_000});
  assert.equal(setup.status,0,'Temporary certificate setup');
  ca=readFileSync(join(dir,'tls/rootCA.pem'));
  await startHost();
  assert.equal((await api('configuration')).status,401);
  assert.equal((await api('configuration',{}, {origin:'https://invalid.example'})).status,403);
  const codeReady=host.wait(/^Pairing code: ([0-9]{8}) /);host.child.stdin.write('pair\n');
  const code=(await codeReady)[1];
  const pair=await ok('pair',{code,name:'Disposable Mac M1 smoke'});
  assert.equal((await ok('pair/status',pair)).approved,false);
  const approval=host.wait(new RegExp(`^Approved request ${pair.id}\\.$`));host.child.stdin.write(`approve ${pair.id}\n`);await approval;
  assert.equal((await ok('pair/status',pair)).approved,true);
  assert.match(cookie,/^__Host-keyln=/);
  const apps=(await ok('apps')).apps;assert.ok(apps.some(app=>app.id==='com.apple.calculator'));
  const channel=events();const initial=await channel.wait(event=>event.type==='state');
  let config=parseConfig((await ok('configuration')).config);
  config.pages.push({id:'native-test',name:'Native test',size:{w:480,h:360},snap:120});
  config.components.push({id:'native-calculator',pageId:'native-test',kind:'key',frame:{x:360,y:240,w:120,h:120},label:'Calculator smoke',icon:'spark',action:{type:'app.open',appId:'com.apple.calculator'}});
  config=parseConfig((await ok('configuration/save',config)).config);
  await channel.wait(event=>event.type==='state'&&event.revision===config.revision);
  const invalid=structuredClone(config);invalid.components.at(-1).action.appId='com.keyln.DoesNotExist';
  const rejected=await api('configuration/save',invalid);assert.equal(rejected.status,400);assert.equal(rejected.data.error.code,'APP_UNAVAILABLE');
  assert.deepEqual((await ok('configuration')).config,config);
  const command={requestId:randomUUID(),componentId:'native-calculator',revision:config.revision};
  const accepted=parseExecution((await ok('execute',command)).execution);assert.equal(accepted.status,'accepted');
  const duplicate=parseExecution((await ok('execute',command)).execution);assert.equal(duplicate.id,accepted.id);
  const terminal=(await channel.wait(event=>event.type==='execution'&&event.execution.requestId===command.requestId&&
    ['succeeded','failed','unknown'].includes(event.execution.status),12_000)).execution;
  const statuses=channel.frames.filter(event=>event.type==='execution'&&event.execution.requestId===command.requestId).map(event=>event.execution.status);
  assert.deepEqual(statuses,['accepted','running','succeeded']);assert.equal(terminal.id,accepted.id);
  assert.equal(calls.get('result')||0,0,'Completion came through WSS without result polling');
  const resultQueriesAtCompletion=0;
  assert.equal((await api('execute',{...command,requestId:randomUUID(),revision:config.revision-1})).data.error.code,'CONFIG_CONFLICT');
  channel.ws.close();await within(channel.closed,3000,'WSS disconnect');
  const reconnected=events();await reconnected.wait(event=>event.type==='state');
  const recovered=parseExecution((await ok('result',{requestId:command.requestId})).execution);assert.equal(recovered.id,terminal.id);assert.equal(recovered.status,'succeeded');
  config.components.at(-1).label='Saved after native execution';
  config=parseConfig((await ok('configuration/save',config)).config);
  const stale=structuredClone(config);config.pages.push({id:'discard-me',name:'Temporary page',size:{w:480,h:360},snap:120});
  config.components.push({id:'discard-button',pageId:'discard-me',kind:'key',frame:{x:120,y:120,w:120,h:120},label:'Unconfigured',icon:'app',action:null});
  config=parseConfig((await ok('configuration/save',config)).config);
  assert.equal((await api('configuration/save',stale)).status,409);
  config.pages=config.pages.filter(page=>page.id!=='discard-me');config.components=config.components.filter(component=>component.pageId!=='discard-me');
  config=parseConfig((await ok('configuration/save',config)).config);
  reconnected.ws.close();await within(reconnected.closed,3000,'WSS disconnect');
  await stopHost(true);assert.equal(existsSync(join(dir,'host.lock')),false);
  await startHost();const restored=await ok('configuration');assert.deepEqual(restored.config,config);
  assert.notEqual(restored.instanceId,initial.instanceId,'Production Host really restarted');
  const restarted=events();await restarted.wait(event=>event.type==='state'&&event.instanceId===restored.instanceId);
  const lost=await api('result',{requestId:command.requestId});assert.equal(lost.status,404);assert.equal(lost.data.error.code,'RESULT_UNKNOWN');
  const revoked=host.wait(new RegExp(`^Revoked device ${pair.id};`));host.child.stdin.write(`revoke ${pair.id}\n`);await revoked;
  assert.equal(await within(restarted.closed,3000,'Revoked WSS close'),4001);
  assert.equal((await api('configuration')).status,401);assert.equal((await api('execute',command)).status,401);
  const unavailable=spawnSync(resolve('dist/keyln-helper'),['open','com.keyln.DoesNotExist'],{encoding:'utf8',timeout:5000});
  assert.equal(unavailable.status,1);assert.equal(JSON.parse(unavailable.stdout).code,'APP_UNAVAILABLE');
  await stopHost(true);
  console.log(JSON.stringify({ok:true,scope:'Mac native integration; not Surface acceptance',runtime:process.version,
    transport:'HTTPS/WSS with CA and IP verification',eventProtocol:EVENT_PROTOCOL,apps:apps.length,
    pages:config.pages.length,components:config.components.length,savedRevision:config.revision,
    nativeExecution:{id:terminal.id,status:terminal.status,elapsedMs:terminal.finishedAt-terminal.createdAt,message:terminal.message},
    executionEvents:statuses,resultQueriesAtCompletion,duplicateExecutionIdMatches:true,reconnectResultQueries:1,
    restart:{configRestored:true,authorizationRestored:true,newInstance:true,oldResult:'RESULT_UNKNOWN'},
    rejected:{unpaired:true,wrongOrigin:true,missingApp:true,staleRevision:true,revokedHttps:true,revokedWssCode:4001},
    shortcutsPosted:0,productionDataUsed:false},null,2));
} finally {
  await cleanup();console.log('Temporary Host stopped and temporary data removed.');
}
