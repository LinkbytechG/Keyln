import { PAGES_SIZE_BOUNDS, TIER_SPAN, sizeTiers, resolveSizeU, sizeToPx, THEME_CONTEXT, themeSizingFor, widgetPresetSpan, type SizeTier, type PagesSize, type PagesWidth, type PagesHeight } from "./sizing.js";
export * from "./sizing.js";
// Shared configuration and protocol rules for the Mac Host and the web client.
export const icons = { app: "App window", spark: "Search", play: "Play", bolt: "Command",
  calculator: "Calculator", scan: "Screenshot", code: "Code", lock: "Lock", moon: "Moon", volume: "Volume",
  link: "Link", keyboard: "Keyboard", text: "Text", mic: "Microphone",
  folder: "Folder", star: "Star", heart: "Heart", home: "Home", mail: "Mail", camera: "Camera",
  terminal: "Terminal", monitor: "Display", globe: "Globe", headphones: "Headphones", coffee: "Coffee",
  check: "Check", download: "Download", upload: "Upload", refresh: "Refresh", sun: "Sun" } as const;
export type Icon = keyof typeof icons;
export const keyColors = ["orange", "yellow", "green", "blue", "purple", "red", "gray"] as const;
export type KeyColor = typeof keyColors[number];
export function keyColor(value: unknown): KeyColor {
  if (!keyColors.includes(value as KeyColor)) throw new Fault("INVALID_INPUT", "Choose a built-in key color.");
  return value as KeyColor;
}
// T43: a key can also have no color at all ("none"): it is never filled and sits on the dark key body. It needs layout v8.
export type ButtonColor = KeyColor | "none";
export function buttonColor(value: unknown): ButtonColor {
  return value === "none" ? "none" : keyColor(value);
}
// The built-in themes. Braun is the default. Which one a device shows is that device's own choice (T62); the definitions of custom themes are shared.
export const themes = ["braun", "metro", "midnight", "standard", "classic", "widget"] as const;
export type ThemeName = typeof themes[number];
export const DEFAULT_THEME: ThemeName = "braun";
export function themeName(value: unknown): ThemeName {
  if (!themes.includes(value as ThemeName)) throw new Fault("INVALID_INPUT", "Choose a supported theme.");
  return value as ThemeName;
}
// Custom themes (v7, T42): a copy of a built-in theme with a few overrides, saved in the Mac layout like the theme itself. Colors are #RRGGBB;
// the font is a key into a fixed list of local stacks (the web client owns the stacks; no web fonts are ever loaded).
export const themeRadii = ["square", "small", "rounded", "round"] as const;
export const themeSpacings = ["tight", "normal", "loose"] as const;
export const themeFonts = ["braun", "metro", "midnight", "standard", "classic", "system"] as const;
export type ThemeRadius = typeof themeRadii[number];
export type ThemeSpacing = typeof themeSpacings[number];
export type ThemeFont = typeof themeFonts[number];
export const MAX_CUSTOM_THEMES = 8;
export type CustomThemeId = `theme-${string}`;
export interface CustomTheme {
  id: CustomThemeId; name: string; base: ThemeName; accent: string; background: string; keyBody: string;
  radius: ThemeRadius; spacing: ThemeSpacing; font: ThemeFont;
  // T62: the zones of this theme; without it the base theme's zones are used (the Layout page of the theme window is T64).
  layout?: ThemeLayout;
}
// The theme a device selects: a built-in name or the id of one of the custom themes.
export type ThemeChoice = ThemeName | CustomThemeId;
export const isCustomThemeId = (value: unknown): value is CustomThemeId => typeof value === "string" && /^theme-[A-Za-z0-9_-]{1,56}$/.test(value);
export function themeHex(value: unknown): string {
  if (typeof value !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(value)) throw new Fault("INVALID_INPUT", "Colors are written as #RRGGBB.");
  return value.toUpperCase();
}
function oneOf<T extends string>(value: unknown, list: readonly T[], what: string): T {
  if (!list.includes(value as T)) throw new Fault("INVALID_INPUT", `Choose a supported ${what}.`);
  return value as T;
}
export function parseCustomThemes(value: unknown): CustomTheme[] {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_THEMES) throw new Fault("INVALID_INPUT", `Use at most ${MAX_CUSTOM_THEMES} custom themes.`);
  const ids = new Set<string>();
  return value.map(item => {
    const obj = exact(item, ["id", "name", "base", "accent", "background", "keyBody", "radius", "spacing", "font", ...(Object.hasOwn(record(item), "layout") ? ["layout"] : [])]);
    if (!isCustomThemeId(obj.id)) throw new Fault("INVALID_INPUT", "Invalid theme ID.");
    if (ids.has(obj.id)) throw new Fault("INVALID_INPUT", "Duplicate theme ID.");
    ids.add(obj.id);
    return { id: obj.id, name: label(obj.name), base: themeName(obj.base), accent: themeHex(obj.accent), background: themeHex(obj.background), keyBody: themeHex(obj.keyBody),
      radius: oneOf(obj.radius, themeRadii, "corner radius"), spacing: oneOf(obj.spacing, themeSpacings, "key spacing"), font: oneOf(obj.font, themeFonts, "font"),
      ...(Object.hasOwn(obj, "layout") ? { layout: parseThemeLayout(obj.layout) } : {}) };
  });
}
export interface AppInfo { id: string; name: string }
// Mac foreground-app usage is independent from keyln.config and shared by paired clients.
export interface AppRecent { status: "starting" | "observing" | "unavailable"; appIds: string[]; message?: string }
export function parseAppRecent(value: unknown): AppRecent {
  const obj = exact(value, ["status", "appIds", ...(Object.hasOwn(record(value), "message") ? ["message"] : [])]);
  if (!["starting", "observing", "unavailable"].includes(obj.status as string) || !Array.isArray(obj.appIds) || obj.appIds.length > 2048) throw new Fault("INVALID_INPUT", "Invalid Mac app usage reply.");
  const ids = obj.appIds.map(appId); if (new Set(ids).size !== ids.length) throw new Fault("INVALID_INPUT", "Duplicate Mac app usage entry.");
  return { status: obj.status as AppRecent["status"], appIds: ids, ...(obj.message !== undefined ? { message: label(obj.message, 300) } : {}) };
}
// T100 (ADR-090): a Finder window key may carry the folder it shows. The Mac switches to the Finder tab of that folder, or opens the folder when no tab shows it.
export const FINDER_APP_ID = "com.apple.finder";
export interface WindowInfo { title: string; minimized: boolean; path?: string }
export type WindowAction = { type: "window.activate"; appId: string; title: string; match: "exact" | "contains"; path?: string };
export interface WindowChoice { window: WindowInfo; id: string; ambiguous: boolean; folder?: string }
// Both window selectors use the target the Host can resolve: a Finder folder when present, otherwise a unique title.
export function windowChoices(app: string, windows: readonly WindowInfo[]): WindowChoice[] {
  const titles = new Map<string, number>();
  for (const window of windows) titles.set(window.title, (titles.get(window.title) ?? 0) + 1);
  const folders = new Set<string>();
  return windows.flatMap(window => {
    const folder = app === FINDER_APP_ID ? window.path : undefined;
    if (folder && folders.has(folder)) return [];
    if (folder) folders.add(folder);
    return [{ window, id: JSON.stringify([app, folder ? "folder" : "title", folder ?? window.title]), ambiguous: !folder && titles.get(window.title)! > 1,
      ...(folder ? { folder } : {}) }];
  });
}
export function windowTitle(value: unknown): string { return label(value, 256); }
// A full folder path as Finder reports it: absolute, no trailing slash (except "/"), no empty, "." or ".." parts, no control characters.
export function folderPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value) ||
      value !== "/" && (value.endsWith("/") || value.includes("//") || value.split("/").slice(1).some(part => part === "." || part === "..")))
    throw new Fault("INVALID_INPUT", "Use a full folder path such as /Users/me/Documents.");
  return value;
}
export function parseWindows(value: unknown): WindowInfo[] {
  if (!Array.isArray(value) || value.length > 64) throw new Fault("INVALID_INPUT", "Invalid Mac window list.");
  return value.map(item => {
    const obj = exact(item, ["title", "minimized", ...(Object.hasOwn(record(item), "path") ? ["path"] : [])]);
    if (typeof obj.minimized !== "boolean") throw new Fault("INVALID_INPUT", "Invalid Mac window state.");
    return {title: windowTitle(obj.title), minimized: obj.minimized, ...(obj.path !== undefined ? {path: folderPath(obj.path)} : {})};
  });
}
export const modifiers = ["command", "option", "control", "shift"] as const;
export type Modifier = typeof modifiers[number];
export const keyboardKeys = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map(letter => `Key${letter}`),
  ..."0123456789".split("").map(digit => `Digit${digit}`),
  "Enter", "Tab", "Space", "Backspace", "Escape", "Delete", "Home", "End", "PageUp", "PageDown",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Backquote", "Comma", "Period", "Slash",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
] as const;
export type ShellParameter = { name: string; kind: "text"; maxLength: number } |
  { name: string; kind: "choice"; choices: string[] } | { name: string; kind: "integer"; min: number; max: number };
