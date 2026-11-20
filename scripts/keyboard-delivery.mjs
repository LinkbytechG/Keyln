import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';

if(process.platform!=='darwin'||process.getuid?.()===0)throw Error('Run this explicit test as the signed-in Mac user, without sudo.');
const binary=resolve('dist/keyln-delivery-probe');
mkdirSync('dist/swift-cache',{recursive:true});
function run(command,args,timeout){
  const result=spawnSync(command,args,{stdio:'inherit',timeout});
  if(result.error){console.error(result.error.message);process.exit(1);}
  if(result.status!==0)process.exit(result.status??1);
}
run('/usr/bin/xcrun',['swiftc','-O','-module-cache-path',resolve('dist/swift-cache'),'tests/native-delivery-probe/main.swift','native/macos-helper/Keyboard.swift','-o',binary],30_000);
run('/usr/bin/codesign',['--force','--sign','-','--identifier','local.keyln.delivery-probe',binary],5000);
console.log('This explicit test sends 20 Command+A samples only to its own temporary window. Keep it in front; do not use other apps until it finishes.');
run(binary,[],45_000);
