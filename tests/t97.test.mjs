import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import * as C from '../dist/packages/contracts/index.js';
import {flowLayout} from '../dist/apps/web/page-view.js';
import {topSpacing} from '../dist/apps/web/console.js';
import {planZones} from '../dist/apps/web/zones.js';
import {client} from './helpers/client-harness.mjs';
import {key} from './helpers/layout.mjs';
import {responsiveBoxes,treeFind} from './helpers/responsive-boxes.mjs';

// T97 (ADR-088): a 52px top bar in the ground colour of the canvas (no dividing line), 32px page tabs, and about 4px between the bar and the first Pages tabs. The zone
// values and the layout run on the production code; the stylesheet is read as text; the page tests run the compiled client against the minimal DOM. None of this is browser
// rendering or Surface evidence.
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const css=read('apps/web/style.css');
// A rule is found where its selector starts a line (so `.pages-strip` is not found inside `[data-theme=midnight] .pages-strip` or a grouped selector).
const rule=selector=>{let start=css.indexOf('\n'+selector+'{');if(start>=0)start+=1;else start=css.indexOf(selector+'{');assert.ok(start>=0,selector);return css.slice(start,css.indexOf('}',start)+1);};
const themeBlock=name=>{const start=css.indexOf(`[data-theme=${name}]{`);assert.ok(start>=0,name);return css.slice(start,css.indexOf('\n}',start));};
const APP={type:'app.open',appId:'test.app'};

// ---- the zones ----------------------------------------------------------------------------------------------------------------------------------
const BARS={braun:{pad:28},metro:{pad:20},midnight:{pad:24},standard:{pad:20},classic:{pad:28}};
test('T97 every theme with a bar: wide header 52, capsule 200x36, switch 140x40, gear 40x40, centred, content starts at the bar\'s foot, 12px between switch and gear',()=>{
  assert.deepEqual(Object.keys(BARS).sort(),C.themes.filter(name=>name!=='widget').sort(),'the five bar themes are all the themes but Widget');
  for(const [name,{pad}] of Object.entries(BARS)){
    const wide=C.THEME_LAYOUTS[name].wide;
    assert.equal(wide.header,52,`${name} header`);
    assert.deepEqual(wide.slots.connection,{form:'capsule',w:200,h:36,left:pad,top:8},`${name} capsule`);
    assert.deepEqual(wide.slots['mode-switch'],{form:'segmented',w:140,h:40,right:pad+40+12,top:6},`${name} switch: 12px left of the gear`);
    assert.deepEqual(wide.slots.settings,{form:'gear',w:40,h:40,right:pad,top:6},`${name} gear`);
    assert.deepEqual(wide.content,{left:0,right:0,top:52,bottom:0},`${name}: the content area starts where the bar ends and reaches the window edges (the canvas keeps its own 1u)`);
    for(const part of C.SYSTEM_PARTS){const slot=wide.slots[part];assert.equal(slot.top*2+slot.h,52,`${name} ${part} is vertically centred in the bar`);}
    assert.equal(C.zoneProblem(wide,C.ZONE_CHECK_WINDOWS.wide),undefined,`${name} passes the zone rules in every wide check window`);
    assert.deepEqual(C.parseThemeLayout(JSON.parse(JSON.stringify(C.THEME_LAYOUTS[name]))),C.THEME_LAYOUTS[name],`${name} round-trips through the strict parser`);
    // On the page: the plan puts the bar's foot and the content area at 52 in a real window.
    const plan=planZones(C.THEME_LAYOUTS[name],{width:1366,height:768});
    assert.equal(plan.zones.header,52);assert.equal(plan.content.y,52);assert.deepEqual(plan.content,{x:0,y:52,w:1366,h:768-52});assert.equal(plan.slots.connection.y,8);assert.equal(plan.slots.settings.x,1366-pad-40);assert.equal(plan.slots['mode-switch'].x,1366-pad-40-12-140);
    assert.equal(plan.slots['mode-switch'].x+140+12,plan.slots.settings.x,'exactly 12px between the switch and the gear');
  }
});
test('T97 the phone bar and the Widget theme are unchanged',()=>{
  for(const name of Object.keys(BARS)){
    const narrow=C.THEME_LAYOUTS[name].narrow;
    assert.deepEqual(narrow,{header:56,slots:{connection:{form:'dot-button',w:44,h:44,left:8,top:6},'mode-switch':{form:'icon',w:44,h:44,right:64,top:6},settings:{form:'gear',w:44,h:44,right:8,top:6}},content:{left:8,right:8,top:56,bottom:8}},`${name} narrow`);
    assert.equal(C.zoneProblem(narrow,C.ZONE_CHECK_WINDOWS.narrow),undefined);
  }
  const widget=C.THEME_LAYOUTS.widget;
  const slots={connection:{form:'dot-button',w:44,h:44,left:12,top:8},'mode-switch':{form:'icon',w:44,h:44,right:68,top:8},settings:{form:'gear',w:44,h:44,right:12,top:8}};
  assert.deepEqual(widget.narrow,{header:0,slots,content:{left:12,right:12,top:60,bottom:12}},'the phone Widget layout is unchanged');
  assert.deepEqual(widget.wide,{header:0,slots,content:{left:0,right:0,top:52,bottom:0}},'a wide Widget window: the controls keep their places; the canvas starts right under them and reaches the window edges');
  for(const side of ['wide','narrow'])assert.equal(C.zoneProblem(widget[side],C.ZONE_CHECK_WINDOWS[side]),undefined);
});
test('T97 a custom theme with its own stored layout is not rewritten; one without follows its base theme',()=>{
  const old=C.parseThemeLayout({wide:{header:72,slots:{connection:{form:'capsule',w:200,h:40,left:28,top:16},'mode-switch':{form:'segmented',w:148,h:44,right:84,top:14},settings:{form:'gear',w:44,h:44,right:28,top:14}},content:{left:28,right:28,top:72,bottom:16}},narrow:C.THEME_LAYOUTS.braun.narrow});
  const theme=(extra={})=>({id:'theme-one',name:'One',base:'metro',accent:'#F26B1D',background:'#101216',keyBody:'#1E2124',radius:'rounded',spacing:'normal',font:'metro',...extra});
  const kept=C.parseCustomThemes([theme({layout:old})]);assert.deepEqual(kept[0].layout,old,'the stored 72px layout is kept exactly (it still passes the rules)');
  assert.equal(C.resolveTheme('theme-one',kept).layout.wide.header,72);
  assert.equal(C.resolveTheme('theme-one',[theme()]).layout.wide.header,52,'no stored layout: the base theme\'s new bar');
});