export interface ScriptInfo { id: string; name: string; version: string; parameters: ShellParameter[] }
export interface ShortcutInfo { id: string; name: string }
export type ShortcutsAction = {type:"shortcuts.run";shortcutId:string;timeoutMs:number};
export interface ShellOutput { exitCode: number | null; signal: string | null; stdout: string; stderr: string; truncated: boolean }
export const MAX_SHELL_OUTPUT = 4096;
export type ShellAction = { type: "shell.run"; scriptId: string; version: string; args: string[] };
export type BasicAction = { type: "app.open"; appId: string } | { type: "keyboard.shortcut"; key: string; modifiers: Modifier[] } | ShellAction | ShortcutsAction | WindowAction;
export type Action = BasicAction | {type:"workflow.run";workflowId:string};
export const MAX_WORKFLOWS=32,MAX_WORKFLOW_STEPS=16,MAX_WORKFLOW_TIMEOUT=180_000;
export interface WorkflowStep {id:string;action:BasicAction;timeoutMs:number;requiresConfirmation?:boolean}
export interface Workflow {id:string;name:string;steps:WorkflowStep[];timeoutMs:number;requiresConfirmation?:boolean}
export interface StepExecution {id:string;actionType:BasicAction["type"];status:Exclude<RunStatus,"accepted">;startedAt:number;finishedAt?:number;message:string;code?:string;output?:ShellOutput}
export interface WorkflowResult {id:string;totalSteps:number;steps:StepExecution[]}
export interface KeyAppearance {
  style?: "tile" | "outline" | "plain";
  shape?: "rounded" | "circle" | "square";
  scale?: "small" | "medium" | "large";
  layout?: "stacked" | "horizontal" | "icon-only";
  tint?: string;
  glyph?: { type: "text"; text: string } | { type: "image"; data: string } | { type: "app" } | { type: "builtin" };
}
export const MAX_PAGES = 16;
export const MAX_WIDGETS = 512;
export const MAX_CONFIG_BYTES = 262_144;
// T65 (ADR-065): arrays are the shared order. Geometry belongs only to the current screen.
// T94 (ADR-086, ADR-087): the saved file is keyln.config v3 (a shared key library plus named layouts, ConfigDocument). The page and the Host's actions work on a merged
// "view" of one layout (Config, version 2 shape: keys carry their placement size) that viewFor() makes and splitView() takes apart again.
export const CONFIG_FORMAT = "keyln.config", CONFIG_VERSION = 3, VIEW_VERSION = 2;
export const gridSizes = ["compact", "standard", "large"] as const;
export type GridSize = typeof gridSizes[number];
export const GRID_CELL: Readonly<Record<GridSize, number>> = { compact: 88, standard: 112, large: 144 };
export function gridSize(value: unknown): GridSize { return oneOf(value, gridSizes, "grid size"); }
export interface Span { cols: number; rows: number }
export interface Cell { x: number; y: number }
export interface CellRect extends Cell, Span {}
export function sizeTier(value: unknown): SizeTier {
  if (!sizeTiers.includes(value as SizeTier)) throw new Fault("INVALID_INPUT", "Choose a size: S, M, L, XL, Tall or Wide.");
  return value as SizeTier;
}
export const componentKinds = ["key"] as const;
export type ComponentKind = typeof componentKinds[number];
export interface Component {
  id: string;
  kind: ComponentKind;
  size: SizeTier;
  label: string;
  icon: Icon;
  color?: ButtonColor;
  appearance?: KeyAppearance;
  requiresConfirmation?: boolean;
  action?: Action | null;
}
// The display widgets (ADR-057) and their forms.
export const displayKinds = ["clock", "text", "refresh", "codex-usage", "claude-usage"] as const;
export type DisplayKind = typeof displayKinds[number];
export const DISPLAY_FORMS: Readonly<Record<DisplayKind, readonly string[]>> = {
  clock: ["time"], text: ["title", "note"], refresh: ["button"], "codex-usage": ["quota"], "claude-usage": ["quota"],
};
export const MAX_WIDGET_TEXT = 80;
export interface DisplayWidget { id: string; kind: DisplayKind; size: SizeTier; form: string; text?: string }
// T88 (ADR-083): a blank is an empty place of one size in the order. It has no label, icon, action or text and never runs anything.
export interface BlankWidget { id: string; kind: "blank"; size: SizeTier }
export type FlatWidget = Component | DisplayWidget | BlankWidget;
export interface PageDef { id: string; name: string; widgets: FlatWidget[] }
// T91 (ADR-084): keys per row of a Pages widget, for wide windows and for narrow ones (at most NARROW_MAX_WIDTH px wide). A missing side is Auto: the global Grid size decides.
export interface PagesColumns { wide?: number; narrow?: number }
export const MAX_PAGES_COLUMNS = 16;
export interface PagesWidget { id: string; kind: "pages"; pages: PageDef[]; size?: PagesSize; columns?: PagesColumns }
export type Widget = FlatWidget | PagesWidget;
export const isPages = (widget: Pick<Widget, "kind">): widget is PagesWidget => widget.kind === "pages";
export const isBlank = (widget: Pick<Widget, "kind">): widget is BlankWidget => widget.kind === "blank";
export const isComponent = (widget: Pick<Widget, "kind">): widget is Component => (componentKinds as readonly string[]).includes(widget.kind);
// The merged view of one layout (T94). `revision` is the key library's revision (what running a key and a confirmation compare); `layoutName` and `layoutRevision`
// name the layout this view was made from and that layout's own revision. A document that was never made from a layout (an item file, a v1/v2 file) has neither.
export interface Config {
  format: typeof CONFIG_FORMAT;
  version: typeof VIEW_VERSION;
  revision: number;
  gridSize: GridSize;
  widgets: Widget[];
  workflows?: Workflow[];
  customThemes?: CustomTheme[];
  layoutName?: string;
  layoutRevision?: number;
}
// ---- keyln.config v3 (T94) ----
// A key as the library keeps it: a Component without its size (the size belongs to the placement in a layout).
export type Key = Omit<Component, "size">;
// A placement: the key `id` of the library, shown at this size. A layout never holds the key's content.
export interface Placement { id: string; kind: "key"; size: SizeTier }
export type LayoutFlat = Placement | DisplayWidget | BlankWidget;
export interface LayoutPage { id: string; name: string; widgets: LayoutFlat[] }
export interface LayoutPages { id: string; kind: "pages"; pages: LayoutPage[]; size?: PagesSize; columns?: PagesColumns }
export type LayoutWidget = LayoutFlat | LayoutPages;
export interface Library { revision: number; keys: Key[]; workflows?: Workflow[]; customThemes?: CustomTheme[] }
// T115 (ADR-099): `dock` is the Mac Dock bar of this layout. It is written only when on (a dock-off document stays byte-compatible with the previous Host).
// T117 (ADR-101): `dockOptions` are the Mac Dock's extra settings of this layout. Written only when at least one differs from its default (a switch only as `true`, `align` only as "left" or "right"); setting the last one back removes the field.
// It is independent of `dock` (turning the Dock off keeps the options). Adding an option: one more key here, one row in apps/web/mac-dock.ts, one more reader.
// T118 (ADR-102): an option is a `switch` (stored as `true`, default off) or a `choice` (stored as its value, the default is never written). `align` is where the capsule sits in the strip.
export const DOCK_ALIGNS = ["left", "center", "right"] as const;
export type DockAlign = typeof DOCK_ALIGNS[number];
export const DOCK_OPTION_SPECS = { hideKeyedApps: { kind: "switch" }, align: { kind: "choice", values: DOCK_ALIGNS, fallback: "center" } } as const;
export const DOCK_OPTION_KEYS = ["hideKeyedApps", "align"] as const;
export type DockOptionKey = typeof DOCK_OPTION_KEYS[number];
export type DockOptions = { hideKeyedApps?: true; align?: "left" | "right" };
/** The full map of the Dock options (every known key, its current value; the default for an option that is not stored). */
export type DockOptionMap = { hideKeyedApps: boolean; align: DockAlign };
export interface Layout { name: string; revision: number; theme: ThemeChoice; gridSize: GridSize; widgets: LayoutWidget[]; dock?: true; dockOptions?: DockOptions }
export interface ConfigDocument { format: typeof CONFIG_FORMAT; version: typeof CONFIG_VERSION; library: Library; layouts: Layout[]; defaultLayout: string }
// What a save carries: the library part (the keys the page shows, all workflows and custom themes) and/or the layout part (grid size and widgets). Absent: unchanged.
export interface LibraryContent { keys: Key[]; workflows?: Workflow[]; customThemes?: CustomTheme[] }
export interface LayoutContent { gridSize: GridSize; widgets: LayoutWidget[] }
export interface SplitView { library?: LibraryContent; layout?: LayoutContent }
export const MAX_LAYOUTS = 16, MAX_LIBRARY_KEYS = 1024;
export interface Trigger { requestId: string; componentId: string; revision: number; confirmation?:string }
export type RunStatus = "accepted" | "running" | "succeeded" | "failed" | "unknown";
export interface Execution {
  id: string;
  requestId: string;
  status: RunStatus;
  actionType: Action["type"];

