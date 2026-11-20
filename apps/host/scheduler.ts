import { randomUUID } from "node:crypto";
import { Fault, findComponent, needsConfirmation, parseShellOutput, parseWorkflowResult, type Action, type Config, type Execution, type Trigger, type ShellOutput, type WorkflowResult } from "../../packages/contracts/index.js";

export interface ActionResult { ok: boolean; code?: string; message: string; unknown?: boolean; output?: ShellOutput;workflow?:WorkflowResult;halt?:boolean }
export interface AdapterContext {config:Config;progress:(value:WorkflowResult)=>void}
export interface Adapter { run(action: Action, signal: AbortSignal,context?:AdapterContext): Promise<ActionResult>; timeoutMs?(action: Action,config?:Config): number }
// T115 (ADR-099): a Dock activation is retained like a trigger, with its own input shape.
export interface DockOpen { requestId: string; appId: string }
interface Entry { deviceId: string; input: Trigger | DockOpen; execution: Execution }
export const RETENTION_MS = 10 * 60 * 1000;
export const EXECUTION_TIMEOUT_MS = 10_000;
export class Scheduler {
  private entries = new Map<string, Entry>();
  private active?: AbortController;
  private stopped = false;
  private completing?: Promise<void>;
  private listeners = new Set<(deviceId: string, execution: Execution) => void>();
  constructor(private adapter: Adapter, private now = Date.now, private timeout = EXECUTION_TIMEOUT_MS, private capacity = 1000,
    private report: (execution: Execution) => void = () => {}) {}
  get busy(): boolean { return !!this.active; }
  onChange(listener: (deviceId: string, execution: Execution) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify(entry: Entry): void {
    for (const listener of this.listeners) {
      // A failed connection must not interrupt execution or affect another observer.
      try { listener(entry.deviceId, structuredClone(entry.execution)); } catch { /* result remains queryable */ }
    }
  }
  private key(deviceId: string, id: string): string { return `${deviceId}/${id}`; }
  private prune(): void {
    for (const [key, entry] of this.entries) {
      const finished = entry.execution.finishedAt;
      if (finished !== undefined && finished + RETENTION_MS <= this.now()) this.entries.delete(key);
    }
  }
  get(deviceId: string, requestId: string): Execution {
    this.prune();
    const entry = this.entries.get(this.key(deviceId, requestId));
    if (!entry) throw new Fault("RESULT_UNKNOWN", "No retained result. The Host may have restarted. Check the Mac; this action will not be retried.", 404);
    return structuredClone(entry.execution);
  }
  trigger(deviceId: string, input: Trigger, config: Config,confirm?:()=>void): Execution {
    this.prune();
    const key = this.key(deviceId, input.requestId), existing = this.entries.get(key);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Fault("REQUEST_CONFLICT", "Request ID was already used with different input.", 409);
      return structuredClone(existing.execution);
    }
    if (this.stopped) throw new Fault("HOST_STOPPING", "The Mac Host is stopping. Nothing was queued.", 503);
    if (input.revision !== config.revision) throw new Fault("CONFIG_CONFLICT", "Configuration changed. Reconnect before running this button.", 409);
    const button = findComponent(config, input.componentId);
    if (!button) throw new Fault("BUTTON_UNAVAILABLE", "This button no longer exists. Reconnect and review the configuration.", 409);
    const target = button.action;
    if (!target) throw new Fault("NOT_CONFIGURED", "Configure the button first.");
    if (this.busy) throw new Fault("BUSY", "The Mac is executing an action. Nothing was queued.", 409);
    if (this.entries.size >= this.capacity) throw new Fault("CAPACITY", "Execution history is full. Wait for its ten-minute retention window to expire.", 429);
    if(needsConfirmation(config,button)){
      if(!confirm)throw new Fault("CONFIRMATION_REQUIRED","Confirm this saved action before running it.",409);
      confirm();
    }else if(input.confirmation)throw new Fault("INVALID_INPUT","This action does not use a confirmation token.");
    return this.start(deviceId, key, { ...input }, target, config);
  }
  /**
   * T115 (ADR-099): brings an already running app to the front for the Dock bar. The caller has checked that the device's layout shows the Dock and that the app is
   * running. It follows the same rules as trigger() (idempotent by request ID, HOST_STOPPING, BUSY, CAPACITY) and runs the existing app.open path; it needs no
   * confirmation and no configuration revision, and it can run nothing but app.open.
   */
  openRunning(deviceId: string, input: DockOpen, config: Config): Execution {
    this.prune();
    const key = this.key(deviceId, input.requestId), existing = this.entries.get(key);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Fault("REQUEST_CONFLICT", "Request ID was already used with different input.", 409);
      return structuredClone(existing.execution);
    }
    if (this.stopped) throw new Fault("HOST_STOPPING", "The Mac Host is stopping. Nothing was queued.", 503);
    if (this.busy) throw new Fault("BUSY", "The Mac is executing an action. Nothing was queued.", 409);
    if (this.entries.size >= this.capacity) throw new Fault("CAPACITY", "Execution history is full. Wait for its ten-minute retention window to expire.", 429);
    return this.start(deviceId, key, { ...input }, { type: "app.open", appId: input.appId }, config);
  }
  private start(deviceId: string, key: string, input: Entry["input"], target: Action, config: Config): Execution {
    const execution: Execution = { id: randomUUID(), requestId: input.requestId, status: "accepted", actionType: target.type, createdAt: this.now(), message: "Received by Mac." };
    const entry: Entry = { deviceId, input, execution };
    this.entries.set(key, entry);
    const controller = new AbortController(); this.active = controller;
    const action = structuredClone(target),boundConfig=structuredClone(config);
    this.notify(entry);
    setImmediate(() => { this.completing = this.execute(entry, action, controller,boundConfig); });
    return { ...execution };
  }
  stop(): void { this.stopped = true; this.active?.abort(); }
  async settled(): Promise<void> { await this.completing; }
  private async execute(entry: Entry, action: Action, controller: AbortController,config:Config): Promise<void> {
    const { execution } = entry;
    execution.status = "running"; execution.message = action.type === "app.open" ? "Opening and activating the application…" :
      action.type === "window.activate" ? "Finding and activating the selected Mac window…" :
      action.type === "shell.run" ? "Running the approved script on the Mac…" : action.type === "shortcuts.run" ? "Waiting for Mac Shortcuts to finish…" : action.type==="workflow.run"?"Starting the saved workflow…":"Sending the shortcut to the current foreground application…";
    this.notify(entry);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let task: Promise<ActionResult> | undefined;
    try {
      if (controller.signal.aborted) throw new Error("Host stopped before execution.");
      const timeout = this.adapter.timeoutMs?.(action,config) ?? this.timeout;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 185_000) throw new Error("Invalid adapter deadline.");
      task = this.adapter.run(action, controller.signal,{config,progress:value=>{
        if(action.type!=="workflow.run"||controller.signal.aborted||execution.status!=="running")return;
        execution.workflow=parseWorkflowResult(value);this.notify(entry);
      }});
      const result = await Promise.race([
        task,
        new Promise<never>((_, reject) => {
          const abort = () => reject(new Fault("RESULT_UNKNOWN", "Execution interrupted or timed out. Check the Mac before trying again."));
          controller.signal.addEventListener("abort", abort, { once: true });
          if (controller.signal.aborted) abort();
          timer = setTimeout(() => controller.abort(), timeout);
        }),
      ]);
      if (typeof result.ok !== "boolean" || typeof result.message !== "string" || !result.message.length ||
          (result.code !== undefined && (typeof result.code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(result.code))) ||
          (result.unknown !== undefined && (typeof result.unknown !== "boolean" || result.unknown && result.ok)))
        throw new Error("Invalid adapter result.");
      if (result.output !== undefined) {
        if (action.type !== "shell.run") throw new Error("Unexpected script output.");
        execution.output = parseShellOutput(result.output);
      }
      if(result.workflow!==undefined){
        if(action.type!=="workflow.run")throw new Error("Unexpected workflow result.");
        execution.workflow=parseWorkflowResult(result.workflow,true);
        if(result.ok&&(execution.workflow.steps.length!==execution.workflow.totalSteps||execution.workflow.steps.some(step=>step.status!=="succeeded")))throw new Error("Incomplete workflow cannot succeed.");
      }else if(action.type==="workflow.run")throw new Error("Missing workflow result.");
      if(result.halt)this.stopped=true;
      execution.status = result.unknown ? "unknown" : result.ok ? "succeeded" : "failed";
      execution.message = result.message.slice(0, 300);if(result.code)execution.code=result.code;else delete execution.code;
    } catch {
      if ((action.type === "shell.run"||action.type==="shortcuts.run"||action.type==="workflow.run") && controller.signal.aborted && task) {
        let drained = false, deadline: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([task.then(() => { drained = true; }, () => { drained = true; }),
          new Promise<void>(resolve => { deadline = setTimeout(resolve, 1500); })]);
        clearTimeout(deadline);
        if (!drained) this.stopped = true; // Do not start another action while an unresponsive script adapter still owns processes.
      }
      execution.status = "unknown"; execution.code = "RESULT_UNKNOWN";
      execution.message = "Result unknown. The helper stopped or timed out. Check the Mac before trying again.";
      for(const step of execution.workflow?.steps??[])if(step.status==="running"){step.status="unknown";step.finishedAt=this.now();step.message="Workflow was interrupted; later steps were not run.";}
    } finally {
      clearTimeout(timer); execution.finishedAt = this.now(); this.active = undefined;
      this.notify(entry);
      this.report(structuredClone(execution));
    }
  }
}
