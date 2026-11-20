import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// T79 (ADR-076): compact 36px controls in the Edit settings card, the quick menu and drawn dropdowns, and the Theme window. Static assertions on the stylesheet:
// the keys and the top bar keep their sizes. (T80, ADR-077, later brought the gear menu, the Edit toolbar and the Library to 36px; see t80.test.mjs.)
const css=readFileSync(new URL('../apps/web/style.css',import.meta.url),'utf8');
// The text of the rule whose selector list is exactly `selector` (at the start of a line, or after another rule's closing brace).
const rule=(selector,from=0)=>{let start=css.indexOf(selector+'{',from);while(start>0&&!/[}\n]/.test(css[start-1]))start=css.indexOf(selector+'{',start+1);assert.ok(start>=0,`${selector} is defined`);return css.slice(start,css.indexOf('}',start)+1);};
const decl=(selector,property)=>{const body=rule(selector);const match=new RegExp(`(?:^|[{;])${property}:([^;}]*)`).exec(body);return match?match[1]:undefined;};

test('--ctl-h is 36px on :root, next to the other theme-independent tokens',()=>{
  const root=css.slice(css.indexOf(':root{\n  color-scheme:dark'));
  assert.match(root.slice(0,root.indexOf('\n}')),/--ctl-h:36px;/);
  assert.equal((css.match(/--ctl-h:/g)||[]).length,1,'defined once');
});

