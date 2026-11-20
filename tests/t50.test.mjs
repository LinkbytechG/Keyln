import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DISPLAY_FORMS} from '../dist/packages/contracts/index.js';
import {createRegistry} from '../dist/apps/web/widgets/registry.js';
import {initialDeskState} from '../dist/apps/web/widgets/state.js';
import {registerSystemWidgets,createRuntime} from '../dist/apps/web/widgets/system.js';
import {connectionTone,dotButtonPlan,BUBBLE_DELAY_MS,BUBBLE_STAY_MS} from '../dist/apps/web/widgets/connection.js';
import {formatClock,msToNextMinute} from '../dist/apps/web/widgets/display.js';
import {Element,installDom,serialize} from './helpers/widget-dom.mjs';

// T50: the new forms (connection dot and dot button, mode icon, result line and lamp, compact activity), the standalone result and activity widgets,
// the clock and text widgets, and the Style and Text choices of arrange mode (ADR-057, Docs/verification/T50.md).
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const calls=[];
const intents=()=>{calls.length=0;return {refresh:()=>calls.push(['refresh']),reconnect:()=>calls.push(['reconnect']),setMode:mode=>calls.push(['setMode',mode]),goToPage:id=>calls.push(['goToPage',id]),clearUnknown:()=>calls.push(['clearUnknown']),retry:key=>calls.push(['retry',key])};};
function setup(t){const dom=installDom(t),registry=createRegistry(intents());registerSystemWidgets(registry);return {...dom,registry};}
const state=(patch={})=>({...initialDeskState('braun'),...patch});
const connection=(text,phase,online=false,reconnectDisabled=false)=>({text,phase,online,reconnectDisabled});
const SIX=[['Mac connected','online',true,'ok'],['Connecting…','connecting',false,'busy'],['Disconnected','offline',false,'bad'],['Pairing required','idle',false,'bad'],['Mac layout needs recovery','offline',false,'bad'],['Browser update needed','idle',false,'bad']];

// ---- the registry ------------------------------------------------------------------------------------------------------------------------------------

