import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as C from '../dist/packages/contracts/index.js';
import {viewOf,withLayoutRevision} from './helpers/layout.mjs';
import {flowLayout,flowRectsU} from '../dist/apps/web/page-view.js';
import {LIBRARY_TYPES,previewsFor,tiersFor,defaultTier,specSpan,tierAfterFormChange} from '../dist/apps/web/library.js';
import {widgetTypes} from '../dist/apps/web/widgets/system.js';
import {createRegistry} from '../dist/apps/web/widgets/registry.js';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} ≈ ${b}`);

test('T68 all component types/forms declare integer-u presets or an explicit container/theme strategy; custom stays closed except Pages',()=>{
  assert.equal(C.STANDARD_KEY_U,120);
  assert.deepEqual(C.PRESET_SIZES.S,{w:120,h:120});
  for(const [key,definition] of Object.entries(C.COMPONENT_SIZING)){
    if(key==='pages') assert.deepEqual(definition.custom,{axes:'both',min:{w:1,h:1},max:{w:3840,h:3840}}); else assert.equal(definition.custom,false,key);
    if(definition.policy==='grid-preset'){
      for(const size of Object.values(definition.presets))assert.deepEqual(C.designSizeU(size),size);
      assert.ok(definition.offeredPresets.includes(definition.defaultPreset),key);
      const [kind,form]=key.split('/');assert.deepEqual(tiersFor(kind,form),definition.offeredPresets);
      assert.equal(defaultTier(kind,form),definition.defaultPreset);
    } else if(definition.policy==='theme-slot')assert.deepEqual(C.designSizeU(definition.defaultSize),definition.defaultSize);
  }
  const registry=createRegistry({});
  for(const type of widgetTypes){registry.register(type);for(const form of type.forms)assert.equal(registry.sizing(type.type,form),C.sizingFor(type.type,form));}
  for(const part of C.SYSTEM_PARTS)for(const form of C.SYSTEM_FORMS[part])assert.equal(C.sizingFor(part,form).policy,'theme-slot');
});
test('T68 1u precision supports exact integer sizes independently of standard-key presets and usable minima',()=>{
  for(const scale of [44/120,88/120,112/120,144/120,1.71]){
    const context=C.sizingContext(scale,12,{w:375,h:640});
    assert.deepEqual(C.resolveSizeU({policy:'exact',size:{w:1,h:17}},context),{w:1,h:17});
    const px=C.sizeToPx(C.resolveSizeU({policy:'exact',size:{w:137,h:83}},context),context);
    near(px.w,137*scale);near(px.h,83*scale);
    const fill=C.sizeToPx(C.resolveWidgetSizeU({kind:'pages'},context),context);near(fill.w,375);near(fill.h,640);
  }
  for(const value of [0,-1,1.2,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>C.designSizeU({w:value,h:1}));
  assert.throws(()=>C.resolveSizeU({policy:'grid-preset',size:{w:137,h:120}},C.sizingContext(1)));
  for(const scale of [0,-1,NaN,Infinity])assert.throws(()=>C.sizingContext(scale));
});
test('T68 grid presets include context gaps in u before final conversion; every historic tier renders for every type/form',()=>{
  for(const [key,definition] of Object.entries(C.COMPONENT_SIZING))if(definition.policy==='grid-preset'){
    const [kind,form]=key.split('/');
    for(const tier of C.sizeTiers)for(const cell of [44,88,112,144,159.7])for(const gap of [0,8,12,14]){
      const context=C.sizingContext(cell/120,gap),size=C.resolveWidgetSizeU({kind,form,size:tier},context),span=C.presetSpan(tier);
      near(size.w,C.PRESET_SIZES[tier].w+(span.cols-1)*context.gapU);
      const px=C.sizeToPx(size,context);near(px.w,span.cols*cell+(span.cols-1)*gap);near(px.h,span.rows*cell+(span.rows-1)*gap);
    }
  }
});
test('T68 v2 keeps preset references, rejects custom dimensions, and preserves non-offered historic presets on roundtrip/import',()=>{
  const config=C.initialView();config.widgets[0].pages[0].widgets=[{id:'wide-clock',kind:'clock',size:'XL',form:'time'}];
  assert.equal(viewOf(config).widgets[0].pages[0].widgets[0].size,'M');
  const withKey=structuredClone(config);withKey.widgets.push({id:'large-key',kind:'key',size:'XL',label:'Large key',icon:'app',action:null});
  const file=C.exportItemFile(withKey,'large-key');assert.equal(C.allComponents(C.itemFileLayout(C.parseItemFile(file)))[0].size,'XL');
  for(const mutate of [w=>w.size={w:137,h:83},w=>w.widthU=137,w=>w.heightU=83]){
    const next=structuredClone(config);mutate(next.widgets[0].pages[0].widgets[0]);assert.throws(()=>C.parseConfig(next));
  }
});
test('T68 theme-slot integer-u design defaults and all six theme layouts use a fixed context, independent of canvas Grid size',()=>{
  assert.equal(C.THEME_CONTEXT.pxPerU,1);
  for(const theme of C.themes){
    const layout=C.THEME_LAYOUTS[theme];
    for(const zones of [layout.wide,layout.narrow])for(const part of C.SYSTEM_PARTS){
      const slot=zones.slots[part],window={width:1368,height:912},rect=C.slotRect(slot,window);
      assert.deepEqual(C.designSizeU(slot),{w:slot.w,h:slot.h});
      for(const gridSize of C.gridSizes){
        C.sizingContext(C.GRID_CELL[gridSize]/120);
        assert.deepEqual(C.slotRect(slot,window),rect);
      }
      assert.equal(rect.w,slot.w);assert.equal(rect.h,slot.h);
    }
  }
});
test('T68 108 pre-change flow baselines preserve order, occupancy and geometry within floating point tolerance',()=>{
  const before=JSON.parse(readFileSync(new URL('./fixtures/t68-flow-before.json',import.meta.url)));
  assert.equal(before.cases.length,108);
  function compare(actual,expected){
    if(typeof expected==='number')near(actual,expected);
    else if(Array.isArray(expected)){assert.equal(actual.length,expected.length);expected.forEach((value,index)=>compare(actual[index],value));}
    else if(expected&&typeof expected==='object')for(const [key,value] of Object.entries(expected))compare(actual[key],value);
    else assert.equal(actual,expected);
  }
  for(const item of before.cases)compare(flowLayout(before.widgets,item.width,item.gridSize,item.gap,item.inset),item.layout);
});

test('T68 exact integer-u component declarations feed the real flow engine, with mixed widths/heights and no overlap or backfill',()=>{
  const original=C.COMPONENT_SIZING.key;
  C.COMPONENT_SIZING.key={...original,policy:'exact',presets:{...original.presets,S:{w:121,h:97},M:{w:1,h:1},L:{w:83,h:205}}};
  try{
    const widgets=['S','M','L','S','L','M','S'].map((size,index)=>({id:`exact-${index}`,kind:'key',size}));
    const layout=flowLayout(widgets,320,'standard',12,14),scale=layout.cell/120;
    assert.deepEqual(layout.placements.map(p=>p.id),widgets.map(w=>w.id));
    layout.placements.forEach((p,index)=>{
      const design=C.COMPONENT_SIZING.key.presets[widgets[index].size];near(p.width,design.w*scale);near(p.height,design.h*scale);
      assert.ok(p.left+p.width<=layout.width+1e-8);
      if(index){const previous=layout.placements[index-1];assert.ok(p.top>previous.top-1e-8&&(p.top>previous.top+1e-8||p.left>previous.left));}
      for(const previous of layout.placements.slice(0,index))assert.ok(!(p.left<previous.left+previous.width-1e-8&&p.left+p.width>previous.left+1e-8&&p.top<previous.top+previous.height-1e-8&&p.top+p.height>previous.top+1e-8));
    });
    assert.ok(layout.placements.some(p=>p.top>14),'the actual exact-size components wrap');
  }finally{C.COMPONENT_SIZING.key=original;}
  const rects=flowRectsU([{id:'a',w:121,h:97},{id:'b',w:1,h:1},{id:'c',w:83,h:205},{id:'d',w:121,h:97}],220,3.25);
  assert.deepEqual(rects.map(r=>[r.id,r.x,r.y]),[['a',0,0],['b',124.25,0],['c',128.5,0],['d',0,100.25]]);
});



test('T70 deleted sizing definitions are unavailable while retained widgets keep integer-u presets',()=>{for(const kind of ['app-group','action-group','media','latest-result','recent-activity'])assert.throws(()=>C.sizingFor(kind));for(const kind of ['key','clock','text','refresh'])assert.ok(C.sizingFor(kind,kind==='clock'?'time':kind==='text'?'title':kind==='refresh'?'button':undefined));});
