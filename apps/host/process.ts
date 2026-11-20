import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number | null; signal: string | null; stdout: Buffer; stderr: Buffer; truncated: boolean;
  reason?: "timeout" | "interrupted" | "start";
}
export const plainOutput = (bytes: Buffer) => bytes.toString("utf8").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
// Callers choose an absolute executable and independent argv. No shell: true or inherited stdio.
export function managedProcess(file: string, args: string[], options: {
  signal: AbortSignal; timeoutMs: number; outputLimit: number; cwd?: string; env?: NodeJS.ProcessEnv; input?: Buffer;
}): Promise<ProcessResult> {
  if (options.signal.aborted) return Promise.resolve({exitCode:null,signal:null,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),truncated:false,reason:"interrupted"});
  return new Promise(resolve => {
    const child = spawn(file, args, {detached:true,cwd:options.cwd,env:options.env,stdio:["pipe","pipe","pipe"]});
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let retained=0,truncated=false,closed=false,cleaned=false,done=false,cleaning=false;
    let exitCode:number|null=null,exitSignal:string|null=null,reason:ProcessResult["reason"];
    let killTimer:ReturnType<typeof setTimeout>|undefined,fallback:ReturnType<typeof setTimeout>|undefined;
    const timer=setTimeout(()=>{reason="timeout";cleanup();},options.timeoutMs);
    function collect(destination:Buffer[],chunk:Buffer){
      const keep=Math.min(options.outputLimit-retained,chunk.length);
      if(keep){destination.push(Buffer.from(chunk.subarray(0,keep)));retained+=keep;}
      if(chunk.length>keep)truncated=true;
    }
    function terminate(signal:NodeJS.Signals){
      if(!child.pid)return;
      try{process.kill(-child.pid,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")reason="interrupted";}
    }
    function finish(){
      if(done||!cleaned||!closed)return;
      done=true;clearTimeout(timer);clearTimeout(killTimer);clearTimeout(fallback);options.signal.removeEventListener("abort",abort);
      resolve({exitCode,signal:exitSignal,stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr),truncated,...(reason?{reason}:{})});
    }
    function cleanup(){
      if(cleaning)return;cleaning=true;terminate("SIGTERM");
      killTimer=setTimeout(()=>{
        terminate("SIGKILL");cleaned=true;finish();
        if(!closed)fallback=setTimeout(()=>{reason??="interrupted";child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();closed=true;finish();},800);
      },200);
    }
    function abort(){reason??="interrupted";cleanup();}
    child.stdout.on("data",chunk=>collect(stdout,chunk));child.stderr.on("data",chunk=>collect(stderr,chunk));
    child.stdin.on("error",()=>{/* Closed child stdin is resolved by close/error. */});
    child.once("error",()=>{clearTimeout(timer);reason="start";cleanup();});
    child.once("exit",(code,signal)=>{clearTimeout(timer);exitCode=code;exitSignal=signal;cleanup();});
    child.once("close",()=>{closed=true;cleanup();finish();});
    options.signal.addEventListener("abort",abort,{once:true});if(options.signal.aborted)abort();
    child.stdin.end(options.input);
  });
}
