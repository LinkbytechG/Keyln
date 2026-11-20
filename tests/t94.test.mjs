import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,readdirSync,mkdirSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {request} from 'node:https';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import * as C from '../dist/packages/contracts/index.js';
import {ConfigStore,configurationFile,OLD_FORMAT_MESSAGE} from '../dist/apps/host/store.js';
import {DeviceAssignments} from '../dist/apps/host/device-assignments.js';
import {Auth} from '../dist/apps/host/auth.js';
import {LocalAdmin} from '../dist/apps/host/admin.js';
import {Scheduler} from '../dist/apps/host/scheduler.js';
import {createHost} from '../dist/apps/host/server.js';
import {importPreview} from '../dist/apps/host/layout.js';
import {archiveLegacyData,MARKER} from '../dist/apps/host/archive.js';
import {migrateLayout,parseMigrateArguments,runMigrate,MigrateError} from '../dist/apps/host/migrate.js';
import {planItemImport} from '../dist/apps/web/component-files.js';
import {client} from './helpers/client-harness.mjs';
import {key,layout,withComponents,pagesWidget,viewOf} from './helpers/layout.mjs';
import {saveRequest} from './helpers/save.mjs';

// T94 (ADR-086 phase 1, ADR-087): keyln.config v3 (a shared key library plus named layouts, each with its own revision), the merged view the page works on, the
// device-to-layout assignment, the Host's save/theme/event/archive behaviour, the migration command and the web client on top of it. Docs/verification/T94.md lists what is
// checked here and what is not (no Surface, no browser).
const APP={type:'app.open',appId:'test.app'},apps=[{id:'test.app',name:'Test app'}];
const clone=value=>JSON.parse(JSON.stringify(value));
const fault=code=>error=>error.code===code;
const folder=t=>{const dir=mkdtempSync(join(tmpdir(),'keyln-t94-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
const placement=(id,size='S')=>({id,kind:'key',size});
const onePage=(...widgets)=>({id:'main',kind:'pages',pages:[{id:'p1',name:'Page 1',widgets}]});
// A library of keys a (shown on both layouts), b (Surface only), c (Phone only) and d (shown nowhere), and the layouts Surface and Phone.
function twoLayouts(){
  const k=(id,label,action=APP)=>({id,kind:'key',label,icon:'app',action});
  return C.parseConfigDocument({format:'keyln.config',version:3,
    library:{revision:4,keys:[k('a','Alpha'),k('b','Beta'),k('c','Gamma',null),k('d','Delta')],workflows:[{id:'flow',name:'Flow',timeoutMs:3000,steps:[{id:'s',action:APP,timeoutMs:1000}]}]},
    layouts:[
      {name:'Surface',revision:7,theme:'braun',gridSize:'standard',widgets:[onePage(placement('a','M'),placement('b'),{id:'clock',kind:'clock',size:'M',form:'time'})]},
      {name:'Phone',revision:2,theme:'metro',gridSize:'compact',widgets:[onePage(placement('a'),placement('c','L'))]}],
    defaultLayout:'Surface'});
}
const writeDoc=(dir,doc)=>writeFileSync(join(dir,'config.json'),JSON.stringify(doc,null,2)+'\n',{mode:0o600});
const storeWith=(t,doc=twoLayouts())=>{const dir=folder(t);writeDoc(dir,doc);return {dir,store:new ConfigStore(dir)};};

// ---- the format --------------------------------------------------------------------------------------------------------------------------------
test('T94 initialConfig is v3: an empty library and one layout named Surface (default theme, standard grid, one empty page); its view is the v2 shape',()=>{
  const doc=C.initialConfig();
  assert.equal(doc.version,3);assert.equal(C.CONFIG_VERSION,3);assert.equal(C.VIEW_VERSION,2);assert.deepEqual(C.parseConfigDocument(doc),doc);
  assert.deepEqual(doc,{format:'keyln.config',version:3,library:{revision:0,keys:[]},layouts:[{name:'Surface',revision:0,theme:'braun',gridSize:'standard',
    widgets:[{id:'main',kind:'pages',pages:[{id:'page-1',name:'Page 1',widgets:[]}]}]}],defaultLayout:'Surface'});
  assert.deepEqual(C.initialView(),{format:'keyln.config',version:2,revision:0,gridSize:'standard',widgets:[{id:'main',kind:'pages',pages:[{id:'page-1',name:'Page 1',widgets:[]}]}],layoutName:'Surface',layoutRevision:0});
  assert.equal(C.EVENT_PROTOCOL,'keyln.events.v4');assert.equal(C.EVENT_PROTOCOL_V3,'keyln.events.v3');
});
test('T94 strict v3 parse: shape, references, duplicate placements, unknown workflows, unique trimmed names, defaultLayout, size',()=>{
  const good=twoLayouts(),bad=(mutate,code='INVALID_INPUT')=>{const doc=clone(good);mutate(doc);assert.throws(()=>C.parseConfigDocument(doc),fault(code));};
  assert.deepEqual(C.parseConfigDocument(clone(good)),good,'round trip');
  assert.equal(good.library.keys.find(item=>item.id==='d')!==undefined,true,'a library key that no layout places is allowed');
  assert.deepEqual(good.layouts.map(layout=>layout.widgets[0].pages[0].widgets[0].id),['a','a'],'the same key may be placed on several layouts');
  bad(d=>{d.version=2;},'CONFIG_VERSION');bad(d=>{d.version=4;},'CONFIG_VERSION');bad(d=>{d.format='keyln.layout';},'CONFIG_VERSION');
  bad(d=>{d.extra=1;});bad(d=>{delete d.defaultLayout;});bad(d=>{d.library.extra=1;});bad(d=>{delete d.library.keys;});bad(d=>{d.layouts[0].extra=1;});bad(d=>{delete d.layouts[0].theme;});
  bad(d=>{d.library.revision=-1;});bad(d=>{d.layouts[0].revision=1.5;});bad(d=>{d.library.revision='4';});
  // keys: a key keeps no size; ids are unique; a key has the key rules (name, icon, action)
  bad(d=>{d.library.keys[0].size='S';});bad(d=>{d.library.keys.push({...d.library.keys[0]});});bad(d=>{d.library.keys[0].label='';});bad(d=>{d.library.keys[0].icon='nonsense';});
  bad(d=>{d.library.keys[0].action={type:'shell.run'};});bad(d=>{d.library.keys[0].kind='group';});
  // placements: they name a library key, carry only a size, a key appears at most once per layout, widget ids stay unique inside a layout
  bad(d=>{d.layouts[0].widgets[0].pages[0].widgets[0].id='missing';});
  bad(d=>{d.layouts[0].widgets[0].pages[0].widgets[0].label='inline content';});bad(d=>{delete d.layouts[0].widgets[0].pages[0].widgets[0].size;});bad(d=>{d.layouts[0].widgets[0].pages[0].widgets[0].size='Huge';});
  bad(d=>{d.layouts[0].widgets[0].pages[0].widgets.push(placement('a'));});
  bad(d=>{d.layouts[0].widgets.push(placement('a'));});
  bad(d=>{d.layouts[0].widgets[0].pages[0].widgets[2].id='a';});
  bad(d=>{d.layouts[0].widgets[0].pages.push({id:'p1',name:'Again',widgets:[]});});
  bad(d=>{d.layouts[0].widgets[0].pages[0].widgets.push({id:'x',kind:'pages',pages:[{id:'y',name:'Y',widgets:[]}]});});
  // workflows are the library's: a key may only run one the library has
  bad(d=>{d.library.keys[0].action={type:'workflow.run',workflowId:'nope'};});
  const flowKey=clone(good);flowKey.library.keys[0].action={type:'workflow.run',workflowId:'flow'};C.parseConfigDocument(flowKey);
  bad(d=>{d.layouts[0].workflows=[];});
  // layouts: at least one, unique trimmed names of 1-40 characters, defaultLayout is one of them
  bad(d=>{d.layouts=[];});bad(d=>{d.layouts[1].name='Surface';});bad(d=>{d.layouts[1].name=' Phone';});bad(d=>{d.layouts[1].name='Phone ';});bad(d=>{d.layouts[1].name='';});bad(d=>{d.layouts[1].name='x'.repeat(41);});bad(d=>{d.layouts[1].name='a\nb';});
  const longest=clone(good);longest.layouts[1].name='x'.repeat(40);C.parseConfigDocument(longest);
  bad(d=>{d.defaultLayout='Tablet';});bad(d=>{d.defaultLayout=' Surface';});
  const many=clone(good);many.layouts=Array.from({length:C.MAX_LAYOUTS+1},(_,n)=>({...clone(good.layouts[0]),name:`L${n}`}));assert.throws(()=>C.parseConfigDocument(many),fault('INVALID_INPUT'));
  // theme: a built-in name, or a custom theme id (one that does not exist parses and resolves to the default)
  bad(d=>{d.layouts[0].theme='nonsense';});bad(d=>{d.layouts[0].theme=7;});
  const ghost=clone(good);ghost.layouts[0].theme='theme-gone';const parsed=C.parseConfigDocument(ghost);assert.equal(C.layoutTheme(parsed,'Surface'),null);assert.equal(C.resolveTheme(parsed.layouts[0].theme,parsed.library.customThemes).name,'braun');
  const custom=clone(good);custom.library.customThemes=[{id:'theme-a',name:'A',base:'metro',accent:'#F26B1D',background:'#101216',keyBody:'#1E2124',radius:'rounded',spacing:'normal',font:'metro'}];custom.layouts[0].theme='theme-a';
  assert.equal(C.layoutTheme(C.parseConfigDocument(custom),'Surface'),'theme-a');custom.library.customThemes=[];assert.equal('customThemes' in C.parseConfigDocument(custom).library,false,'an empty list is the same as none');
  // the whole saved document fits 256 KiB
  const big=clone(good);big.library.keys.push(...Array.from({length:600},(_,n)=>({id:`k${n}`,kind:'key',label:'Key '.repeat(8),icon:'app',action:{type:'shell.run',scriptId:'script',version:'a'.repeat(64),args:Array(8).fill('x'.repeat(128))}})));
  assert.throws(()=>C.parseConfigDocument(big),fault('TOO_LARGE'));
  assert.throws(()=>C.layoutName(' x'),fault('INVALID_INPUT'));assert.equal(C.layoutName('Surface Pro'),'Surface Pro');
});
test('T94 viewFor merges a layout with the library: keys carry their placement size, revision is the library\'s, layoutName and layoutRevision name the layout',()=>{
  const doc=twoLayouts(),view=C.viewFor(doc,'Surface');
  assert.equal(view.version,2);assert.equal(view.revision,4,'the library revision');assert.equal(view.layoutName,'Surface');assert.equal(view.layoutRevision,7);assert.equal(view.gridSize,'standard');
  assert.deepEqual(C.allComponents(view).map(item=>[item.id,item.size,item.label]),[['a','M','Alpha'],['b','S','Beta']]);
  assert.deepEqual(view.widgets[0].pages[0].widgets[2],{id:'clock',kind:'clock',size:'M',form:'time'});assert.deepEqual(view.workflows,doc.library.workflows);
  assert.deepEqual(C.parseConfig(clone(view)),view,'the view is a valid v2 document');
  const phone=C.viewFor(doc,'Phone');assert.equal(phone.gridSize,'compact');assert.equal(phone.layoutRevision,2);assert.equal(phone.revision,4);assert.deepEqual(C.allComponents(phone).map(item=>[item.id,item.size]),[['a','S'],['c','L']],'another layout shows its own placements of the same key');
  assert.equal(C.findComponent(phone,'d'),undefined,'an unplaced library key is in no view');assert.throws(()=>C.viewFor(doc,'Tablet'),fault('INVALID_INPUT'));
  view.widgets[0].pages[0].widgets[0].label='changed';assert.equal(doc.library.keys[0].label,'Alpha','a view never aliases the document');
  assert.equal(C.resolveLayout(doc,'Phone').name,'Phone');assert.equal(C.resolveLayout(doc,'Tablet').name,'Surface');assert.equal(C.resolveLayout(doc,undefined).name,'Surface');
  // Pages (size, columns), blanks and every display widget live in the layout only and come through unchanged
  const rich=C.initialConfig();rich.library.keys.push({id:'k',kind:'key',label:'K',icon:'app',action:null});
  rich.layouts[0].widgets=[{id:'main',kind:'pages',size:{w:{mode:'fill',min:240},h:{mode:'fixed',u:360}},columns:{wide:6,narrow:3},pages:[{id:'p',name:'P',widgets:[placement('k','Wide'),{id:'bl',kind:'blank',size:'M'},{id:'tx',kind:'text',size:'Wide',form:'title',text:'Hi'}]}]},{id:'rf',kind:'refresh',size:'S',form:'button'}];
  const richView=C.viewFor(C.parseConfigDocument(rich),'Surface');assert.deepEqual(richView.widgets[0].columns,{wide:6,narrow:3});assert.deepEqual(richView.widgets[0].size,rich.layouts[0].widgets[0].size);
  assert.deepEqual(richView.widgets[0].pages[0].widgets.map(widget=>widget.kind),['key','blank','text']);assert.equal(richView.widgets[0].pages[0].widgets[0].size,'Wide');
});
test('T94 splitView sends only the part that changed (key content, workflows, custom themes: library; placements, order, pages, grid: layout); the theme is never part of it',()=>{
  const doc=twoLayouts(),base=C.viewFor(doc,'Surface'),edit=mutate=>{const draft=clone(base);mutate(draft);return C.splitView(base,draft);};
  assert.deepEqual(C.splitView(base,clone(base)),{},'nothing changed, nothing to send');
  const rename=edit(d=>{d.widgets[0].pages[0].widgets[0].label='Renamed';});assert.deepEqual(Object.keys(rename),['library']);assert.deepEqual(rename.library.keys.map(item=>item.label),['Renamed','Beta']);assert.equal('size' in rename.library.keys[0],false,'a library key has no size');
  for(const mutate of [d=>{d.widgets[0].pages[0].widgets[0].icon='spark';},d=>{d.widgets[0].pages[0].widgets[0].color='blue';},d=>{d.widgets[0].pages[0].widgets[0].appearance={style:'outline'};},d=>{d.widgets[0].pages[0].widgets[0].requiresConfirmation=true;},d=>{d.widgets[0].pages[0].widgets[0].action=null;}])assert.deepEqual(Object.keys(edit(mutate)),['library']);
  assert.deepEqual(Object.keys(edit(d=>{d.workflows=[...d.workflows,{id:'second',name:'Second',timeoutMs:2000,steps:[{id:'s',action:APP,timeoutMs:1000}]}];})),['library']);
  assert.deepEqual(Object.keys(edit(d=>{d.customThemes=[{id:'theme-a',name:'A',base:'metro',accent:'#F26B1D',background:'#101216',keyBody:'#1E2124',radius:'rounded',spacing:'normal',font:'metro'}];})),['library']);
  const resize=edit(d=>{d.widgets[0].pages[0].widgets[0].size='XL';});assert.deepEqual(Object.keys(resize),['layout']);assert.equal(resize.layout.widgets[0].pages[0].widgets[0].size,'XL');assert.deepEqual(resize.layout.widgets[0].pages[0].widgets[0],{id:'a',kind:'key',size:'XL'});
  assert.deepEqual(Object.keys(edit(d=>{d.widgets[0].pages[0].widgets.reverse();})),['layout'],'a move is a layout change');
  assert.deepEqual(Object.keys(edit(d=>{d.gridSize='large';})),['layout']);assert.deepEqual(Object.keys(edit(d=>{d.widgets[0].pages[0].name='Renamed page';})),['layout']);
  assert.deepEqual(Object.keys(edit(d=>{d.widgets[0].columns={wide:5};})),['layout']);
  assert.deepEqual(Object.keys(edit(d=>{d.widgets[0].pages[0].widgets.push({id:'bl',kind:'blank',size:'S'});})),['layout']);
  const added=edit(d=>{d.widgets[0].pages[0].widgets.push({id:'new',kind:'key',size:'S',label:'New',icon:'app',action:null});});assert.deepEqual(Object.keys(added).sort(),['layout','library']);assert.equal(added.library.keys.at(-1).id,'new');
  const removed=edit(d=>{d.widgets[0].pages[0].widgets.splice(1,1);});assert.deepEqual(Object.keys(removed).sort(),['layout','library'],'deleting a key changes both parts');assert.deepEqual(removed.library.keys.map(item=>item.id),['a']);
  const both=edit(d=>{d.widgets[0].pages[0].widgets[0].label='X';d.widgets[0].pages[0].widgets[0].size='L';});assert.deepEqual(Object.keys(both).sort(),['layout','library']);
  // The order of the properties of a key or the order of the keys is not a change
  const reordered=clone(base);reordered.widgets[0].pages[0].widgets[0]=Object.fromEntries(Object.entries(reordered.widgets[0].pages[0].widgets[0]).reverse());assert.deepEqual(C.splitView(base,reordered),{});
  // The parts parse with the same strictness as a saved file
  assert.deepEqual(C.parseLibraryContent(clone(rename.library)),rename.library);assert.deepEqual(C.parseLayoutContent(clone(resize.layout)),resize.layout);
  assert.throws(()=>C.parseLibraryContent({keys:[],extra:1}),fault('INVALID_INPUT'));assert.throws(()=>C.parseLayoutContent({gridSize:'standard',widgets:[],theme:'metro'}),fault('INVALID_INPUT'),'the theme is not part of a save');
  assert.throws(()=>C.parseLayoutContent({gridSize:'standard',widgets:[{id:'k',kind:'key',size:'S',label:'inline'}]}),fault('INVALID_INPUT'));
});
test('T94 applySplit round-trips every edit; deleting a key removes it from the library only when no other layout places it; keys nobody places stay',()=>{
  const doc=twoLayouts(),base=C.viewFor(doc,'Surface');
  const apply=mutate=>{const draft=clone(base);mutate(draft);return {draft,next:C.applySplit(doc,'Surface',C.splitView(base,draft))};};
  for(const mutate of [d=>{d.widgets[0].pages[0].widgets[0].label='Renamed';},d=>{d.widgets[0].pages[0].widgets[1].size='Tall';d.gridSize='large';},d=>{d.widgets[0].pages[0].widgets.reverse();},
    d=>{d.widgets[0].pages[0].widgets.push({id:'new',kind:'key',size:'S',label:'New',icon:'app',action:APP});},d=>{d.workflows=[];d.widgets[0].pages[0].widgets[0].action=null;}]){
    const {draft,next}=apply(mutate);C.parseConfigDocument(next);assert.deepEqual(C.viewFor(next,'Surface'),{...draft,revision:doc.library.revision,layoutRevision:doc.layouts[0].revision},'the page sees what it edited');
    assert.deepEqual(next.layouts[1],doc.layouts[1],'another layout is untouched');assert.deepEqual(next.defaultLayout,doc.defaultLayout);
  }
  assert.deepEqual(C.applySplit(doc,'Surface',{}),doc,'no parts, no change');
  // b is placed on Surface only: deleting it there deletes it from the library. a is placed on Phone too: deleting it on Surface only takes the placement away.
  const deleteB=apply(d=>{d.widgets[0].pages[0].widgets=d.widgets[0].pages[0].widgets.filter(widget=>widget.id!=='b');}).next;
  assert.deepEqual(deleteB.library.keys.map(item=>item.id),['a','c','d']);
  const deleteA=apply(d=>{d.widgets[0].pages[0].widgets=d.widgets[0].pages[0].widgets.filter(widget=>widget.id!=='a');}).next;
  assert.deepEqual(deleteA.library.keys.map(item=>item.id),['a','b','c','d'],'Phone still places a');assert.deepEqual(C.placedKeyIds(deleteA.layouts[0].widgets),['b']);assert.deepEqual(C.placedKeyIds(deleteA.layouts[1].widgets),['a','c']);
  assert.equal(C.viewFor(deleteA,'Phone').widgets[0].pages[0].widgets[0].label,'Alpha');
  // d is placed nowhere: a library edit made from a page never loses it, whatever the page sent
  assert.equal(apply(d=>{d.widgets[0].pages[0].widgets[0].label='L';}).next.library.keys.some(item=>item.id==='d'),true);
  // an edit of a shared key shows on the other layout
  const shared=apply(d=>{d.widgets[0].pages[0].widgets[0].label='Shared name';}).next;assert.equal(C.viewFor(shared,'Phone').widgets[0].pages[0].widgets[0].label,'Shared name');
  // a page that deletes the key from the library but still places it makes an invalid document, and the parse says so
  assert.throws(()=>C.parseConfigDocument(C.applySplit(doc,'Surface',{library:{keys:[doc.library.keys[0]]}})),fault('INVALID_INPUT'));
  assert.throws(()=>C.applySplit(doc,'Tablet',{}),fault('INVALID_INPUT'));
});
test('T94 v2ToV3 keeps every key, size, Pages setting, blank, display widget, workflow and custom theme; readConfig converts v1 and v2 without writing',()=>{
  const customTheme={id:'theme-one',name:'Mine',base:'metro',accent:'#123456',background:'#101216',keyBody:'#222222',radius:'rounded',spacing:'normal',font:'metro'};
  const keys=[key('plain',APP,{size:'S'},{label:'Plain'}),key('wide',{type:'keyboard.shortcut',key:'KeyA',modifiers:['command','shift']},{size:'Wide'},{label:'Shortcut',icon:'bolt',color:'blue'}),
    key('look',{type:'window.activate',appId:'test.app',title:'Doc',match:'contains'},{size:'XL'},{label:'Look',color:'none',appearance:{style:'outline',shape:'circle',glyph:{type:'text',text:'AI'}},requiresConfirmation:true}),
    key('flowkey',{type:'workflow.run',workflowId:'flow'},{size:'Tall'},{label:'Flow key'}),key('empty',null,{size:'M'},{label:'Not set up'})];
  const v2={...layout(keys,{revision:41,gridSize:'large',workflows:[{id:'flow',name:'Flow',timeoutMs:5000,requiresConfirmation:true,steps:[{id:'one',action:APP,timeoutMs:1000},{id:'two',action:{type:'keyboard.shortcut',key:'Tab',modifiers:[]},timeoutMs:1000,requiresConfirmation:true}]}],customThemes:[customTheme]}),
    widgets:[{id:'top',kind:'text',size:'Wide',form:'title',text:'Hello'},{...pagesWidget(keys.slice(0,3).concat([{id:'bl1',kind:'blank',size:'S'},{id:'clk',kind:'clock',size:'M',form:'time'}]),{size:{w:{mode:'percent',pct:50},h:{mode:'fill',min:240}},columns:{wide:6,narrow:3}}),
      pages:[{id:'page-1',name:'Page 1',widgets:keys.slice(0,3).concat([{id:'bl1',kind:'blank',size:'S'},{id:'clk',kind:'clock',size:'M',form:'time'}])},{id:'page-2',name:'Second',widgets:[keys[3],{id:'rf',kind:'refresh',size:'S',form:'button'}]}]},
      keys[4],{id:'right',kind:'pages',columns:{wide:4},pages:[{id:'r1',name:'R',widgets:[]}]}]};
  delete v2.layoutName;delete v2.layoutRevision;const parsedV2=C.parseConfig(clone(v2)),before=clone(v2);
  const doc=C.v2ToV3(parsedV2,{layoutName:'Studio',theme:'midnight'});
  assert.deepEqual(v2,before,'conversion never mutates its source');assert.equal(doc.version,3);assert.equal(doc.defaultLayout,'Studio');assert.deepEqual(doc.layouts.map(layout=>[layout.name,layout.theme,layout.gridSize,layout.revision]),[['Studio','midnight','large',41]]);assert.equal(doc.library.revision,41);
  assert.deepEqual(doc.library.keys.map(item=>item.id),C.allComponents(parsedV2).map(item=>item.id),'every key is in the library, once');
  for(const original of C.allComponents(parsedV2)){const {size,...content}=original;assert.deepEqual(doc.library.keys.find(item=>item.id===original.id),content,`${original.id} keeps its content`);assert.equal(C.placedKeyIds(doc.layouts[0].widgets).includes(original.id),true);}
  assert.deepEqual(doc.library.workflows,parsedV2.workflows);assert.deepEqual(doc.library.customThemes,parsedV2.customThemes);
  const back=C.viewFor(doc,'Studio');assert.deepEqual(back,{...parsedV2,layoutName:'Studio',layoutRevision:41},'the view of the converted layout is the original, size by size');
  assert.deepEqual(back.widgets[1].columns,{wide:6,narrow:3});assert.deepEqual(back.widgets[1].size,{w:{mode:'percent',pct:50},h:{mode:'fill',min:240}});assert.deepEqual(back.widgets[3].columns,{wide:4});
  assert.deepEqual(C.allComponents(back).map(item=>[item.id,item.size]),[['plain','S'],['wide','Wide'],['look','XL'],['flowkey','Tall'],['empty','M']]);
  assert.deepEqual(C.v2ToV3(parsedV2).layouts[0].name,'Surface');assert.equal(C.v2ToV3(parsedV2).layouts[0].theme,'braun');
  // readConfig: v3 as is, v2 and v1 converted in memory (one layout named Surface, default theme)
  assert.deepEqual(C.readConfig(clone(doc)),doc);const read=C.readConfig(clone(v2));assert.deepEqual(read,C.v2ToV3(parsedV2));assert.equal(read.layouts[0].name,'Surface');
  const v1={format:'keyln.config',version:1,revision:5,canvas:{cols:8,rows:5},widgets:[{...keys[0],cell:{x:0,y:0}}]};const v1Read=C.readConfig(v1);assert.equal(v1Read.version,3);assert.equal(v1Read.library.revision,5);assert.deepEqual(C.allComponents(C.viewFor(v1Read,'Surface')).map(item=>item.id),['plain']);
  assert.throws(()=>C.readConfig({format:'keyln.config',version:9}),fault('CONFIG_VERSION'));assert.throws(()=>C.readConfig({format:'other',version:3}),fault('CONFIG_VERSION'));assert.throws(()=>C.readConfig({...clone(doc),extra:1}));
  // A v2 conversion that does not pass the v3 rules is refused as a whole, never half written
  assert.throws(()=>C.v2ToV3(parsedV2,{layoutName:' padded '}),fault('INVALID_INPUT'));
});

// ---- the Host: separate revisions ------------------------------------------------------------------------------------------------------------
const body=(store,layoutName,parts,revisions={})=>({libraryRevision:store.revision,layoutName,layoutRevision:store.layoutRevision(layoutName),...parts,...revisions});
const renameA=(store,label,name='Surface')=>{const base=store.get(name),draft=clone(base);C.findComponent(draft,'a').label=label;return C.splitView(base,draft);};
const moveSecond=(store,name='Surface')=>{const base=store.get(name),draft=clone(base);draft.widgets[0].pages[0].widgets.reverse();return C.splitView(base,draft);};
test('T94 each part has its own revision: a key edit with a stale layout revision succeeds, a layout edit with a stale library revision succeeds, the same part stale is a 409',t=>{
  const {dir,store}=storeWith(t);
  assert.equal(store.revision,4);assert.equal(store.layoutRevision('Surface'),7);assert.equal(store.layoutRevision('Phone'),2);assert.deepEqual(store.layoutNames,['Surface','Phone']);assert.equal(store.defaultLayout,'Surface');
  const stale={library:3,layout:6};
  // library part only: the layout revision it carries is not looked at
  const keyEdit=store.save(body(store,'Surface',renameA(store,'Edited'),{layoutRevision:stale.layout}),apps);
  assert.equal(keyEdit.revision,5,'the library moved');assert.equal(keyEdit.layoutRevision,7,'the layout did not');assert.equal(C.findComponent(keyEdit,'a').label,'Edited');assert.equal(store.layoutRevision('Phone'),2);
  // layout part only: a stale library revision is not looked at
  const layoutEdit=store.save(body(store,'Surface',moveSecond(store),{libraryRevision:stale.library}),apps);
  assert.equal(layoutEdit.revision,5,'the library did not move');assert.equal(layoutEdit.layoutRevision,8);assert.deepEqual(C.allComponents(layoutEdit).map(item=>item.id),['b','a']);
  // the same part stale conflicts, and nothing is written
  const bytes=readFileSync(store.path);
  assert.throws(()=>store.save(body(store,'Surface',renameA(store,'Again'),{libraryRevision:4}),apps),fault('CONFIG_CONFLICT'));
  assert.throws(()=>store.save(body(store,'Surface',moveSecond(store),{layoutRevision:7}),apps),fault('CONFIG_CONFLICT'));
  // both parts present: either one stale refuses the whole save (atomic)
  const base=store.get('Surface'),draft=clone(base);C.findComponent(draft,'a').label='Both';C.findComponent(draft,'a').size='XL';const both=C.splitView(base,draft);assert.deepEqual(Object.keys(both).sort(),['layout','library']);
  assert.throws(()=>store.save(body(store,'Surface',both,{libraryRevision:4}),apps),fault('CONFIG_CONFLICT'));assert.throws(()=>store.save(body(store,'Surface',both,{layoutRevision:7}),apps),fault('CONFIG_CONFLICT'));
  assert.deepEqual(readFileSync(store.path),bytes,'a refused save writes nothing');
  // both parts, both current: one atomic save, each part's revision up by one, one backup of the previous file
  const saved=store.save(body(store,'Surface',both),apps);assert.equal(saved.revision,6);assert.equal(saved.layoutRevision,9);
  assert.deepEqual(readFileSync(store.backup),bytes,'the backup is the file as it was before this save');
  const disk=configurationFile(store.path);assert.equal(disk.library.revision,6);assert.equal(disk.layouts[0].revision,9);assert.equal(disk.layouts[1].revision,2,'another layout keeps its revision');assert.deepEqual(new ConfigStore(dir).get(),saved);
  // a key shown on two layouts is edited for both; Phone's own revision does not move because only the library changed
  assert.equal(C.findComponent(store.get('Phone'),'a').label,'Both');
});
test('T94 a request that changes nothing writes nothing; a part that is absent is not checked; malformed or unknown requests are refused before anything is written',t=>{
  const {store}=storeWith(t),bytes=readFileSync(store.path),backup=existsSync(store.backup);
  const same=C.splitView(store.get(),store.get());assert.deepEqual(same,{});
  const view=store.save(body(store,'Surface',{},{libraryRevision:0,layoutRevision:0}),apps);assert.equal(view.revision,4);assert.deepEqual(readFileSync(store.path),bytes);
  // a part that is present is checked against its own revision even when it only restates what is stored
  const base=store.get(),parts={library:C.splitView(base,{...base,widgets:base.widgets.map(clone),workflows:[...base.workflows,{id:'x',name:'X',timeoutMs:2000,steps:[{id:'s',action:APP,timeoutMs:1000}]}]}).library};
  assert.throws(()=>store.save(body(store,'Surface',parts,{libraryRevision:1}),apps),fault('CONFIG_CONFLICT'));
  const noChange={library:{keys:C.allComponents(base).map(({size,...rest})=>rest),workflows:base.workflows}};
  assert.equal(store.save(body(store,'Surface',noChange),apps).revision,4,'a library part equal to the stored one changes nothing');assert.deepEqual(readFileSync(store.path),bytes);assert.equal(existsSync(store.backup),backup,'no backup was made');
  const layoutSame={layout:{gridSize:base.gridSize,widgets:C.splitView(base,{...base,gridSize:'large'}).layout.widgets}};
  assert.equal(store.save(body(store,'Surface',layoutSame),apps).layoutRevision,7);assert.deepEqual(readFileSync(store.path),bytes,'a layout part equal to the stored one changes nothing');
  // unknown layout, unknown fields, missing fields, wrong types
  assert.throws(()=>store.save(body(store,'Tablet',{}),apps),fault('CONFIG_CONFLICT'));
  for(const bad of [{...body(store,'Surface',{}),extra:1},{layoutName:'Surface',layoutRevision:7,library:undefined},{libraryRevision:'4',layoutName:'Surface',layoutRevision:7},{libraryRevision:4,layoutName:7,layoutRevision:7},{libraryRevision:4,layoutName:'Surface',layoutRevision:-1},
    {...body(store,'Surface',{}),library:{keys:[],extra:1}},{...body(store,'Surface',{}),layout:{gridSize:'standard',widgets:[],theme:'metro'}},{...body(store,'Surface',{}),layout:{gridSize:'standard',widgets:[{id:'k',kind:'key',size:'S',label:'inline'}]}},null,[],'x'])
    assert.throws(()=>store.save(bad,apps),fault('INVALID_INPUT'));
  assert.deepEqual(readFileSync(store.path),bytes);
  // A placement of a key the library does not have is refused (no half-saved layout)
  assert.throws(()=>store.save(body(store,'Surface',{layout:{gridSize:'standard',widgets:[onePage(placement('ghost'))]}}),apps),fault('INVALID_INPUT'));assert.deepEqual(readFileSync(store.path),bytes);
});
test('T94 saves keep checking that new or changed key actions and workflow steps point at installed apps, approved scripts and known shortcuts',t=>{
  const {store}=storeWith(t),ghost={type:'app.open',appId:'missing.app'};
  const edit=mutate=>{const base=store.get(),draft=clone(base);mutate(draft);return C.splitView(base,draft);};
  assert.throws(()=>store.save(body(store,'Surface',edit(d=>{d.widgets[0].pages[0].widgets[0].action=ghost;})),apps),fault('APP_UNAVAILABLE'));
  assert.throws(()=>store.save(body(store,'Surface',edit(d=>{d.workflows[0].steps[0].action=ghost;})),apps),fault('APP_UNAVAILABLE'));
  assert.throws(()=>store.save(body(store,'Surface',edit(d=>{d.widgets[0].pages[0].widgets[0].action={type:'shell.run',scriptId:'x',version:'a'.repeat(64),args:[]};})),apps),fault('SCRIPT_UNAVAILABLE'));
  assert.throws(()=>store.save(body(store,'Surface',edit(d=>{d.widgets[0].pages[0].widgets[0].action={type:'shell.run',scriptId:'x',version:'a'.repeat(64),args:[]};})),apps,()=>{throw new C.Fault('SCRIPT_UNAVAILABLE','not approved');}),fault('SCRIPT_UNAVAILABLE'));
  assert.equal(store.revision,4,'nothing was saved');
  // an unchanged binding to an app that is gone is kept while something else about the key is edited
  const kept=store.save(body(store,'Surface',renameA(store,'Still there')),[]);assert.equal(C.findComponent(kept,'a').label,'Still there');assert.deepEqual(C.findComponent(kept,'a').action,APP);
  // a new key may bind an installed app
  const withNew=store.save(body(store,'Surface',edit(d=>{d.widgets[0].pages[0].widgets.push({id:'n',kind:'key',size:'S',label:'N',icon:'app',action:APP});})),apps);assert.ok(C.findComponent(withNew,'n'));assert.equal(store.get('Phone').widgets[0].pages[0].widgets.some(widget=>widget.id==='n'),false,'a key placed on one layout is not on the other');
});
test('T94 the theme is saved on its own: only the layout\'s field and revision change, no revision is compared, the backup stays',t=>{
  const {store}=storeWith(t),keyEdit=store.save(body(store,'Surface',renameA(store,'Edited')),apps),backup=readFileSync(store.backup);
  assert.equal(keyEdit.revision,5);
  const reply=store.setTheme('Surface','midnight');assert.deepEqual(reply,{theme:'midnight',layoutName:'Surface',previousLayoutRevision:7,layoutRevision:8});assert.equal(store.revision,5,'the library revision does not move');assert.equal(store.layoutRevision('Phone'),2);assert.equal(store.theme('Surface'),'midnight');assert.equal(store.theme('Phone'),'metro');
  assert.deepEqual(readFileSync(store.backup),backup,'a theme change does not replace the backup of the last save');
  assert.deepEqual(C.allComponents(store.get('Surface')).map(item=>item.label),['Edited','Beta'],'nothing else changed');
  // a page that was based on revision 7 still saves its key edit: that is a library change and the library revision it holds is current
  const afterTheme=store.save(body(store,'Surface',renameA(store,'After theme'),{layoutRevision:7}),apps);assert.equal(afterTheme.revision,6);
  // but a page that saves layout changes must hold the layout revision the theme change produced
  assert.throws(()=>store.save(body(store,'Surface',moveSecond(store),{layoutRevision:7}),apps),fault('CONFIG_CONFLICT'));
  assert.equal(store.save(body(store,'Surface',moveSecond(store),{layoutRevision:8}),apps).layoutRevision,9);
  assert.equal(store.theme('Surface'),'midnight','saving a layout never touches its theme');
  assert.deepEqual(C.parseLayoutContent({gridSize:'standard',widgets:[]}),{gridSize:'standard',widgets:[]});
});

// ---- the Host over HTTPS and WSS ---------------------------------------------------------------------------------------------------------------
async function fixture(t,{doc=twoLayouts(),run,seed=true}={}){
  const dir=folder(t);execFileSync(process.execPath,['scripts/setup.mjs'],{env:{...process.env,KEYLN_DATA_DIR:dir},stdio:'pipe'});
  if(seed)writeDoc(dir,doc);
  const auth=new Auth(dir),admin=new LocalAdmin(),store=new ConfigStore(dir,true),assignments=new DeviceAssignments(dir);
  const executed=[];const scheduler=new Scheduler({run:async action=>{executed.push(action);return run?await run(action):{ok:true,message:'Fake only'};}});
  const origin='https://127.0.0.1:0',ca=readFileSync(join(dir,'tls/rootCA.pem'));
  const server=createHost({auth,admin,store,scheduler,assignments,origin,apps,onPair:()=>{},tls:{key:readFileSync(join(dir,'tls/server.key')),cert:readFileSync(join(dir,'tls/server.pem'))}});
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const sockets=[];
  t.after(async()=>{for(const socket of sockets)socket.terminate();scheduler.stop();await scheduler.settled();server.stopEvents();server.closeAllConnections();await new Promise(yes=>server.close(yes));});
  const connection={hostname:'127.0.0.1',servername:'',port:server.address().port,ca};
  const send=(path,input={},cookie='',overrides={})=>new Promise((yes,no)=>{
    const req=request({...connection,path,method:'POST',headers:{host:'127.0.0.1:0',origin,'content-type':'application/json','x-keyln-client':'1',cookie,...overrides}},res=>{let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.on('end',()=>yes({status:res.statusCode,headers:res.headers,body:text,data:JSON.parse(text)}));});
    req.on('error',no);req.end(JSON.stringify(input));});
  const device=name=>{const p=auth.begin(auth.invite(),name);auth.approve(p.id);return {id:p.id,cookie:`__Host-keyln=${auth.claim(p.id,p.claim).token}`};};
  const events=cookie=>{const frames=[],waiters=[],ws=new WebSocket(`wss://127.0.0.1:${connection.port}/api/events`,C.EVENT_PROTOCOL,{ca,servername:'',origin,headers:{host:'127.0.0.1:0',cookie}});sockets.push(ws);
    ws.on('message',raw=>{const event=JSON.parse(raw.toString());frames.push(event);for(const waiter of waiters.splice(0))waiter();});ws.on('error',()=>{});
    const next=async()=>{const seen=frames.length;while(frames.length===seen)await new Promise(yes=>waiters.push(yes));return frames.at(-1);};
    const opened=new Promise((yes,no)=>{ws.once('open',yes);ws.once('error',no);});return {ws,frames,next,opened};};
  return {dir,store,auth,admin,assignments,scheduler,send,device,events,executed,connection,origin,server};
}
test('T94 a device\'s layout is its assignment or the default; the id comes from the cookie; a request for another layout is a conflict, never a write to it',async t=>{
  const f=await fixture(t),one=f.device('One'),two=f.device('Two');
  f.assignments.set(two.id,'Phone');
  const first=(await f.send('/api/configuration',{},one.cookie)).data.config,second=(await f.send('/api/configuration',{},two.cookie)).data.config;
  assert.equal(first.layoutName,'Surface');assert.equal(second.layoutName,'Phone');assert.deepEqual([first.revision,second.revision],[4,4],'one library revision');assert.deepEqual([first.layoutRevision,second.layoutRevision],[7,2]);
  assert.deepEqual(C.allComponents(first).map(item=>item.id),['a','b']);assert.deepEqual(C.allComponents(second).map(item=>[item.id,item.size]),[['a','S'],['c','L']]);assert.equal(second.gridSize,'compact');
  // an assignment to a layout that no longer exists, and a device with no entry, fall back to the default
  f.assignments.set(one.id,'Tablet');assert.equal((await f.send('/api/configuration',{},one.cookie)).data.config.layoutName,'Surface');
  const three=f.device('Three');assert.equal((await f.send('/api/configuration',{},three.cookie)).data.config.layoutName,'Surface');
  // the request cannot pick a device or a layout: saving for another layout than the device's own is refused and writes nothing
  const bytes=readFileSync(f.store.path),phoneEdit=body(f.store,'Phone',renameA(f.store,'Phone edit','Phone'));
  const refused=await f.send('/api/configuration/save',phoneEdit,one.cookie);assert.equal(refused.status,409);assert.equal(refused.data.error.code,'CONFIG_CONFLICT');assert.deepEqual(readFileSync(f.store.path),bytes);
  assert.equal((await f.send('/api/configuration/save',{...phoneEdit,deviceId:two.id},two.cookie)).status,400);
  // Phone's own device saves Phone: a shared key changes for both layouts, only the layouts that changed move
  const saved=await f.send('/api/configuration/save',phoneEdit,two.cookie);assert.equal(saved.status,200);assert.equal(saved.data.config.layoutName,'Phone');assert.equal(saved.data.config.revision,5);assert.equal(saved.data.config.layoutRevision,2,'only the library changed');
  assert.equal((await f.send('/api/configuration',{},one.cookie)).data.config.widgets[0].pages[0].widgets[0].label,'Phone edit');assert.equal(f.store.layoutRevision('Surface'),7);
  const moved=await f.send('/api/configuration/save',body(f.store,'Phone',moveSecond(f.store,'Phone')),two.cookie);assert.equal(moved.data.config.layoutRevision,3);assert.equal(moved.data.config.revision,5);assert.deepEqual(C.allComponents(moved.data.config).map(item=>item.id),['c','a']);
  assert.deepEqual(C.allComponents((await f.send('/api/configuration',{},one.cookie)).data.config).map(item=>item.id),['a','b'],'Surface kept its order');
  // an old page's whole-document save is refused with a reason
  const old=await f.send('/api/configuration/save',C.viewFor(f.store.document(),'Surface'),one.cookie);assert.equal(old.status,400);assert.equal(old.data.error.code,'CONFIG_VERSION');
  // the device theme routes follow the assignment
  assert.equal((await f.send('/api/device-theme',{},one.cookie)).data.theme,'braun');assert.equal((await f.send('/api/device-theme',{},two.cookie)).data.theme,'metro');
  assert.deepEqual((await f.send('/api/device-theme/save',{theme:'classic',layoutName:'Phone'},two.cookie)).data,{theme:'classic',layoutName:'Phone',previousLayoutRevision:3,layoutRevision:4});assert.equal((await f.send('/api/device-theme',{},one.cookie)).data.theme,'braun');
  // deleting a key on Surface keeps it for Phone (which places it); the library loses a key only when no layout places it
  const base=f.store.get('Surface'),draft=clone(base);draft.widgets[0].pages[0].widgets=draft.widgets[0].pages[0].widgets.filter(widget=>widget.id!=='a'&&widget.id!=='b');
  const deleted=await f.send('/api/configuration/save',saveRequest({...base,layoutRevision:f.store.layoutRevision('Surface'),revision:f.store.revision},{...draft,revision:f.store.revision,layoutRevision:f.store.layoutRevision('Surface')}),one.cookie);
  assert.equal(deleted.status,200);assert.deepEqual(f.store.document().library.keys.map(item=>item.id),['a','c','d'],'b is gone (no other layout places it), a stays (Phone does), c and d stay');
  assert.deepEqual(C.allComponents((await f.send('/api/configuration',{},two.cookie)).data.config).map(item=>item.id),['c','a']);
  assert.equal(f.executed.length,0);
});
test('T94 running a key and a confirmation compare the library revision only; the layout revision moving does not stale them',async t=>{
  const f=await fixture(t),d=f.device('Owner');
  const run=(componentId,revision)=>f.send('/api/execute',{requestId:randomUUID(),componentId,revision},d.cookie);
  assert.equal((await run('a',4)).status,202);await f.scheduler.settled();
  // a layout-only change (order, theme) leaves the library revision, so a key built on it still runs
  assert.equal((await f.send('/api/configuration/save',body(f.store,'Surface',moveSecond(f.store)),d.cookie)).status,200);assert.equal((await f.send('/api/device-theme/save',{theme:'metro',layoutName:'Surface'},d.cookie)).status,200);
  assert.equal(f.store.revision,4);assert.equal(f.store.layoutRevision('Surface'),9);
  const afterLayout=await run('a',4);assert.equal(afterLayout.status,202,JSON.stringify(afterLayout.data));await f.scheduler.settled();
  assert.equal((await run('a',9)).data.error.code,'CONFIG_CONFLICT','the layout revision is not what a key compares');
  // a key edit moves the library revision, and the old one is a conflict
  assert.equal((await f.send('/api/configuration/save',body(f.store,'Surface',renameA(f.store,'Edited')),d.cookie)).status,200);assert.equal(f.store.revision,5);
  assert.equal((await run('a',4)).data.error.code,'CONFIG_CONFLICT');assert.equal((await run('a',5)).status,202);await f.scheduler.settled();
  // only a key shown on the device's layout can run; a library key placed elsewhere is unavailable here
  assert.equal((await run('c',5)).data.error.code,'BUTTON_UNAVAILABLE');assert.equal((await run('d',5)).data.error.code,'BUTTON_UNAVAILABLE');
  // confirmations
  const riskyDraft=clone(f.store.get());C.findComponent(riskyDraft,'b').requiresConfirmation=true;
  assert.equal((await f.send('/api/configuration/save',body(f.store,'Surface',C.splitView(f.store.get(),riskyDraft)),d.cookie)).status,200);
  const asked={requestId:randomUUID(),componentId:'b',revision:6};assert.equal((await f.send('/api/confirmation',asked,d.cookie)).status,200);
  assert.equal((await f.send('/api/confirmation',{...asked,requestId:randomUUID(),revision:f.store.layoutRevision('Surface')},d.cookie)).data.error.code,'CONFIG_CONFLICT');
  assert.equal(f.executed.length,3);
});
test('T94 state events carry the library revision and the revision of the layout assigned to that connection\'s device',async t=>{
  const f=await fixture(t),one=f.device('One'),two=f.device('Two');f.assignments.set(two.id,'Phone');
  const a=f.events(one.cookie),b=f.events(two.cookie);await a.opened;await b.opened;
  const hello=async client=>{await new Promise(yes=>setTimeout(yes,40));return client.frames.at(-1);};
  assert.deepEqual([await hello(a),await hello(b)].map(event=>[event.type,event.version,event.revision,event.layoutRevision]),[['state',2,4,7],['state',2,4,2]]);
  assert.deepEqual(Object.keys(C.parseStateEvent(a.frames[0])).sort(),['busy','instanceId','layoutRevision','revision','sequence','type','version']);
  // a key edit made on Surface moves the library revision for both devices, and Surface's layout revision only for neither (a key edit is not a layout edit)
  const pending=[a.next(),b.next()];assert.equal((await f.send('/api/configuration/save',body(f.store,'Surface',renameA(f.store,'Edited')),one.cookie)).status,200);
  assert.deepEqual((await Promise.all(pending)).map(event=>[event.revision,event.layoutRevision]),[[5,7],[5,2]]);
  // a layout edit on Phone moves only Phone's layout revision, as seen by Phone's device
  const next=[a.next(),b.next()];assert.equal((await f.send('/api/configuration/save',body(f.store,'Phone',moveSecond(f.store,'Phone')),two.cookie)).status,200);
  assert.deepEqual((await Promise.all(next)).map(event=>[event.revision,event.layoutRevision]),[[5,7],[5,3]]);
  // a theme change raises the layout revision and is published
  const theme=[a.next(),b.next()];assert.equal((await f.send('/api/device-theme/save',{theme:'midnight',layoutName:'Surface'},one.cookie)).status,200);
  assert.deepEqual((await Promise.all(theme)).map(event=>[event.revision,event.layoutRevision]),[[5,8],[5,3]]);
  assert.throws(()=>C.parseStateEvent({...a.frames[0],layoutRevision:undefined}),fault('INVALID_INPUT'));
  const refused=new WebSocket(`wss://127.0.0.1:${f.connection.port}/api/events`,'keyln.events.v2',{ca:f.connection.ca,servername:'',origin:f.origin,headers:{host:'127.0.0.1:0',cookie:one.cookie}});
  assert.equal(await new Promise(yes=>{refused.once('unexpected-response',(_,res)=>{res.resume();yes(res.statusCode);});refused.once('open',()=>yes(101));refused.on('error',()=>{});}),400,'the old protocol name is refused');
});

// ---- the Host does not migrate, and old files are never moved aside ---------------------------------------------------------------------------
// A v2 configuration as the files of a Host before T94 hold it: no layoutName, one revision, Pages with fixed or Auto keys per row.
function v2File({revision=41,wide=6}={}){
  const view=layout([key('primary',APP,{size:'M'},{label:'Calculator',color:'blue'}),key('second',null,{size:'S'},{label:'Second'}),{id:'blank-1',kind:'blank',size:'S'}],{revision,customThemes:[{id:'theme-one',name:'Mine',base:'metro',accent:'#123456',background:'#101216',keyBody:'#222222',radius:'rounded',spacing:'normal',font:'metro'}]});
  view.widgets=[{...pagesWidget(view.widgets[0].pages[0].widgets,{columns:wide===null?undefined:{wide,narrow:3}})},{id:'clock',kind:'clock',size:'M',form:'time'},{id:'side',kind:'pages',columns:{wide:4},pages:[{id:'side-1',name:'Side',widgets:[]}]}];
  if(wide===null)delete view.widgets[0].columns;
  delete view.layoutName;delete view.layoutRevision;return C.parseConfig(view);
}
test('T94 the Host never migrates: a v2 (or v1) layout puts the store in the recovery state with the migrate message; no action runs and nothing is written',async t=>{
  const dir=folder(t),v2=v2File(),bytes=JSON.stringify(v2,null,2)+'\n';writeFileSync(join(dir,'config.json'),bytes);
  assert.equal(OLD_FORMAT_MESSAGE,'The layout is in the old format. Stop Keyln and run npm run layout:migrate.');
  assert.throws(()=>new ConfigStore(dir),error=>error.message===OLD_FORMAT_MESSAGE);
  const store=new ConfigStore(dir,true);assert.equal(store.available,false);assert.equal(store.reason,OLD_FORMAT_MESSAGE);assert.throws(()=>store.get(),fault('CONFIG_DAMAGED'));assert.throws(()=>store.save({},apps),fault('CONFIG_DAMAGED'));
  assert.equal(readFileSync(join(dir,'config.json'),'utf8'),bytes,'the file is as it was');assert.equal(existsSync(join(dir,'config.backup.json')),false);
  const v1=join(folder(t),'config.json');mkdirSync(join(v1,'..'),{recursive:true});writeFileSync(v1,JSON.stringify({format:'keyln.config',version:1,revision:2,canvas:{cols:8,rows:5},widgets:[]}));assert.equal(new ConfigStore(join(v1,'..'),true).reason,OLD_FORMAT_MESSAGE);
  // a missing config.json still starts with the initial v3 document
  const fresh=folder(t);assert.deepEqual(new ConfigStore(fresh).document(),C.initialConfig());assert.deepEqual(JSON.parse(readFileSync(join(fresh,'config.json'))),C.initialConfig());
  // Mac management shows the reason and nothing else runs
  const f=await fixture(t,{seed:false});writeFileSync(join(f.dir,'config.json'),bytes);
  const unavailable=new ConfigStore(f.dir,true);assert.equal(unavailable.available,false);
  const host=createHost({auth:f.auth,admin:f.admin,store:unavailable,scheduler:f.scheduler,assignments:f.assignments,origin:f.origin,apps,onPair:()=>{},tls:{key:readFileSync(join(f.dir,'tls/server.key')),cert:readFileSync(join(f.dir,'tls/server.pem'))}});
  await new Promise((yes,no)=>{host.once('error',no);host.listen(0,'127.0.0.1',yes);});t.after(async()=>{host.stopEvents();host.closeAllConnections();await new Promise(yes=>host.close(yes));});
  const send=(path,input={},cookie='')=>new Promise((yes,no)=>{const req=request({hostname:'127.0.0.1',servername:'',port:host.address().port,ca:f.connection.ca,path,method:'POST',headers:{host:'127.0.0.1:0',origin:f.origin,'content-type':'application/json','x-keyln-client':'1',cookie}},res=>{let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.on('end',()=>yes({status:res.statusCode,headers:res.headers,data:JSON.parse(text)}));});req.on('error',no);req.end(JSON.stringify(input));});
  const login=await send('/api/admin/login',{code:f.admin.invite()});assert.equal(login.status,200);const adminCookie=login.headers['set-cookie'][0].split(';')[0];
  const state=await send('/api/admin/state',{},adminCookie);assert.equal(state.status,200);assert.equal(state.data.layout.available,false);assert.equal(state.data.layout.reason,OLD_FORMAT_MESSAGE);
  const paired=f.device('Late');assert.equal((await send('/api/configuration',{},paired.cookie)).data.error.code,'CONFIG_DAMAGED');assert.equal((await send('/api/execute',{requestId:randomUUID(),componentId:'primary',revision:41},paired.cookie)).data.error.code,'CONFIG_DAMAGED');
  assert.equal(f.executed.length,0);assert.equal(readFileSync(join(f.dir,'config.json'),'utf8'),bytes);
});
test('T94 start-up archives nothing the new Host can read: v1, v2 and v3 config files stay; unknown versions move aside; the marker says 3 only for a v3 directory',t=>{
  const dir=folder(t),write=(name,value)=>writeFileSync(join(dir,name),typeof value==='string'?value:JSON.stringify(value));
  const v1={format:'keyln.config',version:1,revision:1,canvas:{cols:8,rows:5},widgets:[]},v2=v2File(),v3=twoLayouts();
  write('config.json',v2);write('config.backup.json',v1);write('config.keep.json',v3);write('config.future.json',{format:'keyln.config',version:4});write('config.other.json',{format:'keyln.layout',version:1});write('config.before-restore-1-x.json',{encoding:'base64',originalBase64:'e30='});
  const before={json:readFileSync(join(dir,'config.json')),backup:readFileSync(join(dir,'config.backup.json')),keep:readFileSync(join(dir,'config.keep.json'))};
  const logs=[],made=archiveLegacyData(dir,message=>logs.push(message),()=>Date.UTC(2026,9,29,1,2,3));
  assert.ok(made);assert.deepEqual(readdirSync(made).sort(),['config.before-restore-1-x.json','config.future.json','config.other.json'],'only what no version of the Host reads moved');
  assert.deepEqual(readFileSync(join(dir,'config.json')),before.json);assert.deepEqual(readFileSync(join(dir,'config.backup.json')),before.backup);assert.deepEqual(readFileSync(join(dir,'config.keep.json')),before.keep);
  assert.equal(existsSync(join(dir,MARKER)),false,'a directory whose config.json is still v2 is not marked as v3');
  // an older marker (version 2, written by T65) stays as it is until the migration
  write(MARKER,{format:'keyln.config',version:2});archiveLegacyData(dir,()=>{});assert.deepEqual(JSON.parse(readFileSync(join(dir,MARKER),'utf8')),{format:'keyln.config',version:2});
  // a v3 config.json (after the migration) gets the marker, and a second start does nothing
  write('config.json',v3);assert.equal(archiveLegacyData(dir,()=>{}),undefined);assert.deepEqual(JSON.parse(readFileSync(join(dir,MARKER),'utf8')),{format:'keyln.config',version:3});assert.equal(archiveLegacyData(dir,()=>{}),undefined);
  // a new directory is a v3 directory
  const fresh=folder(t);assert.equal(archiveLegacyData(fresh,()=>{}),undefined);assert.deepEqual(JSON.parse(readFileSync(join(fresh,MARKER),'utf8')),{format:'keyln.config',version:3});
  // the retired per-device files are still archived
  const retired=folder(t);writeFileSync(join(retired,'device-layouts.json'),'{}');writeFileSync(join(retired,'theme-canvases.json'),'{}');writeFileSync(join(retired,'device-assignments.json'),'{}');writeFileSync(join(retired,'device-themes.json'),'{}');
  const archived=archiveLegacyData(retired,()=>{});assert.deepEqual(readdirSync(archived).sort(),['device-layouts.json','theme-canvases.json']);assert.equal(existsSync(join(retired,'device-assignments.json')),true);assert.equal(existsSync(join(retired,'device-themes.json')),true);
});
test('T94 the production Host started on a v2 directory serves Mac management only, says to run npm run layout:migrate, and leaves every file alone',{timeout:20000},async t=>{
  const f=await fixture(t,{seed:false}),d=f.device('Old'),bytes=JSON.stringify(v2File(),null,2)+'\n';
  writeFileSync(join(f.dir,'config.json'),bytes);await new Promise(yes=>{f.server.stopEvents();f.server.closeAllConnections();f.server.close(yes);});
  const port=f.connection.port,origin=`https://127.0.0.1:${port}`;writeFileSync(join(f.dir,'host.json'),JSON.stringify({schemaVersion:1,address:'127.0.0.1',port,origin}));
  const child=spawn(process.execPath,['dist/apps/host/main.js'],{env:{...process.env,KEYLN_DATA_DIR:f.dir},stdio:['pipe','pipe','pipe']});child.stdin.on('error',()=>{});
  let errors='';child.stderr.on('data',part=>{errors+=part;});const closed=new Promise(yes=>child.once('close',yes));
  const ready=new Promise((yes,no)=>{let output='';const timer=setTimeout(()=>no(Error('Owned startup timed out.')),12000);child.stdout.on('data',part=>{output+=part;const match=output.match(/Mac management login code: ([0-9]{8}) /);if(match){clearTimeout(timer);yes(match[1]);output='';}});child.once('close',()=>{clearTimeout(timer);no(Error('Owned startup exited before ready.'));});});
  const send=(path,input={},cookie='')=>f.send(path,input,cookie,{host:`127.0.0.1:${port}`,origin});
  try{
    const login=await send('/api/admin/login',{code:await ready}),cookie=login.headers['set-cookie'][0].split(';')[0];assert.equal(login.status,200);
    assert.match(errors,/The layout is in the old format\. Stop Keyln and run npm run layout:migrate\./);
    const state=(await send('/api/admin/state',{},cookie)).data;assert.equal(state.layout.available,false);assert.equal(state.layout.reason,OLD_FORMAT_MESSAGE);
    assert.equal((await send('/api/configuration',{},d.cookie)).data.error.code,'CONFIG_DAMAGED');assert.equal((await send('/api/execute',{requestId:randomUUID(),componentId:'primary',revision:41},d.cookie)).data.error.code,'CONFIG_DAMAGED');
    assert.equal(readFileSync(join(f.dir,'config.json'),'utf8'),bytes,'the Host did not migrate');assert.equal(existsSync(join(f.dir,'device-assignments.json')),false);assert.equal(readdirSync(f.dir).some(name=>name.startsWith('migration-v3-')),false);
  }finally{child.stdin.end('quit\n');let timer;const code=await Promise.race([closed,new Promise(yes=>timer=setTimeout(()=>{child.kill('SIGKILL');yes(null);},4000))]);clearTimeout(timer);if(code===null)await closed;assert.equal(code,0);assert.equal(existsSync(join(f.dir,'host.lock')),false);}
});

// ---- export, import, backup and restore --------------------------------------------------------------------------------------------------------
test('T94 export is the whole v3 document; import (v3, or v1/v2 converted) replaces everything with revisions that move past what the Host holds; the preview shows the device\'s own layout',async t=>{
  const f=await fixture(t),one=f.device('One'),two=f.device('Two');f.assignments.set(two.id,'Phone');
  const exported=(await f.send('/api/configuration/export',{},one.cookie)).data.config;assert.equal(exported.version,3);assert.deepEqual(exported,f.store.document());assert.equal(exported.layouts.length,2);assert.equal(exported.library.keys.length,4,'the unplaced key travels too');
  assert.equal((await f.send('/api/configuration/export',{extra:1},one.cookie)).status,400);
  // preview: v3 as it is; the view is the calling device's layout of the file (its own layout when the file has it, else the file's default)
  const doc=clone(exported);doc.library.keys.push({id:'e',kind:'key',label:'Epsilon',icon:'app',action:null});doc.layouts[1].widgets[0].pages[0].widgets.push(placement('e'));doc.layouts[0].name='Home';doc.defaultLayout='Home';
  const forOne=(await f.send('/api/configuration/preview',doc,one.cookie)).data,forTwo=(await f.send('/api/configuration/preview',doc,two.cookie)).data;
  assert.equal(forOne.config.version,3);assert.equal(forOne.view.layoutName,'Home','Surface is not in the file: its default layout');assert.equal(forTwo.view.layoutName,'Phone','Phone is');assert.equal(forOne.layoutName,'Surface');assert.equal(forTwo.layoutName,'Phone');
  assert.deepEqual([forOne.revision,forOne.layoutRevision,forTwo.layoutRevision],[4,7,2]);assert.deepEqual(forOne.issues,[]);assert.deepEqual(readFileSync(f.store.path),readFileSync(f.store.path));
  const preview=(await f.send('/api/configuration/preview',C.viewFor(exported,'Surface'),one.cookie)).data;assert.equal(preview.config.version,3,'a v2 view (an older export) is converted in memory');assert.equal(preview.config.layouts.length,1);assert.equal(preview.config.layouts[0].name,'Surface');
  // import: the file's library revision is the one the reviewer saw
  const bytes=readFileSync(f.store.path);assert.equal((await f.send('/api/configuration/import',{config:{...doc,library:{...doc.library,revision:99}},stamp:forOne.stamp},one.cookie)).data.error.code,'CONFIG_CONFLICT');assert.deepEqual(readFileSync(f.store.path),bytes);
  const imported=await f.send('/api/configuration/import',{config:doc,stamp:forOne.stamp},one.cookie);assert.equal(imported.status,200);
  assert.deepEqual(f.store.layoutNames,['Home','Phone']);assert.equal(f.store.defaultLayout,'Home');assert.equal(f.store.revision,5,'library +1');assert.equal(f.store.layoutRevision('Phone'),3,'a layout the Host had: its revision +1');assert.equal(f.store.layoutRevision('Home'),8,'a new layout name: past the highest revision the Host held');
  assert.equal(imported.data.config.layoutName,'Home','device one no longer has a layout called Surface: the default');assert.deepEqual(readFileSync(f.store.backup),bytes,'the previous file is the backup');
  assert.equal(f.assignments.get(two.id),'Phone','device assignments are not part of the file and stay');assert.equal((await f.send('/api/configuration',{},two.cookie)).data.config.layoutName,'Phone');
  // a v2 file (what the page of before T94 exported) is converted and imported: one layout named Surface, default theme
  const old=v2File({revision:f.store.revision});const converted=await f.send('/api/configuration/import',{config:old,stamp:f.store.documentStamp()},one.cookie);assert.equal(converted.status,200);
  assert.deepEqual(f.store.layoutNames,['Surface']);assert.equal(f.store.theme(),'braun');assert.equal(f.store.revision,6);assert.deepEqual(C.allComponents(f.store.get()).map(item=>item.id),['primary','second']);
  assert.equal((await f.send('/api/configuration',{},two.cookie)).data.config.layoutName,'Surface','a device whose layout is gone uses the default');
  // an import that does not pass the v3 rules, or names an app that is not installed, changes nothing
  const before=readFileSync(f.store.path);for(const bad of [{...doc,defaultLayout:'Nowhere'},{...doc,layouts:[]},{...doc,extra:1}])assert.equal((await f.send('/api/configuration/import',{config:{...bad,library:{...bad.library,revision:f.store.revision}},stamp:f.store.documentStamp()},one.cookie)).status,400);
  const ghost=clone(doc);ghost.library.keys[0].action={type:'app.open',appId:'missing.app'};ghost.library.revision=f.store.revision;assert.equal((await f.send('/api/configuration/import',{config:ghost,stamp:f.store.documentStamp()},one.cookie)).data.error.code,'APP_UNAVAILABLE');assert.deepEqual(readFileSync(f.store.path),before);
  assert.equal(f.executed.length,0);
});
test('T94 a component file still works: its size goes to the placement and its content to the library',()=>{
  const doc=twoLayouts(),view=C.viewFor(doc,'Surface'),file=C.parseItemFile(C.exportItemFile(view,'a'));
  assert.equal(file.component.size,'M','the file carries the placement size');assert.equal(Object.hasOwn(file.component,'id'),false);
  const planned=planItemImport(view,{},file),base=view;assert.equal(C.allComponents(planned.config).length,3);
  const split=C.splitView(base,planned.config);assert.deepEqual(Object.keys(split).sort(),['layout','library']);
  const next=C.applySplit(doc,'Surface',split),added=C.viewFor(next,'Surface');
  const fresh=C.allComponents(added).find(item=>!['a','b'].includes(item.id));assert.ok(fresh,'a new key');assert.equal(fresh.size,'M');assert.equal(fresh.label,'Alpha');assert.equal(next.library.keys.find(item=>item.id===fresh.id).size,undefined,'the library key has no size');
  assert.equal(C.viewFor(next,'Phone').widgets[0].pages[0].widgets.some(widget=>widget.id===fresh.id),false);
  const asConfig=C.itemFileLayout(file);assert.equal(asConfig.version,2);assert.equal(C.allComponents(asConfig)[0].size,'M');
});
test('T94 backup review and restore work on v3 backups and on a v2 backup converted in memory; restore revokes devices and moves every revision past the Host\'s',t=>{
  const {dir,store}=storeWith(t);store.save(body(store,'Surface',renameA(store,'Edited')),apps);store.save(body(store,'Surface',moveSecond(store)),apps);
  const state=store.backupState();assert.equal(state.available,true);assert.deepEqual([state.revision,state.layouts,state.pages,state.buttons,state.workflows],[5,2,2,4,1],'the backup is the file before the last save: its library revision, layouts, pages, keys and workflows');
  let revoked=0;const restored=store.restoreBackup({stamp:state.stamp,confirm:true},()=>revoked++);
  assert.equal(revoked,1);assert.equal(restored.layoutName,'Surface');assert.equal(restored.revision,6,'max(5 held, 5 in the backup) + 1');
  const disk=configurationFile(store.path);assert.equal(disk.version,3);assert.equal(disk.library.revision,6);assert.equal(disk.layouts[0].revision,9);assert.equal(disk.layouts[1].revision,3,'every layout moves past what the Host held');assert.equal(C.viewFor(disk,'Surface').widgets[0].pages[0].widgets[0].label,'Edited');
  assert.deepEqual(new ConfigStore(dir).get(),restored);
  // a v2 backup is read as a converted v3 (one layout named Surface, default theme); restoring it replaces the layouts with it
  const old=v2File({revision:3});writeFileSync(store.backup,JSON.stringify(old));const reviewed=store.backupState();assert.deepEqual([reviewed.available,reviewed.revision,reviewed.layouts,reviewed.buttons],[true,3,1,2]);
  const again=store.restoreBackup({stamp:reviewed.stamp,confirm:true},()=>{});assert.deepEqual(C.allComponents(again).map(item=>item.id),['primary','second']);assert.equal(again.layoutName,'Surface');assert.equal(again.revision,7,'the Host held 6');assert.deepEqual(configurationFile(store.path).layouts.map(layout=>layout.name),['Surface']);
  assert.equal(store.theme(),'braun');
  // nothing readable: no backup, and nothing is reset
  writeFileSync(store.backup,'{broken');assert.equal(store.backupState().available,false);assert.throws(()=>store.restoreBackup({stamp:'x',confirm:true},()=>{}),fault('BACKUP_CHANGED'));
  // the offline command reads a v2 backup too and writes v3
  const cli=folder(t);writeFileSync(join(cli,'config.backup.json'),JSON.stringify(old));writeFileSync(join(cli,'config.json'),'{broken');
  execFileSync(process.execPath,['dist/apps/host/restore.js'],{env:{...process.env,KEYLN_DATA_DIR:cli},stdio:'pipe'});assert.equal(configurationFile(join(cli,'config.json')).version,3);assert.deepEqual(configurationFile(join(cli,'config.json')),C.readConfig(old));
});

// ---- the migration command ---------------------------------------------------------------------------------------------------------------------
// A data directory of a Host before T94: the v2 layout, its v2 backup, the retired device themes, two paired devices (the file has the shape of auth.ts, the hashes are fillers).
const FILES=['config.json','config.backup.json','device-themes.json','devices.json','device-assignments.json'];
function oldDirectory(t,{wide=6,devices=true,themes=true,assignments=false}={}){
  const dir=folder(t),write=(name,value)=>writeFileSync(join(dir,name),typeof value==='string'?value:JSON.stringify(value,null,1)+'\n');
  write('config.json',JSON.stringify(v2File({revision:41,wide}),null,2)+'\n');write('config.backup.json',JSON.stringify(v2File({revision:40,wide:null}))+'\n');
  if(devices)write('devices.json',{schemaVersion:1,devices:[{id:'aaaaaaaa',name:'Surface Pro 5',tokenHash:'a'.repeat(64),expiresAt:4e12},{id:'bbbbbbbb',name:'Test phone',tokenHash:'b'.repeat(64),expiresAt:4e12}]});
  if(themes)write('device-themes.json',{format:'keyln.device-themes',version:1,devices:{aaaaaaaa:{theme:'midnight'},bbbbbbbb:{theme:'theme-one'}}});
  if(assignments)write('device-assignments.json',{format:'keyln.device-assignments',version:1,devices:{cccccccc:{layout:'Other'}}});
  write('icon-library.json','{"icons":[]}');write('scripts.json','{"revision":0,"scripts":[]}');write('host.json','{"schemaVersion":1}');mkdirSync(join(dir,'tls'));write('tls/server.pem','pem');
  return dir;
}
const snapshot=dir=>Object.fromEntries(readdirSync(dir,{recursive:true}).filter(name=>statSync(join(dir,name)).isFile()).map(name=>[name,readFileSync(join(dir,name))]));
const run=(dir,argv)=>{const out=[],err=[],code=runMigrate(argv,dir,line=>out.push(line),line=>err.push(line));return {code,out:out.join('\n'),err:err.join('\n')};};
const backupFolder=dir=>readdirSync(dir).filter(name=>name.startsWith('migration-v3-'));
test('T94 migrate: v2 becomes v3 (library + one layout), the devices are assigned, the theme moves into the layout, every touched file is first copied byte for byte',t=>{
  const dir=oldDirectory(t),before=snapshot(dir),v2=C.parseConfig(JSON.parse(before['config.json']));
  const result=run(dir,['--device','aaaaaaaa']);assert.equal(result.code,0,result.err);assert.match(result.out,/Migrated config\.json to the v3 format/);assert.match(result.out,/aaaaaaaa/);
  const [name,...rest]=backupFolder(dir);assert.equal(rest.length,0);assert.match(name,/^migration-v3-\d{4}-\d{2}-\d{2}T/);assert.equal(statSync(join(dir,name)).mode&0o777,0o700);
  // backups: byte-identical copies of the five files (device-assignments.json did not exist)
  assert.deepEqual(readdirSync(join(dir,name)).sort(),['config.backup.json','config.json','device-themes.json','devices.json']);
  for(const file of readdirSync(join(dir,name)))assert.deepEqual(readFileSync(join(dir,name,file)),before[file],`${file} is an exact copy`);
  // the new files
  const doc=configurationFile(join(dir,'config.json'));assert.equal(JSON.parse(readFileSync(join(dir,'config.json'))).version,3);
  const expected=C.v2ToV3(v2,{layoutName:'Surface',theme:'midnight'});expected.library.revision=42;expected.layouts[0].revision=42;assert.deepEqual(doc,expected,'v2ToV3 of the old layout, both revisions the old revision + 1');
  assert.deepEqual(C.viewFor(doc,'Surface'),{...v2,revision:42,layoutName:'Surface',layoutRevision:42},'the page sees what it saw, key by key');
  assert.deepEqual(C.viewFor(doc,'Surface').widgets[0].columns,{wide:6,narrow:3});assert.equal(doc.layouts[0].theme,'midnight');assert.deepEqual(doc.library.customThemes,v2.customThemes);
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'device-assignments.json'))),{format:'keyln.device-assignments',version:1,devices:{aaaaaaaa:{layout:'Surface'}}});assert.deepEqual(JSON.parse(readFileSync(join(dir,MARKER))),{format:'keyln.config',version:3});
  assert.equal(existsSync(join(dir,'device-themes.json')),false,'moved into the backup folder');
  // everything else is untouched
  for(const file of ['config.backup.json','devices.json','icon-library.json','scripts.json','host.json','tls/server.pem'])assert.deepEqual(readFileSync(join(dir,file)),before[file],`${file} is as it was`);
  assert.deepEqual(readdirSync(dir).sort(),['config.backup.json','config.json','device-assignments.json','devices.json','host.json','icon-library.json',MARKER,name,'scripts.json','tls'].sort());
  // the Host can now run on it, a device shows its layout, the v2 backup is still readable and restorable
  const store=new ConfigStore(dir),assignments=new DeviceAssignments(dir);assert.equal(store.available,true);assert.equal(assignments.layoutOf('aaaaaaaa',store.layoutNames,store.defaultLayout),'Surface');assert.equal(store.theme(),'midnight');
  assert.equal(store.backupState().available,true);assert.deepEqual([store.backupState().revision,store.backupState().layouts],[40,1]);
  assert.equal(new Auth(dir).list().length,2,'devices stay paired');
  // a second run changes nothing and makes no second backup
  const after=snapshot(dir),again=run(dir,['--device','aaaaaaaa']);assert.equal(again.code,0);assert.match(again.out,/already in the v3 format/);assert.deepEqual(snapshot(dir),after);assert.equal(backupFolder(dir).length,1);
});
test('T94 migrate: the layout name and the devices are the command\'s choice; the theme is the first device\'s; a custom theme that is gone, or no device, means the default; assignments are kept',t=>{
  const named=oldDirectory(t,{assignments:true});assert.equal(run(named,['--layout','Surface Pro','--device','bbbbbbbb','--device','aaaaaaaa']).code,0);
  const doc=configurationFile(join(named,'config.json'));assert.deepEqual(doc.layouts.map(layout=>[layout.name,layout.theme]),[['Surface Pro','theme-one']],'the first device chose the custom theme, which exists');assert.equal(doc.defaultLayout,'Surface Pro');
  assert.deepEqual(JSON.parse(readFileSync(join(named,'device-assignments.json'))).devices,{cccccccc:{layout:'Other'},aaaaaaaa:{layout:'Surface Pro'},bbbbbbbb:{layout:'Surface Pro'}});
  assert.deepEqual(readFileSync(join(named,readdirSync(named).find(name=>name.startsWith('migration-v3-')),'device-themes.json')).length>0,true);
  const none=oldDirectory(t);assert.equal(run(none,[]).code,0);assert.equal(configurationFile(join(none,'config.json')).layouts[0].theme,'braun');assert.equal(existsSync(join(none,'device-assignments.json')),false,'no device, no assignment file');assert.equal(existsSync(join(none,'device-themes.json')),false,'the retired file still moves');
  const gone=oldDirectory(t);const text=JSON.parse(readFileSync(join(gone,'config.json')));delete text.customThemes;writeFileSync(join(gone,'config.json'),JSON.stringify(text));
  const r=run(gone,['--device','bbbbbbbb']);assert.equal(r.code,0);assert.equal(configurationFile(join(gone,'config.json')).layouts[0].theme,'braun');assert.match(r.out,/no longer exists; the default theme is used/);
  const damaged=oldDirectory(t);writeFileSync(join(damaged,'device-themes.json'),'{broken');const d=run(damaged,['--device','aaaaaaaa']);assert.equal(d.code,0);assert.match(d.out,/could not be read; the default theme is used/);assert.equal(configurationFile(join(damaged,'config.json')).layouts[0].theme,'braun');
});
test('T94 migrate refuses, naming the Pages widgets, while any Pages has no fixed keys per row (wide); nothing is written',t=>{
  const dir=oldDirectory(t,{wide:null}),before=snapshot(dir);
  const result=run(dir,['--device','aaaaaaaa']);assert.equal(result.code,1);assert.match(result.err,/"main"/);assert.doesNotMatch(result.err,/"side"/,'only the Pages widgets that are Auto are named');assert.match(result.err,/Auto/);assert.match(result.err,/Nothing was changed/);
  assert.deepEqual(snapshot(dir),before);assert.equal(backupFolder(dir).length,0);
  // a Pages widget with only a narrow value is still Auto on wide windows
  const narrow=JSON.parse(readFileSync(join(dir,'config.json')));narrow.widgets[0].columns={narrow:3};narrow.widgets[2].columns={narrow:2};writeFileSync(join(dir,'config.json'),JSON.stringify(narrow));
  const two=run(dir,[]);assert.equal(two.code,1);assert.match(two.err,/"main"/);assert.match(two.err,/"side"/,'every such Pages widget is named');
  // the dry run reports the same
  assert.equal(run(dir,['--dry-run']).code,1);assert.equal(backupFolder(dir).length,0);
});
test('T94 migrate refuses an unknown device, and a layout that is not v2; nothing is written',t=>{
  const dir=oldDirectory(t),before=snapshot(dir);
  const unknown=run(dir,['--device','aaaaaaaa','--device','dddddddd']);assert.equal(unknown.code,1);assert.match(unknown.err,/dddddddd/);assert.match(unknown.err,/devices\.json/);assert.deepEqual(snapshot(dir),before);
  const none=oldDirectory(t,{devices:false});assert.equal(run(none,['--device','aaaaaaaa']).code,1);assert.equal(backupFolder(none).length,0);assert.equal(run(none,[]).code,0,'no device given: nothing to look up');
  // arguments
  for(const argv of [['--device'],['--device','not-an-id'],['--device','AAAAAAAA'],['--layout'],['--layout',' x'],['--layout',''],['--layout','x'.repeat(41)],['--wat'],['aaaaaaaa'],['--device','--dry-run']]){const bad=run(oldDirectory(t),argv);assert.equal(bad.code,1,argv.join(' '));assert.match(bad.err,/refused/);}
  assert.deepEqual(parseMigrateArguments(['--device','aaaaaaaa','--device','aaaaaaaa','--layout','Home','--dry-run']),{devices:['aaaaaaaa'],layout:'Home',dryRun:true});assert.deepEqual(parseMigrateArguments([]),{devices:[],layout:'Surface',dryRun:false});assert.throws(()=>parseMigrateArguments(['--x']),MigrateError);
  const missing=folder(t);assert.equal(run(missing,[]).code,1);const odd=folder(t);writeFileSync(join(odd,'config.json'),JSON.stringify({format:'keyln.config',version:7}));assert.match(run(odd,[]).err,/only version 2 can be migrated/);
  const broken=folder(t);writeFileSync(join(broken,'config.json'),'{broken');assert.match(run(broken,[]).err,/cannot be read/);const v1=folder(t);writeFileSync(join(v1,'config.json'),JSON.stringify({format:'keyln.config',version:1,revision:1,canvas:{cols:8,rows:5},widgets:[]}));assert.match(run(v1,[]).err,/version 1/);
  const foreign=folder(t);writeFileSync(join(foreign,'config.json'),JSON.stringify({format:'other',version:2}));assert.match(run(foreign,[]).err,/not a Keyln layout/);
});
test('T94 migrate on a v3 directory says it is already migrated and writes nothing; --dry-run prints the plan and writes nothing; the data directory lock keeps it away from a running Host',t=>{
  const v3=folder(t);writeDoc(v3,twoLayouts());const before=snapshot(v3),r=run(v3,['--device','aaaaaaaa']);assert.equal(r.code,0);assert.match(r.out,/already in the v3 format/);assert.deepEqual(snapshot(v3),before);assert.equal(existsSync(join(v3,'host.lock')),false,'the lock is released');
  const dir=oldDirectory(t),old=snapshot(dir),dry=run(dir,['--dry-run','--device','aaaaaaaa','--layout','Home']);
  assert.equal(dry.code,0);assert.match(dry.out,/Dry run: nothing was written/);assert.match(dry.out,/library: 2 keys, revision 42/);assert.match(dry.out,/layout "Home": 3 widgets, 2 pages, theme midnight, revision 42/);assert.match(dry.out,/devices on this layout: aaaaaaaa/);assert.match(dry.out,/fixed keys-per-row \(wide\): checked/);
  assert.deepEqual(snapshot(dir),old);assert.equal(backupFolder(dir).length,0);assert.equal(existsSync(join(dir,'host.lock')),false);
  // a Host that holds the lock (here: this very process, alive) is not disturbed
  writeFileSync(join(dir,'host.lock'),String(process.pid));const held=run(dir,['--device','aaaaaaaa']);assert.equal(held.code,1);assert.match(held.err,/Another Keyln Host may be using this data directory/);
  assert.deepEqual(snapshot(dir),{...old,'host.lock':Buffer.from(String(process.pid))});assert.equal(backupFolder(dir).length,0);assert.equal(run(dir,['--dry-run']).code,1,'a dry run takes the lock too');
  rmSync(join(dir,'host.lock'));assert.equal(run(dir,['--device','aaaaaaaa']).code,0);
});
test('T94 migrate from the command line: npm run layout:migrate exits 0 when it migrates or has nothing to do and 1 when it refuses; the migrated directory starts a Host',t=>{
  const script='dist/apps/host/migrate.js',dir=oldDirectory(t,{wide:null}),env={...process.env,KEYLN_DATA_DIR:dir};
  const refused=spawnSync(process.execPath,[script,'--device','aaaaaaaa'],{env,encoding:'utf8'});assert.equal(refused.status,1);assert.match(refused.stderr,/Layout migration refused/);
  const fixed=JSON.parse(readFileSync(join(dir,'config.json')));fixed.widgets[0].columns={wide:6};writeFileSync(join(dir,'config.json'),JSON.stringify(fixed));
  const dry=spawnSync(process.execPath,[script,'--dry-run'],{env,encoding:'utf8'});assert.equal(dry.status,0);assert.match(dry.stdout,/Dry run/);assert.equal(backupFolder(dir).length,0);
  const done=spawnSync(process.execPath,[script,'--device','aaaaaaaa'],{env,encoding:'utf8'});assert.equal(done.status,0,done.stderr);assert.match(done.stdout,/Start Keyln again\. Devices stay paired\./);assert.equal(backupFolder(dir).length,1);
  const again=spawnSync(process.execPath,[script],{env,encoding:'utf8'});assert.equal(again.status,0);assert.match(again.stdout,/already in the v3 format/);
  assert.match(JSON.parse(readFileSync('package.json','utf8')).scripts['layout:migrate'],/node dist\/apps\/host\/migrate\.js/);
  const unknown=spawnSync(process.execPath,[script,'--device','dddddddd'],{env,encoding:'utf8'});assert.equal(unknown.status,0,'already migrated is checked first');
  const store=new ConfigStore(dir);assert.equal(store.available,true);assert.equal(new DeviceAssignments(dir).get('aaaaaaaa'),'Surface');assert.equal(store.revision,42);
});
test('T94 migrate does not write when it cannot back up: a backup that fails stops before config.json changes',t=>{
  const dir=oldDirectory(t),before=snapshot(dir);
  // config.backup.json is a directory: it is not a regular file, so it cannot be copied byte for byte
  rmSync(join(dir,'config.backup.json'));mkdirSync(join(dir,'config.backup.json'));const r=run(dir,['--device','aaaaaaaa']);
  assert.equal(r.code,1);assert.match(r.err,/not a regular file/);assert.deepEqual(readFileSync(join(dir,'config.json')),before['config.json'],'config.json was not changed');assert.equal(existsSync(join(dir,'device-assignments.json')),false);assert.equal(existsSync(join(dir,'device-themes.json')),true);
});

