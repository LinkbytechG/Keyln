import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// T123: where the native helper lives for a module at <runtime>/dist/apps/host/. Inside Keyln.app the runtime is Contents/Resources/runtime and the helper is the sealed Contents/Helpers/keyln-helper; everywhere else it is dist/keyln-helper. Derived from the module's own location only, never from the environment.
export function helperPath(moduleUrl: string): string {
  const here = dirname(fileURLToPath(moduleUrl)), runtime = resolve(here, "../../.."), resources = dirname(runtime), contents = dirname(resources);
  if (basename(runtime) === "runtime" && basename(resources) === "Resources" && basename(contents) === "Contents") return join(contents, "Helpers/keyln-helper");
  return resolve(here, "../../keyln-helper");
}
