import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'node:https';
import { WebSocket } from 'ws';
import { LocalAdmin, ADMIN_SESSION_MS, requireLocalAdminPeer } from '../dist/apps/host/admin.js';
import { Auth } from '../dist/apps/host/auth.js';
import { ConfigStore } from '../dist/apps/host/store.js';
import { Scheduler } from '../dist/apps/host/scheduler.js';
import { createHost } from '../dist/apps/host/server.js';

const fault = code => error => error.code === code;
test('local administrator codes are bounded, expire and are consumed exactly once', () => {
  let now = 1000; const admin = new LocalAdmin(() => now);
  assert.throws(() => admin.login('12345678'), fault('ADMIN_LOGIN_CLOSED'));
  const code = admin.invite(), wrong = code === '12345678' ? '87654321' : '12345678';
  for (let n = 0; n < 5; n++) assert.throws(() => admin.login(wrong), fault('ADMIN_CODE_INVALID'));
  assert.throws(() => admin.login(code), fault('ADMIN_LOGIN_CLOSED'));
  const expired = admin.invite(); now += 120000;
  assert.throws(() => admin.login(expired), fault('ADMIN_LOGIN_CLOSED'));
  const previous = admin.invite(), current = admin.invite();
  if (previous !== current) assert.throws(() => admin.login(previous), fault('ADMIN_CODE_INVALID'));
  const session = admin.login(current);
  assert.match(session.token, /^[a-f0-9]{64}$/);
  assert.equal(session.expiresAt, now + ADMIN_SESSION_MS);
  assert.throws(() => admin.login(current), fault('ADMIN_LOGIN_CLOSED'));
});

test('administrator sessions are isolated, capped, revoked on logout/restart and expire', () => {
  let now = 1000; const admin = new LocalAdmin(() => now), cookies = [];
  for (let n = 0; n < 4; n++) cookies.push(`__Host-keyln-admin=${admin.login(admin.invite()).token}`);
  const fifth = admin.invite(); assert.throws(() => admin.login(fifth), fault('ADMIN_SESSION_LIMIT'));
  assert.throws(() => admin.authenticate(`__Host-keyln=${'a'.repeat(64)}`), fault('ADMIN_UNAUTHORIZED'));
  assert.throws(() => admin.authenticate(`${cookies[0]}; ${cookies[0]}`), fault('ADMIN_UNAUTHORIZED'));
  assert.equal(admin.authenticate(cookies[0]), now + ADMIN_SESSION_MS);
  admin.logout(cookies[0]); assert.throws(() => admin.authenticate(cookies[0]), fault('ADMIN_UNAUTHORIZED'));
  assert.equal(admin.authenticate(cookies[1]), now + ADMIN_SESSION_MS);
  const another = `__Host-keyln-admin=${admin.login(admin.invite()).token}`;
  now += ADMIN_SESSION_MS;
  assert.throws(() => admin.authenticate(another), fault('ADMIN_UNAUTHORIZED'));
  const renewed = `__Host-keyln-admin=${admin.login(admin.invite()).token}`;
  assert.throws(() => new LocalAdmin(() => now).authenticate(renewed), fault('ADMIN_UNAUTHORIZED'));
  admin.clear(); assert.throws(() => admin.authenticate(renewed), fault('ADMIN_UNAUTHORIZED'));
});

