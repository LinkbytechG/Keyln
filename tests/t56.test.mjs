import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {themes,DEFAULT_THEME,parseConfig,themeName,keyColors} from '../dist/packages/contracts/index.js';
import {themeInfo,themeColors,themeColor,tileStatus} from '../dist/apps/web/themes.js';
import {themeBasics,fontStacks,baseNames,deriveTheme,lookOf,contrastSummary} from '../dist/apps/web/theme-custom.js';
import {fromGrid} from './helpers/layout.mjs';

// T56: the sixth built-in theme, Widget (ADR-061): registration, tokens, the layout version, the theme's own default canvases and the lookup order
// (Docs/verification/T56.md).
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const css=read('apps/web/style.css');
const fault=(code,status)=>error=>error.code===code&&(status===undefined||error.status===status);
const lum=hex=>{const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(c=>c<=.03928?c/12.92:((c+.055)/1.055)**2.4);return .2126*r+.7152*g+.0722*b;};
const contrast=(a,b)=>{const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+.05)/(y+.05);};
function tokens(theme){
  const selector=theme==='braun'?':root:not([data-theme]),[data-theme=braun]{':`[data-theme=${theme}]{`,start=css.indexOf(selector);assert.ok(start>=0,`${theme} block`);
  const body=css.slice(start+selector.length,css.indexOf('\n}',start)),values={};
  for(const match of body.matchAll(/(--[a-z0-9-]+):([^;]+);/g))values[match[1]]=match[2].trim();
  return values;
}
const theme=(n=1,extra={})=>({id:`theme-${String(n).padStart(8,'0')}-aaaa-4bbb-8ccc-dddddddddddd`,name:`My theme ${n}`,base:'braun',accent:'#5EB6E4',background:'#1A1917',keyBody:'#2A2926',radius:'rounded',spacing:'normal',font:'braun',...extra});
const plain=(_version,extra={})=>({...fromGrid({revision:1,profiles:[{id:'main',name:'Main'}],buttons:[{id:'a',profileId:'main',position:0,label:'A',icon:'app',action:{type:'app.open',appId:'x'}}]}),...extra});
const group=()=>({id:'g',profileId:'main',position:1,label:'G',icon:'app',kind:'action-group',items:[{id:'i1',label:'One',icon:'play',action:{type:'app.open',appId:'x'}},{id:'i2',label:'Two',icon:'play',action:{type:'app.open',appId:'y'}}],action:null});


