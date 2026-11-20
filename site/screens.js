// screens.js - 2D canvas drawings for every screen in the scene.
// Each screen repaints only when the slice of state it depends on changes.
// Generic apps and icons only; no real product marks.

const COL = {
  bg: '#1A1917', surface: '#2A2926', line: '#3C3A37', text: '#ECE7DC', muted: '#B8B4AB',
  accent: '#F26B1D', ok: '#5E9B63', okText: '#8BB78F', warn: '#E9B93A', danger: '#D9594B',
  mint: '#7CF2B4', ink: '#0D0E10',
};
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const SYN = ['#F26B1D', '#7CF2B4', '#6AA7F2', '#B8B4AB', '#E9B93A'];

const lerp = (a, b, k) => a + (b - a) * k;
const q = (v) => Math.round(v * 100);

// ---- drawing helpers ---------------------------------------------------------
function rr(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function txt(c, s, x, y, size, color, o = {}) {
  c.font = `${o.weight || 400} ${size}px ${o.mono ? MONO : SANS}`;
  c.fillStyle = color;
  c.textAlign = o.align || 'left';
  c.textBaseline = o.base || 'alphabetic';
  c.fillText(s, x, y);
}

function bar(c, x, y, w, h, color, alpha = 1) {
  c.save();
  c.globalAlpha *= alpha;
  c.fillStyle = color;
  rr(c, x, y, w, h, h / 2);
  c.fill();
  c.restore();
}

// Expanding orange outline used to mark "this window just reacted".
function flashRing(c, x, y, w, h, r, p) {
  c.save();
  c.strokeStyle = COL.accent;
  c.lineWidth = 6;
  c.globalAlpha *= Math.min(1, (1 - p) * 1.4);
  rr(c, x - 4 - 26 * p, y - 4 - 26 * p, w + 8 + 52 * p, h + 8 + 52 * p, r + 8 + 20 * p);
  c.stroke();
  c.lineWidth = 3;
  rr(c, x - 3, y - 3, w + 6, h + 6, r + 3);
  c.stroke();
  c.restore();
}

function wallpaper(c, W, H, theme) {
  const stops = {
    warm: ['#2b2420', '#1d1b22', '#33211a'],
    cool: ['#1d2328', '#1b1d26', '#262029'],
    dark: ['#1d1b19', '#171618', '#241c17'],
  }[theme];
  const g = c.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, stops[0]); g.addColorStop(0.5, stops[1]); g.addColorStop(1, stops[2]);
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  const glow = (x, y, r, rgba) => {
    const rg = c.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, rgba); rg.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = rg; c.fillRect(0, 0, W, H);
  };
  glow(W * 0.78, H * 0.85, Math.max(W, H) * 0.55, 'rgba(242,107,29,0.20)');
  glow(W * 0.15, H * 0.1, Math.max(W, H) * 0.45, 'rgba(124,242,180,0.08)');
}

function topBar(c, W, items, clock) {
  c.fillStyle = 'rgba(20,19,17,0.62)';
  c.fillRect(0, 0, W, 40);
  c.fillStyle = COL.accent;
  c.beginPath(); c.arc(30, 20, 8, 0, Math.PI * 2); c.fill();
  items.forEach((s, i) => txt(c, s, 64 + i * 92, 27, 20, i === 0 ? COL.text : COL.muted, { weight: i === 0 ? 700 : 400 }));
  txt(c, clock, W - 24, 27, 20, COL.muted, { align: 'right' });
}

function appIcon(c, x, y, s, color, letter) {
  rr(c, x, y, s, s, s * 0.24);
  c.fillStyle = color; c.fill();
  txt(c, letter, x + s / 2, y + s / 2 + s * 0.02, s * 0.5, COL.ink, { weight: 800, align: 'center', base: 'middle' });
}

function dock(c, W, H) {
  const n = 7, s = 62, gap = 16, w = n * s + (n - 1) * gap + 40, x = (W - w) / 2, y = H - 94;
  c.fillStyle = 'rgba(30,28,26,0.62)';
  rr(c, x, y, w, 80, 24); c.fill();
  c.strokeStyle = 'rgba(236,231,220,0.12)'; c.lineWidth = 2; c.stroke();
  const cols = [COL.accent, COL.mint, '#6AA7F2', COL.warn, '#B98BF0', COL.danger, '#9AA0A6'];
  'EDTMNSC'.split('').forEach((ch, i) => appIcon(c, x + 20 + i * (s + gap), y + 9, s, cols[i], ch));
}

// Window chrome. Call winEnd() after drawing the content (content is clipped).
function winBegin(c, x, y, w, h, title, bodyColor = '#1f1e1c', barH = 56, r = 16) {
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = 36; c.shadowOffsetY = 16;
  c.fillStyle = bodyColor; rr(c, x, y, w, h, r); c.fill();
  c.restore();
  c.save();
  rr(c, x, y, w, h, r); c.clip();
  c.fillStyle = COL.surface; c.fillRect(x, y, w, barH);
  [COL.danger, COL.warn, COL.ok].forEach((col, i) => { c.fillStyle = col; c.beginPath(); c.arc(x + 30 + i * 28, y + barH / 2, 8, 0, Math.PI * 2); c.fill(); });
  txt(c, title, x + w / 2, y + barH / 2 + 7, 22, COL.muted, { align: 'center' });
}
function winEnd(c, x, y, w, h, dim = 0, r = 16) {
  if (dim > 0) { c.fillStyle = `rgba(20,19,17,${dim})`; c.fillRect(x, y, w, h); }
  c.restore();
  c.strokeStyle = COL.line; c.lineWidth = 2; rr(c, x, y, w, h, r); c.stroke();
}