test('the choice buttons share one height and the radius token, not a literal radius',()=>{
  for(const selector of ['.action-choice','.form-choice','.menu-size','.theme-choice','.theme-tab','.pages-row-button','.library-tabs button','.icon-tabs [role=tab]','.order-buttons button']){
    assert.match(rule(selector),/min-height:var\(--ctl-h\)/,`${selector} is --ctl-h tall`);
    assert.match(rule(selector),/border-radius:var\(--radius-ctl\)/,`${selector} uses the control radius token`);
  }
  assert.match(rule('.size-choice,.style-choice'),/min-height:var\(--ctl-h\)/);assert.match(rule('.size-choice,.style-choice'),/border-radius:var\(--radius-ctl\)/);
  assert.doesNotMatch(rule('.size-choice,.style-choice'),/border-radius:\d+px/);assert.doesNotMatch(rule('.action-choice'),/border-radius:\d+px/);
  assert.doesNotMatch(css,/\.(?:size|style|action)-choice\{[^}]*min-height:(?:44|56|58|68)px/,'no leftover tall option buttons');
  assert.doesNotMatch(css,/#editor \.action-choice\{/,'the second, taller rule for the action buttons is gone');
  // trays nest their radius: the outside is the control radius plus the padding
  for(const selector of ['.icon-tabs','.library-tabs'])assert.match(rule(selector),/border-radius:calc\(var\(--radius-ctl\) \+ 2px\)/);
  // one pressed look: accent border and wash, the strong text
  for(const selector of ['.action-choice[aria-pressed=true]','.form-choice[aria-pressed=true]','.menu-size[aria-pressed=true]','.theme-choice[aria-pressed=true]','.theme-tab[aria-pressed=true]'])assert.match(rule(selector),/border-color:var\(--accent\);background:var\(--accent-bg\)/,selector);
});

test('When tapped: three columns on every width, the icon left of the label, a label may wrap but is never cut',()=>{
  assert.match(rule('.action-options'),/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(css,/#editor \.action-options\{/,'no six-column rule is left');assert.doesNotMatch(css,/\.action-options\{[^}]*repeat\(6/);
  const choice=rule('.action-choice');
  assert.match(choice,/flex-direction:row;align-items:center;gap:6px;padding:0 6px/);assert.match(choice,/line-height:1\.15/);assert.doesNotMatch(choice,/text-overflow|overflow:hidden|white-space:nowrap/);
  assert.match(rule('.action-choice .ui-icon'),/width:14px;height:14px/);
  const narrow=css.slice(css.indexOf('@media(max-width:600px){\n  .popup-body'));assert.doesNotMatch(narrow.slice(0,narrow.indexOf('\n}\n')),/action-options/,'the narrow sheet does not change the columns');
});

test('Icon style: three columns, a 20px sample left of the label; sizes stay on one line',()=>{
  assert.match(rule('.style-options'),/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(rule('.style-choice'),/justify-content:flex-start;padding:2px 6px/);
  assert.match(rule('.size-choice,.style-choice'),/flex-direction:row/);
  assert.match(rule('.style-sample'),/width:20px;height:20px/);assert.match(rule('.style-sample'),/flex:none/);
  assert.match(rule('.card-size .size-choice'),/white-space:nowrap/);
});

test('rows, fields and spacing of the card',()=>{
  assert.match(rule('.settings-card .popup-body'),/padding:6px 12px 12px/);assert.match(rule('.card-size'),/padding:8px 12px 0/);assert.match(rule('.card-head'),/padding:4px 6px 4px 8px/,'T92: the grip takes the left edge of the header');assert.match(rule('.card-head h2'),/font-size:15px/);
  assert.match(rule('.group-label'),/margin:12px 0 4px/);assert.match(rule('.sub-label'),/margin:8px 0 4px/);
  assert.match(rule('.section-title'),/margin:16px 0 0;padding-top:12px/);assert.match(rule('.section-title'),/font-size:14px/);
  assert.match(rule('.more-settings'),/margin-top:10px/);assert.match(rule('.more-settings>summary'),/min-height:var\(--ctl-h\)/);
  assert.match(css,/\.settings-card \.field-note,\.theme-dialog \.field-note\{line-height:1\.45;margin-top:6px\}/);
  assert.match(css,/:where\(\.settings-card,\.theme-dialog\) label\{margin:12px 0 4px\}/);
  assert.match(css,/:where\(\.settings-card,\.theme-dialog,\.settings-popover,\.edit-float,\.edit-toolbar,\.shelf-panel\) :is\(button,input,select\)\{min-height:var\(--ctl-h\)\}/,'the base for every control of the card and the theme window (T80 adds the gear menu, toolbar and Library; T83 the floating toolbar)');
  assert.match(css,/:where\(\.settings-card,\.theme-dialog,\.settings-popover,\.edit-float,\.edit-toolbar,\.shelf-panel\) :is\(input,select\)\{padding:7px 10px;font-size:13px\}/);
  assert.match(css,/:is\(\.settings-card,\.theme-dialog\) \.select-button\{min-height:var\(--ctl-h\);padding:7px 10px;font-size:13px\}/);
  assert.match(css,/\.card-head \.icon-close,\.theme-dialog-head \.icon-close\{width:var\(--ctl-h\)/);
  assert.match(rule('.app-field'),/min-height:40px;padding:6px 10px 6px 8px/);assert.match(rule('.app-field .tile-icon'),/width:24px;height:24px/);
  assert.match(rule('.workflow-check,.modifier-grid label'),/min-height:var\(--ctl-h\)/);assert.match(rule('.workflow-check'),/margin:6px 0!important/);
  assert.match(css,/#editor #clear-action,#editor #reload-layout,#editor \.text-button\{min-height:var\(--ctl-h\)/);
  assert.match(rule('#key-color-group .color-swatch'),/flex:0 0 var\(--ctl-h\)/);assert.match(rule('.color-swatch'),/height:var\(--ctl-h\)/);assert.match(rule('.color-swatch:before'),/width:20px;height:20px/);
  assert.match(rule('.pages-row'),/grid-template-columns:minmax\(0,1fr\) var\(--ctl-h\) var\(--ctl-h\) auto/);assert.match(css,/\.pages-row\{grid-template-columns:minmax\(0,1fr\) var\(--ctl-h\) var\(--ctl-h\)\}/);
  assert.match(rule('#pages-settings .form-choice'),/min-width:var\(--ctl-h\)/);
  assert.match(rule('.form-choice'),/min-width:var\(--ctl-h\)/);
});

test('the quick menu and the drawn dropdown rows',()=>{
  assert.match(rule('.menu-item'),/min-height:var\(--ctl-h\);padding:0 10px/);assert.match(rule('.menu-item'),/font-size:13px/);
  assert.match(rule('.menu-size'),/min-width:var\(--ctl-h\);min-height:var\(--ctl-h\)/);
  assert.match(rule('.edit-menu'),/width:224px;display:grid;gap:2px;padding:4px/);
  assert.match(rule('.select-option'),/min-height:var\(--ctl-h\);padding:6px 10px;border-radius:7px;font-size:13px/);
  assert.match(rule('.select-menu'),/padding:4px/);
  assert.match(css,/\.select-layer\[data-sheet=true\] \.select-menu\{[^}]*border-radius:14px 14px 0 0/,'the bottom sheet keeps its layout');
});

test('the theme window',()=>{
  assert.match(rule('.theme-dialog-head'),/padding:8px 8px 8px 18px/);assert.match(rule('.theme-dialog-head h2'),/font-size:16px/);
  assert.match(rule('.theme-list'),/gap:4px;[^}]*padding:10px 10px/);
  assert.match(rule('.theme-row'),/min-height:40px/);assert.match(rule('.theme-swatch'),/width:24px;height:24px;[^}]*border-radius:5px/);
  assert.match(rule('.theme-editor'),/gap:10px;[^}]*padding:12px 18px 14px/);assert.match(rule('.theme-form'),/gap:10px/);
  assert.match(rule('.theme-preview-row'),/padding:12px/);assert.match(rule('.theme-sample'),/min-height:76px/);
  assert.match(rule('.theme-choice'),/flex-direction:row/);assert.match(rule('.theme-radius-sample'),/width:14px;height:14px/);
  assert.match(rule('.theme-swatch-button'),/width:var\(--ctl-h\);min-width:var\(--ctl-h\);height:var\(--ctl-h\)/);
  // The accent is set as background-color: an inline background shorthand would reset background-clip and fill the whole 36px hit box.
  assert.match(readFileSync(new URL('../apps/web/theme-editor.ts',import.meta.url),'utf8'),/setProperty\("background-color", hex\)/);assert.match(rule('.theme-swatch-button'),/background-clip:content-box/);
  assert.match(rule('.theme-color-chip'),/width:var\(--ctl-h\);height:var\(--ctl-h\)/);assert.match(rule('.theme-color-row input[type=color]'),/width:var\(--ctl-h\)/);assert.match(rule('.theme-custom-color input'),/width:var\(--ctl-h\)/);
  assert.match(rule('.layout-numbers input'),/min-height:var\(--ctl-h\)/);
  assert.match(rule('.theme-dialog-foot'),/padding:8px 12px 8px 18px/);
  assert.match(css,/:is\(\.settings-card,\.theme-dialog\) :is\(\.quiet,\.solid\)\{padding:0 12px\}/);assert.match(css,/:is\(\.settings-card,\.theme-dialog\) \.text-button\{min-height:var\(--ctl-h\)\}/);
  const narrow=css.slice(css.indexOf('@media(max-width:600px){\n  .theme-dialog{'));const sheet=narrow.slice(0,narrow.indexOf('\n}\n'));
  assert.match(sheet,/\.theme-row\{width:auto;min-width:148px;flex:none\}/);assert.match(sheet,/\.theme-dialog-foot\{flex-wrap:wrap;padding:8px 12px calc\(8px \+ env\(safe-area-inset-bottom\)\)\}/);
});

test('no new literal colours and no !important beyond the old one; the focus ring stays',()=>{
  const t79=css.slice(css.indexOf('/* ---------- T79 (ADR-076)'));assert.ok(t79.length>400);
  assert.doesNotMatch(t79,/#[0-9a-fA-F]{3,8}\b/);assert.doesNotMatch(t79,/\brgba?\(/);assert.doesNotMatch(t79,/!important/);
  assert.match(t79,/:focus-visible\{outline-offset:2px\}/);assert.doesNotMatch(t79,/outline:\s*none|outline:0/);
  assert.equal((css.match(/\.workflow-check\{[^}]*!important/g)||[]).length,1,'the one old !important stays on .workflow-check');
});

test('what keeps 44px: base buttons, keys, the remove badge, grips, library cards, the theme cards and the other dialogs (T97: page tabs are 32px and the top bar controls fill their slots)',()=>{
  assert.match(css,/\nbutton\{min-height:44px\}/);assert.match(css,/\ninput,select\{color:var\(--text\);width:100%;min-width:0;min-height:44px;padding:11px 12px;font-size:14px\}/);
  assert.match(css,/\nlabel\{display:block;margin:20px 0 8px\}/);
  assert.match(css,/\.edit-remove\{--pitch[^}]*width:44px;height:44px/s);
  assert.match(css,/\.pages-resize-handle\{[^}]*width:44px;height:44px;min-width:44px;min-height:44px/);
  assert.match(css,/\.use-page\{[^}]*min-height:32px/,'T97: page tabs 32px (were 44px)');assert.match(rule('.shelf-card'),/min-height:44px/);
  assert.match(css,/\.mode-button,\.icon-button\{min-height:44px/,'the base is still 44px; the bar overrides it to fill its slot');assert.match(css,/\.connection\{[^}]*min-height:36px/,'T97: the capsule is 36px (was 44px)');
  assert.match(rule('.theme-option'),/min-height:44px/);
  assert.match(rule('.icon-close'),/width:44px;min-width:44px;height:44px/,'the shared close button is still 44px; only the card and theme window heads use --ctl-h');
  assert.match(css,/\.library-dialog \.library-tabs button\{min-height:44px\}/);assert.match(css,/\.first-theme-actions button\{min-height:44px\}/);
  // the scoped compaction never reaches the other dialogs
  assert.doesNotMatch(css.slice(css.indexOf('/* ---------- T79 (ADR-076)')).replace(/\/\*[\s\S]*?\*\//g,''),/app-dialog|library-dialog|first-theme/);
});