  createdAt: number;
  finishedAt?: number;
  code?: string;
  message: string;
  output?: ShellOutput;
  workflow?:WorkflowResult;
}
export const EVENT_PATH = "/api/events";
// T115 (ADR-099): v4 adds the running-apps event. The Host still accepts v3 pages (they never receive it); this page offers v4 only.
export const EVENT_PROTOCOL_V3 = "keyln.events.v3";
export const EVENT_PROTOCOL = "keyln.events.v4";
export const EVENT_PROTOCOLS: readonly string[] = [EVENT_PROTOCOL, EVENT_PROTOCOL_V3];
export const MAX_EVENT_MESSAGE_BYTES = 1024;
export interface StateEvent {
  type: "state";
  version: 2;
  instanceId: string;
  sequence: number;
  // T94: the key library's revision, and the revision of the layout assigned to the device this event goes to.
  revision: number;
  layoutRevision: number;
  busy: boolean;
}
export function parseStateEvent(value: unknown): StateEvent {
  const obj = exact(value, ["type", "version", "instanceId", "sequence", "revision", "layoutRevision", "busy"]);
  if (obj.type !== "state" || typeof obj.busy !== "boolean")
    throw new Fault("INVALID_INPUT", "Unsupported state event.");
  return { type: "state", ...eventHeader(obj), revision: revision(obj.revision), layoutRevision: revision(obj.layoutRevision), busy: obj.busy };
}
export interface ExecutionEvent {
  type: "execution";
  version: 2;
  instanceId: string;
  sequence: number;
  execution: Execution;
}
// T115 (ADR-099): the Mac apps the Dock bar shows, already merged and ordered by the helper. At most MAX_DOCK_APPS entries.
export const MAX_DOCK_APPS = 64;
export interface DockApp { appId: string; name: string; active: boolean; hidden: boolean }
export function parseDockApp(value: unknown): DockApp {
  const obj = exact(value, ["appId", "name", "active", "hidden"]);
  if (typeof obj.active !== "boolean" || typeof obj.hidden !== "boolean") throw new Fault("INVALID_INPUT", "Invalid running app.");
  return { appId: appId(obj.appId), name: label(obj.name, 80), active: obj.active, hidden: obj.hidden };
}
export function parseDockApps(value: unknown): DockApp[] {
  if (!Array.isArray(value) || value.length > MAX_DOCK_APPS) throw new Fault("INVALID_INPUT", `Use at most ${MAX_DOCK_APPS} running apps.`);
  const apps = value.map(parseDockApp);
  if (new Set(apps.map(app => app.appId)).size !== apps.length) throw new Fault("INVALID_INPUT", "Running apps must be distinct.");
  return apps;
}
// "starting": the observer was just started and has not sent its first list (the page shows nothing yet rather than "unavailable").
export interface RunningApps { status: "ready" | "starting" | "unavailable"; apps: DockApp[] }
export function parseRunningApps(value: unknown): RunningApps {
  const obj = exact(value, ["status", "apps"]);
  if (obj.status !== "ready" && obj.status !== "starting" && obj.status !== "unavailable") throw new Fault("INVALID_INPUT", "Invalid running apps status.");
  const apps = parseDockApps(obj.apps);
  if (obj.status !== "ready" && apps.length) throw new Fault("INVALID_INPUT", "Only a ready list has apps.");
  return { status: obj.status, apps };
}
export interface RunningAppsEvent extends RunningApps { type: "running-apps"; version: 2; instanceId: string; sequence: number }
export function parseRunningAppsEvent(value: unknown): RunningAppsEvent {
  const obj = exact(value, ["type", "version", "instanceId", "sequence", "status", "apps"]);
  if (obj.type !== "running-apps") throw new Fault("INVALID_INPUT", "Unsupported event type.");
  return { type: "running-apps", ...eventHeader(obj), ...parseRunningApps({ status: obj.status, apps: obj.apps }) };
}
export type HostEvent = StateEvent | ExecutionEvent | RunningAppsEvent;
function eventHeader(obj: Record<string, unknown>): Pick<HostEvent, "version" | "instanceId" | "sequence"> {
  if (obj.version !== 2 || !Number.isSafeInteger(obj.sequence) || (obj.sequence as number) < 1)
    throw new Fault("INVALID_INPUT", "Unsupported event version or sequence.");
  return { version: 2, instanceId: requestId(obj.instanceId), sequence: obj.sequence as number };
}
export function parseExecution(value: unknown): Execution {
  const obj = record(value);
  const required = ["id", "requestId", "status", "actionType", "createdAt", "message"];
  const optional = ["finishedAt", "code", "output", "workflow"].filter(key => Object.hasOwn(obj, key));
  exact(obj, [...required, ...optional]);
  if (!["accepted", "running", "succeeded", "failed", "unknown"].includes(obj.status as string) ||
      !["app.open", "window.activate", "keyboard.shortcut", "shell.run", "shortcuts.run", "workflow.run"].includes(obj.actionType as string) ||
      !Number.isSafeInteger(obj.createdAt) || (obj.createdAt as number) < 0 ||
      typeof obj.message !== "string" || !obj.message.length || obj.message.length > 300)
    throw new Fault("INVALID_INPUT", "Invalid execution result.");
  const terminal = !["accepted", "running"].includes(obj.status as string);
  if (terminal !== Object.hasOwn(obj, "finishedAt") ||
      (terminal && (!Number.isSafeInteger(obj.finishedAt) || (obj.finishedAt as number) < 0)) ||
      (Object.hasOwn(obj, "code") && (!terminal || typeof obj.code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(obj.code))))
    throw new Fault("INVALID_INPUT", "Invalid execution completion.");
  if (Object.hasOwn(obj, "output") && (!terminal || obj.actionType !== "shell.run"))
    throw new Fault("INVALID_INPUT", "Only a completed Shell action may include output.");
  if(Object.hasOwn(obj,"workflow")&&obj.actionType!=="workflow.run")throw new Fault("INVALID_INPUT","Unexpected workflow result.");
  return { id: requestId(obj.id), requestId: requestId(obj.requestId), status: obj.status as RunStatus,
    actionType: obj.actionType as Action["type"], createdAt: obj.createdAt as number, message: obj.message,
    ...(terminal ? { finishedAt: obj.finishedAt as number } : {}), ...(obj.code !== undefined ? { code: obj.code as string } : {}),
    ...(Object.hasOwn(obj, "output") ? { output: parseShellOutput(obj.output) } : {}),
    ...(Object.hasOwn(obj,"workflow")?{workflow:parseWorkflowResult(obj.workflow,terminal)}:{}) };
}
export function parseHostEvent(value: unknown): HostEvent {
  if (record(value).type === "state") return parseStateEvent(value);
  if (record(value).type === "running-apps") return parseRunningAppsEvent(value);
  const obj = exact(value, ["type", "version", "instanceId", "sequence", "execution"]);
  if (obj.type !== "execution") throw new Fault("INVALID_INPUT", "Unsupported event type.");
  return { type: "execution", ...eventHeader(obj), execution: parseExecution(obj.execution) };
}
export function parseEventRequest(value: unknown): { type: "sync" } {
  const obj = exact(value, ["type"]);
  if (obj.type !== "sync") throw new Fault("INVALID_INPUT", "Only state synchronization is allowed on this channel.");
  return { type: "sync" };
}
export class Fault extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Fault("INVALID_INPUT", "Expected a JSON object.");
  return value as Record<string, unknown>;
}
export function exact(value: unknown, keys: string[]): Record<string, unknown> {
  const obj = record(value);
  if (Object.keys(obj).length !== keys.length || keys.some(key => !Object.hasOwn(obj, key)))
    throw new Fault("INVALID_INPUT", "Unexpected or missing fields.");
  return obj;
}
export function label(value: unknown, max = 40): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\x00-\x1f\x7f]/u.test(value))
    throw new Fault("INVALID_INPUT", `Enter 1–${max} characters without control characters.`);
  return value.trim();
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Fault("INVALID_INPUT", "Invalid configuration revision.");
  return value as number;
}
export function appId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value))
    throw new Fault("INVALID_INPUT", "Invalid application identifier.");
  return value;
}
export function icon(value: unknown): Icon {
  if (typeof value !== "string" || !Object.hasOwn(icons, value))
    throw new Fault("INVALID_INPUT", "Choose a built-in icon.");
  return value as Icon;
}
export function requestId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new Fault("INVALID_INPUT", "Invalid request ID.");
  return value;
}
export function parseTrigger(value: unknown): Trigger {
  const obj = exact(value, ["requestId", "componentId", "revision",...(Object.hasOwn(record(value),"confirmation")?["confirmation"]:[])]);
  return { requestId: requestId(obj.requestId), componentId: stableId(obj.componentId), revision: revision(obj.revision),...(Object.hasOwn(obj,"confirmation")?{confirmation:requestId(obj.confirmation)}:{}) };
}
export function stableId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value))
    throw new Fault("INVALID_INPUT", "Invalid stable ID.");
  return value;
}
export function scriptVersion(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Fault("INVALID_INPUT", "Choose a specific approved script version.");
  return value;
}
export function shellArgument(value: unknown): string {
  if (typeof value !== "string" || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value))
    throw new Fault("INVALID_INPUT", "Script arguments must be plain text of at most 256 characters.");
  return value;
}
export function parseShellParameters(value: unknown): ShellParameter[] {
  if (!Array.isArray(value) || value.length > 8) throw new Fault("INVALID_INPUT", "Use at most eight script parameters.");
  const names = new Set<string>();
  return value.map(item => {
    const candidate = record(item), name = label(candidate.name, 24);
    if (names.has(name)) throw new Fault("INVALID_INPUT", "Parameter names must be unique.");
    names.add(name);
    if (candidate.kind === "text") {
      const obj = exact(item, ["name", "kind", "maxLength"]);
      if (!Number.isInteger(obj.maxLength) || (obj.maxLength as number) < 1 || (obj.maxLength as number) > 256)
        throw new Fault("INVALID_INPUT", "Text parameter limits must be between 1 and 256.");
      return { name, kind: "text", maxLength: obj.maxLength as number };
    }
    if (candidate.kind === "choice") {
      const obj = exact(item, ["name", "kind", "choices"]);
      if (!Array.isArray(obj.choices) || !obj.choices.length || obj.choices.length > 16)
        throw new Fault("INVALID_INPUT", "Use 1–16 allowed values per choice parameter.");
      const choices = obj.choices.map(value => label(value, 80));
      if (new Set(choices).size !== choices.length) throw new Fault("INVALID_INPUT", "Allowed parameter values must be unique.");
      return { name, kind: "choice", choices };
    }
    const obj = exact(item, ["name", "kind", "min", "max"]);
    if (obj.kind !== "integer" || !Number.isSafeInteger(obj.min) || !Number.isSafeInteger(obj.max) ||
        (obj.min as number) < -1_000_000 || (obj.max as number) > 1_000_000 || (obj.min as number) > (obj.max as number))
      throw new Fault("INVALID_INPUT", "Integer parameter bounds must be between -1000000 and 1000000.");
    return { name, kind: "integer", min: obj.min as number, max: obj.max as number };
  });
}
export function validateShellArguments(parameters: ShellParameter[], args: string[]): void {
  if (parameters.length !== args.length) throw new Fault("SCRIPT_ARGUMENTS", "Fill in each approved script parameter.");
  for (let i = 0; i < parameters.length; i++) {
    const rule = parameters[i]!, value = shellArgument(args[i]);
    if (rule.kind === "choice" && !rule.choices.includes(value) || rule.kind === "text" && value.length > rule.maxLength ||
        rule.kind === "integer" && (!/^-?(0|[1-9][0-9]*)$/.test(value) || Number(value) < rule.min || Number(value) > rule.max))
      throw new Fault("SCRIPT_ARGUMENTS", "A script parameter does not match its approved rule.");
  }
}
export function parseScriptInfo(value: unknown): ScriptInfo {
  const obj = exact(value, ["id", "name", "version", "parameters"]);
  return { id: stableId(obj.id), name: label(obj.name), version: scriptVersion(obj.version), parameters: parseShellParameters(obj.parameters) };
}
export function parseShellOutput(value: unknown): ShellOutput {
  const obj = exact(value, ["exitCode", "signal", "stdout", "stderr", "truncated"]);
  if (obj.exitCode !== null && (!Number.isInteger(obj.exitCode) || (obj.exitCode as number) < 0 || (obj.exitCode as number) > 255) ||
      obj.signal !== null && (typeof obj.signal !== "string" || !/^SIG[A-Z0-9]{1,16}$/.test(obj.signal)) ||
      typeof obj.stdout !== "string" || typeof obj.stderr !== "string" || obj.stdout.length + obj.stderr.length > MAX_SHELL_OUTPUT || typeof obj.truncated !== "boolean")
    throw new Fault("INVALID_INPUT", "Invalid bounded script output.");
  return { exitCode: obj.exitCode as number | null, signal: obj.signal as string | null,
    stdout: obj.stdout as string, stderr: obj.stderr as string, truncated: obj.truncated };
}
export function parseAction(value: unknown): Action {
  const candidate = record(value);
  if (candidate.type === "window.activate") {
    const obj = exact(value, ["type", "appId", "title", "match", ...(Object.hasOwn(candidate, "path") ? ["path"] : [])]);
    if (obj.match !== "exact" && obj.match !== "contains") throw new Fault("INVALID_INPUT", "Choose exact or contains for the window title match.");
    const app = appId(obj.appId);
    if (obj.path !== undefined && app !== FINDER_APP_ID) throw new Fault("INVALID_INPUT", "Only Finder window keys have a folder path.");
    return {type: "window.activate", appId: app, title: windowTitle(obj.title), match: obj.match, ...(obj.path !== undefined ? {path: folderPath(obj.path)} : {})};
  }
  if (candidate.type === "app.open") {
    const obj = exact(value, ["type", "appId"]);
    return { type: "app.open", appId: appId(obj.appId) };
  }
  if (candidate.type === "keyboard.shortcut") {
    const obj = exact(value, ["type", "key", "modifiers"]);
    const selected = obj.modifiers;
    if (typeof obj.key !== "string" || !keyboardKeys.includes(obj.key))
      throw new Fault("INVALID_INPUT", "Choose a supported keyboard key.");
    if (!Array.isArray(selected) || selected.length > 4 ||
        new Set(selected).size !== selected.length ||
        selected.some(modifier => !modifiers.includes(modifier)))
      throw new Fault("INVALID_INPUT", "Choose each supported modifier at most once.");
    return { type: "keyboard.shortcut", key: obj.key, modifiers: modifiers.filter(modifier => selected.includes(modifier)) };
  }
  if (candidate.type === "shell.run") {
    const obj = exact(value, ["type", "scriptId", "version", "args"]);
    if (!Array.isArray(obj.args) || obj.args.length > 8) throw new Fault("INVALID_INPUT", "Use at most eight script arguments.");
    return { type: "shell.run", scriptId: stableId(obj.scriptId), version: scriptVersion(obj.version), args: obj.args.map(shellArgument) };
  }
  if(candidate.type === "shortcuts.run"){
    const obj=exact(value,["type","shortcutId","timeoutMs"]);
    return {type:"shortcuts.run",shortcutId:shortcutId(obj.shortcutId),timeoutMs:actionTimeout(obj.timeoutMs)};
  }
  if(candidate.type==="workflow.run"){const obj=exact(value,["type","workflowId"]);return {type:"workflow.run",workflowId:stableId(obj.workflowId)};}
  throw new Fault("INVALID_INPUT", "Unsupported action type.");
}
export function shortcutId(value:unknown):string {
  if(typeof value!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new Fault("INVALID_INPUT","Choose a Mac shortcut identifier.");
  return value.toUpperCase();
}
export function actionTimeout(value:unknown,max=60_000):number {
  if(!Number.isInteger(value)||(value as number)<100||(value as number)>max)throw new Fault("INVALID_INPUT",`Use a timeout from 100 to ${max} ms.`);
  return value as number;
}
export function parseShortcutInfo(value:unknown):ShortcutInfo {
  const obj=exact(value,["id","name"]);return {id:shortcutId(obj.id),name:label(obj.name,200)};
}
export function keyLabel(key: string): string {
  return key.startsWith("Key") ? key.slice(3) : key.startsWith("Digit") ? key.slice(5) : key;
}
export function shortcutLabel(action: Extract<Action, { type: "keyboard.shortcut" }>): string {
  const symbols: Record<Modifier, string> = { command: "⌘", option: "⌥", control: "⌃", shift: "⇧" };
  return [...action.modifiers.map(modifier => symbols[modifier]), keyLabel(action.key)].join(" + ");
}
export const DEFAULT_LAYOUT_NAME = "Surface";
// A new data directory starts with an empty key library and one layout named "Surface" (T94).
export function initialConfig(): ConfigDocument {
  return { format: CONFIG_FORMAT, version: CONFIG_VERSION, library: { revision: 0, keys: [] },
    layouts: [{ name: DEFAULT_LAYOUT_NAME, revision: 0, theme: DEFAULT_THEME, gridSize: "standard",
      widgets: [{ id: "main", kind: "pages", pages: [{ id: "page-1", name: "Page 1", widgets: [] }] }] }],
    defaultLayout: DEFAULT_LAYOUT_NAME };
}
// The view of an empty configuration (the page's shape, version 2; what initialConfig() looked like before T94).
export function initialView(): Config { return viewFor(initialConfig(), DEFAULT_LAYOUT_NAME); }
// ---- placement (ADR-064): whole cells, inside the container, never overlapping ----
function integer(value: unknown, min: number, max: number, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Fault("INVALID_INPUT", `${what} must be a whole number from ${min} to ${max}.`);
  return value as number;
}
export const widgetSpan = (widget: Widget): Span => isPages(widget) ? { cols: (widget.size?.w.mode === "fixed" ? widget.size.w.u : 480) / 120, rows: (widget.size?.h.mode === "fixed" ? widget.size.h.u : 240) / 120 } : widgetPresetSpan(widget);
export const rectsOverlap = (a: CellRect, b: CellRect): boolean => a.x < b.x + b.cols && b.x < a.x + a.cols && a.y < b.y + b.rows && b.y < a.y + a.rows;
export const rectInside = (rect: CellRect, area: Span): boolean => rect.x >= 0 && rect.y >= 0 && rect.x + rect.cols <= area.cols && rect.y + rect.rows <= area.rows;
// Every key of the configuration, canvas first, then the pages of each Pages widget in order.
export function allComponents(config: Pick<Config, "widgets">): Component[] {
  const found: Component[] = [];
  for (const widget of config.widgets) {
    if (isPages(widget)) { for (const page of widget.pages) for (const inner of page.widgets) if (isComponent(inner)) found.push(inner); }
    else if (isComponent(widget)) found.push(widget);
  }
  return found;
}
export const findComponent = (config: Pick<Config, "widgets">, id: string): Component | undefined => allComponents(config).find(item => item.id === id);
// Where a widget lives: on the canvas, or on a page of a Pages widget.
export interface Location { widget: Widget; parent?: PagesWidget; page?: PageDef }
export function locate(config: Pick<Config, "widgets">, id: string): Location | undefined {
  for (const widget of config.widgets) {
    if (widget.id === id) return { widget };
    if (isPages(widget)) for (const page of widget.pages) for (const inner of page.widgets) if (inner.id === id) return { widget: inner, parent: widget, page };
  }
  return undefined;
}
export const MAX_ICON_BYTES = 24_576;
export function imageDimensions(bytes: Uint8Array, mime: "image/png" | "image/webp"): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (mime === "image/png" && bytes.length >= 33 && [137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n) &&
      ascii(12,16) === "IHDR" && view.getUint32(8) === 13)
    return { width: view.getUint32(16), height: view.getUint32(20) };
  if (mime === "image/webp" && bytes.length >= 30 && ascii(0,4) === "RIFF" && ascii(8,12) === "WEBP" && view.getUint32(4,true) + 8 === bytes.length) {
    const kind = ascii(12,16);
    if (kind === "VP8X") return { width: 1 + view.getUint8(24) + (view.getUint8(25) << 8) + (view.getUint8(26) << 16),
      height: 1 + view.getUint8(27) + (view.getUint8(28) << 8) + (view.getUint8(29) << 16) };
    if (kind === "VP8 " && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42)
      return { width: view.getUint16(26,true) & 0x3fff, height: view.getUint16(28,true) & 0x3fff };
    if (kind === "VP8L" && bytes[20] === 47) {
      const bits = view.getUint32(21,true); return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
  }
  throw new Fault("INVALID_INPUT", "Choose a PNG or WebP image.");
}
// Reads only the JPEG frame header. Layouts never store JPEG: imageIcon() still accepts PNG/WebP alone.
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) { offset += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) break;
      const length = (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (length < 8) break;
        const height = (bytes[offset + 5]! << 8) + bytes[offset + 6]!, width = (bytes[offset + 7]! << 8) + bytes[offset + 8]!;
        if (width < 1 || height < 1) break;
        return { width, height };
      }
      offset += 2 + length;
    }
  }
  throw new Fault("INVALID_INPUT", "Choose a valid JPEG image.");
}
export function imageIcon(value: unknown): string {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_ICON_BYTES / 3) * 4 + 24)
    throw new Fault("INVALID_INPUT", "Keep an icon image within 24 KiB.");
  const match = /^data:(image\/(?:png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2]!.length % 4) throw new Fault("INVALID_INPUT", "Only embedded PNG or WebP icons are supported.");
  let binary: string;
  try { binary = atob(match[2]!); } catch { throw new Fault("INVALID_INPUT", "Invalid image encoding."); }
  if (binary.length > MAX_ICON_BYTES || btoa(binary) !== match[2]) throw new Fault("INVALID_INPUT", "Invalid or oversized image encoding.");
  const dimensions = imageDimensions(Uint8Array.from(binary, char => char.charCodeAt(0)), match[1] as "image/png" | "image/webp");
  if (dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 256 || dimensions.height > 256)
    throw new Fault("INVALID_INPUT", "Icon images must be at most 256 × 256 pixels.");
  return value;
}
// T31/T32: the curated Iconify icon sets, shared by Host and page. Names and licences were read from
// https://api.iconify.design/collections on 2026-10-19 and are frozen here; nothing asks Iconify again at run time.
// T32 also allows searching every Iconify set; those sets only ever carry the name and licence that Iconify's own
// search answer gave for them (see iconLabel), never anything from this table.
export const ICON_SETS = [
  { prefix: "material-symbols", name: "Material Symbols", license: "Apache-2.0" },
  { prefix: "lucide", name: "Lucide", license: "ISC" },
  { prefix: "tabler", name: "Tabler Icons", license: "MIT" },
  { prefix: "ph", name: "Phosphor", license: "MIT" },
  { prefix: "fluent", name: "Fluent UI System Icons", license: "MIT" },
  { prefix: "simple-icons", name: "Simple Icons", license: "CC0-1.0", brand: true },
] as const;
export type IconSetPrefix = typeof ICON_SETS[number]["prefix"];
export type IconScope = "curated" | "all";
export const ICON_UNKNOWN_LICENSE = "Unknown license";
// A search of all Iconify sets keeps the icons of at most this many distinct sets (the first ones in Iconify's own order).
export const ICON_PREFIX_LIMIT = 12;
// `set` is any well-formed Iconify prefix (T32); setName and license are what My icons shows for it.
export interface LibraryIcon { id: string; set: string; name: string; svg: string; addedAt: number; setName: string; license: string }
export const MAX_SVG_BYTES = 16_384, MAX_SVG_ELEMENTS = 500, MAX_SVG_DEPTH = 24, MAX_SVG_USE = 16;
export const curatedIconSet = (prefix: unknown) => ICON_SETS.find(set => set.prefix === prefix);
/** Curated sets only: the filter inside a curated search. */
export function iconSet(value: unknown): IconSetPrefix {
  const found = curatedIconSet(value);
  if (!found) throw new Fault("INVALID_INPUT", "Choose one of the listed icon sets.");
  return found.prefix;
}
export function iconScope(value: unknown): IconScope {
  if (value !== "curated" && value !== "all") throw new Fault("INVALID_INPUT", "Search the curated sets or all Iconify sets.");
  return value;
}
/** Shape only: any Iconify prefix passes, so this never decides which sets may be searched. */
export function iconPrefix(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Fault("INVALID_INPUT", "Invalid icon set.");
  return value;
}
export function iconName(value: unknown): string {
  if (typeof value !== "string" || value.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))
    throw new Fault("INVALID_INPUT", "Invalid icon name.");
  return value;
}
export function iconId(value: unknown): { id: string; set: string; name: string } {
  const parts = typeof value === "string" ? value.split(":") : [];
  if (parts.length !== 2) throw new Fault("INVALID_INPUT", "Invalid icon ID.");
  const set = iconPrefix(parts[0]), name = iconName(parts[1]);
  return { id: `${set}:${name}`, set, name };
}
// A set name or licence that came from outside (Iconify, a stored file, the Host) is shown to the person, so it must be
// one short line of printable text: no control, format or separator characters other than a plain space, at most 80 characters.
export function iconLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && Array.from(text).length <= 80 && /^(?:[^\p{C}\p{Z}]| )+$/u.test(text) ? text : undefined;
}
// Search words are the only free text that ever leaves the Mac, so they stay short, printable and English:
// Chinese is turned into English words on the page before this runs (T32), and anything else outside ASCII is refused here.
export function iconQuery(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const query = raw.trim().replace(/ +/gu, " "), length = Array.from(query).length;
  if (length < 2 || length > 64 || !/^[\x20-\x7e]+$/.test(raw))
    throw new Fault("INVALID_INPUT", "Search for 2 to 64 English letters or digits.");
  return query;
}
const SVG_ELEMENTS = new Set(["svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "defs", "clipPath",
  "mask", "linearGradient", "radialGradient", "stop", "use", "symbol", "title", "desc"]);