// ---- the stylesheet -----------------------------------------------------------------------------------------------------------------------------
test('T97 style: the bar has no dividing line and is the canvas ground; --header-h is 52px in the five bar themes and Widget keeps its own',()=>{
  const bar=rule('.system-bar');assert.match(bar,/background:var\(--bg\)/);assert.doesNotMatch(bar,/border-(?:bottom|top|left|right)|border:|--bar-bg|--hair/);
  for(const name of Object.keys(BARS))assert.match(themeBlock(name),/--header-h:52px;/,`${name} --header-h`);
  assert.match(themeBlock('widget'),/--header-h:60px;/,'Widget has no bar; its token is not the bar');
  assert.match(css,/\.connection-recovery\{[^}]*top:calc\(var\(--header-h\) \+ 8px\)/,'the recovery notice still hangs 8px under the bar');
  assert.match(css,/\.settings-popover\{[^}]*max-height:calc\(100dvh - var\(--header-h\) - 12px\)/);
  // the warning banner that uses --bar-bg is Midnight's key status bar, not the top bar
  assert.ok(css.includes('background:var(--bar-bg);color:var(--warn)}'));
});
test('T97 style: the bar controls fill their slots (capsule 36, switch halves, gear 40) and keep their look; the phone dot button and icon stay 44px',()=>{
  assert.match(rule('.connection'),/min-height:36px/);
  assert.match(rule('.system-layer .connection-button'),/height:100%;min-height:0/);
  assert.match(rule('.system-layer>.mode-switch .mode-button'),/min-height:0;padding:0 8px/);
  assert.match(rule('.system-layer>details.connection-settings>summary'),/width:100%;height:100%;min-width:0;min-height:0/);
  assert.match(css,/\.mode-button,\.icon-button\{min-height:44px/,'the base control is still 44px (the phone dot button and icon button are .icon-button)');
  assert.match(css,/\.icon-button\{display:grid;place-items:center;min-width:44px;height:44px/);
  assert.match(css,/\.shell\[data-canvas=true\] \.conn-dot-button\{/);
});
test('T97 style: page tabs are exactly 32px (line-height 32px), the strip has no vertical padding and no 44px override is left',()=>{
  assert.match(rule('.use-page'),/min-height:32px/);assert.match(rule('.use-page'),/line-height:32px/);
  assert.match(rule('.use-pages'),/padding:0 4px/);assert.doesNotMatch(rule('.use-pages'),/padding:6px/);
  assert.match(rule('.pages-strip'),/height:32px/);assert.match(rule('.pages-strip .use-page'),/min-height:32px;padding:0 12px;line-height:32px/);
  assert.match(rule('.pages-strip .page-dot'),/min-height:32px/);assert.match(rule('.pages-strip .add-page'),/min-width:44px/,'the add button may stay 44px wide');
  assert.doesNotMatch(css,/\.pages-strip\{height:44px\}/);assert.doesNotMatch(css,/\.pages-strip \.use-page\{min-height:44px\}/);
  // the Edit strip: the owner grip, the remove target and the tabs are 32px tall too
  assert.match(rule('.pages-owner'),/height:32px/);assert.match(rule('.pages-owner-label'),/min-height:32px/);assert.match(rule('.pages-remove'),/width:44px;height:32px/);assert.match(rule('.pages-tabs'),/height:32px/);
  assert.match(rule('.pages-resize-handle'),/width:44px;height:44px/,'the resize handles keep 44px');
});
test('T97 style: Metro, Midnight and Classic tabs are rescaled to the 32px strip',()=>{
  const metro=rule('[data-theme=metro] .use-page::before');assert.match(metro,/width:22px;height:22px/);assert.match(metro,/line-height:22px/);assert.match(metro,/font-size:13px/);
  assert.match(css,/\[data-theme=metro\] \.pages-strip \.use-page\[aria-pressed=true\]\{box-shadow:inset 0 -4px 0 var\(--tab-c\)\}/,'the active underline stays');
  const tab=rule('[data-theme=midnight] .pages-strip .use-page');assert.match(tab,/height:32px;min-height:32px;padding:17px 12px 0/);assert.match(tab,/line-height:14px/);assert.match(tab,/left 5px \/ 100% 3px/);
  assert.match(rule('[data-theme=midnight] .pages-strip .use-page::before'),/top:2px;[^}]*width:10px;height:10px/);
  assert.match(rule('[data-theme=midnight] .pages-strip .use-page[aria-pressed=true]::before'),/top:0;width:14px;height:14px/);
  assert.match(rule('[data-theme=midnight] .pages-strip .use-page.add-page'),/line-height:32px/);assert.match(rule('[data-theme=midnight] .use-pages'),/padding:0 8px/);
  // The station circles end at 14px and the name starts at 17px: they never touch.
  assert.ok(14<17&&17+14<=32,'stations above the name, both inside 32px');
  assert.match(rule('[data-theme=classic] .use-pages'),/padding:0 2px;[^}]*box-shadow:inset 0 0 0 1px var\(--line\)/);assert.doesNotMatch(rule('[data-theme=classic] .use-pages'),/border:/);
  assert.match(rule('.pages-widget[data-editing=true]>.pages-strip'),/box-shadow:none/,'Edit draws no track');
  assert.doesNotMatch(css,/\[data-theme=[a-z]+\] [^{]*\.use-page\{[^}]*height:44px/,'no theme keeps a 44px tab');
});

// ---- the layout: the gap between the bar and the first tabs ------------------------------------------------------------------------------------
test('T97 flowLayout: insetTop defaults to inset (nothing changes); a smaller insetTop only moves the rows up and shortens the canvas',()=>{
  const widgets=[key('a',APP),key('b',APP),key('c',APP)],plain=flowLayout(widgets,900,'standard',8,14);
  assert.deepEqual(flowLayout(widgets,900,'standard',8,14,0,0,undefined,14),plain,'the default is the inset itself');
  const top0=flowLayout(widgets,900,'standard',8,14,0,0,undefined,0);
  assert.equal(top0.cell,plain.cell);assert.equal(top0.pitch,plain.pitch);assert.equal(top0.columns,plain.columns,'horizontal spacing, columns and cell are untouched');
  top0.placements.forEach((p,i)=>{assert.ok(Math.abs(p.top-(plain.placements[i].top-14))<1e-6,'every row moves up by exactly the inset');assert.equal(p.left,plain.placements[i].left);assert.equal(p.width,plain.placements[i].width);assert.equal(p.height,plain.placements[i].height);});
  assert.ok(Math.abs(top0.height-(plain.height-14))<1e-6,'the canvas is 14px shorter');
  const pages=[{id:'p',kind:'pages',size:{w:{mode:'fill',min:240},h:{mode:'fill',min:240}},pages:[{id:'q',name:'Q',widgets:[]}]}];
  const filled=flowLayout(pages,900,'standard',8,14,600,0,undefined,0).placements[0],before=flowLayout(pages,900,'standard',8,14,600).placements[0];
  assert.equal(filled.top,0);assert.ok(Math.abs(filled.height-(before.height+14))<1e-6,'a Fill height gets the room back and still ends 14px above the area\'s foot');
  assert.ok(Math.abs(filled.top+filled.height+14-600)<1e-6);
});
const scene=(widgets)=>C.parseConfig({...C.initialView(),revision:2,widgets});
const fillSize={w:{mode:'fill',min:240},h:{mode:'fill',min:240}},fixedSize={w:{mode:'fixed',u:480},h:{mode:'fill',min:240}};
const pagesWidget=(id,extra={})=>({id,kind:'pages',pages:[{id:`${id}-a`,name:'A',widgets:[key(`${id}-k1`,APP)]},{id:`${id}-b`,name:'B',widgets:[]}],...extra});
const clock=(id='clock')=>({id,kind:'clock',form:'time',size:'M'});
async function world(t,widgets,{theme='braun',width=1366,height=768,gap}={}){
  const f=await client(t,{configuration:scene(widgets),deviceTheme:{theme},viewport:{width,height}});
  await f.until(()=>!f.el('edit-layout').disabled&&f.state&&f.sockets[0]?.readyState===1);await f.drain();
  if(gap!==undefined){window.getComputedStyle=()=>({getPropertyValue:name=>name==='--gap'?`${gap}px`:''});f.windowEvents.get('resize')();await f.drain();}
  responsiveBoxes(f);return f;
}
const outerOf=(f,id)=>treeFind(f.el('button-grid'),n=>n.className==='pages-widget'&&n.dataset.widgetId===id);
const num=(node,name)=>Number(node.style[name]);
const near=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<1e-6,`${message}: ${actual} != ${expected}`);
const box=node=>({x:num(node,'--kx'),y:num(node,'--ky'),w:num(node,'--kw'),h:num(node,'--kh')});

test('T97 the spacing rule: 1u from the edge, 2u around Pages, whole px, at least 1px and 2px; a narrow window keeps the old inset',()=>{
  for(const [size,edge,gap] of [['compact',1,2],['standard',1,2],['large',1,2]])assert.deepEqual(topSpacing(true,size,8),{wide:true,edge,pagesEdge:edge,pagesGap:gap},size);
  assert.deepEqual(topSpacing(false,'standard',8),{wide:false,edge:14,pagesEdge:0,pagesGap:8},'narrow: the old 14px inset and the key gap');
  assert.equal(C.GRID_CELL.standard/C.STANDARD_KEY_U<1.5&&C.GRID_CELL.large/C.STANDARD_KEY_U<1.5,true,'1u rounds to 1px at every Grid size');
});
test('T97 flowLayout: insetTop defaults to inset; pagesGap defaults to gap; a Pages neighbour changes only the gap next to it',()=>{
  const widgets=[key('a',APP),key('b',APP),key('c',APP)],plain=flowLayout(widgets,900,'standard',8,14);
  assert.deepEqual(flowLayout(widgets,900,'standard',8,14,0,0,undefined,14,8),plain,'both defaults are the old behaviour');
  const top0=flowLayout(widgets,900,'standard',8,14,0,0,undefined,0);
  assert.equal(top0.cell,plain.cell);assert.equal(top0.columns,plain.columns);
  top0.placements.forEach((p,i)=>assert.ok(Math.abs(p.top-(plain.placements[i].top-14))<1e-6));assert.ok(Math.abs(top0.height-(plain.height-14))<1e-6);
  assert.deepEqual(flowLayout(widgets,900,'standard',8,1,0,0,undefined,1,2).placements.map(p=>[p.left,p.top,p.width]),flowLayout(widgets,900,'standard',8,1,0,0,undefined,1).placements.map(p=>[p.left,p.top,p.width]),'without a Pages item the Pages gap is never used');
  const pages=(id,size)=>({id,kind:'pages',size,pages:[{id:`${id}-p`,name:'P',widgets:[]}]});
  const pair=flowLayout([pages('l',fillSize),pages('r',fixedSize)],1368,'standard',8,1,700,1,undefined,1,2).placements;
  assert.ok(Math.abs(pair[0].left+pair[0].width+2-pair[1].left)<1e-6,'2px between side-by-side Pages (not the key gap of 8)');assert.ok(Math.abs(pair[1].left+pair[1].width-(1368-1))<1e-6,'the last one ends 1px from the edge');assert.equal(pair[0].left,1);
  const halves=flowLayout([pages('l',{w:{mode:'percent',pct:50},h:fillSize.h}),pages('r',{w:{mode:'percent',pct:50},h:fillSize.h})],1368,'standard',8,1,700,1,undefined,1,2).placements;
  assert.ok(Math.abs(halves[0].left+halves[0].width+2-halves[1].left)<1e-6&&Math.abs(halves[1].left+halves[1].width-1367)<1e-6,'two 50% Pages fill the width exactly with the 2px gap (percent divides the width with that gap)');
  const mixed=flowLayout([pages('p',fixedSize),clock(),key('k1',APP),key('k2',APP)],1368,'standard',8,1,0,1,undefined,1,2).placements,by=Object.fromEntries(mixed.map(p=>[p.id,p]));
  assert.ok(Math.abs(by.p.left+by.p.width+2-by.clock.left)<1e-6,'2px between a Pages and a clock');
  assert.ok(Math.abs(by.k2.left-(by.k1.left+by.k1.width+8))<1e-6||by.k2.top>by.k1.top,'two keys keep the key gap');
  const stacked=flowLayout([pages('a',{w:{mode:'fill',min:800},h:{mode:'fixed',u:300}}),pages('b',{w:{mode:'fill',min:800},h:{mode:'fixed',u:300}}),key('k',APP)],900,'standard',8,1,0,1,undefined,1,2).placements;
  assert.ok(Math.abs(stacked[0].top+stacked[0].height+2-stacked[1].top)<1e-6,'2px between Pages stacked in rows');assert.ok(Math.abs(stacked[1].top+stacked[1].height+2-stacked[2].top)<1e-6,'and between a Pages and the key under it');
});
const CASES={'a full-width Pages':[pagesWidget('main')],
  'Fill and Custom side by side':[pagesWidget('left',{size:fillSize}),pagesWidget('right',{size:fixedSize})],
  'a key and then a full-width Pages':[key('first',APP),pagesWidget('main')],
  'a Pages and a clock':[pagesWidget('left',{size:fillSize}),clock()]};
test('T97 wide windows, every theme with a canvas: the first top-level item is 1u from the window edge on the left, right and bottom, and 1u below the bar',async t=>{
  assert.match(rule('.shell[data-canvas=true] .grid-frame'),/padding:var\(--frame-pad,4px\)/);
  for(const theme of C.themes)await t.test(theme,async t=>{
    const top=theme==='widget'?52:52;
    for(const [name,widgets] of Object.entries(CASES)){
      const f=await world(t,widgets,{theme}),frame=f.el('grid-frame'),W=parseFloat(frame.style.width),H=parseFloat(frame.style.height);
      assert.equal(frame.style.top,`${top}px`,`${theme} ${name}`);assert.equal(frame.style.left,'0px');assert.equal(W,1366,'the frame reaches both window edges');assert.equal(frame.style['--frame-pad'],'0px');
      assert.equal(parseFloat(frame.style.top)+H,768,'and the foot of the window');
      const first=widgets[0],node=first.kind==='pages'?outerOf(f,first.id):f.button(first.id),b=box(node);
      assert.equal(b.x,1,`${theme} ${name}: left edge`);assert.equal(b.y,1,`${theme} ${name}: 1u below the bar (the frame starts at the bar's foot)`);
      const all=Object.fromEntries(widgets.map(w=>[w.id,w.kind==='pages'?outerOf(f,w.id):f.button(w.id)??treeFind(f.el('button-grid'),n=>n.dataset?.widgetId===w.id)]));
      const rights=widgets.map(w=>{const r=box(all[w.id]);return r.x+r.w;});
      if(widgets.length===1||name==='Fill and Custom side by side')near(Math.max(...rights),W-1,`${theme} ${name}: right edge`);
      if(name==='a full-width Pages'||name==='Fill and Custom side by side')near(b.y+b.h,H-1,`${theme} ${name}: bottom edge`);
    }
  });
});
test('T97 two side-by-side Pages (Fill and Custom 480u, as on the owner\'s Surface): 2u between them, equal tops and heights, 1u at the edges',async t=>{
  const f=await world(t,CASES['Fill and Custom side by side'],{gap:8}),left=box(outerOf(f,'left')),right=box(outerOf(f,'right'));
  assert.equal(left.x,1);near(left.x+left.w+2,right.x,'2px between the Pages (not the key gap of 8)');near(right.x+right.w,1366-1,'right edge');
  assert.equal(left.y,right.y);assert.equal(left.h,right.h);near(left.y+left.h,768-52-1,'bottom edge');
  const scale=parseFloat(outerOf(f,'right').style['--cell'])/120;assert.ok(Math.abs(right.w/scale-480)<.5,'the Custom width still means 480u');
  assert.equal(num(f.button('left-k1'),'--kx'),14,'inside a Pages box: the 14px to its keys is unchanged');assert.equal(num(f.button('left-k1'),'--ky'),14);
});
test('T97 a Pages and a top-level clock: 2u between them; plain top-level keys keep the key gap; stacked Pages and a key under them 2u',async t=>{
  const f=await world(t,CASES['a Pages and a clock'],{gap:8}),p=box(outerOf(f,'left')),c=box(treeFind(f.el('button-grid'),n=>n.dataset?.widgetId==='clock'));
  assert.ok(Math.abs(c.x-(p.x+p.w+2))<1e-6||Math.abs(c.y-(p.y+p.h+2))<1e-6,'the clock sits 2px from the Pages, to its right or below it');
  const keys=await world(t,[key('a',APP),key('b',APP),key('c',APP)],{gap:8}),a=box(keys.button('a')),b=box(keys.button('b'));
  assert.equal(a.x,1);assert.equal(a.y,1);near(b.x,a.x+a.w+8,'keys keep the key gap');
  const stack=await world(t,[pagesWidget('one'),pagesWidget('two'),key('under',APP)],{gap:8}),one=box(outerOf(stack,'one')),two=box(outerOf(stack,'two')),under=box(stack.button('under'));
  assert.equal(one.x,1);assert.equal(one.y,1);near(two.y,one.y+one.h+2,'2px between stacked full-width Pages');near(under.y,two.y+two.h+2,'and between a Pages and the key under it');assert.equal(under.x,1);
  const mid=await world(t,[pagesWidget('p'),key('x',APP),key('y',APP)],{gap:8}),x=box(mid.button('x')),y=box(mid.button('y'));near(y.x,x.x+x.w+8,'two keys below a Pages keep the key gap');
});
test('T97 the canvas height ends 1u under the last item; Fill grows to the new room; Edit keeps the same positions as Use',async t=>{
  const f=await world(t,CASES['a full-width Pages']),use=box(outerOf(f,'main'));
  near(parseFloat(f.el('button-grid').style.height),use.y+use.h+1,'1u below the last item');
  f.el('edit-layout').emit('click');await f.drain();responsiveBoxes(f);assert.deepEqual(box(outerOf(f,'main')),use,'no layout jump on entering Edit');
  f.el('edit-back').emit('click');await f.drain();
});
test('T97 a narrow window keeps the old spacing: 4px frame padding, 14px inset, nothing above the first row, the key gap between items',async t=>{
  for(const width of [375,320,600]){
    const f=await world(t,[key('first',APP),pagesWidget('main'),key('below',APP)],{width,height:800,gap:8}),frame=f.el('grid-frame');
    assert.equal(frame.style['--frame-pad'],'4px');assert.equal(num(f.button('first'),'--kx'),14);assert.equal(num(f.button('first'),'--ky'),0);
    const pages=box(outerOf(f,'main'));assert.equal(pages.x,0,'a full-width Pages touches the frame padding only');assert.equal(pages.w,parseFloat(f.el('button-grid').style.width));
    const first=box(f.button('first'));near(pages.y,first.y+first.h+14+8,'the old gap: the flow\'s 14px bottom inset plus the key gap');
    near(num(f.button('below'),'--ky'),pages.y+pages.h+8+14,'a later run keeps the 14px above its first row');
  }
});
test('T97 drop landing uses the new geometry: the dashed cell sits on the cell the pointer is over, 1u from the edge',async t=>{
  const f=await client(t,{configuration:scene([key('a',APP),key('b',APP),key('c',APP)]),viewport:{width:1366,height:768},moveMode:'swap'});
  await f.until(()=>!f.el('edit-layout').disabled&&f.state&&f.sockets[0]?.readyState===1);await f.drain();
  f.el('edit-layout').emit('click');await f.drain();responsiveBoxes(f);
  const a=f.button('a'),c=f.button('c'),pitch=c.rect.left-f.button('b').rect.left,grid=f.el('button-grid');
  const target=[grid.rect.left+1+4.5*pitch,grid.rect.top+1+pitch/2],from=[a.rect.left+a.rect.width/2,a.rect.top+a.rect.height/2];
  a.emit('pointerdown',{isPrimary:true,button:0,pointerId:1,pointerType:'mouse',clientX:from[0],clientY:from[1]});a.emit('pointermove',{pointerId:1,clientX:from[0]+20,clientY:from[1]+20});
  f.documentEvents.get('pointermove')({pointerId:1,clientX:target[0],clientY:target[1]});
  const ghost=treeFind(grid,n=>n.className==='drop-ghost');assert.equal(ghost.dataset.shape,'cell');assert.equal(ghost.dataset.refused,'false');
  assert.ok(Math.abs(parseFloat(ghost.style.left)-(1+4*pitch))<.01,'cell 4 starts 1px + 4 pitches in');assert.ok(Math.abs(parseFloat(ghost.style.top)-1)<.01,'row 0 starts 1px down');
  f.documentEvents.get('pointerup')({pointerId:1,clientX:target[0],clientY:target[1]});await f.drain();
});
test('T97 Edit overlays at the window edge stay whole: the "−" is drawn inward, the Pages frame and handles are inside the Pages box',async t=>{
  const f=await world(t,[key('first',APP),pagesWidget('main')]);
  f.el('edit-layout').emit('click');await f.drain();responsiveBoxes(f);
  const minus=treeFind(f.el('button-grid'),n=>n.dataset?.removeFor==='first'),grid=f.el('button-grid');
  assert.equal(minus.rect.height,44);assert.ok(minus.rect.left+11>=grid.rect.left&&minus.rect.top+11>=grid.rect.top,'the 22px disc (11px in) is inside the canvas');
  assert.equal(num(minus,'--kx'),3,'clamped inward: the disc centre is 8px from the corner, so 3px keeps its edge at 0');
  assert.match(rule('.pages-resize-handle[data-axis=xy]'),/right:0;bottom:0/);assert.match(rule('.pages-resize-handle[data-axis=x]'),/right:0/);assert.match(rule('.pages-resize-handle[data-axis=y]'),/bottom:0/);
  assert.match(rule('.pages-widget[data-editing=true]'),/outline:1px dashed var\(--muted\);outline-offset:-1px/,'the dashed frame is drawn inside the box');
  f.el('edit-back').emit('click');await f.drain();
});

// ---- the documents ------------------------------------------------------------------------------------------------------------------------------
test('T97 flowLayout: two fixed Pages that fill the row exactly in u stay side by side when the whole-px 2u gap makes them a fraction of a px too wide',()=>{
  const pages=(id,u)=>({id,kind:'pages',size:{w:{mode:'fixed',u},h:{mode:'fill',min:240}},pages:[{id:`${id}-p`,name:'P',widgets:[]}]});
  const at=(w,list)=>flowLayout(list,w,'standard',12,1,858,0,undefined,1,2).placements;
  for(const [w,over] of [[1368,.1],[1368,.9],[1200,.5]]){
    const pxPerU=at(w,[pages('probe',120)])[0].width/120,uM=1000,uR=(w-4+over-uM*pxPerU)/pxPerU;
    const [a,b]=at(w,[pages('m',uM),pages('r',uR)]);
    assert.equal(b.top,a.top,`over by ${over}px at ${w}: one row`);
    assert.ok(Math.abs(b.left+b.width-(w-1))<1e-6,'the last one gives the excess back and ends at the 1u edge');assert.ok(Math.abs(b.left-(a.left+a.width)-2)<1e-6,'2u between them');
    assert.ok(Math.abs(a.width-uM*pxPerU)<1e-6,'the first keeps its size');
    const uWide=(w-4+1.5-uM*pxPerU)/pxPerU,[c,d]=at(w,[pages('m',uM),pages('r',uWide)]);assert.notEqual(d.top,c.top,'more than 1px over still wraps');
  }
});
