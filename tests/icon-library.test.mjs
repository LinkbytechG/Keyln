import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync,existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:https';
import {curatedIconSet,Fault,ICON_PREFIX_LIMIT,ICON_SETS,ICON_UNKNOWN_LICENSE,iconId,iconLabel,iconName,iconPrefix,iconQuery,iconScope,iconSet,iconSvg,MAX_SVG_BYTES,svgDataUrl} from '../dist/packages/contracts/index.js';
import {assembleIcons,IconifyClient,IconLibrary,IconSearch,ICONIFY_LIMITS,ICONIFY_ORIGIN,ICON_CACHE_MS,ICON_CACHE_QUERIES,ICON_CACHE_SETS,ICON_REQUEST_LIMIT,ICON_RESULT_LIMIT,MAX_LIBRARY_BYTES,MAX_LIBRARY_ICONS,setInfo} from '../dist/apps/host/icon-library.js';
import {atomicJSON,ConfigStore} from '../dist/apps/host/store.js';
import {Auth} from '../dist/apps/host/auth.js';
import {Scheduler} from '../dist/apps/host/scheduler.js';
import {createHost} from '../dist/apps/host/server.js';

// Nothing here reaches the network: Iconify is always a fake fetch or a fake source.
const fault=(code,status)=>error=>error.code===code&&(status===undefined||error.status===status);
const unavailable=fault('ICON_SEARCH_UNAVAILABLE',503);
const json=(value,init={})=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json; charset=utf-8'},...init});
const svg=(body='<path fill="currentColor" d="M1 1h2"/>',box='0 0 24 24')=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}">${body}</svg>`;
const data=(prefix,names,extra={})=>({prefix,width:24,height:24,icons:Object.fromEntries(names.map(name=>[name,{body:`<path fill="currentColor" d="M1 1h${name.length}"/>`}])),...extra});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const gate=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function iconify({found=[],sets={},search}={}){
  const calls=[];
  const fetcher=async(url,init)=>{
    calls.push({url:String(url),init});
    const parsed=new URL(url);
    if(parsed.pathname==='/search')return search?await search(parsed):json({icons:found,total:found.length,limit:48,start:0});
    const prefix=parsed.pathname.slice(1).replace(/\.json$/,'');
    return json(sets[prefix]??data(prefix,(parsed.searchParams.get('icons')||'').split(',')));
  };
  return{fetcher,calls};
}
const hang=(url,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason)));
const ids=count=>ICON_SETS.flatMap(set=>Array.from({length:count},(_,i)=>`${set.prefix}:icon-${i}`));

test('curated sets, search words, icon names and icon IDs are validated before anything is sent',()=>{
  assert.deepEqual(ICON_SETS.map(set=>[set.prefix,set.license]),[['material-symbols','Apache-2.0'],['lucide','ISC'],['tabler','MIT'],['ph','MIT'],['fluent','MIT'],['simple-icons','CC0-1.0']]);
  assert.deepEqual(ICON_SETS.filter(set=>set.brand).map(set=>set.prefix),['simple-icons']);
  for(const prefix of ICON_SETS.map(set=>set.prefix))assert.equal(iconSet(prefix),prefix);
  for(const bad of ['mdi','Lucide','lucide ','lucide,tabler','','*',null,undefined,5,{},'../lucide','lucide/..'])assert.throws(()=>iconSet(bad),fault('INVALID_INPUT'));
  for(const good of ['home','home-2','a1','10k','arrow-circle-down-24-regular','x'])assert.equal(iconName(good),good);
  for(const bad of ['','Home','-home','home-','home--x','home_x','home.x','home x','home/x','ho:me','a'.repeat(81),'é',null,3,'home%2F'])assert.throws(()=>iconName(bad),fault('INVALID_INPUT'),String(bad));
  assert.deepEqual(iconId('lucide:house'),{id:'lucide:house',set:'lucide',name:'house'});
  // T32: iconId accepts any well-formed Iconify prefix (the curated list only filters searches); the shape is still strict.
  assert.deepEqual(iconId('logos:codex'),{id:'logos:codex',set:'logos',name:'codex'});assert.deepEqual(iconId('fa7-brands:openai'),{id:'fa7-brands:openai',set:'fa7-brands',name:'openai'});
  for(const bad of ['lucide','lucide:','lucide:house:x',':house','Mdi:home','mdi_x:home','-mdi:home','mdi-:home','mdi--x:home','a'.repeat(65)+':home','lucide:Home','lucide:ho me','lucide:../x','../x:home','lu cide:home',5,null,{}])assert.throws(()=>iconId(bad),fault('INVALID_INPUT'),String(bad));
  for(const good of ['mdi','fa7-brands','ph','a1','a'.repeat(64)])assert.equal(iconPrefix(good),good);
  for(const bad of ['','Mdi','mdi ','mdi,ph','-a','a-','a--b','a_b','a.b','a/b','a'.repeat(65),'é',null,5,{}])assert.throws(()=>iconPrefix(bad),fault('INVALID_INPUT'),String(bad));
  assert.equal(iconScope('curated'),'curated');assert.equal(iconScope('all'),'all');
  for(const bad of ['','All','everything',undefined,null,5,{}])assert.throws(()=>iconScope(bad),fault('INVALID_INPUT'),String(bad));
  assert.equal(curatedIconSet('lucide').name,'Lucide');assert.equal(curatedIconSet('mdi'),undefined);assert.equal(curatedIconSet('__proto__'),undefined);
  // Labels shown to people (set names, licences): one short printable line.
  for(const good of ['MIT','Apache-2.0','CC BY 4.0','Fluent UI System Icons','x'.repeat(80),'  padded  ','FontAwesome Pro 中'])assert.equal(iconLabel(good),good.trim(),good);
  for(const bad of ['','   ','x'.repeat(81),'a\nb','a\tb','a\u0000b','a\u007fb','a b','a b','a​b','‮gnp','a\u0085b',null,5,{}])assert.equal(iconLabel(bad),undefined,JSON.stringify(bad));
  assert.equal(ICON_UNKNOWN_LICENSE,'Unknown license');assert.equal(ICON_PREFIX_LIMIT,12);
  assert.equal(iconQuery('  home   page  '),'home page');assert.equal(iconQuery('ab'),'ab');assert.equal(iconQuery('x'.repeat(64)),'x'.repeat(64));assert.equal(iconQuery('c++'),'c++');
  // T32: only English reaches the Mac and Iconify, so anything outside printable ASCII is refused here (the page converts Chinese first).
  for(const bad of ['','a',' a ','x'.repeat(65),'ho\u0000me','ho\nme','ho\tme\u0007','ho\u007fme','a b',null,5,{}, ' \t\n ','é中','主页','café','home 页','ｈｏｍｅ'])assert.throws(()=>iconQuery(bad),fault('INVALID_INPUT'),JSON.stringify(bad));
});

