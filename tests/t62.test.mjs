import {responsiveBoxes} from './helpers/responsive-boxes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,readdirSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {request} from 'node:https';
import {randomUUID} from 'node:crypto';
import {Auth} from '../dist/apps/host/auth.js';
import {ConfigStore} from '../dist/apps/host/store.js';
import {Scheduler} from '../dist/apps/host/scheduler.js';
import {Confirmations} from '../dist/apps/host/confirmations.js';
import {DeviceAssignments} from '../dist/apps/host/device-assignments.js';
import {archiveLegacyData,MARKER} from '../dist/apps/host/archive.js';
import {createHost} from '../dist/apps/host/server.js';
import {LocalAdmin} from '../dist/apps/host/admin.js';
import {importPreview} from '../dist/apps/host/layout.js';
import * as C from '../dist/packages/contracts/index.js';
import {planZones,usableWindow} from '../dist/apps/web/zones.js';
import {moveWidget,moveToPage,resizeWidget,addWidget,removeWidget,containerOf} from '../dist/apps/web/page-layout.js';
import {client} from './helpers/client-harness.mjs';
import {key,group,display,layout,withComponents,components,fromGrid} from './helpers/layout.mjs';
import {saveRequest} from './helpers/save.mjs';

// T62 (ADR-064): the one shared configuration (canvas, widgets, Pages widget), the theme each device chooses, the theme's zones, archiving the old files, execution on
// the new model, Use mode (zones, scale, pages, drag by whole cells) and component files. Docs/verification/T62.md lists what is checked here and what is not.
const fault=code=>error=>error.code===code;
const bad=(value,code='INVALID_INPUT')=>assert.throws(()=>C.parseConfig(value),fault(code));
const clone=value=>JSON.parse(JSON.stringify(value));
const base=()=>clone(C.initialView());
const pagesOf=config=>config.widgets.find(widget=>widget.kind==='pages');
const open=(config,...widgets)=>{const next=clone(config);next.widgets=[...widgets];return next;};
// A page of the default Pages widget holding exactly these widgets, which carry their own cells (nothing is flowed or checked before the parser sees it).
const onPage=(...widgets)=>open(base(),{...pagesOf(base()),pages:[{id:'page-1',name:'Page 1',widgets}]});

// ---- the format --------------------------------------------------------------------------------------------------------------------------------

test('size tiers: S 1×1, M 2×1, L 2×2, XL 4×2, Tall 1×2, Wide 4×1; anything else is refused',()=>{
  assert.deepEqual(C.sizeTiers,['S','M','L','XL','Tall','Wide']);
  assert.deepEqual(C.TIER_SPAN,{S:{cols:1,rows:1},M:{cols:2,rows:1},L:{cols:2,rows:2},XL:{cols:4,rows:2},Tall:{cols:1,rows:2},Wide:{cols:4,rows:1}});
  for(const tier of C.sizeTiers){const config=layout([key('k',null,{size:tier})]);assert.deepEqual(C.parseConfig(config),config,tier);}
  for(const wrong of ['XXL','s','','1x1',undefined,1,null,{cols:1,rows:1}])bad(onPage({...key('k'),size:wrong}));
});



test('ids are unique across the whole configuration, including pages; fields are strict',()=>{
  const config=layout([key('k1'),key('k2')]);
  bad({...config,widgets:[{...pagesOf(config),pages:[{...pagesOf(config).pages[0],widgets:[...pagesOf(config).pages[0].widgets,{...key('k1'),}]}]}]});
  bad({...config,widgets:[{...pagesOf(config),pages:[{id:'main',name:'same as the widget',widgets:[]}]}]});
  bad({...config,extra:1});bad({...config,theme:'metro'});bad({...config,pages:[]});bad({...config,components:[]});
  bad({...config,version:3},'CONFIG_VERSION');bad({...config,format:'keyln.layout'},'CONFIG_VERSION');bad({schemaVersion:10,profiles:[],buttons:[]},'CONFIG_VERSION');
  const strict=mutate=>{const next=clone(config);mutate(pagesOf(next).pages[0].widgets[0]);bad(next);};
  strict(w=>{w.frame={x:0,y:0,w:120,h:120};});strict(w=>{w.pageId='main';});strict(w=>{w.position=0;});strict(w=>{delete w.size;});strict(w=>{w.cell={x:0,y:0};});strict(w=>{delete w.action;});
  strict(w=>{w.items=[];});strict(w=>{w.kind='nope';});
});
test('system components are not in the configuration; the other widgets and their forms are',()=>{
  for(const kind of ['mode-switch','settings','connection','result-activity'])bad(layout([{id:'s',kind,size:'S',form:'segmented'}]));
  const ok=[display('c','clock','time',{x:4,y:0,size:'M'}),
    display('f','refresh','button',{x:6,y:0,size:'S'}),display('t','text','title',{x:0,y:2,size:'M'},{text:'Hello'})];
  assert.deepEqual(C.parseConfig(layout(ok)),layout(ok));
  for(const [kind,forms] of Object.entries(C.DISPLAY_FORMS))for(const form of forms){const w=display('w',kind,form,{x:0,y:0},kind==='text'?{text:'x'}:{});C.parseConfig(layout([w]));}
  bad(layout([display('c','clock','tabs')]));bad(layout([display('t','text','title',{},{})]));bad(layout([display('c','clock','time',{},{text:'no text here'})]));
  bad(layout([display('t','text','title',{},{text:'x'.repeat(81)})]));C.parseConfig(layout([display('t','text','title',{},{text:'x'.repeat(80)})]));C.parseConfig(layout([display('t','text','note',{},{text:''})]));
  bad(layout([display('t','text','title',{},{text:'two\nlines'})]));
});



