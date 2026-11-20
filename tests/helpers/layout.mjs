import {initialView,parseConfig,allComponents,v2ToV3,readConfig,viewFor} from '../../dist/packages/contracts/index.js';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

// T65 fixtures: arrays are the order; at.size still selects a component tier.
export const key=(id='primary',action=null,at={},extra={})=>({id,kind:'key',size:at.size??'S',label:extra.label??'My first button',icon:extra.icon??'app',action,...(({label:_l,icon:_i,...rest})=>rest)(extra)});
export const group=(id,kind,items,at={},extra={})=>({id,kind,size:at.size??'L',label:extra.label??'Group',icon:'app',items,...(({label:_l,...rest})=>rest)(extra)});
export const display=(id,kind,form,at={},extra={})=>({id,kind,form,size:at.size??'M',...extra});
export const flow=components=>components;
export const pagesWidget=(components=[],extra={})=>({id:'main',kind:'pages',pages:[{id:'page-1',name:'Page 1',widgets:components}],...extra});
// T94: a fixture is the page-shaped view (version 2, keys carry their size); seedDir writes it to disk as the v3 document the Host reads.
export const layout=(components=[key()],extra={})=>({...initialView(),...extra,widgets:[pagesWidget(components)]});
export const parsed=(components,extra)=>parseConfig(layout(components,extra));
// The same configuration with other components on the first page (what store.replace({...store.get(),components}) used to say).
export const withComponents=(config,components)=>({...config,widgets:[pagesWidget(components),...config.widgets.slice(1)]});
export const components=config=>allComponents(config);
// T94: readConfig turns any readable file into a v3 document; the view of its one layout is the page-shaped (version 2) document the older assertions look at. A converted file's
// two revisions are the file's one revision (a view of a v2 file left as it was therefore has layoutRevision = revision).
export const viewOf=value=>viewFor(readConfig(value),'Surface');
export const withLayoutRevision=config=>({...config,layoutRevision:config.revision});
// The configuration a fresh Host starts with, plus one configured key named `primary` (what the older tests started from).
export const withPrimary=(action=null,extra={})=>layout([key('primary',action,{},extra)]);
// Saves a configuration holding the primary key into a store (revision goes up by one).
export const seed=(store,action=null,apps=[])=>store.replace(withComponents(store.get(),[key('primary',action)]),apps);
// Adds the key `primary` to a configuration that has no component yet (what the older tests mutated), and returns the same configuration.
export const primed=(config,action=null)=>{if(!allComponents(config).length){const first=config.widgets[0];first.pages[0].widgets.push(...flow([key('primary',action)]));}return config;};
// Writes config.json holding the key `primary` at revision 0 (the older tests started from such a configuration) before a ConfigStore opens the directory.
export const seedDir=(dir,action=null)=>writeFileSync(join(dir,'config.json'),JSON.stringify(v2ToV3(layout([key('primary',action)])),null,2)+'\n',{mode:0o600});

// A shorthand for writing a configuration in tests as pages of slots (the way the older tests were written). It only builds a fixture in the one configuration
// format: every profile becomes a page of one Pages widget that fills the canvas; slot n of a page with `grid` columns sits at x = n % columns, y = floor(n / columns),
// and a size in cells maps to the matching tier. Nothing in the product reads this shape.
const TIERS=[['S',1,1],['M',2,1],['L',2,2],['XL',4,2],['Tall',1,2],['Wide',4,1]];
const tierFor=(cols,rows)=>(TIERS.find(([,c,r])=>c===cols&&r===rows)??TIERS[0])[0];
export function fromGrid(source){ const config=buildFromGrid(source); Object.defineProperty(config,'order',{value:source.buttons.map(button=>button.id),enumerable:false,configurable:true}); return compat(config); }
function buildFromGrid(source){
  const {profiles,buttons,schemaVersion:_v,...rest}=source;
  const grids=new Map(profiles.map(profile=>[profile.id,profile.grid??{columns:4,rows:3}]));
  const cols=Math.min(16,Math.max(2,...[...grids.values()].map(grid=>grid.columns))),rows=Math.min(12,Math.max(2,...[...grids.values()].map(grid=>grid.rows)));
  const pages=profiles.map(profile=>({id:profile.id,name:profile.name,widgets:buttons.filter(button=>button.profileId===profile.id).map(({profileId,position,size,kind,action,items,...button})=>{
    const grid=grids.get(profileId),cells=size??{columns:1,rows:1},group=kind&&kind!=='key';
    return {id:button.id,kind:kind??'key',size:tierFor(cells.columns,cells.rows),
      label:button.label,icon:button.icon,...(button.color!==undefined?{color:button.color}:{}),...(button.appearance?{appearance:button.appearance}:{}),
      ...(button.requiresConfirmation!==undefined&&!group?{requiresConfirmation:button.requiresConfirmation}:{}),...(group?{items}:{action:action??null})};
  })}));
  // The result readout and the activity list sit beside the pages, as they used to sit in the side column.
  return {format:'keyln.config',version:2,revision:rest.revision??0,gridSize:'standard',widgets:[{id:'pages',kind:'pages',pages}],
    ...(rest.workflows?{workflows:rest.workflows}:{}),...(rest.customThemes?{customThemes:rest.customThemes}:{})};
}

// Older tests read and write `config.components` and `config.pages`. These two non-enumerable members keep them working on the one configuration format: `components`
// is every key and group of the configuration (the same objects, so editing one edits the configuration; assigning a list replaces them in place), `pages` the pages of
// the first Pages widget. They are not part of the data: JSON, spreads and the app never see them.
export function compat(config){
  if(!config||typeof config!=='object'||Array.isArray(config)||!Array.isArray(config.widgets)||Object.getOwnPropertyDescriptor(config,'components'))return config;
  const isComponent=w=>['key'].includes(w.kind);
  Object.defineProperty(config,'components',{configurable:true,enumerable:false,get(){const list=allComponents(config),order=config.order;return order?[...list].sort((a,b)=>(order.indexOf(a.id)<0?1e9:order.indexOf(a.id))-(order.indexOf(b.id)<0?1e9:order.indexOf(b.id))):list;},set(list){
    const byId=new Map(list.map(item=>[item.id,item])),seen=new Set(),replace=widgets=>widgets.filter(w=>!isComponent(w)||byId.has(w.id)).map(w=>{if(!isComponent(w))return w;seen.add(w.id);return byId.get(w.id);});
    config.widgets=replace(config.widgets);
    const first=config.widgets.find(w=>w.kind==='pages');
    for(const widget of config.widgets) if(widget.kind==='pages') for(const page of widget.pages) page.widgets=replace(page.widgets);
    if(first) first.pages[0].widgets.push(...list.filter(item=>!seen.has(item.id)));
  }});
  Object.defineProperty(config,'pages',{configurable:true,enumerable:false,get(){return config.widgets.find(w=>w.kind==='pages')?.pages??[];}});
  return config;
}