test('the SVG validator keeps plain drawing markup and refuses everything else',()=>{
  const ok=[
    svg(),
    svg('<g fill="none" stroke="currentColor" stroke-width="2"><path d="M1 1h2"/><circle cx="1" cy="1" r="1"/><ellipse cx="2" cy="2" rx="1" ry="2"/><line x1="0" y1="0" x2="1" y2="1"/><polyline points="0,0 1,1"/><polygon points="0,0 1,1 2,0"/><rect x="1" y="1" width="2" height="2" rx="1"/></g>'),
    svg('<title>Home</title><desc>A house &amp; garden &#169; &#xA9;</desc><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#fff"/></linearGradient><radialGradient id="r"><stop offset="1"/></radialGradient><clipPath id="c"><rect width="4" height="4"/></clipPath><mask id="m"><circle r="2"/></mask><symbol id="s"><path d="M0 0"/></symbol></defs><use href="#s"/><use xlink:href="#s"/><path d="M0 0" fill="url(#g)" clip-path="url(#c)" mask="url(#m)" style="fill:url( &quot;#r&quot; )"/>'),
    '﻿  '+svg(),`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'><path d='M0 0'/></svg>`,'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><use xlink:href="#a"/></svg>\n`,
  ];
  for(const value of ok)assert.equal(iconSvg(value),value);
  const bad={
    script:svg('<script>alert(1)</script>'),style:svg('<style>*{fill:red}</style>'),foreignObject:svg('<foreignObject><div/></foreignObject>'),image:svg('<image href="#a"/>'),a:svg('<a href="#a"><path d="M0 0"/></a>'),
    animate:svg('<animate attributeName="x"/>'),animateTransform:svg('<animateTransform/>'),set:svg('<set attributeName="href" to="javascript:1"/>'),filter:svg('<filter id="f"/>'),text:svg('<text>hi</text>'),
    uppercase:svg('<Path d="M0 0"/>'),namespaced:svg('<svg:path d="M0 0"/>'),
    onload:'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path d="M0 0"/></svg>',onclick:svg('<path d="M0 0" onclick="1"/>'),ONMOUSEOVER:svg('<path d="M0 0" ONMOUSEOVER="1"/>'),
    hrefExternal:svg('<use href="https://example.com/a.svg#x"/>'),hrefRelative:svg('<use href="a.svg#x"/>'),xlinkData:svg('<use xlink:href="data:image/svg+xml;base64,AAAA"/>'),hrefJs:svg('<use href="javascript:alert(1)"/>'),
    otherNamespaceHref:svg('<use xmlns:q="http://www.w3.org/1999/xlink" q:href="http://example.com/x"/>'),hrefEntity:svg('<use href="&#106;avascript:1"/>'),
    urlHttp:svg('<path d="M0 0" fill="url(http://example.com/x)"/>'),urlSpace:svg('<path d="M0 0" fill="url( http://example.com/x)"/>'),urlQuoted:svg('<path d="M0 0" style="fill:url(\'https://example.com/x\')"/>'),
    urlEntity:svg('<path d="M0 0" style="fill:&#117;rl(http://example.com/x)"/>'),urlHexEntity:svg('<path d="M0 0" style="fill:&#x75;rl(http://example.com/x)"/>'),urlEscape:svg('<path d="M0 0" style="fill:\\75rl(http://example.com/x)"/>'),urlEmpty:svg('<path d="M0 0" fill="url("/>'),
    javascript:svg('<path d="M0 0" data-x="javascript:alert(1)"/>'),
    doctype:'<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">'+svg(),
    entity:'<!DOCTYPE svg [<!ENTITY x "y">]>'+svg(),entityOnly:svg('<desc>&xxe;</desc>'),entityAttr:svg('<path d="M0 0" id="&custom;"/>'),
    stylesheet:'<?xml-stylesheet href="a.css"?>'+svg(),xmlProlog:'<?xml version="1.0"?>'+svg(),cdata:svg('<desc><![CDATA[x]]></desc>'),comment:svg('<!-- hi --><path d="M0 0"/>'),
    notSvg:'<html><body>hi</body></html>',plain:'plain text',empty:'',whitespace:'  ',rootNotFirst:'<g/>'+svg(),textBefore:'x'+svg(),textAfter:svg()+'x',twoRoots:svg()+svg(),
    unclosed:'<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0">',mismatched:'<svg xmlns="http://www.w3.org/2000/svg"><g></path></svg>',strayClose:svg()+'</svg>',closeWithAttribute:'<svg xmlns="http://www.w3.org/2000/svg"></svg x="1">',
    textInside:svg('hello<path d="M0 0"/>'),unquoted:'<svg xmlns="http://www.w3.org/2000/svg"><path d=M0/></svg>',dupAttribute:svg('<path d="M0" d="M1"/>'),noValue:svg('<path d/>'),angleInValue:svg('<path d="a<b"/>'),
    broken:'<svg xmlns="http://www.w3.org/2000/svg"><path',control:svg('<path d="M0\u0001 0"/>'),nul:svg('<path d="M0\u0000"/>'),
    tooLarge:svg(`<path d="${'M0 0h1'.repeat(3000)}"/>`),tooDeep:svg('<g>'.repeat(30)+'</g>'.repeat(30)),tooMany:svg('<g/>'.repeat(501)),tooManyUse:svg('<use href="#a"/>'.repeat(17)),
    notString:5,nullValue:null,
  };
  assert.ok(Buffer.byteLength(bad.tooLarge)>MAX_SVG_BYTES);
  for(const [name,value] of Object.entries(bad))assert.throws(()=>iconSvg(value),fault('INVALID_INPUT'),name);
  assert.ok(iconSvg(svg('<path d="M0 0"/>'.repeat(300))).length>4800,'a few hundred plain elements are fine');
  assert.ok(svgDataUrl(svg()).startsWith('data:image/svg+xml;base64,'));assert.equal(Buffer.from(svgDataUrl('<svg>é</svg>').split(',')[1],'base64').toString(),'<svg>é</svg>');
});

test('assembled icons carry the right box, resolve aliases and drop anything unusual without failing the rest',()=>{
  const lucide={prefix:'lucide',width:24,height:24,icons:{house:{body:'<path d="M1 1"/>'},bad:{body:'<script>alert(1)</script>'},num:{body:5},wide:{body:'<path d="M2 2"/>',width:48},spin:{body:'<path/>',rotate:1},shift:{body:'<path d="M3 3"/>',left:-2,top:1}},
    aliases:{home:{parent:'house'},flip:{parent:'house',hFlip:true},chain:{parent:'home'},loop:{parent:'loop'},orphan:{parent:'nothing'},sized:{parent:'house',width:12,height:12}}};
  const result=assembleIcons(lucide,'lucide',['house','home','flip','chain','loop','orphan','sized','bad','num','wide','spin','shift','absent','__proto__','constructor']);
  assert.deepEqual(result.map(item=>item.id),['lucide:house','lucide:home','lucide:chain','lucide:sized','lucide:wide','lucide:shift']);
  const byName=Object.fromEntries(result.map(item=>[item.name,item.svg]));
  assert.equal(byName.house,svg('<path d="M1 1"/>').replace('viewBox="0 0 24 24"','viewBox="0 0 24 24" width="24" height="24"'));
  assert.equal(byName.home,byName.house,'an alias draws its parent');assert.equal(byName.chain,byName.house);
  assert.match(byName.sized,/viewBox="0 0 12 12" width="12" height="12"><path d="M1 1"\/>/);assert.match(byName.wide,/viewBox="0 0 48 24"/);assert.match(byName.shift,/viewBox="-2 1 24 24"/);
  const fluent={prefix:'fluent',width:20,height:20,icons:{'home-12-filled':{body:'<path d="M0 0"/>',width:12,height:12},'home-20-filled':{body:'<path d="M0 0"/>'}}};
  assert.deepEqual(assembleIcons(fluent,'fluent',['home-12-filled','home-20-filled']).map(item=>/viewBox="([^"]+)"/.exec(item.svg)[1]),['0 0 12 12','0 0 20 20']);
  assert.deepEqual(assembleIcons({prefix:'ph',icons:{a:{body:'<path/>'}}},'ph',['a']).map(item=>/viewBox="([^"]+)"/.exec(item.svg)[1]),['0 0 16 16'],'Iconify default size is 16');
  assert.throws(()=>assembleIcons({prefix:'tabler',icons:{}},'lucide',['a']));
  assert.throws(()=>assembleIcons('text','lucide',['a']));
  assert.deepEqual(assembleIcons({prefix:'lucide',width:-1,icons:{a:{body:'<path/>'}}},'lucide',['a']),[]);
  assert.deepEqual(assembleIcons({prefix:'lucide',width:1e9,icons:{a:{body:'<path/>'}}},'lucide',['a']),[]);
});

test('a curated online search sends only a fixed-host GET with no redirects, cookies or identifying headers, in at most seven requests',async()=>{
  const found=ids(8),fake=iconify({found}),client=new IconifyClient(fake.fetcher);
  const results=(await client.search('  home   page ')).results;
  assert.equal(results.length,48);assert.deepEqual(results.map(item=>item.id),found,'relevance order from the search is kept');
  assert.ok(fake.calls.length<=7,`requests: ${fake.calls.length}`);assert.equal(fake.calls.length,7,'one search plus one batch per set');
  for(const {url,init} of fake.calls){
    assert.equal(new URL(url).origin,'https://api.iconify.design');assert.ok(url.startsWith(`${ICONIFY_ORIGIN}/`));
    assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.method,'GET');assert.equal(init.body,undefined);
    assert.deepEqual(init.headers,{'User-Agent':'Keyln'});assert.ok(init.signal instanceof AbortSignal);
    assert.match(new URL(url).pathname,/^\/(?:search|(?:material-symbols|lucide|tabler|ph|fluent|simple-icons)\.json)$/);
  }
  assert.equal(fake.calls[0].url,`${ICONIFY_ORIGIN}/search?query=home%20page&prefixes=material-symbols,lucide,tabler,ph,fluent,simple-icons&limit=48`);
  assert.deepEqual(fake.calls.slice(1).map(call=>call.url.split('?')[0].slice(ICONIFY_ORIGIN.length)).sort(),ICON_SETS.map(set=>`/${set.prefix}.json`).sort());
  assert.ok(fake.calls.every(call=>!/keyln|device|cookie|token|layout/i.test(call.url)),'no device or configuration data in URLs');
  // One set: a single prefixes value, and results from other sets are ignored even if the server sent them.
  const one=iconify({found:['lucide:a','tabler:b','lucide:c']}),single=(await new IconifyClient(one.fetcher).search('wifi','curated','lucide')).results;
  assert.deepEqual(single.map(item=>item.id),['lucide:a','lucide:c']);assert.equal(one.calls.length,2);assert.match(one.calls[0].url,/prefixes=lucide&limit=48$/);
  assert.equal(one.calls[1].url,`${ICONIFY_ORIGIN}/lucide.json?icons=a,c`);
  // Invalid input never reaches fetch.
  const never=iconify();const guarded=new IconifyClient(never.fetcher);
  for(const [query,scope,set] of [['a'],['x'.repeat(65)],['o\u0001k'],['主页'],['home','curated','mdi'],['home','curated','lucide,tabler'],['home','curated','*'],['home','mdi'],['home','everything'],['home','all','lucide'],['home',undefined,'mdi']])await assert.rejects(guarded.search(query,scope,set),fault('INVALID_INPUT'),JSON.stringify([query,scope,set]));
  await assert.rejects(guarded.icon('lucide:../x'),fault('INVALID_INPUT'));await assert.rejects(guarded.icon('Mdi:home'),fault('INVALID_INPUT'));await assert.rejects(guarded.icon('mdi:Home'),fault('INVALID_INPUT'));
  assert.equal(never.calls.length,0);
  // Odd search answers: bad IDs, other sets, duplicates and more than 48 entries are filtered, never fetched.
  const messy=iconify({found:['evil:x','lucide:Bad','lucide:ok','lucide:ok',5,null,'lucide:ok:x',...Array.from({length:80},(_,i)=>`ph:n-${i}`)]});
  const filtered=(await new IconifyClient(messy.fetcher).search('xx')).results;assert.equal(filtered.length,48);assert.equal(filtered[0].id,'lucide:ok');
  assert.ok(messy.calls.length<=3&&messy.calls.every(call=>!call.url.includes('evil')&&!call.url.includes('Bad')));
  // A long list of long names still stays inside the request budget (the tail is dropped, not re-requested).
  const longNames=Array.from({length:48},(_,i)=>`fluent:${'x'.repeat(60)}-${i}`),long=iconify({found:longNames});
  await new IconifyClient(long.fetcher).search('xx');assert.equal(long.calls.length,2);assert.ok(long.calls[1].url.length<1850);
});

