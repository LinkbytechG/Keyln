import test from 'node:test';
import assert from 'node:assert/strict';
import {parseConfig,imageIcon,jpegDimensions} from '../dist/packages/contracts/index.js';
import {prepareSvg} from '../dist/apps/web/layout-tools.js';
import {iconInk} from '../dist/apps/web/presentation.js';

const fault=code=>error=>error.code===code;
const clone=value=>JSON.parse(JSON.stringify(value));
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1EAAAAASUVORK5CYII=';

// T30 requirement 3: JPEG headers and SVG preparation.
function jpeg(...segments){return Uint8Array.from([0xff,0xd8,...segments.flat()]);}
const sof=(marker,width,height,components=3)=>[0xff,marker,0,8+3*components,8,height>>8,height&255,width>>8,width&255,components,...Array.from({length:components},(_,index)=>[index+1,0x11,0]).flat()];
test('JPEG dimensions come from any SOF marker after other segments, and never from DHT-like markers',()=>{
 assert.deepEqual(jpegDimensions(jpeg(sof(0xc0,640,480))),{width:640,height:480});
 assert.deepEqual(jpegDimensions(jpeg(sof(0xc1,1,2048,1))),{width:1,height:2048});
 assert.deepEqual(jpegDimensions(jpeg(sof(0xc2,4000,3000))),{width:4000,height:3000});
 const exif=[0xff,0xe1,0,10,69,120,105,102,0,0,0,0],comment=[0xff,0xfe,0,5,97,98,99],dht=[0xff,0xc4,0,6,0,1,2,3],dac=[0xff,0xcc,0,4,0,0],fill=[0xff,0xff,0xff];
 assert.deepEqual(jpegDimensions(jpeg(exif,comment,fill,dht,dac,sof(0xc0,300,200))),{width:300,height:200});
 assert.deepEqual(jpegDimensions(jpeg([0xff,0xd0],[0xff,0x01],sof(0xc0,10,20))),{width:10,height:20});
});
test('malformed or truncated JPEG headers are refused without reading past the buffer',()=>{
 const good=jpeg(sof(0xc0,64,64));
 const cases=[new Uint8Array(),Uint8Array.from([0xff]),Uint8Array.from([0xff,0xd8]),Uint8Array.from([0x89,0x50,0x4e,0x47]),good.slice(0,6),good.slice(0,good.length-4),
  jpeg(sof(0xc0,0,64)),jpeg(sof(0xc0,64,0)),jpeg([0xff,0xc0,0,2]),jpeg([0xff,0xc0,0,7,8,0,1,0]),jpeg([0xff,0xe0,0,1]),jpeg([0xff,0xe0,0xff,0xff,1,2,3]),
  jpeg([0xff,0xda,0,4,0,0],sof(0xc0,64,64)),jpeg([0xff,0xd9],sof(0xc0,64,64)),jpeg([1,2,3,4,5,6]),jpeg([0xff,0xc4,0,6,0,1,2,3]),jpeg([0xff,0xc8,0,8,8,0,1,0,1,1,0,0]),
  Uint8Array.from({length:64},(_,index)=>index)];
 for(const bytes of cases)assert.throws(()=>jpegDimensions(bytes),fault('INVALID_INPUT'));
});
test('prepareSvg fixes the render box from width/height, viewBox or a square, and keeps the aspect ratio',()=>{
 const wrap=(attributes,body='<path d="M0 0h1v1z" fill="currentColor"/>')=>`<svg xmlns="http://www.w3.org/2000/svg"${attributes}>${body}</svg>`;
 const sized=prepareSvg(wrap(' width="400" height="200"'),'#FFFFFF');
 assert.deepEqual([sized.width,sized.height],[192,96]);assert.match(sized.text,/ width="192" height="96"/);assert.match(sized.text,/viewBox="0 0 400 200"/);assert.ok(!sized.text.includes('width="400"'));
 const view=prepareSvg(wrap(' viewBox="0 0 24 48"'),'#FFFFFF');assert.deepEqual([view.width,view.height],[96,192]);assert.match(view.text,/viewBox="0 0 24 48"/);assert.equal(view.text.match(/viewBox=/g).length,1);
 const comma=prepareSvg(wrap(' viewBox="0,0,30,10" width="60px" height="20pt"'),'#FFFFFF');assert.ok(Math.abs(comma.width/comma.height-60/(20*4/3))<0.05);
 const widthOnly=prepareSvg(wrap(' width="50"'),'#FFFFFF');assert.deepEqual([widthOnly.width,widthOnly.height],[192,192]);
 const heightOnlyView=prepareSvg(wrap(' height="10" viewBox="0 0 40 20"'),'#FFFFFF');assert.deepEqual([heightOnlyView.width,heightOnlyView.height],[192,96]);
 const bare=prepareSvg(wrap(''),'#FFFFFF');assert.deepEqual([bare.width,bare.height],[192,192]);assert.ok(!bare.text.includes('viewBox'));
 const percent=prepareSvg(wrap(' width="100%" height="100%" viewBox="0 0 10 10"'),'#FFFFFF');assert.deepEqual([percent.width,percent.height],[192,192]);
 const edge=prepareSvg(wrap(' width="1000" height="1"'),'#FFFFFF',160);assert.deepEqual([edge.width,edge.height],[160,1]);
 assert.match(prepareSvg(wrap(' stroke-width="9" viewBox="0 0 8 8"'),'#FFFFFF').text,/stroke-width="9"/,'only the root width/height are replaced');
});
test('prepareSvg replaces currentColor with the key ink, handles prologs and rejects non-SVG roots without modifying anything',()=>{
 const icon='<?xml version="1.0" encoding="UTF-8"?>\n<!-- exported -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" style="color:CURRENTCOLOR"><path d="M3 3h18" stroke="currentColor"/></svg>';
 const prepared=prepareSvg('﻿'+icon,'#EEEFF1');
 assert.ok(!/currentcolor/i.test(prepared.text));assert.equal(prepared.text.match(/#EEEFF1/g).length,3);
 assert.ok(!prepared.text.includes('<?xml'));assert.match(prepared.text,/<!DOCTYPE svg PUBLIC/);assert.match(prepared.text,/<!-- exported -->/);assert.match(prepared.text,/<svg xmlns="[^"]+" viewBox="0 0 24 24" fill="none" stroke="#EEEFF1" style="color:#EEEFF1" width="192" height="192">/);
 assert.equal(prepareSvg('<svg width="10" height="10"/>','#FFFFFF').text,'<svg width="192" height="192" viewBox="0 0 10 10"/>');
 const single=prepareSvg("<svg viewBox='0 0 4 2' width='8'></svg>",'#FFFFFF');assert.deepEqual([single.width,single.height],[192,96]);
 for(const bad of ['','plain text','<html><svg/></html>','<svg:svg xmlns:svg="http://www.w3.org/2000/svg"/>','<svgfoo/>','<!-- <svg> -->','<?xml version="1.0"?><root/>','<svg width="1" ','<svg a="unterminated>'])
  assert.throws(()=>prepareSvg(bad,'#FFFFFF'),/not an SVG/,JSON.stringify(bad));
});
test('prepareSvg only rewrites text: scripts and external references are left for the image decoder to ignore',()=>{
 const hostile='<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="8" height="8" onload="alert(1)"><script>alert(2)</script><image xlink:href="https://example.test/x.png" width="8" height="8"/><path fill="currentColor" d="M0 0h8v8z"/></svg>';
 const prepared=prepareSvg(hostile,'#141414');
 assert.match(prepared.text,/<script>alert\(2\)<\/script>/);assert.match(prepared.text,/https:\/\/example\.test\/x\.png/);assert.match(prepared.text,/fill="#141414"/);
});
test('SVG icon ink (T33): light ink on the dark key body, the theme tone for outline and plain, a custom color as chosen; Classic keeps dark ink on its color plate',()=>{
 // T30 drew a one-color icon in dark ink on the key's color block. Since T33 images sit on the dark key body, so the default is light.
 const base={icon:'app',action:null};
 assert.equal(iconInk(),'#FFFFFF');
 assert.equal(iconInk({...base}),'#F1EFE8');assert.equal(iconInk({...base,appearance:{style:'tile'}}),'#F1EFE8');
 assert.equal(iconInk({...base,appearance:{tint:'#101010'}}),'#101010');assert.equal(iconInk({...base,appearance:{tint:'#F0E060'}}),'#F0E060');
 assert.equal(iconInk({...base,color:'green',appearance:{style:'outline'}}),'#5E9B63');assert.equal(iconInk({...base,appearance:{style:'plain'}}),'#617C96');
 assert.equal(iconInk({...base,icon:'play',appearance:{style:'plain'}}),'#5E9B63');assert.equal(iconInk({...base,appearance:{style:'plain',tint:'#ABCDEF'}}),'#ABCDEF');
 assert.equal(iconInk({...base,color:'green',appearance:{style:'outline'}},'metro'),'#00A040');assert.equal(iconInk({...base,appearance:{style:'plain'}},'metro'),'#1A83C8','a fill too dark for the key body uses its lighter tone');
 assert.equal(iconInk({...base},'classic'),'#141414');assert.equal(iconInk({...base,appearance:{style:'tile'}},'classic'),'#141414');
 assert.equal(iconInk({...base,appearance:{tint:'#101010'}},'classic'),'#EEEFF1');assert.equal(iconInk({...base,appearance:{tint:'#F0E060'}},'classic'),'#141414');
 assert.equal(iconInk({...base,color:'green',appearance:{style:'outline'}},'classic'),'#7CF2B4');assert.equal(iconInk({...base,appearance:{style:'plain'}},'classic'),'#5AA9FF');
});
