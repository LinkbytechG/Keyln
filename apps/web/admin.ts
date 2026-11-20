import { label, parseShellParameters, type ShellParameter } from "../../packages/contracts/index.js";
import { downloadLayout } from "./layout-files.js";

interface Device { id: string; name: string; expiresAt: number }
interface Pending { id: string; name: string; expiresAt: number; approved: boolean }
interface LocalScript {
  id: string; name: string; kind: "file" | "command"; source: string; interpreter: string; parameters: ShellParameter[];
  timeoutMs: number; version?: string; status: string; error?: string;
}
interface AdminState { origin: string; expiresAt: number; devices: Device[]; pairing: { expiresAt: number | null; pending: Pending | null };
  scriptRegistry?: { revision: number; scripts: LocalScript[] };
  layout?: { available:boolean;reason:string;backup:{available:boolean;stamp?:string;revision?:number;pages?:number;components?:number;workflows?:number;message:string} } }
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const message = element("admin-message"), login = element("admin-login"), dashboard = element("admin-dashboard");
const codeInput = element<HTMLInputElement>("admin-code"), verify = element<HTMLInputElement>("pair-verify");
let state: AdminState | undefined, busy = false, polling = false, lastState = "", confirmDevice = "", generation = 0;
let visibleCode: { code: string; expiresAt: number } | undefined;
let backupReview: string | undefined, restoreUncertain = false;
interface ParameterDraft { name: string; kind: string; maxLength: number; choices: string; min: number; max: number }
let scriptId: string | null = null, scriptBaseRevision = 0, scriptDirty = false, parameters: ParameterDraft[] = [];
let scriptReview: { id: string; revision: number; version: string; sourceText: string; interpreter: string; timeoutMs: number; parameters: ShellParameter[] } | undefined;
let scriptConfirmation: { kind: "discard" | "revoke" | "remove"; id: string | null } | undefined;

