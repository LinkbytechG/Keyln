import test from 'node:test';
import assert from 'node:assert/strict';
import {assembledPage} from './helpers/widget-dom.mjs';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {request} from 'node:https';
import {WebSocket} from 'ws';
import {themes,DEFAULT_THEME,themeName,parseConfig,keyColors} from '../dist/packages/contracts/index.js';
import {tintInk,tintSoftInk,contrast,keyFill,glyphKind,iconInk,repeatsPhrase} from '../dist/apps/web/presentation.js';
import {themeColors,themeColor,themeInfo,tileStatus,shortStatus} from '../dist/apps/web/themes.js';
import {Auth} from '../dist/apps/host/auth.js';
import {LocalAdmin} from '../dist/apps/host/admin.js';
import {ConfigStore} from '../dist/apps/host/store.js';
import {Scheduler} from '../dist/apps/host/scheduler.js';
import {createHost} from '../dist/apps/host/server.js';

const fault=code=>error=>error.code===code;
const clone=value=>JSON.parse(JSON.stringify(value));
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1EAAAAASUVORK5CYII=';

// ---- Host store and route ----

async function host(t){
 const dir=mkdtempSync(join(tmpdir(),'keyln-t33-http-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 execFileSync(process.execPath,['scripts/setup.mjs'],{env:{...process.env,KEYLN_DATA_DIR:dir},stdio:'pipe'});
 const auth=new Auth(dir),admin=new LocalAdmin(),store=new ConfigStore(dir),scheduler=new Scheduler({run:async()=>({ok:true,message:'Fake only'})});
 const origin='https://127.0.0.1:0',ca=readFileSync(join(dir,'tls/rootCA.pem'));
 const server=createHost({auth,admin,store,scheduler,origin,apps:[],onPair:()=>{},tls:{key:readFileSync(join(dir,'tls/server.key')),cert:readFileSync(join(dir,'tls/server.pem'))}});
 await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
 const sockets=[];
 t.after(async()=>{for(const socket of sockets)socket.terminate();scheduler.stop();await scheduler.settled();server.stopEvents();server.closeAllConnections();await new Promise(yes=>server.close(yes));});
 const connection={hostname:'127.0.0.1',servername:'',port:server.address().port,ca};
 const headers=cookie=>({host:'127.0.0.1:0',origin,'content-type':'application/json','x-keyln-client':'1',cookie});
 const send=(path,input={},cookie='',overrides={})=>new Promise((yes,no)=>{
  const req=request({...connection,path,method:'POST',headers:{...headers(cookie),...overrides}},res=>{let body='';res.setEncoding('utf8');res.on('data',part=>body+=part);res.on('end',()=>yes({status:res.statusCode,body,data:JSON.parse(body)}));});
  req.on('error',no);req.end(JSON.stringify(input));
 });
 const device=()=>{const p=auth.begin(auth.invite(),'Theme tester');auth.approve(p.id);return `__Host-keyln=${auth.claim(p.id,p.claim).token}`;};
 const socket=cookie=>{const ws=new WebSocket(`wss://127.0.0.1:${connection.port}/api/events`,'keyln.events.v2',{ca,servername:'',origin,headers:{host:'127.0.0.1:0',cookie}});sockets.push(ws);return ws;};
 return {dir,store,auth,send,device,socket};
}

// ---- presentation: ink, fill rules, state wording ----
test('tintInk picks the ink with more contrast and the action line stays readable on every custom color',()=>{
 assert.equal(tintInk('#101010'),'#EEEFF1');assert.equal(tintInk('#F0E060'),'#141414');assert.equal(tintInk('#FFFFFF'),'#141414');assert.equal(tintInk('#000000'),'#EEEFF1');
 // Mid tones: the old brightness rule chose light ink at #808080 (3.4:1); the dark ink has 4.7:1.
 assert.equal(tintInk('#808080'),'#141414');assert.ok(contrast('#808080','#141414')>contrast('#808080','#EEEFF1'));
 for(let value=0;value<=255;value+=5){
  const tint='#'+[value,(value*3)%256,(value*7)%256].map(part=>part.toString(16).padStart(2,'0')).join('').toUpperCase(),ink=tintInk(tint),soft=tintSoftInk(tint,ink);
  assert.ok(contrast(tint,ink)>=Math.max(contrast(tint,'#141414'),contrast(tint,'#EEEFF1'))-1e-9,`${tint} ink`);
  assert.ok(contrast(tint,soft)>=Math.min(4.5,contrast(tint,ink))-1e-9,`${tint} action line keeps the 4.5:1 floor`);
  assert.ok(contrast(tint,soft)<=contrast(tint,ink)+1e-9,`${tint} action line is never louder than the name`);
  if(contrast(tint,ink)>=4.55)assert.ok(contrast(tint,soft)<=4.9,`${tint} action line sits close to the floor (T35: quieter), not at the name's weight`);
 }
 assert.equal(contrast('#000000','#FFFFFF').toFixed(1),'21.0');assert.equal(contrast('#FFFFFF','#FFFFFF'),1);
});
test('fill rules: built-in symbols and text fill the key; App icons, images and outline or plain keys sit on the dark body',()=>{
 const base={icon:'app',action:null},app={type:'app.open',appId:'test.app'};
 assert.equal(glyphKind(),'builtin');assert.equal(keyFill(),'body','an empty slot is not filled');
 assert.equal(glyphKind({...base}),'builtin');assert.equal(keyFill({...base}),'solid','the default built-in icon fills the key');
 assert.equal(keyFill({...base,appearance:{glyph:{type:'builtin'}}}),'solid');
 assert.equal(glyphKind({...base,appearance:{glyph:{type:'text',text:'AI'}}}),'text');assert.equal(keyFill({...base,appearance:{glyph:{type:'text',text:'AI'}}}),'solid');
 assert.equal(glyphKind({...base,appearance:{glyph:{type:'image',data:png}}}),'image');assert.equal(keyFill({...base,appearance:{glyph:{type:'image',data:png}}}),'body');
 assert.equal(glyphKind({...base,action:app}),'app','the untouched default of an app key shows the Mac app icon');assert.equal(keyFill({...base,action:app}),'body');
 assert.equal(glyphKind({...base,action:app,appearance:{glyph:{type:'app'}}}),'app');assert.equal(keyFill({...base,action:app,appearance:{glyph:{type:'app'}}}),'body');
 assert.equal(glyphKind({...base,appearance:{glyph:{type:'app'}}}),'builtin','an App glyph on a key that opens no app falls back to the symbol');
 assert.equal(keyFill({...base,appearance:{style:'outline'}}),'body');assert.equal(keyFill({...base,appearance:{style:'plain'}}),'body');assert.equal(keyFill({...base,appearance:{style:'tile'}}),'solid');
 assert.equal(keyFill({...base,appearance:{style:'outline',glyph:{type:'text',text:'K'}}}),'body');
 assert.equal(keyFill({...base,color:'red',appearance:{tint:'#123456'}}),'solid','a custom color fills the key like a palette color');
});
test('status wording: Braun, Standard and Classic share one set; Metro and Midnight use their own',()=>{
 for(const theme of ['braun','standard','classic']){assert.equal(tileStatus(theme,'running'),'Executing…');assert.equal(tileStatus(theme,'succeeded'),'Done');assert.equal(tileStatus(theme,'failed'),'Failed');}
 assert.deepEqual(['sending','accepted','running','succeeded','failed','rejected','unknown'].map(status=>tileStatus('metro',status)),['Sending','Accepted','Running','Done','Failed','Rejected','Unknown']);
 assert.deepEqual(['accepted','running','succeeded','failed','rejected'].map(status=>tileStatus('midnight',status)),['In progress','In progress','Arrived · done','Delayed · failed','Delayed · rejected']);
 for(const theme of themes){assert.equal(tileStatus(theme,'ready'),'Ready');assert.equal(tileStatus(theme,'offline'),'Offline');assert.ok(themeInfo[theme].name&&themeInfo[theme].note);}
});

// ---- stylesheet: tokens, contrast, browser surfaces ----
const css=readFileSync(new URL('../apps/web/style.css',import.meta.url),'utf8');
function tokens(theme){
 const selector=theme==='braun'?':root:not([data-theme]),[data-theme=braun]{':`[data-theme=${theme}]{`,start=css.indexOf(selector);assert.ok(start>=0,`${theme} block`);
 const body=css.slice(start+selector.length,css.indexOf('\n}',start)),values={};
 for(const match of body.matchAll(/(--[a-z0-9-]+):([^;]+);/g))values[match[1]]=match[2].trim();
 return values;
}
test('every theme defines the full token set and the seven key colors with readable inks',()=>{
 for(const theme of themes){
  const t=tokens(theme);
  for(const name of ['--bg','--key','--surface','--surface-2','--hair','--line','--text','--muted','--dim','--accent','--accent-ink','--ok','--ok-text','--warn','--danger','--danger-text','--danger-bg','--sel','--focus','--font-ui','--radius-key','--header-h','--tile-gap','--tile-align'])assert.ok(t[name],`${theme} ${name}`);
  const text=(a,b,min,what)=>assert.ok(contrast(t[a],t[b])>=min,`${theme} ${what}: ${a} on ${b} is ${contrast(t[a],t[b]).toFixed(2)}`);
  text('--text','--bg',7,'text');text('--text','--key',7,'text on keys');text('--text','--surface-2',7,'text on hover');
  text('--muted','--bg',4.5,'muted');text('--muted','--surface-2',4.5,'muted on hover');text('--dim','--bg',4.5,'dim');text('--dim','--key',4.5,'dim on keys');text('--dim','--surface-2',4.5,'dim on hover');
  text('--detail','--key',4.5,'action line on the key body (T35)');text('--detail','--bg',4.5,'action line on the ground');text('--muted','--surface-2',4.5,'hover restore for the action line');
  assert.ok(contrast(t['--detail'],t['--key'])<contrast(t['--muted'],t['--key']),`${theme}: the action line is quieter than muted text`);assert.ok(contrast(t['--detail'],t['--key'])<=4.75,`${theme}: and sits close to the floor`);
  text('--line','--bg',3,'control border');text('--line','--surface',3,'control border on panels');
  text('--accent','--bg',3,'accent');text('--accent-ink','--accent',4.5,'accent button text');text('--ok-text','--surface-2',4.5,'ok text');text('--danger-text','--danger-bg',4.5,'error text');text('--danger-text','--bg',4.5,'error text on ground');
  text('--text','--sel',4.5,'selected text');text('--focus','--bg',3,'focus ring');
  for(const state of ['ok','warn','danger']){const on={ok:'--on-ok',warn:'--on-warn',danger:'--on-bad'}[state];text(on,`--${state}`,4.5,`ink on the ${state} bar`);}
  for(const color of keyColors){
   const fill=t[`--c-${color}`],ink=t[`--i-${color}`],soft=t[`--s-${color}`],tone=t[`--t-${color}`];
   assert.ok(fill&&ink&&soft&&tone,`${theme} ${color}`);
   assert.ok(contrast(fill,ink)>=4.5,`${theme} ${color}: name on the key ${contrast(fill,ink).toFixed(2)}`);
   assert.ok(contrast(fill,soft)>=4.5,`${theme} ${color}: action line on the key ${contrast(fill,soft).toFixed(2)}`);
   assert.ok(contrast(fill,soft)<=Math.min(contrast(fill,ink),4.75)+1e-9,`${theme} ${color}: the action ink is the quiet one, close to the 4.5:1 floor (${contrast(fill,soft).toFixed(2)})`);
   assert.ok(contrast(fill,ink)>=3,`${theme} ${color}: glyph`);
   assert.ok(contrast(tone,t['--key'])>=3,`${theme} ${color}: glyph or ring on the dark key body ${contrast(tone,t['--key']).toFixed(2)}`);
   assert.ok(contrast(tone,t['--bg'])>=3,`${theme} ${color}: glyph on the ground`);
  }
 }
});
test('Braun keeps to two neutrals with the planner-set palette; the other themes use their set grounds, bodies and colors',()=>{
 const braun=tokens('braun');
 assert.equal(braun['--bg'],'#1A1917');assert.equal(braun['--key'],'#2A2926');assert.equal(braun['--text'],'#ECE7DC');assert.equal(braun['--surface'],braun['--key'],'panels use the key body, not a third neutral');
 for(const [color,fill] of Object.entries({orange:'#F26B1D',yellow:'#E9B93A',green:'#5E9B63',blue:'#4F6D8A',red:'#B5483B',gray:'#8C877C',purple:'#7A5C8E'}))assert.equal(braun[`--c-${color}`],fill,`braun ${color}`);
 assert.deepEqual([tokens('metro')['--bg'],tokens('metro')['--key'],tokens('metro')['--text']],['#1E2124','#2A2E33','#F4F4F2']);
 for(const [index,line] of ['#E2231A','#0075C2','#00A040','#F7943E','#7E3C93','#5EB6E4'].entries())assert.equal(tokens('metro')[`--line-${index}`],line);
 assert.deepEqual([tokens('midnight')['--bg'],tokens('midnight')['--key'],tokens('midnight')['--text']],['#0E1A33','#15244A','#F1EFE8']);
 for(const [index,line] of ['#D7263D','#2F5DD0','#F2A900','#2E9E5B'].entries())assert.equal(tokens('midnight')[`--line-${index}`],line);
 assert.deepEqual([tokens('standard')['--bg'],tokens('standard')['--key']],['#000000','#1C1C1E']);
 for(const [color,fill] of Object.entries({orange:'#FF9F0A',yellow:'#FFD60A',green:'#30D158',blue:'#0A84FF',purple:'#BF5AF2',red:'#FF453A',gray:'#8E8E93'}))assert.equal(tokens('standard')[`--c-${color}`],fill,`standard ${color}`);
 assert.equal(tokens('standard')['--radius-key'],'18px');assert.deepEqual([braun['--radius-key'],tokens('metro')['--radius-key']],['10px','0']);
 assert.equal(tokens('classic')['--c-green'],'#7CF2B4');assert.equal(tokens('classic')['--c-blue'],'#5AA9FF');
});
test('the JavaScript colors used for one-color icons mirror the stylesheet tokens',()=>{
 for(const theme of themes){
  const t=tokens(theme);assert.equal(themeColors[theme].ground,t['--bg'],`${theme} ground`);
  for(const color of keyColors){assert.equal(themeColor(theme,color),t[`--c-${color}`],`${theme} ${color} fill`);assert.equal(themeColor(theme,color,'tone'),t[`--t-${color}`],`${theme} ${color} tone`);}
 }
 assert.equal(iconInk({icon:'app',action:null,appearance:{style:'plain'}},'standard'),'#0A84FF');
});

// ---- fix round: lamp housing, busy keys, one label size, text glyphs, page indicator, readout ----
const clamp=(low,value,high)=>Math.min(Math.max(value,low),high);
const rule=(selector,from=0)=>{const start=css.indexOf(selector+'{',from);assert.ok(start>=0,selector);return css.slice(start,css.indexOf('}',start)+1);};
test('lamps sit in a ground-colored housing of 18px or more that scales with the cell; the header pill uses the same housing',()=>{
 const housing='border:calc(var(--lamp-d) * .21) solid var(--bg);background:var(--bg);box-shadow:inset 0 0 0 2px var(--dim),0 0 0 1px var(--hair)';
 const lamp=rule('[data-theme=braun] :where(.desk[data-editing=false]) .control-tile:where(:not([data-state=unconfigured])) .tile-lamp');
 assert.ok(lamp.includes(housing),'idle: a ground-colored housing with a hollow inner ring');assert.match(lamp,/width:var\(--lamp-d\);height:var\(--lamp-d\);border-radius:50%/);
 assert.doesNotMatch(lamp,/border:2px solid var\(--dim\)|var\(--ink\)/,'no bare ring on the key color any more');
 const tile=rule('.control-tile',css.indexOf('/* ---------- keys'));assert.match(tile,/--lamp-d:clamp\(14px,calc\(var\(--cell\) \* \.095\),26px\)/);
 const housingD=cell=>clamp(14,cell*.095,26);assert.ok(housingD(192)>=18&&housingD(243)>=18&&housingD(396)===26,'18px and up on ordinary keys');assert.equal(housingD(82),14,'and never under 14px on small keys');
 assert.ok(housingD(82)*(1-2*.21)>=8,'the state dot is at least 8px even on the smallest housing');assert.ok(housingD(192)*(1-2*.21)>=10);
 assert.match(css,/\[data-theme=braun\] \.control-tile:is\(\[data-state=sending\],\[data-state=accepted\],\[data-state=running\]\) \.tile-lamp\{background-clip:content-box;background-color:var\(--warn\)/);
 assert.match(css,/\[data-theme=braun\] \.control-tile\[data-state=succeeded\] \.tile-lamp\{background-clip:content-box;background-color:var\(--ok\)/);assert.match(css,/\.tile-lamp\{background-clip:content-box;background-color:var\(--danger\)/);
 assert.ok(rule('.connection::before').includes(housing.replace('calc(var(--lamp-d) * .21)','calc(var(--lamp-d) * .21)')),'the header pill');assert.match(rule('.connection::before'),/--lamp-d:18px/);
 assert.match(css,/\.connection\[data-phase=online\]::before\{background-clip:content-box;background-color:var\(--ok\)/);assert.match(css,/\.connection\[data-phase=offline\]::before\{background-clip:content-box;background-color:var\(--danger\)/);
 assert.doesNotMatch(css,/radial-gradient\(circle closest-side/,'lamps are drawn with borders, not gradient glows');
 assert.match(rule('[data-theme=braun] .desk[data-editing=false] .control-tile'),/--corner-clear:calc\(2 \* \(var\(--lamp-inset\) \+ var\(--lamp-d\) \+ 1px\)\)/,'the icon keeps clear of the lamp corner');
 assert.match(rule('[data-theme=standard] .desk[data-editing=false] .control-tile'),/--corner-clear:/,'and of the Standard badge');
 for(const theme of themes){const block=css.slice(css.indexOf(theme==='braun'?':root:not([data-theme]),[data-theme=braun]{':`[data-theme=${theme}]{`));assert.match(block.slice(0,block.indexOf('\n}')),/--glyph-adv:/,theme);}
});
test('keys that cannot be pressed while another one runs look busy in every theme but Classic, which keeps "Mac busy"',()=>{
 assert.match(css,/\[data-theme\]:not\(\[data-theme=classic\]\) \.desk\[data-editing=false\] \.control-tile\[data-state=busy\] :is\(\.tile-icon,\.tile-label,\.tile-detail\)\{opacity:\.55\}/);
 assert.match(css,/\[data-theme=braun\] \.control-tile\[data-state=busy\] \.tile-lamp\{box-shadow:0 0 0 1px var\(--hair\)\}/,'Braun: the lamp goes out (no ring, no color)');
 assert.match(css,/\[data-theme=metro\] \.desk\[data-editing=false\] \.control-tile\[data-state=busy\]\{box-shadow:inset 0 -4px 0 var\(--line\)\}/);
 assert.match(css,/\[data-theme=midnight\] \.desk\[data-editing=false\] \.control-tile\[data-state=busy\]\{outline:3px dotted/);
 assert.match(css,/\[data-theme=standard\] \.desk\[data-editing=false\] \.control-tile\[data-state=busy\]\{filter:saturate\(\.4\)\}/);
 const classicBusy=css.split('\n').filter(line=>line.startsWith('[data-theme=classic]')&&line.includes('[data-state=busy]'));assert.ok(classicBusy.length>=2&&classicBusy.every(line=>!line.includes('.55')),'Classic keeps its own busy look');assert.equal(tileStatus('classic','busy'),'Mac busy');
 assert.match(css,/\[data-theme=classic\] \.control-tile:is\(\[data-state=offline\],\[data-state=connecting\],\[data-state=busy\]\)\{opacity:1;border-style:dashed\}/);
});
test('one name size on every key: 16px (12px under 100px cells), the same on every key size, and the action line, a smaller second size, shows from 100px cells up',()=>{
 for(const name of ['--name-scale','--detail-scale','--span-min) - 1) * .2','.074'])assert.ok(!css.includes(name),`${name} is gone: the size no longer follows the key`);
 const tile=rule('.control-tile',css.indexOf('/* ---------- keys'));assert.match(tile,/--fs:clamp\(12px,calc\(\(var\(--cell\) - 100px\) \* 100 \+ 16px\),16px\);/,'one size from the stylesheet (T102: no page-wide override)');assert.ok(!css.includes('--page-fs'));
 const fs=cell=>clamp(12,(cell-100)*100+16,16),sub=size=>Math.max(11,size*.8),detail=cell=>clamp(0,(cell-100)*100+sub(fs(cell)),sub(fs(cell)));
 for(const cell of [44,64,82,99,99.5])assert.ok(fs(cell)===12&&detail(cell)<=.0001+Math.max(0,(cell-100)*100+11),`${cell}px: 12px and no action line`);
 for(const cell of [100,112,123,192,243,264])assert.ok(fs(cell)===16&&Math.abs(detail(cell)-12.8)<1e-9,`${cell}px: 16px name and a 12.8px action line (T35)`);
 assert.match(rule('.control-tile .tile-label',css.indexOf('/* ---------- keys')),/font-size:var\(--fs\)/);assert.match(css,/\.control-tile \.tile-detail\{[^}]*font-size:clamp\(0px,calc\(\(var\(--cell\) - 100px\) \* 100 \+ var\(--fs-detail\)\),var\(--fs-detail\)\)/);assert.match(tile,/--fs-detail:max\(11px,calc\(var\(--fs\) \* \.8\)\)/,'the action line is 0.8 of the name, never under 11px');
 assert.doesNotMatch(css,/(^|\})\.control-tile\{--fs:/,'no per-size override of the label size');assert.doesNotMatch(css,/\.control-tile \.tile-detail\{display:none\}/,'the viewport width no longer decides whether the action line shows');
 // T102: a name is one line in every theme; one wider than the key ends in an ellipsis.
 assert.ok(!css.includes('--label-lines'));const label=rule('.control-tile .tile-label',css.indexOf('/* ---------- keys'));assert.match(label,/white-space:nowrap/);assert.match(label,/text-overflow:ellipsis/);assert.doesNotMatch(label,/line-clamp/);
});
test('text glyphs stay within about 60% of the key width in every theme, and longer text shrinks',()=>{
 const text=rule('.control-tile .tile-icon[data-glyph=text]',css.indexOf('/* ---------- keys'));assert.match(text,/max\(var\(--tw\) \* \.3,min\(var\(--tw\) \* \.6,var\(--tw\) - var\(--corner-clear\)\)\) \/ \(max\(1,var\(--glyph-chars,1\)\) \* var\(--glyph-adv\)\)/);
 for(const theme of themes){
  const block=css.slice(css.indexOf(theme==='braun'?':root:not([data-theme]),[data-theme=braun]{':`[data-theme=${theme}]{`)),adv=Number(/--glyph-adv:([.0-9]+);/.exec(block.slice(0,block.indexOf('\n}')))[1]);
  if(theme==='classic')continue;
  for(const [cell,clear] of [[243,70],[202,64],[123,50],[82,34],[64,38]]){
   const iconD=cell*.5;let last=Infinity;
   for(const chars of [1,2,3,5,8]){
    const budget=Math.max(cell*.3,Math.min(cell*.6,cell-clear)),font=Math.min(iconD,budget/(chars*adv)),width=chars*adv*font;
    assert.ok(width<=Math.max(cell*.6,cell*.3)+1e-9,`${theme} ${chars} chars on ${cell}px: ${(width/cell).toFixed(2)} of the key`);assert.ok(font<=last+1e-9,'longer text never grows');last=font;
   }
  }
 }
 assert.ok(Number(/--glyph-adv:([.0-9]+);/.exec(css.slice(css.indexOf('[data-theme=midnight]{')))[1])>=.7,'Midnight\'s wide display weight gets the largest allowance');
});
test('the page indicator has no cap and wraps instead of hiding pages',()=>{
 // T64: the right column and the .desk-bottom strip are gone with the old control desk; the indicator of a Pages widget is the one that is left.
 assert.match(css,/\.page-dots\{display:flex;flex-wrap:wrap;align-items:center;max-width:100%\}/);assert.doesNotMatch(rule('.page-dots'),/overflow|max-width:55%/);assert.doesNotMatch(css,/\.page-dots\{max-width:46%\}|\.page-dots\{[^}]*overflow-x:auto/);
});
test('status bars on Metro and Midnight keep the name: on small cells the bar stands where the action line is, the icon gives way and nothing is hidden',()=>{
 for(const theme of ['metro','midnight'])assert.match(css,new RegExp(`\\[data-theme=${theme}\\] \\.desk\\[data-editing=false\\] \\.control-tile:is\\([^)]*\\)\\{--bar-h:clamp\\(18px,calc\\(\\(var\\(--cell\\) - 100px\\) \\* 100 \\+ 2[68]px\\),2[68]px\\);--icon-min:calc\\(var\\(--u\\) \\* \\.12\\);padding-bottom:calc\\(var\\(--bar-h\\) \\+ clamp\\(2px,calc\\(\\(var\\(--cell\\) - 100px\\) \\* 100 \\+ var\\(--pad\\)\\),var\\(--pad\\)\\)\\)\\}`),theme);
 assert.match(css,/grid-template-rows:minmax\(var\(--icon-min\),1fr\) auto auto/);assert.match(css,/--icon-min:calc\(var\(--u\) \* \.25\)/,'the icon area keeps about a quarter of the key');
 assert.doesNotMatch(css,/\.tile-label\{font-size:clamp\(0px/,'no state hides or shrinks the name');
 assert.match(css,/--pad:clamp\(5px,calc\(var\(--cell\) \* \.07\),18px\)/);
 // The budget of a small key while it runs: padding above, one line of name (T102), the bar and its gap; what is left is the icon.
 for(const [cell,font] of [[64,11],[82,12],[99,12]]){
  const pad=clamp(5,cell*.07,18),icon=cell-pad-(18+2)-(pad*.5+1.2*font);
  assert.ok(icon>=cell*.12-1e-9,`${cell}px, ${font}px name: the icon keeps ${icon.toFixed(1)}px between the top and the name`);
 }
 // On large keys nothing changes: the gap above the bar is the key padding again and the bar is 26 or 28px.
 assert.equal(clamp(2,(100-100)*100+9,9),9);assert.equal(clamp(2,(64-100)*100+4.5,4.5),2);
 for(const theme of ['metro','midnight'])assert.match(css,new RegExp(`\\[data-theme=${theme}\\] \\.desk\\[data-editing=false\\] \\.control-tile:is\\([^)]*\\) \\.tile-status\\{[^}]*gap:clamp\\(0px,calc\\(\\(var\\(--cell\\) - 100px\\) \\* 100 \\+ 8px\\),8px\\)`),`${theme}: no gap beside marks that are not drawn`);
});
test('a status word in a bar ends in an ellipsis instead of being cut, and Midnight shows a short word on keys under 100px',()=>{
 assert.match(rule('.tile-status .status-text'),/min-width:0;overflow:hidden;text-overflow:ellipsis/);
 assert.match(css,/\[data-theme=midnight\] \.status-text\[data-short\]\{font-size:clamp\(0px,calc\(\(var\(--cell\) - 100px\) \* 100 \+ 12px\),12px\)\}/);
 assert.match(css,/\[data-theme=midnight\] \.status-text\[data-short\]::after\{content:attr\(data-short\);font-size:clamp\(0px,calc\(\(100px - var\(--cell\)\) \* 100\),12px\)\}/);
 for(const cell of [44,64,99])assert.ok(clamp(0,(cell-100)*100+12,12)===0&&clamp(0,(100-cell)*100,12)===12,`${cell}px: the short word only`);
 for(const cell of [100,150,264])assert.ok(clamp(0,(cell-100)*100+12,12)===12&&clamp(0,(100-cell)*100,12)===0,`${cell}px: the service-board word only`);
 for(const status of ['sending','accepted','running','succeeded','failed','rejected','unknown']){const short=shortStatus('midnight',status),long=tileStatus('midnight',status);assert.ok(short&&short.length<=8&&short.length<=long.length,status);}
 for(const theme of ['braun','metro','standard','classic'])assert.equal(shortStatus(theme,'running'),undefined,`${theme} has one word`);
});
test('T102 a name is one line: no wrapping, and one wider than the key ends in an ellipsis',()=>{
 const label=rule('.control-tile .tile-label',css.indexOf('/* ---------- keys'));
 assert.match(label,/display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis/);assert.doesNotMatch(label,/-webkit-box|line-clamp|overflow-wrap|word-break/);
});
test('the readout shows the Mac message only when it says something new',()=>{
 assert.equal(repeatsPhrase('Executing on Mac…','Executing on the Mac…'),true);assert.equal(repeatsPhrase('Executing on Mac…','Executing on Mac…'),true);
 assert.equal(repeatsPhrase('Received by Mac','Received by Mac.'),true);assert.equal(repeatsPhrase('Done','Done.'),true);assert.equal(repeatsPhrase('Shortcut sent','Shortcut sent.'),true);
 assert.equal(repeatsPhrase('Executing on Mac…','Opening and activating the application…'),false);assert.equal(repeatsPhrase('Action failed','Application unavailable.'),false);
 assert.equal(repeatsPhrase('Result unknown','Result unknown. The helper stopped or timed out. Check the Mac before trying again.'),false);
 assert.equal(repeatsPhrase('Done','Fixture opened the app.'),false);assert.equal(repeatsPhrase('Window activated','Window activated.'),true);assert.equal(repeatsPhrase('Done',''),true,'an empty message is nothing to show');
});
