import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';

// T122 (ADR-106): app icons come from the approved keypad artwork in apps/web/icons/keyln.svg.
// Decodes the committed PNGs (8-bit RGBA, non-interlaced) and checks the platform rules, not exact pixels.
function decode(path){
  const file=readFileSync(path);assert.equal(file.subarray(0,8).toString('hex'),'89504e470d0a1a0a',path);
  let width=0,height=0;const data=[];
  for(let at=8;at<file.length;){
    const length=file.readUInt32BE(at),type=file.toString('latin1',at+4,at+8),body=file.subarray(at+8,at+8+length);
    if(type==='IHDR'){width=body.readUInt32BE(0);height=body.readUInt32BE(4);assert.deepEqual([body[8],body[9],body[12]],[8,6,0],`${path} must be 8-bit RGBA, non-interlaced`);}
    if(type==='IDAT')data.push(body);
    at+=12+length;
  }
  const raw=inflateSync(Buffer.concat(data)),stride=width*4,pixels=Buffer.alloc(stride*height);
  for(let y=0;y<height;y++){
    const filter=raw[y*(stride+1)],row=raw.subarray(y*(stride+1)+1,(y+1)*(stride+1));
    for(let x=0;x<stride;x++){
      const a=x>=4?pixels[y*stride+x-4]:0,b=y?pixels[(y-1)*stride+x]:0,c=x>=4&&y?pixels[(y-1)*stride+x-4]:0;
      const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
      const predictor=[0,a,b,(a+b)>>1,pa<=pb&&pa<=pc?a:pb<=pc?b:c][filter];
      assert.notEqual(predictor,undefined,`${path} uses an unknown PNG filter`);
      pixels[y*stride+x]=(row[x]+predictor)&255;
    }
  }
  return {width,height,at:(x,y)=>[...pixels.subarray((y*width+x)*4,(y*width+x)*4+4)]};
}
const TILE=[26,25,23,255];// #1A1917
const warm=([r,g,b,a])=>a>200&&r>180&&r-b>80;// the orange K, the junction key and the signal

test('T122 keyln.svg is the approved keypad artwork, not the old mint K', () => {
  const svg=readFileSync('apps/web/icons/keyln.svg','utf8');
  assert.match(svg,/viewBox="0 0 256 256"/);
  for(const color of ['#1A1917','#F26B1D','#FF9152','#F6A470'])assert.ok(svg.includes(color),color);
  assert.ok(!/7CF2B4/i.test(svg),'old mint mark');
});

test('T122 home screen and PWA icons are full bleed with the K where the artwork puts it', () => {
  for(const size of [180,192,512]){
    const icon=decode(`apps/web/icons/keyln-${size}.png`);assert.deepEqual([icon.width,icon.height],[size,size]);
    for(const [x,y] of [[0,0],[size-1,0],[0,size-1],[size-1,size-1],[Math.round(size*4/256),Math.round(size/2)]])assert.deepEqual(icon.at(x,y),TILE,`${size} at ${x},${y}`);
    for(let y=0;y<size;y+=7)for(let x=0;x<size;x+=7)assert.equal(icon.at(x,y)[3],255,`${size} must be opaque at ${x},${y}`);
    assert.ok(warm(icon.at(Math.round(size*64/256),Math.round(size*32/256))),`${size} top of the K stroke`);
    assert.ok(!warm(icon.at(Math.round(size*32/256),Math.round(size*32/256))),`${size} corner key stays dark`);
  }
});

test('T122 maskable icon keeps every warm pixel inside the safe zone', () => {
  const icon=decode('apps/web/icons/keyln-maskable-512.png'),centre=256,safe=512*0.4;let count=0;
  for(const [x,y] of [[0,0],[511,0],[0,511],[511,511]])assert.deepEqual(icon.at(x,y),TILE);
  for(let y=0;y<512;y++)for(let x=0;x<512;x++)if(warm(icon.at(x,y))){count++;assert.ok(Math.hypot(x+.5-centre,y+.5-centre)<=safe,`warm pixel outside the safe zone at ${x},${y}`);}
  assert.ok(count>5000,'the K must be drawn');
});

test('T122 Mac app icon is the rounded tile on the Apple icon grid with a transparent margin', () => {
  const icon=decode('native/macos-menubar/AppIcon.png');assert.deepEqual([icon.width,icon.height],[1024,1024]);
  for(const [x,y] of [[0,0],[1023,1023],[90,512],[512,90],[933,512]])assert.equal(icon.at(x,y)[3],0,`margin at ${x},${y}`);
  for(const [x,y] of [[110,512],[512,110],[913,512],[512,913]])assert.equal(icon.at(x,y)[3],255,`tile at ${x},${y}`);
  assert.ok(warm(icon.at(292,182)),'top of the K stroke');
  const icns='dist/Keyln.app/Contents/Resources/AppIcon.icns';
  if(existsSync(icns)){const data=readFileSync(icns);assert.equal(data.toString('latin1',0,4),'icns');assert.ok(data.includes(Buffer.from('ic10')),'1024 px (512@2x) entry');}
});