class ApiError extends Error { constructor(message: string, readonly code: string) { super(message); } }
async function post<T>(path: string, input: object = {}): Promise<T> {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`/api/admin/${path}`, { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Keyln-Client": "1" }, body: JSON.stringify(input), signal: controller.signal });
    const value = await response.json();
    if (!response.ok) {
      const code = value.error?.code || "HOST_ERROR", detail = value.error?.message || "Management request failed.";
      const translated: Record<string,string> = {PAIR_EXPIRED:"The pairing request changed or expired. Compare a new request ID.",DEVICE_NOT_FOUND:"This device was revoked or expired. Refresh the list.",ADMIN_LOCAL_ONLY:"Open management on the Mac running Host."};
      throw new ApiError(/\p{Script=Han}/u.test(detail) ? translated[code] ?? `The Mac rejected this request (${code}). Check its current state.` : detail,code);
    }
    return value as T;
  } finally { clearTimeout(timeout); }
}
function notify(text: string, error = false): void { message.textContent = text; message.classList.toggle("error", error); }
function showLogin(): void {
  generation++;
  backupReview=undefined;restoreUncertain=false;element("backup-confirm").hidden=true;element<HTMLInputElement>("backup-understood").checked=false;
  for (const id of ["backup-state", "backup-message", "backup-review", "layout-recovery-reason"]) element(id).textContent = "";
  state = undefined; lastState = ""; visibleCode = undefined; confirmDevice = ""; codeInput.value = "";
  element("admin-devices").replaceChildren(); element("pair-code").textContent = "";
  element("script-list").replaceChildren(); loadScript(null);
  dashboard.hidden = true; login.hidden = false;
}
function failure(error: unknown): void {
  if (error instanceof ApiError && error.code === "ADMIN_UNAUTHORIZED") showLogin();
  notify(error instanceof ApiError ? error.message : "Cannot reach the Mac Host. Check that Keyln is running and try again.", true);
}
function time(timestamp: number): string { return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function count(value: number | undefined, noun: string): string { const n = value ?? 0; return `${n} ${noun}${n === 1 ? "" : "s"}`; }
function refreshButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy;
  element<HTMLButtonElement>("admin-approve").disabled = busy || !state?.pairing.pending || state.pairing.pending.approved || !verify.checked;
  element<HTMLFieldSetElement>("script-fields").disabled = busy || !state;
  element<HTMLButtonElement>("script-add-parameter").disabled = busy || parameters.length >= 8;
  element<HTMLButtonElement>("script-preview").disabled = busy || !scriptId || scriptDirty;
  element<HTMLInputElement>("script-reviewed").disabled = busy || !scriptReview;
  element<HTMLButtonElement>("script-approve").disabled = busy || scriptDirty || !scriptReview || !element<HTMLInputElement>("script-reviewed").checked ||
    state?.scriptRegistry?.scripts.find(item => item.id === scriptReview?.id)?.status === "approved";
  element<HTMLButtonElement>("backup-export").disabled=busy||!state?.layout?.backup.available;
  element<HTMLButtonElement>("backup-restore").disabled=busy||restoreUncertain||!state?.layout?.backup.available;
  element<HTMLButtonElement>("backup-confirm-yes").disabled=busy||restoreUncertain||!backupReview||!element<HTMLInputElement>("backup-understood").checked;
}
function renderDevices(): void {
  element("device-count").textContent = `${state?.devices.length ?? 0} / 8`;
  const list = element("admin-devices"); list.replaceChildren();
  if (!state?.devices.length) { const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "No authorized devices yet."; list.append(empty); }
  for (const device of state?.devices ?? []) {
    const item = document.createElement("article"), name = document.createElement("h3"), details = document.createElement("p");
    item.className = "device"; item.dataset.deviceId = device.id; name.textContent = device.name;
    details.className = "hint"; details.textContent = `ID ${device.id} · Access expires ${new Date(device.expiresAt).toLocaleDateString()}`;
    const actions = document.createElement("div"); actions.className = "actions";
    const button = document.createElement("button"); button.type = "button"; button.className = "danger";
    if (confirmDevice === device.id) {
      const warning = document.createElement("p"); warning.className = "confirm-text"; warning.textContent = `Revoke access for “${device.name}”?`;
      button.textContent = "Confirm revoke"; button.onclick = () => void operate(async () => { await post("revoke", { id: device.id }); confirmDevice = ""; notify(`Revoked ${device.name}.`); });
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel";
      cancel.onclick = () => { confirmDevice = ""; renderDevices(); refreshButtons(); };
      item.append(warning); actions.append(button, cancel);
    } else {
      button.textContent = "Revoke access"; button.onclick = () => { confirmDevice = device.id; renderDevices(); refreshButtons(); }; actions.append(button);
    }
    item.prepend(name, details); item.append(actions); list.append(item);
  }
}
function render(): void {
  if (!state) return;
  login.hidden = true; dashboard.hidden = false;
  element("control-address").textContent = state.origin;
  element("admin-session").textContent = `Signed in on this Mac · Session expires at ${time(state.expiresAt)}`;
  const backup=state.layout?.backup;
  element("backup-state").textContent=backup?.available?`Previous revision ${backup.revision} · ${count(backup.pages,"page")} · ${count(backup.components,"key")} · ${count(backup.workflows,"workflow")}.` : backup?.message??"Checking the layout backup.";
  element("layout-recovery-reason").textContent=state.layout?.available===false?"The layout is damaged or unavailable. Only recovery is enabled; pairing and actions are disabled. Original files were not reset.":"";
  element("pairing-management").hidden=state.layout?.available===false;element("scripts-management").hidden=state.layout?.available===false;
  if(backupReview&&backupReview!==backup?.stamp){backupReview=undefined;element<HTMLInputElement>("backup-understood").checked=false;element("backup-message").textContent="The layout or backup changed. Review it again before confirming.";}
  element("backup-confirm").hidden=!backupReview;
  if (state.pairing.expiresAt !== visibleCode?.expiresAt) visibleCode = undefined;
  element("pair-code-area").hidden = !visibleCode;
  element("pair-code").textContent = visibleCode?.code ?? "";
  element("pair-code-expiry").textContent = visibleCode ? `Expires at ${time(visibleCode.expiresAt)}; 5 attempts. Approve the pairing request here afterward.` : "";
  element("pair-window").textContent = state.pairing.expiresAt ? "Pairing is open. A new code replaces the previous code and pending request." : state.pairing.pending ? "The code was used. Compare the pending request below." : "Pairing is closed. Generate a code to allow a device request.";
  element("admin-close-pairing").hidden = !state.pairing.expiresAt && !state.pairing.pending;
  const pending = state.pairing.pending;
  element("pending-request").hidden = !pending;
  if (verify.dataset.requestId !== pending?.id || pending?.approved) verify.checked = false;
  verify.dataset.requestId = pending?.id ?? "";
  element("pending-name").textContent = pending ? `Device name: ${pending.name}` : "";
  element("pending-id").textContent = pending?.id ?? "";
  element("pending-expiry").textContent = pending ? `Request expires at ${time(pending.expiresAt)}. The name is only a label; compare the request ID.` : "";
  element("pair-verify-label").hidden = !!pending?.approved;
  element("admin-approve").hidden = !!pending?.approved;
  element("pending-approved").hidden = !pending?.approved;
  renderDevices(); renderScripts(); refreshButtons();
}