// ---- Keyln console (Surface, tablet, phone) ---------------------------------------
// Modelled on the real Keyln "Use" screen: connection pill, page tabs, Use/Edit, a grid of
// app keys (icon, name, action), a clock, usage cards, recent activity and the Mac Dock strip.
// App icons are generic shapes and letters, never real product marks.
const UI = {
  bg: '#1E1F22', tile: '#2A2B2F', line: '#3A3B40', text: '#F2F2F3', sub: '#9DA0A6',
  green: '#3FB950', red: '#E5484D', blue: '#2F6FEB',
};

// Icon: bg colour, foreground colour, and either a glyph kind (see glyph()) or a short text.
const I = (bg, g, fg = '#FFFFFF') => ({ bg, g, fg });
const WIN = I('#F4F5F7', 'win', UI.blue);
const APPS = {
  editor: { label: 'Editor', sub: 'Open app', icon: I('#2F6FEB', '</>') },
  build: { label: 'Build', sub: 'Run script', icon: I('#16181C', 'shell', '#7CF2B4') },
  palette: { label: '⌘⇧P', sub: 'Shortcut', icon: I('#5B5F68', 'kbd') },
  work: { label: 'Start Work', sub: 'Workflow', icon: I('#F26B1D', 'flow') },
  docs: { label: 'Docs', sub: 'Activate window', icon: WIN },
  sketch: { label: 'Sketch', sub: 'Open app', icon: I('#F4F5F7', 'S', '#E5484D') },
  notes: { label: 'Notes', sub: 'Open app', icon: I('#F5C542', 'note', '#5A4300') },
  music: { label: 'Music', sub: 'Open app', icon: I('#E5484D', 'music') },
  mail: { label: 'Mail', sub: 'Open app', icon: I('#3D8BFD', 'M') },
  apps: { label: 'Apps', sub: 'Open app', icon: I('#1F9BF0', 'app') },
  chat: { label: 'Chat', sub: 'Open app', icon: I('#8B5CF6', 'C') },
  files: { label: 'Files', sub: 'Open app', icon: I('#4AA3F0', 'F') },
  browser: { label: 'Browser', sub: 'Open app', icon: I('#0EA5E9', 'B') },
  calendar: { label: 'Calendar', sub: 'Open app', icon: I('#F4F5F7', '20', '#E5484D') },
  photos: { label: 'Photos', sub: 'Open app', icon: I('#F59E0B', 'P') },
  camera: { label: 'Camera', sub: 'Open app', icon: I('#3A3D44', 'O') },
  settings: { label: 'Settings', sub: 'Open app', icon: I('#6B7280', '⚙') },
  draw: { label: 'Draw', sub: 'Open app', icon: I('#F97316', 'D') },
  remote: { label: 'Remote', sub: 'Open app', icon: I('#2563EB', 'R') },
  share: { label: 'Screen share', sub: 'Open app', icon: I('#38BDF8', 'S') },
  vault: { label: 'Vault', sub: 'Open app', icon: I('#7C3AED', 'V') },
  viewer: { label: 'Viewer', sub: 'Open app', icon: I('#0EA5E9', 'V') },
  maps: { label: 'Maps', sub: 'Open app', icon: I('#22C55E', 'M') },
  text: { label: 'Text', sub: 'Open app', icon: I('#E5E7EB', 'T', '#16A34A') },
  messages: { label: 'Messages', sub: 'Open app', icon: I('#22C55E', 'chat') },
  lock: { label: 'Lock', sub: 'Shortcut', icon: I('#3A3D44', 'lock') },
  lab: { label: 'Lab PC', sub: 'Activate window', icon: WIN },
  wintest: { label: 'Win · Test', sub: 'Activate window', icon: WIN },
  winbuild: { label: 'Win · Build', sub: 'Activate window', icon: WIN },
  server: { label: 'Server', sub: 'Activate window', icon: WIN },
  macmini: { label: 'Mac mini', sub: 'Activate window', icon: WIN },
};