test('a single icon is fetched from its own set and a missing or unsafe one is refused',async()=>{
  const fake=iconify({sets:{lucide:data('lucide',['house']),tabler:{prefix:'tabler',icons:{evil:{body:'<script/>'}}}}}),client=new IconifyClient(fake.fetcher);
  assert.match(await client.icon('lucide:house'),/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor"/);
  assert.equal(fake.calls[0].url,`${ICONIFY_ORIGIN}/lucide.json?icons=house`);
  await assert.rejects(client.icon('lucide:absent'),fault('ICON_NOT_FOUND',404));await assert.rejects(client.icon('tabler:evil'),fault('ICON_NOT_FOUND',404));
  await assert.rejects(new IconifyClient(async()=>new Response('x',{status:500})).icon('lucide:house'),unavailable);
});

test('timeouts, bad status, wrong type, oversized or malformed answers all become one 503 that explains the Mac needs internet',async()=>{
  const limits={requestMs:40,totalMs:400,searchBytes:1024,dataBytes:2048};
  const attempt=(fetcher,search=['xx'],custom=limits)=>new IconifyClient(fetcher,custom).search(...search);
  const check=async(name,fetcher,custom)=>{
    const error=await attempt(fetcher,['xx'],custom).then(()=>assert.fail(`${name} should fail`),error=>error);
    assert.ok(unavailable(error),`${name}: ${error.code} ${error.status}`);assert.match(error.message,/Mac to reach the internet/);assert.match(error.message,/My icons still works offline/);
  };
  await check('search 500',async()=>new Response('x',{status:500}));
  await check('search 404',async()=>new Response('{}',{status:404,headers:{'content-type':'application/json'}}));
  await check('search 429',async()=>new Response('{}',{status:429,headers:{'content-type':'application/json'}}));
  await check('redirect',async()=>new Response(null,{status:302,headers:{location:'https://evil.example/'}}));
  await check('redirect rejected by fetch',async()=>{throw new TypeError('fetch failed')});
  await check('html',async()=>new Response('<html/>',{status:200,headers:{'content-type':'text/html'}}));
  await check('invalid JSON',async()=>new Response('{',{status:200,headers:{'content-type':'application/json'}}));
  await check('invalid UTF-8',async()=>new Response(new Uint8Array([0x7b,0xff,0x7d]),{status:200,headers:{'content-type':'application/json'}}));
  await check('icons not an array',async()=>json({icons:{}}));
  await check('search body over the limit, streamed',async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(600).fill(32));c.enqueue(new Uint8Array(600).fill(32));c.close();}}),{status:200,headers:{'content-type':'application/json'}}));
  await check('search body over the limit, declared',async()=>new Response('{}',{status:200,headers:{'content-type':'application/json','content-length':'5000'}}));
  await check('search timeout',hang);
  await check('data 500',async(url,init)=>new URL(url).pathname==='/search'?json({icons:['lucide:a']}):new Response('x',{status:500}));
  await check('data over the limit',async url=>new URL(url).pathname==='/search'?json({icons:['lucide:a']}):new Response(new Uint8Array(4000).fill(32),{status:200,headers:{'content-type':'application/json'}}));
  await check('data wrong set',async url=>new URL(url).pathname==='/search'?json({icons:['lucide:a']}):json(data('tabler',['a'])));
  await check('data not an object',async url=>new URL(url).pathname==='/search'?json({icons:['lucide:a']}):json([1]));
  await check('data timeout',async(url,init)=>new URL(url).pathname==='/search'?json({icons:['lucide:a']}):hang(url,init));
  // The five-second request limit and nine-second search limit are what the Host really uses, inside the 10 second server timeout.
  assert.deepEqual({...ICONIFY_LIMITS},{requestMs:5000,totalMs:9000,searchBytes:262144,dataBytes:262144});assert.ok(ICONIFY_LIMITS.totalMs<10_000);
});

test('the request limit and the whole-search limit are enforced with real timers, and a failure cancels the other requests',async()=>{
  let started=Date.now();
  const slow=new IconifyClient(hang,{requestMs:60,totalMs:2000,searchBytes:1024,dataBytes:1024});
  await assert.rejects(slow.search('xx'),unavailable);let elapsed=Date.now()-started;assert.ok(elapsed>=50&&elapsed<1500,`per-request limit: ${elapsed} ms`);
  // The search answers in time, but the batches hang: the 120 ms whole-search limit ends it long before the 1.5 s request limit.
  started=Date.now();const signals=[];
  const whole=new IconifyClient(async(url,init)=>{
    if(new URL(url).pathname==='/search')return json({icons:['lucide:a','tabler:b','ph:c']});
    signals.push(init.signal);return hang(url,init);
  },{requestMs:1500,totalMs:120,searchBytes:1024,dataBytes:1024});
  await assert.rejects(whole.search('xx'),unavailable);elapsed=Date.now()-started;assert.ok(elapsed>=100&&elapsed<1000,`whole-search limit: ${elapsed} ms`);assert.equal(signals.length,3);
  // One failing batch aborts its siblings instead of leaving them running.
  const siblings=[];
  const failing=new IconifyClient(async(url,init)=>{
    if(new URL(url).pathname==='/search')return json({icons:['lucide:a','tabler:b','ph:c']});
    if(url.includes('/lucide.json'))return new Response('x',{status:500});
    siblings.push(init.signal);return hang(url,init);
  },{requestMs:2000,totalMs:3000,searchBytes:1024,dataBytes:1024});
  started=Date.now();await assert.rejects(failing.search('xx'),unavailable);assert.ok(Date.now()-started<1000);await turn();
  assert.equal(siblings.length,2);assert.ok(siblings.every(signal=>signal.aborted),'siblings cancelled');
});

function source(overrides={}){
  const calls={search:[],icon:[]};
  // A fake source may answer with a plain array (not truncated) or with a full { results, truncated }.
  return{calls,search:async(query,scope,set)=>{calls.search.push([query,scope,set]);const answer=overrides.search?await overrides.search(query,scope,set):[{id:'lucide:house',set:'lucide',name:'house',svg:svg()}];return Array.isArray(answer)?{results:answer,truncated:false}:answer;},
    icon:async id=>{calls.icon.push(id);return overrides.icon?overrides.icon(id):svg();}};
}
test('the search layer caches for ten minutes, keeps cache bounded and answers repeats without the network',async()=>{
  let clock=1000;const src=source(),search=new IconSearch(src,()=>clock);
  const first=await search.search(' House ');assert.equal(first.results.length,1);assert.equal(first.truncated,false);
  assert.deepEqual(await search.search('house'),first,'case and spacing do not change the key');assert.equal(src.calls.search.length,1);
  await search.search('house','curated','lucide');assert.equal(src.calls.search.length,2,'a different set is a different query');await search.search('house','all');assert.equal(src.calls.search.length,3,'a different scope is a different query');
  clock+=ICON_CACHE_MS-1;await search.search('house');assert.equal(src.calls.search.length,3);
  clock+=1;await search.search('house');assert.equal(src.calls.search.length,4,'expired after ten minutes');assert.equal(ICON_CACHE_MS,600_000);
  // A search fills the icon cache, so saving a result needs no second download.
  assert.equal((await search.icon('lucide:house')).svg,svg());assert.equal(src.calls.icon.length,0);
  assert.equal((await search.icon('lucide:other')).svg,svg());assert.equal((await search.icon('lucide:other')).svg,svg());assert.equal(src.calls.icon.length,1);
  // At most 256 remembered queries.
  const many=new IconSearch(source({search:query=>[{id:`lucide:${query.replace(/\W/g,'')}`,set:'lucide',name:query,svg:svg()}]}),()=>clock);
  for(let i=0;i<ICON_CACHE_QUERIES+20;i++)await many.search('w'+('a'.repeat(i%20))+i.toString(36).padStart(3,'a'));
  assert.ok(many.queries.size<=ICON_CACHE_QUERIES);
});

test('at most two online searches run at once, identical ones share a request, and a failure frees its slot',async()=>{
  const gates={aa:gate(),bb:gate()},src=source({search:query=>gates[query]?.promise??[{id:'lucide:x',set:'lucide',name:'x',svg:svg()}]});
  const search=new IconSearch(src);
  const a=search.search('aa'),b=search.search('bb'),again=search.search('aa');await turn();
  assert.equal(src.calls.search.length,2,'the repeated query shares the first request');
  await assert.rejects(search.search('cc'),fault('BUSY',409));await assert.rejects(search.icon('lucide:missing'),fault('BUSY',409));
  assert.equal(src.calls.search.length,2);
  gates.aa.resolve([{id:'lucide:one',set:'lucide',name:'one',svg:svg()}]);assert.deepEqual((await a).results.map(item=>item.id),['lucide:one']);assert.deepEqual(await again,await a);
  assert.equal((await search.search('cc')).results.length,1,'a slot was released');
  gates.bb.reject(new Fault('ICON_SEARCH_UNAVAILABLE','offline',503));await assert.rejects(b,unavailable);
  assert.equal((await search.search('dd')).results.length,1);assert.equal((await search.search('ee')).results.length,1);
  const failing=new IconSearch(source({search:()=>{throw new Fault('ICON_SEARCH_UNAVAILABLE','offline',503);}}));
  for(let i=0;i<5;i++)await assert.rejects(failing.search('zz'+i),unavailable);
});

