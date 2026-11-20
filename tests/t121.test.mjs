import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

// T121 (ADR-105): QR code for the menu bar app. Compiles only QRCode.swift with a driver in a temp dir; never opens an app or starts a service.
const swiftc=spawnSync('/usr/bin/xcrun',['--find','swiftc'],{encoding:'utf8'});
const skip=swiftc.status===0?false:'xcrun swiftc is unavailable';
const driver=`import CoreImage
import CoreGraphics
import Foundation
for text in CommandLine.arguments.dropFirst() {
  let px = 8
  guard let img = QRCode.cgImage(for: text, modulePixels: px) else { print("{\\"error\\":\\"nil\\"}"); continue }
  let w = img.width, h = img.height
  var data = [UInt8](repeating: 0, count: w * h * 4)
  let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
  let q = 4 * px
  var quietWhite = true, dark = 0
  for y in 0..<h { for x in 0..<w {
    let i = (y * w + x) * 4
    let white = data[i] == 255 && data[i+1] == 255 && data[i+2] == 255
    if !white { dark += 1 }
    if (x < q || y < q || x >= w - q || y >= h - q) && !white { quietWhite = false }
  } }
  let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
  let features = detector.features(in: CIImage(cgImage: img))
  let message = (features.first as? CIQRCodeFeature)?.messageString ?? ""
  let obj: [String: Any] = ["message": message, "width": w, "height": h, "quietWhite": quietWhite, "dark": dark, "px": px]
  print(String(data: try! JSONSerialization.data(withJSONObject: obj), encoding: .utf8)!)
}
`;
test('QRCode.cgImage round-trips through the system QR detector with a white quiet zone',{skip},t=>{
 const dir=mkdtempSync(join(tmpdir(),'keyln-t121-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(join(dir,'main.swift'),driver);
 const out=join(dir,'qrtest');
 execFileSync('/usr/bin/xcrun',['swiftc','-module-cache-path',join(dir,'cache'),resolve('native/macos-menubar/QRCode.swift'),join(dir,'main.swift'),'-o',out],{stdio:'pipe'});
 const inputs=['https://192.0.2.10:8941','https://a-rather-long-host-name.example.local:8941/with/a/long/path?token=abcdefghijklmnopqrstuvwxyz0123456789&more=0123456789abcdef'];
 const lines=execFileSync(out,inputs,{encoding:'utf8'}).trim().split('\n').map(l=>JSON.parse(l));
 assert.equal(lines.length,inputs.length);
 lines.forEach((r,i)=>{
  assert.equal(r.message,inputs[i]);
  assert.equal(r.quietWhite,true);
  assert.equal(r.width,r.height);assert.equal(r.width%r.px,0);assert.ok(r.dark>0);
 });
 assert.ok(lines[1].width>lines[0].width);
});

test('the built menu bar app still verifies and contains the QR sources',()=>{
 execFileSync('/usr/bin/codesign',['--verify','--strict','dist/Keyln.app'],{stdio:'pipe'});
 assert.match(readFileSync('native/macos-menubar/AppDelegate.swift','utf8'),/Show QR Code…/);
});