function clearScriptReview(): void {
  scriptReview = undefined; element("script-review").hidden = true; element("script-source-preview").textContent = ""; element("script-rules-preview").textContent = "";
  element<HTMLInputElement>("script-reviewed").checked = false;
}
function scriptChanged(): void {
  scriptDirty = true; scriptConfirmation = undefined; element("script-confirm").hidden = true; clearScriptReview();
  element("script-message").textContent = "Unsaved. Save, review and approve again. Existing keys do not automatically change versions."; refreshButtons();
}
function renderParameters(): void {
  const container = element("script-parameters"); container.replaceChildren();
  for (const [index, parameter] of parameters.entries()) {
    const row = document.createElement("div"); row.className = "script-parameter";
    function field(caption: string, key: "name" | "maxLength" | "choices" | "min" | "max", number = false) {
      const wrapper = document.createElement("label"), input = document.createElement(key === "choices" ? "textarea" : "input");
      wrapper.textContent = caption; input.value = String(parameter[key]); input.setAttribute("aria-label", `Parameter ${index + 1} ${caption}`);
      if (number) (input as HTMLInputElement).type = "number";
      input.addEventListener("input", () => { if (key === "maxLength" || key === "min" || key === "max") parameter[key] = Number(input.value); else parameter[key] = input.value; scriptChanged(); });
      wrapper.append(input); row.append(wrapper);
    }
    field("Parameter name", "name");
    const wrapper = document.createElement("label"), select = document.createElement("select"); wrapper.textContent = "Allowed value rule";
    select.replaceChildren(new Option("Text (bounded length)", "text"), new Option("Fixed choices", "choice"), new Option("Integer range", "integer")); select.value = parameter.kind;
    select.addEventListener("change", () => { parameter.kind = select.value; scriptChanged(); renderParameters(); }); wrapper.append(select); row.append(wrapper);
    if (parameter.kind === "text") field("Max characters (1–256)", "maxLength", true);
    else if (parameter.kind === "choice") field("Allowed choices (one per line, up to 16)", "choices");
    else { field("Minimum integer", "min", true); field("Maximum integer", "max", true); }
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Remove parameter";
    remove.onclick = () => { parameters.splice(index, 1); scriptChanged(); renderParameters(); }; row.append(remove); container.append(row);
  }
}
function loadScript(id: string | null): void {
  scriptId = id; scriptBaseRevision = state?.scriptRegistry?.revision ?? 0; scriptDirty = false; scriptConfirmation = undefined; clearScriptReview(); element("script-confirm").hidden = true;
  const script = state?.scriptRegistry?.scripts.find(item => item.id === id);
  element("script-form-title").textContent = script ? `Edit “${script.name}”` : "Register a script";
  element<HTMLInputElement>("script-name").value = script?.name ?? "";
  element<HTMLSelectElement>("script-kind").value = script?.kind ?? "file";
  element<HTMLSelectElement>("script-interpreter").value = script?.interpreter ?? "/bin/zsh";
  element<HTMLTextAreaElement>("script-source").value = script?.source ?? "";
  element<HTMLInputElement>("script-timeout").value = String((script?.timeoutMs ?? 10000) / 1000);
  parameters = (script?.parameters ?? []).map(rule => ({ name: rule.name, kind: rule.kind,
    maxLength: rule.kind === "text" ? rule.maxLength : 80, choices: rule.kind === "choice" ? rule.choices.join("\n") : "safe", min: rule.kind === "integer" ? rule.min : 0, max: rule.kind === "integer" ? rule.max : 100 }));
  element("script-source-label").textContent = script?.kind === "command" ? "Command (registered on this Mac)" : "Absolute script path";
  renderParameters(); refreshButtons();
}
function switchScript(id: string | null): void {
  if (scriptDirty) { scriptConfirmation = { kind: "discard", id }; showScriptConfirmation("Discard these unsaved registration edits? Saved registrations and approvals are unchanged."); }
  else loadScript(id);
}
function showScriptConfirmation(message: string): void {
  element("script-confirm-message").textContent = message; element("script-confirm").hidden = false;
}
function renderScripts(): void {
  const list = element("script-list"), scripts = state?.scriptRegistry?.scripts ?? [];
  element("script-count").textContent = `${scripts.length} / 32`; list.replaceChildren();
  if (scriptReview && scripts.find(item => item.id === scriptReview!.id)?.version !== scriptReview.version) clearScriptReview();
  for (const script of scripts) {
    const item = document.createElement("article"), title = document.createElement("h3"), status = document.createElement("p"), actions = document.createElement("div");
    item.className = "script-item"; item.dataset.scriptId = script.id; title.textContent = script.name; status.className = "hint";
    status.textContent = ({approved:"Approved",unapproved:"Approval required",changed:"File changed; approval required",unavailable:"File unavailable"} as Record<string,string>)[script.status] ?? "Not checked";
    if (script.error) status.textContent += ` · ${script.error}`;
    actions.className = "actions";
    for (const [caption, callback] of [["Edit / view", () => switchScript(script.id)], ["Revoke approval", () => {
      scriptConfirmation = {kind:"revoke",id:script.id}; showScriptConfirmation(`Revoke approval for “${script.name}”? Future runs are blocked; started actions are not undone.`);
    }], ["Remove registration", () => { scriptConfirmation = {kind:"remove",id:script.id}; showScriptConfirmation(`Remove the registration for “${script.name}”? Related keys become unavailable. The script file is not deleted.`); }]] as [string, () => void][]) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = caption; button.onclick = callback; actions.append(button);
    }
    item.append(title,status,actions); list.append(item);
  }
}
for (const id of ["script-name", "script-kind", "script-interpreter", "script-source", "script-timeout"])
  element(id).addEventListener("input", scriptChanged);
