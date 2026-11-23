import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,readdirSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

// T120 (ADR-104): the menu bar app shell. Nothing here starts, stops or touches any real LaunchAgent; the only label used is an isolated test label.
const TEST_LABEL='local.keyln.host.test.1234abcd';
const directory=t=>{const dir=mkdtempSync(join(tmpdir(),'keyln-t120-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
const entry=(args,env={})=>spawnSync(process.execPath,['dist/apps/host/service-entry.js',...args],{encoding:'utf8',timeout:15000,env:{...process.env,KEYLN_SERVICE_LABEL:TEST_LABEL,...env}});
const version=JSON.parse(readFileSync('package.json','utf8')).version;

test('service-entry refuses install, uninstall and unknown commands with one stderr line',t=>{
 const data=directory(t);
 for(const command of ['install','uninstall','status','doctor','admin','']){
  const result=entry(command?[command]:[],{KEYLN_DATA_DIR:data});
  assert.equal(result.status,1,command);assert.equal(result.stdout,'');assert.match(result.stderr,/Unsupported command/);assert.equal(result.stderr.trim().split('\n').length,1);
 }
 assert.deepEqual(readdirSync(data),[]);
});

test('service-entry accepts only service labels that servicePaths already accepts',t=>{
 const data=directory(t);
 for(const label of ['local.keyln.host.evil','local.keyln.host.test.XYZ','com.example.other','local.keyln.host.test.1234abcd.x']){
  const result=entry(['menu-status'],{KEYLN_DATA_DIR:data,KEYLN_SERVICE_LABEL:label});assert.equal(result.status,1,label);assert.match(result.stderr,/Invalid Keyln service paths or label/);assert.equal(result.stdout,'');
 }
});

test('menu-status reports a missing installation as valid JSON without throwing, with and without --doctor',t=>{
 const data=directory(t);execFileSync(process.execPath,['scripts/setup.mjs'],{env:{...process.env,KEYLN_DATA_DIR:data},stdio:'pipe'});
 for(const args of [['menu-status'],['menu-status','--doctor']]){
  const result=entry(args,{KEYLN_DATA_DIR:data});assert.equal(result.status,0,result.stderr);
  const status=JSON.parse(result.stdout);
  assert.equal(status.installed,false);assert.equal(status.running,false);assert.equal(status.loaded,false);assert.equal(status.pid,null);assert.equal(status.nodeAvailable,false);
  assert.match(status.origin,/^https:\/\//);assert.equal(status.logs,join(data,'logs'));assert.equal(typeof status.state,'string');assert.equal('permissions' in status,false);
 }
 const bare=directory(t),empty=JSON.parse(entry(['menu-status'],{KEYLN_DATA_DIR:bare}).stdout);assert.equal(empty.installed,false);assert.equal(empty.origin,null);
 assert.equal(entry(['menu-status','--bogus'],{KEYLN_DATA_DIR:data}).status,1);
});

test('admin-json and the service commands fail cleanly when the test service does not exist',t=>{
 const data=directory(t);
 for(const command of ['admin-json','start','stop','restart']){const result=entry([command],{KEYLN_DATA_DIR:data});assert.equal(result.status,1,command);assert.equal(result.stdout,'');assert.equal(result.stderr.trim().split('\n').length,1);}
});

test('the build produces a signed agent app bundle with the expected Info.plist and icon',()=>{
 const app='dist/Keyln.app',plist=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',join(app,'Contents/Info.plist')],{encoding:'utf8'}));
 assert.equal(plist.LSUIElement,true);assert.equal(plist.CFBundleIdentifier,'local.keyln.menubar');assert.equal(plist.CFBundleExecutable,'Keyln');assert.equal(plist.CFBundleName,'Keyln');assert.equal(plist.CFBundleDisplayName,'Keyln');
 assert.equal(plist.CFBundleShortVersionString,version);assert.equal(plist.CFBundleIconFile,'AppIcon');assert.match(plist.LSMinimumSystemVersion,/^\d+\.\d+$/);
 assert.ok(statSync(join(app,'Contents/MacOS/Keyln')).mode&0o100);assert.ok(statSync(join(app,'Contents/Resources/AppIcon.icns')).size>1000);
 execFileSync('/usr/bin/codesign',['--verify','--strict',app],{stdio:'pipe'});
 assert.match(spawnSync('/usr/bin/codesign',['-dv',app],{encoding:'utf8'}).stderr,/Identifier=local\.keyln\.menubar/);
});

test('app:install copies the bundle into the chosen directory and a second run replaces it cleanly',t=>{
 const target=directory(t),run=()=>execFileSync(process.execPath,['scripts/app-install.mjs','--target',target,'--no-open','--app-only'],{encoding:'utf8',stdio:'pipe'});
 run();const installed=join(target,'Keyln.app');assert.ok(existsSync(join(installed,'Contents/MacOS/Keyln')));execFileSync('/usr/bin/codesign',['--verify','--strict',installed],{stdio:'pipe'});
 writeFileSync(join(installed,'stale-marker'),'x');run();
 assert.equal(existsSync(join(installed,'stale-marker')),false);execFileSync('/usr/bin/codesign',['--verify','--strict',installed],{stdio:'pipe'});
 assert.deepEqual(readdirSync(target),['Keyln.app']);
 for(const bad of [['--target','relative'],['--target','/Applications'],['--bogus']])assert.equal(spawnSync(process.execPath,['scripts/app-install.mjs',...bad,'--no-open'],{stdio:'pipe'}).status,1);
});
