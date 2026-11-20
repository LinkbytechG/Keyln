import { existsSync } from "node:fs";
import { SERVICE_LABEL, servicePaths, loadedService, readService, certificateStatus, type ServicePaths } from "./service.js";
import { serviceCommand, serviceStatus } from "./service-cli.js";
import { requestLocalManagement } from "./local-management.js";

// T120: the only commands the menu bar app may run. install and uninstall are deliberately absent.
const COMMANDS = ["menu-status", "admin-json", "start", "stop", "restart"];

async function menuStatus(paths: ServicePaths, doctor: boolean) {
  let base: { installed: boolean; loaded: boolean; pid: number | null; state: string; origin: string | null; nodeAvailable: boolean };
  try {
    const full = serviceStatus(paths);
    base = { installed: full.installed, loaded: full.loaded, pid: full.pid, state: full.state, origin: String(full.certificate.origin ?? "") || null, nodeAvailable: full.nodeAvailable === true };
  } catch {
    // Not installed, mismatched manifest or no certificate yet: report what is still knowable, never throw.
    let installed = false, nodeAvailable = false, origin: string | null = null;
    try { installed = existsSync(paths.manifest); if (installed) nodeAvailable = existsSync(readService(paths).node); } catch { /* keep defaults */ }
    try { origin = String(certificateStatus(paths.data).origin ?? "") || null; } catch { /* no certificate */ }
    const job = loadedService(paths);
    base = { installed, loaded: job.loaded, pid: job.pid, state: job.state, origin, nodeAvailable };
  }
  const status: Record<string, unknown> = { installed: base.installed, loaded: base.loaded, running: base.pid !== null, pid: base.pid, state: base.state, origin: base.origin, logs: paths.logs, nodeAvailable: base.nodeAvailable };
  if (doctor && base.pid !== null) {
    try {
      const result = await requestLocalManagement(paths.data, "doctor");
      const diagnostics = (result.diagnostics ?? {}) as Record<string, unknown>;
      status.permissions = { accessibilityTrusted: diagnostics.accessibilityTrusted === true, eventPostingAllowed: diagnostics.eventPostingAllowed === true };
    } catch (error) {
      status.permissions = null;
      status.doctorError = String((error as Error).message ?? error).split("\n")[0]!.slice(0, 200);
    }
  }
  return status;
}

async function main(args: string[]) {
  const [command, ...rest] = args;
  if (!command || !COMMANDS.includes(command)) throw new Error("Unsupported command. Use menu-status, admin-json, start, stop or restart.");
  const label = process.env.KEYLN_SERVICE_LABEL || SERVICE_LABEL;
  const paths = servicePaths(undefined, label); // rejects any label the service does not already accept
  if (command === "menu-status") {
    if (rest.some(value => value !== "--doctor")) throw new Error("Usage: menu-status [--doctor]");
    console.log(JSON.stringify(await menuStatus(paths, rest.includes("--doctor"))));
    return;
  }
  if (rest.length) throw new Error("This command does not take arguments.");
  if (command === "admin-json") {
    const { origin, code, expiresInSeconds } = await requestLocalManagement(paths.data, "admin");
    console.log(JSON.stringify({ origin, code, expiresInSeconds }));
    return;
  }
  await serviceCommand([command], label);
}

main(process.argv.slice(2)).catch(error => {
  console.error(String((error as Error).message ?? error).replace(/\s+/g, " ").trim());
  process.exitCode = 1;
});
