import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {THEME_LAYOUTS} from '../dist/packages/contracts/index.js';
import {createRegistry} from '../dist/apps/web/widgets/registry.js';
import {initialDeskState} from '../dist/apps/web/widgets/state.js';
import {registerSystemWidgets} from '../dist/apps/web/widgets/system.js';
import {connectionPress,dotButtonPlan} from '../dist/apps/web/widgets/connection.js';
import {installDom} from './helpers/widget-dom.mjs';
import {client} from './helpers/client-harness.mjs';

// T87 (ADR-082): the connection capsule is one button that does what the dot button does. The widget tests drive the production widget against the
// small DOM; the page tests run the compiled app. Neither is browser rendering or Surface touch evidence.
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const css=read('apps/web/style.css');
const calls=[];
const intents=()=>{calls.length=0;return {refresh:()=>calls.push('refresh'),reconnect:()=>calls.push('reconnect'),setMode(){},goToPage(){},clearUnknown(){},retry(){}};};
const setup=t=>{const dom=installDom(t),registry=createRegistry(intents());registerSystemWidgets(registry);return {...dom,registry};};
const connection=(text,phase,online=false,reconnectDisabled=false)=>({text,phase,online,reconnectDisabled});
const desk=(conn,refresh={disabled:false,blocked:false})=>({...initialDeskState('braun'),connection:conn,refresh});
const buttonOf=widget=>widget.element.tagName==='button'?widget.element:widget.element.find(node=>node.tagName==='button');

test('T87 the capsule is one button with the lamp, the words and a refresh icon; no separate Reconnect button',t=>{
  const {registry}=setup(t),widget=registry.create('connection','capsule',true),root=widget.element;
  assert.equal(root.className,'connection-tools');
  const buttons=root.all(node=>node.tagName==='button');assert.equal(buttons.length,1,'one button');
  const button=buttons[0];assert.equal(button.id,'connection-button');assert.equal(button.type,'button');assert.match(button.className,/\bconnection\b/,'the lamp and capsule styles stay on it');
  assert.ok(button.find(node=>node.className==='connection-text'),'the words');
  const icon=button.find(node=>node.getAttribute?.('data-ui-icon')==='refresh');assert.ok(icon,'the refresh icon');assert.equal(icon.getAttribute('aria-hidden'),'true');
  assert.equal(root.find(node=>node.id==='reconnect'),undefined);assert.equal(root.find(node=>(node.className||'').includes('reconnect')),undefined);
  const status=root.find(node=>node.id==='connection');assert.ok(status);assert.equal(status.getAttribute('role'),'status');assert.match(status.className,/sr-only/);assert.equal(button.find(node=>node===status),undefined,'the status text is outside the button, so the button name is not re-announced');
});

