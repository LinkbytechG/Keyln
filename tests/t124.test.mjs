import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {OPENSSL,candidateAddresses,runSetup,readHostSettings,validateAddress} from '../dist/apps/host/setup.js';
import {servicePaths,appBundlePaths,readService,readServiceLenient} from '../dist/apps/host/service.js';
import {adoptApp,selfApp,classifyAppPath} from '../dist/apps/host/app-service.js';
import {changeAddress,exportCertificate,setupInfo} from '../dist/apps/host/first-run.js';

// T124 (ADR-108): first run and self-install. No launchctl writes, no real service, no real data folder: every path is a temp directory and an isolated test label.
const LABEL='local.keyln.host.test.1234abcd';
const directory=t=>{const dir=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'keyln-t124-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>resolve(port));});});
const entry=(args,env={})=>spawnSync(process.execPath,['dist/apps/host/service-entry.js',...args],{encoding:'utf8',timeout:20000,env:{...process.env,KEYLN_SERVICE_LABEL:LABEL,...env}});
const FAKE={en9:[{address:'10.9.8.7',family:'IPv4',internal:false,netmask:'255.0.0.0',mac:'',cidr:null}]};

test('setup uses the system OpenSSL, verifies with Node, reuses the CA and keeps private modes',async t=>{
 assert.equal(OPENSSL,'/usr/bin/openssl');
 const data=join(directory(t),'d'),port=await freePort();
 const first=await runSetup({data,address:'127.0.0.1',port});
 assert.equal(first.origin,`https://127.0.0.1:${port}`);
 const ca=new X509Certificate(fs.readFileSync(join(data,'tls/rootCA.pem'))),server=new X509Certificate(fs.readFileSync(join(data,'tls/server.pem')));
 assert.ok(server.verify(ca.publicKey));assert.equal(server.checkIP('127.0.0.1'),'127.0.0.1');assert.equal(server.checkIP('10.1.1.1'),undefined);assert.equal(first.caFingerprint,ca.fingerprint256);
 assert.match(ca.fingerprint256,/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);assert.equal(ca.subject,'CN=Keyln Local CA');assert.ok(ca.ca);
 assert.deepEqual(readHostSettings(data),{schemaVersion:1,address:'127.0.0.1',port,origin:first.origin});
 const mode=p=>fs.statSync(join(data,p)).mode&0o777;
 assert.equal(mode('.'),0o700);assert.equal(mode('tls'),0o700);for(const f of ['host.json','tls/rootCA.key','tls/rootCA.pem','tls/server.key','tls/server.pem'])assert.equal(mode(f),0o600,f);
 assert.deepEqual(fs.readdirSync(join(data,'tls')).filter(n=>n.startsWith('setup-')),[]);
 const caBytes=fs.readFileSync(join(data,'tls/rootCA.pem')),keyBytes=fs.readFileSync(join(data,'tls/rootCA.key')),serverBytes=fs.readFileSync(join(data,'tls/server.pem'));
 const again=await runSetup({data,address:'127.0.0.1'}); // no port: the configured one stays
 assert.equal(again.port,port);assert.deepEqual(fs.readFileSync(join(data,'tls/rootCA.pem')),caBytes);assert.deepEqual(fs.readFileSync(join(data,'tls/rootCA.key')),keyBytes);assert.notDeepEqual(fs.readFileSync(join(data,'tls/server.pem')),serverBytes);
 assert.equal(again.caFingerprint,first.caFingerprint);
 // A private address assigned to this Mac (simulated interface list) gets a certificate for exactly that address.
 const other=await runSetup({data,address:'10.9.8.7',port,interfaces:FAKE,checkPort:false});
 const renewed=new X509Certificate(fs.readFileSync(join(data,'tls/server.pem')));assert.ok(renewed.verify(ca.publicKey));assert.equal(renewed.checkIP('10.9.8.7'),'10.9.8.7');assert.equal(other.origin,`https://10.9.8.7:${port}`);
});

test('setup rejects public, unassigned, wildcard and malformed addresses and ports, and an incomplete CA',async t=>{
 const data=join(directory(t),'d');
 for(const address of ['8.8.8.8','0.0.0.0','192.168.254.253','10.9.8.7','::1','localhost','',undefined])await assert.rejects(runSetup({data,address,port:8940,checkPort:false}),/private IPv4 address assigned to this Mac/,String(address));
 for(const port of [80,1023,65536,8940.5,NaN,'8940'])await assert.rejects(runSetup({data,address:'127.0.0.1',port,checkPort:false}),/Port must be 1024/,String(port));
 assert.equal(fs.existsSync(join(data,'host.json')),false);assert.throws(()=>validateAddress('172.32.0.1',{x:[{address:'172.32.0.1',family:'IPv4',internal:false}]}),/private IPv4/);
 await runSetup({data,address:'127.0.0.1',port:await freePort(),checkPort:false});fs.rmSync(join(data,'tls/rootCA.key'));
 await assert.rejects(runSetup({data,address:'127.0.0.1',checkPort:false}),/Incomplete CA files/);
});

test('setup refuses a port that is in use, and while host.lock exists',async t=>{
 const data=join(directory(t),'d'),holder=net.createServer(),port=await new Promise(r=>holder.listen(0,'127.0.0.1',()=>r(holder.address().port)));t.after(()=>holder.close());
 await assert.rejects(runSetup({data,address:'127.0.0.1',port}),/already in use/);assert.equal(fs.existsSync(join(data,'host.json')),false);
 const free=await freePort();fs.mkdirSync(data,{recursive:true,mode:0o700});fs.writeFileSync(join(data,'host.lock'),String(process.pid),{mode:0o600});
 await assert.rejects(runSetup({data,address:'127.0.0.1',port:free}),/Stop Host/);assert.equal(fs.existsSync(join(data,'host.json')),false);
});

test('candidate addresses are private IPv4 on this Mac, loopback last',()=>{
 const fake={en0:[{address:'192.168.1.20',family:'IPv4',internal:false},{address:'fe80::1',family:'IPv6',internal:false}],en1:[{address:'8.8.4.4',family:'IPv4',internal:false}],utun1:[{address:'169.254.9.9',family:'IPv4',internal:false}],en2:[{address:'172.20.1.1',family:'IPv4',internal:false},{address:'192.168.1.20',family:'IPv4',internal:false}],lo0:[{address:'127.0.0.1',family:'IPv4',internal:true}]};
 assert.deepEqual(candidateAddresses(fake),[{interface:'en0',address:'192.168.1.20'},{interface:'en2',address:'172.20.1.1'},{interface:'lo0',address:'127.0.0.1'}]);
});

test('the app location is derived from the runtime path and flagged when it cannot be installed',()=>{
 const run=app=>`${app}/Contents/Resources/runtime/dist/apps/host/service-entry.js`;
 assert.deepEqual(selfApp(pathToFileURL(run('/Users/x/Applications/Keyln.app')).href),{app:'/Users/x/Applications/Keyln.app',problem:null});
 assert.deepEqual(selfApp(run('/Applications/Keyln.app')),{app:'/Applications/Keyln.app',problem:null});
 assert.deepEqual(selfApp(run('/private/var/folders/ab/AppTranslocation/1234-ABCD/d/Keyln.app')).problem,'translocated');
 assert.equal(selfApp(run('/Volumes/Keyln 1.0/Keyln.app')).problem,'volume');
 assert.equal(selfApp(run('/Applications/Keyln copy.app')).problem,'renamed');
 for(const path of ['/repo/dist/apps/host/service-entry.js','/data/Keyln/runtime/dist/apps/host/service-entry.js','/a/Keyln.app/Contents/Other/runtime/dist/apps/host/service-entry.js','/a/Resources/runtime/dist/apps/host/service-entry.js'])assert.deepEqual(selfApp(path),{app:null,problem:'not-bundled'},path);
 assert.equal(classifyAppPath('relative/Keyln.app'),'not-bundled');assert.equal(classifyAppPath('/Applications/Keyln.app'),null);
});

test('setup-info reports an unconfigured data folder from a development runtime',t=>{
 const data=directory(t),result=entry(['setup-info'],{KEYLN_DATA_DIR:data});assert.equal(result.status,0,result.stderr);
 const info=JSON.parse(result.stdout);
 assert.equal(info.configured,false);assert.equal(info.address,null);assert.equal(info.port,null);assert.equal(info.origin,null);assert.equal(info.caFingerprint,null);
 assert.equal(info.selfApp,null);assert.equal(info.selfAppProblem,'not-bundled');assert.equal(info.manifestApp,null);assert.equal(info.layout,null);assert.equal(info.running,false);assert.equal(info.manifestMatchesSelf,false);
 assert.ok(info.candidates.length>=1);assert.deepEqual(info.candidates.at(-1),{interface:'lo0',address:'127.0.0.1'});for(const c of info.candidates)assert.deepEqual(Object.keys(c),['interface','address']);
 assert.deepEqual(fs.readdirSync(data),[]);
});

test('setup and setup-info through the command line, and from an app-shaped runtime',async t=>{
 const root=directory(t),data=join(root,'data'),port=await freePort();fs.mkdirSync(data,{mode:0o700});
 const done=entry(['setup','--address','127.0.0.1','--port',String(port)],{KEYLN_DATA_DIR:data});assert.equal(done.status,0,done.stderr);
 const result=JSON.parse(done.stdout);assert.deepEqual(Object.keys(result).sort(),['caFingerprint','origin']);assert.equal(result.origin,`https://127.0.0.1:${port}`);
 // Copy the compiled runtime into app-shaped folders; the entry decides from where it was started.
 const shaped=(...parts)=>{const app=join(root,...parts,'Keyln.app'),runtime=join(app,'Contents/Resources/runtime');fs.mkdirSync(join(runtime,'dist'),{recursive:true});
  fs.cpSync('dist/apps',join(runtime,'dist/apps'),{recursive:true});fs.cpSync('dist/packages',join(runtime,'dist/packages'),{recursive:true});fs.cpSync('node_modules/ws',join(runtime,'node_modules/ws'),{recursive:true});fs.writeFileSync(join(runtime,'package.json'),'{"private":true,"type":"module"}');return {app,entry:join(runtime,'dist/apps/host/service-entry.js')};};
 const run=(file,args)=>spawnSync(process.execPath,[file,...args],{encoding:'utf8',timeout:20000,env:{...process.env,KEYLN_SERVICE_LABEL:LABEL,KEYLN_DATA_DIR:data}});
 const good=shaped('Applications'),info=JSON.parse(run(good.entry,['setup-info']).stdout);
 assert.equal(info.configured,true);assert.equal(info.origin,result.origin);assert.equal(info.port,port);assert.equal(info.caFingerprint,result.caFingerprint);assert.equal(info.selfApp,good.app);assert.equal(info.selfAppProblem,null);assert.equal(info.layout,null);assert.equal(info.running,false);
 const moved=shaped('AppTranslocation','XYZ','d'),bad=JSON.parse(run(moved.entry,['setup-info']).stdout);assert.equal(bad.selfApp,moved.app);assert.equal(bad.selfAppProblem,'translocated');
 // install-self refuses a translocated app before any service query, and takes no arguments.
 const refused=run(moved.entry,['install-self']);assert.equal(refused.status,1);assert.match(refused.stderr,/temporary location/);assert.equal(fs.existsSync(join(data,'service.json')),false);
 const dev=entry(['install-self'],{KEYLN_DATA_DIR:data});assert.equal(dev.status,1);assert.match(dev.stderr,/not running from an app bundle/);
 for(const args of [['install-self','--node','/bin/sh'],['install-self','/tmp/Keyln.app'],['setup-info','x']]){const r=entry(args,{KEYLN_DATA_DIR:data});assert.equal(r.status,1,args.join(' '));assert.match(r.stderr,/does not take arguments/);}
 // A manifest that points at another place is reported, not trusted.
 fs.writeFileSync(join(data,'service.json'),JSON.stringify({schemaVersion:2,app:'/Somewhere/Keyln.app'}),{mode:0o600});
 const stale=JSON.parse(run(good.entry,['setup-info']).stdout);assert.equal(stale.layout,'app');assert.equal(stale.manifestApp,'/Somewhere/Keyln.app');assert.equal(stale.manifestMatchesSelf,false);
 fs.writeFileSync(join(data,'service.json'),JSON.stringify({schemaVersion:2,app:good.app}),{mode:0o600});assert.equal(JSON.parse(run(good.entry,['setup-info']).stdout).manifestMatchesSelf,true);
 fs.writeFileSync(join(data,'service.json'),JSON.stringify({schemaVersion:1}),{mode:0o600});assert.equal(JSON.parse(run(good.entry,['setup-info']).stdout).layout,'legacy');
 // The unmodified rules of the command: bad addresses and missing arguments are one-line errors.
 for(const args of [['setup'],['setup','--address','8.8.8.8'],['setup','--address','127.0.0.1','--bogus','1'],['change-address','--port','9000']]){const r=entry(args,{KEYLN_DATA_DIR:data});assert.equal(r.status,1,args.join(' '));assert.equal(r.stderr.trim().split('\n').length,1);}
});

test('the whitelist still rejects install, uninstall and any command that could take a path or Node',t=>{
 const data=directory(t);
 for(const command of ['install','uninstall','install-app','adopt','service','node']){const r=entry([command,'--node','/bin/sh'],{KEYLN_DATA_DIR:data});assert.equal(r.status,1,command);assert.match(r.stderr,/Unsupported command/);assert.equal(r.stdout,'');}
 assert.deepEqual(fs.readdirSync(data),[]);
});

// A bundle shaped like the real one, without the 147 MB Node: enough for manifest, plist and transaction tests.
function fakeApp(dir,name='build'){
 const app=join(dir,name,'Keyln.app'),{runtime,node,helper}=appBundlePaths(app);
 for(const d of [join(app,'Contents/MacOS'),join(app,'Contents/Helpers'),join(runtime,'dist/apps/host')])fs.mkdirSync(d,{recursive:true});
 fs.writeFileSync(join(app,'Contents/MacOS/Keyln'),'menu');fs.writeFileSync(node,'node');fs.writeFileSync(helper,'helper');fs.writeFileSync(join(runtime,'dist/apps/host/main.js'),'x');
 fs.writeFileSync(join(runtime,'.keyln-runtime.json'),JSON.stringify({schemaVersion:2,kind:'keyln-app-runtime'}));return app;
}
async function configured(t,{setup=true}={}){
 const dir=directory(t),data=join(dir,'data');fs.mkdirSync(data,{mode:0o700});
 if(setup)await runSetup({data,address:'127.0.0.1',port:await freePort(),checkPort:false});
 return {dir,data,paths:servicePaths(data,LABEL,join(dir,'agents'))};
}
function control(f,{running=false,startFails=false}={}){
 const calls=[],initial={loaded:running,enabled:true,running};
 return {calls,verify:()=>{},quit(){throw new Error('quit must not be called');},state(){calls.push('state');return {...initial};},async stop(){calls.push('stop');},
  async start(){calls.push('start');if(startFails&&calls.filter(c=>c==='start').length===1)throw new Error('New job failed to start');},async ready(){calls.push('ready');},async restore(paths,prior){calls.push('restore');assert.deepEqual(prior,initial);}};
}
const snapshot=f=>Object.fromEntries([f.paths.manifest,f.paths.plist].map(p=>[p,fs.existsSync(p)?fs.readFileSync(p):null]));
const plistOf=path=>JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',path],{encoding:'utf8'}));

test('install-self adopts the running app in place: manifest v2, plist, no copy, legacy runtime untouched',async t=>{
 const f=await configured(t),app=fakeApp(f.dir),job=control(f);
 fs.mkdirSync(f.paths.runtime,{recursive:true});fs.writeFileSync(join(f.paths.runtime,'legacy.txt'),'old');
 const before=fs.readdirSync(dirname(app));
 const manifest=await adoptApp(f.paths,app,job);
 assert.deepEqual(job.calls,['state','start','ready']);assert.equal(manifest.schemaVersion,2);assert.equal(manifest.app,app);
 const bundle=appBundlePaths(app),saved=readService(f.paths);assert.equal(saved.app,app);assert.equal(saved.node,bundle.node);assert.equal(saved.runtime,bundle.runtime);
 const plist=plistOf(f.paths.plist);assert.deepEqual(plist.ProgramArguments,[bundle.node,join(bundle.runtime,'dist/apps/host/service-runner.js')]);assert.equal(plist.Label,LABEL);assert.equal(plist.EnvironmentVariables.KEYLN_DATA_DIR,f.data);
 assert.deepEqual(fs.readdirSync(dirname(app)),before,'nothing was copied or left beside the app');assert.equal(fs.readFileSync(join(f.paths.runtime,'legacy.txt'),'utf8'),'old');
 assert.deepEqual(fs.readdirSync(dirname(f.paths.plist)),[LABEL+'.plist']);assert.equal(fs.statSync(f.paths.plist).mode&0o777,0o600);assert.equal(fs.statSync(f.paths.manifest).mode&0o777,0o600);
 // Repeating it from the same place is a clean no-op in effect, and stops the running job first.
 const again=control(f,{running:true});await adoptApp(f.paths,app,again);assert.deepEqual(again.calls,['state','stop','start','ready']);
});

test('install-self over a service whose app was moved: the broken manifest is read leniently, then replaced',async t=>{
 const f=await configured(t),old=fakeApp(f.dir,'old');await adoptApp(f.paths,old,control(f));
 const moved=join(f.dir,'new');fs.renameSync(join(f.dir,'old'),moved);const app=join(moved,'Keyln.app');
 assert.throws(()=>readService(f.paths));assert.equal(readServiceLenient(f.paths).app,old);
 const job=control(f,{running:true});await adoptApp(f.paths,app,job);assert.deepEqual(job.calls,['state','stop','start','ready']);assert.equal(readService(f.paths).app,app);
 fs.writeFileSync(f.paths.manifest,JSON.stringify({...JSON.parse(fs.readFileSync(f.paths.manifest,'utf8')),label:'local.keyln.host.test.00000000'}));
 assert.throws(()=>readServiceLenient(f.paths),/does not match/);
});

test('a failed start rolls the plist and manifest back byte for byte',async t=>{
 const f=await configured(t),first=fakeApp(f.dir,'one');await adoptApp(f.paths,first,control(f));
 const before=snapshot(f),second=fakeApp(f.dir,'two'),job=control(f,{running:true,startFails:true});
 await assert.rejects(adoptApp(f.paths,second,job),/previous files and startup state were preserved or restored/);
 assert.deepEqual(job.calls,['state','stop','start','stop','restore','ready']);assert.deepEqual(snapshot(f),before);assert.equal(readService(f.paths).app,first);
 assert.deepEqual(fs.readdirSync(dirname(f.paths.plist)),[LABEL+'.plist']);
 // First installation failing leaves neither file behind.
 const g=await configured(t),third=fakeApp(g.dir);
 await assert.rejects(adoptApp(g.paths,third,control(g,{startFails:true})),/restored/);assert.equal(fs.existsSync(g.paths.manifest),false);assert.equal(fs.existsSync(g.paths.plist),false);
});

test('install-self refuses without host.json, for translocated or volume paths, and before any lifecycle call',async t=>{
 const f=await configured(t,{setup:false}),app=fakeApp(f.dir),job=control(f);
 await assert.rejects(adoptApp(f.paths,app,job),/Set up the address and certificates first/);assert.equal(fs.existsSync(f.paths.manifest),false);assert.equal(fs.existsSync(f.paths.plist),false);
 const g=await configured(t),translocated=fakeApp(g.dir,'AppTranslocation/ABC/d'),gate=control(g);
 await assert.rejects(adoptApp(g.paths,translocated,gate),/temporary location/);assert.deepEqual(gate.calls,[]);
 await assert.rejects(adoptApp(g.paths,'/Volumes/Keyln/Keyln.app',gate),/disk image or another volume/);await assert.rejects(adoptApp(g.paths,join(g.dir,'x/Keyln Copy.app'),gate),/named Keyln\.app/);assert.deepEqual(gate.calls,[]);
 assert.equal(fs.existsSync(g.paths.manifest),false);
 // An unrecognized LaunchAgent is preserved.
 fs.mkdirSync(dirname(g.paths.plist),{recursive:true,mode:0o700});fs.writeFileSync(g.paths.plist,'foreign',{mode:0o600});
 await assert.rejects(adoptApp(g.paths,fakeApp(g.dir,'ok'),control(g)),/unrecognized LaunchAgent/);assert.equal(fs.readFileSync(g.paths.plist,'utf8'),'foreign');
});

test('setup-info on a configured folder with a real manifest says the app matches itself',async t=>{
 const f=await configured(t),app=fakeApp(f.dir);await adoptApp(f.paths,app,control(f));
 const run=url=>setupInfo(f.paths,url),good=pathToFileURL(join(appBundlePaths(app).runtime,'dist/apps/host/service-entry.js')).href;
 const info=run(good);assert.equal(info.layout,'app');assert.equal(info.manifestApp,app);assert.equal(info.manifestMatchesSelf,true);assert.equal(info.selfApp,app);
 const other=pathToFileURL(join(appBundlePaths(join(f.dir,'elsewhere/Keyln.app')).runtime,'dist/apps/host/service-entry.js')).href;
 const away=run(other);assert.equal(away.manifestMatchesSelf,false);assert.equal(away.selfAppProblem,null);
});

test('change-address stops, sets up, restarts, keeps the CA and says devices must re-pair',async t=>{
 const f=await configured(t),port=await freePort(),next=await freePort();
 await runSetup({data:f.data,address:'127.0.0.1',port,checkPort:false});fs.writeFileSync(f.paths.manifest,'{}');
 const ca=fs.readFileSync(join(f.data,'tls/rootCA.pem')),job=control(f,{running:true});
 const done=await changeAddress(f.paths,{address:'127.0.0.1',port:next},job);
 assert.deepEqual(job.calls,['state','stop','start','ready']);assert.equal(done.origin,`https://127.0.0.1:${next}`);assert.equal(done.repairRequired,true);assert.match(done.note,/paired again/);assert.equal(readHostSettings(f.data).port,next);assert.deepEqual(fs.readFileSync(join(f.data,'tls/rootCA.pem')),ca);
 const idle=control(f,{running:false});await changeAddress(f.paths,{address:'127.0.0.1',port},idle);assert.deepEqual(idle.calls,['state'],'a stopped service stays stopped');assert.equal(readHostSettings(f.data).port,port);
});

test('change-address restarts the previous service unchanged when setup fails or the new one does not start',async t=>{
 const f=await configured(t);fs.writeFileSync(f.paths.manifest,'{}');
 const files=['host.json','tls/server.key','tls/server.pem','tls/rootCA.pem','tls/rootCA.key'],read=()=>files.map(n=>fs.readFileSync(join(f.data,n)));const before=read();
 const job=control(f,{running:true});
 await assert.rejects(changeAddress(f.paths,{address:'8.8.8.8',port:9000},job),/private IPv4 address assigned/);
 assert.deepEqual(job.calls,['state','stop','start','ready']);assert.deepEqual(read(),before);
 const holder=net.createServer(),busy=await new Promise(r=>holder.listen(0,'127.0.0.1',()=>r(holder.address().port)));t.after(()=>holder.close());
 const second=control(f,{running:true});await assert.rejects(changeAddress(f.paths,{address:'127.0.0.1',port:busy},second),/already in use/);assert.deepEqual(second.calls,['state','stop','start','ready']);assert.deepEqual(read(),before);
 const failing=control(f,{running:true,startFails:true});
 await assert.rejects(changeAddress(f.paths,{address:'127.0.0.1',port:await freePort()},failing),/previous address was restored/);
 assert.deepEqual(failing.calls,['state','stop','start','stop','start','ready']);assert.deepEqual(read(),before);
});

test('export-certificate writes only the public CA as DER and refuses unsafe targets',async t=>{
 const f=await configured(t),out=join(f.dir,'keyln-root.cer'),info=exportCertificate(f.data,out);
 const der=fs.readFileSync(out),ca=new X509Certificate(fs.readFileSync(join(f.data,'tls/rootCA.pem')));
 assert.equal(info.path,out);assert.equal(info.fingerprint,ca.fingerprint256);assert.deepEqual(der,ca.raw);assert.equal(new X509Certificate(der).fingerprint256,ca.fingerprint256);
 assert.equal(fs.statSync(out).mode&0o777,0o644);assert.ok(!der.toString('latin1').includes('PRIVATE KEY')&&!der.toString('latin1').includes('BEGIN'));
 const key=fs.readFileSync(join(f.data,'tls/rootCA.key')),serverKey=fs.readFileSync(join(f.data,'tls/server.key'));for(const secret of [key,serverKey])assert.equal(der.includes(secret.subarray(40,120)),false);
 assert.deepEqual(fs.readdirSync(f.dir).filter(n=>n.endsWith('.tmp')),[]);
 for(const bad of [join(f.data,'keyln-root.cer'),join(f.data,'tls/root.cer'),join(f.data,'tls/rootCA.pem.cer'),join(f.data,'host.json')])assert.throws(()=>exportCertificate(f.data,bad),/outside the Keyln data folder|ending in \.cer/,bad);
 fs.symlinkSync(f.data,join(f.dir,'link'));assert.throws(()=>exportCertificate(f.data,join(f.dir,'link/via.cer')),/outside the Keyln data folder/);
 for(const bad of [join(f.dir,'a.pem'),join(f.dir,'a.cer.txt'),'relative.cer',join(f.dir,'missing/a.cer')])assert.throws(()=>exportCertificate(f.data,bad),/ending in \.cer|ENOENT/,bad);
 fs.mkdirSync(join(f.dir,'folder.cer'));assert.throws(()=>exportCertificate(f.data,join(f.dir,'folder.cer')),/folder/);
 assert.equal(fs.readdirSync(f.data).includes('keyln-root.cer'),false);
 // Overwriting an earlier export is allowed, and through the command line the output is one JSON line.
 const cli=entry(['export-certificate','--out',join(f.dir,'again.cer')],{KEYLN_DATA_DIR:f.data});assert.equal(cli.status,0,cli.stderr);assert.deepEqual(Object.keys(JSON.parse(cli.stdout)).sort(),['fingerprint','path']);
 assert.equal(entry(['export-certificate'],{KEYLN_DATA_DIR:f.data}).status,1);assert.equal(entry(['export-certificate','--out',join(f.data,'x.cer')],{KEYLN_DATA_DIR:f.data}).status,1);
 const source=fs.readFileSync('apps/host/first-run.ts','utf8'),exportBody=source.slice(source.indexOf('export function exportCertificate'));assert.ok(!/rootCA\.key|server\.key/.test(exportBody));
});