// ---- theme zones -------------------------------------------------------------------------------------------------------------------------------
test('every built-in theme has valid zones in the wide and the narrow set: components inside the window, apart from each other and from the content area',()=>{
  assert.deepEqual(Object.keys(C.THEME_LAYOUTS).sort(),[...C.themes].sort());
  for(const theme of C.themes){
    const layout=C.THEME_LAYOUTS[theme];
    assert.equal(C.zoneProblem(layout.wide,C.ZONE_CHECK_WINDOWS.wide),undefined,`${theme} wide`);assert.equal(C.zoneProblem(layout.narrow,C.ZONE_CHECK_WINDOWS.narrow),undefined,`${theme} narrow`);
    assert.deepEqual(C.parseThemeLayout(clone(layout)),layout,`${theme} round-trips through the strict parser`);
    for(const set of ['wide','narrow'])for(const part of C.SYSTEM_PARTS){
      const slot=layout[set].slots[part];assert.ok(C.SYSTEM_FORMS[part].includes(slot.form),`${theme} ${set} ${part} form`);
      assert.ok(Object.keys(slot).filter(name=>['left','right'].includes(name)).length===1&&Object.keys(slot).filter(name=>['top','bottom'].includes(name)).length===1,'anchored to one side and the top or bottom');
      // T97: the wide bars are 52px tall with a 200 x 36 capsule, a 140 x 40 switch and a 40 x 40 gear; the phone bar keeps its 44px controls.
      const least=set==='wide'?{w:40,h:36}:{w:44,h:40};assert.ok(slot.w>=least.w||slot.form==='dot'||slot.form==='segmented'&&slot.w>=96,'touch targets');assert.ok(slot.h>=least.h);
    }
  }
});
test('the zones follow the window width: 600px or less is narrow, 601px or more is wide; the plan places the components from the window edges',()=>{
  assert.equal(C.NARROW_MAX_WIDTH,600);
  const layout=C.THEME_LAYOUTS.braun;
  assert.equal(C.zoneSetFor(layout,600),layout.narrow);assert.equal(C.zoneSetFor(layout,601),layout.wide);assert.equal(C.zoneSetFor(layout,320),layout.narrow);assert.equal(C.zoneSetFor(layout,1920),layout.wide);
  const wide=planZones(layout,{width:1366,height:768}),narrow=planZones(layout,{width:411,height:860});
  assert.equal(wide.set,'wide');assert.equal(narrow.set,'narrow');
  // Braun wide (T97): a 52px bar; the connection capsule on the left, the Use|Edit switch and the gear on the right; the canvas below the bar.
  assert.equal(wide.zones.header,52);assert.deepEqual(wide.slots.connection,{x:28,y:8,w:200,h:36,form:'capsule'});
  assert.equal(wide.slots.settings.x,1366-28-40);assert.equal(wide.slots['mode-switch'].x,1366-28-40-12-140);assert.deepEqual(wide.content,{x:0,y:52,w:1366,h:768-52},'T97: the content area reaches the window edges on the left, right and bottom; the canvas keeps its own 1u');assert.equal(wide.slots.connection.x,28,'the bar controls keep their 28px');
  assert.equal(narrow.slots.connection.form,'dot-button');assert.equal(narrow.slots['mode-switch'].form,'icon');assert.equal(narrow.slots.settings.x,411-8-44);
  // The Widget theme has no bar: three round controls float in the top corners.
  const widget=planZones(C.THEME_LAYOUTS.widget,{width:1366,height:768});assert.equal(widget.zones.header,0);assert.equal(widget.content.y,52,'T97: a wide Widget window starts the canvas right under the three controls');assert.equal(planZones(C.THEME_LAYOUTS.widget,{width:411,height:860}).content.y,60,'the phone layout is unchanged');assert.equal(widget.slots.settings.x,1366-12-44);
  // The safe area moves everything in.
  const inset=usableWindow({width:1000,height:700},{top:20,right:30,bottom:34,left:10});assert.deepEqual(inset,{width:960,height:646});
  assert.equal(C.slotRect({form:'gear',w:44,h:44,right:10,bottom:10},{width:200,height:100}).y,100-10-44);
  // The Edit bar keeps the foot of the content area free.
  assert.equal(planZones(layout,{width:1366,height:768},undefined,96).content.h,768-52-96);
});
test('a custom theme can carry its own zones: strictly checked; without them it uses its base theme\'s; a missing theme falls back to Braun',()=>{
  const theme=(extra={})=>({id:'theme-one',name:'One',base:'metro',accent:'#F26B1D',background:'#101216',keyBody:'#1E2124',radius:'rounded',spacing:'normal',font:'metro',...extra});
  assert.deepEqual(C.parseCustomThemes([theme()]),[theme()]);
  const own=clone(C.THEME_LAYOUTS.classic);own.wide.content.bottom=60;
  const parsed=C.parseCustomThemes([theme({layout:own})]);assert.deepEqual(parsed[0].layout,own);
  const overlapping=clone(own);overlapping.wide.slots.settings=clone(overlapping.wide.slots.connection);overlapping.wide.slots.settings.form='gear';
  assert.throws(()=>C.parseCustomThemes([theme({layout:overlapping})]),fault('INVALID_INPUT'));
  const outside=clone(own);outside.wide.slots.settings.right=-5;assert.throws(()=>C.parseCustomThemes([theme({layout:outside})]),fault('INVALID_INPUT'));
  const both=clone(own);both.wide.slots.settings.left=4;assert.throws(()=>C.parseCustomThemes([theme({layout:both})]),fault('INVALID_INPUT'));
  const form=clone(own);form.narrow.slots.settings.form='dot';assert.throws(()=>C.parseCustomThemes([theme({layout:form})]),fault('INVALID_INPUT'));
  const tiny=clone(own);tiny.wide.content.left=1300;assert.throws(()=>C.parseCustomThemes([theme({layout:tiny})]),fault('INVALID_INPUT'));
  assert.throws(()=>C.parseCustomThemes([theme({layout:{wide:own.wide}})]),fault('INVALID_INPUT'));assert.throws(()=>C.parseCustomThemes([theme({layout:{...own,extra:1}})]),fault('INVALID_INPUT'));
  assert.deepEqual(C.resolveTheme('theme-one',parsed).layout,own);assert.equal(C.resolveTheme('theme-one',[theme()]).layout,C.THEME_LAYOUTS.metro);assert.equal(C.resolveTheme('theme-one',[theme()]).name,'metro');
  assert.equal(C.resolveTheme('theme-gone',[theme()]).name,'braun');assert.equal(C.resolveTheme(undefined,undefined).choice,'braun');assert.equal(C.resolveTheme('midnight',undefined).layout,C.THEME_LAYOUTS.midnight);assert.equal(C.resolveTheme('nonsense',[]).name,'braun');
  // The definitions are shared in the configuration; the choice is not.
  const config=C.withCustomThemes(C.initialView(),[theme()]);assert.equal(C.parseConfig(config).customThemes[0].id,'theme-one');assert.equal(Object.hasOwn(C.withCustomThemes(config,[]),'customThemes'),false);
});

