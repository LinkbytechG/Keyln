import { allComponents, MAX_WORKFLOWS, MAX_WORKFLOW_STEPS, keyboardKeys, keyLabel, modifiers, parseWorkflows, validateShellArguments,
  type AppInfo,type BasicAction,type Component,type Config,type ScriptInfo,type ShortcutInfo,type Workflow,type WorkflowStep,type WindowInfo } from "../../packages/contracts/index.js";
import { createAppPicker, type AppContext } from "./app-picker.js";
import { createWindowPicker } from "./window-picker.js";
import { enhanceSelect } from "./select-menu.js";

const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
interface Options {config:()=>Config|undefined;selected:()=>Component|undefined;apps:()=>AppInfo[];appContext?:()=>AppContext;scripts:()=>ScriptInfo[];shortcuts:()=>ShortcutInfo[];windows:(id:string)=>Promise<WindowInfo[]>;changed:()=>void}
export function createWorkflowEditor(options:Options){
  const selected=()=>{const action=options.selected()?.action;return action?.type==="workflow.run"?options.config()?.workflows?.find(item=>item.id===action.workflowId):undefined;};
  function change(){el("workflow-delete-confirm").hidden=true;options.changed();}
  function selector(){
    const action=options.selected()?.action,select=el<HTMLSelectElement>("workflow-select");
    select.replaceChildren(new Option("Choose a workflow",""),...(options.config()?.workflows??[]).map(item=>new Option(item.name,item.id)));
    select.value=action?.type==="workflow.run"?action.workflowId:"";
  }
  function button(caption:string,action:()=>void){const node=document.createElement("button");node.type="button";node.className="quiet";node.textContent=caption;node.onclick=action;return node;}
  function field<T extends HTMLInputElement|HTMLSelectElement>(parent:HTMLElement,caption:string,node:T,id:string):T{
    const label=document.createElement("label");label.textContent=caption;node.id=id;label.setAttribute("for",id);parent.append(label,node);return node;
  }
  function input(parent:HTMLElement,caption:string,value:string,id:string,onChange:(value:string)=>void,number=false){
    const node=document.createElement("input");node.value=value;node.type=number?"number":"text";if(number){node.min="0.1";node.max="60";node.step="0.1";}
    node.addEventListener("input",()=>{onChange(node.value);change();});return field(parent,caption,node,id);
  }
  function select(parent:HTMLElement,caption:string,choices:[string,string][],value:string,id:string,onChange:(value:string)=>void){
    const node=document.createElement("select");node.replaceChildren(...choices.map(([label,value])=>new Option(label,value)));node.value=value;
    node.addEventListener("change",()=>{onChange(node.value);change();});const placed=field(parent,caption,node,id);enhanceSelect(placed);return placed;
  }
  function check(parent:HTMLElement,caption:string,checked:boolean,onChange:(value:boolean)=>void){
    const label=document.createElement("label"),node=document.createElement("input"),text=document.createElement("span");label.className="workflow-check";node.type="checkbox";node.checked=checked;text.textContent=caption;
    node.addEventListener("change",()=>{onChange(node.checked);change();});label.append(node,text);parent.append(label);
  }
  // The label and the empty host the App picker fills with its field button (id `${prefix}-app`).
  function appHost(parent:HTMLElement,prefix:string){
    const label=document.createElement("label"),host=document.createElement("div");label.textContent="Mac application";label.setAttribute("for",prefix+"-app");parent.append(label,host);return host;
  }
  function actionFields(parent:HTMLElement,step:WorkflowStep){
    const action=step.action,prefix=`wf-${step.id}`;
    if(action.type==="window.activate"){
      const host=appHost(parent,prefix),fields=document.createElement("div");parent.append(fields);
      const picker=createAppPicker(host,prefix+"-app",()=>{windowPicker.appChanged();action.appId=picker.value;action.title="";delete action.path;change();},options.appContext);picker.set(options.apps(),action.appId);
      const windowPicker=createWindowPicker(fields,prefix+"-window",{appId:()=>picker.value,load:options.windows,changed:()=>{action.title=windowPicker.title;action.match=windowPicker.match;if(windowPicker.path)action.path=windowPicker.path;else delete action.path;change();}});
      windowPicker.set(action);
    }else if(action.type==="app.open"){
      const host=appHost(parent,prefix);
      const picker=createAppPicker(host,prefix+"-app",()=>{action.appId=picker.value;change();},options.appContext);picker.set(options.apps(),action.appId);
    }else if(action.type==="keyboard.shortcut"){
      select(parent,"Key",keyboardKeys.map(key=>[keyLabel(key),key]),action.key,prefix+"-key",value=>{action.key=value;});
      const group=document.createElement("div");group.className="workflow-modifiers";
      for(const modifier of modifiers)check(group,modifier,action.modifiers.includes(modifier),checked=>{action.modifiers=modifiers.filter(item=>item===modifier?checked:action.modifiers.includes(item));});parent.append(group);
    }else if(action.type==="shell.run"){
      const scripts=options.scripts(),script=scripts.find(item=>item.id===action.scriptId&&item.version===action.version),missing=!!action.scriptId&&!script;
      select(parent,"Mac-approved script",[["Choose an approved script",""],...scripts.map(item=>[item.name,item.id] as [string,string]),...(missing?[["Unavailable version — keep binding","__unavailable"] as [string,string]]:[])],missing?"__unavailable":action.scriptId,prefix+"-script",value=>{
        const selected=scripts.find(item=>item.id===value);if(!selected)return;
        step.action={type:"shell.run",scriptId:selected.id,version:selected.version,args:selected.parameters.map(()=>"")};reloadSteps();
      });
      for(const [index,rule]of (script?.parameters??[]).entries()){
        if(rule.kind==="choice")select(parent,rule.name,[["Choose a value",""],...rule.choices.map(value=>[value,value] as [string,string])],action.args[index]??"",prefix+`-arg-${index}`,value=>{action.args[index]=value;});
        else{const node=input(parent,rule.name,action.args[index]??"",prefix+`-arg-${index}`,value=>{action.args[index]=value;},rule.kind==="integer");if(rule.kind==="text")node.maxLength=rule.maxLength;else{node.min=String(rule.min);node.max=String(rule.max);node.step="1";}}
      }
    }else{
      const shortcuts=options.shortcuts(),missing=!!action.shortcutId&&!shortcuts.some(item=>item.id===action.shortcutId);
      select(parent,"Mac shortcut",[["Choose a Mac shortcut",""],...shortcuts.map(item=>[`${item.name} · ${item.id.slice(0,8)}`,item.id] as [string,string]),...(missing?[["Unavailable shortcut — keep binding",action.shortcutId] as [string,string]]:[])],action.shortcutId,prefix+"-shortcut",value=>{action.shortcutId=value;});
      input(parent,"Shortcut wait limit (seconds)",String(action.timeoutMs/1000),prefix+"-shortcut-timeout",value=>{action.timeoutMs=Math.round(Number(value)*1000);},true);
    }
  }
  function reloadSteps(){
    const workflow=selected(),container=el("workflow-steps");container.replaceChildren();if(!workflow)return;
    for(const [index,step]of workflow.steps.entries()){
      const card=document.createElement("section"),heading=document.createElement("h4"),actions=document.createElement("div");card.className="workflow-step";card.dataset.stepId=step.id;heading.textContent=`Step ${index+1}`;card.append(heading);
      const choices:[string,string][]=[["Open app","app.open"],["Activate window","window.activate"],["Keyboard shortcut","keyboard.shortcut"],["Approved Shell script","shell.run"],["Mac shortcut","shortcuts.run"]];
      select(card,"Action",choices,step.action.type,`wf-${step.id}-type`,type=>{
        const defaults:Record<string,BasicAction>={"app.open":{type:"app.open",appId:""},"window.activate":{type:"window.activate",appId:"",title:"",match:"exact"},"keyboard.shortcut":{type:"keyboard.shortcut",key:"KeyK",modifiers:["command"]},"shell.run":{type:"shell.run",scriptId:"",version:"",args:[]},"shortcuts.run":{type:"shortcuts.run",shortcutId:"",timeoutMs:30_000}};
        step.action=defaults[type]!;reloadSteps();
      });
      actionFields(card,step);input(card,"Step limit (seconds)",String(step.timeoutMs/1000),`wf-${step.id}-timeout`,value=>{step.timeoutMs=Math.round(Number(value)*1000);},true);
      check(card,"High risk — confirm before starting the workflow",!!step.requiresConfirmation,value=>{if(value)step.requiresConfirmation=true;else delete step.requiresConfirmation;});
      actions.className="workflow-step-actions";
      const up=button("Move up",()=>{[workflow.steps[index-1],workflow.steps[index]]=[workflow.steps[index]!,workflow.steps[index-1]!];reloadSteps();change();});up.disabled=index===0;
      const down=button("Move down",()=>{[workflow.steps[index+1],workflow.steps[index]]=[workflow.steps[index]!,workflow.steps[index+1]!];reloadSteps();change();});down.disabled=index===workflow.steps.length-1;
      actions.append(up,down,button("Remove step",()=>{workflow.steps.splice(index,1);reloadSteps();change();}));card.append(actions);container.append(card);
    }
    el<HTMLButtonElement>("workflow-add-step").disabled=workflow.steps.length>=MAX_WORKFLOW_STEPS;
  }
  function load(){
    selector();const workflow=selected();el("workflow-definition").hidden=!workflow;el("workflow-delete-confirm").hidden=true;
    el<HTMLInputElement>("workflow-name").value=workflow?.name??"";el<HTMLInputElement>("workflow-timeout").value=String((workflow?.timeoutMs??60_000)/1000);el<HTMLInputElement>("workflow-risk").checked=!!workflow?.requiresConfirmation;
    el<HTMLButtonElement>("workflow-new").disabled=(options.config()?.workflows?.length??0)>=MAX_WORKFLOWS;
    reloadSteps();
  }
  el("workflow-select").addEventListener("change",()=>{const button=options.selected();if(button){button.action={type:"workflow.run",workflowId:el<HTMLSelectElement>("workflow-select").value};load();change();}});
  el("workflow-new").addEventListener("click",()=>{
    const config=options.config(),button=options.selected();if(!config||!button||(config.workflows?.length??0)>=MAX_WORKFLOWS)return;
    const workflow:Workflow={id:`workflow-${crypto.randomUUID()}`,name:"New workflow",timeoutMs:60_000,steps:[]};(config.workflows??=[]).push(workflow);button.action={type:"workflow.run",workflowId:workflow.id};load();change();
  });
  el("workflow-name").addEventListener("input",()=>{const workflow=selected();if(workflow){workflow.name=el<HTMLInputElement>("workflow-name").value;selector();change();}});
  el("workflow-timeout").addEventListener("input",()=>{const workflow=selected();if(workflow){workflow.timeoutMs=Math.round(Number(el<HTMLInputElement>("workflow-timeout").value)*1000);change();}});
  el("workflow-risk").addEventListener("change",()=>{const workflow=selected();if(workflow){if(el<HTMLInputElement>("workflow-risk").checked)workflow.requiresConfirmation=true;else delete workflow.requiresConfirmation;change();}});
  el("workflow-add-step").addEventListener("click",()=>{const workflow=selected();if(workflow&&workflow.steps.length<MAX_WORKFLOW_STEPS){workflow.steps.push({id:`step-${crypto.randomUUID()}`,action:{type:"app.open",appId:""},timeoutMs:10_000});reloadSteps();change();}});
  el("workflow-delete").addEventListener("click",()=>{if(selected())el("workflow-delete-confirm").hidden=false;});
  el("workflow-delete-no").addEventListener("click",()=>{el("workflow-delete-confirm").hidden=true;});
  el("workflow-delete-yes").addEventListener("click",()=>{const workflow=selected(),config=options.config();if(!workflow||!config)return;config.workflows=config.workflows?.filter(item=>item.id!==workflow.id);for(const button of allComponents(config))if(button.action?.type==="workflow.run"&&button.action.workflowId===workflow.id)button.action=null;load();change();});
  return {load,validate(baseline:Config|undefined):string|undefined{
    const config=options.config();if(!config)return;
    try{
      const workflows=parseWorkflows(config.workflows??[]);
      for(const workflow of workflows)for(const step of workflow.steps){
        const previous=baseline?.workflows?.find(item=>item.id===workflow.id)?.steps.find(item=>item.id===step.id)?.action,action=step.action;
        if(action.type==="shell.run"){
          const script=options.scripts().find(item=>item.id===action.scriptId&&item.version===action.version);
          if(script)validateShellArguments(script.parameters,action.args);else if(JSON.stringify(action)!==JSON.stringify(previous))return "Choose an approved script version for each Shell step.";
        }
        if((action.type==="app.open"||action.type==="window.activate")&&!options.apps().some(item=>item.id===action.appId)&&JSON.stringify(action)!==JSON.stringify(previous))return "Choose an installed Mac app for each application or window step.";
        if(action.type==="shortcuts.run"&&!options.shortcuts().some(item=>item.id===action.shortcutId)&&JSON.stringify(action)!==JSON.stringify(previous))return "Choose an available Mac shortcut for each shortcut step.";
      }
    }catch(error){return (error as Error).message;}
  }};
}