element("script-kind").addEventListener("change", () => { element("script-source-label").textContent = element<HTMLSelectElement>("script-kind").value === "command" ? "Command (registered on this Mac)" : "Absolute script path"; scriptChanged(); });
element("script-new").onclick = () => switchScript(null);
element("script-reset").onclick = () => switchScript(scriptId);
element("script-add-parameter").onclick = () => {
  if (parameters.length >= 8) return;
  parameters.push({name:`Parameter ${parameters.length + 1}`,kind:"text",maxLength:80,choices:"safe",min:0,max:100}); scriptChanged(); renderParameters();
};
element<HTMLFormElement>("script-form").onsubmit = event => {
  event.preventDefault();
  let definition: object;
  try {
    const rules = parseShellParameters(parameters.map(rule => ({name:rule.name,kind:rule.kind,...(rule.kind === "choice" ? {choices:rule.choices.split("\n").map(item=>item.trim()).filter(Boolean)} : rule.kind === "integer" ? {min:rule.min,max:rule.max} : {maxLength:rule.maxLength})})));
    definition = {name:label(element<HTMLInputElement>("script-name").value),kind:element<HTMLSelectElement>("script-kind").value,source:element<HTMLTextAreaElement>("script-source").value,
      interpreter:element<HTMLSelectElement>("script-interpreter").value,timeoutMs:Math.round(Number(element<HTMLInputElement>("script-timeout").value)*1000),parameters:rules};
  } catch (error) { notify((error as Error).message,true); return; }
  void operate(async () => {
    const saved = await post<{id:string;revision:number;scripts:LocalScript[]}>("scripts/save",{revision:scriptBaseRevision,id:scriptId,definition});
    if (!state) return; state.scriptRegistry = saved; loadScript(saved.id);
    element("script-message").textContent = "Registration saved, awaiting approval. Review it before approving. No script ran.";
  });
};
element("script-preview").onclick = () => {
  if (!scriptId || scriptDirty) return;
  const id = scriptId;
  void operate(async () => {
    scriptReview = await post<NonNullable<typeof scriptReview>>("scripts/preview",{id});
    element("script-review-summary").textContent = `${scriptReview.interpreter} · ${scriptReview.timeoutMs / 1000} s · ${count(scriptReview.parameters.length,"parameter")} · Version ${scriptReview.version.slice(0,12)}`;
    element("script-source-preview").textContent = scriptReview.sourceText; element("script-review").hidden = false;
    element("script-rules-preview").textContent = scriptReview.parameters.length ? scriptReview.parameters.map((rule,index)=>
      `$${index+1} ${rule.name}: ${rule.kind === "text" ? `Text, up to ${rule.maxLength} characters` : rule.kind === "choice" ? `Only ${rule.choices.join(" / ")}` : `Integer ${rule.min}–${rule.max}`}`).join("; ") : "No parameters accepted.";
    element<HTMLInputElement>("script-reviewed").checked = false;
  });
};
element("script-reviewed").onchange = refreshButtons;
element("script-approve").onclick = () => {
  if (!scriptReview || scriptDirty || !element<HTMLInputElement>("script-reviewed").checked) return;
  const review = scriptReview;
  void operate(async () => {
    const approved = await post<NonNullable<AdminState["scriptRegistry"]>>("scripts/approve",{revision:review.revision,id:review.id,version:review.version});
    if (state) { state.scriptRegistry = approved; loadScript(review.id); }
    element("script-message").textContent = "This version is approved. Surface can select it now; existing keys must be explicitly rebound.";
  });
};
element("script-confirm-no").onclick = () => { scriptConfirmation = undefined; element("script-confirm").hidden = true; };
element("script-confirm-yes").onclick = () => {
  const confirmation = scriptConfirmation; if (!confirmation) return;
  scriptConfirmation = undefined; element("script-confirm").hidden = true;
  if (confirmation.kind === "discard") { loadScript(confirmation.id); return; }
  void operate(async () => {
    const next = await post<NonNullable<AdminState["scriptRegistry"]>>(`scripts/${confirmation.kind}`,{revision:state?.scriptRegistry?.revision,id:confirmation.id});
    if (!state) return; state.scriptRegistry = next; if (scriptId === confirmation.id) loadScript(confirmation.kind === "remove" ? null : confirmation.id);
    element("script-message").textContent = confirmation.kind === "remove" ? "Registration removed. The script file is unchanged." : "Approval revoked. Started actions are not undone.";
  });
};
async function sync(force = false, expected = generation): Promise<void> {
  const next = await post<AdminState>("state"), serialized = JSON.stringify(next);
  if (expected !== generation) return;
  const pending = state?.pairing.pending;
  const completed = pending && next.devices.some(device => device.id === pending.id);
  const first = !state; state = next;
  if (first) loadScript(null);
  if (force || serialized !== lastState) { lastState = serialized; render(); }
  if (completed) notify(`Device “${pending.name}” is paired.`);
}
async function operate(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  generation++;
  busy = true; refreshButtons();
  try { await action(); if (state) await sync(true); }
  catch (error) { failure(error); }
  finally { busy = false; refreshButtons(); }
}
element<HTMLFormElement>("admin-login-form").onsubmit = event => {
  event.preventDefault();
  void operate(async () => { await post("login", { code: codeInput.value.trim() }); codeInput.value = ""; await sync(true); notify("Signed in. You can manage devices."); });
};
element("admin-invite").onclick = () => void operate(async () => {
  const result = await post<{ code: string; expiresAt: number }>("invite");
  visibleCode = { code: result.code, expiresAt: result.expiresAt }; notify("Enter the new code on Surface, then compare the request ID here.");
});
element("admin-close-pairing").onclick = () => void operate(async () => { await post("close-pairing"); visibleCode = undefined; notify("Pairing closed. Pending requests were cancelled."); });
verify.onchange = refreshButtons;
element("admin-approve").onclick = () => {
  const id = state?.pairing.pending?.id;
  if (!id || !verify.checked || verify.dataset.requestId !== id) return;
  void operate(async () => { await post("approve", { id }); notify("Approved. Waiting for Surface to finish pairing."); });
};
element("admin-logout").onclick = () => void operate(async () => { await post("logout"); showLogin(); notify("Signed out. Paired devices remain connected."); });
const initialGeneration = generation;
void sync(true).then(() => { if (initialGeneration === generation) notify("Management session restored."); }).catch(error => {
  if (initialGeneration !== generation) return;
  showLogin(); if (error instanceof ApiError && error.code === "ADMIN_UNAUTHORIZED") notify("Enter the management code from the Keyln window on this Mac."); else failure(error);
});
setInterval(() => {
  if (!state || busy || polling || document.hidden) return;
  const expected = generation;
  polling = true;
  void sync(false, expected).catch(error => { if (expected === generation) failure(error); }).finally(() => { polling = false; });
}, 3000);

