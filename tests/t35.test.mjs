import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {contrast,tintInk,tintSoftInk} from '../dist/apps/web/presentation.js';
import {themes,keyColors} from '../dist/packages/contracts/index.js';

// T35: the action line under a key's name is a smaller, quieter second size. Source-level checks on the shipped stylesheet and design records;
// the rendered sizes, colours and contrast were measured in headless Chrome (Docs/verification/T35.md). No test here renders a page.
const css=readFileSync(new URL('../apps/web/style.css',import.meta.url),'utf8');
function tokens(theme){
 const selector=theme==='braun'?':root:not([data-theme]),[data-theme=braun]{':`[data-theme=${theme}]{`,start=css.indexOf(selector);assert.ok(start>=0,`${theme} block`);
 const body=css.slice(start+selector.length,css.indexOf('\n}',start)),values={};
 for(const match of body.matchAll(/(--[a-z0-9-]+):([^;]+);/g))values[match[1]]=match[2].trim();
 return values;
}
const rule=(selector,from=0)=>{const start=css.indexOf(selector+'{',from);assert.ok(start>=0,selector);return css.slice(start,css.indexOf('}',start)+1);};
const keys=css.indexOf('/* ---------- keys');
const clamp=(low,value,high)=>Math.min(Math.max(value,low),high);
const channels=hex=>[1,3,5].map(offset=>parseInt(hex.slice(offset,offset+2),16));

