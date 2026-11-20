import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// T82: a tap outside the open gear menu closes it, and that tap does nothing else; Esc closes it too.
const src=readFileSync(new URL('../apps/web/widgets/settings.ts',import.meta.url),'utf8');

test('an outside tap closes the gear menu and its click is swallowed',()=>{
  assert.match(src,/document\.addEventListener\("pointerdown", outside, true\)/,'listens in the capture phase so nothing behind sees the tap first');
  assert.match(src,/element\.contains\(target\)/,'taps inside the menu keep it open');
  assert.match(src,/target\.closest\("#edit-settings"\)/,"the Edit toolbar's gear toggles the menu itself and is not outside");
  assert.match(src,/element\.open = false; swallow = true;/);
  assert.match(src,/document\.addEventListener\("click", swallowClick, true\)/);
  assert.match(src,/if \(!swallow\) return; swallow = false;[^;]*; event\.preventDefault\(\); event\.stopPropagation\(\);/,'only the one following click is swallowed, so a key behind the menu never runs');
  assert.match(src,/setTimeout\(\(\) => \{ swallow = false; \}, 800\)/,'a tap that never becomes a click (a scroll) does not eat a later click');
});
test('Esc closes the menu without also leaving Edit, and the listeners are removed with the widget',()=>{
  assert.match(src,/event\.key !== "Escape" \|\| !element\.open/);
  assert.match(src,/element\.open = false; event\.preventDefault\(\); event\.stopPropagation\(\); element\.querySelector\("summary"\)\?\.focus\(\);/);
  for(const [type,fn] of [['pointerdown','outside'],['click','swallowClick'],['keydown','escape']])assert.match(src,new RegExp(`document\\.removeEventListener\\("${type}", ${fn}, true\\)`));
});
