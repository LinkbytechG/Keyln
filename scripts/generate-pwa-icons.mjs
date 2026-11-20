// Rebuild the committed, font-free Keyln app icons. Node built-ins only.
import {mkdirSync,writeFileSync} from 'node:fs';
import {deflateSync} from 'node:zlib';
const output=new URL('../apps/web/icons/',import.meta.url);
mkdirSync(output,{recursive:true});
const mint=[124,242,180],ink=[13,14,16];
const polygons=[[[160,144],[200,144],[200,368],[160,368]],[[196,252],[292,144],[348,144],[246,260]],[[210,264],[246,232],[352,368],[300,368]]];
const crcTable=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function chunk(type,body){
  const bytes=Buffer.concat([Buffer.from(type),body]);let crc=0xffffffff;
  for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);
  const header=Buffer.alloc(4),tail=Buffer.alloc(4);header.writeUInt32BE(body.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([header,bytes,tail]);
}
function inside(x,y,points){
  let result=false;
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const [ax,ay]=points[i],[bx,by]=points[j];
    if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)result=!result;
  }
  return result;
}
function render(size,maskable){
  const scale=512/size,samples=4,scan=Buffer.alloc((size*3+1)*size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const sum=[0,0,0];
    for(let sy=0;sy<samples;sy++)for(let sx=0;sx<samples;sx++){
      const px=(x+(sx+.5)/samples)*scale,py=(y+(sy+.5)/samples)*scale;
      const dx=Math.max(132-px,0,px-380),dy=Math.max(132-py,0,py-380);
      const tile=maskable||px>=32&&px<=480&&py>=32&&py<=480&&dx*dx+dy*dy<=10000;
      const color=tile&&!polygons.some(points=>inside(px,py,points))?mint:ink;
      for(let c=0;c<3;c++)sum[c]+=color[c];
    }
    const offset=y*(size*3+1)+1+x*3;
    for(let c=0;c<3;c++)scan[offset+c]=Math.round(sum[c]/(samples*samples));
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]);
}
for(const [size,maskable] of [[180,false],[192,false],[512,false],[512,true]]){
  const name=`keyln-${maskable?'maskable-':''}${size}.png`;
  writeFileSync(new URL(name,output),render(size,maskable));
  console.log(name);
}
writeFileSync(new URL('keyln.svg',output),`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>Keyln</title><rect width="512" height="512" fill="#0D0E10"/><rect x="32" y="32" width="448" height="448" rx="100" fill="#7CF2B4"/>${polygons.map(points=>`<polygon points="${points.map(p=>p.join(',')).join(' ')}" fill="#0D0E10"/>`).join('')}</svg>\n`);
