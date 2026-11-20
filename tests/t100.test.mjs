import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FINDER_APP_ID,folderPath,parseAction,parseWindows} from '../dist/packages/contracts/index.js';
import {createWindowPicker} from '../dist/apps/web/window-picker.js';
import {installDom} from './helpers/widget-dom.mjs';
import {client} from './helpers/client-harness.mjs';
import {fromGrid} from './helpers/layout.mjs';

// T100 (ADR-090): a Finder window key keeps the folder of its tab. The Mac switches to any Finder tab that shows it (background tabs too) and opens the
// folder when none does; failures no longer open the Settings menu. The Mac side is covered by tests/window-target-policy.test.mjs and the T100 Mac check.
// These tests use the compiled contract, the window picker on the small DOM and the page on the fake transport; they are not browser or Surface evidence.
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const finder={type:'window.activate',appId:FINDER_APP_ID,title:'功課',match:'exact'};

test('T100 a Finder key may carry a full folder path; other apps and malformed paths are refused',()=>{
  assert.equal(FINDER_APP_ID,'com.apple.finder');
  assert.deepEqual(parseAction({...finder,path:'/Users/me/功課'}),{...finder,path:'/Users/me/功課'});
  assert.deepEqual(parseAction(finder),finder,'a key without a folder stays as it was');
  for(const path of ['/','/Volumes/Data','/a b/c'])assert.equal(folderPath(path),path);
  for(const path of ['relative/x','/a/','/a//b','/a/../b','/a/./b','/a\nb','',42,'/'+'x'.repeat(1024)])assert.throws(()=>parseAction({...finder,path}),/folder path/);
  assert.throws(()=>parseAction({...finder,appId:'com.apple.Safari',path:'/Users/me'}),/Only Finder/);
  assert.deepEqual(parseWindows([{title:'Keyln',minimized:false,path:'/Users/me/Keyln'},{title:'Recents',minimized:false}]),
    [{title:'Keyln',minimized:false,path:'/Users/me/Keyln'},{title:'Recents',minimized:false}]);
  assert.throws(()=>parseWindows([{title:'x',minimized:false,path:'x/'}]));
});

function picker(t,appId,rows){
  const {el,document}=installDom(t),parent=document.getElementById('host');let changes=0,current=appId;
  const p=createWindowPicker(parent,'window',{appId:()=>current,load:async()=>rows,changed:()=>changes++});
  return {p,el,changes:()=>changes,setApp:value=>{current=value;p.appChanged();}};
}
test('T100 the Folder field shows only for Finder and is filled from the window that is chosen',async t=>{
  const rows=[{title:'Keyln',minimized:false,path:'/Users/me/Keyln'},{title:'功課',minimized:true,path:'/Users/me/功課'}];
  const {p,el,changes,setApp}=picker(t,FINDER_APP_ID,rows);
  p.set(finder);assert.equal(el('window-path').hidden,false);assert.equal(p.path,undefined,'an old key has no folder');
  el('window-read').emit('click');await new Promise(resolve=>setImmediate(resolve));
  el('window-choices').value='1';el('window-choices').emit('change');
  assert.equal(p.title,'功課');assert.equal(p.path,'/Users/me/功課');assert.ok(changes()>0);
  el('window-path').value='  /Users/me/Other  ';el('window-path').emit('input');assert.equal(p.path,'/Users/me/Other','typed paths are trimmed');
  setApp('com.microsoft.rdc.macos');assert.equal(el('window-path').hidden,true);assert.equal(p.path,undefined,'other apps never carry a folder');
});
test('T100 when Finder folders cannot be read the picker says how to allow it',async t=>{
  const {el}=picker(t,FINDER_APP_ID,[{title:'Keyln',minimized:false}]);
  el('window-read').emit('click');await new Promise(resolve=>setImmediate(resolve));
  assert.match(el('window-status').textContent,/allow Keyln to control Finder on the Mac \(System Settings › Privacy & Security › Automation\)/);
});

test('T100 a failed key no longer opens the Settings menu; the diagnostics inside it are expanded',async t=>{
  const configuration=fromGrid({schemaVersion:2,revision:1,profiles:[{id:'main',name:'Main'}],buttons:[{id:'primary',profileId:'main',position:0,label:'功課',icon:'app',action:finder}]});
  const f=await client(t,{configuration,apps:[{id:FINDER_APP_ID,name:'Finder'}]}),{el}=f,socket=f.sockets[0];await f.until(()=>!f.button().disabled);
  f.button().emit('click');socket.state({busy:true});socket.push({type:'execution',execution:f.execution('accepted',{actionType:'window.activate'})});
  socket.push({type:'execution',execution:f.execution('failed',{actionType:'window.activate',code:'FOLDER_UNAVAILABLE',message:'The saved folder no longer exists or is not a folder.'})});
  socket.state({busy:false});f.execute.resolve({execution:f.execution('accepted',{actionType:'window.activate'})});await f.drain();
  assert.equal(f.button().dataset.state,'failed');assert.match(el('execution-message').textContent,/功課 · Action failed .*no longer exists/);
  assert.notEqual(el('connection-settings').open,true,'the menu stays closed');assert.equal(el('execution-diagnostics').open,true);
  assert.match(f.button().title,/no longer exists/,'the message is on the key tooltip');
});

test('T100 the helper scripts Finder with a fixed script, opens only plain folders and keeps every other app on Accessibility',()=>{
  const swift=read('native/macos-helper/Finder.swift'),windows=read('native/macos-helper/Windows.swift'),host=read('apps/host/native.ts'),build=read('scripts/build.mjs');
  assert.match(swift,/private let finderScriptSource = """/);
  assert.doesNotMatch(swift,/finderScriptSource\s*\+|\\\(path\)|\\\(title\)/,'no value is spliced into the script');
  assert.match(swift,/\.isPackageKey/);assert.match(swift,/directory\.boolValue/);
  assert.match(swift,/case -1743: return WindowProblem\(code: "FINDER_AUTOMATION_REQUIRED"/);
  assert.match(windows,/if appID == finderAppID, let result = try activateFinder\(title: title, match: match, path: path\) \{ return result \}/);
  assert.match(windows,/if path != nil \{ throw WindowProblem\(code: "INVALID_WINDOW_RULE"/);
  assert.match(host,/\.\.\.\(action\.path !== undefined \? \[action\.path\] : \[\]\)/);
  assert.match(build,/'native\/macos-helper\/Finder\.swift'/);
});
