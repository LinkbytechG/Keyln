import { Fault, label, shortcutId, type ShortcutInfo, type ShortcutsAction } from "../../packages/contracts/index.js";
import { managedProcess } from "./process.js";
import type { ActionResult } from "./scheduler.js";

export function parseShortcutList(text:string):ShortcutInfo[]{
  const lines=text.replace(/\r\n/g,"\n").split("\n").filter(line=>line.length>0);
  if(lines.length>1024)throw new Fault("SHORTCUTS_CATALOG","At most 1024 Mac shortcuts can be listed.");
  const seen=new Set<string>();
  return lines.map(line=>{
    const match=/^(.*) \(([0-9A-F-]{36})\)$/i.exec(line);
    if(!match)throw new Fault("SHORTCUTS_CATALOG","The Mac shortcut list could not be read safely.");
    const id=shortcutId(match[2]);if(seen.has(id))throw new Fault("SHORTCUTS_CATALOG","The Mac shortcut list contains duplicate identifiers.");seen.add(id);
    return {id,name:label(match[1],200)};
  });
}
export class ShortcutsCatalog {
  private shortcuts:ShortcutInfo[]=[];
  private error="";
  private refreshing?:Promise<void>;
  constructor(private runProcess=managedProcess){}
  state(){return {shortcuts:structuredClone(this.shortcuts),shortcutsError:this.error,shortcutsRefreshing:!!this.refreshing};}
  refresh():Promise<void>{
    if(this.refreshing)return this.refreshing;
    this.refreshing=this.scan().finally(()=>{this.refreshing=undefined;});return this.refreshing;
  }
  private async scan(){
    try{
      const result=await this.runProcess("/usr/bin/shortcuts",["list","--show-identifiers"],{signal:new AbortController().signal,timeoutMs:5000,outputLimit:262144});
      if(result.reason||result.exitCode!==0||result.truncated)throw Error("Unavailable");
      this.shortcuts=parseShortcutList(result.stdout.toString("utf8"));this.error="";
    }catch{
      this.shortcuts=[];this.error="Mac Shortcuts is unavailable. Open Shortcuts on the Mac, then refresh its list.";
    }
  }
}
export class ShortcutsAdapter {
  constructor(private catalog:Pick<ShortcutsCatalog,"state"|"refresh">,private runProcess=managedProcess){}
  async run(action:ShortcutsAction,signal:AbortSignal):Promise<ActionResult>{
    if(process.platform!=="darwin"||process.getuid?.()===0)return {ok:false,code:"SHORTCUTS_USER_REQUIRED",message:"Run Shortcuts as the normal signed-in Mac user."};
    if(signal.aborted)return {ok:false,unknown:true,code:"SHORTCUTS_INTERRUPTED",message:"The Host stopped before starting the shortcut."};
    let interrupted:(()=>void)|undefined;
    try{await Promise.race([this.catalog.refresh(),new Promise<void>(resolve=>{interrupted=()=>resolve();signal.addEventListener("abort",interrupted,{once:true});})]);}
    finally{if(interrupted)signal.removeEventListener("abort",interrupted);}
    if(signal.aborted)return {ok:false,unknown:true,code:"SHORTCUTS_INTERRUPTED",message:"The Host stopped before starting the shortcut."};
    const state=this.catalog.state();
    if(state.shortcutsError)return {ok:false,code:"SHORTCUTS_UNAVAILABLE",message:state.shortcutsError};
    if(!state.shortcuts.some(item=>item.id===action.shortcutId))return {ok:false,code:"SHORTCUT_UNAVAILABLE",message:"This shortcut no longer exists on the Mac. Refresh the list and choose another."};
    const result=await this.runProcess("/usr/bin/shortcuts",["run",action.shortcutId],{signal,timeoutMs:action.timeoutMs,outputLimit:4096});
    if(result.reason==="start")return {ok:false,code:"SHORTCUTS_START_FAILED",message:"The Mac shortcut could not start."};
    if(result.reason)return {ok:false,unknown:true,code:result.reason==="timeout"?"SHORTCUTS_TIMEOUT":"SHORTCUTS_INTERRUPTED",
      message:"The shortcut did not finish before the wait ended. It may still be running or waiting for input on the Mac. Check Shortcuts before trying again."};
    return result.exitCode===0?{ok:true,message:"Mac Shortcuts finished with exit code 0."}:{ok:false,code:"SHORTCUTS_FAILED",message:"The shortcut ended with an error. Check its actions and any required interaction in Mac Shortcuts."};
  }
}