test('whatever a source returns is checked again: bad IDs, wrong sets, duplicates, unsafe SVG and more than 48 icons are dropped',async()=>{
  const good=name=>({id:`lucide:${name}`,set:'lucide',name,svg:svg()});
  const search=new IconSearch(source({search:()=>[{id:'evil:x',set:'evil',name:'x',svg:svg()},{id:'Evil:x'},{id:5},null,good('ok'),good('ok'),{...good('bad'),svg:svg('<script>1</script>')},{id:'tabler:other',set:'tabler',name:'other',svg:svg()},
    ...Array.from({length:80},(_,i)=>good(`n-${i}`))]}));
  const results=(await search.search('xx','curated','lucide')).results;assert.equal(results.length,48);assert.equal(results[0].id,'lucide:ok');assert.ok(results.every(item=>item.set==='lucide'&&!item.svg.includes('script')));
  await assert.rejects(new IconSearch(source({icon:()=>svg('<script/>')})).icon('lucide:x'),fault('INVALID_INPUT'));
  await assert.rejects(search.search('xx','curated','nope'),fault('INVALID_INPUT'));await assert.rejects(search.search('xx','nope'),fault('INVALID_INPUT'));await assert.rejects(search.search('x'.repeat(65)),fault('INVALID_INPUT'));
});

function directory(t){
  const dir=mkdtempSync(join(tmpdir(),'keyln-icons-'));t.after(()=>{try{chmodSync(dir,0o700);}catch{}rmSync(dir,{recursive:true,force:true});});return dir;
}
const entry=(name,body=svg(),set='lucide',at=1)=>({id:`${set}:${name}`,set,name,svg:body,addedAt:at});
const writeLibrary=(dir,icons,revision=1)=>atomicJSON(join(dir,'icon-library.json'),{schemaVersion:1,revision,icons});
const bigSvg=index=>svg(`<path d="${'M0 0h1'.repeat(2600)}${index}"/>`);

test('My icons persists privately, adds idempotently and removes safely',t=>{
  const dir=directory(t),library=new IconLibrary(dir,()=>1234);
  assert.deepEqual(JSON.parse(readFileSync(library.path,'utf8')),{schemaVersion:2,revision:0,icons:[]});
  assert.equal(statSync(library.path).mode&0o777,0o600);assert.equal(statSync(dir).mode&0o777,0o700);assert.equal(library.path,join(dir,'icon-library.json'));
  const icon=library.add('lucide:house',svg());assert.deepEqual(icon,{id:'lucide:house',set:'lucide',name:'house',svg:svg(),addedAt:1234,setName:'Lucide',license:'ISC'});
  const bytes=readFileSync(library.path);assert.equal(JSON.parse(bytes).revision,1);
  const again=new IconLibrary(dir,()=>9999).add('lucide:house',svg('<path d="M9 9"/>'));assert.deepEqual(again,icon,'adding the same ID again changes nothing');
  assert.deepEqual(readFileSync(library.path),bytes,'an idempotent add writes nothing');
  library.add('tabler:home',svg());assert.deepEqual(new IconLibrary(dir).state().icons.map(item=>item.id),['lucide:house','tabler:home']);assert.equal(new IconLibrary(dir).state().revision,2);
  assert.deepEqual(library.find('tabler:home').id,'tabler:home');assert.equal(library.find('ph:none'),undefined);
  library.state().icons[0].svg='tampered';library.find('lucide:house').svg='tampered';assert.equal(library.state().icons[0].svg,svg(),'callers get copies');
  for(const [id,body] of [['mdi:home',svg()],['lucide:Home',svg()],['lucide:ok','<svg><script/></svg>'],['lucide:ok','<html/>'],['lucide:ok','']])assert.throws(()=>library.add(id,body),fault('INVALID_INPUT'),id);
  assert.equal(library.state().icons.length,2);
  assert.equal(library.remove('lucide:house'),true);assert.equal(library.remove('lucide:house'),false);assert.equal(library.remove('ph:never'),false);assert.throws(()=>library.remove('nope'),fault('INVALID_INPUT'));
  assert.deepEqual(new IconLibrary(dir).state().icons.map(item=>item.id),['tabler:home']);assert.equal(new IconLibrary(dir).state().revision,3);
  assert.deepEqual(readdirSync(dir),['icon-library.json'],'no stray temporary files');
});

test('My icons holds 500 icons and 4 MiB, then says so without losing anything',t=>{
  assert.equal(MAX_LIBRARY_ICONS,500);assert.equal(MAX_LIBRARY_BYTES,4*1024*1024);
  const dir=directory(t);writeLibrary(dir,Array.from({length:499},(_,i)=>entry(`n-${i}`)));
  const library=new IconLibrary(dir);assert.equal(library.state().icons.length,499);assert.equal(library.damagedCopy,undefined);
  library.add('ph:last',svg());assert.equal(library.state().icons.length,500);
  assert.throws(()=>library.add('ph:one-more',svg()),fault('ICON_LIBRARY_FULL',409));assert.equal(new IconLibrary(dir).state().icons.length,500);
  assert.equal(library.add('ph:last',svg()).id,'ph:last','an icon that is already stored is not "full"');
  library.remove('ph:last');library.add('ph:one-more',svg());
  const bytes=directory(t);writeLibrary(bytes,Array.from({length:240},(_,i)=>entry(`n-${i}`,bigSvg(i))));
  const heavy=new IconLibrary(bytes);assert.equal(heavy.state().icons.length,240);assert.ok(statSync(heavy.path).size>3.5*1024*1024);
  let added=0;for(;added<60;added++){
    try{heavy.add(`ph:x-${added}`,bigSvg(1000+added));}catch(error){assert.ok(fault('ICON_LIBRARY_FULL',409)(error));assert.match(error.message,/4 MiB/);break;}
  }
  assert.ok(added>0&&added<60,`${added} more fit`);assert.ok(statSync(heavy.path).size<=MAX_LIBRARY_BYTES);assert.equal(new IconLibrary(bytes).state().icons.length,240+added);
  // 501 icons, or a file above 4 MiB, is not a valid library.
  const over=directory(t);writeLibrary(over,Array.from({length:501},(_,i)=>entry(`n-${i}`)));const rejected=new IconLibrary(over);
  assert.equal(rejected.state().icons.length,0);assert.ok(rejected.damagedCopy&&existsSync(rejected.damagedCopy));
});

test('a damaged My icons file never stops the Host: it is kept under a new name and an empty library starts',t=>{
  const cases={
    truncated:'{"schemaVersion":1,"revision":3,"icons":[{"id":"lucide:ho',empty:'',binary:Buffer.from([0xff,0xfe,0,1]),array:'[]',
    version3:JSON.stringify({schemaVersion:3,revision:1,icons:[]}),extra:JSON.stringify({schemaVersion:1,revision:1,icons:[],note:'x'}),missing:JSON.stringify({schemaVersion:1,icons:[]}),
    negativeRevision:JSON.stringify({schemaVersion:1,revision:-1,icons:[]}),notArray:JSON.stringify({schemaVersion:1,revision:1,icons:{}}),
    duplicate:JSON.stringify({schemaVersion:1,revision:1,icons:[entry('a'),entry('a')]}),setMismatch:JSON.stringify({schemaVersion:1,revision:1,icons:[{...entry('a'),set:'tabler'}]}),
    unsafe:JSON.stringify({schemaVersion:1,revision:1,icons:[entry('a','<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')]}),extraField:JSON.stringify({schemaVersion:1,revision:1,icons:[{...entry('a'),extra:1}]}),
    badTime:JSON.stringify({schemaVersion:1,revision:1,icons:[{...entry('a'),addedAt:'now'}]}),unknownSet:JSON.stringify({schemaVersion:1,revision:1,icons:[{...entry('a','x','mdi'),svg:svg()}]}),
  };
  for(const [name,content] of Object.entries(cases)){
    const dir=directory(t),path=join(dir,'icon-library.json');writeFileSync(path,content);
    const library=new IconLibrary(dir);
    assert.deepEqual(library.state(),{revision:0,icons:[]},name);assert.ok(library.damagedCopy,name);assert.notEqual(library.damagedCopy,path);
    assert.ok(readFileSync(library.damagedCopy).equals(Buffer.from(content)),`${name}: the original bytes are preserved`);
    assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),{schemaVersion:2,revision:0,icons:[]});
    assert.equal(library.add('lucide:house',svg()).id,'lucide:house',`${name}: usable again`);
  }
  // Every damaged copy gets its own name; an earlier one is never overwritten.
  const dir=directory(t),path=join(dir,'icon-library.json'),copies=new Set();
  for(const text of ['{','[','x']){writeFileSync(path,text);copies.add(new IconLibrary(dir).damagedCopy);}
  assert.equal(copies.size,3);assert.equal(readdirSync(dir).filter(name=>name.startsWith('icon-library.damaged-')).length,3);
  assert.deepEqual([...copies].map(file=>readFileSync(file,'utf8')).sort(),['[','x','{']);
  // A link or a folder in its place is moved aside, never followed.
  const linked=directory(t),target=join(linked,'precious.txt');writeFileSync(target,'keep');symlinkSync(target,join(linked,'icon-library.json'));
  const viaLink=new IconLibrary(linked);assert.ok(viaLink.damagedCopy);assert.equal(readFileSync(target,'utf8'),'keep');assert.equal(statSync(join(linked,'icon-library.json')).isFile(),true);
  assert.equal(new IconLibrary(directory(t)).damagedCopy,undefined);
});

