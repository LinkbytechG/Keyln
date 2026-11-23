import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, isAbsolute, basename } from "node:path";
import { homedir, networkInterfaces } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { atomicBytes, atomicJSON, defaultDataDir, privateDir } from "./store.js";

export const SERVICE_LABEL = "local.keyln.host";
export interface ServicePaths { label:string;data:string;runtime:string;logs:string;plist:string;manifest:string }
interface ManifestV1 {schemaVersion:1;label:string;uid:number;node:string;data:string;runtime:string;logs:string;plist:string;installedAt:string}
// T123: schema 2 is the self-contained Keyln.app: node and runtime live inside the sealed bundle, and the LaunchAgent points there.
export interface ManifestV2 extends Omit<ManifestV1,"schemaVersion"> {schemaVersion:2;app:string}
export type Manifest=ManifestV1|ManifestV2;
export function appBundlePaths(app:string) {return {app,node:join(app,"Contents/Helpers/node"),helper:join(app,"Contents/Helpers/keyln-helper"),runtime:join(app,"Contents/Resources/runtime")};}
export function servicePaths(data=defaultDataDir(),label=SERVICE_LABEL,agentDir=join(homedir(),"Library/LaunchAgents")):ServicePaths {
  if (!isAbsolute(data) || !isAbsolute(agentDir) || !/^local\.keyln\.host(?:\.test\.[a-f0-9]{8})?$/.test(label)) throw new Error("Invalid Keyln service paths or label.");
  return {label,data,runtime:join(data,"runtime"),logs:join(data,"logs"),plist:join(agentDir,label+".plist"),manifest:join(data,"service.json")};
}
export function present(path:string) {try {lstatSync(path);return true;} catch(error) {if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}}
export function owned(path:string,kind:"file"|"directory") {
  const stat=lstatSync(path);
  if(stat.uid!==process.getuid?.()||stat.isSymbolicLink()||(kind==="file"?!stat.isFile():!stat.isDirectory())||(stat.mode&0o022)!==0)throw new Error(`The Keyln ${kind} must be owned by this user and must not be a link or writable by others: ${path}`);
}
export function runtimeOwned(path:string,label:string) {
  owned(path,"directory");const marker=JSON.parse(readFileSync(join(path,".keyln-runtime.json"),"utf8"));
  if(marker.schemaVersion!==1||marker.label!==label||marker.uid!==process.getuid?.())throw new Error("An existing runtime is not owned by this Keyln installation. It was preserved.");
}
export function requireSupportedNode(version:string) {
  if(!/^v(?:24|26)\./.test(version))throw new Error("Use the supported Node 24 or 26 runtime.");
}
export function serviceNodePath(value:string):string {
  if(!isAbsolute(value))throw new Error("Use an absolute Node path.");
  let path:string;
  try{path=realpathSync(value);}catch(error){
    if((error as NodeJS.ErrnoException).code==="ENOENT")throw new Error(`The configured Node entry is missing: ${value}. Reinstall with --node /absolute/path/to/node (Homebrew: /opt/homebrew/bin/node).`);
    throw error;
  }
  const stat=lstatSync(path);
  if(!stat.isFile()||![0,process.getuid?.()].includes(stat.uid)||(stat.mode&0o022)!==0)throw new Error("Use a trusted Node binary owned by this user or root, not writable by others.");
  const version=execFileSync(path,["--version"],{encoding:"utf8",timeout:4000}).trim();
  requireSupportedNode(version);
  // Validate the current target, but keep the configured entry so Homebrew can update its link.
  return value;
}
export function appRuntimeOwned(path:string) {
  owned(path,"directory");const marker=JSON.parse(readFileSync(join(path,".keyln-runtime.json"),"utf8"));
  if(marker.schemaVersion!==2||marker.kind!=="keyln-app-runtime")throw new Error("The Keyln app runtime is not a recognized sealed runtime.");
}
// Accepts both layouts: schema 1 (runtime copied into the data folder, any trusted Node) and schema 2 (Keyln.app).
export function readService(paths:ServicePaths):Manifest {
  owned(paths.manifest,"file");const value=JSON.parse(readFileSync(paths.manifest,"utf8")) as Manifest;
  const mismatch=()=>new Error("The Keyln service manifest does not match this user and installation.");
  if(!value||typeof value!=="object"||value.label!==paths.label||value.uid!==process.getuid?.()||value.data!==paths.data||value.logs!==paths.logs||value.plist!==paths.plist||typeof value.node!=="string"||!isAbsolute(value.node))throw mismatch();
  if(value.schemaVersion===1){
    if(value.runtime!==paths.runtime)throw mismatch();
    runtimeOwned(paths.runtime,paths.label);
  }else if(value.schemaVersion===2){
    if(typeof value.app!=="string"||!isAbsolute(value.app)||basename(value.app)!=="Keyln.app")throw mismatch();
    const bundle=appBundlePaths(value.app);
    if(value.node!==bundle.node||value.runtime!==bundle.runtime)throw mismatch();
    appRuntimeOwned(bundle.runtime);
  }else throw mismatch();
  owned(paths.plist,"file");return value;
}
export function hostAlive(data:string):boolean {
  const path=join(data,"host.lock");if(!present(path))return false;
  owned(path,"file");const pid=Number(readFileSync(path,"utf8"));if(!Number.isSafeInteger(pid)||pid<=0)throw new Error("Inspect the invalid Host lock before managing startup.");
  try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")return false;throw error;}
}
export function servicePlist(paths:ServicePaths,node:string,runtime=paths.runtime):string {
  const xml=(value:string)=>value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(paths.label)}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(join(runtime,"dist/apps/host/service-runner.js"))}</string></array>
