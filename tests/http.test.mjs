import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import { Auth } from '../dist/apps/host/auth.js';
import { ConfigStore } from '../dist/apps/host/store.js';
import { Scheduler } from '../dist/apps/host/scheduler.js';
import { createHost } from '../dist/apps/host/server.js';
import { MAX_CONFIG_BYTES } from '../dist/packages/contracts/index.js';
import {seedDir,key,withComponents,components,layout,pagesWidget} from './helpers/layout.mjs';
import {saveRequest} from './helpers/save.mjs';
import {viewFor} from '../dist/packages/contracts/index.js';

test('real TLS API enforces approval, origin, authorization and server-owned execution input', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'keyln-http-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync(process.execPath, ['scripts/setup.mjs'], { env: { ...process.env, KEYLN_DATA_DIR: dir }, stdio: 'pipe' });
  seedDir(dir); const auth = new Auth(dir), store = new ConfigStore(dir), origin = 'https://127.0.0.1:0';
  let called = 0, reportedPair;
  const expectedActions = [
    {type:'app.open',appId:'com.apple.calculator'},
    {type:'keyboard.shortcut',key:'KeyK',modifiers:['command','shift']},
    {type:'keyboard.shortcut',key:'Tab',modifiers:[]},
  ];
  const scheduler = new Scheduler({ run: async action => { assert.deepEqual(action, expectedActions[called]); called++; return { ok: true, message: 'Test adapter completed' }; } });
  const server = createHost({ auth, store, scheduler, origin,
    apps: [{ id: 'com.apple.calculator', name: 'Calculator' }],
    tls: { key: readFileSync(join(dir, 'tls/server.key')), cert: readFileSync(join(dir, 'tls/server.pem')) },
    onPair: id => { reportedPair = id; },
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const ca = readFileSync(join(dir, 'tls/rootCA.pem'));
  async function getAsset(path,host='127.0.0.1:0') {
    return await new Promise((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',servername:'',port:server.address().port,ca,path,headers:{host}},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
      });req.on('error',reject);req.end();
    });
  }
  const manifestAsset=await getAsset('/manifest.webmanifest');
  assert.equal(manifestAsset.status,200);assert.match(manifestAsset.headers['content-type'],/^application\/manifest\+json/);
  assert.equal(manifestAsset.headers['cache-control'],'no-store');assert.match(manifestAsset.headers['content-security-policy'],/manifest-src 'self'/);
  const manifest=JSON.parse(manifestAsset.body);
  assert.equal(manifest.id,'/');assert.equal(manifest.start_url,'/');assert.equal(manifest.scope,'/');assert.equal(manifest.display,'standalone');
  assert.ok(!JSON.stringify(manifest).match(/https?:\/\/|token|claim|code=/));
  for(const icon of [...manifest.icons,{src:'/icons/keyln-180.png',sizes:'180x180'}]){
    const asset=await getAsset(icon.src);assert.equal(asset.status,200);assert.equal(asset.headers['content-type'],'image/png');assert.equal(asset.headers['cache-control'],'no-store');
    assert.equal(asset.body.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.equal(`${asset.body.readUInt32BE(16)}x${asset.body.readUInt32BE(20)}`,icon.sizes);
  }
  assert.equal((await getAsset('/manifest.webmanifest','evil.example')).status,403);
  assert.equal((await getAsset('/icons/private.png')).status,404);
  assert.equal((await getAsset('/sw.js')).status,404);
  // A separately emitted client module must also be present in the static allowlist.
  for (const path of ['/', '/packages/contracts/sizing.js', '/apps/web/app.js', '/apps/web/install.js', '/apps/web/page-refresh.js', '/apps/web/console.js', '/apps/web/editor.js', '/apps/web/app-picker.js', '/apps/web/presentation.js', '/apps/web/icon-paths.js', '/apps/web/layout-tools.js', '/apps/web/page-layout.js', '/apps/web/icon-library.js', '/apps/web/icon-keywords.js', '/apps/web/themes.js', '/apps/web/select-menu.js', '/apps/web/theme-custom.js', '/apps/web/theme-editor.js', ...['state','dom','registry','connection','mode-switch','refresh','settings','system'].map(name=>`/apps/web/widgets/${name}.js`)]) {
    const asset = await new Promise((resolve,reject) => {
      const req=request({hostname:'127.0.0.1',servername:'',port:server.address().port,ca,path,headers:{host:'127.0.0.1:0'}},res=>{
        let body='';res.setEncoding('utf8');res.on('data',chunk=>{body+=chunk;});res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));
      });req.on('error',reject);req.end();
    });
    assert.equal(asset.status,200,path);assert.ok(asset.body.length>100,path);
    if(path==='/') { assert.match(asset.body,/id="system-layer"/); assert.match(asset.body,/<link rel="manifest" href="\/manifest.webmanifest">/); assert.match(asset.headers['content-security-policy'],/img-src 'self' data:/); }
    if(path==='/apps/web/editor.js')assert.match(asset.body,/createConfigurationEditor/);
  }
  let cookie = '';
  function send(path, data = {}, overrides = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', servername: '', port: server.address().port, ca, path, method: 'POST',
        headers: { host: '127.0.0.1:0', origin, 'content-type': 'application/json', 'x-keyln-client': '1', cookie, ...overrides },
      }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(body) }));
      });
      req.on('error', reject); req.end(typeof data === 'string' ? data : JSON.stringify(data));
    });
  }
  assert.equal((await send('/api/configuration')).status, 401);
  assert.equal((await send('/api/apps')).status, 401);
  assert.equal((await send('/api/execute')).status, 401);
  assert.equal((await send('/api/configuration')).status, 401);
  assert.equal((await send('/api/configuration/save')).status, 401);
  assert.equal((await send('/api/echo', {sampleId:randomUUID()})).status, 401);
  assert.equal((await send('/api/pair', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await send('/api/pair', {}, { host: 'evil.example' })).status, 403);
  assert.equal((await send('/api/pair', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await send('/api/pair', {}, { 'x-keyln-client': '' })).status, 403);
  const pair = await send('/api/pair', { code: auth.invite(), name: 'Surface test' });
  assert.equal(pair.status, 202); assert.equal(reportedPair, pair.data.id);
  assert.equal((await send('/api/pair/status', pair.data)).data.approved, false);
  assert.equal((await send('/api/configuration')).status, 401);
  auth.approve(pair.data.id);
  const approved = await send('/api/pair/status', pair.data);
  const setCookie = approved.headers['set-cookie'][0];
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(setCookie.includes(flag));
  cookie = setCookie.split(';')[0];
  assert.equal((await send('/api/configuration')).data.config.revision, 0);
  const sampleId=randomUUID();
  const echoed=await send('/api/echo',{sampleId});assert.equal(echoed.status,200);
  assert.equal(echoed.data.sampleId,sampleId);assert.equal(echoed.data.instanceId,(await send('/api/configuration')).data.instanceId);
  assert.equal((await send('/api/echo',{sampleId,action:'anything'})).status,400);
  assert.equal((await send('/api/echo',{sampleId:'invalid'})).status,400);
  assert.equal((await send('/api/echo',{sampleId},{origin:'https://evil.example'})).status,403);
  assert.equal(called,0);assert.equal(scheduler.busy,false);assert.equal(store.get().revision,0);
  assert.equal((await send('/api/configuration', {}, { origin: '' })).status, 403);
  assert.equal((await send('/api/configuration', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send('/api/configuration', '{broken')).status, 400);
  assert.equal((await send('/api/configuration', { big: 'x'.repeat(17000) })).status, 413);
  const keyOf = (action, label) => withComponents(store.get(), [key('primary', action, {}, { label })]);
  const saveView = (candidate, base = store.get()) => send('/api/configuration/save', saveRequest(base, candidate));
  assert.equal((await saveView(keyOf(expectedActions[0], 'Calculator'))).status, 200);
  assert.equal((await saveView({ ...keyOf(expectedActions[0], 'Stale'), revision: 0 })).status, 409);
  const command = { requestId: randomUUID(), componentId: 'primary', revision: 1 };
  assert.equal((await send('/api/execute', { ...command, command: 'open anything' })).status, 400);
  assert.equal((await send('/api/execute', command)).data.execution.status, 'accepted');
  assert.equal((await send('/api/execute', command)).status, 202);
  const result = await send('/api/result', { requestId: command.requestId });
  assert.equal(result.data.execution.status, 'succeeded'); assert.equal(called, 1);
  assert.equal((await saveView(keyOf(expectedActions[1], 'Shortcut'))).status, 200);
  const keyboardCommand = {...command,requestId:randomUUID(),revision:2};
  assert.equal((await send('/api/execute', keyboardCommand)).data.execution.actionType, 'keyboard.shortcut');
  const keyboardResult = await send('/api/result', {requestId:keyboardCommand.requestId});
  assert.equal(keyboardResult.data.execution.status, 'succeeded'); assert.equal(called, 2);
  const configuration = (await send('/api/configuration')).data.config;
  assert.equal(configuration.format, 'keyln.config'); assert.equal(configuration.version, 2);
  assert.equal((await send('/api/configuration', {}, {origin:'https://evil.example'})).status, 403);
  assert.equal((await send('/api/configuration/save', saveRequest(configuration, configuration), {origin:'https://evil.example'})).status, 403);
  const second = structuredClone(configuration);
  second.widgets[0].pages.push({ id: 'tools', name: 'Tools', widgets: [key('switch-tab', expectedActions[2], { x: 0, y: 2 }, { label: 'Tab', icon: 'bolt' })] });
  const candidate = second;
  const saved = await saveView(candidate, configuration);
  assert.equal(saved.status, 200); assert.equal(saved.data.config.revision, 3);
  assert.equal((await saveView(candidate, configuration)).status, 409, 'the same candidate again was made on revision 2');
  assert.equal((await send('/api/configuration/save', {...saveRequest(saved.data.config, saved.data.config), extra:'secret'})).status, 400);
  assert.equal((await send('/api/configuration/save', {junk:'x'.repeat(MAX_CONFIG_BYTES)})).status, 413);
  assert.equal((await send('/api/execute', {requestId:randomUUID(),componentId:'switch-tab',revision:2})).status, 409);
  const secondPageTrigger = {requestId:randomUUID(),componentId:'switch-tab',revision:3};
  assert.equal((await send('/api/execute', secondPageTrigger)).status, 202);
  assert.equal((await send('/api/result', {requestId:secondPageTrigger.requestId})).data.execution.status, 'succeeded');
  assert.equal(called, 3);
  assert.equal((await send('/api/execute', {requestId:randomUUID(),componentId:'missing',revision:3})).data.error.code, 'BUTTON_UNAVAILABLE');
  const large = structuredClone(saved.data.config); large.widgets[0].pages = [];
  for(let index=0;index<8;index++) large.widgets[0].pages.push({ id: `page-${index}`, name: `Page ${index}`, widgets: Array.from({ length: 12 }, (_, slot) => key(`button-${index}-${slot}`.padEnd(64,'x'),null,{x:slot%4,y:Math.floor(slot/4)},{label:'Button name '.repeat(3)})) });
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 16_384);
  assert.equal((await saveView(large, saved.data.config)).status, 200);
  assert.equal(components((await send('/api/configuration')).data.config).length, 96);
  const freeBase = store.get(), free = structuredClone(freeBase);
  free.widgets[0].pages[0].widgets[0] = {...free.widgets[0].pages[0].widgets[0],size:'L',icon:'folder',appearance:{style:'outline',glyph:{type:'text',text:'AI'}}};
  const freeSaved = await saveView(free, freeBase);
  assert.equal(freeSaved.status,200); assert.equal(freeSaved.data.config.revision,5);
  const exported = (await send('/api/configuration/export')).data.config;
  assert.equal(exported.version,3,'export is the whole v3 document');assert.deepEqual(exported,store.document());assert.deepEqual(viewFor(exported,'Surface'),freeSaved.data.config);
  const obsoleteCoordinates=saveRequest(freeSaved.data.config,freeSaved.data.config),layoutPart=store.document().layouts[0];
  layoutPart.widgets[0].pages[0].widgets[1]={...layoutPart.widgets[0].pages[0].widgets[1],cell:{x:4,y:1}};
  assert.equal((await send('/api/configuration/save',{...obsoleteCoordinates,layout:{gridSize:layoutPart.gridSize,widgets:layoutPart.widgets}})).status,400);
  assert.deepEqual(store.get(),freeSaved.data.config);assert.equal(called,3);
  assert.equal((await send('/api/state')).status,404,'the one-button state route is gone');
  assert.equal((await send('/api/config',{revision:5})).status,404,'the one-button edit route is gone');
  assert.equal((await send('/api/result', { requestId: randomUUID() })).data.error.code, 'RESULT_UNKNOWN');
  assert.equal((await send('/api/admin/approve', { id: pair.data.id })).status, 404);
  auth.revoke(pair.data.id);
  assert.equal((await send('/api/echo',{sampleId:randomUUID()})).status,401);
  assert.equal((await send('/api/configuration')).status, 401);
  assert.equal((await send('/api/result', { requestId: command.requestId })).status, 401);
  assert.equal((await send('/api/execute', { ...command, requestId: randomUUID() })).status, 401);
  assert.equal((await send('/api/configuration')).status, 401);
  assert.equal((await send('/api/configuration/save', saveRequest(freeSaved.data.config, large))).status, 401);
  assert.equal(called, 3);
});
