import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAction,parseShortcutInfo} from '../dist/packages/contracts/index.js';
import {ShortcutsAdapter,ShortcutsCatalog,parseShortcutList} from '../dist/apps/host/shortcuts.js';
const id='4FE32199-2549-45B2-B2D7-43BEBA883E06';
const result=extra=>({exitCode:0,signal:null,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),truncated:false,...extra});
const catalog=(entries=[{id,name:'Owned shortcut'}])=>({refresh:async()=>{},state:()=>({shortcuts:entries,shortcutsError:'',shortcutsRefreshing:false})});

test('Shortcuts list keeps UUID identity for duplicate names and parentheses; malformed lists fail closed',()=>{
 const another='0A95A69B-6E99-42DC-8C84-10357FAAFDF2';
 const entries=parseShortcutList(`Same (name) (${id})\nSame (name) (${another})\n`);
 assert.equal(entries.length,2);assert.equal(entries[0].name,'Same (name)');assert.notEqual(entries[0].id,entries[1].id);
 for(const text of ['arbitrary output',`Owned (${id})\nOwned (${id})`])assert.throws(()=>parseShortcutList(text));
 assert.equal(parseAction({type:'shortcuts.run',shortcutId:id.toLowerCase(),timeoutMs:1000}).shortcutId,id);
 assert.throws(()=>parseAction({type:'shortcuts.run',shortcutId:'name; command',timeoutMs:1000}));
 assert.throws(()=>parseAction({type:'shortcuts.run',shortcutId:id,timeoutMs:60001}));
 assert.throws(()=>parseAction({type:'shortcuts.run',shortcutId:id,timeoutMs:1000,inputPath:'/private/user/file'}));
 assert.deepEqual(parseShortcutInfo({id,name:'Owned'}),{id,name:'Owned'});
});

test('Shortcuts waits for CLI completion, uses only UUID argv, and never exposes raw output/errors',async()=>{
 let finish,calls=0;
 const adapter=new ShortcutsAdapter(catalog(),async(file,args,options)=>{calls++;assert.equal(file,'/usr/bin/shortcuts');assert.deepEqual(args,['run',id]);assert.equal(options.timeoutMs,1000);return await new Promise(resolve=>finish=resolve);});
 let completed=false;const run=adapter.run({type:'shortcuts.run',shortcutId:id,timeoutMs:1000},new AbortController().signal).then(value=>{completed=true;return value;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(completed,false);assert.equal(calls,1);
 finish(result({stdout:Buffer.from('private-shortcut-output')}));assert.equal((await run).ok,true);assert.equal(JSON.stringify(await run).includes('private-shortcut-output'),false);
 const error=await new ShortcutsAdapter(catalog(),async()=>result({exitCode:1,stderr:Buffer.from('private error')})).run({type:'shortcuts.run',shortcutId:id,timeoutMs:1000},new AbortController().signal);
 assert.equal(error.code,'SHORTCUTS_FAILED');assert.doesNotMatch(error.message,/private error/);
});

test('removed shortcuts never start; a timed out CLI remains unknown because the system shortcut may continue',async()=>{
 let calls=0;
 const missing=await new ShortcutsAdapter(catalog([]),async()=>{calls++;return result();}).run({type:'shortcuts.run',shortcutId:id,timeoutMs:1000},new AbortController().signal);
 assert.equal(missing.code,'SHORTCUT_UNAVAILABLE');assert.equal(calls,0);
 const unknown=await new ShortcutsAdapter(catalog(),async()=>result({reason:'timeout'})).run({type:'shortcuts.run',shortcutId:id,timeoutMs:1000},new AbortController().signal);
 assert.equal(unknown.ok,false);assert.equal(unknown.unknown,true);assert.equal(unknown.code,'SHORTCUTS_TIMEOUT');assert.match(unknown.message,/may still be running/);
});

test('catalog refresh is bounded, shared, and stale identifiers are removed after an unavailable scan',async()=>{
 let calls=0,fail=false;
 const list=new ShortcutsCatalog(async(file,args)=>{calls++;assert.equal(file,'/usr/bin/shortcuts');assert.deepEqual(args,['list','--show-identifiers']);return result({stdout:Buffer.from(`Owned (${id})\n`),...(fail?{reason:'timeout'}:{})});});
 await Promise.all([list.refresh(),list.refresh()]);assert.equal(calls,1);assert.equal(list.state().shortcuts.length,1);
 fail=true;await list.refresh();assert.deepEqual(list.state().shortcuts,[]);assert.ok(list.state().shortcutsError);
});
