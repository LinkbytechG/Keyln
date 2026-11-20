import test from 'node:test';
import assert from 'node:assert/strict';
import {parseConfig,imageIcon} from '../dist/packages/contracts/index.js';
import {key,layout} from './helpers/layout.mjs';

const fault=code=>error=>error.code===code;
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1EAAAAASUVORK5CYII=';
test('raster icons are bounded embedded PNG/WebP only, with checked dimensions and canonical base64',()=>{
 assert.equal(imageIcon(png),png);
 const c=layout([key('primary',null,{},{appearance:{glyph:{type:'image',data:png}}})]);assert.deepEqual(parseConfig(c),c);
 const oversized=Buffer.from(png.split(',')[1],'base64');oversized.writeUInt32BE(257,16);
 for(const invalid of ['data:image/svg+xml;base64,'+Buffer.from('<svg onload="alert(1)"/>').toString('base64'),
 'data:text/html;base64,PHN2Zz4=',png+' ',png.replace('image/png','image/webp'),
 'data:image/png;base64,'+oversized.toString('base64'),'data:image/png;base64,'+Buffer.alloc(25_000).toString('base64')])
 assert.throws(()=>imageIcon(invalid),fault('INVALID_INPUT'));
});