// ---- the theme of each device ------------------------------------------------------------------------------------------------------------------
const dir=t=>{const value=mkdtempSync(join(tmpdir(),'keyln-t62-'));t.after(()=>rmSync(value,{recursive:true,force:true}));return value;};
// T94: device-themes.json is retired. Which layout a device shows is device-assignments.json (the same damaged-file handling as the old theme file had);
// the theme is a field of the layout.
test('device assignments: each device keeps its layout in device-assignments.json; the default layout until it has one; a missing layout means the default',t=>{
  const folder=dir(t),assignments=new DeviceAssignments(folder),names=['Surface','Phone'];
  assert.equal(assignments.get('aaaaaaaa'),undefined);assert.equal(assignments.layoutOf('aaaaaaaa',names,'Surface'),'Surface');
  assert.equal(assignments.set('aaaaaaaa','Phone'),'Phone');assert.equal(assignments.set('bbbbbbbb','Surface'),'Surface');
  assert.equal(assignments.layoutOf('aaaaaaaa',names,'Surface'),'Phone');assert.equal(assignments.layoutOf('bbbbbbbb',names,'Surface'),'Surface');assert.equal(assignments.layoutOf('cccccccc',names,'Surface'),'Surface');
  assert.deepEqual(JSON.parse(readFileSync(join(folder,'device-assignments.json'),'utf8')),{format:'keyln.device-assignments',version:1,devices:{aaaaaaaa:{layout:'Phone'},bbbbbbbb:{layout:'Surface'}}});
  assert.throws(()=>assignments.set('aaaaaaaa',' Padded ',[]),fault('INVALID_INPUT'));assert.throws(()=>assignments.set('aaaaaaaa','',[]),fault('INVALID_INPUT'));assert.throws(()=>assignments.set('not-an-id','Phone'),fault('INVALID_INPUT'));
  assert.equal(assignments.layoutOf('aaaaaaaa',['Surface'],'Surface'),'Surface','a layout that no longer exists means the default');
  assert.equal(new DeviceAssignments(folder).get('bbbbbbbb'),'Surface','kept across a restart');
  // Giving a device what it already has writes nothing.
  const before=readFileSync(join(folder,'device-assignments.json'));assignments.set('bbbbbbbb','Surface');assert.deepEqual(readFileSync(join(folder,'device-assignments.json')),before);
  // A damaged file is kept aside and the Host starts with every device on the default layout.
  writeFileSync(join(folder,'device-assignments.json'),'{"broken":');const logs=[];const damaged=new DeviceAssignments(folder,message=>logs.push(message));
  assert.equal(damaged.get('bbbbbbbb'),undefined);assert.ok(damaged.damagedCopy&&existsSync(damaged.damagedCopy));assert.equal(logs.length,1);
  assert.throws(()=>C.parseDeviceAssignmentFile({format:'keyln.device-assignments',version:1,devices:{aaaaaaaa:{layout:'Phone',extra:1}}}),fault('INVALID_INPUT'));
  assert.throws(()=>C.parseDeviceAssignmentFile({format:'keyln.device-assignments',version:2,devices:{}}),fault('INVALID_INPUT'));
  // The retired device-themes file keeps its parser for the migration command, with its old strictness.
  assert.throws(()=>C.parseDeviceThemeFile({format:'keyln.device-themes',version:1,devices:{aaaaaaaa:{theme:'metro',extra:1}}}),fault('INVALID_INPUT'));
  assert.throws(()=>C.parseDeviceThemeFile({format:'keyln.device-themes',version:2,devices:{}}),fault('INVALID_INPUT'));
});
test('the theme belongs to the layout: the default until it is chosen; a custom theme must exist; the same theme writes nothing; only the layout revision goes up',t=>{
  const folder=dir(t),store=new ConfigStore(folder),custom=[{id:'theme-a',name:'A',base:'braun',accent:'#F26B1D',background:'#101216',keyBody:'#1E2124',radius:'rounded',spacing:'normal',font:'braun'}];
  assert.equal(store.theme(),'braun');const library=store.revision,layout=store.layoutRevision();
  assert.deepEqual(store.setTheme('Surface','metro'),{theme:'metro',layoutName:'Surface',previousLayoutRevision:layout,layoutRevision:layout+1});assert.equal(store.theme(),'metro');assert.equal(store.revision,library,'the library revision does not move');
  assert.throws(()=>store.setTheme('Surface','nonsense'),fault('INVALID_INPUT'));assert.throws(()=>store.setTheme('Surface','theme-a'),fault('INVALID_INPUT'));
  const bytes=readFileSync(store.path);assert.deepEqual(store.setTheme('Surface','metro'),{theme:'metro',layoutName:'Surface',previousLayoutRevision:layout+1,layoutRevision:layout+1});assert.deepEqual(readFileSync(store.path),bytes,'the same theme writes nothing');
  store.setCustomThemes(custom,library);assert.deepEqual(store.setTheme('Surface','theme-a'),{theme:'theme-a',layoutName:'Surface',previousLayoutRevision:layout+1,layoutRevision:layout+2});assert.equal(store.theme(),'theme-a');
  store.setCustomThemes([],store.revision);assert.equal(store.theme(),null,'a deleted custom theme means the default');
  assert.equal(new ConfigStore(folder).get().layoutRevision,layout+2,'kept across a restart');
  assert.equal(existsSync(store.backup),true);const backup=JSON.parse(readFileSync(store.backup));store.setTheme('Surface','midnight');assert.deepEqual(JSON.parse(readFileSync(store.backup)),backup,'a theme change does not replace the backup of the last saved layout');
});
async function fixture(t,{run}={}){
  const folder=dir(t);execFileSync(process.execPath,['scripts/setup.mjs'],{env:{...process.env,KEYLN_DATA_DIR:folder},stdio:'pipe'});
  const auth=new Auth(folder),admin=new LocalAdmin(),store=new ConfigStore(folder,true),assignments=new DeviceAssignments(folder);
  let calls=0;const scheduler=new Scheduler({run:async(...args)=>{calls++;return run?await run(...args):{ok:true,message:'Fake only'};}});
  const origin='https://127.0.0.1:0',ca=readFileSync(join(folder,'tls/rootCA.pem'));
  const server=createHost({auth,admin,store,scheduler,assignments,origin,apps:[{id:'test.app',name:'Test app'}],onPair:()=>{},tls:{key:readFileSync(join(folder,'tls/server.key')),cert:readFileSync(join(folder,'tls/server.pem'))}});
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  t.after(async()=>{scheduler.stop();await scheduler.settled();server.stopEvents();server.closeAllConnections();await new Promise(yes=>server.close(yes));});
  const connection={hostname:'127.0.0.1',servername:'',port:server.address().port,ca};
  const send=(path,input={},cookie='',overrides={})=>new Promise((yes,no)=>{
    const req=request({...connection,path,method:'POST',headers:{host:'127.0.0.1:0',origin,'content-type':'application/json','x-keyln-client':'1',cookie,...overrides}},res=>{let body='';res.setEncoding('utf8');res.on('data',part=>body+=part);res.on('end',()=>yes({status:res.statusCode,body,data:JSON.parse(body)}));});
    req.on('error',no);req.end(JSON.stringify(input));});
  const device=name=>{const p=auth.begin(auth.invite(),name);auth.approve(p.id);return {id:p.id,cookie:`__Host-keyln=${auth.claim(p.id,p.claim).token}`};};
  return {folder,store,auth,assignments,send,device,scheduler,get calls(){return calls;}};
}
test('device theme routes: only paired devices, only the theme of their own layout (the id comes from the cookie), strict input, custom themes checked against the shared list',async t=>{
  const f=await fixture(t),one=f.device('One'),two=f.device('Two');
  // T94: the theme is the layout's. Device two shows another layout, so what it chooses never touches device one.
  const doc=f.store.document();doc.layouts.push({...clone(doc.layouts[0]),name:'Phone'});f.store.importDocument(doc,f.store.documentStamp(),[]);f.assignments.set(two.id,'Phone');
  for(const path of ['/api/device-theme','/api/device-theme/save'])assert.equal((await f.send(path,path.endsWith('save')?{theme:'metro'}:{})).status,401);
  assert.equal((await f.send('/api/device-theme',{},one.cookie,{origin:'https://evil.example'})).status,403);
  assert.deepEqual((await f.send('/api/device-theme',{},one.cookie)).data,{theme:'braun'},'a layout always has a theme: the default until one is chosen');
  const library=f.store.revision,layout=f.store.layoutRevision('Surface');
  assert.deepEqual((await f.send('/api/device-theme/save',{theme:'midnight',layoutName:'Surface'},one.cookie)).data,{theme:'midnight',layoutName:'Surface',previousLayoutRevision:layout,layoutRevision:layout+1},'the layout baseline and revision are returned for the page to adopt safely');
  assert.equal(f.store.revision,library,'the library revision does not move');
  assert.equal((await f.send('/api/device-theme',{},one.cookie)).data.theme,'midnight');assert.equal((await f.send('/api/device-theme',{},two.cookie)).data.theme,'braun','a device on another layout is not affected');
  // The request cannot name another device, nor carry more than the theme.
  assert.equal((await f.send('/api/device-theme/save',{theme:'widget',layoutName:'Surface',deviceId:two.id},one.cookie)).status,400);assert.equal((await f.send('/api/device-theme',{deviceId:two.id},one.cookie)).status,400);
  const after=readFileSync(f.store.path);
  assert.equal((await f.send('/api/device-theme/save',{theme:'metro'},one.cookie)).data.error.code,'CONFIG_VERSION','old pages must reload before changing a theme');
  assert.equal((await f.send('/api/device-theme/save',{theme:'metro',layoutName:'Phone'},one.cookie)).data.error.code,'CONFIG_CONFLICT');assert.deepEqual(readFileSync(f.store.path),after);
  assert.equal((await f.send('/api/device-theme',{},two.cookie)).data.theme,'braun');
  assert.equal((await f.send('/api/device-theme/save',{theme:'nonsense',layoutName:'Surface'},one.cookie)).status,400);assert.equal((await f.send('/api/device-theme/save',{theme:'theme-gone',layoutName:'Surface'},one.cookie)).status,400);
  assert.equal((await f.send('/api/device-theme/save',{},one.cookie)).status,400);
  // A custom theme is shared through the key library (its own revision), and chosen per layout.
  const theme={id:'theme-a',name:'A',base:'metro',accent:'#F26B1D',background:'#101216',keyBody:'#1E2124',radius:'rounded',spacing:'normal',font:'metro'};
  const revision=f.store.revision,saved=await f.send('/api/configuration/themes',{customThemes:[theme],revision},one.cookie);
  assert.equal(saved.status,200);assert.equal(saved.data.config.revision,revision+1);assert.deepEqual(saved.data.config.customThemes,[theme]);
  assert.equal((await f.send('/api/configuration/themes',{customThemes:[theme],revision},one.cookie)).status,409,'a stale revision conflicts');
  assert.equal((await f.send('/api/configuration/themes',{customThemes:[theme],revision:revision+1},one.cookie)).data.config.revision,revision+1,'the same list changes nothing');
  assert.equal((await f.send('/api/configuration/theme',{theme:'metro',revision:revision+1},one.cookie)).status,404,'the shared theme route is gone');
  assert.equal((await f.send('/api/device-theme/save',{theme:'theme-a',layoutName:'Phone'},two.cookie)).data.theme,'theme-a');
  assert.equal((await f.send('/api/device-theme',{},one.cookie)).data.theme,'midnight','the other layout kept its own');
  // Deleting the custom theme sends the layouts that used it back to the default.
  assert.equal((await f.send('/api/configuration/themes',{customThemes:[],revision:revision+1},one.cookie)).status,200);
  assert.equal((await f.send('/api/device-theme',{},two.cookie)).data.theme,null);
  for(const gone of ['/api/device-layout','/api/device-layout/save','/api/theme-canvases','/api/theme-canvases/save','/api/state','/api/config'])assert.equal((await f.send(gone,{},one.cookie)).status,404,`${gone} is gone`);
  assert.equal((await f.send('/api/configuration',{},one.cookie)).data.config.format,'keyln.config');
  assert.equal((await f.send('/api/configuration',{},two.cookie)).data.config.layoutName,'Phone','the device sees its own layout');
});

