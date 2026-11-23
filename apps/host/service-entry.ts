import { existsSync } from "node:fs";
import { SERVICE_LABEL, servicePaths, loadedService, readService, certificateStatus, type ServicePaths } from "./service.js";
import { serviceCommand, serviceStatus } from "./service-cli.js";
import { requestLocalManagement } from "./local-management.js";
import { changeAddress, exportCertificate, installSelf, setupCommand, setupInfo } from "./first-run.js";

// T120: the only commands the menu bar app may run. install and uninstall are deliberately absent.
// T124 (ADR-108) adds the first-run commands. `install-self` installs only the app this runtime lives in and takes no path; install and uninstall stay impossible.
const COMMANDS = ["menu-status", "admin-json", "start", "stop", "restart", "setup-info", "setup", "install-self", "change-address", "export-certificate"];

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

function addressOptions(rest: string[]) {
  let address: string | undefined, port: number | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === "--address" && rest[i + 1]) address = rest[i + 1];
    else if (rest[i] === "--port" && rest[i + 1]) port = Number(rest[i + 1]);
    else throw new Error("Usage: --address PRIVATE_IPV4 [--port 8940]");
  }
  if (!address) throw new Error("Usage: --address PRIVATE_IPV4 [--port 8940]");
  return { address, port };
}

async function main(args: string[]) {
  const [command, ...rest] = args;
  if (!command || !COMMANDS.includes(command)) throw new Error("Unsupported command. Use menu-status, admin-json, start, stop, restart, setup-info, setup, install-self, change-address or export-certificate.");
  const label = process.env.KEYLN_SERVICE_LABEL || SERVICE_LABEL;
  const paths = servicePaths(undefined, label); // rejects any label the service does not already accept
  if (command === "menu-status") {
    if (rest.some(value => value !== "--doctor")) throw new Error("Usage: menu-status [--doctor]");
    console.log(JSON.stringify(await menuStatus(paths, rest.includes("--doctor"))));
    return;
  }
  if (command === "setup-info" || command === "install-self") {
    if (rest.length) throw new Error("This command does not take arguments.");
    if (command === "setup-info") console.log(JSON.stringify(setupInfo(paths, import.meta.url)));
    else { await installSelf(paths, import.meta.url); console.log(JSON.stringify({ installed: true })); }
    return;
  }
  if (command === "setup" || command === "change-address") {
    const options = addressOptions(rest);
    console.log(JSON.stringify(command === "setup" ? await setupCommand(paths, options) : await changeAddress(paths, options)));
    return;
  }
  if (command === "export-certificate") {
    if (rest.length !== 2 || rest[0] !== "--out" || !rest[1]) throw new Error("Usage: export-certificate --out /absolute/path/keyln-root.cer");
    console.log(JSON.stringify(exportCertificate(paths.data, rest[1])));
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
