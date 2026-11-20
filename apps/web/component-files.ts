// T57/T62: one component as a file (ADR-062, ADR-064). The planning functions are pure; the draft they return is only a draft.
import { Fault, ITEM_FILE_SUFFIX, MAX_CONFIG_BYTES, MAX_WIDGETS, MAX_WORKFLOWS, presetSummary, allComponents, locate, parseItemFile,
  type Component, type Config, type FileBody, type ItemFile, type SizeTier, type Workflow } from "../../packages/contracts/index.js";
import { addWidget, type Container } from "./page-layout.js";

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// ---- file names, download, reading ----
// A name that is safe on every system: letters, digits, dots, dashes; anything else becomes a dash.
export function safeFileName(name: string, suffix: string, fallback: string): string {
  const base = Array.from(name).filter(char => !/[\x00-\x1f\x7f]/u.test(char)).join("").trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^[.\-]+|[.\-]+$/g, "").slice(0, 60).replace(/[\uD800-\uDBFF]$/, "");
  return `${base || fallback}${suffix}`;
}
export const itemFileName = (name: string) => safeFileName(name, ITEM_FILE_SUFFIX, "component");
export function downloadJson(value: unknown, name: string) {
  const blob = new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// The file's text as JSON. The size limit is the one a whole layout import has; nothing else is read or kept.
export async function readJsonFile(file: { size: number; arrayBuffer: () => Promise<ArrayBuffer> }): Promise<unknown> {
  if (file.size > MAX_CONFIG_BYTES) throw new Fault("TOO_LARGE", "Use a JSON file of at most 256 KiB.", 413);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer())); }
  catch { throw new Fault("INVALID_INPUT", "This is not a readable JSON file."); }
}

// ---- names ----
// "Name", then "Name (2)", "Name (3)" … cut so the whole stays within 40 characters.
export function uniqueName(name: string, taken: Iterable<string>, max = 40): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`, base = name.slice(0, max - suffix.length).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
    if (!used.has(base + suffix)) return base + suffix;
  }
}

// ---- what the person is shown before anything is added ----
export interface ImportInfo { name: string; kind: string; componentKind?: string; size: SizeTier; workflows: number }
export const itemInfo = (file: ItemFile): ImportInfo => ({ name: file.component.label, kind: "Key",
  componentKind: file.component.kind, size: file.component.size, workflows: file.workflows?.length ?? 0 });
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
export function describe(info: ImportInfo): string[] {
  const lines = [`${info.kind} · ${presetSummary(info.size, info.componentKind ? { kind: info.componentKind } : undefined)}`];
  if (info.workflows) lines.push(plural(info.workflows, "workflow"));
  return lines;
}
// ---- fresh ids, workflows ----
const fresh = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
// The file's workflows join the draft with new ids and names that do not collide. Returns the old-to-new id map.
function bringWorkflows(draft: Config, source: Workflow[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!source?.length) return map;
  if ((draft.workflows?.length ?? 0) + source.length > MAX_WORKFLOWS) throw new Fault("INVALID_INPUT", `A configuration holds up to ${MAX_WORKFLOWS} workflows. Delete one first; nothing was added.`);
  const taken = new Set((draft.workflows ?? []).map(workflow => workflow.name));
  for (const workflow of source) {
    const made = copy(workflow);
    made.id = fresh("workflow"); made.name = uniqueName(workflow.name, taken); taken.add(made.name);
    made.steps = made.steps.map(step => ({ ...step, id: fresh("step") }));
    map.set(workflow.id, made.id); (draft.workflows ??= []).push(made);
  }
  return map;
}
function rebuilt(source: FileBody, workflowIds: Map<string, string>): Omit<Component, "cell"> {
  const component = { ...copy(source), id: fresh("component") } as Omit<Component, "cell">;
  if (component.action?.type === "workflow.run") component.action = { type: "workflow.run", workflowId: workflowIds.get(component.action.workflowId)! };
  return component;
}
function settle(config: Config) {
  if (allComponents(config).length > MAX_WIDGETS) throw new Fault("LAYOUT_SPACE", `A configuration holds up to ${MAX_WIDGETS} widgets. Nothing was added.`);
  if (new TextEncoder().encode(JSON.stringify(config, null, 2) + "\n").length > MAX_CONFIG_BYTES) throw new Fault("TOO_LARGE", "This would make the saved configuration larger than 256 KiB. Nothing was added.", 413);
}

// ---- adding one component ----
export interface ItemPlan { config: Config; button: Component }
// The first free place in the container (the current page, else the canvas, else any page) where the tier fits. `size` overrides the file's own tier.
export function planItemImport(draft: Config, container: Container | undefined, file: ItemFile, size?: SizeTier): ItemPlan {
  const next = copy(draft), want = size ?? file.component.size;
  const made = rebuilt({ ...file.component, size: want }, bringWorkflows(next, file.workflows));
  const placed = addWidget(next, made, container);
  settle(placed.config);
  const button = locate(placed.config, made.id)!.widget as Component;
  return { config: placed.config, button };
}

export { parseItemFile };