// ---- the old files -----------------------------------------------------------------------------------------------------------------------------
test('start-up archives every file the new format cannot read (T58 configuration, backups, device layouts, theme canvases) and preserves My icons and keeps certificates, pairing, scripts and host.json',t=>{
  const folder=dir(t),write=(name,value)=>writeFileSync(join(folder,name),typeof value==='string'?value:JSON.stringify(value));
  mkdirSync(join(folder,'tls'));write('tls/server.pem','pem');write('devices.json',{schemaVersion:1,devices:[]});write('scripts.json',{revision:0,scripts:[]});write('host.json',{schemaVersion:1});
  const t58={format:'keyln.layout',version:1,revision:3,pages:[{id:'main',name:'Page 1',size:{w:480,h:360},snap:120}],components:[]};
  write('config.json',t58);write('config.backup.json',t58);write('config.before-restore-1-x.json',{schemaVersion:10,profiles:[],buttons:[]});
  write('device-layouts.json',{format:'keyln.device-layouts',version:1,devices:{},meta:{}});write('device-layouts.backup.json',{});write('device-layouts.2026-01-01.corrupt','{');
  write('theme-canvases.json',{format:'keyln.theme-canvases',version:1,themes:{}});write('icon-library.json',{icons:[]});
  const logs=[],folderMade=archiveLegacyData(folder,message=>logs.push(message),()=>Date.UTC(2026,9,23,1,2,3));
  assert.ok(folderMade&&folderMade.endsWith('archive-2026-10-23T01-02-03-000Z'),folderMade);
  assert.deepEqual(readdirSync(folderMade).sort(),['config.backup.json','config.before-restore-1-x.json','config.json','device-layouts.2026-01-01.corrupt','device-layouts.backup.json','device-layouts.json','theme-canvases.json']);
  for(const kept of ['tls','devices.json','scripts.json','host.json','icon-library.json'])assert.ok(existsSync(join(folder,kept)),`${kept} stays`);
  for(const moved of ['config.json','config.backup.json','device-layouts.json','theme-canvases.json'])assert.equal(existsSync(join(folder,moved)),false,`${moved} moved`);
  assert.deepEqual(JSON.parse(readFileSync(join(folder,MARKER),'utf8')),{format:'keyln.config',version:3});assert.equal(logs.length,1);
  assert.deepEqual(JSON.parse(readFileSync(join(folderMade,'config.json'),'utf8')),t58,'not converted, not changed');
  // The Host then starts on the default configuration.
  const store=new ConfigStore(folder);assert.deepEqual(store.get(),C.initialView());
  // Files of the new format are never moved, and a second start archives nothing.
  assert.equal(archiveLegacyData(folder,()=>{}),undefined);write('icon-library.json',{icons:[]});assert.equal(archiveLegacyData(folder,()=>{}),undefined,'My icons stays through every upgrade');assert.ok(existsSync(join(folder,'icon-library.json')));
  assert.deepEqual(new ConfigStore(folder).get(),C.initialView());
});
test('archiving leaves a damaged (non-JSON) configuration for the store to keep and recover, and never touches a current one',t=>{
  const folder=dir(t);writeFileSync(join(folder,'config.json'),'{"broken":');
  assert.equal(archiveLegacyData(folder,()=>{}),undefined);assert.equal(readFileSync(join(folder,'config.json'),'utf8'),'{"broken":');
  const second=dir(t);const config=C.initialView();writeFileSync(join(second,'config.json'),JSON.stringify(config));
  writeFileSync(join(second,'device-layouts.json'),'{}');
  const made=archiveLegacyData(second,()=>{});assert.ok(made);assert.deepEqual(readdirSync(made),['device-layouts.json']);assert.deepEqual(JSON.parse(readFileSync(join(second,'config.json'),'utf8')),config);
});