test('administrator local-peer check ignores forwarded headers and still needs a session', () => {
  const request = address => ({socket:{remoteAddress:address},headers:{'x-forwarded-for':'192.0.2.10',forwarded:'for=192.0.2.10'}});
  assert.doesNotThrow(() => requireLocalAdminPeer(request('::ffff:192.0.2.10'), '192.0.2.10'));
  for (const address of ['192.0.2.20', '127.0.0.1', undefined])
    assert.throws(() => requireLocalAdminPeer(request(address), '192.0.2.10'), fault('LOCAL_ADMIN_ONLY'));
  assert.throws(() => new LocalAdmin().authenticate(), fault('ADMIN_UNAUTHORIZED'));
});

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'keyln-admin-'));
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  execFileSync(process.execPath, ['scripts/setup.mjs'], {env:{...process.env,KEYLN_DATA_DIR:dir},stdio:'pipe'});
  let now = Date.now(), calls = 0;
  const auth = new Auth(dir, () => now), admin = new LocalAdmin(() => now), store = new ConfigStore(dir);
  const origin = 'https://127.0.0.1:0', ca = readFileSync(join(dir, 'tls/rootCA.pem'));
  const scheduler = new Scheduler({run:async () => { calls++; return {ok:true,message:'No native action'}; }});
  const server = createHost({auth,admin,store,scheduler,origin,apps:[],onPair:()=>{},
    tls:{key:readFileSync(join(dir,'tls/server.key')),cert:readFileSync(join(dir,'tls/server.pem'))}});
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(() => new Promise(resolve => {server.stopEvents();server.closeAllConnections();server.close(resolve);}));
  const connection = {hostname:'127.0.0.1',servername:'',port:server.address().port,ca};
  function send(path, input={}, {cookie='', method='POST',headers={}}={}) {
    return new Promise((resolve,reject) => {
      const req = request({...connection,path,method,headers:{host:'127.0.0.1:0',origin,'content-type':'application/json','x-keyln-client':'1',cookie,...headers}},res=>{
        let body='';res.setEncoding('utf8');res.on('data',part=>{body+=part;});res.on('end',()=>{
          resolve({status:res.statusCode,headers:res.headers,body,data:res.headers['content-type']?.startsWith('application/json')?JSON.parse(body):undefined});
        });
      });req.on('error',reject);req.end(method==='GET'?undefined:typeof input==='string'?input:JSON.stringify(input));
    });
  }
  async function login() {
    const response = await send('/api/admin/login',{code:admin.invite()}); assert.equal(response.status,200);
    return response.headers['set-cookie'][0].split(';')[0];
  }
  return {auth,admin,store,send,login,connection,origin,server,dir,get calls(){return calls;},advance(ms){now+=ms;}};
}

