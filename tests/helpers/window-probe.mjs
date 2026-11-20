import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

export async function windowProbe(){
 if(process.platform!=='darwin'||process.getuid?.()===0)throw Error('Use the signed-in Mac user, without sudo.');
 const directory=mkdtempSync(join(tmpdir(),'keyln-t20-probe-')),nonce=randomUUID().slice(0,8),bundleId=`local.keyln.windowprobe.${nonce}`,app=join(directory,'Keyln Window Test.app'),contents=join(app,'Contents');
 mkdirSync(join(contents,'MacOS'),{recursive:true});
 const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;');
 writeFileSync(join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleName</key><string>Keyln Window Test</string><key>CFBundleExecutable</key><string>probe</string><key>CFBundlePackageType</key><string>APPL</string><key>KeylnProbeNonce</key><string>${nonce}</string><key>KeylnProbeDirectory</key><string>${escape(directory)}</string></dict></plist>`);
 let serial=0,closed=false;
 const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
 const state=()=>JSON.parse(readFileSync(join(directory,'state.json'),'utf8'));
 async function until(check,ms=7000){const deadline=Date.now()+ms;while(Date.now()<deadline){try{const current=state();if(current.nonce!==nonce)throw Error('Wrong probe identity.');if(check(current))return current;}catch(error){if(error.message==='Wrong probe identity.')throw error;}await delay(50);}throw Error('Owned window probe did not reach its expected state.');}
 async function command(action){writeFileSync(join(directory,'command.json'),JSON.stringify({nonce,serial:++serial,action}),{mode:0o600});return await until(value=>value.serial===serial);}
 try{
  execFileSync('/usr/bin/xcrun',['swiftc','-O','-module-cache-path',resolve('dist/swift-cache'),'tests/window-probe/main.swift','-o',join(contents,'MacOS/probe')],{stdio:'pipe'});
  execFileSync('/usr/bin/codesign',['--force','--sign','-','--identifier',bundleId,app],{stdio:'pipe'});
  // Launch readiness is independent of focus; modern macOS may keep a new app behind a full-screen Space.
  execFileSync('/usr/bin/open',['-n',app],{stdio:'pipe'});await until(value=>value.windows?.a&&value.windows?.b);
  return {directory,nonce,bundleId,titleA:`Keyln Window A ${nonce}`,titleB:`Keyln Window B ${nonce}`,state,until,command,
   async close(){if(closed)return;closed=true;const pid=state().pid;if(alive(pid))await command('quit');const end=Date.now()+5000;while(Date.now()<end){if(!alive(pid)){rmSync(directory,{recursive:true,force:true});return {stopped:true,dataRemoved:!existsSync(directory)};}await delay(50);}throw Error('Owned window app did not exit; its directory was preserved.');}
  };
 }catch(error){
  if(!existsSync(join(directory,'state.json')))rmSync(directory,{recursive:true,force:true});
  else {const own=state();if(own.nonce===nonce){if(alive(own.pid))await command('quit');const end=Date.now()+5000;while(alive(own.pid)&&Date.now()<end)await delay(50);if(!alive(own.pid))rmSync(directory,{recursive:true,force:true});}}
  throw error;
 }
}