function glyph(c, kind, cx, cy, s, col) {
  c.save();
  c.translate(cx, cy); c.scale(s / 100, s / 100);
  c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 7; c.lineCap = 'round'; c.lineJoin = 'round';
  const line = (...p) => { c.beginPath(); c.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) c.lineTo(p[i], p[i + 1]); c.stroke(); };
  if (kind === 'app') {
    [0, 1].forEach((i) => [0, 1].forEach((j) => { rr(c, -24 + i * 26, -24 + j * 26, 22, 22, 6); c.fill(); }));
  } else if (kind === 'win') {
    rr(c, -30, -24, 60, 48, 7); c.stroke();
    line(-30, -10, 30, -10);
    c.globalAlpha = 0.35; rr(c, -24, -4, 48, 22, 3); c.fill();
  } else if (kind === 'shell') {
    line(-22, -16, -4, 0, -22, 16); line(4, 18, 24, 18);
  } else if (kind === 'kbd') {
    txt(c, '⌘', 0, 3, 52, col, { weight: 600, align: 'center', base: 'middle' });
  } else if (kind === 'flow') {
    [-26, 0, 26].forEach((dx) => { c.beginPath(); c.arc(dx, 0, 8, 0, Math.PI * 2); c.fill(); });
    line(-18, 0, -8, 0); line(8, 0, 18, 0);
  } else if (kind === 'music') {
    c.beginPath(); c.arc(-9, 16, 10, 0, Math.PI * 2); c.fill();
    line(1, 16, 1, -24, 20, -16);
  } else if (kind === 'note') {
    line(-18, -12, 18, -12); line(-18, 2, 18, 2); line(-18, 16, 6, 16);
  } else if (kind === 'lock') {
    rr(c, -18, -4, 36, 28, 6); c.fill();
    c.beginPath(); c.arc(0, -8, 11, Math.PI, 0); c.stroke();
  } else if (kind === 'chat') {
    rr(c, -26, -20, 52, 34, 14); c.fill();
    c.beginPath(); c.moveTo(-12, 12); c.lineTo(-18, 24); c.lineTo(0, 14); c.fill();
  } else {
    txt(c, kind, 0, 3, kind.length > 2 ? 30 : 46, col, { weight: 800, align: 'center', base: 'middle' });
  }
  c.restore();
}

function appIconTile(c, icon, cx, top, s) {
  rr(c, cx - s / 2, top, s, s, s * 0.24);
  c.fillStyle = icon.bg; c.fill();
  glyph(c, icon.g, cx, top + s / 2, s, icon.fg);
}