// ---- execution and confirmation ----------------------------------------------------------------------------------------------------------------
const sleep=()=>new Promise(resolve=>setImmediate(resolve));
const nestedConfig=()=>{
  const items=[{id:'one',label:'One',icon:'app',action:{type:'app.open',appId:'test.app'}},{id:'two',label:'Two',icon:'app',action:{type:'app.open',appId:'test.app'},requiresConfirmation:true}];
  const config=open(base(),{...pagesOf(base()),pages:[{id:'a',name:'A',widgets:[{...key('on-page',{type:'app.open',appId:'test.app'}),},{...key('second',{type:'app.open',appId:'test.app'}),}]},{id:'b',name:'B',widgets:[{...key('risky',{type:'app.open',appId:'test.app'},{},{requiresConfirmation:true}),}]}]},{...key('on-canvas',{type:'app.open',appId:'test.app'}),});
  return C.parseConfig({...config,revision:1});
};
test('execution finds a component by id wherever it sits: on the canvas or on a page; the trigger names the component',async()=>{
  const config=nestedConfig(),calls=[];
  const scheduler=new Scheduler({run:async action=>{calls.push(action.type);return {ok:true,message:'Fake only'};}});
  const trigger=(componentId,extra={})=>({requestId:randomUUID(),componentId,revision:1,...extra});
  for(const input of [trigger('on-canvas'),trigger('on-page'),trigger('second')]){
    scheduler.trigger('device',input,config);
    for(let n=0;n<100&&['accepted','running'].includes(scheduler.get('device',input.requestId).status);n++)await sleep();
    assert.equal(scheduler.get('device',input.requestId).status,'succeeded');
  }
  assert.equal(calls.length,3);
  assert.throws(()=>scheduler.trigger('device',trigger('missing'),config),fault('BUTTON_UNAVAILABLE'));
  assert.throws(()=>scheduler.trigger('device',{...trigger('on-page'),revision:0},config),fault('CONFIG_CONFLICT'));
  assert.equal(calls.length,3);scheduler.stop();
});
test('confirmation is bound to the saved key, is single-use and expires',()=>{
  const config=nestedConfig();let now=100;const proofs=new Confirmations(()=>now);
  const risky={requestId:randomUUID(),componentId:'risky',revision:1},item={requestId:randomUUID(),componentId:'grp',revision:1,itemId:'two'};
  assert.equal(C.needsConfirmation(config,C.findComponent(config,'risky')),true);assert.equal(C.needsConfirmation(config,C.findComponent(config,'on-page')),false);

  const challenge=proofs.issue('device',risky,config);assert.equal(challenge.label,'My first button');
  proofs.consume('device',{...risky,confirmation:challenge.id});assert.throws(()=>proofs.consume('device',{...risky,confirmation:challenge.id}),fault('CONFIRMATION_REQUIRED'));
  const second=proofs.issue('device',risky,config);
  assert.throws(()=>proofs.consume('device',{...risky,requestId:randomUUID(),confirmation:second.id}),()=>true);
  assert.throws(()=>proofs.issue('device',{requestId:randomUUID(),componentId:'grp',revision:1,itemId:'one'},config),()=>true,'an item that needs no confirmation has nothing to confirm');
  now+=60_000;assert.throws(()=>proofs.consume('device',{...risky,confirmation:second.id}),()=>true,'a proof expires');
});
test('over HTTPS: save a configuration with a Pages widget, run keys on a page and the canvas, ask for the result; a risky key refuses without its proof',async t=>{
  const f=await fixture(t),d=f.device('Owned'),config=nestedConfig();
  const saved=await f.send('/api/configuration/save',saveRequest(f.store.get(),{...config,revision:0}),d.cookie);assert.equal(saved.status,200);assert.equal(saved.data.config.revision,1);
  const state=(await f.send('/api/configuration',{},d.cookie)).data;assert.deepEqual(C.allComponents(state.config).map(item=>item.id),['on-page','second','risky','on-canvas']);
  for(const trigger of [{componentId:'on-page'},{componentId:'on-canvas'},{componentId:'second'}]){
    const body={requestId:randomUUID(),revision:1,...trigger},run=await f.send('/api/execute',body,d.cookie);assert.equal(run.status,202,JSON.stringify(run.data));
    await sleep();assert.equal((await f.send('/api/result',{requestId:body.requestId},d.cookie)).data.execution.status,'succeeded');
  }
  assert.equal(f.calls,3);
  const unconfirmed=await f.send('/api/execute',{requestId:randomUUID(),revision:1,componentId:'risky'},d.cookie);assert.notEqual(unconfirmed.status,202);assert.equal(f.calls,3);
  const asked={requestId:randomUUID(),revision:1,componentId:'risky'},challenge=await f.send('/api/confirmation',asked,d.cookie);assert.equal(challenge.status,200);
  assert.equal((await f.send('/api/execute',{...asked,confirmation:challenge.data.id},d.cookie)).status,202);await sleep();assert.equal(f.calls,4);
  assert.equal((await f.send('/api/execute',{requestId:randomUUID(),revision:1,componentId:'grp',itemId:'two'},d.cookie)).status!==202,true);
  // The old trigger field and the old format are refused.
  assert.equal((await f.send('/api/execute',{requestId:randomUUID(),revision:1,buttonId:'on-page'},d.cookie)).status,400);
  assert.equal((await f.send('/api/configuration/save',{format:'keyln.layout',version:1,revision:1,pages:[],components:[]},d.cookie)).status,400);
  // T94: a save carries only the changed parts; a whole document (an older page's save, v1 or v2) is refused, and a v1 file is only converted when it is read for a review.
  const before=f.store.get(),old={format:'keyln.config',version:1,revision:before.revision,canvas:{cols:8,rows:5},widgets:[]};
  for(const body of [old,{...before}]){const response=await f.send('/api/configuration/save',body,d.cookie);assert.equal(response.status,400);assert.equal(response.data.error.code,'CONFIG_VERSION');}
  const preview=await f.send('/api/configuration/preview',old,d.cookie);assert.equal(preview.status,200);assert.equal(preview.data.config.version,3,'a v1 file is converted to v3 in memory');assert.deepEqual(f.store.get(),before);
  // Importing it replaces everything (the reviewer asked for it): one layout named Surface, the default theme, every key in the library.
  const imported=await f.send('/api/configuration/import',{config:old,stamp:f.store.documentStamp()},d.cookie);assert.equal(imported.status,200);assert.deepEqual(f.store.layoutNames,['Surface']);assert.equal(f.store.theme(),'braun');assert.equal(f.store.get().revision,before.revision+1);

});
test('import review looks at every component of the canvas and of every page, and returns the configuration it checked',()=>{
  const config=nestedConfig(),checked=[];
  const preview=importPreview(clone(config),[{id:'test.app',name:'Test app'}],action=>checked.push(action));
  assert.deepEqual(preview.config,C.v2ToV3(config));assert.deepEqual(preview.view,{...config,layoutRevision:config.revision});assert.equal(preview.issues.length,0);
  const missing=importPreview(clone(config),[],()=>{});
  assert.ok(missing.issues.some(issue=>issue.location.includes('on-canvas')||issue.location.includes('My first button')),JSON.stringify(missing.issues));assert.ok(missing.issues.length>=4,'keys on the canvas and on pages');
  assert.throws(()=>importPreview({...clone(config),pages:[]},[],()=>{}),()=>true);
});

