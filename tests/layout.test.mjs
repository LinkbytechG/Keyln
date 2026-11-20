import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync,statSync,renameSync,mkdirSync,unlinkSync,symlinkSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ConfigStore} from '../dist/apps/host/store.js';
import {Auth} from '../dist/apps/host/auth.js';
import {key,components,withComponents,pagesWidget} from './helpers/layout.mjs';
import {importPreview} from '../dist/apps/host/layout.js';
import {initialView,parseConfig,MAX_CONFIG_BYTES,v2ToV3,viewFor} from '../dist/packages/contracts/index.js';
const dir=t=>{const value=mkdtempSync(join(tmpdir(),'keyln-t14-'));t.after(()=>rmSync(value,{recursive:true,force:true}));return value;};
// T94: a save that changes nothing writes nothing (and keeps no backup), so a test that needs a first saved revision makes a real change.
const touch=store=>store.replace(withComponents(store.get(),[key('seed')]),[]);
const bind=()=>({type:'shell.run',scriptId:'owned-script',version:'a'.repeat(64),args:['safe']});
function layout(){let c=initialView();c.revision=9;const first=key('primary',bind(),{x:0,y:0},{requiresConfirmation:true});c=withComponents(c,[first,{...first,id:'flow-key',action:{type:'workflow.run',workflowId:'flow'}}]);c.workflows=[{id:'flow',name:'Owned flow',timeoutMs:3000,steps:[{id:'first',action:bind(),timeoutMs:1000},{id:'second',action:{type:'keyboard.shortcut',key:'KeyA',modifiers:['command']},timeoutMs:1000,requiresConfirmation:true}]}];return c;}
function device(auth){const p=auth.begin(auth.invite(),'Owned device');auth.approve(p.id);return `__Host-keyln=${auth.claim(p.id,p.claim).token}`;}

test('layout preview round-trips pages, keys, workflow IDs and risk flags without registering or running a script',()=>{
 const c=layout(),calls=[];const preview=importPreview(JSON.parse(JSON.stringify(c)),[],action=>calls.push(action));assert.deepEqual(preview.config,v2ToV3(c));assert.deepEqual(preview.view,{...c,layoutRevision:c.revision});assert.equal(preview.issues.length,0);assert.equal(calls.length,3);
 const unavailable=importPreview(c,[],action=>{if(action.type==='shell.run')throw Error('private local path must not leak');});assert.equal(unavailable.issues.length,2);assert.doesNotMatch(JSON.stringify(unavailable.issues),/private local path/);assert.match(unavailable.issues[0].message,/never registers or approves/);
 for(const old of [{schemaVersion:1,revision:3,button:{id:'primary',label:'Legacy',icon:'app',action:null}},{...c,schemaVersion:10}])assert.throws(()=>importPreview(old,[],()=>{}),error=>error.code==='CONFIG_VERSION'||error.code==='INVALID_INPUT');
 for(const bad of [{...c,version:3},{...c,devices:[]},{...c,scripts:[{source:'do not run'}]},{...c,widgets:[{...c.widgets[0],pages:[{...c.widgets[0].pages[0],widgets:[components(c)[0],components(c)[0]]}]}]},{...c,workflows:[{...c.workflows[0],steps:[{...c.workflows[0].steps[0],action:{type:'workflow.run',workflowId:'flow'}}]}]}])assert.throws(()=>importPreview(bad,[],()=>{}));
});

test('import ignores file revisions, validates all script bindings even if unchanged, and backs up the complete previous layout',t=>{
 const store=new ConfigStore(dir(t)),c=layout();c.revision=store.get().revision;store.replace(c,[],()=>{});
 const before=store.get(),bytes=readFileSync(store.path);const candidate=structuredClone(before);components(candidate)[0].label='Imported';
 assert.throws(()=>store.replace(candidate,[],()=>{throw Error('Requires rebind');},true,store.documentStamp()),/Requires rebind/);assert.deepEqual(readFileSync(store.path),bytes);
 const future=structuredClone(candidate);future.revision=999;assert.throws(()=>store.replace(future,[],()=>{},true,store.documentStamp()),error=>error.code==='CONFIG_CONFLICT');
 const next=store.replace(candidate,[],()=>{},true,store.documentStamp());assert.equal(next.revision,before.revision+1);assert.deepEqual(viewFor(JSON.parse(readFileSync(store.backup)),'Surface'),before);assert.deepEqual(new ConfigStore(join(store.path,'..')).get(),next);
});

test('backup review binds both files; stale confirmation does not revoke devices or overwrite the layout',t=>{
 const path=dir(t),store=new ConfigStore(path),auth=new Auth(path),cookie=device(auth);touch(store);const review=store.backupState();assert.equal(review.available,true);
 const candidate=store.get();candidate.widgets[0].pages[0].name='Newer';store.replace(candidate,[]);let revoked=0;
 assert.throws(()=>store.restoreBackup({stamp:review.stamp,confirm:true},()=>revoked++),error=>error.code==='BACKUP_CHANGED');assert.equal(revoked,0);assert.ok(auth.authenticate(cookie));assert.equal(store.get().widgets[0].pages[0].name,'Newer');
});