// Draw `s` in at most maxW px, cutting with an ellipsis.
function fit(c, s, maxW) {
  if (c.measureText(s).width <= maxW) return s;
  while (s.length > 1 && c.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

// Sent / Done / step chip; k scales it to the tile.
function chip(c, x2, y, kind, text, alpha, k) {
  const dot = { sent: COL.warn, done: UI.green, step: COL.accent }[kind];
  c.font = `600 ${16 * k}px ${SANS}`;
  const w = c.measureText(text).width + 38 * k;
  c.save();
  c.globalAlpha *= alpha;
  c.fillStyle = 'rgba(20,21,23,0.95)'; rr(c, x2 - w, y, w, 26 * k, 13 * k); c.fill();
  c.strokeStyle = UI.line; c.lineWidth = 1.5 * k; c.stroke();
  c.fillStyle = dot; c.beginPath(); c.arc(x2 - w + 15 * k, y + 13 * k, 5 * k, 0, Math.PI * 2); c.fill();
  txt(c, text, x2 - w + 26 * k, y + 19 * k, 16 * k, kind === 'done' ? '#8FD19E' : UI.text, { weight: 600 });
  c.restore();
}

// One key tile at r = {x, y, w, h}, with its press / chip state fx.
function drawTile(c, app, r, fx) {
  const press = fx ? fx.press : 0, k = r.h / 130;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  c.save();
  c.translate(cx, cy); c.scale(1 - 0.05 * press, 1 - 0.05 * press); c.translate(-cx, -cy);
  rr(c, r.x, r.y, r.w, r.h, 6 * k); c.fillStyle = UI.tile; c.fill();
  if (press > 0) {
    c.fillStyle = `rgba(255,255,255,${0.12 * press})`; c.fill();
    c.strokeStyle = COL.accent; c.lineWidth = 3 * k; c.stroke();
  }
  appIconTile(c, app.icon, cx, r.y + 0.12 * r.h, 0.43 * r.h);
  c.font = `700 ${0.165 * r.h}px ${SANS}`;
  txt(c, fit(c, app.label, r.w - 14 * k), cx, r.y + 0.75 * r.h, 0.165 * r.h, UI.text, { weight: 700, align: 'center' });
  txt(c, app.sub, cx, r.y + 0.92 * r.h, 0.125 * r.h, UI.sub, { align: 'center' });
  if (fx && fx.chip) chip(c, r.x + r.w - 6 * k, r.y + 6 * k, fx.chip.kind, fx.chip.text, fx.chip.alpha, k);
  c.restore();
}

function tapRipple(c, r, p) {
  const x = r.x + r.w / 2, y = r.y + r.h * 0.42;
  c.save();
  c.globalAlpha = Math.max(0, 1 - p);
  c.strokeStyle = COL.accent; c.lineWidth = r.h * 0.04; c.beginPath(); c.arc(x, y, r.h * (0.16 + 0.6 * p), 0, Math.PI * 2); c.stroke();
  c.fillStyle = 'rgba(255,255,255,0.4)'; c.beginPath(); c.arc(x, y, r.h * 0.16, 0, Math.PI * 2); c.fill();
  c.restore();
}

// Header: "Mac connected" pill at left; Use / Edit and the settings button at right (k = scale).
function consoleHeader(c, W, k, withEdit) {
  rr(c, 16 * k, 12 * k, 250 * k, 54 * k, 27 * k);
  c.strokeStyle = UI.line; c.lineWidth = 2 * k; c.stroke();
  c.fillStyle = '#0F2A17'; c.beginPath(); c.arc(42 * k, 39 * k, 12 * k, 0, Math.PI * 2); c.fill();
  c.fillStyle = UI.green; c.beginPath(); c.arc(42 * k, 39 * k, 8 * k, 0, Math.PI * 2); c.fill();
  txt(c, 'Mac connected', 64 * k, 47 * k, 23 * k, UI.text, { weight: 600 });
  c.save(); c.strokeStyle = UI.sub; c.lineWidth = 2.5 * k;
  c.beginPath(); c.arc(242 * k, 39 * k, 9 * k, -2.6, 2.2); c.stroke(); c.restore();
  if (!withEdit) return;
  const gx = W - 16 * k - 56 * k, sx = gx - 14 * k - 196 * k;
  rr(c, sx, 10 * k, 196 * k, 58 * k, 6 * k); c.strokeStyle = UI.line; c.stroke();
  rr(c, sx + 5 * k, 15 * k, 92 * k, 48 * k, 4 * k); c.fillStyle = UI.tile; c.fill(); c.strokeStyle = '#55575D'; c.stroke();
  txt(c, 'Use', sx + 51 * k, 47 * k, 22 * k, UI.text, { weight: 600, align: 'center' });
  txt(c, 'Edit', sx + 147 * k, 47 * k, 22 * k, UI.sub, { align: 'center' });
  rr(c, gx, 10 * k, 56 * k, 58 * k, 6 * k); c.fillStyle = UI.tile; c.fill();
  c.save(); c.strokeStyle = UI.text; c.lineWidth = 2.5 * k;
  c.beginPath(); c.arc(gx + 28 * k, 39 * k, 9 * k, 0, Math.PI * 2); c.stroke(); c.restore();
}

function consoleTabs(c, y, k) {
  const tab = (x, letter, color, name, active) => {
    c.fillStyle = color; c.beginPath(); c.arc(x + 16 * k, y, 15 * k, 0, Math.PI * 2); c.fill();
    txt(c, letter, x + 16 * k, y + 1 * k, 17 * k, '#FFFFFF', { weight: 800, align: 'center', base: 'middle' });
    txt(c, name, x + 40 * k, y + 8 * k, 22 * k, active ? UI.text : UI.sub, { weight: active ? 700 : 500 });
    if (active) { c.fillStyle = UI.red; c.fillRect(x - 12 * k, y + 22 * k, 150 * k, 4 * k); }
  };
  tab(24 * k, 'C', UI.red, 'Coding', true);
  tab(194 * k, 'W', UI.blue, 'Windows', false);
}

function card(c, x, y, w, h) { rr(c, x, y, w, h, 4); c.fillStyle = '#25262A'; c.fill(); }

function usageCard(c, x, y, w, title, mark, rows, foot) {
  card(c, x, y, w, 150);
  txt(c, mark, x + 16, y + 30, 18, UI.text, { weight: 700, mono: mark === '</>' });
  txt(c, title, x + 52, y + 30, 19, UI.text, { weight: 700 });
  txt(c, 'remaining', x + w - 14, y + 29, 14, UI.sub, { align: 'right' });
  rows.forEach(([name, pct, reset], i) => {
    const ry = y + 62 + i * 28;
    txt(c, name, x + 16, ry, 15, UI.sub);
    bar(c, x + 58, ry - 9, 58, 6, '#3A3B40'); bar(c, x + 58, ry - 9, 58 * pct, 6, UI.green);
    txt(c, Math.round(pct * 100) + '%', x + 126, ry, 17, UI.text, { weight: 700 });
    txt(c, reset, x + w - 14, ry, 14, UI.sub, { align: 'right' });
  });
  txt(c, foot, x + 16, y + 136, 15, UI.sub);
}

function macDock(c, x, y, s, icons) {
  const gap = 14, w = icons.length * s + (icons.length - 1) * gap + 32;
  rr(c, x, y, w, s + 28, 4); c.strokeStyle = UI.line; c.lineWidth = 2; c.stroke();
  icons.forEach((ic, i) => appIconTile(c, ic, x + 16 + s / 2 + i * (s + gap), y + 14, s));
}

// ---- Surface (3:2, 1536 x 1022): the full screen from the reference screenshot ----
const SURF = { x: 16, y: 132, w: 140, h: 130, gap: 12 };
const SURF_KEYS = [
  ['editor', 0, 0], ['sketch', 1, 0], ['notes', 2, 0], ['music', 3, 0], ['mail', 5, 0], ['apps', 7, 0],
  ['build', 0, 1], ['chat', 1, 1], ['files', 2, 1], ['browser', 3, 1], ['calendar', 4, 1], ['photos', 5, 1], ['camera', 6, 1], ['settings', 7, 1],
  ['palette', 0, 2], ['draw', 1, 2], ['remote', 2, 2], ['share', 3, 2], ['vault', 4, 2], ['viewer', 5, 2], ['maps', 6, 2], ['lock', 7, 2],
  ['work', 0, 3], ['text', 2, 3], ['messages', 3, 3],
  ['docs', 0, 4], ['lab', 1, 4], ['wintest', 2, 4], ['winbuild', 3, 4], ['server', 4, 4], ['macmini', 5, 4],
];
const surfRect = (col, row) => ({ x: SURF.x + col * (SURF.w + SURF.gap), y: SURF.y + row * (SURF.h + SURF.gap), w: SURF.w, h: SURF.h });
function keyRect(id) {
  const e = SURF_KEYS.find((k) => k[0] === id);
  return surfRect(e[1], e[2]);
}

function paintSurface(c, st) {
  const W = 1536, H = 1022;
  c.fillStyle = UI.bg; c.fillRect(0, 0, W, H);
  consoleHeader(c, W, 1, true);
  consoleTabs(c, 96, 1);
  SURF_KEYS.forEach(([id, col, row]) => drawTile(c, APPS[id], surfRect(col, row), st.keys[id]));
  // right column: clock, usage cards, recent activity
  const rx = 1250, rw = 270;
  txt(c, '19:11', rx, 178, 86, UI.text, { weight: 800 });
  txt(c, 'Nov 20   Fri   Week 47', rx, 218, 22, UI.text, { weight: 700 });
  usageCard(c, rx, 242, rw, 'Codex', '</>', [['5h', 0.93, '1h 58m'], ['Week', 0.72, 'Mon 22:59']], 'Seen 2m ago');
  usageCard(c, rx, 404, rw, 'Claude Code', '✳', [['5h', 0.66, '3h 9m'], ['Week', 0.71, 'Wed 09:59']], 'Updated now');
  card(c, rx, 566, rw, 264);
  txt(c, 'Recent', rx + 16, 598, 19, UI.text, { weight: 700 });
  if (!st.recent.length) txt(c, 'No runs yet', rx + 16, 640, 16, UI.sub);
  st.recent.slice(0, 5).forEach((r, i) => {
    const y = 640 + i * 38;
    c.fillStyle = UI.green; c.beginPath(); c.arc(rx + 22, y - 6, 5, 0, Math.PI * 2); c.fill();
    c.font = `600 16px ${SANS}`;
    txt(c, fit(c, r.text, rw - 50), rx + 36, y, 16, i === 0 ? UI.text : UI.sub, { weight: i === 0 ? 600 : 400 });
  });
  // Mac Dock strip
  macDock(c, 16, 900, 68, [APPS.notes.icon, WIN, I('#F26B1D', 'B'), APPS.photos.icon, I('#14B8A6', 'S')]);
  if (st.tap && st.tap.device === 'surface') tapRipple(c, keyRect(st.tap.key), st.tap.p);
}

const keySig = (st, pick) => Object.entries(st.keys).filter(([k]) => pick(k))
  .map(([k, v]) => k + q(v.press) + (v.chip ? v.chip.kind + v.chip.text + q(v.chip.alpha) : '')).join();
const sigSurface = (st) =>
  keySig(st, (k) => !k.includes(':')) + '|' + (st.tap && st.tap.device === 'surface' ? st.tap.key + q(st.tap.p) : '') +
  '|' + st.recent.map((r) => r.text).join() + '|' + q(st.reset);

// ---- 34" ultrawide: generic desktop with a code editor ------------------------
const CODE = (() => {
  let s = 7;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  return Array.from({ length: 40 }, () => {
    const indent = [0, 0, 1, 1, 2, 2, 3][Math.floor(rnd() * 7)];
    const segs = rnd() < 0.12 ? [] : Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({ w: 30 + Math.floor(rnd() * 150), c: Math.floor(rnd() * 5) }));
    return { indent, segs };
  });
})();

function drawEditor(c, x, y, w, h, full) {
  winBegin(c, x, y, w, h, 'main.ts — keyln-demo');
  const sbH = 34, tabH = 44, top = y + 56;
  const sw = Math.min(300, w * 0.22), rpW = lerp(0, 340, full), bpH = lerp(0, 150, full);
  // sidebar
  c.fillStyle = '#232220'; c.fillRect(x, top, sw, h - 56 - sbH);
  for (let i = 0; i < 13; i++) {
    const ind = [0, 1, 1, 2, 2, 1, 0, 1, 1, 1, 2, 0, 1][i];
    bar(c, x + 28 + ind * 24, top + 28 + i * 40, 80 + ((i * 37) % 110), 12, i === 3 ? COL.accent : COL.muted, i === 3 ? 0.9 : 0.35);
  }
  // tabs
  c.fillStyle = '#26241f'; c.fillRect(x + sw, top, w - sw, tabH);
  ['main.ts', 'utils.ts', 'index.html'].forEach((name, i) => {
    const tx = x + sw + 14 + i * 190;
    if (i === 0) { c.fillStyle = '#1f1e1c'; rr(c, tx, top + 6, 176, tabH - 6, 8); c.fill(); }
    txt(c, name, tx + 88, top + 30, 20, i === 0 ? COL.text : COL.muted, { align: 'center' });
  });
  // code
  const x0 = x + sw + 16, codeTop = top + tabH + 20, bottom = y + h - sbH - bpH - 10;
  const n = Math.max(0, Math.floor((bottom - codeTop) / 32));
  for (let i = 0; i < n; i++) {
    const ly = codeTop + i * 32, line = CODE[i % CODE.length];
    txt(c, String(i + 1), x0 + 40, ly + 14, 17, COL.line, { mono: true, align: 'right' });
    let bx = x0 + 70 + line.indent * 36;
    line.segs.forEach((sg) => { bar(c, bx, ly + 3, sg.w, 12, SYN[sg.c], 0.8); bx += sg.w + 12; });
  }
  // extra panels in the full layout
  if (full > 0.01) {
    c.save();
    c.globalAlpha *= full;
    const rx = x + w - rpW;
    c.fillStyle = '#232220'; c.fillRect(rx, top, rpW, h - 56 - sbH);
    c.fillStyle = COL.line; c.fillRect(rx, top, 2, h - 56 - sbH);
    txt(c, 'OUTLINE', rx + 28, top + 40, 17, COL.muted, { weight: 700 });
    for (let i = 0; i < 9; i++) bar(c, rx + 28 + (i % 3) * 22, top + 66 + i * 38, 90 + ((i * 53) % 120), 12, SYN[i % 5], 0.6);
    const py = y + h - sbH - bpH;
    c.fillStyle = '#1b1a18'; c.fillRect(x + sw, py, w - sw - rpW, bpH);
    c.fillStyle = COL.line; c.fillRect(x + sw, py, w - sw - rpW, 2);
    txt(c, 'PROBLEMS', x + sw + 24, py + 38, 17, COL.muted, { weight: 700 });
    for (let i = 0; i < 3; i++) {
      c.fillStyle = i === 1 ? COL.warn : COL.okText; c.beginPath(); c.arc(x + sw + 34, py + 70 + i * 28, 6, 0, Math.PI * 2); c.fill();
      bar(c, x + sw + 56, py + 64 + i * 28, 220 + i * 70, 11, COL.muted, 0.45);
    }
    c.restore();
  }
  // status bar
  c.fillStyle = COL.surface; c.fillRect(x, y + h - sbH, w, sbH);
  txt(c, 'main  ·  0 errors', x + 20, y + h - 11, 17, COL.muted);
  txt(c, 'UTF-8  ·  Ln 12', x + w - 20, y + h - 11, 17, COL.muted, { align: 'right' });
  winEnd(c, x, y, w, h);
}

function drawPalette(c, x, y, w, h, p) {
  const pw = 660, ph = 330, px = x + w / 2 - pw / 2, py = y + 84 - (1 - p) * 16;
  c.save();
  c.globalAlpha *= p;
  c.fillStyle = 'rgba(0,0,0,0.28)'; rr(c, x, y, w, h, 16); c.fill();
  c.shadowColor = 'rgba(0,0,0,0.55)'; c.shadowBlur = 40; c.shadowOffsetY = 16;
  c.fillStyle = COL.surface; rr(c, px, py, pw, ph, 14); c.fill();
  c.shadowColor = 'transparent';
  c.strokeStyle = COL.line; c.lineWidth = 2; c.stroke();
  c.fillStyle = COL.bg; rr(c, px + 16, py + 16, pw - 32, 54, 10); c.fill();
  txt(c, '›', px + 38, py + 53, 30, COL.accent, { weight: 700 });
  txt(c, 'toggle', px + 62, py + 52, 24, COL.text);
  c.fillStyle = COL.accent; c.fillRect(px + 62 + 76, py + 32, 3, 26);
  const rows = [['Toggle sidebar', '⌘B'], ['Go to file', '⌘P'], ['Run task', '⌘⇧B'], ['Split editor', '⌘\\']];
  rows.forEach(([label, key], i) => {
    const ry = py + 86 + i * 58;
    if (i === 0) { c.fillStyle = 'rgba(242,107,29,0.2)'; rr(c, px + 12, ry, pw - 24, 50, 10); c.fill(); }
    txt(c, label, px + 36, ry + 33, 24, i === 0 ? COL.text : COL.muted);
    txt(c, key, px + pw - 36, ry + 33, 22, COL.muted, { align: 'right' });
  });
  c.restore();
}

function paintUltra(c, st) {
  const W = 2048, H = 870, e = st.editor;
  wallpaper(c, W, H, 'warm');
  topBar(c, W, ['Desk', 'File', 'Edit', 'View', 'Window'], '9:41');
  if (e.open > 0.001) {
    const f = e.full, x = lerp(200, 70, f), y = lerp(72, 62, f), w = lerp(1648, 1908, f), h = lerp(684, 704, f);
    const s = 0.92 + 0.08 * e.open;
    c.save();
    c.globalAlpha *= e.open;
    c.translate(x + w / 2, y + h / 2); c.scale(s, s); c.translate(-(x + w / 2), -(y + h / 2));
    drawEditor(c, x, y, w, h, f);
    if (e.palette > 0.001) drawPalette(c, x, y, w, h, e.palette);
    c.restore();
    if (st.flash.editor >= 0) flashRing(c, x, y, w, h, 16, st.flash.editor);
  }
  dock(c, W, H);
}
const sigUltra = (st) => [q(st.editor.open), q(st.editor.full), q(st.editor.palette), q(st.flash.editor), q(st.reset)].join();

// ---- 28" portrait: docs window behind an inbox window -------------------------
function drawInbox(c, x, y, w, h, dim) {
  winBegin(c, x, y, w, h, 'Inbox');
  rr(c, x + 24, y + 76, w - 48, 44, 22); c.fillStyle = COL.bg; c.fill();
  bar(c, x + 52, y + 92, 120, 12, COL.muted, 0.4);
  const av = [COL.accent, COL.mint, '#6AA7F2', COL.warn, '#B98BF0', COL.danger];
  for (let i = 0; i < 8; i++) {
    const ry = y + 144 + i * 84;
    c.fillStyle = av[i % 6]; c.beginPath(); c.arc(x + 54, ry + 32, 24, 0, Math.PI * 2); c.fill();
    bar(c, x + 100, ry + 12, 140 + ((i * 47) % 120), 16, COL.text, 0.8);
    bar(c, x + 100, ry + 42, 260 + ((i * 71) % 220), 12, COL.muted, 0.4);
    c.fillStyle = COL.line; c.fillRect(x + 100, ry + 76, w - 124, 2);
  }
  winEnd(c, x, y, w, h, dim);
}

function paras(c, x, y, w, rows, seed) {
  for (let i = 0; i < rows; i++) bar(c, x, y + i * 30, i === rows - 1 ? w * 0.55 : w * (0.86 + ((i * 7 + seed) % 5) * 0.03), 14, COL.muted, 0.45);
}

function drawDocs(c, x, y, w, h, page, dim) {
  winBegin(c, x, y, w, h, 'Docs — Guide');
  const m = 52, cw = w - m * 2;
  c.save(); c.globalAlpha *= 1 - page;
  bar(c, x + m, y + 120, cw * 0.55, 36, COL.text, 0.9);
  bar(c, x + m, y + 176, cw * 0.35, 16, COL.muted, 0.5);
  bar(c, x + m, y + 240, cw * 0.28, 24, COL.accent, 0.85);
  paras(c, x + m, y + 290, cw, 4, 1);
  bar(c, x + m, y + 440, cw * 0.32, 24, COL.accent, 0.85);
  paras(c, x + m, y + 490, cw, 3, 3);
  c.fillStyle = COL.bg; rr(c, x + m, y + 610, cw, 150, 12); c.fill();
  [0.3, 0.5, 0.4].forEach((k, i) => bar(c, x + m + 28, y + 636 + i * 36, cw * k, 12, SYN[i], 0.8));
  paras(c, x + m, y + 800, cw, 4, 2);
  c.restore();
  c.save(); c.globalAlpha *= page;
  bar(c, x + m, y + 120, cw * 0.4, 36, COL.text, 0.9);
  paras(c, x + m, y + 190, cw, 3, 4);
  c.fillStyle = 'rgba(242,107,29,0.14)'; rr(c, x + m, y + 310, cw, 130, 12); c.fill();
  c.fillStyle = COL.accent; c.fillRect(x + m, y + 310, 6, 130);
  bar(c, x + m + 32, y + 340, cw * 0.5, 18, COL.text, 0.8); paras(c, x + m + 32, y + 380, cw - 64, 2, 5);
  for (let i = 0; i < 4; i++) { c.fillStyle = COL.accent; c.beginPath(); c.arc(x + m + 10, y + 497 + i * 44, 6, 0, Math.PI * 2); c.fill(); bar(c, x + m + 32, y + 490 + i * 44, cw * (0.5 + (i % 3) * 0.12), 14, COL.muted, 0.5); }
  [0, 1, 2].forEach((i) => { c.strokeStyle = COL.line; c.lineWidth = 3; rr(c, x + m + i * (cw / 3 + 6), y + 700, cw / 3 - 14, 110, 12); c.stroke(); bar(c, x + m + 24 + i * (cw / 3 + 6), y + 740, cw / 3 - 62, 14, SYN[i], 0.8); });
  paras(c, x + m, y + 850, cw, 3, 6);
  c.restore();
  winEnd(c, x, y, w, h, dim);
}

function paintPortrait(c, st) {
  const W = 1024, H = 1152, f = st.docs.front, page = st.docs.page;
  wallpaper(c, W, H, 'cool');
  topBar(c, W, ['Desk', 'File', 'View'], '9:41');
  const bump = 1 + 0.025 * Math.sin(Math.PI * f);
  const dx = lerp(206, 60, f), dy = lerp(176, 104, f), dw = lerp(780, 904, f), dh = lerp(850, 980, f);
  const docs = () => {
    c.save();
    c.translate(dx + dw / 2, dy + dh / 2); c.scale(bump, bump); c.translate(-(dx + dw / 2), -(dy + dh / 2));
    drawDocs(c, dx, dy, dw, dh, page, f < 0.35 ? 0.2 : 0);
    c.restore();
  };
  if (f < 0.35) { docs(); drawInbox(c, 40, 96, 700, 860, 0); } else { drawInbox(c, 40, 96, 700, 860, 0.25); docs(); }
  if (st.flash.docs >= 0) flashRing(c, dx, dy, dw, dh, 16, st.flash.docs);
}
const sigPortrait = (st) => [q(st.docs.front), q(st.docs.page), q(st.flash.docs), q(st.reset)].join();

// ---- 16" portable: terminal ---------------------------------------------------
const TERM_LINES = {
  build: ['./build.sh', 'compiling…', 'bundling…', '✓ build finished in 2.1 s'],
  work: ['./start-work.sh', 'opening workspace…', '✓ workspace ready'],
};

function paintSmall(c, st) {
  const W = 1280, H = 798, t = st.term;
  wallpaper(c, W, H, 'dark');
  // Full-bleed terminal: the window fills the panel edge to edge, so the screen reads borderless.
  winBegin(c, 0, 0, W, H, 'build — zsh', '#121110', 64, 0);
  const lines = t.mode ? TERM_LINES[t.mode] : [];
  const step = 88, y0 = 64 + 100, X0 = 56;
  const prompt = (row, cmd) => {
    txt(c, '$', X0, y0 + row * step, 54, COL.mint, { mono: true, weight: 700 });
    if (cmd) txt(c, cmd, X0 + 66, y0 + row * step, 54, COL.text, { mono: true });
  };
  for (let i = 0; i < t.n; i++) {
    if (i === 0) prompt(0, lines[0]);
    else if (lines[i][0] === '✓') txt(c, lines[i], X0, y0 + i * step, 54, COL.okText, { mono: true, weight: 700 });
    else txt(c, lines[i], X0, y0 + i * step, 54, COL.muted, { mono: true });
  }
  if (t.n === 0 || t.n === lines.length) {
    const row = t.n === 0 ? 0 : t.n;
    prompt(row, '');
    c.fillStyle = COL.accent; c.fillRect(X0 + 66, y0 + row * step - 44, 28, 56);
  }
  winEnd(c, 0, 0, W, H, 0, 0);
  if (st.flash.term >= 0) flashRing(c, 8, 8, W - 16, H - 16, 6, st.flash.term);
}
const sigSmall = (st) => [st.term.mode, st.term.n, q(st.flash.term), q(st.reset)].join();

// ---- other control devices: a tablet (4:3) and a phone, same console style, own layout --
// Key ids in state are `${prefix}:${id}`.
const MINI = {
  pad: { W: 1200, H: 900, prefix: 'pad', k: 1.25, cols: 4, kw: 274, kh: 222, gap: 14, gx: 16, gy: 150, tabs: true,
    ids: ['editor', 'music', 'notes', 'sketch', 'chat', 'files', 'browser', 'calendar', 'mail', 'photos', 'maps', 'settings'] },
  phone: { W: 720, H: 1560, prefix: 'phone', k: 1.25, cols: 3, kw: 218, kh: 222, gap: 14, gx: 16, gy: 130, tabs: false, dock: 1380,
    ids: ['notes', 'editor', 'music', 'mail', 'chat', 'files', 'browser', 'calendar', 'photos', 'maps', 'settings', 'sketch', 'apps', 'camera', 'lock'] },
};
const miniRect = (cfg, i) => ({ x: cfg.gx + (i % cfg.cols) * (cfg.kw + cfg.gap), y: cfg.gy + Math.floor(i / cfg.cols) * (cfg.kh + cfg.gap), w: cfg.kw, h: cfg.kh });

function paintMini(cfg) {
  return (c, st) => {
    c.fillStyle = UI.bg; c.fillRect(0, 0, cfg.W, cfg.H);
    consoleHeader(c, cfg.W, cfg.k, cfg.tabs);
    if (cfg.tabs) consoleTabs(c, 112, 1);
    cfg.ids.forEach((id, i) => drawTile(c, APPS[id], miniRect(cfg, i), st.keys[`${cfg.prefix}:${id}`]));
    if (cfg.dock) macDock(c, 16, cfg.dock, 100, [APPS.notes.icon, WIN, I('#F26B1D', 'B'), APPS.photos.icon]);
    if (st.tap && st.tap.device === cfg.prefix) tapRipple(c, miniRect(cfg, cfg.ids.indexOf(st.tap.key.split(':')[1])), st.tap.p);
  };
}
const sigMini = (cfg) => (st) =>
  keySig(st, (k) => k.startsWith(cfg.prefix + ':')) + '|' + (st.tap && st.tap.device === cfg.prefix ? q(st.tap.p) : '') + '|' + q(st.reset);

// ---- factory ------------------------------------------------------------------
function makeScreen(w, h, paint, sig, idle) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const c = canvas.getContext('2d');
  let last = null;
  return {
    canvas,
    /** Repaint if this screen's slice of state changed. Returns true when it did. */
    update(st, force) {
      const s = sig(st);
      if (s === last && !force) return false;
      last = s;
      paint(c, st);
      if (st.reset > 0.001) { // crossfade back to the idle picture
        c.save(); c.globalAlpha = st.reset; paint(c, idle); c.restore();
      }
      return true;
    },
  };
}

