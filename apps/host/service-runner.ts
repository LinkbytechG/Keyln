import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { defaultDataDir } from "./store.js";
import { rotatingLog, lineSink } from "./logging.js";
import { requireSupportedNode } from "./service.js";

const dir = defaultDataDir(), writeLog = rotatingLog(join(dir,"logs"));
try{requireSupportedNode(process.version);}catch(error){
  writeLog("service",`Keyln could not start with ${process.version}: ${(error as Error).message}`);process.exit(1);
}
let stopping = false;
const child = spawn(process.execPath,[fileURLToPath(new URL("./main.js",import.meta.url))],{
  env:{PATH:"/usr/bin:/bin:/usr/sbin:/sbin",HOME:process.env.HOME,LANG:process.env.LANG||"en_US.UTF-8",KEYLN_DATA_DIR:dir,KEYLN_BACKGROUND:"1"},stdio:["ignore","pipe","pipe"],
});
function log(stream:"stdout"|"stderr"|"service",message:string) {try{writeLog(stream,message);}catch{process.exitCode=1;child.kill("SIGTERM");}}
log("service", `Host child started; uid ${process.getuid?.()}, pid ${child.pid}.`);
child.stdout.on("data",lineSink(line=>log("stdout",line))); child.stderr.on("data",lineSink(line=>log("stderr",line)));
child.once("error",()=>{log("service","The Host child could not start.");process.exitCode=1;});
child.once("close",(code,signal)=>{log("service",`Host child exited; code ${code}, signal ${signal??"none"}.`);process.exitCode=stopping?0:1;});
for (const signal of ["SIGTERM","SIGINT"] as const) process.once(signal,()=>{stopping=true;if(child.exitCode===null&&child.signalCode===null)child.kill("SIGTERM");});
