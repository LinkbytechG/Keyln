import { randomUUID } from "node:crypto";
import { Fault, findComponent, needsConfirmation, type Config, type Trigger } from "../../packages/contracts/index.js";

export class Confirmations {
  private entries=new Map<string,{device:string;input:Trigger;expiresAt:number}>();
  constructor(private now=Date.now){}
  issue(device:string,input:Trigger,config:Config){
    for(const [id,entry]of this.entries)if(entry.expiresAt<=this.now()||entry.device===device)this.entries.delete(id);
    if(input.confirmation)throw new Fault("INVALID_INPUT","Request a fresh confirmation without a token.");
    if(input.revision!==config.revision)throw new Fault("CONFIG_CONFLICT","The layout changed. Review it before confirming.",409);
    const button=findComponent(config,input.componentId);
    if(!button)throw new Fault("NOT_CONFIGURED","This button is not configured.");
    const action=button.action;
    if(!action)throw new Fault("NOT_CONFIGURED","This button is not configured.");
    if(!needsConfirmation(config,button))throw new Fault("INVALID_INPUT","This action does not require confirmation.");
    if(this.entries.size>=128)throw new Fault("CAPACITY","Too many pending confirmations. Wait and try again.",429);
    const id=randomUUID(),expiresAt=this.now()+30_000;
    this.entries.set(id,{device,input:{...input},expiresAt});
    const workflow=action.type==="workflow.run"?config.workflows?.find(item=>item.id===action.workflowId):undefined;
    return {id,expiresAt,expiresInMs:30_000,label:button.label,summary:workflow?`${workflow.name} · ${workflow.steps.length} steps. Earlier effects are not rolled back if a later step fails.`:"Run this saved action once on the Mac. Its effects may not be reversible."};
  }
  consume(device:string,input:Trigger){
    const entry=input.confirmation?this.entries.get(input.confirmation):undefined;
    if(!entry||entry.device!==device||entry.expiresAt<=this.now()||entry.input.requestId!==input.requestId||entry.input.componentId!==input.componentId||entry.input.revision!==input.revision)
      throw new Fault("CONFIRMATION_REQUIRED","Confirmation expired or does not match this saved action. Review and confirm again.",409);
    this.entries.delete(input.confirmation!);
  }
  clear(){this.entries.clear();}
  cancel(device:string){for(const [id,entry]of this.entries)if(entry.device===device)this.entries.delete(id);}
}