// ---- S2 connection dot ------------------------------------------------------------------------------------------------------------------------------
test('the dot maps the six status texts to three colours, shows only, and keeps the text for assistive tools',t=>{
  const {registry}=setup(t),widget=registry.create('connection','dot',true),lamp=widget.element.find(node=>(node.className||'').includes('w-lamp'));
  assert.equal(widget.element.getAttribute('role'),'status');
  for(const [text,phase,online,tone] of SIX){
    widget.update(state({connection:connection(text,phase,online)}));
    assert.equal(connectionTone({phase}),tone,text);assert.equal(lamp.dataset.tone,tone,text);assert.equal(widget.element.dataset.tone,tone);
    assert.equal(widget.element.title,text,'the hover shows the full text');assert.equal(widget.element.find(node=>node.className==='sr-only').textContent,text);
    assert.equal(widget.element.find(node=>node.className==='conn-bubble').textContent,text);
  }
  assert.equal(connectionTone({phase:'loading'}),'busy','the first load counts as connecting');
  assert.equal(widget.element.tagName,'div','nothing to press');assert.equal(widget.element.listeners.get('click'),undefined);
  assert.equal(registry.limits('connection','dot').interactive,false);
  widget.element.emit('click');assert.deepEqual(calls,[],'pressing the dot does nothing');
});
test('a long press shows the full status text in a small bubble that opens nothing and goes away by itself',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {registry}=setup(t),widget=registry.create('connection','dot',true),bubble=widget.element.find(node=>node.className==='conn-bubble');
  widget.update(state({connection:connection('Disconnected','offline')}));
  assert.equal(bubble.hidden,true);
  widget.element.emit('pointerdown');t.mock.timers.tick(BUBBLE_DELAY_MS-1);assert.equal(bubble.hidden,true,'not yet');
  t.mock.timers.tick(1);assert.equal(bubble.hidden,false);assert.equal(bubble.textContent,'Disconnected');
  widget.element.emit('pointerup');assert.equal(bubble.hidden,false,'an open bubble stays so it can be read');
  t.mock.timers.tick(BUBBLE_STAY_MS);assert.equal(bubble.hidden,true);
  // Letting go early (a tap) shows nothing.
  widget.element.emit('pointerdown');t.mock.timers.tick(BUBBLE_DELAY_MS-50);widget.element.emit('pointerup');t.mock.timers.tick(1000);assert.equal(bubble.hidden,true);
  let prevented=false;widget.element.emit('contextmenu',{preventDefault(){prevented=true;}});assert.equal(prevented,true,'no context menu on a long press');
  assert.deepEqual(calls,[]);
  widget.destroy();assert.equal(widget.element.listenerCount(),0);
});
test('the dot button reconnects and refreshes when disconnected or failed, and only refreshes otherwise; its name says what it will do',t=>{
  const {registry}=setup(t),widget=registry.create('connection','dot-button',true);
  assert.equal(widget.element.tagName,'button');assert.match(widget.element.className,/icon-button/);
  const expect=[
    ['Mac connected','online',true,false,[['refresh']],'Mac connected. Refresh the page.'],
    ['Connecting…','connecting',false,false,[['refresh']],'Connecting…. Refresh the page.'],
    ['Disconnected','offline',false,false,[['reconnect'],['refresh']],'Disconnected. Reconnect and refresh the page.'],
    ['Pairing required','idle',false,false,[['reconnect'],['refresh']],'Pairing required. Reconnect and refresh the page.'],
    ['Mac layout needs recovery','offline',false,false,[['reconnect'],['refresh']],'Mac layout needs recovery. Reconnect and refresh the page.'],
    ['Browser update needed','idle',false,true,[['refresh']],'Browser update needed. Refresh the page.'],
    ['Disconnected','offline',false,true,[['refresh']],'Disconnected. Refresh the page.'],
  ];
  for(const [text,phase,online,disabled,sequence,label] of expect){
    widget.update(state({connection:connection(text,phase,online,disabled)}));
    assert.equal(widget.element.getAttribute('aria-label'),label,text);assert.equal(widget.element.title,text);
    calls.length=0;widget.element.emit('click');assert.deepEqual(calls,sequence,`${text}${disabled?' (a sync is running)':''}`);
  }
  assert.equal(dotButtonPlan(connection('Disconnected','offline')).reconnect,true);
  widget.update(state({connection:connection('Mac connected','online',true),refresh:{disabled:true,blocked:false}}));assert.equal(widget.element.disabled,true,'a reload in progress');
  widget.update(state({connection:connection('Disconnected','offline'),refresh:{disabled:true,blocked:false}}));assert.equal(widget.element.disabled,false,'T87: a lost Mac can still be reconnected while a reload is held back');calls.length=0;widget.element.emit('click');assert.deepEqual(calls,[['reconnect']],'and then only reconnects');
  const lamp=widget.element.find(node=>(node.className||'').includes('w-lamp'));assert.equal(lamp.dataset.tone,'bad');
  assert.equal(registry.limits('connection','dot-button').interactive,true);assert.ok(registry.limits('connection','dot-button').min.w>=44);
  widget.destroy();assert.equal(widget.element.listenerCount(),0);
});

// ---- S3 mode icon -----------------------------------------------------------------------------------------------------------------------------------
test('the mode icon shows a pencil in Use and a check in Edit, and its pressed state and presses follow the mode',t=>{
  const {registry}=setup(t),widget=registry.create('mode-switch','icon',true),[pencil,check]=widget.element.children;
  assert.equal(widget.element.tagName,'button');assert.equal(pencil.getAttribute('data-ui-icon'),'pencil');assert.equal(check.getAttribute('data-ui-icon'),'check');
  assert.equal(widget.element.getAttribute('aria-pressed'),'false');assert.equal(pencil.hidden,false);assert.equal(check.hidden,true);assert.equal(widget.element.title,'Edit layout');
  widget.update(state({mode:{editing:false,useDisabled:false,editDisabled:false}}));
  widget.element.emit('click');assert.deepEqual(calls,[['setMode','edit']]);
  widget.update(state({mode:{editing:true,useDisabled:false,editDisabled:false}}));
  assert.equal(widget.element.getAttribute('aria-pressed'),'true');assert.equal(pencil.hidden,true);assert.equal(check.hidden,false);assert.equal(widget.element.title,'Back to Use mode');
  calls.length=0;widget.element.emit('click');assert.deepEqual(calls,[['setMode','use']]);
  assert.ok(widget.element.getAttribute('aria-label'),'it has a name');
  widget.update(state({mode:{editing:true,useDisabled:true,editDisabled:false}}));assert.equal(widget.element.disabled,true,'Use is off while editing');
  widget.update(state({mode:{editing:false,useDisabled:true,editDisabled:true}}));assert.equal(widget.element.disabled,true);
  widget.update(state());assert.equal(widget.element.disabled,true,'a snapshot without a mode keeps what it had');
  assert.ok(registry.limits('mode-switch','icon').min.w>=44&&registry.limits('mode-switch','icon').interactive);
  widget.destroy();assert.equal(widget.element.listenerCount(),0);
});

