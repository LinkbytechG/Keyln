import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_FORMAT, CONFIG_VERSION, DEFAULT_LAYOUT_NAME, DEFAULT_THEME, deviceThemeId, emptyDeviceAssignments, isCustomThemeId, layoutName, parseConfig, parseDeviceAssignmentFile,
  parseDeviceThemeFile, record, v2ToV3, viewFor, type ConfigDocument, type DeviceAssignmentFile, type ThemeChoice } from "../../packages/contracts/index.js";
import { MARKER } from "./archive.js";
import { atomicJSON, configurationText, defaultDataDir, lockDataDir, privateDir } from "./store.js";

// T94 (ADR-087): `npm run layout:migrate` turns a keyln.config v2 data directory into v3 once, offline. The Host never migrates: it refuses to start on a v2 layout.
// Usage: layout:migrate [--device <id>]... [--layout <name>] [--dry-run]
// Before anything is written, every file the command touches is copied byte for byte into migration-v3-<time>/ (mode 0700); the originals of config.backup.json and
// devices.json stay where they are, and device-themes.json is moved into that folder (the theme is the layout's now).
export interface MigrateOptions { devices: string[]; layout: string; dryRun: boolean }
export interface MigrateReport {
  status: "migrated" | "dry-run" | "already-migrated";
  keys?: number; widgets?: number; pages?: number; theme?: ThemeChoice; layout?: string; devices?: string[]; revision?: number; backupFolder?: string; notes?: string[];
}
export class MigrateError extends Error {}
const BACKED_UP = ["config.json", "config.backup.json", "device-themes.json", "devices.json", "device-assignments.json"];
const usage = "Usage: npm run layout:migrate -- [--device <id>]... [--layout <name>] [--dry-run]";
export function parseMigrateArguments(argv: string[]): MigrateOptions {
  const options: MigrateOptions = { devices: [], layout: DEFAULT_LAYOUT_NAME, dryRun: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--device" || argument === "--layout") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new MigrateError(`${argument} needs a value. ${usage}`);
      if (argument === "--layout") {
        try { options.layout = layoutName(value); } catch { throw new MigrateError("A layout name is 1–40 characters on one line, without spaces at its start or end."); }
      } else {
        try { options.devices.push(deviceThemeId(value)); } catch { throw new MigrateError(`"${value}" is not a device ID (eight characters, 0–9 and a–f).`); }
      }
    } else throw new MigrateError(`Unknown argument ${argument}. ${usage}`);
  }
  options.devices = [...new Set(options.devices)];
  return options;
}
const readJSON = (path: string): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)));
function pagesOf(document: ConfigDocument): number { return document.layouts.reduce((sum, layout) => sum + layout.widgets.reduce((inner, widget) => inner + (widget.kind === "pages" ? widget.pages.length : 0), 0), 0); }
export function migrateLayout(dir: string, options: MigrateOptions, now = Date.now): MigrateReport {
  const configPath = join(dir, "config.json");
  if (!existsSync(configPath)) throw new MigrateError(`There is no config.json in ${dir}. Nothing to migrate.`);
  let value: unknown;
  try { value = JSON.parse(configurationText(configPath)); } catch (error) { throw new MigrateError(`config.json cannot be read: ${(error as Error).message}. Nothing was changed.`); }
  const head = record(value);
  if (head.format !== CONFIG_FORMAT) throw new MigrateError("config.json is not a Keyln layout. Nothing was changed.");
  if (head.version === CONFIG_VERSION) return { status: "already-migrated" };
  if (head.version !== 2) throw new MigrateError(`config.json is version ${String(head.version)}; only version 2 can be migrated. Nothing was changed.`);
  const view = parseConfig(value), notes: string[] = [];
  // Every Pages widget needs a fixed number of keys per row on wide windows: the migration cannot guess what Surface shows for Auto.
  const auto = view.widgets.filter(widget => widget.kind === "pages" && widget.columns?.wide === undefined);
  if (auto.length) throw new MigrateError(`Set a fixed keys-per-row (wide) on these Pages widgets in Edit, save, then run this again: ${auto.map(widget => `"${widget.id}"`).join(", ")} (Auto). Nothing was changed.`);
  const devicesPath = join(dir, "devices.json");
  if (options.devices.length) {
    let known: string[] = [];
    try { known = ((readJSON(devicesPath) as { devices?: Array<{ id?: unknown }> }).devices ?? []).map(device => String(device.id)); } catch { /* Treated as no known devices below. */ }
    const missing = options.devices.filter(id => !known.includes(id));
    if (missing.length) throw new MigrateError(`Unknown device ${missing.join(", ")}: it is not in devices.json. Nothing was changed.`);
  }
  // The new layout shows the theme the first --device chose (the default theme when there is none, or it is gone).
  let theme: ThemeChoice = DEFAULT_THEME;
  const themesPath = join(dir, "device-themes.json");
  if (options.devices.length && existsSync(themesPath)) {
    try {
      const chosen = parseDeviceThemeFile(readJSON(themesPath)).devices[options.devices[0]!]?.theme;
      if (chosen && (!isCustomThemeId(chosen) || view.customThemes?.some(item => item.id === chosen))) theme = chosen;
      else if (chosen) notes.push(`The theme device ${options.devices[0]} chose no longer exists; the default theme is used.`);
    } catch { notes.push("device-themes.json could not be read; the default theme is used."); }
  }
  const document = v2ToV3(view, { layoutName: options.layout, theme });
  document.library.revision = view.revision + 1; document.layouts[0]!.revision = view.revision + 1;
  const report: MigrateReport = { status: options.dryRun ? "dry-run" : "migrated", keys: document.library.keys.length, widgets: viewFor(document, options.layout).widgets.length, pages: pagesOf(document),
    theme, layout: options.layout, devices: options.devices, revision: view.revision + 1, notes };
  if (options.dryRun) return report;
  // 1. Back everything up, byte for byte, before anything changes.
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  let folder = join(dir, `migration-v3-${stamp}`);
  for (let n = 2; existsSync(folder); n++) folder = join(dir, `migration-v3-${stamp}-${n}`);
  mkdirSync(folder, { mode: 0o700 }); chmodSync(folder, 0o700);
  for (const name of BACKED_UP) if (existsSync(join(dir, name))) {
    if (!lstatSync(join(dir, name)).isFile()) throw new MigrateError(`${name} is not a regular file. Nothing was changed except an empty backup folder ${folder}.`);
    copyFileSync(join(dir, name), join(folder, name));
  }
  report.backupFolder = folder;
  // 2. The assignments first, so a run that stops half way still finds config.json at v2 and can simply be run again.
  if (options.devices.length) {
    const assignmentsPath = join(dir, "device-assignments.json");
    let file: DeviceAssignmentFile = emptyDeviceAssignments();
    if (existsSync(assignmentsPath)) { try { file = parseDeviceAssignmentFile(readJSON(assignmentsPath)); } catch { notes.push("device-assignments.json was damaged; it was replaced (the backup keeps the original)."); } }
    for (const id of options.devices) file.devices[id] = { layout: options.layout };
    atomicJSON(assignmentsPath, file);
  }
  // 3. The commit: config.json becomes v3. config.backup.json stays as it is (v2, still readable).
  atomicJSON(configPath, document);
  // 4. The theme moved into the layout; the old file now lives only in the backup folder.
  if (existsSync(themesPath)) unlinkSync(themesPath);
  atomicJSON(join(dir, MARKER), { format: CONFIG_FORMAT, version: CONFIG_VERSION });
  return report;
}
export function describe(report: MigrateReport, dryRun: boolean): string[] {
  if (report.status === "already-migrated") return ["config.json is already in the v3 format. Nothing was changed."];
  const lines = [dryRun ? "Dry run: nothing was written. A real run would:" : "Migrated config.json to the v3 format:",
    `  library: ${report.keys} keys, revision ${report.revision}`,
    `  layout "${report.layout}": ${report.widgets} widgets, ${report.pages} pages, theme ${report.theme}, revision ${report.revision}`,
    `  devices on this layout: ${report.devices?.length ? report.devices.join(", ") : "none (every device uses the default layout)"}`,
    "  every Pages widget has a fixed keys-per-row (wide): checked"];
  if (report.backupFolder) lines.push(`  backup of the old files: ${report.backupFolder}`);
  for (const note of report.notes ?? []) lines.push(`  note: ${note}`);
  if (!dryRun) lines.push("Start Keyln again. Devices stay paired.");
  return lines;
}
/** The command: returns the exit code (0 done or already done, 1 refused). The data directory lock keeps it from running beside a Host. */
export function runMigrate(argv: string[], dir = defaultDataDir(), out: (line: string) => void = line => console.log(line), error: (line: string) => void = line => console.error(line)): number {
  let unlock: (() => void) | undefined;
  try {
    const options = parseMigrateArguments(argv);
    privateDir(dir); unlock = lockDataDir(dir);
    for (const line of describe(migrateLayout(dir, options), options.dryRun)) out(line);
    return 0;
  } catch (failure) { error(`Layout migration refused: ${(failure as Error).message}`); return 1; }
  finally { unlock?.(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runMigrate(process.argv.slice(2));
