// Opt-in local Claude status-line bridge. Never reads tokens or modifies login state.
import {readFileSync,writeFileSync,renameSync,lstatSync,mkdirSync,chmodSync,existsSync,unlinkSync,realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {defaultDataDir} from '../dist/apps/host/store.js';
import {executable} from '../dist/apps/host/subscriptions.js';
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
const own=(path,max=262144)=>{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.size>max||s.uid!==process.getuid())throw new Error('Unsafe local settings or bridge file.');return readFileSync(path,'utf8');};
const json=text=>{const v=JSON.parse(text);if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Expected a JSON settings object.');return v;};
function atomic(path,text){const tmp=path+'.'+randomUUID()+'.tmp';try{writeFileSync(tmp,text,{flag:'wx',mode:0o600});renameSync(tmp,path);}finally{try{unlinkSync(tmp);}catch{}}}
function stableNode(){
  for(const candidate of ['/opt/homebrew/bin/node','/usr/local/bin/node'])try{if(realpathSync(candidate)===realpathSync(process.execPath))return candidate;}catch{}
  return process.execPath;
}
export function configureClaudeBridge({dataDir=defaultDataDir(),configDir=process.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude'),node=stableNode(),claude=executable('claude'),disconnect=false}={}){
  if(!claude&&!disconnect)throw new Error('Install Claude Code first.');
  const dir=join(resolve(dataDir),'subscription-usage'),settingsPath=join(resolve(configDir),'settings.json'),manifestPath=join(dir,'bridge.json');
  const originalBytes=existsSync(settingsPath)?own(settingsPath):undefined,settings=json(originalBytes??'{}');
  let manifest=existsSync(manifestPath)?json(own(manifestPath)):undefined;
  if(manifest&&(manifest.version!==1||!manifest.installed||!Object.hasOwn(manifest,'original')))throw new Error('Invalid bridge manifest. Review the local bridge before changing it.');
  const current=settings.statusLine;
  if(disconnect){
    if(!manifest) return {connected:false,changed:false};
    if(JSON.stringify(current)!==JSON.stringify(manifest.installed))throw new Error('The Claude status line changed after setup; keep it and remove the Keyln bridge manually.');
    if(manifest.original===null)delete settings.statusLine;else settings.statusLine=manifest.original;
    if(own(settingsPath)!==originalBytes)throw new Error('Claude settings changed. Retry after reviewing them.');
    if(manifest.settingsExisted===false&&Object.keys(settings).length===0)unlinkSync(settingsPath);
    else atomic(settingsPath,JSON.stringify(settings,null,2)+'\n');
    unlinkSync(manifestPath);try{unlinkSync(join(dir,'claude.json'));}catch{}
    try{unlinkSync(join(dir,'capture.mjs'));}catch{}
    return {connected:false,changed:true};
  }
  if(current!==undefined&&(!current||typeof current!=='object'||current.type!=='command'||typeof current.command!=='string'))throw new Error('The existing status line cannot be safely wrapped.');
  if(manifest&&JSON.stringify(current)!==JSON.stringify(manifest.installed))throw new Error('The Claude status line changed after setup. Disconnect or review it before reconnecting.');
  mkdirSync(dir,{recursive:true,mode:0o700});if(lstatSync(dir).isSymbolicLink())throw new Error('Unsafe bridge directory.');chmodSync(dir,0o700);
  mkdirSync(configDir,{recursive:true,mode:0o700});
  const capture=join(dir,'capture.mjs'),installed={...(current??{}),type:'command',command:quote(node)+' '+quote(capture)};
  // A re-run updates the helper/runtime path without wrapping itself or losing the saved original.
  const source=readFileSync(fileURLToPath(new URL('../dist/apps/host/claude-statusline.js',import.meta.url)),'utf8');
  if(source.includes('from "./')||source.includes('from "../'))throw new Error('Capture helper is not standalone. Rebuild first.');
  if(!manifest)manifest={version:1,original:current??null,settingsExisted:originalBytes!==undefined,installed,claude,createdAt:Date.now()};else manifest={...manifest,installed,claude};
  if((existsSync(settingsPath)?own(settingsPath):undefined)!==originalBytes)throw new Error('Claude settings changed. Retry after reviewing them.');
  const before=new Map([capture,manifestPath].map(path=>[path,existsSync(path)?own(path):undefined]));
  try{
    atomic(capture,source);atomic(manifestPath,JSON.stringify(manifest,null,2)+'\n');
    if((existsSync(settingsPath)?own(settingsPath):undefined)!==originalBytes)throw new Error('Claude settings changed. Retry after reviewing them.');
    settings.statusLine=installed;atomic(settingsPath,JSON.stringify(settings,null,2)+'\n');
  }catch(error){
    for(const [path,bytes]of before)if(bytes===undefined){try{unlinkSync(path);}catch{}}else atomic(path,bytes);
    throw error;
  }
  return {connected:true,changed:true};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const action=process.argv[2];
  if(!['connect-claude','disconnect-claude'].includes(action)){console.error('Usage: node scripts/subscriptions.mjs connect-claude | disconnect-claude');process.exitCode=1;}
  else try{console.log(JSON.stringify(configureClaudeBridge({disconnect:action==='disconnect-claude'})));}catch(error){console.error(error.message);process.exitCode=1;}
}