// ---- S6 result: line, lamp, standalone panel --------------------------------------------------------------------------------------------------------
const result=(status,title,line,extra={})=>state({result:{status,title,line,detail:'',unknown:false,...extra}});



// ---- S7 compact activity ----------------------------------------------------------------------------------------------------------------------------


// ---- S9 clock ---------------------------------------------------------------------------------------------------------------------------------------
test('the clock uses 24-hour local time and always shows the Chinese date',()=>{
  const date=new Date(2026,9,22,14,5,30);
  assert.deepEqual(formatClock(date),{time:'14:05',date:'Oct 22  Thu  Week 43'});
});
test('the clock updates on the minute boundary, pauses while the page is hidden, and stops on destroy',t=>{
  const start=new Date(2026,9,22,14,5,50).getTime();
  t.mock.timers.enable({apis:['setTimeout','Date'],now:start});
  const dom=installDom(t),handlers=new Map();
  dom.document.hidden=false;dom.document.addEventListener=(type,fn)=>handlers.set(type,fn);dom.document.removeEventListener=type=>handlers.delete(type);
  const registry=createRegistry(intents());registerSystemWidgets(registry);
  const widget=registry.create('clock','time',true),time=widget.element.find(node=>node.tagName==='time');
  const shown=()=>formatClock(new Date(Date.now())).time;
  assert.equal(time.textContent,shown(),'it shows the time at once');
  assert.equal(msToNextMinute(start),10_000);assert.equal(msToNextMinute(0),60_000);assert.equal(msToNextMinute(59_999),1);
  const before=time.textContent;
  t.mock.timers.tick(9_999);assert.equal(time.textContent,before,'nothing happens before the minute');
  t.mock.timers.tick(1);assert.notEqual(time.textContent,before);assert.equal(time.textContent,shown(),'it changes on the minute');
  assert.equal(widget.element.find(node=>(node.className||'').includes('clock-date')).getAttribute('aria-label'),formatClock(new Date(Date.now())).date);
  // Hidden: no timer runs. Becoming visible again shows the right time at once.
  dom.document.hidden=true;handlers.get('visibilitychange')();
  const hiddenAt=time.textContent;t.mock.timers.tick(5*60_000);assert.equal(time.textContent,hiddenAt,'paused while hidden');
  dom.document.hidden=false;handlers.get('visibilitychange')();assert.equal(time.textContent,shown());
  const again=time.textContent;t.mock.timers.tick(60_000);assert.notEqual(time.textContent,again,'ticking again on the new boundary');
  widget.destroy();const final=time.textContent;t.mock.timers.tick(10*60_000);assert.equal(time.textContent,final);assert.equal(handlers.size,0);
  assert.equal(registry.limits('clock','time').interactive,false);
  const single=registry.create('clock','time',true);assert.ok(single.element.find(node=>(node.className||'').includes('clock-date')),'the clock always shows the date');single.destroy();
});

// ---- S10 text ---------------------------------------------------------------------------------------------------------------------------------------
test('the text widget shows exactly the words it is given, as text and never as markup',t=>{
  const {registry}=setup(t),title=registry.create('text','title',true),note=registry.create('text','note',true);
  assert.equal(title.element.dataset.form,'title');assert.equal(note.element.dataset.form,'note');assert.equal(registry.limits('text','title').interactive,false);
  title.words('Studio <b>desk</b> & "quotes"');
  assert.equal(title.element.textContent,'Studio <b>desk</b> & "quotes"');
  assert.equal(serialize(title.element).includes('<b>'),false,'serialised, the tag is escaped');assert.match(serialize(title.element),/&lt;b&gt;desk&lt;\/b&gt; &amp;/);
  assert.equal(title.element.all(node=>node.tagName==='b').length,0);
  title.words('');assert.equal(title.element.textContent,'');note.words('Back at 3');assert.equal(note.element.textContent,'Back at 3');
  title.update(state());assert.equal(note.element.textContent,'Back at 3','a desk snapshot does not touch the words');
});

