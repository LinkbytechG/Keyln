import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// T80 (ADR-077): the gear menu, the Edit toolbar and the Library use the 36px controls of ADR-076. Static assertions on the stylesheet.
const css=readFileSync(new URL('../apps/web/style.css',import.meta.url),'utf8');
const rule=(selector,from=0)=>{let start=css.indexOf(selector+'{',from);while(start>0&&!/[}\n]/.test(css[start-1]))start=css.indexOf(selector+'{',start+1);assert.ok(start>=0,`${selector} is defined`);return css.slice(start,css.indexOf('}',start)+1);};
const has=(selector,pattern,message)=>assert.match(rule(selector),pattern,message??selector);

test('the 36px base reaches the three surfaces and nothing wider',()=>{
  assert.match(css,/:where\(\.settings-card,\.theme-dialog,\.settings-popover,\.edit-float,\.edit-toolbar,\.shelf-panel\) :is\(button,input,select\)\{min-height:var\(--ctl-h\)\}/);
  assert.match(css,/:where\(\.settings-card,\.theme-dialog,\.settings-popover,\.edit-float,\.edit-toolbar,\.shelf-panel\) :is\(input,select\)\{padding:7px 10px;font-size:13px\}/);
  assert.match(css,/:is\(\.settings-card,\.theme-dialog,\.edit-menu,\.settings-popover,\.edit-float,\.edit-toolbar,\.shelf-panel\) :is\(button,input,select,summary\):focus-visible\{outline-offset:2px\}/);
  // the top bar gear is a sibling of the popover, never inside it
  const settings=readFileSync(new URL('../apps/web/widgets/settings.ts',import.meta.url),'utf8');
  assert.match(settings,/make\("details",\s*\{ id: "connection-settings"[^]*?make\("summary"[^]*?\), popover\)/,'the gear summary sits beside the popover, not in it');
  assert.equal((css.match(/!important/g)||[]).length,29,'T80 adds no !important (29 before and after)');
});

test('gear menu: tight padding, headings, one stack of 36px buttons, a shorter theme picker',()=>{
  has('.settings-popover',/padding:14px/);has('.settings-popover p',/margin-top:8px/);has('.settings-popover strong',/font-size:13px;font-weight:650/);
  assert.match(css,/\.settings-popover\{top:52px;width:348px;max-height:calc\(100dvh - var\(--header-h\) - 12px\);overflow-y:auto/,'width and the inner scroll stay');
  assert.match(css,/\.settings-popover \.quiet\{width:100%;padding:4px 12px;font-size:13px;white-space:normal\}/,'the popover buttons are one style, full width');
  assert.match(css,/\.settings-popover p:has\(>\.quiet\)\{margin-top:6px\}/);has('.theme-open',/margin-top:8px;width:100%/);
  assert.match(css,/\.settings-popover a\{display:inline-flex;align-items:center;min-height:var\(--ctl-h\)\}/);
  has('.execution-diagnostics summary',/min-height:var\(--ctl-h\)/);has('.execution-diagnostics .quiet',/margin-top:6px/);
  has('.theme-section',/padding-bottom:12px/);has('.theme-picker',/grid-template-columns:repeat\(2,minmax\(0,1fr\)\);gap:6px;margin-top:8px/);
  has('.theme-option',/padding:5px 5px 7px/);has('.theme-option[aria-pressed=true]',/border-color:var\(--accent\);box-shadow:inset 0 0 0 1px var\(--accent\)/,'the selected look stays');
  has('.theme-name',/margin-top:4px/);has('.theme-note-line',/font-size:11\.5px;line-height:1\.25/);
  has('.theme-preview',/gap:3px;height:32px;padding:5px/);
  // every face keeps its state mark inside the 32px preview (chips span 5px..25px of a 30px padding box)
  has('[data-theme=braun].theme-preview .tp-state',/top:8px;right:8px;width:7px;height:7px/);
  has('[data-theme=metro].theme-preview .tp-state',/left:5px;right:5px;bottom:5px;height:5px/);
  has('[data-theme=midnight].theme-preview .tp-state',/left:9px;right:9px;bottom:8px;height:3px/);
  has('[data-theme=standard].theme-preview .tp-state',/top:3px;right:3px;width:10px;height:10px/);
  has('[data-theme=widget].theme-preview .tp-state',/top:8px;right:8px;width:6px;height:6px/);
  assert.doesNotMatch(css,/\.theme-preview \.tp-state\{[^}]*(?:top|right|bottom):1[01]px/);
});

test('gear menu opens above the Edit toolbar and the library, below the quick menu and the save question',()=>{
  assert.match(css,/\.system-layer:has\(>details\.connection-settings\[open\]\)\{z-index:70\}/);
  const z=name=>Number(new RegExp(`${name}\\{[^}]*z-index:(\\d+)`).exec(css)[1]);
  assert.ok(z('\\.edit-float')<70&&z('\\.shelf-panel')<70&&z('\\.edit-menu')>70&&z('\\.edit-float \\.confirm-slot')>70);
  assert.match(css,/\.system-layer>details\.connection-settings \.settings-popover\{[^}]*max-height:calc\(100dvh - 120px\);overflow-y:auto/,'it still scrolls inside the window');
});

test('Edit toolbar: 36px row, select and buttons; the notices use 36px buttons',()=>{
  // T83 (ADR-078): the label and the scope line are gone from view (aria-label and #grid-size-scope keep them); the select shows its value only.
  has('.edit-float-row .edit-grid-size',/min-height:var\(--ctl-h\)/);has('.edit-float-row .edit-grid-size',/padding:0 4px 0 10px;font-size:13px/); // the native arrow sits inside; a wider right padding clips "Standard"
  assert.match(css,/\.edit-float-button\{[^}]*width:var\(--ctl-h\);height:var\(--ctl-h\);min-width:var\(--ctl-h\);min-height:var\(--ctl-h\)/);
  has('.edit-float-label',/font-size:13px/);assert.match(css,/\.edit-float-button \.ui-icon\{width:16px;height:16px\}/);
  has('.edit-float-button.icon-only',/width:var\(--ctl-h\);padding:0/,'the icon-only Settings, Library and Collapse buttons are 36x36');
  assert.doesNotMatch(css,/\.edit-save-slot|\.grid-size-row|\.edit-layout-tools|\.edit-transactions/,'T83: Save is inline, no reserved slot or two-row groups');has('.edit-done',/border-color:var\(--text\)/);
  has('.edit-float-row',/gap:6px;/);assert.match(rule('.edit-float-row'),/padding:6px;/);
  has('.edit-notice .text-button',/min-height:var\(--ctl-h\)/);has('.edit-float .confirm-slot .layout-confirm button',/min-height:var\(--ctl-h\)/);
  assert.doesNotMatch(css,/\.edit-float-button\{[^}]*(?:width|height):44px/);
  // the narrow rules still fit 375px: widths only, no heights (T83: Undo and Save become 36px icons)
  const narrow=css.slice(css.indexOf('/* Narrow windows keep the bar in one row'));assert.match(narrow.slice(0,narrow.indexOf('\n}\n')),/:is\(#edit-undo,#desk-save\)\{width:var\(--ctl-h\);padding:0\}/);
});

test('JS: the toolbar reserve is measured from the DOM, not a constant of the old height',()=>{
  const app=readFileSync(new URL('../apps/web/app.ts',import.meta.url),'utf8');
  // T83 (ADR-078): the toolbar floats over the preview; only the open Library is measured.
  assert.match(app,/el\("shelf-panel"\)\.getBoundingClientRect\(\)/);assert.doesNotMatch(app,/el\("edit-float-row"\)\.getBoundingClientRect\(\)/);
  for(const file of ['app.ts','console.ts','editor.ts','layout-tools.ts','page-layout.ts'])assert.doesNotMatch(readFileSync(new URL(`../apps/web/${file}`,import.meta.url),'utf8'),/\b(?:108|EDIT_TOOLBAR_H)\b/,file);
});

test('Library: 40px two-line nav, tighter panel, 36px search, sort, tabs and import buttons; cards keep their size',()=>{
  has('.shelf-type',/min-height:40px;padding:4px 10px/);has('.shelf-type',/font-size:13px;line-height:1\.2/);has('.shelf-type span',/font-size:11px/);
  has('.shelf-side',/gap:4px/);has('.shelf-types',/gap:4px/);
  has('.shelf-panel',/gap:10px;padding:8px 10px calc\(8px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css,/\.shell\{--shelf-h:244px;--edit-toolbar-h:50px\}/);assert.match(css,/--shelf-h:min\(52dvh,400px\)/);
  has('.shelf-previews',/gap:8px/);has('.shelf-message',/font-size:12px/);
  assert.match(css,/\.shelf-app-controls :is\(input,select\)\{min-height:var\(--ctl-h\);padding:7px 10px;font-size:13px\}/);
  has('.shelf-app-controls label',/margin:0;font-size:12px/);
  assert.match(css,/\.shelf-app-toolbar \.field-note\{margin:2px 0 0;font-size:11px;line-height:1\.4\}/);
  has('.shelf-tabs button',/min-height:var\(--ctl-h\);flex:1 1 auto;padding:0 12px;font-size:13px/);
  assert.match(css,/\.shelf-tabs \[aria-selected=true\],\.shelf-tabs \[aria-selected=true\]:hover:enabled\{border-color:var\(--accent\);background:var\(--accent-bg\)/,'the same pressed look as the other option buttons');
  assert.match(css,/\.shelf-import :is\(\.solid,\.quiet\)\{min-height:var\(--ctl-h\);padding:0 12px/);
  assert.match(css,/\.shelf-side \.shelf-type\{min-height:var\(--ctl-h\);justify-content:center/,'narrow, single-line nav');
  // previews are content, not buttons
  has('.shelf-card',/min-height:44px/);assert.match(css,/\.shelf-card\.shelf-app-card\{[^}]*min-height:88px/);has('.shelf-sample',/width:112px;height:76px/);
  assert.match(css,/\.shelf-window-tools button\{min-height:44px/,'the Windows dialog is not part of the compact Library');
});

test('what keeps 44px: keys, the remove badge, grips, library cards, the first-theme dialog, pairing and the icon search window (T97: page tabs are 32px and the top bar controls fill their slots)',()=>{
  assert.match(css,/\nbutton\{min-height:44px\}/);assert.match(css,/\ninput,select\{color:var\(--text\);width:100%;min-width:0;min-height:44px;padding:11px 12px;font-size:14px\}/);
  assert.match(css,/\nlabel\{display:block;margin:20px 0 8px\}/);
  assert.match(css,/\.edit-remove\{--pitch[^}]*width:44px;height:44px/s);
  assert.match(css,/\.pages-resize-handle\{[^}]*width:44px;height:44px;min-width:44px;min-height:44px/);
  assert.match(css,/\.use-page\{[^}]*min-height:32px/,'T97: page tabs 32px (were 44px)');assert.match(css,/\.mode-button,\.icon-button\{min-height:44px/,'the base is still 44px; the bar overrides it to fill its slot');assert.match(css,/\.connection\{[^}]*min-height:36px/,'T97: the capsule is 36px (was 44px)');
  assert.match(rule('.shelf-card'),/min-height:44px/);assert.match(rule('.theme-option'),/min-height:44px/);
  assert.match(css,/\.first-theme-actions button\{min-height:44px\}/);assert.match(css,/\.library-dialog \.library-tabs button\{min-height:44px\}/);
  assert.match(css,/\.pair-panel \.solid\{width:100%;margin:24px 0 16px\}/);
  const scoped=css.slice(css.indexOf('/* ---------- T79 (ADR-076)')).replace(/\/\*[\s\S]*?\*\//g,'');
  assert.doesNotMatch(scoped,/app-dialog|library-dialog|first-theme|pair-panel|use-page|mode-button/,'the scoped compaction does not reach them');
});

test('no literal colours and no new !important in the T80 additions',()=>{
  const t80=css.slice(css.indexOf('.system-layer:has(>details.connection-settings[open])'),css.indexOf('.shell[data-canvas=true] .grid-frame{'));
  assert.doesNotMatch(t80,/#[0-9a-fA-F]{3,8}\b|\brgba?\(|!important/);
});