test('tokens: the full set, every contrast floor of the other themes, system font, large radii, and the mirrors in JavaScript agree with the stylesheet',()=>{
  const t=tokens('widget');
  for(const name of ['--bg','--key','--surface','--surface-2','--hair','--line','--text','--muted','--dim','--detail','--accent','--accent-ink','--ok','--ok-text','--warn','--danger','--danger-text','--danger-bg','--sel','--focus','--font-ui','--radius-key','--radius-panel','--radius-ctl','--header-h','--tabs-h','--tile-gap','--tile-align','--glyph-adv','--label-adv'])assert.ok(t[name],name);
  assert.equal(t['--label-lines'],undefined,'T102: names are one line, no line count token');
  const pair=(a,b,min,what)=>assert.ok(contrast(t[a],t[b])>=min,`${what}: ${a} on ${b} is ${contrast(t[a],t[b]).toFixed(2)}`);
  pair('--text','--bg',7,'text');pair('--text','--key',7,'text on keys');pair('--text','--surface-2',7,'text on hover');
  pair('--muted','--bg',4.5,'muted');pair('--muted','--surface-2',4.5,'muted on hover');pair('--dim','--bg',4.5,'dim');pair('--dim','--key',4.5,'dim on keys');pair('--dim','--surface-2',4.5,'dim on hover');
  pair('--detail','--key',4.5,'action line');pair('--detail','--bg',4.5,'action line on the ground');
  assert.ok(contrast(t['--detail'],t['--key'])<=4.75&&contrast(t['--detail'],t['--key'])<contrast(t['--muted'],t['--key']),'the action line is the quietest ink');
  pair('--line','--bg',3,'control border');pair('--line','--surface',3,'border on panels');pair('--accent','--bg',3,'accent');pair('--accent-ink','--accent',4.5,'accent button text');
  pair('--ok-text','--surface-2',4.5,'ok text');pair('--danger-text','--danger-bg',4.5,'error text');pair('--danger-text','--bg',4.5,'error text on the ground');pair('--text','--sel',4.5,'selection');pair('--focus','--bg',3,'focus ring');
  // The state ring and corner dot are graphics: 3:1 on the ground and on the key body.
  for(const name of ['--ok','--warn','--danger']){pair(name,'--bg',3,'state ring');pair(name,'--key',3,'state dot on a key body');}
  for(const [state,on] of [['ok','--on-ok'],['warn','--on-warn'],['danger','--on-bad']])pair(on,`--${state}`,4.5,`ink on ${state}`);
  for(const color of keyColors){
    const fill=t[`--c-${color}`],ink=t[`--i-${color}`],soft=t[`--s-${color}`],tone=t[`--t-${color}`];
    assert.ok(contrast(fill,ink)>=4.5&&contrast(fill,soft)>=4.5&&contrast(fill,soft)<=Math.min(contrast(fill,ink),4.75)+1e-9,`${color}: name and quiet action ink`);
    assert.ok(contrast(tone,t['--key'])>=3&&contrast(tone,t['--bg'])>=3,`${color}: glyph on the key body and the ground`);
  }
  // Large radii and the system stack; the thin bar belongs to the theme.
  for(const name of ['--radius-key','--radius-panel'])assert.ok(Number.parseInt(t[name])>=20&&Number.parseInt(t[name])<=24,name);
  assert.equal(t['--font-ui'],fontStacks.system.stack,'the system font stack');assert.doesNotMatch(t['--font-ui'],/Inter|Roboto|Geist Sans|https?:|url\(/);
  assert.ok(Number.parseInt(t['--header-h'])<72,'a thinner top bar than Braun');
  // JavaScript mirrors: ground, fills, tones, and the basics of the custom-theme base.
  assert.equal(themeColors.widget.ground,t['--bg']);for(const color of keyColors){assert.equal(themeColor('widget',color),t[`--c-${color}`]);assert.equal(themeColor('widget',color,'tone'),t[`--t-${color}`]);}
  const basics=themeBasics.widget;
  for(const [field,prop] of [['accent','--accent'],['background','--bg'],['keyBody','--key'],['text','--text'],['muted','--muted'],['dim','--dim'],['detail','--detail']])assert.equal(t[prop],basics[field],prop);
  assert.equal(t['--surface'],basics.keyBody);assert.equal(t['--tile-gap'],`${basics.gap}px`);assert.equal(basics.font,'system');assert.equal(basics.radius,'round');
  assert.equal(t['--glyph-adv'],fontStacks.system.glyphAdv);assert.equal(t['--label-adv'],fontStacks.system.labelAdv);
  // A copy of Widget overrides nothing and passes every rule.
  const look=lookOf('widget'),derived=deriveTheme(look);assert.deepEqual(derived.vars,{});assert.deepEqual(derived.blockers,[]);assert.ok(contrastSummary(look).ok);assert.match(contrastSummary(look).text,/Widget's colors\./);
  // The other five themes' tokens are exactly what they were (their anchors).
  assert.deepEqual([tokens('braun')['--bg'],tokens('metro')['--bg'],tokens('midnight')['--bg'],tokens('standard')['--bg'],tokens('classic')['--bg']],['#1A1917','#1E2124','#0E1A33','#000000','#0D0E10']);
});


// ---- the Widget default canvases ----
const WIDTHS={phone:{landscape:[844,390],portrait:[411,860]},tablet:{landscape:[1180,820],portrait:[768,1024]},laptop:{landscape:[1366,768],portrait:[800,1280]},desktop:{landscape:[1920,1080],portrait:[1080,1920]}};
const items=(canvas,type)=>canvas.items.filter(item=>item.kind==='widget'&&item.type===type);
const rects=(canvas,[width,height],flags={offline:false,expanded:false})=>checkCanvas(canvas,{width,height},flags);




// ---- the lookup order and the question ----

const LANDSCAPE={width:1366,height:768},PORTRAIT={width:768,height:1366};
function world({preset='laptop',viewport=LANDSCAPE,themes=[],canvases={},layout}={}){
  const state={layout:layout===undefined?{...defaultDeviceLayout(preset),revision:3}:layout,revision:3,viewport,themes,canvases,calls:[],asked:[],said:[],yes:undefined,undo:undefined};
  const flow=createThemeLayoutFlow({
    layout:()=>state.layout,revision:()=>state.revision,viewport:()=>state.viewport,customThemes:()=>state.themes,canvases:()=>state.canvases,themeName:choice=>state.themes.find(item=>item.id===choice)?.name??(choice==='widget'?'Widget':choice),
    call:async(path,body)=>{state.calls.push({path,body:clone(body)});parseDeviceLayout(body.layout);return {status:200,data:{revision:state.revision+1}};},
    adopt:(layout,revision)=>{state.layout=layout;state.revision=revision;},blocked:()=>'',
    ask:(name,orientation,yes)=>{state.asked.push({name,orientation});state.yes=yes;return true;},say:(title,detail,undo)=>{state.said.push({title,detail});state.undo=undo;},
  });
  return {state,flow};
}
const settle=()=>new Promise(yes=>setTimeout(yes,0));