// ---- component files ---------------------------------------------------------------------------------------------------------------------------
test('a component file carries a size tier and no position; it is checked as the one-widget configuration it becomes; there is no page file any more',()=>{
  const config=withComponents(C.initialView(),[key('k',{type:'app.open',appId:'test.app'},{size:'M'},{label:'Open it',color:'blue'})]);
  const file=C.exportItemFile(config,'k');
  assert.equal(file.format,'keyln.item');assert.equal(file.version,2);assert.equal(file.component.size,'M');assert.equal(Object.hasOwn(file.component,'cell'),false);assert.equal(Object.hasOwn(file.component,'id'),false);assert.equal(file.component.label,'Open it');
  assert.deepEqual(C.parseItemFile(clone(file)),file);
  const layoutOfFile=C.itemFileLayout(file);assert.deepEqual(C.allComponents(layoutOfFile).map(item=>item.size),['M']);
  for(const [name,mutate] of Object.entries({id:f=>{f.component.id='x';},cell:f=>{f.component.cell={x:0,y:0};},frame:f=>{f.component.frame={x:0,y:0,w:1,h:1};},size:f=>{f.component.size='Huge';},noSize:f=>{delete f.component.size;},kind:f=>{f.component.kind='pages';},version:f=>{f.version=1;},format:f=>{f.format='keyln.page';},extra:f=>{f.extra=1;}})){
    const copy=clone(file);mutate(copy);assert.throws(()=>C.parseItemFile(copy),()=>true,name);
  }
  const flow={id:'w',name:'Flow',timeoutMs:2000,steps:[{id:'s',action:{type:'app.open',appId:'test.app'},timeoutMs:1000}]};
  const withFlow={...withComponents(C.initialView(),[key('k',{type:'workflow.run',workflowId:'w'})]),workflows:[flow]};
  const flowFile=C.exportItemFile(withFlow,'k');assert.equal(flowFile.workflows.length,1);assert.equal(flowFile.workflows[0].id,'workflow-1');assert.equal(flowFile.component.action.workflowId,'workflow-1');
  const stray=clone(flowFile);stray.component.action=null;assert.throws(()=>C.parseItemFile(stray),()=>true,'a workflow no key uses');
  const items=[{id:'a',label:'A',icon:'app',action:{type:'app.open',appId:'test.app'}},{id:'b',label:'B',icon:'app',action:null}];
  assert.throws(()=>C.parseItemFile({...file,component:group('g','app-group',items)}),fault('INVALID_INPUT'));
  assert.throws(()=>C.exportItemFile(config,'missing'),fault('INVALID_INPUT'));
  for(const gone of ['parsePageFile','exportPageFile','pageFileLayout','PAGE_FILE_FORMAT','PAGE_FILE_SUFFIX','parseDeviceLayout','parseThemeCanvasEntry','layoutCanvas','DEVICE_PRESETS','withTheme','activeCustomTheme','configTheme','parseFrame','freeSpot'])assert.equal(gone in C,false,`${gone} is deleted`);
});
test('the whole configuration exports and imports as itself: strict, size-bounded, with the Pages widget intact',()=>{
  const config=nestedConfig();assert.deepEqual(C.parseConfig(JSON.parse(JSON.stringify(config,null,2))),config);
  const huge=clone(config);pagesOf(huge).pages[0].widgets.push(...Array.from({length:6},(_,i)=>({...key(`x${i}`,{type:'shell.run',scriptId:'s',version:'a'.repeat(64),args:Array(8).fill('y'.repeat(200))}),})));
  C.parseConfig(huge);
  const many=clone(config);many.widgets[0].pages=Array.from({length:16},(_,p)=>({id:`pg${p}`,name:`Page ${p}`,widgets:Array.from({length:30},(_,i)=>({...key(`k${p}-${i}`,{type:'shell.run',scriptId:'s',version:'a'.repeat(64),args:Array(8).fill('y'.repeat(200))},{},{label:'z'.repeat(40)}),}))}));
  many.widgets=[many.widgets[0]];bad(many,'TOO_LARGE');
});