test('the action line is 0.8 of the name, never under 11px, follows the page size, and is hidden under 100px cells; the name size is unchanged',()=>{
 const tile=rule('.control-tile',keys);
 assert.match(tile,/--fs:clamp\(12px,calc\(\(var\(--cell\) - 100px\) \* 100 \+ 16px\),16px\);/,'the name size rule (T102: no page-wide override)');
 assert.match(tile,/--fs-detail:max\(11px,calc\(var\(--fs\) \* \.8\)\)/);
 assert.match(rule('.control-tile .tile-label',keys),/font-size:var\(--fs\)/);
 assert.match(rule('.control-tile .tile-detail',keys),/font-size:clamp\(0px,calc\(\(var\(--cell\) - 100px\) \* 100 \+ var\(--fs-detail\)\),var\(--fs-detail\)\)/);
 // The same arithmetic in JavaScript: the name 16px gives 12.8px; a fitted page size shrinks the action line by the same ratio down to the 11px floor.
 const sub=size=>Math.max(11,size*.8);
 for(const [name,expected] of [[16,12.8],[15,12],[14,11.2],[13,11],[12,11],[11,11],[9,11]])assert.ok(Math.abs(sub(name)-expected)<1e-9,`${name}px name -> ${expected}px action line`);
 const shown=(cell,name=16)=>clamp(0,(cell-100)*100+sub(name),sub(name));
 for(const cell of [100,123,192,264])assert.ok(Math.abs(shown(cell)-12.8)<1e-9,`${cell}px cell: 12.8px beside a 16px name`);
 for(const cell of [44,82,99,99.5])assert.ok(shown(cell,12)<=Math.max(0,(cell-100)*100+11)+1e-9&&shown(cell,12)<1,`${cell}px cell: the action line is left out`);
 assert.ok(sub(16)/16===.8&&sub(16)<16,'a second size, smaller than the name');
 assert.doesNotMatch(css,/--detail-scale|--name-scale/,'no per-key text scaling came back');
});
test('every face has a --detail ink for the action line on the dark key body: quieter than muted text, 4.5:1 or better on the key, on a line between the legend and the key',()=>{
 for(const theme of themes){
  const t=tokens(theme);assert.match(t['--detail'],/^#[0-9A-F]{6}$/,`${theme} --detail`);
  const onKey=contrast(t['--detail'],t['--key']);
  assert.ok(onKey>=4.5,`${theme}: ${onKey.toFixed(2)} on the key body`);assert.ok(contrast(t['--detail'],t['--bg'])>=4.5,`${theme}: and on the ground`);
  assert.ok(onKey<contrast(t['--muted'],t['--key'])&&onKey<contrast(t['--dim'],t['--key']),`${theme}: quieter than muted and dim text (${onKey.toFixed(2)})`);
  assert.ok(onKey<=4.75,`${theme}: and close to the floor, not an almost-muted grey (${onKey.toFixed(2)})`);
  // It is the legend mixed toward the key body: each channel lies between the two.
  const a=channels(t['--text']),b=channels(t['--key']),d=channels(t['--detail']);
  d.forEach((value,index)=>assert.ok(value<=Math.max(a[index],b[index])&&value>=Math.min(a[index],b[index]),`${theme}: --detail is a mix of --text and --key`));
  // A hovered key sits on the raised surface, where --detail is too quiet; the action line goes back to --muted there, which keeps 4.5:1.
  assert.ok(contrast(t['--muted'],t['--surface-2'])>=4.5,`${theme}: --muted on the raised surface`);
 }
});
test('every filled key has a quiet action ink that still passes 4.5:1, no louder than the name and close to the floor',()=>{
 for(const theme of themes){
  const t=tokens(theme);
  for(const color of keyColors){
   const fill=t[`--c-${color}`],ink=t[`--i-${color}`],soft=t[`--s-${color}`],ratio=contrast(fill,soft);
   assert.ok(ratio>=4.5,`${theme} ${color}: ${ratio.toFixed(2)}`);assert.ok(ratio<=Math.min(contrast(fill,ink),4.75)+1e-9,`${theme} ${color}: quiet (${ratio.toFixed(2)})`);
  }
 }
 // Custom colours follow the same rule.
 for(const tint of ['#F0E060','#102030','#808080','#FF9548','#7A5C8E','#E2231A']){
  const ink=tintInk(tint),soft=tintSoftInk(tint,ink),ratio=contrast(tint,soft);
  assert.ok(ratio<=contrast(tint,ink)+1e-9,`${tint} never louder than the name`);
  if(contrast(tint,ink)>=4.5)assert.ok(ratio>=4.5,`${tint} keeps the floor`);else assert.equal(soft,ink,`${tint}: no ink reaches 4.5:1 on it, so the action line takes the name's own ink`);
  if(contrast(tint,ink)>=4.55)assert.ok(ratio<=4.9,`${tint}: ${ratio.toFixed(2)}`);
 }
});
test('the stylesheet sends every action line to the new inks: --detail on the body, --ink-2 on a fill, --muted only while hovered or pressed, state colours untouched',()=>{
 assert.match(rule('.control-tile .tile-detail',keys),/color:var\(--detail\)/);
 assert.match(css,/\.control-tile\[data-fill=solid\] \.tile-detail\{color:var\(--ink-2\)\}/);
 assert.match(css,/\.control-tile\[data-state=unconfigured\] \.tile-detail\{color:var\(--detail\)\}/);
 assert.match(css,/\.control-tile\[data-state=unconfigured\]\[data-fill=solid\] \.tile-detail\{color:var\(--ink-2\)\}/);
 assert.match(css,/@media\(hover:hover\)\{[^@]*\.control-tile\[data-fill=body\]:hover:enabled \.tile-detail\{color:var\(--muted\)\}/,'hover restores muted on the lighter surface');
 assert.match(css,/\[data-theme=classic\] \.control-tile:active:enabled \.tile-detail,\[data-theme=classic\] \.control-tile\[data-pressed=true\]:enabled \.tile-detail\{color:var\(--muted\)\}/,'and so does a pressed Classic key');
 assert.match(css,/\[data-theme=classic\] \.control-tile\[data-fill=solid\] \.tile-detail\{color:var\(--detail\)\}/);assert.match(css,/\[data-theme=classic\] \.control-tile \.tile-detail\{font-family:var\(--font-mono\);color:var\(--detail\)\}/);
 // No other action-line rule still reads from the old inks, except the restores above.
 for(const line of css.split('\n').filter(line=>/\.tile-detail\{[^}]*color:var\(--(muted|dim)\)/.test(line)))assert.match(line,/:hover|:active|data-pressed/,`only a hover or pressed rule may use muted: ${line.slice(0,120)}`);
 // State words keep their colours (Classic writes them in the action line).
 assert.match(css,/\[data-state=sending\],\[data-state=accepted\],\[data-state=running\]\) \.tile-detail\{color:var\(--accent\)\}/);
 assert.match(css,/\[data-state=succeeded\] \.tile-detail\{color:var\(--ok-text\)\}/);assert.match(css,/\[data-state=failed\],\[data-state=rejected\],\[data-state=unknown\]\) \.tile-detail\{color:var\(--danger-text\)\}/);
});