import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// T81: Midnight's station-line page tabs fit the Pages strip; stations sit above the page names and never cover them. T97: the strip is 32px, so the station line is rescaled (see t97).
const css=readFileSync(new URL('../apps/web/style.css',import.meta.url),'utf8');
const rule=selector=>{const i=css.indexOf(selector+'{');assert.ok(i>=0,`${selector} exists`);return css.slice(i,css.indexOf('}',i));};

test('Midnight tabs are 32px with the name below the stations',()=>{
  const tab=rule('[data-theme=midnight] .pages-strip .use-page');
  assert.match(tab,/height:32px;min-height:32px;padding:17px 12px 0;/);assert.match(tab,/line-height:14px/);assert.match(tab,/left 5px \/ 100% 3px/);
  const station=rule('[data-theme=midnight] .pages-strip .use-page::before');assert.match(station,/top:2px;[^}]*width:10px;height:10px/);
  const current=rule('[data-theme=midnight] .pages-strip .use-page[aria-pressed=true]::before');assert.match(current,/top:0;width:14px;height:14px/);
  // The largest station ends at 14px; the name starts at 17px.
  assert.doesNotMatch(css,/\[data-theme=midnight\] \.use-page\{[^}]*height:68px/,'the old 68px tab that the strip clipped is gone');
});
test('the Edit "+" is a plain button and the line stops at the last page',()=>{
  assert.match(rule('[data-theme=midnight] .pages-strip .use-page.add-page'),/line-height:32px;[^}]*background-image:none/);
  assert.match(rule('[data-theme=midnight] .pages-strip .use-page.add-page::before'),/content:none/);
  assert.match(rule('[data-theme=midnight] .pages-strip .use-page:has(+ .add-page)'),/background-size:50% 3px/);
});
