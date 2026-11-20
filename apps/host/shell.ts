import { homedir, userInfo } from "node:os";
import { Fault, MAX_SHELL_OUTPUT, type ShellAction } from "../../packages/contracts/index.js";
import type { ActionResult, Adapter } from "./scheduler.js";
import { ScriptRegistry } from "./scripts.js";
import { nativeAdapter } from "./native.js";
import { managedProcess, plainOutput } from "./process.js";
import { ShortcutsAdapter, ShortcutsCatalog } from "./shortcuts.js";
import { WorkflowEngine } from "./workflow.js";

export class ShellAdapter {
  constructor(private scripts: ScriptRegistry) {}
  async run(action: ShellAction, signal: AbortSignal): Promise<ActionResult> {
    if (process.platform === "win32" || process.getuid?.() === 0)
      return { ok: false, code: "SHELL_USER_REQUIRED", message: "Run the Mac Host as its normal signed-in user, without sudo." };
    if (signal.aborted) return { ok: false, unknown: true, code: "SHELL_INTERRUPTED", message: "The Host stopped. No new script was started." };
    let plan: ReturnType<ScriptRegistry["prepare"]>;
    try { plan = this.scripts.prepare(action); }
    catch (error) { return { ok: false, code: error instanceof Fault ? error.code : "SCRIPT_UNAVAILABLE",
      message: error instanceof Fault ? error.message : "Review this script on the Mac before running it." }; }
    const user = userInfo().username;
    const flags = plan.interpreter === "/bin/zsh" ? ["-f", "-s", "--"] : plan.interpreter === "/bin/bash" ? ["--noprofile", "--norc", "-s", "--"] : ["-s", "--"];
    const result = await managedProcess(plan.interpreter,[...flags,...plan.args],{signal,timeoutMs:plan.timeoutMs,outputLimit:MAX_SHELL_OUTPUT,cwd:plan.cwd,input:plan.bytes,
      env:{PATH:"/usr/bin:/bin:/usr/sbin:/sbin",HOME:homedir(),USER:user,LOGNAME:user,LANG:"en_US.UTF-8"}});
    const output={exitCode:result.exitCode,signal:result.signal,stdout:plainOutput(result.stdout),stderr:plainOutput(result.stderr),truncated:result.truncated};
    if(result.reason === "start")return {ok:false,code:"SHELL_START_FAILED",message:"The approved script could not start on the Mac.",output};
    if(result.reason)return {ok:false,unknown:true,code:result.reason === "timeout" ? "SHELL_TIMEOUT" : "SHELL_INTERRUPTED",
      message:result.reason === "timeout" ? "The script timed out. Managed processes were stopped; partial effects may remain. Check the Mac before retrying." : "Script execution was interrupted. Check the Mac before retrying.",output};
    return {ok:result.exitCode===0,...(result.exitCode===0?{}:{code:"SHELL_EXIT"}),
      message:result.exitCode===0?"Script completed with exit code 0.":`The script ended with ${result.exitCode===null?result.signal||"no exit code":`exit code ${result.exitCode}`}.`,output};
  }
}
export function actionAdapter(scripts: ScriptRegistry, catalog:Pick<ShortcutsCatalog,"state"|"refresh"> = new ShortcutsCatalog()): Adapter {
  const shell = new ShellAdapter(scripts), shortcuts = new ShortcutsAdapter(catalog);
  const workflow = new WorkflowEngine((action,signal,targetAppId)=>action.type==="shell.run"?shell.run(action,signal):action.type==="shortcuts.run"?shortcuts.run(action,signal):
    action.type==="keyboard.shortcut"&&targetAppId?nativeAdapter.runTargeted(action,targetAppId,signal):nativeAdapter.run(action,signal));
  return {timeoutMs:(action,config)=>action.type==="workflow.run"?(config?.workflows?.find(item=>item.id===action.workflowId)?.timeoutMs??1000)+3000:
      action.type==="shell.run"?65_000:action.type==="shortcuts.run"?action.timeoutMs+7_000:10_000,
    run:(action,signal,context)=>action.type==="workflow.run"?workflow.run(action.workflowId,context!.config,signal,context?.progress):
      action.type==="shell.run"?shell.run(action,signal):action.type==="shortcuts.run"?shortcuts.run(action,signal):nativeAdapter.run(action,signal)};
}
