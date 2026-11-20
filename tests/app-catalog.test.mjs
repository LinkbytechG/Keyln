import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

// Read-only native discovery: no app is opened and no keyboard event is sent.
test('native catalog includes installed system Safari and keeps application IDs unique',()=>{
  const apps=JSON.parse(execFileSync('./dist/keyln-helper',['list'],{encoding:'utf8',timeout:10000}));
  assert.ok(Array.isArray(apps));assert.equal(new Set(apps.map(app=>app.id)).size,apps.length);
  for(const app of apps){assert.match(app.id,/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/);assert.ok(app.name.length>0);}
  if(['/Applications/Safari.app','/System/Cryptexes/App/System/Applications/Safari.app'].some(path=>existsSync(path)))
    assert.ok(apps.some(app=>app.id==='com.apple.Safari'&&app.name.includes('Safari')),'Installed Safari must be selectable, including through a hidden system link.');
});

test('native app catalog keeps UI agents while excluding background-only, hidden and nested helper apps',t=>{
 const directory=mkdtempSync(join(tmpdir(),'keyln-app-catalog-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const root=join(directory,'Applications');mkdirSync(root);
 function bundle(path,id,name,flags={}){
  mkdirSync(join(path,'Contents'),{recursive:true});
  const fields={CFBundleIdentifier:id,CFBundleName:name,CFBundlePackageType:'APPL',...flags};
  const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
  writeFileSync(join(path,'Contents/Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict>${Object.entries(fields).map(([k,v])=>`<key>${k}</key>${typeof v==='boolean'?v?'<true/>':'<false/>':`<string>${escape(v)}</string>`}`).join('')}</dict></plist>`);
 }
 bundle(join(root,'Agent.app'),'local.test.agent','Window-capable agent',{LSUIElement:true});
 bundle(join(root,'Background.app'),'local.test.background','Background only',{LSBackgroundOnly:true});
 bundle(join(root,'Both.app'),'local.test.both','Still background only',{LSUIElement:true,LSBackgroundOnly:true});
 bundle(join(root,'.Hidden.app'),'local.test.hidden','Hidden app',{LSUIElement:true});
 bundle(join(root,'Regular.app'),'local.test.regular','Regular app');
 bundle(join(root,'Copy.app'),'local.test.regular','Regular app');
 bundle(join(root,'Regular.app/Contents/Helpers/Nested.app'),'local.test.nested','Nested helper',{LSUIElement:true});
 const binary=join(directory,'catalog-probe'),cache=join(directory,'module-cache');
 execFileSync('/usr/bin/xcrun',['swiftc','-module-cache-path',cache,'tests/app-catalog-probe/main.swift','native/macos-helper/Applications.swift','-o',binary],{stdio:'pipe',timeout:60000});
 const result=JSON.parse(execFileSync(binary,[root],{encoding:'utf8',timeout:5000}));
 assert.deepEqual(result,[{id:'local.test.regular',name:'Regular app'},{id:'local.test.agent',name:'Window-capable agent'}]);
});