const MATRIX=[
  // text, phase, online, reconnectDisabled, refreshDisabled, calls, disabled, label
  ['Mac connected','online',true,false,false,['refresh'],false,'Mac connected. Refresh the page.'],
  ['Connecting…','connecting',false,false,false,['refresh'],false,'Connecting…. Refresh the page.'],
  ['Loading…','loading',false,false,false,['refresh'],false,'Loading…. Refresh the page.'],
  ['Disconnected','offline',false,false,false,['reconnect','refresh'],false,'Disconnected. Reconnect and refresh the page.'],
  ['Pairing required','idle',false,false,false,['reconnect','refresh'],false,'Pairing required. Reconnect and refresh the page.'],
  ['Mac layout needs recovery','offline',false,false,false,['reconnect','refresh'],false,'Mac layout needs recovery. Reconnect and refresh the page.'],
  ['Disconnected','offline',false,true,false,['refresh'],false,'Disconnected. Refresh the page.'],
  ['Disconnected','offline',false,false,true,['reconnect'],false,'Disconnected. Reconnect.'],
  ['Disconnected','offline',false,true,true,[],true,'Disconnected. Refresh the page.'],
  ['Mac connected','online',true,false,true,[],true,'Mac connected. Refresh the page.'],
  ['Connecting…','connecting',false,false,true,[],true,'Connecting…. Refresh the page.'],
];
for(const form of ['capsule','dot-button'])test(`T87 ${form}: online and connecting refresh only; lost reconnects first, and still reconnects when refresh is held back; otherwise disabled with refresh`,t=>{
  const {registry}=setup(t),widget=registry.create('connection',form,true),button=buttonOf(widget);
  for(const [text,phase,online,noReconnect,noRefresh,sequence,disabled,label] of MATRIX){
    widget.update(desk(connection(text,phase,online,noReconnect),{disabled:noRefresh,blocked:false}));
    const why=`${text} reconnectDisabled=${noReconnect} refreshDisabled=${noRefresh}`;
    assert.equal(button.disabled,disabled,why);assert.equal(button.getAttribute('aria-label'),label,why);
    calls.length=0;if(!button.disabled)button.emit('click');assert.deepEqual(calls,sequence,why);
  }
});
test('T87 the plan helper is shared: connectionPress builds on dotButtonPlan, and the old labels are unchanged',()=>{
  const lost=connection('Disconnected','offline');
  assert.deepEqual(dotButtonPlan(lost),{reconnect:true,label:'Disconnected. Reconnect and refresh the page.'});
  assert.deepEqual(connectionPress(lost,{disabled:false,blocked:false}),{reconnect:true,refresh:true,disabled:false,label:'Disconnected. Reconnect and refresh the page.'});
  assert.deepEqual(connectionPress(lost,{disabled:true,blocked:true}),{reconnect:true,refresh:false,disabled:false,label:'Disconnected. Reconnect.'});
  const source=read('apps/web/widgets/connection.ts');assert.equal((source.match(/connectionPress\(connection, refresh\)/g)||[]).length,2,'the capsule and the dot button both use it');
  assert.doesNotMatch(source,/id: "reconnect"/);
});
test('T87 the capsule name and title follow the state, and the role=status text and data keep updating',t=>{
  const {registry}=setup(t),widget=registry.create('connection','capsule',true),button=buttonOf(widget),status=widget.element.find(node=>node.id==='connection'),words=widget.element.find(node=>node.className==='connection-text');
  assert.equal(button.getAttribute('aria-label'),'Loading…. Refresh the page.');assert.equal(button.title,button.getAttribute('aria-label'));
  for(const [text,phase,online,noReconnect,noRefresh,,,label] of MATRIX){
    widget.update(desk(connection(text,phase,online,noReconnect),{disabled:noRefresh,blocked:false}));
    assert.equal(button.title,label);assert.equal(status.textContent,text);assert.equal(words.textContent,text);
    assert.equal(status.dataset.phase,phase);assert.equal(status.dataset.online,String(online));assert.equal(button.dataset.phase,phase);assert.equal(button.dataset.online,String(online));
  }
  widget.destroy();assert.equal(button.listenerCount(),0,'listeners are removed on destroy');
});

test('T87 the page: one capsule button, refresh reloads when nothing is at stake, a lost Mac reconnects first, a draft or running action asks first',async t=>{
  const f=await client(t),{el}=f;
  const find=(node,match)=>{for(const child of node.children??[]){if(match(child))return child;const found=find(child,match);if(found)return found;}return undefined;};
  assert.equal(find(el('system-layer'),node=>node.id==='reconnect'),undefined,'no #reconnect in the page');
  const button=el('connection-button');assert.equal(el('connection').textContent,'Mac connected');assert.equal(button.getAttribute('aria-label'),'Mac connected. Refresh the page.');
  button.emit('click');assert.equal(f.reloads,1,'online and clean: refresh reloads at once');
  const g=await client(t);g.sockets[0].close(1006);await g.drain();
  assert.match(g.el('connection').textContent,/Disconnected|Connecting|Reconnecting/);
  g.el('connection-button').emit('click');await g.until(()=>g.sockets.length===2);assert.equal(g.reloads,1,'reconnect first, then refresh');
});
test('T87 the capsule keeps the refresh path: a draft in Edit is asked about, never discarded silently',async t=>{
  const f=await client(t),{el}=f;
  el('edit-layout').emit('click');await f.drain();el('grid-size').value='large';el('grid-size').emit('change');await f.drain();
  el('connection-button').emit('click');await f.drain();
  assert.equal(el('refresh-dialog').open,true,'the confirmation opens');assert.equal(f.reloads,undefined,'nothing reloads yet');assert.equal(f.count('configuration/save'),0);
});