test('a failed write leaves My icons exactly as it was',t=>{
  if(process.getuid?.()===0)return t.skip('root ignores directory permissions');
  const dir=directory(t),library=new IconLibrary(dir);library.add('lucide:house',svg());const before=readFileSync(library.path);
  chmodSync(dir,0o500);
  assert.throws(()=>library.add('lucide:camera',svg()),fault('SAVE_FAILED',500));assert.throws(()=>library.remove('lucide:house'),fault('SAVE_FAILED',500));
  chmodSync(dir,0o700);assert.deepEqual(library.state().icons.map(item=>item.id),['lucide:house']);assert.deepEqual(readFileSync(library.path),before);
  assert.equal(library.add('lucide:camera',svg()).id,'lucide:camera');
});

// ----- Host routes: real TLS and the production handlers, with a fake Iconify source. -----
async function host(t,options={}){
  const dir=directory(t);
  execFileSync(process.execPath,['scripts/setup.mjs'],{env:{...process.env,KEYLN_DATA_DIR:dir},stdio:'pipe'});
  const auth=new Auth(dir),store=new ConfigStore(dir),origin='https://127.0.0.1:0',scheduler=new Scheduler({run:async()=>assert.fail('No action allowed')});
  if(options.prefill)writeLibrary(dir,Array.from({length:options.prefill},(_,i)=>entry(`n-${i}`)));
  const library=options.library===false?undefined:new IconLibrary(dir),src=options.source??source();
  const server=createHost({origin,auth,store,scheduler,apps:[],tls:{key:readFileSync(join(dir,'tls/server.key')),cert:readFileSync(join(dir,'tls/server.pem'))},onPair:()=>{},
    ...(options.iconSearch===false?{}:{iconSearch:src}),...(library?{iconLibrary:library}:{})});
  await new Promise(yes=>server.listen(0,'127.0.0.1',yes));
  t.after(()=>{scheduler.stop();server.stopEvents();return new Promise(yes=>{server.closeAllConnections();server.close(yes);});});
  const pair=auth.begin(auth.invite(),'Icon test');auth.approve(pair.id);const cookie='__Host-keyln='+auth.claim(pair.id,pair.claim).token,ca=readFileSync(join(dir,'tls/rootCA.pem'));
  function send(path,value,extra={},method='POST'){return new Promise((yes,no)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,ca,servername:'',method,path,
    headers:{host:'127.0.0.1:0',origin,'content-type':'application/json','x-keyln-client':'1',cookie,...extra}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));
    res.on('end',()=>{const body=Buffer.concat(chunks).toString();yes({status:res.statusCode,headers:res.headers,body,json:()=>JSON.parse(body)});});});req.on('error',no);req.end(value===undefined?undefined:JSON.stringify(value));});}
  return{send,auth,library,src,dir,origin};
}
const sample=name=>({id:`lucide:${name}`,set:'lucide',name,svg:svg()});

test('icon library routes need a paired device and keep every origin boundary',async t=>{
  const h=await host(t),routes=[['/api/icon-library',{}],['/api/icon-library/search',{query:'home'}],['/api/icon-library/add',{id:'lucide:house'}],['/api/icon-library/remove',{id:'lucide:house'}]];
  for(const [path,body] of routes){
    assert.equal((await h.send(path,body,{cookie:''})).status,401,`${path} unpaired`);assert.equal((await h.send(path,body,{cookie:'__Host-keyln=0000'})).status,401);
    for(const extra of [{origin:'https://evil.test'},{'x-keyln-client':''},{'sec-fetch-site':'cross-site'},{host:'evil.test'}])assert.ok([401,403].includes((await h.send(path,body,extra)).status),`${path} ${JSON.stringify(extra)}`);
    assert.equal((await h.send(path,undefined,{},'GET')).status,405);
    assert.equal((await h.send(path,body,{'content-type':'text/plain'})).status,415);
  }
  assert.deepEqual(h.src.calls,{search:[],icon:[]},'nothing reached the network layer');
});

test('listing, searching, saving and removing icons through the Host, with strict inputs and per-set filtering',async t=>{
  const calls=[],h=await host(t,{source:source({search:(query,scope,set)=>{calls.push([query,scope,set]);return [sample('house'),{id:'tabler:home',set:'tabler',name:'home',svg:svg()}].filter(item=>!set||item.set===set);},
    icon:id=>id==='lucide:missing'?Promise.reject(new Fault('ICON_NOT_FOUND','That icon is not available as plain SVG. Choose another one.',404)):svg()})});
  const empty=await h.send('/api/icon-library',{});assert.equal(empty.status,200);assert.equal(empty.headers['cache-control'],'no-store');assert.match(empty.headers['content-type'],/^application\/json/);
  assert.deepEqual(empty.json(),{icons:[],sets:ICON_SETS.map(({prefix,name,license})=>({prefix,name,license}))});
  assert.match(empty.headers['content-security-policy'],/default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; manifest-src 'self'; connect-src 'self' wss:\/\/127\.0\.0\.1:0; base-uri 'none'; frame-ancestors 'none'; form-action 'none'/);
  const all=await h.send('/api/icon-library/search',{query:'  home  '});assert.equal(all.status,200);assert.deepEqual(all.json().results.map(item=>item.id),['lucide:house','tabler:home']);assert.deepEqual(calls.at(-1),['home','curated',undefined]);
  assert.deepEqual(Object.keys(all.json().results[0]).sort(),['id','license','name','set','setName','svg']);assert.deepEqual([all.json().results[1].setName,all.json().results[1].license],['Tabler Icons','MIT'],'curated sets always use the frozen names');
  const one=await h.send('/api/icon-library/search',{query:'home',set:'tabler'});assert.deepEqual(one.json().results.map(item=>item.id),['tabler:home']);assert.deepEqual(calls.at(-1),['home','curated','tabler']);
  const before=calls.length;
  for(const body of [{},{query:'h'},{query:'x'.repeat(65)},{query:5},{query:'ok',set:'mdi'},{query:'ok',set:null},{query:'ok',set:'lucide,tabler'},{query:'ok',extra:1},{query:'ok',set:'lucide',extra:1},[],null,'text',{query:'a\nb'}])
    assert.equal((await h.send('/api/icon-library/search',body)).status,400,JSON.stringify(body));
  assert.equal(calls.length,before,'rejected inputs never reach the source');
  const saved=await h.send('/api/icon-library/add',{id:'lucide:house'});assert.equal(saved.status,200);const icon=saved.json().icon;
  assert.deepEqual(Object.keys(icon).sort(),['addedAt','id','license','name','set','setName','svg']);assert.deepEqual([icon.setName,icon.license],['Lucide','ISC']);assert.equal(icon.id,'lucide:house');assert.equal(icon.svg,svg());assert.equal(h.library.state().icons.length,1);
  assert.equal(h.src.calls.icon.length,0,'an icon from the last search needs no second download');
  const fresh=await h.send('/api/icon-library/add',{id:'lucide:camera'});assert.equal(fresh.status,200);assert.equal(h.src.calls.icon.length,1);
  assert.deepEqual((await h.send('/api/icon-library/add',{id:'lucide:camera'})).json().icon,fresh.json().icon);assert.equal(h.src.calls.icon.length,1,'saving twice downloads once');
  assert.equal((await h.send('/api/icon-library/add',{id:'lucide:house'})).json().icon.addedAt,icon.addedAt);assert.equal(h.library.state().icons.length,2);
  assert.deepEqual((await h.send('/api/icon-library',{})).json().icons.map(item=>item.id),['lucide:house','lucide:camera']);
  for(const body of [{},{id:'house'},{id:'Mdi:home'},{id:'lucide:Home'},{id:5},{id:'lucide:house',extra:1},{id:'lucide:../x'},[]])assert.equal((await h.send('/api/icon-library/add',body)).status,400,JSON.stringify(body));
  // A set outside the curated six is only saved after a search has shown its name and licence; otherwise nothing is downloaded.
  const unknownSet=await h.send('/api/icon-library/add',{id:'mdi:home'});assert.equal(unknownSet.status,409);assert.equal(unknownSet.json().error.code,'ICON_SET_UNKNOWN');
  assert.equal(h.src.calls.icon.filter(id=>id==='mdi:home').length,0);
  const missing=await h.send('/api/icon-library/add',{id:'lucide:missing'});assert.equal(missing.status,404);assert.equal(missing.json().error.code,'ICON_NOT_FOUND');
  assert.equal((await h.send('/api/icon-library/remove',{id:'lucide:house'})).json().removed,true);assert.equal((await h.send('/api/icon-library/remove',{id:'lucide:house'})).json().removed,false);
  assert.equal((await h.send('/api/icon-library/remove',{id:'nope'})).status,400);assert.equal((await h.send('/api/icon-library/remove',{})).status,400);assert.equal(h.library.state().icons.length,1);
  assert.equal((await h.send('/api/icon-library',{extra:1})).status,400);
});

