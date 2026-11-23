import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SERVICE_LABEL, servicePaths, serviceNodePath, stageService, readService, startService, stopService, uninstallService, loadedService, certificateStatus, serviceStartupState, restoreServiceStartup,
  type ServicePaths, type ServiceStartupState } from "./service.js";
import { requestLocalManagement } from "./local-management.js";
import { setTimeout as delay } from "node:timers/promises";

interface InstallLifecycle {
  state(paths:ServicePaths): ServiceStartupState;
  start(paths:ServicePaths): Promise<void>;
  stop(paths:ServicePaths): Promise<void>;
  ready(data:string): Promise<void>;
  restore(paths:ServicePaths,state:ServiceStartupState): Promise<void>;
}
const lifecycle:InstallLifecycle={state:serviceStartupState,start:startService,stop:stopService,ready,restore:restoreServiceStartup};
export async function installService(paths:ServicePaths,source:string,node:string,control:InstallLifecycle=lifecycle) {
  const previous=existsSync(paths.manifest),state=control.state(paths);
  if(!previous&&state.loaded)throw new Error("An unrecognized Keyln login job is loaded. It was preserved.");
  const installation=stageService(paths,source,node);
  let stopAttempted=false,startAttempted=false;
  try {
    if(previous){stopAttempted=true;await control.stop(paths);}
    installation.commit();
    startAttempted=true;await control.start(paths);await control.ready(paths.data);
    installation.finish();
  }catch(error){
    // Never exchange files underneath a new job that could still be running.
    if(startAttempted){try{await control.stop(paths);}catch(stopError){throw new Error(`Installation failed: ${String(error)}. The new job could not be stopped; rollback files were preserved. ${String(stopError)}`);}}
    try{
      installation.rollback();
      if(stopAttempted||startAttempted){await control.restore(paths,state);if(state.running)await control.ready(paths.data);}
    }catch(restoreError){throw new Error(`Installation failed: ${String(error)}. Automatic recovery could not finish: ${String(restoreError)}`);}
    throw new Error(`Installation failed; previous files and startup state were preserved or restored. ${String(error)}`);
  }
}

export function serviceStatus(paths:ServicePaths) {
  const installed=existsSync(paths.manifest),manifest=installed?readService(paths):undefined;
  return {installed,...loadedService(paths),uid:process.getuid?.(),runtime:manifest?.runtime,node:manifest?.node,app:manifest?.schemaVersion===2?manifest.app:undefined,layout:manifest?(manifest.schemaVersion===2?"app":"legacy"):undefined,nodeAvailable:manifest?existsSync(manifest.node):undefined,logs:paths.logs,certificate:certificateStatus(paths.data)};
}
export async function serviceCommand(args:string[],label=SERVICE_LABEL) {
  if(process.platform!=="darwin"||process.getuid?.()===0)throw new Error("Use the signed-in Mac user, without sudo.");
  const [command,...rest]=args,paths=servicePaths(undefined,label);
  if(command==="install") {
    if(rest.length!==0&&(rest.length!==2||rest[0]!=="--node"||!rest[1]))throw new Error("Usage: npm run service:install -- [--node /absolute/path/to/node]");
    const previous=existsSync(paths.manifest)?readService(paths):undefined;
    // An app installation never lends its bundled Node to the legacy path; falling back to the Homebrew-era Node needs --node or the current one.
    const node=serviceNodePath(rest[1]??(previous?.schemaVersion===1?previous.node:undefined)??process.execPath);
    await installService(paths,fileURLToPath(new URL("../../../",import.meta.url)),node);
    console.log("Keyln login startup installed for this user. Runtime: "+paths.runtime+"\nLogs: "+paths.logs+"\nRun npm run service:admin for a private management code; service:doctor checks the actual background launch context.");return;
  }
  if(rest.length)throw new Error("This service command does not take arguments.");
  if(command==="admin"||command==="doctor") {
    const result=await requestLocalManagement(paths.data,command);
    if(command==="admin")console.log(`Mac management: ${result.origin}/admin\nMac management login code: ${result.code} (2 minutes, 5 attempts; use on this Mac only).`);
    else console.log(JSON.stringify(result,null,2));return;
  }
  if(command==="status") {
    console.log(JSON.stringify(serviceStatus(paths),null,2));return;
  }
  if(command==="start"){await startService(paths);await ready(paths.data);console.log("Keyln user service is running.");return;}
  if(command==="stop"){await stopService(paths);console.log("Keyln user service stopped and disabled until service:start. Saved data retained.");return;}
  if(command==="restart"){await stopService(paths);await startService(paths);await ready(paths.data);console.log("Keyln user service restarted. Previous actions were not resumed.");return;}
  if(command==="uninstall"){await uninstallService(paths);console.log("Keyln login startup removed (runtime too, unless it lives inside Keyln.app). Data, scripts, certificates, logs and Keyln.app retained.");return;}
  throw new Error("Use install, start, stop, restart, status, admin, doctor or uninstall.");
}
export async function ready(data:string) {
  const end=Date.now()+12000;
  while(Date.now()<end){try{await requestLocalManagement(data,"doctor");return;}catch{await delay(200);}}
  throw new Error("The service did not become ready. Inspect service:status, private logs and macOS Login Items; no action was retried.");
}
