import { Fault, MAX_SHELL_OUTPUT, parseShellOutput, parseWorkflowResult, type BasicAction, type Config, type StepExecution, type WorkflowResult, type WindowAction } from "../../packages/contracts/index.js";
import type { ActionResult } from "./scheduler.js";

type RunBasic=(action:BasicAction,signal:AbortSignal,targetAppId?:string|WindowAction)=>Promise<ActionResult>;
const failed=(code:string,message:string,unknown=false):ActionResult=>({ok:false,code,message,...(unknown?{unknown:true}:{})});
export class WorkflowEngine {
  constructor(private runBasic:RunBasic){}
  async run(id:string,config:Config,signal:AbortSignal,progress:(value:WorkflowResult)=>void=()=>{}):Promise<ActionResult>{
    const workflow=config.workflows?.find(item=>item.id===id);
    if(!workflow)return failed("WORKFLOW_UNAVAILABLE","This workflow no longer exists.");
    const result:WorkflowResult={id,totalSteps:workflow.steps.length,steps:[]};
    let targetAppId:string|WindowAction|undefined,remainingOutput=MAX_SHELL_OUTPUT,wholeTimedOut=false;
    const whole=new AbortController(),abort=()=>whole.abort();signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
    const timer=setTimeout(()=>{wholeTimedOut=true;whole.abort();},workflow.timeoutMs);
    const publish=()=>progress(structuredClone(result));
    try{
      for(const step of workflow.steps){
        if(whole.signal.aborted)return {...failed(wholeTimedOut?"WORKFLOW_TIMEOUT":"WORKFLOW_INTERRUPTED","Workflow stopped. Later steps were not run. Check the Mac before retrying.",true),workflow:result};
        const running:StepExecution={id:step.id,actionType:step.action.type,status:"running",startedAt:Date.now(),message:`Running step ${result.steps.length+1} of ${result.totalSteps}…`};
        result.steps.push(running);publish();
        const controller=new AbortController(),cancel=()=>controller.abort();whole.signal.addEventListener("abort",cancel,{once:true});
        if(whole.signal.aborted)cancel();
        let timedOut=false,settled=false,cleanupTimer:ReturnType<typeof setTimeout>|undefined;
        const stepTimer=setTimeout(()=>{timedOut=true;controller.abort();},step.timeoutMs);
        let task:Promise<ActionResult>;
        try{task=controller.signal.aborted?Promise.resolve(failed("WORKFLOW_INTERRUPTED","Workflow interrupted before this step started.",true)):Promise.resolve(this.runBasic(step.action,controller.signal,step.action.type==="keyboard.shortcut"?targetAppId:undefined));}
        catch{task=Promise.reject(new Error("Adapter failed."));}
        const observed=task.then(value=>{settled=true;return value;},()=>{settled=true;return failed("STEP_UNKNOWN","The step stopped without a reliable result.",true);});
        let abortWait:()=>void=()=>{};
        const interrupted=new Promise<ActionResult>(resolve=>{
          abortWait=()=>{cleanupTimer=setTimeout(()=>resolve({...failed("STEP_UNKNOWN","Step cleanup could not be confirmed. Restart Host before running another action.",true),halt:true}),1500);};
          controller.signal.addEventListener("abort",abortWait,{once:true});if(controller.signal.aborted)abortWait();
        });
        let outcome=await Promise.race([observed,interrupted]);
        clearTimeout(stepTimer);clearTimeout(cleanupTimer);controller.signal.removeEventListener("abort",abortWait);whole.signal.removeEventListener("abort",cancel);
        if(!settled)outcome={...outcome,halt:true};
        if(controller.signal.aborted)outcome={...outcome,ok:false,unknown:true,code:wholeTimedOut?"WORKFLOW_TIMEOUT":timedOut?"STEP_TIMEOUT":"WORKFLOW_INTERRUPTED",
          message:"The step timed out or was interrupted. Later steps were not run; partial effects may remain."};
        try{
          if(typeof outcome.ok!=="boolean"||typeof outcome.message!=="string"||!outcome.message||outcome.unknown&&outcome.ok)throw new Fault("INVALID_INPUT","Invalid step result.");
          running.status=outcome.unknown?"unknown":outcome.ok?"succeeded":"failed";running.finishedAt=Date.now();running.message=outcome.message.slice(0,300);
          if(outcome.code)running.code=outcome.code;
          if(outcome.output){
            if(step.action.type!=="shell.run")throw new Fault("INVALID_INPUT","Unexpected step output.");
            const output=parseShellOutput(outcome.output),stdout=output.stdout.slice(0,remainingOutput);remainingOutput-=stdout.length;
            const stderr=output.stderr.slice(0,remainingOutput);remainingOutput-=stderr.length;
            running.output={...output,stdout,stderr,truncated:output.truncated||stdout!==output.stdout||stderr!==output.stderr};
          }
          parseWorkflowResult(result);publish();
        }catch{
          running.status="unknown";running.finishedAt=Date.now();running.message="The step returned an unsupported result. Later steps were not run.";delete running.output;delete running.code;
          publish();return {...failed("STEP_UNKNOWN",running.message,true),workflow:result,halt:outcome.halt};
        }
        if(!outcome.ok)return {...outcome,message:`Step ${result.steps.length} of ${result.totalSteps}: ${running.message}`.slice(0,300),output:undefined,workflow:result};
        if(step.action.type==="app.open")targetAppId=step.action.appId;
        if(step.action.type==="window.activate")targetAppId=structuredClone(step.action);
      }
      return {ok:true,message:`All ${result.totalSteps} workflow steps completed.`,workflow:result};
    }finally{clearTimeout(timer);signal.removeEventListener("abort",abort);}
  }
}