test('offline Mac: search and first-time save fail with the 503 explanation while My icons keeps working',async t=>{
  const offline=()=>{throw new Fault('ICON_SEARCH_UNAVAILABLE','Searching online icons needs your Mac to reach the internet. My icons still works offline.',503);};
  const h=await host(t,{source:source({search:offline,icon:offline})});
  h.library.add('lucide:house',svg());
  const search=await h.send('/api/icon-library/search',{query:'home'});assert.equal(search.status,503);assert.equal(search.json().error.code,'ICON_SEARCH_UNAVAILABLE');assert.match(search.json().error.message,/internet/);
  const add=await h.send('/api/icon-library/add',{id:'tabler:home'});assert.equal(add.status,503);assert.equal(add.json().error.code,'ICON_SEARCH_UNAVAILABLE');
  assert.equal((await h.send('/api/icon-library',{})).json().icons.length,1);
  assert.equal((await h.send('/api/icon-library/add',{id:'lucide:house'})).status,200,'an icon already in My icons needs no network');
  assert.equal((await h.send('/api/icon-library/remove',{id:'lucide:house'})).json().removed,true);
  // A Host without the online source or without the library says so instead of crashing.
  const noSearch=await host(t,{iconSearch:false});assert.equal((await noSearch.send('/api/icon-library/search',{query:'home'})).json().error.code,'ICON_SEARCH_UNAVAILABLE');
  assert.equal((await noSearch.send('/api/icon-library',{})).status,200);
  const none=await host(t,{library:false});assert.equal((await none.send('/api/icon-library',{})).status,503);assert.equal((await none.send('/api/icon-library/remove',{id:'lucide:a'})).json().error.code,'ICON_LIBRARY_UNAVAILABLE');
});

test('the Host runs at most two outbound searches at once and answers the rest with BUSY',async t=>{
  const gates=new Map(),h=await host(t,{source:source({search:query=>{const g=gate();gates.set(query,g);return g.promise;}})});
  const first=h.send('/api/icon-library/search',{query:'aa'}),second=h.send('/api/icon-library/search',{query:'bb'});
  while(gates.size<2)await turn();
  const busy=await h.send('/api/icon-library/search',{query:'cc'});assert.equal(busy.status,409);assert.equal(busy.json().error.code,'BUSY');
  const addBusy=await h.send('/api/icon-library/add',{id:'tabler:home'});assert.equal(addBusy.status,409);assert.equal(addBusy.json().error.code,'BUSY');
  assert.equal((await h.send('/api/icon-library',{})).status,200,'My icons is never blocked by online searches');
  gates.get('aa').resolve([sample('one')]);gates.get('bb').resolve([sample('two')]);
  assert.deepEqual((await first).json().results.map(item=>item.id),['lucide:one']);assert.equal((await second).status,200);
  gates.clear();const third=h.send('/api/icon-library/search',{query:'cc'});while(gates.size<1)await turn();gates.get('cc').resolve([]);assert.deepEqual((await third).json(),{results:[],truncated:false});
});

test('a device revoked while the Mac searches online gets 401 and nothing is stored',async t=>{
  const search=gate(),download=gate(),h=await host(t,{source:source({search:()=>search.promise,icon:()=>download.promise})});
  const pending=h.send('/api/icon-library/search',{query:'home'});while(!h.src.calls.search.length)await turn();
  h.auth.revoke(h.auth.list()[0].id);search.resolve([sample('house')]);const result=await pending;assert.equal(result.status,401);assert.ok(!result.body.includes('house'));
  const second=await host(t,{source:source({icon:()=>download.promise})});
  const adding=second.send('/api/icon-library/add',{id:'lucide:house'});while(!second.src.calls.icon.length)await turn();
  second.auth.revoke(second.auth.list()[0].id);download.resolve(svg());assert.equal((await adding).status,401);assert.equal(second.library.state().icons.length,0,'a revoked device cannot store an icon');
});

test('a full My icons reports it over the API, and replies are size-checked',async t=>{
  const h=await host(t,{prefill:500});
  assert.equal(h.library.state().icons.length,500);
  const response=await h.send('/api/icon-library/add',{id:'lucide:overflow'});assert.equal(response.status,409);assert.equal(response.json().error.code,'ICON_LIBRARY_FULL');assert.match(response.json().error.message,/500/);
  assert.equal((await h.send('/api/icon-library/add',{id:'lucide:n-3'})).status,200,'an icon that is already stored still succeeds');
  assert.equal((await h.send('/api/icon-library',{})).json().icons.length,500);
  assert.equal((await h.send('/api/icon-library/remove',{id:'lucide:n-3'})).json().removed,true);assert.equal((await h.send('/api/icon-library/add',{id:'lucide:overflow'})).status,200);
  const results=Array.from({length:48},(_,i)=>({id:`lucide:n-${i}`,set:'lucide',name:`n-${i}`,svg:svg(`<path d="${'M0 0h1'.repeat(2600)}"/>`)}));
  const wide=await host(t,{source:source({search:()=>results})});const ok=await wide.send('/api/icon-library/search',{query:'many'});
  assert.equal(ok.status,200);assert.equal(ok.json().results.length,48);assert.ok(ok.body.length>700_000&&ok.body.length<1_048_576);
});

test('a Mac that cannot send valid icons fails closed',async t=>{
  const h=await host(t,{source:source({icon:()=>'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',search:()=>[{id:'lucide:bad',set:'lucide',name:'bad',svg:'<html/>'},sample('good')]})});
  assert.deepEqual((await h.send('/api/icon-library/search',{query:'xx'})).json().results.map(item=>item.id),['lucide:good']);
  assert.equal((await h.send('/api/icon-library/add',{id:'lucide:evil'})).status,400);assert.equal(h.library.state().icons.length,0);
});

// ----- T32: all Iconify sets, set names and licences, library version 2 -----
const logo=(prefix,name)=>({id:`${prefix}:${name}`,set:prefix,name,svg:svg('<path fill="#111" d="M1 1h2"/>'),setName:`Name ${prefix}`,license:`Lic ${prefix}`});

test('collections give a non-curated set its name and licence; bad or missing values fall back without failing',()=>{
  const table={logos:{name:'SVG Logos',license:{title:'CC0',spdx:'CC0-1.0',url:'https://example.test/'}},devicon:{name:'Devicon',license:{title:'MIT'}},ooui:{name:'OOUI'},
    odd:{name:'x'.repeat(81),license:{spdx:'a\nb',title:'T'.repeat(81)}},ctl:{name:'a\u0000b',license:{spdx:5,title:{}}},spaced:{name:'  Spaced Name  ',license:{spdx:' ',title:' BSD 3 '}},lucide:{name:'Evil name',license:{spdx:'GPL-3.0'}},
    list:[1],text:'x',nul:null};
  assert.deepEqual(setInfo('logos',table),{setName:'SVG Logos',license:'CC0-1.0'},'spdx is preferred over the longer title');
  assert.deepEqual(setInfo('devicon',table),{setName:'Devicon',license:'MIT'},'the title is used when there is no spdx');
  assert.deepEqual(setInfo('ooui',table),{setName:'OOUI',license:ICON_UNKNOWN_LICENSE});
  assert.deepEqual(setInfo('odd',table),{setName:'odd',license:ICON_UNKNOWN_LICENSE},'oversized or non-printable text is not shown');
  assert.deepEqual(setInfo('ctl',table),{setName:'ctl',license:ICON_UNKNOWN_LICENSE});
  assert.deepEqual(setInfo('spaced',table),{setName:'Spaced Name',license:'BSD 3'});
  for(const bad of ['list','text','nul','absent'])assert.deepEqual(setInfo(bad,table),{setName:bad,license:ICON_UNKNOWN_LICENSE},bad);
  for(const collections of [undefined,null,[],'x',5,Object.create({logos:{name:'Inherited',license:{spdx:'MIT'}}})])assert.deepEqual(setInfo('logos',collections),{setName:'logos',license:ICON_UNKNOWN_LICENSE},String(collections));
  assert.deepEqual(setInfo('lucide',table),{setName:'Lucide',license:'ISC'},'a curated set always uses the frozen table, whatever Iconify says');
  assert.deepEqual(setInfo('simple-icons',undefined),{setName:'Simple Icons',license:'CC0-1.0'});
});

