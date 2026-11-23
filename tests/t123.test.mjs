import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {pathToFileURL} from 'node:url';
import {NODE_PLATFORM,NODE_SHA256,NODE_VERSION,NODE_TEAM,nodeTarball,nodeUrl,installNode,cachedNode} from '../scripts/node-runtime.mjs';
import {prepareService,readService,servicePaths,servicePlist,appBundlePaths} from '../dist/apps/host/service.js';
import {installApp} from '../dist/apps/host/app-service.js';
import {helperPath} from '../dist/apps/host/helper-path.js';

// T123 (ADR-107): self-contained Keyln.app. No launchctl, no real service, no real Node download; every path is a temp directory and an isolated test label.
const LABEL='local.keyln.host.test.1234abcd';
const directory=t=>{const dir=fs.mkdtempSync(join(tmpdir(),'keyln-t123-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const sha=path=>createHash('sha256').update(fs.readFileSync(path)).digest('hex');

test('the Node pin is the official darwin-arm64 tarball with a SHA-256 and the Node.js Foundation team',()=>{
 assert.equal(NODE_VERSION,'v26.13.1');assert.equal(NODE_PLATFORM,'darwin-arm64');assert.match(NODE_SHA256,/^[a-f0-9]{64}$/);assert.equal(NODE_TEAM,'HX7739G8FX');
 assert.equal(nodeTarball(),'node-v26.13.1-darwin-arm64.tar.gz');assert.equal(nodeUrl(),'https://nodejs.org/dist/v26.13.1/node-v26.13.1-darwin-arm64.tar.gz');
 assert.match(fs.readFileSync('.gitignore','utf8'),/^\.cache\/$/m);
});

function fakeTarball(dir,content='#!/bin/sh\necho fake\n'){
 const root=join(dir,'src',`node-${NODE_VERSION}-${NODE_PLATFORM}`);fs.mkdirSync(join(root,'bin'),{recursive:true});fs.writeFileSync(join(root,'bin/node'),content,{mode:0o755});fs.writeFileSync(join(root,'README.md'),'not extracted');
 const file=join(dir,nodeTarball());execFileSync('/usr/bin/tar',['-czf',file,'-C',join(dir,'src'),`node-${NODE_VERSION}-${NODE_PLATFORM}`]);return file;
}
test('node:fetch checks the pinned SHA-256 before extracting and keeps only bin/node',async t=>{
 const dir=directory(t),tarball=fakeTarball(dir),base=join(dir,'repo'),good=sha(tarball);
 await assert.rejects(installNode({tarball,base,verifySignature(){}}),/pinned SHA-256/);assert.equal(fs.existsSync(join(base,'.cache')),false);
 const checked=[];const path=await installNode({tarball,base,sha256:good,verifySignature:p=>checked.push(p)});
 assert.equal(path,cachedNode(base));assert.equal(checked.length,1);assert.ok(fs.statSync(path).mode&0o100);assert.match(fs.readFileSync(path,'utf8'),/fake/);
 assert.deepEqual(fs.readdirSync(join(base,'.cache/node')),[`${NODE_VERSION}-${NODE_PLATFORM}`]);assert.deepEqual(fs.readdirSync(join(base,'.cache/node',`${NODE_VERSION}-${NODE_PLATFORM}`)),['node']);
});
test('node:fetch refuses a binary whose signature check fails and leaves nothing cached',async t=>{
 const dir=directory(t),tarball=fakeTarball(dir),base=join(dir,'repo');
 await assert.rejects(installNode({tarball,base,sha256:sha(tarball)}),/codesign|not signed/);assert.equal(fs.existsSync(cachedNode(base)),false);
 assert.deepEqual(fs.readdirSync(join(base,'.cache/node')),[]);
});
test('the node:fetch command rejects a tarball that does not match the pin, and bad arguments',t=>{
 const dir=directory(t),tarball=fakeTarball(dir);
 const bad=spawnSync(process.execPath,['scripts/node-runtime.mjs','--from',tarball],{encoding:'utf8'});assert.equal(bad.status,1);assert.match(bad.stderr,/pinned SHA-256/);
 assert.equal(spawnSync(process.execPath,['scripts/node-runtime.mjs','--bogus'],{encoding:'utf8'}).status,1);
});

test('the helper is found beside the app runtime inside Keyln.app and in dist everywhere else',()=>{
 const url=path=>pathToFileURL(path).href;
 assert.equal(helperPath(url('/Users/x/Applications/Keyln.app/Contents/Resources/runtime/dist/apps/host/native.js')),'/Users/x/Applications/Keyln.app/Contents/Helpers/keyln-helper');
 assert.equal(helperPath(url('/repo/dist/apps/host/native.js')),'/repo/dist/keyln-helper');
 assert.equal(helperPath(url('/data/Keyln/runtime/dist/apps/host/native.js')),'/data/Keyln/runtime/dist/keyln-helper');
 // Lookalike directories outside a real Contents/Resources/runtime chain keep the dev layout.
 assert.equal(helperPath(url('/a/Resources/runtime/dist/apps/host/native.js')),'/a/Resources/runtime/dist/keyln-helper');
 assert.equal(helperPath(url('/a/Contents/Other/runtime/dist/apps/host/native.js')),'/a/Contents/Other/runtime/dist/keyln-helper');
 assert.ok(!/KEYLN_HELPER/.test(fs.readFileSync('apps/host/helper-path.ts','utf8')),'no environment override');
});

// A bundle shaped like the real one, without the 147 MB Node: enough for manifest, plist and transaction tests.
function fakeApp(dir,marker='A'){
 const app=join(dir,'build/Keyln.app'),{runtime,node,helper}=appBundlePaths(app);fs.rmSync(app,{recursive:true,force:true});
 for(const d of [join(app,'Contents/MacOS'),join(app,'Contents/Helpers'),join(runtime,'dist/apps/host')])fs.mkdirSync(d,{recursive:true});
 fs.writeFileSync(join(app,'Contents/MacOS/Keyln'),'menu');fs.writeFileSync(node,'node');fs.writeFileSync(helper,'helper');fs.writeFileSync(join(runtime,'dist/apps/host/main.js'),marker);
 fs.writeFileSync(join(runtime,'.keyln-runtime.json'),JSON.stringify({schemaVersion:2,kind:'keyln-app-runtime',node:NODE_VERSION}));
 return app;
}
function fixture(t,{legacy=false}={}){
 const dir=directory(t),data=join(dir,'data'),source=join(dir,'source'),target=join(dir,'Applications');
 fs.mkdirSync(join(data,'tls'),{recursive:true,mode:0o700});for(const name of ['host.json','config.json','tls/server.key','tls/server.pem','tls/rootCA.pem'])fs.writeFileSync(join(data,name),'Fixture private data',{mode:0o600});
 const paths=servicePaths(data,LABEL,join(dir,'agents')),app=fakeApp(dir);
 if(legacy){
  for(const name of ['dist/apps/host','dist/packages','node_modules/ws'])fs.mkdirSync(join(source,name),{recursive:true,mode:0o700});
  fs.writeFileSync(join(source,'dist/apps/host/main.js'),'LEGACY');fs.writeFileSync(join(source,'dist/apps/host/service-runner.js'),'x');fs.writeFileSync(join(source,'node_modules/ws/package.json'),'{}');fs.copyFileSync('dist/keyln-helper',join(source,'dist/keyln-helper'));
  prepareService(paths,source);
 }
 return {dir,data,paths,app,target,installed:join(target,'Keyln.app')};
}
const state=(f)=>Object.fromEntries([f.paths.manifest,f.paths.plist,join(f.paths.runtime,'dist/apps/host/main.js'),join(f.installed,'Contents/Resources/runtime/dist/apps/host/main.js'),join(f.target,'.Keyln.app.previous/Contents/Resources/runtime/dist/apps/host/main.js')].map(p=>[p,fs.existsSync(p)?fs.readFileSync(p,'utf8'):null]));
function control(f,initial={loaded:false,enabled:true,running:false},{startFails=false}={}){
 const calls=[];
 return {calls,verify:()=>{},quit:path=>calls.push('quit '+path),state(){calls.push('state');return {...initial};},async stop(){calls.push('stop');},
  async start(){calls.push('start');readService(f.paths);if(startFails)throw new Error('New job failed to start');},async ready(){calls.push('ready');},async restore(paths,prior){calls.push('restore');assert.deepEqual(prior,initial);}};
}

test('schema 2 manifest and schema 1 manifest are both read; anything else is rejected',async t=>{
 const f=fixture(t,{legacy:true}),v1=readService(f.paths);assert.equal(v1.schemaVersion,1);assert.equal(v1.runtime,f.paths.runtime);
 await installApp(f.paths,f.app,f.target,control(f,{loaded:false,enabled:true,running:false}));
 const v2=readService(f.paths),bundle=appBundlePaths(f.installed);
 assert.equal(v2.schemaVersion,2);assert.equal(v2.app,f.installed);assert.equal(v2.node,bundle.node);assert.equal(v2.runtime,bundle.runtime);assert.equal(v2.label,LABEL);
 const original=fs.readFileSync(f.paths.manifest,'utf8'),tamper=change=>{fs.writeFileSync(f.paths.manifest,JSON.stringify({...JSON.parse(original),...change}),{mode:0o600});};
 for(const [name,change] of Object.entries({node:{node:'/opt/homebrew/bin/node'},runtime:{runtime:f.paths.runtime},app:{app:join(f.dir,'Other.app')},relative:{app:'Keyln.app'},schema:{schemaVersion:3},label:{label:'local.keyln.host.test.00000000'},uid:{uid:0},data:{data:join(f.dir,'x')}})){
  tamper(change);assert.throws(()=>readService(f.paths),/does not match/,name);
 }
 tamper({});assert.equal(readService(f.paths).schemaVersion,2);
 fs.writeFileSync(join(bundle.runtime,'.keyln-runtime.json'),JSON.stringify({schemaVersion:1}));assert.throws(()=>readService(f.paths),/sealed runtime/);
});

test('the app LaunchAgent runs the bundled Node and runtime with the same environment and no Homebrew path',t=>{
 const dir=directory(t),paths=servicePaths(join(dir,'Path & space'),LABEL,join(dir,'agents')),bundle=appBundlePaths(join(dir,'Apps/Keyln.app')),path=join(dir,'agent.plist');
 fs.writeFileSync(path,servicePlist(paths,bundle.node,bundle.runtime));const plist=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',path],{encoding:'utf8'}));
 assert.deepEqual(plist.ProgramArguments,[bundle.node,join(bundle.runtime,'dist/apps/host/service-runner.js')]);assert.equal(plist.WorkingDirectory,bundle.runtime);assert.equal(plist.Label,LABEL);
 assert.equal(plist.EnvironmentVariables.KEYLN_DATA_DIR,paths.data);assert.equal(plist.EnvironmentVariables.PATH,'/usr/bin:/bin:/usr/sbin:/sbin');assert.deepEqual(plist.KeepAlive,{SuccessfulExit:false});assert.equal(plist.RunAtLoad,true);assert.equal(plist.LimitLoadToSessionType,'Aqua');
 assert.ok(!JSON.stringify(plist).includes('/opt/homebrew'));
 fs.writeFileSync(path,servicePlist(paths,'/n'));const legacy=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',path],{encoding:'utf8'}));assert.deepEqual(legacy.ProgramArguments,['/n',join(paths.runtime,'dist/apps/host/service-runner.js')]);assert.equal(legacy.WorkingDirectory,paths.runtime);
});

test('app install over the Homebrew-era installation switches manifest and plist and leaves the old runtime untouched',async t=>{
 const f=fixture(t,{legacy:true}),legacyRuntime=join(f.paths.runtime,'dist/apps/host/main.js'),before=fs.readFileSync(legacyRuntime,'utf8'),job=control(f);
 const manifest=await installApp(f.paths,f.app,f.target,job);
 assert.deepEqual(job.calls,['state','stop','quit '+f.installed,'start','ready']);assert.equal(manifest.schemaVersion,2);
 const plist=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',f.paths.plist],{encoding:'utf8'}));assert.equal(plist.ProgramArguments[0],join(f.installed,'Contents/Helpers/node'));assert.ok(!JSON.stringify(plist).includes('/opt/homebrew'));
 assert.equal(fs.readFileSync(legacyRuntime,'utf8'),before);assert.equal(fs.existsSync(f.paths.runtime+'.previous'),false);assert.equal(fs.readFileSync(join(f.installed,'Contents/Resources/runtime/dist/apps/host/main.js'),'utf8'),'A');
 assert.deepEqual(fs.readdirSync(f.target),['Keyln.app']);assert.equal(fs.statSync(f.paths.plist).mode&0o777,0o600);
});

test('a failed start rolls the app, plist and manifest back to the Homebrew-era state',async t=>{
 const f=fixture(t,{legacy:true}),before=state(f),job=control(f,{loaded:true,enabled:true,running:true},{startFails:true});
 await assert.rejects(installApp(f.paths,f.app,f.target,job),/previous files and startup state were preserved or restored/);
 assert.deepEqual(job.calls.slice(-3),['stop','restore','ready']);assert.deepEqual(state(f),before);assert.equal(readService(f.paths).schemaVersion,1);assert.deepEqual(fs.readdirSync(f.target),[]);
 assert.ok(!fs.readdirSync(f.data).some(name=>name.startsWith('runtime-')&&name!=='runtime'));
});

test('a second app install keeps the previous app for rollback and a failed one restores it exactly',async t=>{
 const f=fixture(t);await installApp(f.paths,f.app,f.target,control(f));
 assert.equal(fs.existsSync(f.paths.runtime),false,'a fresh app install creates no data-folder runtime');
 fakeApp(f.dir,'B');await installApp(f.paths,f.app,f.target,control(f));
 assert.equal(fs.readFileSync(join(f.installed,'Contents/Resources/runtime/dist/apps/host/main.js'),'utf8'),'B');assert.equal(fs.readFileSync(join(f.target,'.Keyln.app.previous/Contents/Resources/runtime/dist/apps/host/main.js'),'utf8'),'A');
 fakeApp(f.dir,'C');const before=state(f);
 await assert.rejects(installApp(f.paths,f.app,f.target,control(f,{loaded:true,enabled:true,running:true},{startFails:true})),/restored/);
 assert.deepEqual(state(f),before);assert.deepEqual(fs.readdirSync(f.target).sort(),['.Keyln.app.previous','Keyln.app']);
});

for(const point of ['plist','manifest','swap'])test(`a failure while committing (${point}) restores the exact previous files`,async t=>{
 const f=fixture(t,{legacy:true}),before=state(f),original=fs.renameSync;let fired=false;
 fs.renameSync=(from,to)=>{
  const hit=point==='plist'?String(to)===f.paths.plist:point==='manifest'?String(to)===f.paths.manifest:String(from).includes('.Keyln-install-')&&String(to)===f.installed;
  if(!fired&&hit){fired=true;throw Object.assign(new Error('Injected write failure'),{code:'EACCES'});}return original(from,to);
 };
 syncBuiltinESMExports();t.after(()=>{fs.renameSync=original;syncBuiltinESMExports();});
 await assert.rejects(installApp(f.paths,f.app,f.target,control(f,{loaded:true,enabled:true,running:true})),/Injected write failure/);
 assert.equal(fired,true);assert.deepEqual(state(f),before);assert.deepEqual(fs.readdirSync(f.target),[]);
});

test('staging refuses an app that fails verification before stopping anything',async t=>{
 const f=fixture(t,{legacy:true}),before=state(f),job={...control(f),verify(){throw new Error('Bad signature');}};
 await assert.rejects(installApp(f.paths,f.app,f.target,job),/Bad signature/);assert.deepEqual(job.calls,['state']);assert.deepEqual(state(f),before);assert.deepEqual(fs.readdirSync(f.target),[]);
});

test('the legacy installer still works after an app install, ignores the bundled Node as its default and keeps Keyln.app',async t=>{
 const f=fixture(t);await installApp(f.paths,f.app,f.target,control(f));
 const source=join(f.dir,'source');for(const name of ['dist/apps/host','dist/packages','node_modules/ws'])fs.mkdirSync(join(source,name),{recursive:true,mode:0o700});
 fs.writeFileSync(join(source,'dist/apps/host/main.js'),'LEGACY');fs.writeFileSync(join(source,'dist/apps/host/service-runner.js'),'x');fs.writeFileSync(join(source,'node_modules/ws/package.json'),'{}');fs.copyFileSync('dist/keyln-helper',join(source,'dist/keyln-helper'));
 const manifest=prepareService(f.paths,source);assert.equal(manifest.schemaVersion,1);assert.equal(readService(f.paths).schemaVersion,1);assert.equal(readService(f.paths).node,process.execPath);
 assert.equal(JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',f.paths.plist],{encoding:'utf8'})).ProgramArguments[0],process.execPath);assert.ok(fs.existsSync(join(f.installed,'Contents/MacOS/Keyln')));
 assert.match(fs.readFileSync('apps/host/service-cli.ts','utf8'),/previous\?\.schemaVersion===1/);
});

const bundled=fs.existsSync(cachedNode());
test('app:build produces a sealed bundle that keeps the Node.js Foundation signature',{skip:!bundled&&'Run npm run node:fetch to exercise app:build',timeout:300000},t=>{
 const out=join(directory(t),'Keyln.app');
 execFileSync(process.execPath,['scripts/app-build.mjs','--out',out],{stdio:'pipe'});
 const {node,helper,runtime}=appBundlePaths(out);
 execFileSync('/usr/bin/codesign',['--verify','--strict','--deep',out],{stdio:'pipe'});
 const info=path=>spawnSync('/usr/bin/codesign',['-dv',path],{encoding:'utf8'}).stderr;
 assert.match(info(node),/^TeamIdentifier=HX7739G8FX$/m);assert.match(info(node),/^Identifier=node$/m);assert.match(info(helper),/^Identifier=local\.keyln\.helper$/m);assert.match(info(out),/^Identifier=local\.keyln\.menubar$/m);
 assert.equal(sha(node),sha(cachedNode()),'the Node binary is byte for byte the cached one');
 assert.equal(execFileSync(node,['--version'],{encoding:'utf8'}).trim(),NODE_VERSION);assert.ok(fs.statSync(join(out,'Contents/MacOS/Keyln')).mode&0o100);
 for(const file of ['dist/apps/host/main.js','dist/apps/host/service-runner.js','dist/apps/host/service-entry.js','node_modules/ws/package.json','package.json','.keyln-runtime.json'])assert.ok(fs.existsSync(join(runtime,file)),file);
 assert.equal(fs.existsSync(join(runtime,'dist/keyln-helper')),false,'one helper, in Contents/Helpers');
 assert.deepEqual(JSON.parse(fs.readFileSync(join(runtime,'package.json'),'utf8')),{private:true,type:'module'});
 // The sealed runtime is directly runnable by the bundled Node, and its helper lookup lands on the bundled helper.
 const entry=spawnSync(node,[join(runtime,'dist/apps/host/service-entry.js'),'menu-status'],{encoding:'utf8',env:{KEYLN_DATA_DIR:join(directory(t),'d'),KEYLN_SERVICE_LABEL:LABEL,PATH:'/usr/bin:/bin'}});assert.equal(entry.status,0,entry.stderr);assert.equal(JSON.parse(entry.stdout).installed,false);
 assert.equal(helperPath(pathToFileURL(join(runtime,'dist/apps/host/native.js')).href),helper);
 // The output path must be absolute and end in /Keyln.app.
 assert.equal(spawnSync(process.execPath,['scripts/app-build.mjs','--out','relative/Keyln.app']).status,1);
});