/**
 * Where a finger touches key `key` on control device `device` ('surface' | 'pad' | 'phone'):
 * {u, v} in 0..1 across the screen texture (v from the top), at the tap ripple's centre.
 */
export function touchPoint(device, key) {
  if (device === 'surface') {
    const r = keyRect(key);
    return { u: (r.x + r.w / 2) / 1536, v: (r.y + r.h * 0.42) / 1022 };
  }
  const cfg = MINI[device], r = miniRect(cfg, cfg.ids.indexOf(key.split(':')[1]));
  return { u: (r.x + r.w / 2) / cfg.W, v: (r.y + r.h * 0.42) / cfg.H };
}

/** @param idle the state at t=0 (everything closed, nothing sent) */
export function createScreens(idle) {
  return {
    surface: makeScreen(1536, 1022, paintSurface, sigSurface, idle),
    ultra: makeScreen(2048, 870, paintUltra, sigUltra, idle),
    portrait: makeScreen(1024, 1152, paintPortrait, sigPortrait, idle),
    small: makeScreen(1280, 798, paintSmall, sigSmall, idle),
    pad: makeScreen(MINI.pad.W, MINI.pad.H, paintMini(MINI.pad), sigMini(MINI.pad), idle),
    phone: makeScreen(MINI.phone.W, MINI.phone.H, paintMini(MINI.phone), sigMini(MINI.phone), idle),
  };
}