test('real TLS administrator API enforces independent login, origin, schema and role boundaries', async t => {
  const f=await fixture(t), send=f.send;
  for(const path of ['/admin','/admin.css','/apps/web/admin.js']) {
    const asset=await send(path,{}, {method:'GET'});assert.equal(asset.status,200);assert.ok(asset.body.length>100);
    assert.equal(asset.headers['cache-control'],'no-store');assert.match(asset.headers['content-security-policy'],/frame-ancestors 'none'/);
  }
  const code=f.admin.invite();
  assert.equal((await send('/api/admin/login',{code},{headers:{origin:'https://evil.example'}})).status,403);
  assert.equal((await send('/api/admin/login',{code},{headers:{host:'evil.example'}})).status,403);
  assert.equal((await send('/api/admin/login',{code},{headers:{'x-keyln-client':''}})).status,403);
  assert.equal((await send('/api/admin/login',{code},{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await send('/api/admin/login',{code},{headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await send('/api/admin/login',{code,admin:true})).status,400);
  assert.equal((await send('/api/admin/login','{broken')).status,400);
  assert.equal((await send('/api/admin/login',{code:'x'.repeat(1100)})).status,413);
  const loggedIn=await send('/api/admin/login',{code});assert.equal(loggedIn.status,200);
  const setCookie=loggedIn.headers['set-cookie'][0], cookie=setCookie.split(';')[0];
  for(const flag of ['HttpOnly','Secure','SameSite=Strict','Path=/','Max-Age=1800'])assert.ok(setCookie.includes(flag));
  assert.deepEqual(Object.keys(loggedIn.data),['expiresAt']);
  assert.equal((await send('/api/admin/login',{code})).data.error.code,'ADMIN_LOGIN_CLOSED');
  assert.equal((await send('/api/admin/state')).status,401);
  for(const path of ['/api/configuration','/api/apps','/api/execute'])assert.equal((await send(path,{}, {cookie})).status,401);
  assert.equal((await send('/api/admin/state',{}, {cookie})).status,200);
  assert.equal((await send('/api/admin/invite',{extra:true},{cookie})).status,400);
  assert.equal(f.auth.pairingState().expiresAt,null);
  assert.equal((await send('/api/admin/invite',{}, {cookie,headers:{origin:'https://evil.example'}})).status,403);
  assert.equal((await send('/api/admin/login?code=12345678',{}, {cookie})).status,404);
  const pending=f.auth.begin(f.auth.invite(),'Surface test');f.auth.approve(pending.id);
  const deviceCookie=`__Host-keyln=${f.auth.claim(pending.id,pending.claim).token}`;
  assert.equal((await send('/api/admin/state',{}, {cookie:deviceCookie})).status,401);
  assert.equal((await send('/api/admin/approve',{id:pending.id},{cookie:deviceCookie})).status,401);
  const state=await send('/api/admin/state',{}, {cookie});
  assert.equal(state.data.devices.length,1);assert.doesNotMatch(state.body,/tokenHash|claimHash|__Host-keyln/);
  const second=await f.login();
  const logout=await send('/api/admin/logout',{}, {cookie});assert.equal(logout.status,200);assert.match(logout.headers['set-cookie'][0],/Max-Age=0/);
  assert.equal((await send('/api/admin/state',{}, {cookie})).status,401);
  assert.equal((await send('/api/admin/state',{}, {cookie:second})).status,200);
  assert.equal((await send('/api/configuration',{}, {cookie:deviceCookie})).status,200);
  f.advance(ADMIN_SESSION_MS);
  assert.equal((await send('/api/admin/state',{}, {cookie:second})).status,401);
  assert.equal(f.calls,0);
});

test('administrator pairing approval is bound to a live ID and revocation closes only that device', async t => {
  const f=await fixture(t), cookie=await f.login(), send=(path,input={})=>f.send(path,input,{cookie});
  const invite=await send('/api/admin/invite');assert.match(invite.data.code,/^\d{8}$/);
  let pair=await f.send('/api/pair',{code:invite.data.code,name:'M1-test'});assert.equal(pair.status,202);
  const state=await send('/api/admin/state');assert.equal(state.data.pairing.pending.id,pair.data.id);
  assert.doesNotMatch(state.body,/claimHash|tokenHash|"claim"|"code"/);
  assert.equal((await send('/api/admin/approve',{id:'wrong-id'})).status,409);
  assert.equal((await f.send('/api/pair/status',pair.data)).data.approved,false);
  await send('/api/admin/close-pairing');assert.equal((await f.send('/api/pair/status',pair.data)).status,401);
  const replacement=await send('/api/admin/invite');
  pair=await f.send('/api/pair',{code:replacement.data.code,name:'M1-test'});
  assert.equal((await send('/api/admin/approve',{id:pair.data.id})).status,200);
  const claim=await f.send('/api/pair/status',pair.data), deviceCookie=claim.headers['set-cookie'][0].split(';')[0];
  const other=f.auth.begin(f.auth.invite(),'Other device');f.auth.approve(other.id);
  const otherCookie=`__Host-keyln=${f.auth.claim(other.id,other.claim).token}`;
  const ws=new WebSocket(`wss://127.0.0.1:${f.connection.port}/api/events`,'keyln.events.v3',
    {ca:f.connection.ca,servername:'',origin:f.origin,headers:{host:'127.0.0.1:0',cookie:deviceCookie}});
  t.after(()=>ws.terminate());await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const closed=new Promise(resolve=>ws.once('close',code=>resolve(code)));
  assert.equal((await send('/api/admin/revoke',{id:pair.data.id})).status,200);assert.equal(await closed,4001);
  assert.equal((await f.send('/api/configuration',{}, {cookie:deviceCookie})).status,401);
  assert.equal((await f.send('/api/configuration',{}, {cookie:otherCookie})).status,200);
  assert.equal((await send('/api/admin/revoke',{id:pair.data.id})).status,404);
  assert.deepEqual(new Auth(f.dir).list().map(item=>item.id),[other.id]);
  assert.equal(f.calls,0);
});

test('administrator authority is checked again after an upload yields', async t => {
  const f=await fixture(t), cookie=await f.login();
  const started=new Promise(resolve=>f.server.once('request',resolve));
  let upload;
  const late=new Promise((resolve,reject)=>{
    upload=request({...f.connection,path:'/api/admin/invite',method:'POST',headers:{host:'127.0.0.1:0',origin:f.origin,
      cookie,'x-keyln-client':'1','content-type':'application/json','content-length':2}},res=>{
      res.resume();res.on('end',()=>resolve(res.statusCode));
    });upload.on('error',reject);upload.write('{');
  });
  await started;
  assert.equal((await f.send('/api/admin/logout',{}, {cookie})).status,200);
  upload.end('}');assert.equal(await late,401);assert.equal(f.auth.pairingState().expiresAt,null);assert.equal(f.calls,0);
});

test('production Host starts Mac management, pairs via its API and shuts down without a native action', {timeout:20000}, async t => {
  const f=await fixture(t);
  await new Promise(resolve=>{f.server.stopEvents();f.server.closeAllConnections();f.server.close(resolve);});
  const origin=`https://127.0.0.1:${f.connection.port}`;
  writeFileSync(join(f.dir,'host.json'),JSON.stringify({schemaVersion:1,address:'127.0.0.1',port:f.connection.port,origin}));
  const child=spawn(process.execPath,['dist/apps/host/main.js'],{env:{...process.env,KEYLN_DATA_DIR:f.dir},stdio:['pipe','pipe','pipe']});
  child.stdin.on('error',()=>{});child.stderr.resume();
  const closed=new Promise(resolve=>child.once('close',code=>resolve(code)));
  const codeReady=new Promise((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>reject(new Error('Temporary production Host startup timed out.')),12000);
    child.stdout.on('data',chunk=>{
      output+=chunk;const match=output.match(/Mac management login code: ([0-9]{8}) /);
      if(match){clearTimeout(timer);if(output.includes(`${origin}/admin`))resolve(match[1]);else reject(new Error('Missing Mac management address.'));output='';}
      if(output.length>8192){clearTimeout(timer);reject(new Error('Unexpected startup output.'));}
    });
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Could not start the temporary production Host.'));});
    child.once('close',()=>{clearTimeout(timer);reject(new Error('Temporary production Host exited before startup.'));});
  });
  const send=(path,input={},options={})=>f.send(path,input,{...options,headers:{host:`127.0.0.1:${f.connection.port}`,origin,...options.headers}});
  try {
    const login=await send('/api/admin/login',{code:await codeReady});assert.equal(login.status,200);
    const duplicate=spawnSync(process.execPath,['scripts/prepare-start.mjs'],{env:{...process.env,KEYLN_DATA_DIR:f.dir},encoding:'utf8',timeout:4000});
    assert.equal(duplicate.status,1);assert.ok(duplicate.stderr.includes(`PID ${child.pid}`));
    assert.ok(duplicate.stderr.includes('No new Host was started from this window'));
    const adminCookie=login.headers['set-cookie'][0].split(';')[0];
    const invite=await send('/api/admin/invite',{}, {cookie:adminCookie});assert.equal(invite.status,200);
    const pair=await send('/api/pair',{code:invite.data.code,name:'Production M1 test'});assert.equal(pair.status,202);
    assert.equal((await send('/api/admin/approve',{id:pair.data.id},{cookie:adminCookie})).status,200);
    const claim=await send('/api/pair/status',pair.data);assert.equal(claim.data.approved,true);
    const deviceCookie=claim.headers['set-cookie'][0].split(';')[0];
    assert.equal((await send('/api/configuration',{}, {cookie:deviceCookie})).status,200);
    assert.equal((await send('/api/configuration',{}, {cookie:adminCookie})).status,401);
    assert.equal((await send('/api/echo',{sampleId:'66d5ffad-2ef9-49e0-900d-f8feaf8f746f'},{cookie:deviceCookie})).status,200);
    assert.equal((await send('/api/admin/revoke',{id:pair.data.id},{cookie:adminCookie})).status,200);
    assert.equal((await send('/api/configuration',{}, {cookie:deviceCookie})).status,401);
    await promisify(execFile)(process.execPath,['scripts/stop-host.mjs'],{env:{...process.env,KEYLN_DATA_DIR:f.dir},timeout:12000});
    assert.equal(await closed,0,'Explicit restart helper stopped only its verified temporary Host');
  } finally {
    child.stdin.end('quit\n');
    let timer;const exit=await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(()=>{child.kill('SIGKILL');resolve(null);},4000);})]);
    clearTimeout(timer);if(exit===null)await closed;
    assert.equal(exit,0,'Production Host must shut down cleanly');
    assert.equal(existsSync(join(f.dir,'host.lock')),false);
  }
});

test('manual restart refuses a live unrelated Node process even when a lock points to it', async () => {
  const dir=mkdtempSync(join(tmpdir(),'keyln-stop-'));
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  const closed=new Promise(resolve=>child.once('close',resolve));
  try {
    writeFileSync(join(dir,'host.lock'),String(child.pid));
    await assert.rejects(promisify(execFile)(process.execPath,['scripts/stop-host.mjs'],{env:{...process.env,KEYLN_DATA_DIR:dir},timeout:12000}),error=>error.code===1);
    assert.doesNotThrow(()=>process.kill(child.pid,0));
  } finally { child.kill('SIGTERM');await closed;rmSync(dir,{recursive:true,force:true}); }
});