// Defence in depth for stored library icons. The page only ever shows them through <img src="data:image/svg+xml">,
// which never runs script, but the Host still refuses anything beyond plain drawing markup before it keeps a copy.
// Element names are a whitelist; document type, entities, comments, processing instructions and CDATA are refused outright.
export function iconSvg(value: unknown): string {
  const bad = (reason: string): never => { throw new Fault("INVALID_INPUT", `This SVG was rejected: ${reason}.`); };
  if (typeof value !== "string" || !value) return bad("it is empty");
  const text = value;
  if (new TextEncoder().encode(text).length > MAX_SVG_BYTES) bad("it is larger than 16 KiB");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) bad("it contains control characters");
  if (/<[!?]|\]\]>/.test(text)) bad("it has a document type, entity, comment, stylesheet, CDATA or processing instruction");
  if (!/^\s*<svg[\s/>]/.test(text)) bad("the root element is not <svg>");
  const entity = /&(?!(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});)/;
  const decoded = (raw: string) => raw.replace(/&#x([0-9a-fA-F]{1,6});/g, (_, hex: string) => String.fromCodePoint(Math.min(0x10ffff, parseInt(hex, 16))))
    .replace(/&#([0-9]{1,7});/g, (_, digits: string) => String.fromCodePoint(Math.min(0x10ffff, Number(digits)))).replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name]!);
  const tag = /<(\/?)([A-Za-z][A-Za-z0-9:._-]*)((?:\s+[^\s"'<>\/=]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
  const attribute = /\s+([^\s"'<>\/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const stack: string[] = []; let index = 0, root = false, count = 0, uses = 0;
  for (;;) {
    const open = text.indexOf("<", index), chunk = text.slice(index, open < 0 ? text.length : open);
    if (entity.test(chunk)) bad("it uses an unknown entity");
    if (chunk.trim() && !["title", "desc"].includes(stack.at(-1) ?? "")) bad("it has text outside <title> and <desc>");
    if (open < 0) break;
    tag.lastIndex = open;
    const match = tag.exec(text);
    if (!match) return bad("the markup is malformed");
    index = tag.lastIndex;
    const [, closing = "", name = "", attributes = "", selfClosing = ""] = match;
    if (!SVG_ELEMENTS.has(name)) bad(`<${name}> is not allowed`);
    if (closing) { if (attributes.trim() || selfClosing || stack.pop() !== name) bad("the tags are not balanced"); continue; }
    if (!stack.length) { if (root) bad("it has more than one root element"); root = true; }
    if (++count > MAX_SVG_ELEMENTS || name === "use" && ++uses > MAX_SVG_USE) bad("it has too many elements");
    const seen = new Set<string>();
    for (const [, key = "", double, single] of attributes.matchAll(attribute)) {
      const raw = double ?? single ?? "", content = decoded(raw);
      if (seen.has(key)) bad("an attribute is repeated"); seen.add(key);
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(key)) bad("an attribute name is invalid");
      if (/^on/i.test(key)) bad("event attributes are not allowed");
      if (entity.test(raw)) bad("it uses an unknown entity");
      if (/(?:^|:)href$/i.test(key) && !content.startsWith("#")) bad("links may only point inside the image");
      if (/url\s*\((?!\s*['"]?#)/i.test(content)) bad("url() may only point inside the image");
      if (/javascript:|[\\]/i.test(content)) bad("an attribute value is not allowed");
    }
    if (!selfClosing) { stack.push(name); if (stack.length > MAX_SVG_DEPTH) bad("it is nested too deeply"); }
  }
  if (!root || stack.length) bad("the tags are not balanced");
  return value;
}
// data: is the only image URL form the page CSP allows; the SVG text is wrapped, never inserted into the page.
export function svgDataUrl(text: string): string {
  const bytes = new TextEncoder().encode(text); let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}
export function parseAppearance(value: unknown): KeyAppearance {
  const candidate = record(value), fields = ["style", "shape", "scale", "layout", "tint", "glyph"];
  const obj = exact(value, fields.filter(field => Object.hasOwn(candidate, field))), result: KeyAppearance = {};
  for (const [field, choices] of [["style",["tile","outline","plain"]], ["shape",["rounded","circle","square"]],
    ["scale",["small","medium","large"]], ["layout",["stacked","horizontal","icon-only"]]] as const) {
    if (Object.hasOwn(obj, field)) {
      if (!(choices as readonly unknown[]).includes(obj[field])) throw new Fault("INVALID_INPUT", "Choose a supported icon style.");
      Object.assign(result, { [field]: obj[field] });
    }
  }
  if (Object.hasOwn(obj, "tint")) {
    if (typeof obj.tint !== "string" || !/^#[0-9a-f]{6}$/i.test(obj.tint)) throw new Fault("INVALID_INPUT", "Choose a six-digit color.");
    result.tint = obj.tint.toUpperCase();
  }
  if (Object.hasOwn(obj, "glyph")) {
    const glyph = record(obj.glyph);
    if (glyph.type === "text") {
      exact(glyph, ["type", "text"]); const text = label(glyph.text, 24);
      if (Array.from(text).length > 8) throw new Fault("INVALID_INPUT", "Use up to eight characters for a text or Emoji icon.");
      result.glyph = { type: "text", text };
    } else if (glyph.type === "app" || glyph.type === "builtin") {
      exact(glyph, ["type"]); result.glyph = { type: glyph.type };
    } else {
      exact(glyph, ["type", "data"]);
      if (glyph.type !== "image") throw new Fault("INVALID_INPUT", "Choose a supported icon source.");
      result.glyph = { type: "image", data: imageIcon(glyph.data) };
    }
  }
  return result;
}
function widgetText(value: unknown): string {
  if (typeof value !== "string" || Array.from(value).length > MAX_WIDGET_TEXT || /[\u0000-\u001f\u007f]/.test(value))
    throw new Fault("INVALID_INPUT", `Text is at most ${MAX_WIDGET_TEXT} characters on one line.`);
  return value;
}
// `placements`: the widgets are those of a v3 layout, where a key is only a placement (id, kind, size).
interface WidgetContext { ids: Set<string>; placements?: boolean }
function parseFlat(value: unknown, context: WidgetContext, allowPages: false): FlatWidget;
function parseFlat(value: unknown, context: WidgetContext, allowPages: true): Widget;
function parseFlat(value: unknown, context: WidgetContext, allowPages: boolean): Widget {
  const source = record(value), kind = source.kind;
  const id = stableId(source.id);
  if (context.ids.has(id)) throw new Fault("INVALID_INPUT", "Duplicate widget ID.");
  context.ids.add(id);
  if (kind === "pages") {
    if (!allowPages) throw new Fault("INVALID_INPUT", "A Pages widget cannot hold another Pages widget.");
    if (Object.hasOwn(source, "dimensions") && Object.hasOwn(source, "size")) throw new Fault("INVALID_INPUT", "Pages cannot have both size and dimensions.");
    const obj = exact(value, ["id", "kind", "pages", ...(Object.hasOwn(source, "dimensions") ? ["dimensions"] : []), ...(Object.hasOwn(source, "size") ? ["size"] : []), ...(Object.hasOwn(source, "columns") ? ["columns"] : [])]);
    let columns: PagesColumns | undefined;
    if (Object.hasOwn(obj, "columns")) {
      const found = record(obj.columns), keys = Object.keys(found);
      if (!keys.length || keys.some(name => name !== "wide" && name !== "narrow")) throw new Fault("INVALID_INPUT", "Keys per row are set for wide and narrow screens only.");
      columns = {};
      for (const side of ["wide", "narrow"] as const) if (Object.hasOwn(found, side)) columns[side] = integer(found[side], 1, MAX_PAGES_COLUMNS, "Keys per row");
    }
    const dimensions = Object.hasOwn(obj, "dimensions") ? exact(obj.dimensions, ["w", "h"]) : undefined;
    let size: PagesSize | undefined;
    if (dimensions) size = { w: { mode: "fixed", u: integer(dimensions.w, 1, PAGES_SIZE_BOUNDS.max.w, "Pages width") }, h: { mode: "fixed", u: integer(dimensions.h, 1, PAGES_SIZE_BOUNDS.max.h, "Pages height") } };
    else if (Object.hasOwn(obj, "size")) {
      const axes = exact(obj.size, ["w", "h"]);
      const axis = (value: unknown, name: "w" | "h"): PagesWidth | PagesHeight => {
        const source = record(value);
        if (source.mode === "fixed") { const a = exact(value, ["mode", "u"]); return { mode: "fixed", u: integer(a.u, 1, PAGES_SIZE_BOUNDS.max[name], "Pages size") }; }
        if (source.mode === "fill") { const a = exact(value, ["mode", "min"]); return { mode: "fill", min: integer(a.min, 1, PAGES_SIZE_BOUNDS.max[name], "Pages minimum") }; }
        if (name === "w" && source.mode === "percent") { const a = exact(value, ["mode", "pct"]); return { mode: "percent", pct: integer(a.pct, 1, 100, "Pages percent") }; }
        throw new Fault("INVALID_INPUT", "Invalid Pages size mode.");
      };
      size = { w: axis(axes.w, "w") as PagesWidth, h: axis(axes.h, "h") as PagesHeight };
    }
    if (!Array.isArray(obj.pages) || obj.pages.length < 1 || obj.pages.length > MAX_PAGES) throw new Fault("INVALID_INPUT", `Use 1–${MAX_PAGES} pages in a Pages widget.`);
    const pages: PageDef[] = obj.pages.map(raw => {
      const page = exact(raw, ["id", "name", "widgets"]), pageId = stableId(page.id);
      if (context.ids.has(pageId)) throw new Fault("INVALID_INPUT", "Duplicate page ID.");
      context.ids.add(pageId);
      if (!Array.isArray(page.widgets)) throw new Fault("INVALID_INPUT", "A page holds a list of widgets.");
      const widgets = page.widgets.map(item => parseFlat(item, context, false));
      return { id: pageId, name: label(page.name), widgets };
    });
    return { id, kind: "pages", pages, ...(size ? { size } : {}), ...(columns ? { columns } : {}) };
  }
  if (kind === "blank") {
    const obj = exact(value, ["id", "kind", "size"]);
    return { id, kind: "blank", size: sizeTier(obj.size) };
  }
  if ((displayKinds as readonly unknown[]).includes(kind)) {
    const display = kind as DisplayKind, obj = exact(value, ["id", "kind", "size", "form", ...(display === "text" ? ["text"] : [])]);
    if (display === "clock") {
      if (obj.form !== "time" && obj.form !== "time-date") throw new Fault("INVALID_INPUT", "Choose a form for the clock widget.");
      sizeTier(obj.size);
      return { id, kind: display, size: "M", form: "time" };
    }
    if (typeof obj.form !== "string" || !DISPLAY_FORMS[display].includes(obj.form)) throw new Fault("INVALID_INPUT", `Choose a form for the ${display} widget.`);
    if ((display === "codex-usage" || display === "claude-usage") && obj.size !== "M" && obj.size !== "L") throw new Fault("INVALID_INPUT", "Subscription widgets use Compact (M) or Standard (L).");
    return { id, kind: display, size: sizeTier(obj.size), form: obj.form, ...(display === "text" ? { text: widgetText(obj.text) } : {}) };
  }
  const part = componentKind(kind);
  if (context.placements) {
    const placement = exact(value, ["id", "kind", "size"]);
    return { id, kind: part, size: sizeTier(placement.size) } as unknown as Component;
  }
  const component = exact(value, ["id", "kind", "size", "label", "icon", ...["color", "appearance"].filter(key => Object.hasOwn(source, key)),
    "action", ...(Object.hasOwn(source, "requiresConfirmation") ? ["requiresConfirmation"] : [])]);
  return { id, kind: part, size: sizeTier(component.size), label: label(component.label), icon: icon(component.icon),
    ...(Object.hasOwn(component, "color") ? { color: buttonColor(component.color) } : {}),
    ...(Object.hasOwn(component, "appearance") ? { appearance: parseAppearance(component.appearance) } : {}),
    ...confirmationFlag(component), action: component.action === null ? null : parseAction(component.action) };
}
// A layout or theme name is one trimmed line of 1–40 characters.
export function layoutName(value: unknown): string {
  const name = label(value);
  if (name !== value) throw new Fault("INVALID_INPUT", "A layout name has no spaces at its start or end.");
  return name;
}
// Parses the merged view of a layout (version 2 shape). A view made by viewFor() also carries layoutName and layoutRevision; a draft the page keeps may carry only the name.
export function parseConfig(value: unknown): Config {
  const head = record(value);
  if (head.format !== CONFIG_FORMAT || head.version !== VIEW_VERSION) throw new Fault("CONFIG_VERSION", "Unsupported configuration format.");
  const obj = exact(value, ["format", "version", "revision", "gridSize", "widgets", ...["workflows", "customThemes", "layoutName", "layoutRevision"].filter(key => Object.hasOwn(head, key))]);
  // An empty list is the same as none: the field is left out.
  const parsedThemes = Object.hasOwn(obj, "customThemes") ? parseCustomThemes(obj.customThemes) : undefined;
  const customThemes = parsedThemes?.length ? parsedThemes : undefined;
  const workflows = Object.hasOwn(obj, "workflows") ? parseWorkflows(obj.workflows) : undefined;
  const size = gridSize(obj.gridSize);
  if (!Array.isArray(obj.widgets)) throw new Fault("INVALID_INPUT", "The canvas holds a list of widgets.");
  const context: WidgetContext = { ids: new Set() };
  const widgets = obj.widgets.map(item => parseFlat(item, context, true));
  if (context.ids.size > MAX_WIDGETS) throw new Fault("INVALID_INPUT", "Too many widgets.");
  const config: Config = { format: CONFIG_FORMAT, version: VIEW_VERSION, revision: revision(obj.revision), gridSize: size, widgets,
    ...(workflows ? { workflows } : {}), ...(customThemes ? { customThemes } : {}),
    ...(Object.hasOwn(obj, "layoutName") ? { layoutName: layoutName(obj.layoutName) } : {}), ...(Object.hasOwn(obj, "layoutRevision") ? { layoutRevision: revision(obj.layoutRevision) } : {}) };
  for (const component of allComponents(config)) if (component.action?.type === "workflow.run") {
    const id = component.action.workflowId;
    if (!workflows?.some(workflow => workflow.id === id)) throw new Fault("INVALID_INPUT", "Component references an unknown workflow.");
  }
  // The readable export and the persisted file must fit the same budget as an import.
  if (new TextEncoder().encode(JSON.stringify(config, null, 2) + "\n").length > MAX_CONFIG_BYTES)
    throw new Fault("TOO_LARGE", "The complete saved configuration must fit within 256 KiB.", 413);
  return config;
}
// Read-only compatibility boundary for files/imports (T94): v1 and v2 are converted to v3 in memory (one layout named "Surface", default theme); v3 is read as is.
// Writes accept v3 only. The converted document never contains cell/span/canvas and is never written merely by reading it.
export function readConfig(value: unknown): ConfigDocument {
  const head = record(value);
  if (head.format === CONFIG_FORMAT && head.version === CONFIG_VERSION) return parseConfigDocument(value);
  return v2ToV3(readLegacyView(value));
}
// v1 and v2 as the page-shaped view (version 2). A v1 file is converted without writing it.
function readLegacyView(value: unknown): Config {
  const head = record(value);
  if (head.format !== CONFIG_FORMAT || head.version !== 1) return parseConfig(value);
  const obj = exact(value, ["format", "version", "revision", "canvas", "widgets", ...["workflows", "customThemes"].filter(key => Object.hasOwn(head, key))]);
  const canvas = exact(obj.canvas, ["cols", "rows"]);
  integer(canvas.cols, 2, 16, "Canvas columns"); integer(canvas.rows, 2, 12, "Canvas rows");
  function convert(list: unknown, area: Span, allowPages = true): Record<string, unknown>[] {
    if (!Array.isArray(list)) throw new Fault("INVALID_INPUT", "A container holds a list of widgets.");
    const occupied: CellRect[] = [];
    return list.map((raw, index) => {
      const source = record(raw), cell = exact(source.cell, ["x", "y"]);
      const x = integer(cell.x, 0, 15, "Cell x"), y = integer(cell.y, 0, 11, "Cell y");
      const { cell: _cell, ...widget } = source;
      let need: Span;
      if (widget.kind === "pages") {
        if (Object.hasOwn(widget, "dimensions")) throw new Fault("INVALID_INPUT", "Pages dimensions require version 2.");
        if (!allowPages) throw new Fault("INVALID_INPUT", "A Pages widget cannot hold another Pages widget.");
        const span = exact(widget.span, ["cols", "rows"]);
        integer(span.cols, 2, 16, "Pages width"); integer(span.rows, 2, 12, "Pages height");
        need = { cols: span.cols as number, rows: span.rows as number };
        delete widget.span;
        if (!Array.isArray(widget.pages)) throw new Fault("INVALID_INPUT", "A Pages widget holds pages.");
        widget.pages = widget.pages.map(raw => { const page = exact(raw, ["id", "name", "widgets"]); return { ...page, widgets: convert(page.widgets, need, false) }; });
      } else need = TIER_SPAN[sizeTier(widget.size)];
      const rect = { x, y, ...need };
      if (!rectInside(rect, area) || occupied.some(other => rectsOverlap(other, rect))) throw new Fault("INVALID_INPUT", "Invalid v1 placement: a widget overlaps or leaves its area.");
      occupied.push(rect);
      return { widget, x, y, index };
    }).sort((a, b) => a.y - b.y || a.x - b.x || a.index - b.index).map(entry => entry.widget);
  }
  const { canvas: _canvas, ...rest } = obj;
  return parseConfig({ ...rest, version: VIEW_VERSION, gridSize: "standard", widgets: convert(obj.widgets, { cols: canvas.cols as number, rows: canvas.rows as number }) });
}
// ---------------------------------------------------------------------------------------------------------------------------------
// T94 (ADR-087): keyln.config v3. A shared key library plus named layouts, each with its own revision. The functions below are pure: the Host's store and the
// page both use them, so a view, a save and a migration can never disagree about what a layout is.
export function parseKey(value: unknown): Key {
  const source = record(value);
  const id = stableId(source.id);
  componentKind(source.kind);
  const key = exact(value, ["id", "kind", "label", "icon", ...["color", "appearance"].filter(name => Object.hasOwn(source, name)),
    "action", ...(Object.hasOwn(source, "requiresConfirmation") ? ["requiresConfirmation"] : [])]);
  return { id, kind: "key", label: label(key.label), icon: icon(key.icon),
    ...(Object.hasOwn(key, "color") ? { color: buttonColor(key.color) } : {}),
    ...(Object.hasOwn(key, "appearance") ? { appearance: parseAppearance(key.appearance) } : {}),
    ...confirmationFlag(key), action: key.action === null ? null : parseAction(key.action) };
}
export function parseThemeChoice(value: unknown): ThemeChoice { return isCustomThemeId(value) ? value : themeName(value); }
function parseLayoutWidgets(value: unknown): LayoutWidget[] {
  if (!Array.isArray(value)) throw new Fault("INVALID_INPUT", "The canvas holds a list of widgets.");
  const context: WidgetContext = { ids: new Set(), placements: true };
  const widgets = value.map(item => parseFlat(item, context, true) as unknown as LayoutWidget);
  if (context.ids.size > MAX_WIDGETS) throw new Fault("INVALID_INPUT", "Too many widgets.");
  return widgets;
}
// The ids of the keys a layout places, canvas first, then the pages of each Pages widget in order.
export function placedKeyIds(widgets: readonly LayoutWidget[]): string[] {
  const found: string[] = [];
  for (const widget of widgets) {
    if (widget.kind === "pages") { for (const page of widget.pages) for (const inner of page.widgets) if (inner.kind === "key") found.push(inner.id); }
    else if (widget.kind === "key") found.push(widget.id);
  }
  return found;
}
function parseKeys(value: unknown): Key[] {
  if (!Array.isArray(value) || value.length > MAX_LIBRARY_KEYS) throw new Fault("INVALID_INPUT", `The key library holds at most ${MAX_LIBRARY_KEYS} keys.`);
  const ids = new Set<string>();
  return value.map(item => {
    const key = parseKey(item);
    if (ids.has(key.id)) throw new Fault("INVALID_INPUT", "Duplicate key ID.");
    ids.add(key.id);
    return key;
  });
}
export function parseLibraryContent(value: unknown): LibraryContent {
  const head = record(value);
  const obj = exact(value, ["keys", ...["workflows", "customThemes"].filter(name => Object.hasOwn(head, name))]);
  const themes = Object.hasOwn(obj, "customThemes") ? parseCustomThemes(obj.customThemes) : undefined;
  return { keys: parseKeys(obj.keys), ...(Object.hasOwn(obj, "workflows") ? { workflows: parseWorkflows(obj.workflows) } : {}), ...(themes?.length ? { customThemes: themes } : {}) };
}
export function parseLayoutContent(value: unknown): LayoutContent {
  const obj = exact(value, ["gridSize", "widgets"]);
  return { gridSize: gridSize(obj.gridSize), widgets: parseLayoutWidgets(obj.widgets) };
}
/** T118: whether `value` is a legal value of the option (a switch: a boolean; a choice: one of its values). */
export function validDockOption(key: DockOptionKey, value: unknown): boolean {
  const spec = DOCK_OPTION_SPECS[key];
  return spec.kind === "switch" ? typeof value === "boolean" : (spec.values as readonly unknown[]).includes(value);
}
/** T117/T118: a stored `dockOptions` object: known keys only, each holding its non-default value (a switch: `true`; a choice: a value other than the default), at least one (an empty object is never written). */
export function parseDockOptions(value: unknown): DockOptions {
  const obj = record(value), keys = Object.keys(obj);
  const stored = (key: string) => (DOCK_OPTION_KEYS as readonly string[]).includes(key) && (() => { const spec = DOCK_OPTION_SPECS[key as DockOptionKey]; return spec.kind === "switch" ? obj[key] === true : obj[key] !== spec.fallback && validDockOption(key as DockOptionKey, obj[key]); })();
  if (!keys.length || !keys.every(stored)) throw new Fault("INVALID_INPUT", "The Mac Dock options must name known options set to a non-default value.");
  return Object.fromEntries(DOCK_OPTION_KEYS.filter(key => Object.hasOwn(obj, key)).map(key => [key, obj[key]])) as DockOptions;
}
// Strict parse of a saved v3 file or an import. Every placement names a library key; a key is placed at most once per layout; workflow references are checked
// against the library; the layout names are unique and `defaultLayout` is one of them. Library keys that no layout places are allowed.
export function parseConfigDocument(value: unknown): ConfigDocument {
  const head = record(value);
  if (head.format !== CONFIG_FORMAT || head.version !== CONFIG_VERSION) throw new Fault("CONFIG_VERSION", "Unsupported configuration format.");
  const obj = exact(value, ["format", "version", "library", "layouts", "defaultLayout"]);
  const lib = record(obj.library);
  const libObj = exact(obj.library, ["revision", "keys", ...["workflows", "customThemes"].filter(name => Object.hasOwn(lib, name))]);
  const themes = Object.hasOwn(libObj, "customThemes") ? parseCustomThemes(libObj.customThemes) : undefined;
  const workflows = Object.hasOwn(libObj, "workflows") ? parseWorkflows(libObj.workflows) : undefined;
  const keys = parseKeys(libObj.keys), known = new Set(keys.map(key => key.id));
  const library: Library = { revision: revision(libObj.revision), keys, ...(workflows ? { workflows } : {}), ...(themes?.length ? { customThemes: themes } : {}) };
  if (!Array.isArray(obj.layouts) || obj.layouts.length < 1 || obj.layouts.length > MAX_LAYOUTS) throw new Fault("INVALID_INPUT", `Use 1–${MAX_LAYOUTS} layouts.`);
  const names = new Set<string>();
  const layouts: Layout[] = obj.layouts.map(raw => {
    const item = exact(raw, ["name", "revision", "theme", "gridSize", "widgets", ...["dock", "dockOptions"].filter(field => Object.hasOwn(record(raw), field))]), name = layoutName(item.name);
    // T115: only `true` is ever written; false (or anything else) is not a valid value, so a dock-off document has no field at all.
    if (Object.hasOwn(item, "dock") && item.dock !== true) throw new Fault("INVALID_INPUT", "The Mac Dock setting must be true or absent.");
    const dockOptions = Object.hasOwn(item, "dockOptions") ? parseDockOptions(item.dockOptions) : undefined;
    if (names.has(name)) throw new Fault("INVALID_INPUT", "Layout names must be unique.");
    names.add(name);
    const widgets = parseLayoutWidgets(item.widgets);
    for (const id of placedKeyIds(widgets)) if (!known.has(id)) throw new Fault("INVALID_INPUT", "A layout places a key that is not in the key library.");
    return { name, revision: revision(item.revision), theme: parseThemeChoice(item.theme), gridSize: gridSize(item.gridSize), widgets, ...(item.dock === true ? { dock: true as const } : {}), ...(dockOptions ? { dockOptions } : {}) };
  });
  const defaultLayout = layoutName(obj.defaultLayout);
  if (!names.has(defaultLayout)) throw new Fault("INVALID_INPUT", "The default layout must be one of the layouts.");
  for (const key of keys) if (key.action?.type === "workflow.run") {
    const id = key.action.workflowId;
    if (!workflows?.some(workflow => workflow.id === id)) throw new Fault("INVALID_INPUT", "Component references an unknown workflow.");
  }
  const config: ConfigDocument = { format: CONFIG_FORMAT, version: CONFIG_VERSION, library, layouts, defaultLayout };
  // The readable export and the persisted file must fit the same budget as an import.
  if (new TextEncoder().encode(JSON.stringify(config, null, 2) + "\n").length > MAX_CONFIG_BYTES)
    throw new Fault("TOO_LARGE", "The complete saved configuration must fit within 256 KiB.", 413);
  return config;
}
/** The layout called `name`, else the default layout (a device whose layout no longer exists uses the default one). */
export function resolveLayout(config: ConfigDocument, name?: string): Layout {
  return config.layouts.find(layout => layout.name === name) ?? config.layouts.find(layout => layout.name === config.defaultLayout)!;
}
/** T117/T118: the Dock options of a layout as a full map (every known key; the default for what is not stored). */
export const dockOptionMap = (options?: DockOptions): DockOptionMap => ({ hideKeyedApps: options?.hideKeyedApps === true, align: options?.align ?? "center" });
export const layoutDockOptions = (config: ConfigDocument, name?: string): DockOptionMap => dockOptionMap(resolveLayout(config, name).dockOptions);
/** T115: whether the layout shows the Mac Dock bar. */
export const layoutDock = (config: ConfigDocument, name?: string): boolean => resolveLayout(config, name).dock === true;
/** The theme a layout shows: its choice, or null when it names a custom theme that no longer exists (the page then shows the default). */
export function layoutTheme(config: ConfigDocument, name?: string): ThemeChoice | null {
  const choice = resolveLayout(config, name).theme;
  return isCustomThemeId(choice) && !config.library.customThemes?.some(theme => theme.id === choice) ? null : choice;
}
const copyOf = <T>(value: T): T => structuredClone(value);
// Key order never decides whether two parts are the same.
function stable(value: unknown): string {
  const order = (item: unknown): unknown => Array.isArray(item) ? item.map(order) : item && typeof item === "object" ?
    Object.fromEntries(Object.keys(item).sort().map(name => [name, order((item as Record<string, unknown>)[name])])) : item;
  return JSON.stringify(order(value));
}
export const sameContent = (left: unknown, right: unknown): boolean => stable(left) === stable(right);
function toKey(component: Component): Key { const { size: _size, ...key } = copyOf(component); return key; }
function toLayoutFlat(widget: FlatWidget): LayoutFlat { return isComponent(widget) ? { id: widget.id, kind: "key", size: widget.size } : copyOf(widget); }
function toLayoutWidgets(widgets: readonly Widget[]): LayoutWidget[] {
  return widgets.map(widget => {
    if (!isPages(widget)) return toLayoutFlat(widget);
    const { pages, ...rest } = copyOf(widget);
    return { ...rest, pages: pages.map(page => ({ id: page.id, name: page.name, widgets: page.widgets.map(toLayoutFlat) })) };
  });
}
/** The merged document the page works on: the layout `layoutName` with every placement replaced by its key (plus the placement's size). `revision` is the library's. */
export function viewFor(config: ConfigDocument, layoutNameValue: string): Config {
  const layout = config.layouts.find(item => item.name === layoutNameValue);
  if (!layout) throw new Fault("INVALID_INPUT", "Unknown layout.");
  const keys = new Map(config.library.keys.map(key => [key.id, key]));
  const inline = (placement: Placement): Component => {
    const key = keys.get(placement.id);
    if (!key) throw new Fault("INVALID_INPUT", "A layout places a key that is not in the key library.");
    const { id, kind, ...rest } = copyOf(key);
    return { id, kind, size: placement.size, ...rest };
  };
  const flat = (widget: LayoutFlat): FlatWidget => widget.kind === "key" ? inline(widget) : copyOf(widget);
  const widgets: Widget[] = layout.widgets.map(widget => {
    if (widget.kind !== "pages") return flat(widget);
    const { pages, ...rest } = copyOf(widget);
    return { ...rest, pages: pages.map(page => ({ id: page.id, name: page.name, widgets: page.widgets.map(flat) })) };
  });
  return { format: CONFIG_FORMAT, version: VIEW_VERSION, revision: config.library.revision, gridSize: layout.gridSize, widgets,
    ...(config.library.workflows ? { workflows: copyOf(config.library.workflows) } : {}),
    ...(config.library.customThemes?.length ? { customThemes: copyOf(config.library.customThemes) } : {}),
    layoutName: layout.name, layoutRevision: layout.revision };
}
/** What a draft changed against its base, as the two parts a save carries. Each part is present only when it changed (the layout's theme is never part of it). */
export function splitView(base: Config, draft: Config): SplitView {
  const baseKeys = allComponents(base).map(toKey), draftKeys = allComponents(draft).map(toKey);
  const before = new Map(baseKeys.map(key => [key.id, key]));
  const libraryChanged = draftKeys.length !== baseKeys.length || draftKeys.some(key => { const old = before.get(key.id); return !old || !sameContent(old, key); }) ||
    !sameContent(base.workflows ?? [], draft.workflows ?? []) || !sameContent(base.customThemes ?? [], draft.customThemes ?? []);
  const baseLayout: LayoutContent = { gridSize: base.gridSize, widgets: toLayoutWidgets(base.widgets) };
  const layout: LayoutContent = { gridSize: draft.gridSize, widgets: toLayoutWidgets(draft.widgets) };
  return {
    ...(libraryChanged ? { library: { keys: draftKeys, ...(draft.workflows ? { workflows: copyOf(draft.workflows) } : {}), ...(draft.customThemes?.length ? { customThemes: copyOf(draft.customThemes) } : {}) } } : {}),
    ...(!sameContent(baseLayout, layout) ? { layout } : {}),
  };
}
/**
 * The document with the parts of a save put in (no revision changes: the caller bumps those). The library part holds the keys the page shows, so a stored key the page
 * did not send stays unless the page's layout placed it and no other layout does: deleting a key in the page removes it from the library only then.
 */
export function applySplit(config: ConfigDocument, layoutNameValue: string, split: SplitView): ConfigDocument {
  const next = copyOf(config), layout = next.layouts.find(item => item.name === layoutNameValue);
  if (!layout) throw new Fault("INVALID_INPUT", "Unknown layout.");
  const placedHere = new Set(placedKeyIds(layout.widgets));
  const placedElsewhere = new Set(next.layouts.filter(item => item !== layout).flatMap(item => placedKeyIds(item.widgets)));
  if (split.layout) { layout.gridSize = copyOf(split.layout.gridSize); layout.widgets = copyOf(split.layout.widgets); }
  if (split.library) {
    const sent = new Map(split.library.keys.map(key => [key.id, key])), stored = new Set(config.library.keys.map(key => key.id));
    const keys: Key[] = [];
    for (const old of config.library.keys) {
      const key = sent.get(old.id);
      if (key) keys.push(copyOf(key));
      else if (!placedHere.has(old.id) || placedElsewhere.has(old.id)) keys.push(copyOf(old));
    }
    for (const key of split.library.keys) if (!stored.has(key.id)) keys.push(copyOf(key));
    next.library.keys = keys;
    if (split.library.workflows) next.library.workflows = copyOf(split.library.workflows); else delete next.library.workflows;
    if (split.library.customThemes?.length) next.library.customThemes = copyOf(split.library.customThemes); else delete next.library.customThemes;
  }
  return next;
}
/**
 * A v2 configuration (the merged shape) as a v3 document: every key goes to the library, every placement keeps its size, and the widget tree (Pages with their
 * columns, blanks, display widgets) becomes the one layout `layoutName`, which is also the default layout. Both revisions are the v2 revision; the caller adds one when it migrates.
 */
export function v2ToV3(config: Config, options: { layoutName?: string; theme?: ThemeChoice } = {}): ConfigDocument {
  const name = options.layoutName ?? DEFAULT_LAYOUT_NAME;
  return parseConfigDocument({ format: CONFIG_FORMAT, version: CONFIG_VERSION,
    library: { revision: config.revision, keys: allComponents(config).map(toKey),
      ...(config.workflows ? { workflows: copyOf(config.workflows) } : {}), ...(config.customThemes?.length ? { customThemes: copyOf(config.customThemes) } : {}) },
    layouts: [{ name, revision: config.revision, theme: options.theme ?? DEFAULT_THEME, gridSize: config.gridSize, widgets: toLayoutWidgets(config.widgets) }],
    defaultLayout: name });
}
// The view with its custom themes replaced. An empty list removes the field. Which theme a layout shows is the layout's own choice (T94).
export function withCustomThemes(config: Config, customThemes: unknown): Config {
  const list = parseCustomThemes(customThemes), next = JSON.parse(JSON.stringify(config)) as Config;
  if (list.length) next.customThemes = list; else delete next.customThemes;
  return next;
}
export function confirmationFlag(obj:Record<string,unknown>):{requiresConfirmation?:boolean}{
  if(!Object.hasOwn(obj,"requiresConfirmation"))return {};
  if(typeof obj.requiresConfirmation!=="boolean")throw new Fault("INVALID_INPUT","Confirmation flag must be true or false.");
  return {requiresConfirmation:obj.requiresConfirmation};
}
export function parseBasicAction(value:unknown):BasicAction{
  const action=parseAction(value);if(action.type==="workflow.run")throw new Fault("INVALID_INPUT","Nested workflows are not supported.");return action;
}
export function parseWorkflows(value:unknown):Workflow[]{
  if(!Array.isArray(value)||value.length>MAX_WORKFLOWS)throw new Fault("INVALID_INPUT",`Use at most ${MAX_WORKFLOWS} workflows.`);
  const ids=new Set<string>();return value.map(item=>{
    const obj=exact(item,["id","name","steps","timeoutMs",...(Object.hasOwn(record(item),"requiresConfirmation")?["requiresConfirmation"]:[])]),id=stableId(obj.id);
    if(ids.has(id))throw new Fault("INVALID_INPUT","Duplicate workflow ID.");ids.add(id);
    if(!Array.isArray(obj.steps)||obj.steps.length<1||obj.steps.length>MAX_WORKFLOW_STEPS)throw new Fault("INVALID_INPUT",`Use 1–${MAX_WORKFLOW_STEPS} workflow steps.`);
    const stepIds=new Set<string>();const steps=obj.steps.map(item=>{
      const step=exact(item,["id","action","timeoutMs",...(Object.hasOwn(record(item),"requiresConfirmation")?["requiresConfirmation"]:[])]),id=stableId(step.id);
      if(stepIds.has(id))throw new Fault("INVALID_INPUT","Duplicate workflow step ID.");stepIds.add(id);
      return {id,action:parseBasicAction(step.action),timeoutMs:actionTimeout(step.timeoutMs),...confirmationFlag(step)};
    });
    return {id,name:label(obj.name),timeoutMs:actionTimeout(obj.timeoutMs,MAX_WORKFLOW_TIMEOUT),steps,...confirmationFlag(obj)};
  });
}
export function componentKind(value: unknown): ComponentKind {
  if (!componentKinds.includes(value as ComponentKind)) throw new Fault("INVALID_INPUT", "Choose a supported component type.");
  return value as ComponentKind;
}
export function needsConfirmation(config:Config,component:Component):boolean{
  const action=component.action,workflow=action?.type==="workflow.run"?config.workflows?.find(item=>item.id===action.workflowId):undefined;
  return !!component.requiresConfirmation||!!workflow?.requiresConfirmation||!!workflow?.steps.some(step=>step.requiresConfirmation);
}
export function parseWorkflowResult(value:unknown,terminal=false):WorkflowResult{
  const obj=exact(value,["id","totalSteps","steps"]);
  if(!Number.isInteger(obj.totalSteps)||(obj.totalSteps as number)<1||(obj.totalSteps as number)>MAX_WORKFLOW_STEPS||!Array.isArray(obj.steps)||obj.steps.length>(obj.totalSteps as number))throw new Fault("INVALID_INPUT","Invalid workflow progress.");
  const ids=new Set<string>();let outputLength=0;
  const rawSteps=obj.steps;const steps=rawSteps.map((item,index)=>{
    const step=exact(item,["id","actionType","status","startedAt","message",...["finishedAt","code","output"].filter(key=>Object.hasOwn(record(item),key))]),id=stableId(step.id);
    if(ids.has(id)||!["app.open","window.activate","keyboard.shortcut","shell.run","shortcuts.run"].includes(step.actionType as string)||!["running","succeeded","failed","unknown"].includes(step.status as string)||!Number.isSafeInteger(step.startedAt)||(step.startedAt as number)<0||typeof step.message!=="string"||!step.message.length||step.message.length>300)throw new Fault("INVALID_INPUT","Invalid workflow step result.");ids.add(id);
    const done=step.status!=="running";
    if(!done&&(terminal||index!==rawSteps.length-1)||done!==Object.hasOwn(step,"finishedAt")||done&&(!Number.isSafeInteger(step.finishedAt)||(step.finishedAt as number)<(step.startedAt as number)))throw new Fault("INVALID_INPUT","Invalid workflow step timing.");
    if(Object.hasOwn(step,"code")&&(!done||typeof step.code!=="string"||!/^[A-Z][A-Z0-9_]{0,63}$/.test(step.code)))throw new Fault("INVALID_INPUT","Invalid workflow step code.");
    const output=Object.hasOwn(step,"output")?parseShellOutput(step.output):undefined;
    if(output){if(step.actionType!=="shell.run")throw new Fault("INVALID_INPUT","Unexpected workflow output.");outputLength+=output.stdout.length+output.stderr.length;}
    return {id,actionType:step.actionType as BasicAction["type"],status:step.status as StepExecution["status"],startedAt:step.startedAt as number,message:step.message,
      ...(done?{finishedAt:step.finishedAt as number}:{}),...(step.code?{code:step.code as string}:{}),...(output?{output}:{})};
  });
  if(outputLength>MAX_SHELL_OUTPUT)throw new Fault("INVALID_INPUT","Workflow output exceeds its shared limit.");
  return {id:stableId(obj.id),totalSteps:obj.totalSteps as number,steps};
}

// ---------------------------------------------------------------------------------------------------------------------------------
// T62 (ADR-064): theme zones. A theme decides where the three system components sit (anchored to the window edges, in px), the content area that holds the shared
// canvas (insets from the window edges) and the height of the top bar. The built-in themes are written here; a custom theme starts from its base theme's zones and may
// carry its own `layout`. The theme picks the set by the window width: narrow (at most NARROW_MAX_WIDTH px) or wide.
export const SYSTEM_PARTS = ["mode-switch", "settings", "connection"] as const;
export type SystemPart = typeof SYSTEM_PARTS[number];
export const SYSTEM_FORMS: Readonly<Record<SystemPart, readonly string[]>> = { "mode-switch": ["segmented", "icon"], settings: ["gear"], connection: ["capsule", "dot", "dot-button"] };
// The integer-u design size (theme context: 1 CSS px/u) a system component takes in each of its forms; the Layout page of the theme window uses it when a form is chosen.
export const NARROW_MAX_WIDTH = 600;
// A system component is placed from one horizontal edge (left or right) and one vertical edge (top or bottom) of the window, with a fixed size.
export interface SystemSlot { form: string; w: number; h: number; left?: number; right?: number; top?: number; bottom?: number }
export interface ContentInsets { left: number; right: number; top: number; bottom: number }
export interface ZoneSet { header: number; slots: Record<SystemPart, SystemSlot>; content: ContentInsets }
export interface ThemeLayout { wide: ZoneSet; narrow: ZoneSet }
export interface PxRect { x: number; y: number; w: number; h: number }
export interface WindowSize { width: number; height: number }
export const zoneSetFor = (layout: ThemeLayout, width: number): ZoneSet => width <= NARROW_MAX_WIDTH ? layout.narrow : layout.wide;
export function slotRect(slot: SystemSlot, window: WindowSize): PxRect {
  const size = sizeToPx(resolveSizeU({ policy: themeSizingFor(slot.form).policy, size: slot }, THEME_CONTEXT), THEME_CONTEXT);
  return { x: slot.left !== undefined ? slot.left : window.width - slot.right! - size.w, y: slot.top !== undefined ? slot.top : window.height - slot.bottom! - size.h, ...size };
}
export function contentRect(zones: ZoneSet, window: WindowSize): PxRect {
  const c = zones.content;
  return { x: c.left, y: c.top, w: window.width - c.left - c.right, h: window.height - c.top - c.bottom };
}
const pxOverlap = (a: PxRect, b: PxRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
// The windows a zone set is checked in (px): the system components must lie inside, not touch each other or the content area, and the content area must keep room.
export const ZONE_CHECK_WINDOWS: Readonly<Record<"wide" | "narrow", readonly WindowSize[]>> = {
  wide: [{ width: 1366, height: 768 }, { width: 601, height: 420 }], narrow: [{ width: 411, height: 860 }, { width: 320, height: 480 }],
};
export const MIN_CONTENT = { w: 160, h: 120 };
export function zoneProblem(zones: ZoneSet, windows: readonly WindowSize[]): string | undefined {
  const rects: Array<[string, PxRect]> = [];
  for (const window of windows) {
    rects.length = 0;
    for (const part of SYSTEM_PARTS) rects.push([part, slotRect(zones.slots[part], window)]);
    const content = contentRect(zones, window);
    if (content.w < MIN_CONTENT.w || content.h < MIN_CONTENT.h) return `The content area is too small in a ${window.width} × ${window.height} window.`;
    for (const [name, rect] of rects) {
      if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > window.width || rect.y + rect.h > window.height) return `The ${name} component leaves a ${window.width} × ${window.height} window.`;
      if (pxOverlap(rect, content)) return `The ${name} component overlaps the content area in a ${window.width} × ${window.height} window.`;
    }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++)
      if (pxOverlap(rects[i]![1], rects[j]![1])) return `The ${rects[i]![0]} and ${rects[j]![0]} components overlap in a ${window.width} × ${window.height} window.`;
  }
  return undefined;
}
function parseZoneSet(value: unknown, windows: readonly WindowSize[]): ZoneSet {
  const obj = exact(value, ["header", "slots", "content"]), slots = exact(obj.slots, [...SYSTEM_PARTS]), content = exact(obj.content, ["left", "right", "top", "bottom"]);
  const parsed = {} as Record<SystemPart, SystemSlot>;
  for (const part of SYSTEM_PARTS) {
    const raw = record(slots[part]), horizontal = ["left", "right"].filter(key => Object.hasOwn(raw, key)), vertical = ["top", "bottom"].filter(key => Object.hasOwn(raw, key));
    if (horizontal.length !== 1 || vertical.length !== 1) throw new Fault("INVALID_INPUT", `Anchor the ${part} component to one side and to the top or bottom.`);
    const slot = exact(raw, ["form", "w", "h", horizontal[0]!, vertical[0]!]);
    if (typeof slot.form !== "string" || !SYSTEM_FORMS[part].includes(slot.form)) throw new Fault("INVALID_INPUT", `Choose a form for the ${part} component.`);
    parsed[part] = { form: slot.form, w: integer(slot.w, 24, 400, `${part} width`), h: integer(slot.h, 24, 200, `${part} height`),
      [horizontal[0]!]: integer(slot[horizontal[0]!], 0, 2000, `${part} ${horizontal[0]}`), [vertical[0]!]: integer(slot[vertical[0]!], 0, 2000, `${part} ${vertical[0]}`) } as SystemSlot;
  }
  const zones: ZoneSet = { header: integer(obj.header, 0, 160, "Top bar height"), slots: parsed,
    content: { left: integer(content.left, 0, 400, "Content left"), right: integer(content.right, 0, 400, "Content right"), top: integer(content.top, 0, 400, "Content top"), bottom: integer(content.bottom, 0, 400, "Content bottom") } };
  const problem = zoneProblem(zones, windows);
  if (problem) throw new Fault("INVALID_INPUT", problem);
  return zones;
}
export function parseThemeLayout(value: unknown): ThemeLayout {
  const obj = exact(value, ["wide", "narrow"]);
  return { wide: parseZoneSet(obj.wide, ZONE_CHECK_WINDOWS.wide), narrow: parseZoneSet(obj.narrow, ZONE_CHECK_WINDOWS.narrow) };
}
// A bar along the top edge: the connection on the left, the Use | Edit switch and the gear on the right.
function bar(header: number, pad: number, connection: { form: string; w: number; h: number }, mode: { form: string; w: number; h: number }, bottom = 16, gear = 44): ZoneSet {
  const middle = (height: number) => Math.round((header - height) / 2);
  return { header, slots: {
    connection: { form: connection.form, w: connection.w, h: connection.h, left: pad, top: middle(connection.h) },
    "mode-switch": { form: mode.form, w: mode.w, h: mode.h, right: pad + gear + 12, top: middle(mode.h) },
    settings: { form: "gear", w: gear, h: gear, right: pad, top: middle(gear) } },
  content: { left: pad, right: pad, top: header, bottom } };
}
// T97 (ADR-088): the wide top bar is 52px; the capsule is 200 x 36, the Use | Edit switch 140 x 40, the gear 40 x 40, all centred in the bar. The phone bar (narrowBar) keeps its 44px controls.
const CAPSULE = { form: "capsule", w: 200, h: 36 }, SEGMENTED = { form: "segmented", w: 140, h: 40 };
const WIDE_BAR = 52, WIDE_GEAR = 40;
// The content area of a wide window reaches the window edges on the left, right and bottom (T97, ADR-088): the canvas keeps its own 1u from the edge, computed when it is laid out.
const wideBar = (pad: number): ZoneSet => { const zones = bar(WIDE_BAR, pad, CAPSULE, SEGMENTED, 0, WIDE_GEAR); return { ...zones, content: { left: 0, right: 0, top: WIDE_BAR, bottom: 0 } }; };
const PHONE_CONNECTION = { form: "dot-button", w: 44, h: 44 }, PHONE_MODE = { form: "icon", w: 44, h: 44 };
const narrowBar = (): ZoneSet => bar(56, 8, PHONE_CONNECTION, PHONE_MODE, 8);
// The Widget theme has no bar: three round controls float in the top corners and the content starts below them.
const floating = (wide = false): ZoneSet => ({ header: 0, slots: {
  connection: { form: "dot-button", w: 44, h: 44, left: 12, top: 8 }, "mode-switch": { form: "icon", w: 44, h: 44, right: 68, top: 8 }, settings: { form: "gear", w: 44, h: 44, right: 12, top: 8 } },
  // T97: a wide Widget window starts the canvas right under the three controls (they end at 52) and at the window edges; the phone layout keeps 12/12/60/12.
  content: wide ? { left: 0, right: 0, top: 52, bottom: 0 } : { left: 12, right: 12, top: 60, bottom: 12 } });
export const THEME_LAYOUTS: Readonly<Record<ThemeName, ThemeLayout>> = {
  braun: { wide: wideBar(28), narrow: narrowBar() },
  metro: { wide: wideBar(20), narrow: narrowBar() },
  midnight: { wide: wideBar(24), narrow: narrowBar() },
  standard: { wide: wideBar(20), narrow: narrowBar() },
  classic: { wide: wideBar(28), narrow: narrowBar() },
  widget: { wide: floating(true), narrow: floating() },
};
// The theme a device shows: a built-in name or one of the custom themes. A choice that names a custom theme that no longer exists falls back to the default.
export interface ResolvedTheme { choice: ThemeChoice; name: ThemeName; custom?: CustomTheme; layout: ThemeLayout }
export function resolveTheme(choice: unknown, customThemes: readonly CustomTheme[] | undefined): ResolvedTheme {
  if (isCustomThemeId(choice)) {
    const custom = customThemes?.find(theme => theme.id === choice);
    if (custom) return { choice, name: custom.base, custom, layout: custom.layout ?? THEME_LAYOUTS[custom.base] };
  } else if (themes.includes(choice as ThemeName)) return { choice: choice as ThemeName, name: choice as ThemeName, layout: THEME_LAYOUTS[choice as ThemeName] };
  return { choice: DEFAULT_THEME, name: DEFAULT_THEME, layout: THEME_LAYOUTS[DEFAULT_THEME] };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// T62 (retired by T94, still read by `npm run layout:migrate`): the theme each paired device showed, stored by the Host in device-themes.json, never in the shared configuration. A custom theme's definition is shared;
// which theme a device uses is the device's own choice.
export const DEVICE_THEMES_FORMAT = "keyln.device-themes", DEVICE_THEMES_VERSION = 1;
export interface DeviceThemeFile { format: typeof DEVICE_THEMES_FORMAT; version: typeof DEVICE_THEMES_VERSION; devices: Record<string, { theme: ThemeChoice }> }
export const emptyDeviceThemes = (): DeviceThemeFile => ({ format: DEVICE_THEMES_FORMAT, version: DEVICE_THEMES_VERSION, devices: {} });
export function deviceThemeId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}$/.test(value)) throw new Fault("INVALID_INPUT", "Invalid device ID.");
  return value;
}
export function parseDeviceThemeFile(value: unknown): DeviceThemeFile {
  const obj = exact(value, ["format", "version", "devices"]);
  if (obj.format !== DEVICE_THEMES_FORMAT || obj.version !== DEVICE_THEMES_VERSION) throw new Fault("INVALID_INPUT", "Unsupported device theme file.");
  const file = emptyDeviceThemes();
  for (const [id, entry] of Object.entries(record(obj.devices))) {
    const item = exact(entry, ["theme"]);
    file.devices[deviceThemeId(id)] = { theme: isCustomThemeId(item.theme) ? item.theme : themeName(item.theme) };
  }
  return file;
}

// T94: which layout each paired device shows, kept by the Host in device-assignments.json beside config.json. The layouts live in the configuration, by name;
// a device with no entry, or whose layout no longer exists, uses the default layout. device-themes.json is retired: the theme belongs to the layout.
export const DEVICE_ASSIGNMENTS_FORMAT = "keyln.device-assignments", DEVICE_ASSIGNMENTS_VERSION = 1;
export interface DeviceAssignmentFile { format: typeof DEVICE_ASSIGNMENTS_FORMAT; version: typeof DEVICE_ASSIGNMENTS_VERSION; devices: Record<string, { layout: string }> }
export const emptyDeviceAssignments = (): DeviceAssignmentFile => ({ format: DEVICE_ASSIGNMENTS_FORMAT, version: DEVICE_ASSIGNMENTS_VERSION, devices: {} });
export function parseDeviceAssignmentFile(value: unknown): DeviceAssignmentFile {
  const obj = exact(value, ["format", "version", "devices"]);
  if (obj.format !== DEVICE_ASSIGNMENTS_FORMAT || obj.version !== DEVICE_ASSIGNMENTS_VERSION) throw new Fault("INVALID_INPUT", "Unsupported device assignment file.");
  const file = emptyDeviceAssignments();
  for (const [id, entry] of Object.entries(record(obj.devices))) file.devices[deviceThemeId(id)] = { layout: layoutName(exact(entry, ["layout"]).layout) };
  return file;
}

// ---------- T57/T62: one component as a file (ADR-062, ADR-064) ----------
// A file carries only what the component is: its name, look, size tier and actions (plus the workflows a key runs). No device id, no revision, no theme, no position.
// Every id in a file is a local name for linking (a workflow to the key that runs it); the importing configuration makes its own. Parsing reuses the configuration's
// own rules by checking the file as a one-widget configuration, so a file can never hold what a saved configuration could not. The single-page file of ADR-063 is
// gone: a page now belongs to a Pages widget and travels with the whole configuration.
export const ITEM_FILE_FORMAT = "keyln.item", ITEM_FILE_VERSION = 2;
export const ITEM_FILE_SUFFIX = ".keyln-item.json";
export type FileBody = Omit<Component, "id">;
export interface ItemFile { format: typeof ITEM_FILE_FORMAT; version: typeof ITEM_FILE_VERSION; component: FileBody; workflows?: Workflow[] }
const FILE_BODY_KEYS = ["kind", "size", "label", "icon", "action", "color", "requiresConfirmation", "appearance"];
function itemConfig(component: Record<string, unknown>, workflows: unknown): Config {
  return parseConfig({ format: CONFIG_FORMAT, version: VIEW_VERSION, revision: 0, gridSize: "standard",
    widgets: [{ ...component, id: "file-component" }], ...(workflows !== undefined ? { workflows } : {}) });
}
export function parseItemFile(value: unknown): ItemFile {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_CONFIG_BYTES) throw new Fault("TOO_LARGE", "Use a file of at most 256 KiB.", 413);
  const head = record(value);
  if (head.format !== ITEM_FILE_FORMAT) throw new Fault("INVALID_INPUT", "This is not a Keyln component file.");
  if (head.version !== ITEM_FILE_VERSION) throw new Fault("CONFIG_VERSION", "Unsupported file version.");
  const obj = exact(value, ["format", "version", "component", ...(Object.hasOwn(head, "workflows") ? ["workflows"] : [])]), component = record(obj.component);
  if (Object.keys(component).some(key => !FILE_BODY_KEYS.includes(key)) || !Object.hasOwn(component, "kind")) throw new Fault("INVALID_INPUT", "Unexpected or missing fields.");
  const config = itemConfig(component, Object.hasOwn(obj, "workflows") ? obj.workflows : undefined), made = config.widgets[0];
  if (!made || !isComponent(made)) throw new Fault("INVALID_INPUT", "A component file holds one key.");
  const used = new Set(made.action?.type === "workflow.run" ? [made.action.workflowId] : []);
  if (config.workflows?.some(workflow => !used.has(workflow.id))) throw new Fault("INVALID_INPUT", "This file holds a workflow that no key uses.");
  const { id: _id, ...body } = made;
  return { format: ITEM_FILE_FORMAT, version: ITEM_FILE_VERSION, component: body, ...(config.workflows?.length ? { workflows: config.workflows } : {}) };
}
// The file as the one-widget configuration it is checked as. The Mac's import check (configuration/preview) takes exactly this, so the file's apps, scripts and shortcuts are looked up like a full import's.
export function itemFileLayout(file: ItemFile): Config { return itemConfig(file.component as unknown as Record<string, unknown>, file.workflows); }
export function exportItemFile(config: Config, componentId: string): ItemFile {
  const component = findComponent(config, componentId);
  if (!component) throw new Fault("INVALID_INPUT", "Select a key first.");
  const { id: _id, ...body } = JSON.parse(JSON.stringify(component)) as Component;
  let workflows: Workflow[] | undefined;
  if (body.action?.type === "workflow.run") {
    const old = body.action.workflowId, found = config.workflows?.find(workflow => workflow.id === old);
    if (!found) throw new Fault("INVALID_INPUT", "A key runs a workflow that is not saved yet.");
    const flow = JSON.parse(JSON.stringify(found)) as Workflow;
    flow.id = "workflow-1"; flow.steps = flow.steps.map((step, index) => ({ ...step, id: `step-${index + 1}` }));
    body.action = { type: "workflow.run", workflowId: flow.id }; workflows = [flow];
  }
  return parseItemFile({ format: ITEM_FILE_FORMAT, version: ITEM_FILE_VERSION, component: body, ...(workflows ? { workflows } : {}) });
}