test('a search of all Iconify sets sends no prefixes, keeps Iconify order, keeps only the first twelve sets, costs at most thirteen requests and says when it dropped icons',async()=>{
  assert.equal(ICON_PREFIX_LIMIT,12);assert.equal(ICON_REQUEST_LIMIT,13);assert.equal(ICON_RESULT_LIMIT,48);
  const sets=Array.from({length:16},(_,i)=>`set${i}`);
  // Set 12 (the thirteenth) shows up before a later icon of set 0; only icons of the thirteenth and later sets are dropped.
  const found=[...sets.map(prefix=>`${prefix}:a`),'set0:b','set15:b','set1:b','set12:b','not a valid id',`${'x'.repeat(65)}:a`,'set2:b'];
  const collections=Object.fromEntries(sets.map((prefix,i)=>[prefix,{name:`Set ${i}`,license:{title:`Title ${i}`,...(i%2?{}:{spdx:`SPDX-${i}`})}}]));
  const fake=iconify({search:()=>json({icons:found,total:found.length,limit:48,start:0,collections})});
  const {results,truncated}=await new IconifyClient(fake.fetcher).search('codex','all');
  assert.equal(fake.calls[0].url,`${ICONIFY_ORIGIN}/search?query=codex&limit=48`);assert.doesNotMatch(fake.calls[0].url,/prefixes/);
  assert.equal(fake.calls.length,13,'one search plus one batch per kept set');
  assert.deepEqual(fake.calls.slice(1).map(call=>call.url.split('?')[0].slice(ICONIFY_ORIGIN.length)).sort(),sets.slice(0,12).map(prefix=>`/${prefix}.json`).sort(),'nothing is requested for sets thirteen to sixteen');
  assert.deepEqual(results.map(item=>item.id),[...sets.slice(0,12).map(prefix=>`${prefix}:a`),'set0:b','set1:b','set2:b'],'Iconify order is kept, variants are not merged and later sets are dropped');
  assert.equal(truncated,true,'icons were left out because of the set limit');assert.deepEqual(new Set(results.map(item=>item.set)).size,ICON_PREFIX_LIMIT);
  const byId=Object.fromEntries(results.map(item=>[item.id,item]));
  assert.deepEqual([byId['set0:a'].setName,byId['set0:a'].license],['Set 0','SPDX-0']);assert.deepEqual([byId['set1:a'].setName,byId['set1:a'].license],['Set 1','Title 1']);
  assert.deepEqual([byId['set1:b'].setName,byId['set1:b'].license],['Set 1','Title 1'],'every icon of a set carries the set\'s details');
  for(const {url,init} of fake.calls){assert.equal(new URL(url).origin,'https://api.iconify.design');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.method,'GET');assert.deepEqual(init.headers,{'User-Agent':'Keyln'});}
  assert.ok(fake.calls.every(call=>!/keyln|device|cookie|token|layout/i.test(call.url)));
  // Exactly twelve sets: nothing is dropped, so nothing is reported. Fewer sets, and an answer cut by Iconify's own limit of 48, are not "truncated" either.
  const twelve=iconify({search:()=>json({icons:sets.slice(0,12).flatMap(prefix=>[`${prefix}:a`,`${prefix}:b`]),total:24,collections})}),exact12=await new IconifyClient(twelve.fetcher).search('xx','all');
  assert.equal(exact12.results.length,24);assert.equal(exact12.truncated,false,'exactly twelve sets lose nothing');assert.equal(twelve.calls.length,13);
  const few=iconify({search:()=>json({icons:['set0:a','set1:a'],total:2,collections})}),fewer=await new IconifyClient(few.fetcher).search('xx','all');assert.equal(fewer.truncated,false);assert.equal(few.calls.length,3);
  const limited=iconify({search:()=>json({icons:Array.from({length:48},(_,i)=>`set${i%3}:n-${i}`),total:500,limit:48,collections})}),cut=await new IconifyClient(limited.fetcher).search('xx','all');
  assert.equal(cut.results.length,48);assert.equal(cut.truncated,false,'Iconify\'s own limit=48 cut is not reported');
  // The same when the answer has no collections at all, and curated sets inside an all-sets answer keep the frozen details.
  const bare=iconify({search:()=>json({icons:['logos:codex','lucide:house','tabler:home']})}),mixed=await new IconifyClient(bare.fetcher).search('codex','all');
  assert.deepEqual(mixed.results.map(item=>[item.id,item.setName,item.license]),[['logos:codex','logos',ICON_UNKNOWN_LICENSE],['lucide:house','Lucide','ISC'],['tabler:home','Tabler Icons','MIT']]);
  assert.equal(bare.calls.length,4);assert.equal(mixed.truncated,false);
  // A search cannot name more sets than the budget even if the answer is enormous.
  const many=iconify({search:()=>json({icons:Array.from({length:200},(_,i)=>`s${i}:a`)})}),capped=await new IconifyClient(many.fetcher).search('xx','all');
  assert.equal(capped.results.length,12);assert.equal(capped.truncated,true);assert.ok(many.calls.length<=13);
  // A curated search can never reach the limit; 'all' takes no set filter, and the curated default is unchanged.
  const guarded=iconify();await assert.rejects(new IconifyClient(guarded.fetcher).search('xx','all','lucide'),fault('INVALID_INPUT'));assert.equal(guarded.calls.length,0);
  const curated=iconify({found:['lucide:a']}),curatedAnswer=await new IconifyClient(curated.fetcher).search('xx');assert.match(curated.calls[0].url,/prefixes=material-symbols,lucide,tabler,ph,fluent,simple-icons&limit=48$/);assert.equal(curatedAnswer.truncated,false);
  // Every limit for a failing all-sets search is still one 503.
  await assert.rejects(new IconifyClient(async url=>new URL(url).pathname==='/search'?json({icons:['a:x','b:x']}):new Response('x',{status:500})).search('xx','all'),unavailable);
  // Thirteen requests fit the nine-second search limit with the unchanged concurrency of four: each simulated 40 ms request, 13 in all, ends well inside it.
  let started=Date.now();const timed=iconify({search:()=>json({icons:sets.map(prefix=>`${prefix}:a`),collections})});
  const slowFetch=async(url,init)=>{await wait(40);return timed.fetcher(url,init);};
  const slowAnswer=await new IconifyClient(slowFetch).search('xx','all');assert.equal(slowAnswer.results.length,12);assert.ok(Date.now()-started<1500,`${Date.now()-started} ms`);
});

test('the search layer re-checks scope and set limits, keeps the truncation flag with cached answers, remembers set details for saving, and bounds that memory',async()=>{
  const curatedOnly=new IconSearch(source({search:(query,scope)=>[logo('logos','codex'),{id:'lucide:house',set:'lucide',name:'house',svg:svg(),setName:'Fake',license:'Fake'},logo('mdi','home')]}));
  const kept=(await curatedOnly.search('xx','curated')).results;assert.deepEqual(kept.map(item=>item.id),['lucide:house'],'a curated search can only contain curated sets');
  assert.deepEqual([kept[0].setName,kept[0].license],['Lucide','ISC'],'curated details always come from the frozen table');
  // All sets: any prefix, at most twelve different ones, details checked again, "Unknown license" when the source gives none.
  const items=[...Array.from({length:14},(_,i)=>logo(`s${i}`,'a')),{...logo('s0','b'),license:'x'.repeat(81)},{...logo('s1','b'),setName:'a\nb'},{...logo('s11','b')},{id:'Bad:x',svg:svg()},{...logo('s2','b'),svg:svg('<script/>')}];
  const src=source({search:()=>items}),search=new IconSearch(src),answer=await search.search('xx','all'),all=answer.results;
  assert.deepEqual(all.map(item=>item.id),[...Array.from({length:12},(_,i)=>`s${i}:a`),'s0:b','s1:b','s11:b']);
  assert.equal(answer.truncated,true,'a source that returned too many sets is reported as truncated');
  assert.deepEqual(src.calls.search,[['xx','all',undefined]]);
  assert.equal(all.find(item=>item.id==='s0:b').license,ICON_UNKNOWN_LICENSE);assert.equal(all.find(item=>item.id==='s1:b').setName,'s1');assert.equal(all.find(item=>item.id==='s0:a').setName,'Name s0');
  await assert.rejects(search.search('xx','all','lucide'),fault('INVALID_INPUT'));await assert.rejects(search.search('主页','all'),fault('INVALID_INPUT'));
  // Cached answers keep the details and the same truncation flag, for both values of the flag.
  assert.deepEqual(await search.search('xx','all'),answer);assert.equal(src.calls.search.length,1);assert.equal((await search.search('xx','all')).truncated,true);
  const flags=new IconSearch(source({search:query=>({results:[logo('s0','a')],truncated:query==='cut'})}));
  assert.equal((await flags.search('cut','all')).truncated,true);assert.equal((await flags.search('cut','all')).truncated,true,'a cache hit keeps true');
  assert.equal((await flags.search('whole','all')).truncated,false);assert.equal((await flags.search('whole','all')).truncated,false,'a cache hit keeps false');
  const exact12=new IconSearch(source({search:()=>({results:Array.from({length:12},(_,i)=>logo(`s${i}`,'a')),truncated:false})})),twelve=await exact12.search('xx','all');
  assert.equal(twelve.results.length,12);assert.equal(twelve.truncated,false,'twelve sets and nothing dropped is not truncated');
  assert.equal((await new IconSearch(source({search:()=>({results:[logo('s0','a')]})})).search('xx','all')).truncated,false,'a source that does not say is not truncated');
  // Saving: the details of a seen set come with the icon; an unseen non-curated set is refused before any download.
  const saved=await search.icon('s3:a');assert.deepEqual([saved.svg,saved.setName,saved.license],[all.find(item=>item.id==='s3:a').svg,'Name s3','Lic s3']);assert.equal(src.calls.icon.length,0);
  const other=await search.icon('s3:other');assert.deepEqual([other.setName,other.license],['Name s3','Lic s3']);assert.equal(src.calls.icon.length,1);
  await assert.rejects(search.icon('never:seen'),fault('ICON_SET_UNKNOWN',409));assert.equal(src.calls.icon.length,1,'no download for an unknown set');
  assert.deepEqual(await search.icon('lucide:anything').then(item=>[item.setName,item.license]),['Lucide','ISC'],'curated sets never need a prior search');
  // The memory of set details is bounded (oldest first).
  const wide=new IconSearch(source({search:query=>Array.from({length:8},(_,i)=>logo(`q${query.slice(1)}x${i}`,'a'))}));
  assert.equal(ICON_CACHE_SETS,512);
  for(let i=0;i<70;i++)await wide.search('q'+i,'all');
  await assert.rejects(wide.icon('q0x0:a'),fault('ICON_SET_UNKNOWN'),'the oldest set was forgotten');assert.equal((await wide.icon('q69x7:a')).setName,'Name q69x7');assert.ok(wide.sets.size<=ICON_CACHE_SETS);
});