// ---- Use mode ---------------------------------------------------------------------------------------------------------------------------------
const pitchOf=f=>parseFloat(f.el('button-grid').style['--cell']);
const find=(node,match)=>{for(const child of node.children??[]){if(match(child))return child;const found=find(child,match);if(found)return found;}return undefined;};
const findAll=(node,match,out=[])=>{for(const child of node.children??[]){if(match(child))out.push(child);findAll(child,match,out);}return out;};
const plan=(config={},theme='braun',size={width:1366,height:768})=>planZones(C.resolveTheme(theme,config.customThemes).layout,size);
const tile=(f,id)=>f.button(id);
const wideWorld=(configuration,extra={})=>client(extra.t,{configuration,viewport:extra.viewport??{width:1366,height:768},deviceTheme:extra.deviceTheme,...extra.options});

test('Use mode places the three system components from the device theme\'s zones and the canvas in the content area: Braun wide, Braun narrow, and a theme chosen per device',async t=>{
  const f=await wideWorld(layout([key('k',{type:'app.open',appId:'test.app'})]),{t}),{el}=f;await f.until(()=>!f.button('k').disabled);
  const expected=plan(),layer=el('system-layer');
  assert.equal(layer.hidden,false);assert.equal(el('shell').dataset.canvas,'true');assert.equal(el('shell').dataset.zones,'wide');
  // The element of each part sits where the zones say, in px from the window edges, with the form the theme names.
  const placed=part=>find(layer,node=>node.dataset?.zonePart===part&&!node.hidden);
  for(const part of C.SYSTEM_PARTS){
    const node=placed(part);assert.ok(node,`${part} is shown`);
    assert.equal(node.style.left,`${expected.slots[part].x}px`);assert.equal(node.style.top,`${expected.slots[part].y}px`);assert.equal(node.style.width,`${expected.slots[part].w}px`);assert.equal(node.style.height,`${expected.slots[part].h}px`);
  }
  assert.equal(find(layer,node=>node.dataset?.zonePart==='connection').className,'connection-tools','the capsule form');assert.equal(find(layer,node=>node.dataset?.zonePart==='mode-switch').id,'mode-switch');
  // Exactly one form of each part is shown; the system bar has the theme's height.
  assert.equal(findAll(layer,node=>node.dataset?.zonePart!==undefined&&!node.hidden).length,3);assert.equal(el('system-bar').style.height,'52px');assert.equal(el('system-bar').hidden,false);
  // The content area is the frame of the canvas.
  const frame=el('grid-frame');assert.equal(frame.style.left,`${expected.content.x}px`);assert.equal(frame.style.top,`${expected.content.y}px`);assert.equal(frame.style.width,`${expected.content.w}px`);assert.equal(frame.style.height,`${expected.content.h}px`);
});
test('a device whose theme is Widget has no bar and round controls in the corners; a narrow window switches to the narrow set',async t=>{
  const f=await wideWorld(layout([key('k',{type:'app.open',appId:'test.app'})]),{t,deviceTheme:'widget'}),{el}=f;await f.until(()=>el('html').dataset.theme==='widget');
  const expected=plan({},'widget');
  assert.equal(el('system-bar').hidden,true);const dot=find(el('system-layer'),node=>node.dataset?.zonePart==='connection');assert.equal(dot.className.includes('conn-dot-button'),true);assert.equal(dot.style.left,`${expected.slots.connection.x}px`);
  assert.equal(find(el('system-layer'),node=>node.dataset?.zonePart==='mode-switch').className.includes('mode-icon'),true);
  const narrow=await wideWorld(layout([key('k',{type:'app.open',appId:'test.app'})]),{t,viewport:{width:411,height:860}});await narrow.until(()=>!narrow.button('k').disabled);
  assert.equal(narrow.el('shell').dataset.zones,'narrow');const small=plan({},'braun',{width:411,height:860});
  assert.equal(find(narrow.el('system-layer'),node=>node.dataset?.zonePart==='settings').style.left,`${small.slots.settings.x}px`);
  assert.equal(find(narrow.el('system-layer'),node=>node.dataset?.zonePart==='connection').className.includes('conn-dot-button'),true);
});
test('choosing a theme in Settings saves this device\'s own choice (not the configuration) and moves the zones at once',async t=>{
  const f=await wideWorld(layout([key('k',{type:'app.open',appId:'test.app'})]),{t}),{el}=f;await f.until(()=>!f.button('k').disabled);
  const revision=f.state.config.revision,widget=el('theme-picker').children.find(node=>node.dataset.themeChoice==='widget');
  widget.emit('click');await f.until(()=>f.deviceTheme==='widget');await f.until(()=>el('html').dataset.theme==='widget');
  assert.equal(f.count('device-theme/save'),1);assert.equal(f.count('configuration/save'),0);assert.equal(f.state.config.revision,revision,'the shared configuration did not change');
  assert.equal(el('system-bar').hidden,true,'Widget has no bar');assert.equal(f.local.get('keyln.theme'),'widget');
});