element('backup-export').addEventListener('click',()=>{void operate(async()=>{
  const result=await post<{config:unknown}>('layout/backup');downloadLayout(result.config,`keyln-backup-v3-${new Date().toISOString().slice(0,10)}.json`);
  element('backup-message').textContent='Exported the previous valid layout, without device tokens, certificates or script registrations.';
});});
element('backup-restore').addEventListener('click',()=>{
  if(busy||restoreUncertain||!state?.layout?.backup.available)return;
  backupReview=state.layout.backup.stamp;element<HTMLInputElement>('backup-understood').checked=false;
  element('backup-review').textContent=`Review revision ${state.layout.backup.revision}: ${count(state.layout.backup.pages,"page")}, ${count(state.layout.backup.components,"key")}, ${count(state.layout.backup.workflows,"workflow")}.`;
  element('backup-confirm').hidden=false;refreshButtons();
});
element('backup-understood').addEventListener('change',refreshButtons);
element('backup-confirm-no').addEventListener('click',()=>{backupReview=undefined;element('backup-confirm').hidden=true;refreshButtons();});
element('backup-confirm-yes').addEventListener('click',()=>{
  if(busy||restoreUncertain||!backupReview||!element<HTMLInputElement>('backup-understood').checked)return;
  const stamp=backupReview;backupReview=undefined;element('backup-confirm').hidden=true;
  void operate(async()=>{
    try{await post('layout/restore',{stamp,confirm:true});element('backup-message').textContent='Layout restored. All control devices were revoked. Pair Surface again; no action ran.';notify('Layout recovery complete.');}
    catch(error){
      if(!(error instanceof ApiError)||!['BACKUP_CHANGED','BUSY','INVALID_INPUT','ADMIN_UNAUTHORIZED','WRONG_ORIGIN'].includes(error.code)){
        restoreUncertain=true;element('backup-message').textContent='Restore result is unknown. Do not repeat it. Check the Mac, then choose Check status again; devices may already be revoked.';
      }
      throw error;
    }
  });
});
element('backup-refresh').addEventListener('click',()=>{void operate(async()=>{await sync(true);restoreUncertain=false;element('backup-message').textContent='Mac state reloaded. Review the layout and backup before deciding to restore.';});});