// ---- the page ----------------------------------------------------------------------------------------------------------------------------------
// The compiled client against the minimal DOM and a fake Host (tests/helpers/client-harness.mjs). `call.request` is what the page sent; `call.data` the candidate it describes.
const pageConfig=()=>layout([key('primary',APP,{},{label:'Calculator'}),key('other',APP,{},{label:'Other'})],{revision:4});
const worldOf=async(t,extra={})=>{
  const f=await client(t,{configuration:{...pageConfig(),layoutName:'Surface',layoutRevision:7},viewport:{width:1366,height:768},...extra});
  await f.until(()=>f.el('edit-layout').disabled===false&&f.sockets[0]?.readyState===1);await f.drain();return f;
};
const saves=f=>f.calls.filter(call=>call.path==='/api/configuration/save');
const rename=async(f,id,label)=>{f.button(id).emit('click');await f.drain();f.el('button-name').value=label;f.el('button-name').emit('input');await f.drain();};
const saveNow=async(f)=>{const before=saves(f).length;f.el('desk-save').emit('click');await f.until(()=>saves(f).length>before&&f.el('save-message').textContent==='Saved on your Mac.');await f.drain();return saves(f).at(-1);};
test('T94 page: a save sends only the changed part(s), each with the revision it was made on; the stale checks look at both revisions and the layout name',async t=>{
  const f=await worldOf(t);f.el('edit-layout').emit('click');await f.drain();
  // a key edit: the library part only
  await rename(f,'primary','Renamed');let call=await saveNow(f);
  assert.deepEqual(Object.keys(call.request).sort(),['layoutName','layoutRevision','library','libraryRevision']);assert.deepEqual([call.request.libraryRevision,call.request.layoutName,call.request.layoutRevision],[4,'Surface',7]);
  assert.deepEqual(call.request.library.keys.map(item=>[item.id,item.label,'size' in item]),[['primary','Renamed',false],['other','Other',false]]);assert.equal(call.request.library.keys[0].appearance===undefined,true);
  assert.equal(f.state.config.revision,5);assert.equal(f.state.config.layoutRevision,7);assert.equal(f.el('desk-save').hidden,true);
  // a layout edit (grid size): the layout part only, with the layout revision, and the library revision it holds is current
  f.el('grid-size').value='compact';f.el('grid-size').emit('change');await f.drain();call=await saveNow(f);
  assert.deepEqual(Object.keys(call.request).sort(),['layout','layoutName','layoutRevision','libraryRevision']);assert.equal(call.request.layout.gridSize,'compact');assert.doesNotMatch(JSON.stringify(call.request.layout.widgets),/label|action|icon/,'a layout holds placements, never key content');assert.deepEqual(C.placedKeyIds(call.request.layout.widgets),['primary','other']);
  assert.deepEqual([call.request.libraryRevision,call.request.layoutRevision],[5,7]);assert.equal(f.state.config.revision,5,'a layout edit leaves the library revision');assert.equal(f.state.config.layoutRevision,8);
  // both in one draft: both parts, one request
  await rename(f,'other','Both');f.el('grid-size').value='large';f.el('grid-size').emit('change');await f.drain();call=await saveNow(f);
  assert.deepEqual(Object.keys(call.request).sort(),['layout','layoutName','layoutRevision','library','libraryRevision']);assert.equal(f.state.config.revision,6);assert.equal(f.state.config.layoutRevision,9);
  // a save the Host refuses as stale keeps the draft and asks to load the latest
  await rename(f,'primary','Stale one');f.saveFault={code:'CONFIG_CONFLICT',status:409,message:'Changed'};f.el('desk-save').emit('click');await f.drain();await f.drain();
  assert.equal(f.el('reload-layout').hidden,false);assert.match(f.el('save-message').textContent,/Configuration changed on the Mac/);assert.equal(f.el('button-name').value,'Stale one');
});
test('T94 page: another device changing the layout (or the library) makes an open draft stale and a state event re-syncs; a layout name change is stale too',async t=>{
  const f=await worldOf(t);f.el('edit-layout').emit('click');await f.drain();await rename(f,'primary','Mine');
  assert.equal(f.el('reload-layout').hidden,true);const calls=f.count('configuration');
  // only the layout revision moved on the Mac: an event with the new layout revision makes the page load it
  f.state={...f.state,config:{...f.state.config,layoutRevision:8}};f.sockets[0].state();await f.until(()=>f.count('configuration')>calls);await f.drain();
  assert.equal(f.el('reload-layout').hidden,true,'the draft only renamed a key, so a newer layout revision does not block it (ADR-086 decision 11)');assert.equal(f.el('layout-warning').hidden,true);assert.equal(f.el('button-name').value,'Mine','the draft is kept');
  // the draft only edits a key, so it carries the library part: it saves against the library revision and the layout revision it was made on (the Host decides, it did not change a key)
  const kept=await saveNow(f);assert.deepEqual(Object.keys(kept.request).sort(),['layoutName','layoutRevision','library','libraryRevision']);assert.deepEqual([kept.request.libraryRevision,kept.request.layoutRevision],[4,7]);
  assert.equal(f.state.config.revision,5);assert.equal(f.state.config.layoutRevision,8);assert.equal(f.el('reload-layout').hidden,true,'saved: the draft starts again from both revisions');
  // the library moved on the Mac: an open draft is stale again, and loading the latest starts over
  await rename(f,'primary','Mine again');const before=f.count('configuration');f.state={...f.state,config:{...f.state.config,revision:9}};f.sockets[0].state();await f.until(()=>f.count('configuration')>before);await f.drain();
  assert.equal(f.el('reload-layout').hidden,false);assert.equal(f.el('button-name').value,'Mine again');
  f.el('reload-layout').emit('click');await f.drain();f.el('confirm-yes').emit('click');await f.until(()=>f.el('save-message').textContent==='Latest saved layout loaded.');await f.drain();assert.equal(f.el('desk-save').hidden,true);assert.equal(f.el('reload-layout').hidden,true);
  await f.until(()=>f.sockets.at(-1).readyState===1);
  // a state event that changes nothing does not load anything
  const quiet=f.count('configuration');f.sockets.at(-1).state();await f.drain();await f.drain();assert.equal(f.count('configuration'),quiet);
  // the layout the device shows changed (another name): stale even with the same numbers
  await rename(f,'primary','Third');const named=f.count('configuration');f.state={...f.state,config:{...f.state.config,layoutName:'Phone'}};f.sockets.at(-1).state({revision:f.state.config.revision+1});await f.until(()=>f.count('configuration')>named);await f.drain();
  assert.equal(f.el('reload-layout').hidden,false);
});
test('T94 page: a draft that only changed the layout is not blocked when another device edits a key, and its save sends the layout part alone',async t=>{
  const f=await worldOf(t);f.el('edit-layout').emit('click');await f.drain();
  f.el('grid-size').value='large';f.el('grid-size').emit('change');await f.drain();assert.equal(f.el('desk-save').hidden,false);
  const calls=f.count('configuration');f.state={...f.state,config:{...f.state.config,revision:f.state.config.revision+1}};f.sockets[0].state();await f.until(()=>f.count('configuration')>calls);await f.drain();
  assert.equal(f.el('reload-layout').hidden,true);assert.equal(f.el('layout-warning').hidden,true);assert.equal(f.el('grid-size').value,'large','the draft is kept');
  const call=await saveNow(f);assert.deepEqual(Object.keys(call.request).sort(),['layout','layoutName','layoutRevision','libraryRevision']);
});
test('T94 page: a theme chosen here raises only the layout revision; the page and an open draft adopt it, keep the draft\'s edits, and the next save is not stale',async t=>{
  const f=await worldOf(t,{deviceTheme:'braun'});f.el('edit-layout').emit('click');await f.drain();await rename(f,'primary','Draft edit');
  assert.equal(f.el('desk-save').hidden,false);const syncs=f.count('configuration');
  f.el('theme-picker').children.find(node=>node.dataset.themeChoice==='classic').emit('click');await f.until(()=>f.deviceTheme==='classic');await f.drain();await f.drain();
  assert.equal(f.state.config.layoutRevision,8,'the fake Host raised the layout revision');assert.equal(f.state.config.revision,4);
  assert.equal(f.count('configuration'),syncs,'the page took the revision from the answer: no reload');assert.equal(f.el('reload-layout').hidden,true,'the draft is not stale because of this page\'s own theme change');
  assert.equal(f.el('button-name').value,'Draft edit');assert.equal(f.el('desk-save').hidden,false);assert.equal(f.el('desk-save').disabled,false);
  const call=await saveNow(f);assert.deepEqual([call.request.libraryRevision,call.request.layoutRevision],[4,8],'the save holds the adopted layout revision');assert.equal(C.findComponent(f.state.config,'primary').label,'Draft edit');
  assert.equal(f.state.config.layoutRevision,8,'a key edit leaves the layout revision');
  // an event that carries the revision already adopted is not a change
  const quiet=f.count('configuration');f.sockets[0].state();await f.drain();await f.drain();assert.equal(f.count('configuration'),quiet);
});
test('T94 page: an import is reviewed as the layout this device will show, edited in the draft, and sent as the whole document with the library revision it was reviewed on',async t=>{
  const f=await worldOf(t);const doc=C.v2ToV3(pageConfig(),{layoutName:'Surface'});doc.library.keys.push({id:'extra',kind:'key',label:'Extra',icon:'app',action:null});doc.layouts.push({name:'Phone',revision:3,theme:'metro',gridSize:'compact',widgets:[onePage(placement('extra'))]});doc.library.revision=4;
  f.el('layout-files-open').emit('click');const file={name:'x.json',size:10,arrayBuffer:async()=>new TextEncoder().encode(JSON.stringify(doc)).buffer};f.el('layout-import-file').files=[file];f.el('layout-import-file').emit('change');
  await f.until(()=>!f.el('layout-import-preview').hidden);assert.match(f.el('layout-import-summary').textContent,/3 keys · 2 layouts · 0 workflows/);
  f.el('layout-import-load').emit('click');await f.drain();assert.equal(f.el('desk').dataset.editing,'true');
  await rename(f,'primary','Edited in the import draft');f.el('desk-save').emit('click');await f.drain();f.el('confirm-yes').emit('click');
  await f.until(()=>f.count('configuration/import')===1&&f.el('save-message').textContent==='Saved on your Mac.');
  const sent=f.calls.find(call=>call.path==='/api/configuration/import').data;assert.equal(sent.version,3);assert.equal(sent.library.revision,4);assert.deepEqual(sent.layouts.map(layout=>layout.name),['Surface','Phone'],'the whole document: every layout of the file');
  assert.equal(sent.library.keys.find(item=>item.id==='primary').label,'Edited in the import draft',"the draft's edit is in the document");assert.equal(f.imported.layouts.length,2);assert.equal(f.state.config.layoutName,'Surface');
  assert.equal(f.count('configuration/save'),0);
});