test('recovery preserves malformed original bytes, restores the valid backup and revokes stale sessions before writing',t=>{
 const path=dir(t),store=new ConfigStore(path),auth=new Auth(path),cookie=device(auth);touch(store);
 const backup=readFileSync(store.backup),broken=Buffer.from([0xff,0x00,0x61]);writeFileSync(store.path,broken);const recovery=new ConfigStore(path,true);
 assert.equal(recovery.available,false);assert.throws(()=>recovery.get(),error=>error.code==='CONFIG_DAMAGED');const review=recovery.backupState();assert.equal(review.available,true);
 const saved=recovery.restoreBackup({stamp:review.stamp,confirm:true},()=>auth.revokeAll());assert.equal(recovery.available,true);assert.deepEqual(saved,viewFor(JSON.parse(backup),'Surface'));assert.throws(()=>auth.authenticate(cookie),error=>error.code==='UNAUTHORIZED');assert.deepEqual(readFileSync(store.backup),backup);
 const archive=readdirSync(path).find(name=>name.startsWith('config.before-restore-'));const wrapper=JSON.parse(readFileSync(join(path,archive)));assert.deepEqual(Buffer.from(wrapper.originalBase64,'base64'),broken);assert.equal(statSync(join(path,archive)).mode&0o777,0o600);
});

test('failed revoke preserves active layout and backup; failed primary replacement stays explicit with old memory intact',t=>{
 const path=dir(t),store=new ConfigStore(path);touch(store);const before=store.get(),original=readFileSync(store.path),backup=readFileSync(store.backup),review=store.backupState();
 assert.throws(()=>store.restoreBackup({stamp:review.stamp,confirm:true},()=>{throw Error('write denied');}),error=>error.code==='RESTORE_FAILED');assert.deepEqual(readFileSync(store.path),original);assert.deepEqual(store.get(),before);
 assert.throws(()=>store.restoreBackup({stamp:review.stamp,confirm:true},()=>{renameSync(store.path,store.path+'.owned');mkdirSync(store.path);}),error=>error.code==='RESTORE_FAILED');assert.deepEqual(store.get(),before);assert.deepEqual(readFileSync(store.backup),backup);assert.deepEqual(readFileSync(store.path+'.owned'),original);
});

test('live backup restore advances revision while missing or unsupported backups never reset the configuration',t=>{
 const path=dir(t),store=new ConfigStore(path);assert.equal(store.backupState().available,false);touch(store);const review=store.backupState(),revision=store.get().revision;
 const result=store.restoreBackup({stamp:review.stamp,confirm:true},()=>{});assert.equal(result.revision,revision+1);
 const current=readFileSync(store.path);writeFileSync(store.backup,JSON.stringify({...initialView(),version:99}));assert.equal(store.backupState().available,false);assert.throws(()=>store.restoreBackup({stamp:'old',confirm:true},()=>{}));assert.deepEqual(readFileSync(store.path),current);
});

test('a compact upload cannot save a readable layout larger than its own export/import budget',t=>{
 const store=new ConfigStore(dir(t)),c=initialView();
 c.widgets=[{...c.widgets[0],pages:Array.from({length:16},(_,i)=>({id:`p${i}`,name:`Page ${i}`,widgets:Array.from({length:12},(_,j)=>key(`key${i*12+j}`,{...bind(),args:Array(8).fill('x'.repeat(128))},{x:j%4,y:Math.floor(j/4)},{label:'Sized layout'}))}))}];
 assert.ok(Buffer.byteLength(JSON.stringify(c))<MAX_CONFIG_BYTES);assert.ok(Buffer.byteLength(JSON.stringify(c,null,2)+'\n')>MAX_CONFIG_BYTES);
 const before=readFileSync(store.path);assert.throws(()=>parseConfig(c),e=>e.code==='TOO_LARGE');assert.throws(()=>store.replace(c,[],()=>{},true),e=>e.code==='TOO_LARGE');assert.deepEqual(readFileSync(store.path),before);
});

test('missing, future and linked primary layouts remain preserved instead of becoming a blank first run',t=>{
 const path=dir(t),store=new ConfigStore(path);touch(store);unlinkSync(store.path);
 const missing=new ConfigStore(path,true);assert.equal(missing.available,false);assert.equal(missing.backupState().available,true);assert.equal(readdirSync(path).includes('config.json'),false);
 writeFileSync(store.path,JSON.stringify({...initialView(),version:99}));const bytes=readFileSync(store.path);assert.equal(new ConfigStore(path,true).available,false);assert.deepEqual(readFileSync(store.path),bytes);
 unlinkSync(store.path);symlinkSync(join(path,'missing-target.json'),store.path);const linked=new ConfigStore(path,true);assert.equal(linked.available,false);assert.equal(linked.backupState().available,false);assert.equal(lstatSync(store.path).isSymbolicLink(),true);
});

test('offline recovery uses the same bounded format and preserves malformed original bytes exactly',t=>{
 const path=dir(t),store=new ConfigStore(path),auth=new Auth(path),cookie=device(auth);touch(store);const broken=Buffer.from([0xff,0x7b,0x00]);writeFileSync(store.path,broken);
 execFileSync(process.execPath,['dist/apps/host/restore.js'],{env:{...process.env,KEYLN_DATA_DIR:path},stdio:'pipe'});
 const archive=readdirSync(path).find(name=>name.startsWith('config.before-restore-'));assert.deepEqual(Buffer.from(JSON.parse(readFileSync(join(path,archive))).originalBase64,'base64'),broken);
 assert.throws(()=>new Auth(path).authenticate(cookie),e=>e.code==='UNAUTHORIZED');assert.deepEqual(new ConfigStore(path).get(),viewFor(JSON.parse(readFileSync(store.backup)),'Surface'));
});