<key>WorkingDirectory</key><string>${xml(runtime)}</string>
<key>EnvironmentVariables</key><dict><key>KEYLN_DATA_DIR</key><string>${xml(paths.data)}</string><key>HOME</key><string>${xml(homedir())}</string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>LimitLoadToSessionType</key><string>Aqua</string><key>ProcessType</key><string>Interactive</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>15</integer><key>ExitTimeOut</key><integer>15</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`;
}
function copyTree(source:string,target:string) {
  const stat=lstatSync(source);if(stat.isSymbolicLink())throw new Error("Linked build entries cannot be installed.");
  if(stat.isDirectory()){mkdirSync(target,{mode:0o700,recursive:true});for(const name of readdirSync(source))copyTree(join(source,name),join(target,name));}
  else if(stat.isFile()){copyFileSync(source,target);chmodSync(target,0o600);}else throw new Error("Only ordinary build files can be installed.");
}
export interface ServiceInstall {
  manifest: ManifestV1;
  commit(): void;
  rollback(): void;
  finish(): void;
}
// Copy and validate everything while the old service can keep running. Only commit requires it to be stopped.
export function stageService(paths:ServicePaths,source:string,node=process.execPath):ServiceInstall {
  if(process.platform!=="darwin"||process.getuid?.()===0)throw new Error("Install as the signed-in Mac user, without sudo.");
  owned(paths.data,"directory");if(present(paths.logs))owned(paths.logs,"directory");
  const executable=serviceNodePath(node),previous=present(paths.manifest)?readService(paths):undefined;
  if(present(paths.runtime)&&!previous)throw new Error("An unrecognized runtime exists. It was preserved.");
  if(present(paths.runtime))runtimeOwned(paths.runtime,paths.label);
  if(present(paths.plist)&&!previous)throw new Error("An unrecognized LaunchAgent exists. It was preserved.");
  for(const file of ["host.json","tls/server.key","tls/server.pem","tls/rootCA.pem"])owned(join(paths.data,file),"file");
  privateDir(paths.data);privateDir(paths.logs);
  const agents=join(paths.plist,"..");mkdirSync(agents,{mode:0o700,recursive:true});owned(agents,"directory");
  const backup=paths.runtime+".previous";
  if(present(backup))runtimeOwned(backup,paths.label);
  const oldManifest=previous?readFileSync(paths.manifest):undefined,oldPlist=previous?readFileSync(paths.plist):undefined;
  const staged=mkdtempSync(join(paths.data,"runtime-stage-")),held=join(paths.data,"runtime-rollback-"+randomUUID());
  const candidate=paths.plist+"."+randomUUID()+".tmp";
  const manifest:ManifestV1={schemaVersion:1,label:paths.label,uid:process.getuid!(),node:executable,data:paths.data,runtime:paths.runtime,logs:paths.logs,plist:paths.plist,installedAt:new Date().toISOString()};
  const cleanup=()=>{rmSync(staged,{recursive:true,force:true});rmSync(candidate,{force:true});};
  try {
    mkdirSync(join(staged,"dist"),{mode:0o700});copyTree(join(source,"dist/apps"),join(staged,"dist/apps"));copyTree(join(source,"dist/packages"),join(staged,"dist/packages"));
    copyTree(join(source,"dist/keyln-helper"),join(staged,"dist/keyln-helper"));chmodSync(join(staged,"dist/keyln-helper"),0o700);
    copyTree(join(source,"node_modules/ws"),join(staged,"node_modules/ws"));atomicJSON(join(staged,"package.json"),{private:true,type:"module"});
    atomicJSON(join(staged,".keyln-runtime.json"),{schemaVersion:1,label:paths.label,uid:process.getuid?.()});
    execFileSync("/usr/bin/codesign",["--verify","--strict",join(staged,"dist/keyln-helper")],{stdio:"pipe",timeout:5000});
    for(const name of ["main.js","service-runner.js"])owned(join(staged,"dist/apps/host",name),"file");
    writeFileSync(join(staged,"agent.plist"),servicePlist(paths,executable),{mode:0o600});
    writeFileSync(candidate,servicePlist(paths,executable),{flag:"wx",mode:0o600});
    execFileSync("/usr/bin/plutil",["-lint",candidate],{stdio:"pipe",timeout:4000});
  }catch(error){try{cleanup();}catch(cleanupError){throw new Error(`Installation staging failed: ${String(error)}. Temporary files could not be removed: ${String(cleanupError)}`);}throw error;}
  let oldMoved=false,newMoved=false,plistWritten=false,manifestWritten=false,finished=false;
  return { manifest,
    commit() {
      if(finished||newMoved)throw new Error("This installation has already been committed.");
      if(hostAlive(paths.data))throw new Error("A Host is running. Stop it before installing; no process was terminated.");
      if(present(paths.runtime)){renameSync(paths.runtime,held);oldMoved=true;}
      renameSync(staged,paths.runtime);newMoved=true;
      renameSync(candidate,paths.plist);plistWritten=true;
      atomicJSON(paths.manifest,manifest);manifestWritten=true;
    },
    rollback() {
      if(finished)throw new Error("The installation has already finished.");
      const errors: string[]=[];
      const attempt=(work:()=>void)=>{try{work();}catch(error){errors.push(String(error));}};
      if(newMoved)attempt(()=>{runtimeOwned(paths.runtime,paths.label);renameSync(paths.runtime,staged);newMoved=false;});
      if(oldMoved)attempt(()=>{if(present(paths.runtime))throw new Error("The new runtime could not be moved aside; the previous runtime is preserved at "+held);renameSync(held,paths.runtime);oldMoved=false;});
      if(manifestWritten)attempt(()=>{if(oldManifest)atomicBytes(paths.manifest,oldManifest);else rmSync(paths.manifest);manifestWritten=false;});
      if(plistWritten)attempt(()=>{if(oldPlist)atomicBytes(paths.plist,oldPlist);else rmSync(paths.plist);plistWritten=false;});
      if(!errors.length)attempt(cleanup);
      if(errors.length)throw new Error("Installation rollback could not finish; preserve the remaining staging/rollback files. "+errors.join("; "));
    },
    finish() {
      if(finished||!newMoved||!manifestWritten)throw new Error("There is no committed installation to finish.");
      if(oldMoved){
        const retired=backup+".retired-"+randomUUID();
        const hadBackup=present(backup);
        if(hadBackup){runtimeOwned(backup,paths.label);renameSync(backup,retired);}
        try{renameSync(held,backup);oldMoved=false;}catch(error){if(hadBackup)renameSync(retired,backup);throw error;}
        if(hadBackup)try{rmSync(retired,{recursive:true});}catch{console.warn("Keyln updated; an older runtime was retained at "+retired);}
      }
      finished=true;
      try{cleanup();}catch{console.warn("Keyln updated; temporary installation files could not all be removed.");}
    },
  };
}
// Offline installation primitive retained for callers that already stopped their Host.
export function prepareService(paths:ServicePaths,source:string,node=process.execPath):Manifest {
  if(hostAlive(paths.data))throw new Error("A Host is running. Stop it before installing; no process was terminated.");
  const installation=stageService(paths,source,node);
  try{installation.commit();installation.finish();return installation.manifest;}
  catch(error){try{installation.rollback();}catch(rollbackError){throw new Error(`${String(error)}; ${String(rollbackError)}`);}throw error;}
}
const target=(paths:ServicePaths)=>`gui/${process.getuid!()}/${paths.label}`;
function launchctl(args:string[]) {return execFileSync("/bin/launchctl",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:15000});}
export function loadedService(paths:ServicePaths) {
  try{const output=launchctl(["print",target(paths)]);return {loaded:true,pid:Number(output.match(/^\s*pid = (\d+)$/m)?.[1])||null,state:output.match(/^\s*state = (.+)$/m)?.[1]??"unknown"};}
  catch{return {loaded:false,pid:null,state:"not loaded"};}
}
export interface ServiceStartupState { loaded: boolean; enabled: boolean; running: boolean }
export function serviceStartupState(paths:ServicePaths):ServiceStartupState {
  const job=loadedService(paths),disabled=launchctl(["print-disabled",`gui/${process.getuid!()}`]);
  const entry=disabled.split("\n").find(line=>line.includes(`"${paths.label}" =>`));
  return {loaded:job.loaded,running:job.pid!==null,enabled:!entry?.includes("=> true")};
}
export async function restoreServiceStartup(paths:ServicePaths,state:ServiceStartupState) {
  if(state.loaded)await startService(paths);
  launchctl([state.enabled?"enable":"disable",target(paths)]);
}
export async function startService(paths:ServicePaths) {
  const manifest=readService(paths);serviceNodePath(manifest.node);
  if(loadedService(paths).loaded){launchctl(["enable",target(paths)]);launchctl(["kickstart",target(paths)]);return;}
  if(hostAlive(paths.data))throw new Error("A manual or different Host is running. Stop that Host first; no process was terminated.");
  launchctl(["enable",target(paths)]);launchctl(["bootstrap",`gui/${process.getuid!()}`,paths.plist]);
}
export async function stopService(paths:ServicePaths) {
  readService(paths);launchctl(["disable",target(paths)]);
  if(loadedService(paths).loaded)launchctl(["bootout",target(paths)]);
  const deadline=Date.now()+16000;while(hostAlive(paths.data)&&Date.now()<deadline)await delay(100);
  if(hostAlive(paths.data))throw new Error("The Host has not stopped. No unrelated process was signalled; inspect service status.");
}
export async function uninstallService(paths:ServicePaths) {
  const app=readService(paths).schemaVersion===2;
  await stopService(paths);const backup=paths.runtime+".previous";
  // An app installation keeps its runtime inside Keyln.app, which is left alone; only an earlier data-folder runtime of ours is removed so the legacy installer can run again.
  if(present(backup)){runtimeOwned(backup,paths.label);rmSync(backup,{recursive:true});}
  if(!app||present(paths.runtime)){runtimeOwned(paths.runtime,paths.label);rmSync(paths.runtime,{recursive:true});}
  rmSync(paths.plist);rmSync(paths.manifest);
  // Data, scripts, logs, certificates and Keyln.app are deliberately retained.
}
export function certificateStatus(data:string) {
  const settings=JSON.parse(readFileSync(join(data,"host.json"),"utf8")),certificate=new X509Certificate(readFileSync(join(data,"tls/server.pem"))),ca=new X509Certificate(readFileSync(join(data,"tls/rootCA.pem")));
  const daysRemaining=Math.floor((Date.parse(certificate.validTo)-Date.now())/86_400_000);
  return {origin:settings.origin,expiresAt:certificate.validTo,expired:Date.parse(certificate.validTo)<=Date.now(),daysRemaining,renewSoon:daysRemaining<30,
    caExpiresAt:ca.validTo,caExpired:Date.parse(ca.validTo)<=Date.now(),signedByLocalCA:certificate.verify(ca.publicKey),matchesAddress:!!certificate.checkIP(settings.address),
    addressAssigned:Object.values(networkInterfaces()).flat().some(item=>item?.address===settings.address)};
}
