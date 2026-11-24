import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {readVersion,UNKNOWN_VERSION} from '../dist/apps/host/version.js';
import {appRuntimeOwned} from '../dist/apps/host/service.js';
import {localManagement,requestLocalManagement,hostVersionOf,managementPath} from '../dist/apps/host/local-management.js';
import {dirtyEntries,shaLine,parseShaLine,sha256Hex,zipName,forbiddenPaths,listTree,versionMismatches} from '../scripts/release-lib.mjs';

// T125 (ADR-109): version stamp, Host version over the local socket, release helpers. Short temp paths (Unix socket limit), isolated test label, no real service.
const LABEL='local.keyln.host.test.5a5a5a5a';
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const directory=t=>{const dir=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'k125-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const entry=(args,env={})=>spawnSync(process.execPath,['dist/apps/host/service-entry.js',...args],{encoding:'utf8',timeout:20000,env:{...process.env,KEYLN_SERVICE_LABEL:LABEL,...env}});

test('the build writes package.json\'s version next to the Host and the Host helper reads it',t=>{
 const file=JSON.parse(fs.readFileSync('dist/apps/host/version.json','utf8'));assert.deepEqual(file,{version:pkg.version});
 assert.equal(readVersion(),pkg.version);
 const dir=directory(t);assert.equal(readVersion(dir),UNKNOWN_VERSION);
 for(const bad of ['not json','{}','{"version":3}','{"version":""}','{"version":"1.0 0\\n"}']){fs.writeFileSync(join(dir,'version.json'),bad);assert.equal(readVersion(dir),UNKNOWN_VERSION,bad);}
 fs.writeFileSync(join(dir,'version.json'),'{"version":"2.1.0-rc.1"}\n');assert.equal(readVersion(dir),'2.1.0-rc.1');
});

test('both runtime layouts copy dist/apps whole, so version.json travels with the Host',()=>{
 const build=fs.readFileSync('scripts/build.mjs','utf8'),appBuild=fs.readFileSync('scripts/app-build.mjs','utf8'),service=fs.readFileSync('apps/host/service.ts','utf8');
 assert.match(build,/dist\/apps\/host\/version\.json/);assert.match(appBuild,/cpSync\('dist\/apps'/);assert.match(service,/copyTree\(join\(source,"dist\/apps"\)/);
 assert.match(appBuild,/version: JSON\.parse\(readFileSync\('package\.json'/);
 // Pruning only removes compiled .js / .js.map files with no source, never version.json.
 assert.ok(fs.existsSync('dist/apps/host/version.json'));
});

test('a runtime marker with a version still passes the app runtime validation',t=>{
 const runtime=join(directory(t),'runtime');fs.mkdirSync(runtime,{mode:0o700});
 fs.writeFileSync(join(runtime,'.keyln-runtime.json'),JSON.stringify({schemaVersion:2,kind:'keyln-app-runtime',node:'v26.13.1',version:pkg.version}));
 appRuntimeOwned(runtime);
 fs.writeFileSync(join(runtime,'.keyln-runtime.json'),JSON.stringify({schemaVersion:2,kind:'keyln-app-runtime'}));appRuntimeOwned(runtime); // markers from T123 builds
 fs.writeFileSync(join(runtime,'.keyln-runtime.json'),JSON.stringify({schemaVersion:2,kind:'other',version:pkg.version}));assert.throws(()=>appRuntimeOwned(runtime),/not a recognized sealed runtime/);
});

test('the local management socket answers version with the Host version and pid, and admin/doctor are unchanged',async t=>{
 const dir=join(directory(t),'d'),admin={invite:()=>'code-1'};
 const close=await localManagement(dir,admin,'https://127.0.0.1:8940',async()=>({ok:true}),'9.8.7');t.after(()=>close());
 assert.deepEqual(await requestLocalManagement(dir,'version'),{version:'9.8.7',pid:process.pid});
 assert.equal(await hostVersionOf(dir),'9.8.7');
 assert.deepEqual(await requestLocalManagement(dir,'admin'),{origin:'https://127.0.0.1:8940',code:'code-1',expiresInSeconds:120});
 const doctor=await requestLocalManagement(dir,'doctor');assert.equal(doctor.origin,'https://127.0.0.1:8940');assert.deepEqual(doctor.diagnostics,{ok:true});
 // Without a version argument a Host reports "unknown" rather than guessing.
 const other=join(directory(t),'d'),closeOther=await localManagement(other,admin,'https://127.0.0.1:8940',async()=>({}));t.after(()=>closeOther());
 assert.equal((await requestLocalManagement(other,'version')).version,'unknown');
});

test('hostVersionOf says "unknown" for a Host that rejects the command, stays silent, or is not there; it never throws',async t=>{
 const dir=join(directory(t),'d');fs.mkdirSync(dir,{mode:0o700});
 assert.equal(await hostVersionOf(dir),'unknown'); // no socket at all
 // An older Host: it destroys the connection on any command it does not know.
 const old=net.createServer(socket=>{socket.on('data',()=>socket.destroy());socket.on('error',()=>{});});
 await new Promise(resolve=>old.listen(managementPath(dir),resolve));fs.chmodSync(managementPath(dir),0o600);
 assert.equal(await hostVersionOf(dir),'unknown');await new Promise(resolve=>old.close(resolve));fs.rmSync(managementPath(dir),{force:true});
 // A Host that accepts and never answers: the short timeout decides.
 const held=new Set(),mute=net.createServer(socket=>{held.add(socket);socket.on('data',()=>{});socket.on('error',()=>{});});
 await new Promise(resolve=>mute.listen(managementPath(dir),resolve));fs.chmodSync(managementPath(dir),0o600);
 const started=Date.now();assert.equal(await hostVersionOf(dir,300),'unknown');assert.ok(Date.now()-started<3000);
 for(const socket of held)socket.destroy();await new Promise(resolve=>mute.close(resolve));
});

test('menu-status reports hostVersion null when the service is not running, with and without --doctor, and setup-info carries appVersion',t=>{
 const data=directory(t);
 for(const args of [['menu-status'],['menu-status','--doctor']]){const result=entry(args,{KEYLN_DATA_DIR:data});assert.equal(result.status,0,result.stderr);const status=JSON.parse(result.stdout);assert.equal(status.running,false);assert.equal(status.hostVersion,null);}
 const info=entry(['setup-info'],{KEYLN_DATA_DIR:data});assert.equal(info.status,0,info.stderr);assert.equal(JSON.parse(info.stdout).appVersion,pkg.version);
});

test('release helpers: checksum line, dirty-tree parsing, version agreement',()=>{
 const hex=sha256Hex(Buffer.from('keyln'));assert.match(hex,/^[0-9a-f]{64}$/);
 assert.equal(shaLine(hex,zipName('1.2.3')),`${hex}  Keyln-1.2.3.zip\n`);
 assert.deepEqual(parseShaLine(shaLine(hex,'Keyln-1.2.3.zip')),{hex,name:'Keyln-1.2.3.zip'});
 for(const bad of [`${hex} Keyln.zip\n`,`${hex.toUpperCase()}  Keyln.zip\n`,`${hex}  Keyln.zip`,`${hex}  dir/Keyln.zip\n`,'abc  Keyln.zip\n',''])assert.equal(parseShaLine(bad),null,bad);
 assert.deepEqual(dirtyEntries(''),[]);assert.deepEqual(dirtyEntries('\n'),[]);
 assert.deepEqual(dirtyEntries(' M scripts/build.mjs\n?? tests/new.mjs\nA  x.ts\n!! dist/\n'),[' M scripts/build.mjs','?? tests/new.mjs','A  x.ts']);
 assert.deepEqual(versionMismatches({a:'1.0.0',b:'1.0.0',c:'1.0.0'}),[]);
 assert.deepEqual(versionMismatches({'package.json':'1.0.1','Info.plist':'1.0.0'}),['package.json="1.0.1"','Info.plist="1.0.0"']);
 assert.equal(versionMismatches({a:'1.0.0',b:undefined}).length,2);assert.equal(versionMismatches({a:'',b:''}).length,2);
});

test('the forbidden-content scan flags keys, certificates, device and host records, env files, private docs and git data',t=>{
 const bad=['Keyln.app/Contents/Resources/tls/server.key','a/rootCA.pem','a/rootCA-copy.cer','x/id.p12','Keyln.app/Contents/devices.json','host.json','a/.env','a/.env.local','Keyln_private/Docs/x.md','a/.git/config','.git','a/b/Keyln_private'];
 assert.deepEqual(forbiddenPaths(bad),bad);
 const good=['Keyln.app','Keyln.app/Contents/Helpers/node','Keyln.app/Contents/Resources/runtime/dist/apps/host/host-info.js','Keyln.app/Contents/Resources/AppIcon.icns','a/.gitignore','a/environment.js','a/monkey.js','a/pemkey.txt','a/hosts.json'];
 assert.deepEqual(forbiddenPaths(good),[]);
 const root=directory(t);fs.mkdirSync(join(root,'A/.git'),{recursive:true});fs.writeFileSync(join(root,'A/ok.txt'),'x');fs.writeFileSync(join(root,'A/.git/HEAD'),'x');fs.writeFileSync(join(root,'A/secret.key'),'x');
 assert.deepEqual(listTree(root).sort(),['A','A/.git','A/.git/HEAD','A/ok.txt','A/secret.key']);assert.deepEqual(forbiddenPaths(listTree(root)).sort(),['A/.git','A/.git/HEAD','A/secret.key']);
});

test('the release script is wired as specified and never publishes anything',()=>{
 assert.equal(pkg.scripts['app:release'],'npm run build && node scripts/app-build.mjs && node scripts/app-release.mjs');
 const source=fs.readFileSync('scripts/app-release.mjs','utf8');
 assert.match(source,/'-c', '-k', '--sequesterRsrc', '--keepParent'/);assert.match(source,/--allow-dirty/);
 const git=[...source.matchAll(/'\/usr\/bin\/git', \['([a-z-]+)'/g)].map(m=>m[1]);assert.deepEqual(git.sort(),['rev-parse','status'],'only reads git state');assert.ok(!/\bfetch\(|\bhttps?:|\bgh\b/.test(source),'no network or GitHub');
 const usage=spawnSync(process.execPath,['scripts/app-release.mjs','--bogus'],{encoding:'utf8'});assert.equal(usage.status,1);assert.match(usage.stderr,/Usage/);
});
