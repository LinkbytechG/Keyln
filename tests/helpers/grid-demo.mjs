import {initialView} from '../../dist/packages/contracts/index.js';

// The sample configuration of `browser-fixture.mjs --grid-demo`, in the page-shaped view of a layout (T94: keyln.config v2 shape; the Host saves it as a v3 layout): a responsive canvas holding a scrolling Pages widget (three pages)
// and, below it, ordinary widgets (clock, latest result, activity, Refresh, a title). Every action is a fake one; the fixture never touches the Mac.
// `appIds` are the Mac apps an icon demo may use; without them the keys use the test fixture apps.
export function gridDemoConfig(appIds) {
  const app = (n, fallback) => appIds?.length ? appIds[n % appIds.length] : fallback;
  const key = (id, label, icon, action, x, y, size = 'S') => ({ id, kind: 'key', size, label, icon, action });
  const daily = Array.from({ length: 72 }, (_, n) => key(n === 0 ? 'primary' : `tool-${n + 1}`, n === 0 ? 'Calculator' : `Tool ${n + 1}`, n % 2 ? 'spark' : 'app',
    { type: 'app.open', appId: app(n, 'test.calculator') }, n % 6, Math.floor(n / 6)));
  const more = appIds?.length ? [] : [
    key('slow', 'Slow test', 'play', { type: 'app.open', appId: 'test.slow' }, 0, 0), key('failure', 'Failure test', 'bolt', { type: 'app.open', appId: 'test.failure' }, 1, 0),
    key('shortcut', 'Test shortcut', 'spark', { type: 'keyboard.shortcut', key: 'KeyK', modifiers: ['command'] }, 2, 0)];
  const config = initialView();
  config.widgets = [
    { id: 'main', kind: 'pages', pages: [
      { id: 'page-1', name: 'Daily tools', widgets: daily }, { id: 'more', name: 'More actions', widgets: more }, { id: 'empty', name: 'Empty page', widgets: [] }] },
    { id: 'clock', kind: 'clock', size: 'M', form: 'time-date' },
    { id: 'refresh', kind: 'refresh', size: 'S', form: 'button' },
    { id: 'title', kind: 'text', size: 'Wide', form: 'title', text: 'Keyln demo' }];
  return config;
}