test('turning pages stays inside the Pages widget: a tab or a swipe shows another page, nothing else on the canvas changes, and no action is sent',async t=>{
  const config=open(base(),{...pagesOf(base()),pages:[
    {id:'a',name:'Daily',widgets:[{...key('k1',{type:'app.open',appId:'test.app'}),}]},{id:'b',name:'More',widgets:[{...key('k2',{type:'app.open',appId:'test.app'}),}]},{id:'c',name:'Last',widgets:[]}]},
    {...key('c1',{type:'app.open',appId:'test.app'}),});
  const f=await client(t,{configuration:C.parseConfig({...config,revision:2}),viewport:{width:1366,height:768}}),{el}=f;await f.until(()=>!f.button('k1').disabled);
  const canvasKey=f.button('c1');
  f.page('b').emit('click');await f.until(()=>f.button('k2'));assert.equal(f.button('k1'),undefined);assert.equal(f.button('c1').dataset.buttonId,'c1');
  assert.equal(JSON.parse(f.storage.get('keyln.active-pages')).main,'b','the choice is kept for this browser tab only');assert.equal(f.count('configuration/save'),0);
  // A swipe left on the page turns to the next one; right turns back; the ends stop.
  const surface=()=>find(el('button-grid'),node=>node.className==='button-grid pages-surface'),swipe=(from,to)=>{
    surface().emit('pointerdown',{isPrimary:true,button:0,clientX:from,clientY:200});surface().emit('pointerup',{clientX:to,clientY:210});};
  swipe(400,200);await f.until(()=>surface().dataset.pageId==='c');swipe(400,200);assert.equal(surface().dataset.pageId,'c','the last page is the end');
  swipe(200,400);await f.until(()=>surface().dataset.pageId==='b');swipe(200,420);await f.until(()=>surface().dataset.pageId==='a');swipe(200,420);assert.equal(surface().dataset.pageId,'a');
  swipe(400,380);assert.equal(surface().dataset.pageId,'a','a short move is not a swipe');
  assert.equal(f.count('execute'),0,'turning pages sends nothing');assert.equal(canvasKey.dataset.buttonId,'c1');
});


// ---- Use mode: moving by long press ------------------------------------------------------------------------------------------------------------
// The harness gives nodes a box only when a test says so: the canvas starts at 0,0 and each cell is `size` px wide, so a finger's cell is plain division.
async function dragWorld(t,config){
  const f=await client(t,{configuration:C.parseConfig({...config,revision:2}),viewport:{width:1366,height:768}});await f.until(()=>!f.button(C.allComponents(config)[0].id).disabled);
  const size=pitchOf(f),surfaces=()=>[f.el('button-grid'),...findAll(f.el('button-grid'),node=>node.className==='button-grid pages-surface')];
  const boxes=()=>responsiveBoxes(f);
  const press=async(id,x,y,pointerId=1)=>{boxes();const node=f.button(id);node.emit('pointerdown',{isPrimary:true,button:0,pointerId,pointerType:'mouse',clientX:x,clientY:y});await f.fireTimer(550);};
  const move=(x,y,pointerId=1)=>f.documentEvents.get('pointermove')({pointerId,clientX:x,clientY:y});
  const release=(x,y,pointerId=1)=>f.documentEvents.get('pointerup')({pointerId,clientX:x,clientY:y});
  const saved=()=>f.calls.filter(c=>c.path==='/api/configuration/save');
  return {f,size,boxes,press,move,release,saved,surfaces};
}
const dragConfig=()=>open(base(),{...pagesOf(base()),pages:[
  {id:'a',name:'A',widgets:[{...key('k1',{type:'app.open',appId:'test.app'}),},{...key('k2',{type:'app.open',appId:'test.app'}),}]},
  {id:'b',name:'B',widgets:[{...key('k3',{type:'app.open',appId:'test.app'}),}]}]},
  {...key('c1',{type:'app.open',appId:'test.app'}),});




test('moving is refused while the draft is open or the connection is gone; a long press in Edit opens the quick menu instead of lifting (T63)',async t=>{
  const w=await dragWorld(t,dragConfig()),{f}=w;w.boxes();
  f.el('edit-layout').emit('click');await f.drain();
  await f.drain();assert.equal(f.el('shell').dataset.editing,'true');
  const surface=w.surfaces()[1];w.boxes();f.button('k1').emit('pointerdown',{isPrimary:true,button:0,pointerId:1,pointerType:'mouse',clientX:surface.rect.left+5,clientY:surface.rect.top+5});
  await f.fireTimer(550);
  assert.equal(f.button('k1').dataset.lifted,undefined,'nothing is lifted by a long press in Edit');assert.equal(f.el('edit-menu').hidden,false,'the quick menu opened');assert.equal(w.saved().length,0);
});

// ---- the pure rules behind Edit's minimum -------------------------------------------------------------------------------------------------------