test('T87 style: 36px tall (T97; it was 44px), pointer cursor, hover only where hovering exists, pressed and focus states, theme tokens, no Reconnect rules',()=>{
  const rule=selector=>{const start=css.indexOf(selector+'{');assert.ok(start>=0,selector);return css.slice(start,css.indexOf('}',start)+1);};
  assert.match(rule('.connection'),/min-height:36px/);assert.match(rule('.connection'),/border-radius:999px/);
  const forms=Object.entries(THEME_LAYOUTS).flatMap(([name,layout])=>['wide','narrow'].map(set=>[name,set,layout[set].slots.connection]));
  const capsules=forms.filter(([,,slot])=>slot.form==='capsule');assert.deepEqual(capsules.map(([name,set])=>`${name}/${set}`).sort(),['braun/wide','classic/wide','metro/wide','midnight/wide','standard/wide'],'the five wide layouts use the capsule; narrow and the Widget theme use the dot button');
  for(const [name,set,slot] of capsules)assert.deepEqual([slot.w,slot.h],[200,36],`${name}/${set}: T97: the slot is 200 x 36 and the button fills it (no overhang)`);
  assert.match(rule('.connection-button'),/cursor:pointer/);assert.match(rule('.connection-button .ui-icon'),/width:14px;height:14px/);assert.match(rule('.connection-button .ui-icon'),/color:var\(--muted\)/);
  assert.ok(css.includes('@media(hover:hover){.connection-button:hover:enabled{background:var(--surface-2)}}'));assert.equal(css.split('.connection-button:hover').length,2,'hover in one place only');
  assert.match(rule('.connection-button:active:enabled'),/var\(--surface-2\)/);assert.match(rule('.connection-button:focus-visible'),/outline:2px solid var\(--focus\)/);assert.match(rule('.connection-button:disabled'),/cursor:default/);
  const block=css.slice(css.indexOf('/* T87'),css.indexOf('.mode-button,.icon-button'));assert.doesNotMatch(block,/#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(css,/\.reconnect\b/,'nothing is left of the Reconnect button');assert.doesNotMatch(css,/\.connection-tools:has\(/);
  assert.match(css,/\.shell\[data-paired=true\] \.connection-button\{gap:0;width:44px;padding:0;justify-content:center\}/,'narrow: the lamp alone, centred, nothing clipped');
  assert.match(css,/\.shell\[data-paired=true\] \.connection-button :is\(\.connection-text,\.ui-icon\)\{display:none\}/);
  assert.doesNotMatch(css,/text-indent:-100vw/);
  assert.match(css,/\.connection\[data-phase=online\]::before\{/);
  assert.ok(!/id="reconnect"/.test(read('apps/web/index.html')));
});
test('T87 previews of the capsule are not buttons: the theme sketch draws spans, and the Library preview context cannot refresh or reconnect',()=>{
  const sketch=read('apps/web/theme-sketch.ts');
  assert.match(sketch,/document\.createElement\(interactive \? "button" : "span"\)/);assert.doesNotMatch(sketch,/widgets\/connection/);
  assert.match(read('apps/web/library.ts'),/intents: \{ refresh\(\) \{\}, reconnect\(\) \{\}, setMode\(\) \{\} \}/);
});