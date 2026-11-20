import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { applySplit, CONFIG_FORMAT, DOCK_OPTION_KEYS, DOCK_OPTION_SPECS, dockOptionMap, exact, Fault, initialConfig, isCustomThemeId, layoutDock, layoutDockOptions, layoutName, layoutTheme, MAX_CONFIG_BYTES, parseConfig, parseConfigDocument, parseCustomThemes, parseLayoutContent, parseLibraryContent, validDockOption,
  parseThemeChoice, readConfig, record, resolveLayout, revision, sameContent, splitView, viewFor,
  type Action, type AppInfo, type Config, type ConfigDocument, type DockOptionKey, type DockOptionMap, type DockOptions, type Layout, type SplitView, type ThemeChoice } from "../../packages/contracts/index.js";

export const defaultDataDir = () => process.env.KEYLN_DATA_DIR || join(homedir(), "Library/Application Support/Keyln");
export function privateDir(dir: string): void { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); }
export function atomicJSON(path: string, value: unknown): void { atomicBytes(path, Buffer.from(JSON.stringify(value, null, 2) + "\n")); }
export function atomicBytes(path: string, bytes: Uint8Array): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export function lockDataDir(dir: string): () => void {
  privateDir(dir);
  const path = join(dir, "host.lock");
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid lock: ${path}. Inspect it before removing it.`);
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") unlinkSync(path);
      else throw error;
    }
  }
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch { throw new Error("Another Keyln Host may be using this data directory. Stop it first."); }
  writeFileSync(fd, String(process.pid)); closeSync(fd);
  return () => { if (existsSync(path)) unlinkSync(path); };
}
export function configurationBytes(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES)
    throw new Fault("CONFIG_FILE", "The layout file is not a regular file within the 256 KiB limit.");
  const bytes = readFileSync(path);
  if (bytes.length > MAX_CONFIG_BYTES) throw new Fault("CONFIG_FILE", "The layout file is too large.");
  return bytes;
}
export function configurationText(path: string): string { return new TextDecoder("utf-8", { fatal: true }).decode(configurationBytes(path)); }
export function configurationFile(path: string): ConfigDocument { return readConfig(JSON.parse(configurationText(path))); }
function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
const pageCount = (config: ConfigDocument): number => config.layouts.reduce((sum, layout) => sum + layout.widgets.reduce((inner, widget) => inner + (widget.kind === "pages" ? widget.pages.length : 0), 0), 0);
// T94: a v1 or v2 file is a supported read (imports, backups) but the Host never runs on it: `npm run layout:migrate` converts it first.
export const OLD_FORMAT_MESSAGE = "The layout is in the old format. Stop Keyln and run npm run layout:migrate.";
export function isOldConfigFormat(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && (value as { format?: unknown }).format === CONFIG_FORMAT && [1, 2].includes((value as { version?: unknown }).version as number);
}
const SAVE_KEYS = ["libraryRevision", "layoutName", "layoutRevision"];
export class ConfigStore {
  private current!: ConfigDocument;
  private recoveryReason = "";
  readonly path: string;
  readonly backup: string;
  constructor(dir: string, allowRecovery = false) {
    privateDir(dir);
    this.path = join(dir, "config.json"); this.backup = join(dir, "config.backup.json");
    if (!present(this.path)) {
      if (present(this.backup)) {
        const message = "Configuration is missing but a backup exists. Recover it in Mac management or run npm run restore.";
        if (!allowRecovery) throw new Error(message);
        this.recoveryReason = message; return;
      }
      atomicJSON(this.path, initialConfig());
    }
    const fail = (message: string) => { if (!allowRecovery) throw new Error(message); this.recoveryReason = message; };
    let parsed: unknown;
    try { parsed = JSON.parse(configurationText(this.path)); }
    catch { fail("Configuration is damaged or unsupported. It was preserved. Recover it in Mac management or run npm run restore."); return; }
    if (isOldConfigFormat(parsed)) { fail(OLD_FORMAT_MESSAGE); return; }
    try { this.current = parseConfigDocument(parsed); }
    catch { fail("Configuration is damaged or unsupported. It was preserved. Recover it in Mac management or run npm run restore."); }
  }
  get available(): boolean { return !this.recoveryReason; }
  get reason(): string { return this.recoveryReason; }
  private doc(): ConfigDocument {
    if (!this.available) throw new Fault("CONFIG_DAMAGED", "The Mac layout needs recovery. Open /admin on the Mac; no actions can run.", 503);
    return this.current;
  }
  /** The whole v3 document (what Export writes). */
  document(): ConfigDocument { return structuredClone(this.doc()); }
  /** Baseline for operations that replace the whole document, including every layout. */
  documentStamp(): string { return createHash("sha256").update(JSON.stringify(this.doc())).digest("hex"); }
  get defaultLayout(): string { return this.doc().defaultLayout; }
  get layoutNames(): string[] { return this.doc().layouts.map(layout => layout.name); }
  /** The key library's revision: what running a key and a confirmation compare. */
  get revision(): number { return this.doc().library.revision; }
  /** The revision of the layout `name` (the default layout when it does not exist). */
  layoutRevision(name?: string): number { return resolveLayout(this.doc(), name).revision; }
  /** The merged view of the layout `name`, or of the default layout when there is none of that name. */
  get(name?: string): Config { const doc = this.doc(); return viewFor(doc, resolveLayout(doc, name).name); }
  /** The theme the layout shows, or null when it names a custom theme that no longer exists. */
  theme(name?: string): ThemeChoice | null { return layoutTheme(this.doc(), name); }
  /** T115: whether the layout shows the Mac Dock bar. */
  dock(name?: string): boolean { return layoutDock(this.doc(), name); }
  /** T117: the Mac Dock options of the layout as a full map (every known option, on or off). */
  dockOptions(name?: string): DockOptionMap { return layoutDockOptions(this.doc(), name); }
  /** T115: whether any layout shows it (the Host observes running apps only then). */
  get anyDock(): boolean { return this.available && this.doc().layouts.some(layout => layout.dock === true); }
  private readBackup() {
    const bytes = configurationBytes(this.backup), config = readConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const original = present(this.path) ? configurationBytes(this.path) : undefined;
    const stamp = createHash("sha256").update(original ?? "missing").update("\0").update(bytes).digest("hex");
    return { config, original, stamp };
  }
  backupState() {
    try {
      const { config, stamp } = this.readBackup();
      return { available: true, stamp, revision: config.library.revision, layouts: config.layouts.length, pages: pageCount(config), buttons: config.library.keys.length,
        workflows: config.library.workflows?.length ?? 0, message: "Previous saved layout. Restore revokes all control devices; no action runs." };
    } catch { return { available: false, message: "No readable, supported backup. The current file has not been reset." }; }
  }
  restoreBackup(input: unknown, revokeDevices: () => void): Config {
    const obj = exact(input, ["stamp", "confirm"]);
    let reviewed: ReturnType<ConfigStore["readBackup"]>;
    try { reviewed = this.readBackup(); }
    catch { throw new Fault("BACKUP_CHANGED", "No supported backup is available. Preserve the files and inspect them on the Mac.", 409); }
    if (obj.confirm !== true || obj.stamp !== reviewed.stamp)
      throw new Fault("BACKUP_CHANGED", "The layout or backup changed. Review the current backup before restoring.", 409);
    const next = reviewed.config;
    if (this.available) {
      // Every revision moves past what the running Host holds, so no stale page can mistake the restored layout for the one it has.
      const bump = (now: number, restored: number) => {
        if (Math.max(now, restored) === Number.MAX_SAFE_INTEGER) throw new Fault("CONFIG_CONFLICT", "The revision limit was reached; preserve the files and repair deliberately.", 409);
        return Math.max(now, restored) + 1;
      };
      next.library.revision = bump(this.current.library.revision, next.library.revision);
      for (const layout of next.layouts) layout.revision = bump(this.current.layouts.find(item => item.name === layout.name)?.revision ?? 0, layout.revision);
    }
    const validated = parseConfigDocument(next);
    try {
      if (reviewed.original) atomicJSON(join(dirname(this.path), `config.before-restore-${Date.now()}-${randomUUID()}.json`), { encoding: "base64", originalBase64: reviewed.original.toString("base64") });
      // Revoke first: even a failed subsequent write must never reuse a stale device's revision.
      revokeDevices();
      atomicJSON(this.path, validated);
    } catch { throw new Fault("RESTORE_FAILED", "Layout recovery could not finish. Existing layout files were preserved; control devices may already be revoked. Check Mac data permissions.", 500); }
    this.current = validated; this.recoveryReason = "";
    return this.get();
  }
  // Every new or changed basic target is checked (retained unavailable bindings stay), including workflow steps; `all` (an import) checks every one.
  private checkActions(next: ConfigDocument, apps: AppInfo[], validateAction: ((action: Action) => void) | undefined, all: boolean): void {
    const before = this.doc();
    function check(action: Action | null, previous: Action | null | undefined) {
      if (!action || !all && JSON.stringify(action) === JSON.stringify(previous)) return;
      if ((action.type === "app.open" || action.type === "window.activate") && !apps.some(app => app.id === action.appId)) throw new Fault("APP_UNAVAILABLE", "Choose an installed application.");
      if (action.type === "shell.run" || action.type === "shortcuts.run") {
        if (!validateAction) throw new Fault("SCRIPT_UNAVAILABLE", "The local action catalog is unavailable.");
        validateAction(action);
      }
    }
    for (const key of next.library.keys) check(key.action ?? null, before.library.keys.find(item => item.id === key.id)?.action);
    for (const workflow of next.library.workflows ?? []) {
      const previous = before.library.workflows?.find(item => item.id === workflow.id);
      for (const step of workflow.steps) check(step.action, previous?.steps.find(item => item.id === step.id)?.action);
    }
  }
  /**
   * T94: a save carries only the part(s) that changed. `{ libraryRevision, layoutName, layoutRevision, library?, layout? }`: a present part is checked against its own
   * revision (CONFIG_CONFLICT on a mismatch), an absent part is not checked. Both parts are written in one atomic save and each changed part's revision goes up by one;
   * a request that changes nothing writes nothing. Returns the view of the layout.
   */
  save(input: unknown, apps: AppInfo[], validateAction?: (action: Action) => void): Config {
    const doc = this.doc(), head = record(input);
    const obj = exact(input, [...SAVE_KEYS, ...["library", "layout"].filter(name => Object.hasOwn(head, name))]);
    const name = layoutName(obj.layoutName), libraryRevision = revision(obj.libraryRevision), layoutRevision = revision(obj.layoutRevision);
    const layout = doc.layouts.find(item => item.name === name);
    if (!layout) throw new Fault("CONFIG_CONFLICT", "That layout no longer exists. Reconnect and review the latest version.", 409);
    const split: SplitView = { ...(Object.hasOwn(obj, "library") ? { library: parseLibraryContent(obj.library) } : {}), ...(Object.hasOwn(obj, "layout") ? { layout: parseLayoutContent(obj.layout) } : {}) };
    const conflict = () => new Fault("CONFIG_CONFLICT", "Configuration changed. Reconnect and review the latest version.", 409);
    if (split.library && libraryRevision !== doc.library.revision) throw conflict();
    if (split.layout && layoutRevision !== layout.revision) throw conflict();
    const next = parseConfigDocument(applySplit(doc, name, split)), nextLayout = next.layouts.find(item => item.name === name)!;
    const libraryPart = (value: ConfigDocument) => ({ keys: value.library.keys, workflows: value.library.workflows ?? [], customThemes: value.library.customThemes ?? [] });
    const layoutPart = (value: Layout) => ({ gridSize: value.gridSize, widgets: value.widgets });
    const libraryChanged = !!split.library && !sameContent(libraryPart(doc), libraryPart(next));
    const layoutChanged = !!split.layout && !sameContent(layoutPart(layout), layoutPart(nextLayout));
    if (!libraryChanged && !layoutChanged) return this.get(name);
    this.checkActions(next, apps, validateAction, false);
    if (libraryChanged) next.library.revision = this.bump(doc.library.revision, "Configuration revision limit reached. No change was saved.");
    if (layoutChanged) nextLayout.revision = this.bump(layout.revision, "Configuration revision limit reached. No change was saved.");
    this.commit(next);
    return this.get(name);
  }
  /**
   * A merged view saved as a whole, the way every save worked before T94: it is stale unless the revision(s) it carries are the current ones, whatever it changes.
   * (A page saves through save(), which sends only what changed and compares each part with its own revision.) A current view is split against the stored layout
   * and saved like any save, so one that changes nothing writes nothing.
   */
  replace(input: unknown, apps: AppInfo[], validateAction?: (action: Action) => void, imported = false, stamp?: unknown): Config {
    if (imported) return this.get(this.importDocument(input, stamp, apps, validateAction).defaultLayout);
    const candidate = parseConfig(input), doc = this.doc(), layout = resolveLayout(doc, candidate.layoutName);
    if (candidate.revision !== doc.library.revision || candidate.layoutRevision !== undefined && candidate.layoutRevision !== layout.revision)
      throw new Fault("CONFIG_CONFLICT", "Configuration changed. Reconnect and review the latest version.", 409);
    return this.save({ libraryRevision: doc.library.revision, layoutName: layout.name, layoutRevision: layout.revision,
      ...splitView(viewFor(doc, layout.name), candidate) }, apps, validateAction);
  }
  /**
   * Replaces everything with an imported document (v3, or v1/v2 converted in memory). The stamp covers the entire document the reviewer saw; every
   * binding is checked, unchanged ones too. Each layout's revision moves past everything the Host holds now. Returns the document that was saved.
   */
  importDocument(input: unknown, stamp: unknown, apps: AppInfo[], validateAction?: (action: Action) => void): ConfigDocument {
    const doc = this.doc(), candidate = readConfig(input);
    if (stamp !== this.documentStamp() || candidate.library.revision !== doc.library.revision) throw new Fault("CONFIG_CONFLICT", "Configuration changed. Reconnect and review the import again.", 409);
    this.checkActions(candidate, apps, validateAction, true);
    const top = Math.max(doc.library.revision, ...doc.layouts.map(layout => layout.revision));
    candidate.library.revision = this.bump(doc.library.revision, "Configuration revision limit reached. No change was saved.");
    for (const layout of candidate.layouts) layout.revision = this.bump(doc.layouts.find(item => item.name === layout.name)?.revision ?? top, "Configuration revision limit reached. No change was saved.");
    this.commit(candidate);
    return structuredClone(candidate);
  }
  // T62: replaces the custom themes (the definitions are shared; they belong to the library). Same rules as any save: one library revision, a backup like any save, and
  // a request that changes nothing writes nothing.
  setCustomThemes(customThemes: unknown, expected: unknown, layoutNameValue?: string): Config {
    const doc = this.doc();
    if (revision(expected) !== doc.library.revision) throw new Fault("CONFIG_CONFLICT", "Configuration changed. Reconnect and review the latest version.", 409);
    const list = parseCustomThemes(customThemes), next = structuredClone(doc);
    if (list.length) next.library.customThemes = list; else delete next.library.customThemes;
    if (sameContent(next, doc)) return this.get(layoutNameValue);
    next.library.revision = this.bump(doc.library.revision, "Configuration revision limit reached. No change was saved.");
    this.commit(parseConfigDocument(next));
    return this.get(layoutNameValue);
  }
  /**
   * The theme of a layout: last write wins (no revision to compare), only that field changes, and the layout's revision goes up. The same theme writes nothing.
   * It is a one-field change, so it does not replace config.backup.json (the backup stays the last layout you saved).
   */
  setTheme(layoutNameValue: string | undefined, choice: unknown): { theme: ThemeChoice; layoutName: string; previousLayoutRevision: number; layoutRevision: number } {
    const doc = this.doc(), layout = resolveLayout(doc, layoutNameValue), theme = parseThemeChoice(choice);
    if (isCustomThemeId(theme) && !doc.library.customThemes?.some(item => item.id === theme)) throw new Fault("INVALID_INPUT", "The selected theme is not one of the custom themes.");
    const baseline = { layoutName: layout.name, previousLayoutRevision: layout.revision };
    if (layout.theme === theme) return { theme, ...baseline, layoutRevision: layout.revision };
    const next = structuredClone(doc), nextLayout = next.layouts.find(item => item.name === layout.name)!;
    nextLayout.theme = theme;
    nextLayout.revision = this.bump(layout.revision, "Configuration revision limit reached. No change was saved.");
    this.commit(next, false);
    return { theme, ...baseline, layoutRevision: nextLayout.revision };
  }
  /**
   * T115 (ADR-099): the Mac Dock bar of a layout. Same rules as the theme: last write wins, only that field changes, the layout's revision goes up, and the same value
   * writes nothing. `dock: true` is written only when on; turning it off removes the field, so a dock-off file stays as the previous Host wrote it.
   */
  setDock(layoutNameValue: string | undefined, value: unknown): { dock: boolean; layoutName: string; previousLayoutRevision: number; layoutRevision: number } {
    if (typeof value !== "boolean") throw new Fault("INVALID_INPUT", "The Mac Dock setting must be true or false.");
    const doc = this.doc(), layout = resolveLayout(doc, layoutNameValue);
    const baseline = { layoutName: layout.name, previousLayoutRevision: layout.revision };
    if ((layout.dock === true) === value) return { dock: value, ...baseline, layoutRevision: layout.revision };
    const next = structuredClone(doc), nextLayout = next.layouts.find(item => item.name === layout.name)!;
    if (value) nextLayout.dock = true; else delete nextLayout.dock;
    nextLayout.revision = this.bump(layout.revision, "Configuration revision limit reached. No change was saved.");
    this.commit(next, false);
    return { dock: value, ...baseline, layoutRevision: nextLayout.revision };
  }
  /**
   * T117/T118 (ADR-101, ADR-102): the Mac Dock options of a layout. `value` is a partial map of known options (a switch: a boolean; `align`: "left" | "center" | "right"), merged with the
   * current ones (an option not named keeps its value). Same rules as setDock: last write wins, only the layout's revision goes up, the same result writes nothing.
   * `dockOptions` holds only the options that differ from their default; the last one back at its default removes it.
   */
  setDockOptions(layoutNameValue: string | undefined, value: unknown): { options: DockOptionMap; layoutName: string; previousLayoutRevision: number; layoutRevision: number } {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Fault("INVALID_INPUT", "The Mac Dock options must be an object.");
    const input = value as Record<string, unknown>, names = Object.keys(input);
    if (!names.length || names.some(key => !(DOCK_OPTION_KEYS as readonly string[]).includes(key) || !validDockOption(key as DockOptionKey, input[key]))) throw new Fault("INVALID_INPUT", "Name known Mac Dock options and give each a valid value.");
    const doc = this.doc(), layout = resolveLayout(doc, layoutNameValue), baseline = { layoutName: layout.name, previousLayoutRevision: layout.revision };
    const current = dockOptionMap(layout.dockOptions), merged: Record<string, unknown> = { ...current };
    for (const key of DOCK_OPTION_KEYS) if (Object.hasOwn(input, key)) merged[key] = input[key];
    if (DOCK_OPTION_KEYS.every(key => merged[key] === current[key])) return { options: current, ...baseline, layoutRevision: layout.revision };
    const next = structuredClone(doc), nextLayout = next.layouts.find(item => item.name === layout.name)!;
    const stored = DOCK_OPTION_KEYS.flatMap(key => { const spec = DOCK_OPTION_SPECS[key], v = merged[key]; return spec.kind === "switch" ? (v === true ? [[key, true]] : []) : (v !== spec.fallback ? [[key, v]] : []); });
    if (stored.length) nextLayout.dockOptions = Object.fromEntries(stored) as DockOptions; else delete nextLayout.dockOptions;
    nextLayout.revision = this.bump(layout.revision, "Configuration revision limit reached. No change was saved.");
    this.commit(next, false);
    return { options: dockOptionMap(nextLayout.dockOptions), ...baseline, layoutRevision: nextLayout.revision };
  }
  private bump(value: number, message: string): number {
    if (value === Number.MAX_SAFE_INTEGER) throw new Fault("CONFIG_CONFLICT", message, 409);
    return value + 1;
  }
  private commit(next: ConfigDocument, rotateBackup = true): void {
    // Validate after revision bumps and single-field changes, before touching either file.
    const validated = parseConfigDocument(next);
    try { if (rotateBackup) atomicBytes(this.backup, configurationBytes(this.path)); atomicJSON(this.path, validated); }
    catch { throw new Fault("SAVE_FAILED", "Could not save. The previous configuration remains active; check disk space and permissions.", 500); }
    this.current = validated;
  }
}
