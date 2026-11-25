import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

// T126 (ADR-110): the menu bar mark is a template K with signal arcs, drawn by StatusIcon.swift.
// Compiles only that file with a driver in a temp dir and renders each state at 2x; never opens an app or starts a service.
const swiftc=spawnSync('/usr/bin/xcrun',['--find','swiftc'],{encoding:'utf8'});
const skip=swiftc.status===0?false:'xcrun swiftc is unavailable';
const driver=`import AppKit
for (name, state) in [("running", StatusIconState.running), ("stopped", .stopped), ("attention", .attention)] {
  let image = StatusIcon.image(state, description: "Keyln " + name)
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 36, pixelsHigh: 36, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  rep.size = NSSize(width: 18, height: 18)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  image.draw(in: NSRect(x: 0, y: 0, width: 18, height: 18))
  NSGraphicsContext.restoreGraphicsState()
  var alpha = [Int](), colour = 0
  for y in 0..<36 { for x in 0..<36 {
    var p = [Int](repeating: 0, count: 4); rep.getPixel(&p, atX: x, y: y)
    alpha.append(p[3]); if p[3] > 0 { colour = max(colour, p[0], p[1], p[2]) }
  } }
  let obj: [String: Any] = ["name": name, "template": image.isTemplate, "width": image.size.width, "height": image.size.height, "description": image.accessibilityDescription ?? "", "alpha": alpha, "colour": colour]
  print(String(data: try! JSONSerialization.data(withJSONObject: obj), encoding: .utf8)!)
}
`;
function render(t){
  const dir=mkdtempSync(join(tmpdir(),'keyln-t126-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(join(dir,'main.swift'),driver);
  const out=join(dir,'statusicon');
  execFileSync('/usr/bin/xcrun',['swiftc','-module-cache-path',join(dir,'cache'),resolve('native/macos-menubar/StatusIcon.swift'),join(dir,'main.swift'),'-o',out],{stdio:'pipe'});
  return Object.fromEntries(execFileSync(out,{encoding:'utf8'}).trim().split('\n').map(line=>{const o=JSON.parse(line);return [o.name,o];}));
}
// Pixel coordinates at 2x, top-left origin. Keys are 2.75 pt with 0.6 pt gaps from 1 pt.
const ink=(icon,x,y)=>icon.alpha[y*36+x]>128;
const inkIn=(icon,x0,y0,x1,y1)=>{let n=0;for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)if(icon.alpha[y*36+x]>32)n++;return n;};

test('T126 every state is an 18 pt black template image with a description',{skip},t=>{
  const icons=render(t);
  for(const name of ['running','stopped','attention']){
    const icon=icons[name];assert.equal(icon.template,true,name);assert.deepEqual([icon.width,icon.height],[18,18],name);
    assert.equal(icon.description,'Keyln '+name);assert.equal(icon.colour,0,`${name} draws in black only, so macOS can tint it`);
    // The K: the full-height stroke, the junction key, both arms.
    for(const [x,y] of [[4,4],[4,18],[4,31],[11,18],[18,11],[18,25],[25,4],[25,31]])assert.ok(ink(icon,x,y),`${name} K key at ${x},${y}`);
    for(const [x,y] of [[11,4],[11,31],[18,18]])assert.ok(!ink(icon,x,y),`${name} K stays open at ${x},${y}`);
  }
});

test('T126 the signal shows only while running; attention shows an exclamation mark clear of the K',{skip},t=>{
  const {running,stopped,attention}=render(t);
  assert.ok(ink(running,24,18),'inner arc');assert.ok(ink(running,30,18),'outer arc past the arms');
  assert.equal(inkIn(stopped,21,9,36,27),0,'no signal when stopped');
  assert.equal(inkIn(attention,21,9,30,27),0,'no arcs with the warning');
  assert.ok(ink(attention,32,10)&&ink(attention,32,20)&&ink(attention,32,29),'exclamation bar and dot');
  assert.ok(!ink(attention,32,25),'gap between bar and dot');
  assert.equal(inkIn(attention,29,0,30,36),0,'exclamation does not touch the K arms');
});

test('T126 the menu bar uses StatusIcon and dims the stopped state instead of SF Symbols',()=>{
  const source=readFileSync('native/macos-menubar/AppDelegate.swift','utf8');
  assert.ok(!source.includes('systemSymbolName'),'no SF Symbol for the status item');
  assert.match(source,/button\.image = StatusIcon\.image\(icon, description: "Keyln " \+ words\)/);
  assert.match(source,/button\.appearsDisabled = icon == \.stopped/);
  for(const [state,words] of [['attention','status unavailable'],['stopped','not installed'],['stopped','stopped'],['attention','running, permission missing or unknown'],['running','running']])
    assert.ok(source.includes(`icon = .${state}; words = "${words}"`),words);
});
