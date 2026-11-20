import { MAX_WIDGETS, MAX_CONFIG_BYTES, MAX_WORKFLOWS, MAX_WORKFLOW_STEPS, parseConfig, parseConfigDocument, readConfig, type Config, type ConfigDocument } from '../../packages/contracts/index.js';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function downloadLayout(value: unknown, name: string) {
  const config = parseConfigDocument(value), blob = new Blob([JSON.stringify(config, null, 2) + '\n'], {type:'application/json'});
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
interface Options {
  post: <T>(path:string, input:unknown) => Promise<T>;
  current: () => {revision:number;layoutRevision?:number;layoutName?:string;instanceId:string} | undefined;
  available: () => boolean;
  adopt: (view:Config, document:ConfigDocument, stamp:string) => boolean;
}
// T94: `config` is the reviewed v3 document, `view` the layout this device will show once it is saved (what the editor opens).
interface Preview {config:ConfigDocument; view:Config; stamp:string; revision:number; layoutRevision:number; layoutName:string; instanceId:string; issues:Array<{location:string;message:string}>}
export function createLayoutFiles(options: Options) {
  let raw: unknown, preview:Preview|undefined, busy=false, serial=0;
  const note=(value:string)=>{el('layout-file-message').textContent=value;};
  function render() {
    const current=options.current(),active=options.available(),stale=preview&&(preview.revision!==current?.revision||preview.layoutRevision!==current?.layoutRevision||preview.layoutName!==current?.layoutName||preview.instanceId!==current?.instanceId);
    el('layout-files-open').hidden=!current;
    el<HTMLButtonElement>('layout-export').disabled=busy||!active;
    el<HTMLInputElement>('layout-import-file').disabled=busy||!active;
    el<HTMLButtonElement>('layout-import-check').disabled=busy||!active||raw===undefined;
    el<HTMLButtonElement>('layout-import-load').disabled=busy||!active||!preview||!!stale;
    el('layout-import-preview').hidden=!preview;
    if(stale)note('The Mac layout changed. Check this file again before loading it into the editor.');
    if(!current){serial++;raw=undefined;preview=undefined;busy=false;el('layout-files-panel').hidden=true;el('layout-import-issues').replaceChildren();el('layout-import-summary').textContent='';el<HTMLInputElement>('layout-import-file').value='';}
  }
  async function check() {
    if(busy||!options.available()||raw===undefined)return;
    const generation=++serial;busy=true;preview=undefined;note('Checking file and Mac bindings…');render();
    try {
      const response=await options.post<Preview>('configuration/preview',raw);
      if(generation!==serial||!options.current())return;
      if(typeof response.stamp!=='string'||!/^[a-f0-9]{64}$/.test(response.stamp))throw Error('Invalid import review. Reload the page and check the file again.');
      if(!Number.isSafeInteger(response.revision)||response.revision<0||!Number.isSafeInteger(response.layoutRevision)||response.layoutRevision<0||typeof response.layoutName!=='string'||typeof response.instanceId!=='string'||!Array.isArray(response.issues)||response.issues.length>MAX_WIDGETS+MAX_WORKFLOWS*MAX_WORKFLOW_STEPS||response.issues.some(item=>typeof item?.location!=='string'||typeof item?.message!=='string'))throw Error('Invalid import review.');
      preview={...response,config:parseConfigDocument(response.config),view:parseConfig(response.view)};
      el('layout-import-summary').textContent=`${preview.config.library.keys.length} keys · ${preview.config.layouts.length} ${preview.config.layouts.length===1?'layout':'layouts'} · ${preview.config.library.workflows?.length??0} workflows`;
      el('layout-import-issues').replaceChildren(...preview.issues.map(issue=>{const row=document.createElement('li');row.textContent=`${issue.location}: ${issue.message}`;return row;}));
      note(preview.issues.length?'File structure is valid. Rebind the listed targets in the imported draft before saving.':'File and current bindings checked. Nothing has been saved or executed.');
    } catch(error){if(generation===serial)note((error as Error).message);}finally{if(generation===serial){busy=false;render();}}
  }
  el('layout-files-open').addEventListener('click',()=>{el('layout-files-panel').hidden=false;el<HTMLDetailsElement>('connection-settings').open=false;render();el('layout-files-panel').scrollIntoView({block:'nearest'});});
  el('layout-files-close').addEventListener('click',()=>{el('layout-files-panel').hidden=true;});
  el('layout-export').addEventListener('click',()=>{void(async()=>{
    if(busy||!options.available())return;const generation=++serial;busy=true;render();
    try{const value=await options.post<{config:ConfigDocument}>('configuration/export',{});if(generation===serial&&options.current()){downloadLayout(value.config,`keyln-layout-${new Date().toISOString().slice(0,10)}.json`);note('Saved Mac layout exported. Unsaved drafts are not included.');}}
    catch(error){if(generation===serial)note((error as Error).message);}finally{if(generation===serial){busy=false;render();}}
  })();});
  el('layout-import-file').addEventListener('change',()=>{void(async()=>{
    if(busy||!options.available())return;const file=el<HTMLInputElement>('layout-import-file').files?.[0],generation=++serial;raw=undefined;preview=undefined;render();
    if(!file)return;
    try{if(file.size>MAX_CONFIG_BYTES)throw Error('Use a JSON layout file of at most 256 KiB.');
      const content=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());
      if(generation!==serial)return;const value=JSON.parse(content);raw=readConfig(value);await check();
    }catch(error){if(generation===serial){note(`File rejected: ${(error as Error).message}`);render();}}
  })();});
  el('layout-import-check').addEventListener('click',()=>{void check();});
  el('layout-import-load').addEventListener('click',()=>{
    const current=options.current();if(busy||!options.available()||!preview||preview.revision!==current?.revision||preview.layoutRevision!==current?.layoutRevision||preview.layoutName!==current?.layoutName||preview.instanceId!==current?.instanceId)return;
    if(options.adopt(preview.view,preview.config,preview.stamp)){preview=undefined;raw=undefined;el('layout-files-panel').hidden=true;render();}
  });
  return {render};
}