test('the search route takes scope "curated" or "all" and a set only with "curated"; English only',async t=>{
  const calls=[],h=await host(t,{source:source({search:(query,scope,set)=>{calls.push([query,scope,set]);return scope==='all'?[logo('logos','codex'),logo('devicon','codex'),sample('house')]:set?[]:[sample('house')];},icon:()=>svg('<path fill="#111" d="M1 1h2"/>')})});
  const all=await h.send('/api/icon-library/search',{query:'  codex ',scope:'all'});assert.equal(all.status,200);assert.deepEqual(calls.at(-1),['codex','all',undefined]);
  assert.deepEqual(all.json().results.map(item=>[item.id,item.setName,item.license]),[['logos:codex','Name logos','Lic logos'],['devicon:codex','Name devicon','Lic devicon'],['lucide:house','Lucide','ISC']]);
  assert.deepEqual((await h.send('/api/icon-library/search',{query:'codex',scope:'curated'})).json().results.map(item=>item.id),['lucide:house']);assert.deepEqual(calls.at(-1),['codex','curated',undefined]);
  assert.deepEqual((await h.send('/api/icon-library/search',{query:'codex',scope:'curated',set:'tabler'})).json().results,[]);assert.deepEqual(calls.at(-1),['codex','curated','tabler']);
  await h.send('/api/icon-library/search',{query:'plain'});assert.deepEqual(calls.at(-1),['plain','curated',undefined],'curated is the default');
  const before=calls.length;
  for(const body of [{query:'codex',scope:'all',set:'lucide'},{query:'codex',scope:'all',set:null},{query:'codex',scope:'everything'},{query:'codex',scope:null},{query:'codex',scope:'ALL'},{query:'codex',scope:5},{scope:'all'},{query:'a',scope:'all'},
    {query:'主页',scope:'all'},{query:'主页'},{query:'home 页',scope:'curated'},{query:'ｈｏｍｅ'},{query:'codex',scope:'all',extra:1},{query:'codex',scope:'all',set:'mdi'},{query:'codex',set:'mdi'},{query:'codex',scope:'curated',set:'logos'}])
    assert.equal((await h.send('/api/icon-library/search',body)).status,400,JSON.stringify(body));
  assert.equal(calls.length,before,'rejected inputs never reach the source');
  // Saving an icon from a set that appeared in a search keeps that set's name and licence, and the library shows them.
  await h.send('/api/icon-library/search',{query:'codex',scope:'all'});
  const add=await h.send('/api/icon-library/add',{id:'logos:codex'});assert.equal(add.status,200);
  assert.deepEqual([add.json().icon.setName,add.json().icon.license],['Name logos','Lic logos']);
  assert.deepEqual(JSON.parse(readFileSync(join(h.dir,'icon-library.json'),'utf8')).icons.map(({id,set,setName,license})=>({id,set,setName,license})),[{id:'logos:codex',set:'logos',setName:'Name logos',license:'Lic logos'}]);
  assert.equal(JSON.parse(readFileSync(join(h.dir,'icon-library.json'),'utf8')).schemaVersion,2);
  const listed=(await h.send('/api/icon-library',{})).json();assert.deepEqual(listed.icons.map(item=>[item.id,item.setName,item.license]),[['logos:codex','Name logos','Lic logos']]);
  assert.equal((await h.send('/api/icon-library/add',{id:'logos:codex'})).json().icon.addedAt,add.json().icon.addedAt,'saving again changes nothing');
  assert.equal((await h.send('/api/icon-library/add',{id:'never:seen'})).status,409);
});

test('My icons upgrades a version 1 file on the next write, reads version 2, and refuses invalid set names and licences',t=>{
  const dir=directory(t),path=join(dir,'icon-library.json');
  writeLibrary(dir,[entry('house',svg(),'lucide',5),entry('home',svg(),'tabler',6)],3);
  const before=readFileSync(path),library=new IconLibrary(dir,()=>77);
  assert.equal(library.damagedCopy,undefined);assert.ok(readFileSync(path).equals(before),'opening a version 1 file does not rewrite it');
  assert.deepEqual(library.state().icons.map(({id,setName,license})=>[id,setName,license]),[['lucide:house','Lucide','ISC'],['tabler:home','Tabler Icons','MIT']]);
  assert.equal(JSON.parse(before).schemaVersion,1);
  const added=library.add('logos:codex',svg('<path fill="#111" d="M1 1h2"/>'),{setName:'SVG Logos',license:'CC0-1.0'});
  assert.deepEqual(added,{id:'logos:codex',set:'logos',name:'codex',svg:svg('<path fill="#111" d="M1 1h2"/>'),addedAt:77,setName:'SVG Logos',license:'CC0-1.0'});
  const upgraded=JSON.parse(readFileSync(path,'utf8'));assert.equal(upgraded.schemaVersion,2);assert.equal(upgraded.revision,4);
  assert.deepEqual(upgraded.icons.map(({id,setName,license})=>[id,setName,license]),[['lucide:house','Lucide','ISC'],['tabler:home','Tabler Icons','MIT'],['logos:codex','SVG Logos','CC0-1.0']]);
  assert.deepEqual(upgraded.icons[0],{id:'lucide:house',set:'lucide',name:'house',svg:svg(),addedAt:5,setName:'Lucide',license:'ISC'},'old entries keep their ID, SVG and time');
  assert.equal(statSync(path).mode&0o777,0o600);assert.deepEqual(readdirSync(dir),['icon-library.json']);
  const again=new IconLibrary(dir);assert.equal(again.damagedCopy,undefined);assert.deepEqual(again.state(),library.state());
  // Version 2 as written by the Host is read back, including sets outside the curated six.
  assert.deepEqual(again.find('logos:codex').license,'CC0-1.0');
  // A version 1 file can only hold curated sets (that is all T31 ever wrote); anything else is damage.
  const bad=(content,name)=>{const d=directory(t);writeFileSync(join(d,'icon-library.json'),JSON.stringify(content));const lib=new IconLibrary(d);assert.ok(lib.damagedCopy,name);assert.deepEqual(lib.state(),{revision:0,icons:[]},name);};
  const v2=extra=>({schemaVersion:2,revision:1,icons:[{...entry('codex',svg(),'logos'),setName:'SVG Logos',license:'CC0-1.0',...extra}]});
  bad({schemaVersion:1,revision:1,icons:[entry('codex',svg(),'logos')]},'v1 with a non-curated set');
  bad(v2({setName:undefined}),'missing setName');bad(v2({license:undefined}),'missing license');bad(v2({setName:''}),'empty setName');bad(v2({license:'   '}),'blank license');
  bad(v2({setName:'x'.repeat(81)}),'long setName');bad(v2({license:'x'.repeat(81)}),'long license');bad(v2({license:'MIT\nGPL'}),'newline in license');bad(v2({setName:'a\u0000b'}),'control character');
  bad(v2({license:5}),'number license');bad(v2({setName:{}}),'object setName');bad(v2({extra:1}),'extra field');
  const ok=directory(t);writeFileSync(join(ok,'icon-library.json'),JSON.stringify(v2({})));assert.equal(new IconLibrary(ok).damagedCopy,undefined);
  // Adding: a non-curated set needs a valid name and licence; curated sets fill them in.
  const lib=new IconLibrary(directory(t));
  for(const info of [undefined,{},{setName:'SVG Logos'},{license:'MIT'},{setName:'',license:'MIT'},{setName:'A',license:'x'.repeat(81)},{setName:'A\nB',license:'MIT'},{setName:5,license:'MIT'}])
    assert.throws(()=>lib.add('logos:codex',svg(),info),fault('INVALID_INPUT'),JSON.stringify(info));
  assert.equal(lib.state().icons.length,0);
  assert.deepEqual(lib.add('lucide:house',svg()).setName,'Lucide');assert.equal(lib.add('logos:codex',svg(),{setName:'  SVG Logos ',license:' CC0-1.0'}).setName,'SVG Logos');
  assert.equal(lib.state().icons.length,2);
});

test('the search reply says whether icons of later sets were dropped, and a cached answer says the same',async t=>{
  const h=await host(t,{source:source({search:query=>({results:[logo('s0','a'),logo('s1','a')],truncated:query==='cut'})})});
  for(const round of [1,2]){
    const cut=await h.send('/api/icon-library/search',{query:'cut',scope:'all'}),whole=await h.send('/api/icon-library/search',{query:'whole',scope:'all'});
    assert.equal(cut.status,200);assert.deepEqual(Object.keys(cut.json()).sort(),['results','truncated']);assert.equal(cut.json().truncated,true,`round ${round}: dropped icons are reported`);
    assert.equal(whole.json().truncated,false,`round ${round}: nothing dropped, nothing reported`);assert.equal(whole.json().results.length,2);
  }
  assert.equal(h.src.calls.search.length,2,'the second round was answered from the cache');
  // A curated search can never be cut by the set limit (at most six sets), so it never reports truncation, whatever a source claims.
  const curated=await h.send('/api/icon-library/search',{query:'cut'});assert.equal(curated.status,200);assert.equal(curated.json().truncated,false,'a curated search is never truncated');
  assert.deepEqual((await h.send('/api/icon-library/search',{query:'nothing',scope:'all'})).json().results.length,2);
});
