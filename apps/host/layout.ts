import { Fault, readConfig, resolveLayout, viewFor, type Action, type AppInfo } from '../../packages/contracts/index.js';

// T94: the file is read as a v3 document (a v1/v2 file is converted in memory). `view` is the layout the calling device will show once the import is saved:
// its own layout when the file has one of that name, else the file's default layout; the page edits that view before saving.
export function importPreview(value: unknown, apps: AppInfo[], validate: (action: Action) => void, deviceLayout?: string) {
  const config = readConfig(value), issues: Array<{ location: string; code: string; message: string }> = [];
  function inspect(action: Action | null, location: string) {
    if (!action || action.type === 'workflow.run') return;
    try {
      if ((action.type === 'app.open' || action.type === 'window.activate') && !apps.some(app => app.id === action.appId))
        throw new Fault('APP_UNAVAILABLE', 'Select an installed Mac app in the imported draft.');
      validate(action);
    } catch (error) {
      const code = error instanceof Fault ? error.code : 'BINDING_UNAVAILABLE';
      const message = action.type === 'shell.run' ? 'Rebind to a locally approved script version and its allowed parameters. Import never registers or approves scripts.' :
        action.type === 'shortcuts.run' ? 'Refresh Mac shortcuts and select an available target in the imported draft.' : 'Select an installed Mac app in the imported draft.';
      issues.push({ location, code, message });
    }
  }
  for (const key of config.library.keys) {
    inspect(key.action ?? null, `Key: ${key.label}`);
  }
  for (const workflow of config.library.workflows ?? [])
    for (const [index, step] of workflow.steps.entries()) inspect(step.action, `${workflow.name} · Step ${index + 1}`);
  return { config, view: viewFor(config, resolveLayout(config, deviceLayout).name), issues };
}
