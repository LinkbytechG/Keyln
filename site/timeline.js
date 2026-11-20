// timeline.js - the storyboard as data, plus pure functions of time.
// Everything on screen (camera, key chips, windows, pulses) is derived from t,
// never from accumulated side effects, so seeking to any time is always correct.

export const DURATION = 46; // seconds, then the loop restarts
export const RESET_START = 44.6; // screens crossfade back to idle from here
export const STATIC_T = 44.4; // the "final wide shot" used for static frames

// Seconds after a tap: the dot leaves the tablet at +0.2, lands on the Mac at +1.0.
const FLIGHT = 0.8;
const LAND = 1.0;

/*
  Chapter fields
    start   absolute start time (s)
    cam     camera pose reached after `move` seconds: pos, look (meters), fov (deg, for 16:9)
    drift   slow camera movement added over the chapter length
    move    seconds spent easing from the previous pose
    events  taps, at = offset in seconds from chapter start
            run: open | activate | script | shortcut | workflow
*/
export const chapters = [
  {
    id: 'overview', label: 'Overview', start: 0, move: 0,
    caption: 'Turn a tablet into a touch console for your Mac.',
    cam: { pos: [0, 0.8, 2.05], look: [0, 0.22, -0.05], fov: 36 },
    drift: { pos: [0, -0.1, -0.22], look: [0, 0.03, -0.02] },
    events: [],
  },
  {
    id: 'open', label: 'Open app', start: 4, move: 1.6,
    caption: 'Open any app with one tap.',
    cam: { pos: [-0.6, 0.5, 1.15], look: [-0.28, 0.26, -0.1], fov: 42 },
    drift: { pos: [0.05, 0, -0.05], look: [0, 0, 0] },
    events: [{ at: 1.7, key: 'editor', run: 'open', done: 'Done', recent: 'Editor · Done', kind: 'Open app' }],
  },
  {
    id: 'activate', label: 'Activate window', start: 10, move: 1.6,
    caption: 'Bring the exact window forward.',
    cam: { pos: [-0.15, 0.6, 1.55], look: [-0.02, 0.28, -0.05], fov: 42 },
    drift: { pos: [0.03, 0, -0.04], look: [0.01, 0, 0] },
    events: [{ at: 1.7, key: 'docs', run: 'activate', done: 'Done', recent: 'Docs · Done', kind: 'Activate window' }],
  },
  {
    id: 'script', label: 'Run script', start: 15, move: 1.6,
    caption: 'Run scripts you approved on the Mac.',
    cam: { pos: [-0.4, 0.42, 1.05], look: [-0.32, 0.14, -0.05], fov: 42 },
    drift: { pos: [0.04, 0, -0.04], look: [0, 0, 0] },
    events: [{ at: 1.7, key: 'build', run: 'script', done: 'Finished', recent: 'Build · Finished 2.1 s', kind: 'Run script' }],
  },
  {
    id: 'shortcut', label: 'Shortcut', start: 21, move: 1.5,
    caption: 'Send keyboard shortcuts.',
    cam: { pos: [-0.35, 0.55, 1.25], look: [-0.25, 0.31, -0.15], fov: 40 },
    drift: { pos: [0.03, 0, -0.04], look: [0, 0, 0] },
    events: [{ at: 1.5, key: 'palette', run: 'shortcut', done: 'Done', recent: '⌘⇧P · Done', kind: 'Shortcut' }],
  },
  {
    id: 'workflow', label: 'Workflow', start: 25, move: 1.4,
    caption: 'Chain steps into one-tap workflows.',
    cam: { pos: [-0.05, 0.7, 1.85], look: [-0.03, 0.25, -0.08], fov: 38 },
    drift: { pos: [0, 0, 0.02], look: [0, 0, 0] },
    events: [{ at: 1.2, key: 'work', run: 'workflow', done: 'Done', recent: 'Start Work · Done', kind: 'Workflow' }],
  },
  {
    // Any device with a browser can be the console. In the Surface's spot the devices take turns
    // (tablet, then phone), each running an action; then all three stand together once, and the
    // Surface stays. See DEVICES below for the exact timing.
    id: 'devices', label: 'Any device', start: 31, move: 1.4,
    caption: 'Any tablet or phone with a browser can be the console.',
    cam: { pos: [-0.42, 0.5, 1.22], look: [-0.3, 0.12, -0.04], fov: 42 },
    drift: { pos: [0.03, 0, -0.03], look: [0, 0, 0] },
    events: [
      { at: 2.3, key: 'pad:music', device: 'pad', run: 'tap', done: 'Done', recent: 'Music · Done (tablet)', kind: 'Open app' },
      { at: 5.2, key: 'phone:notes', device: 'phone', run: 'tap', done: 'Done', recent: 'Notes · Done (phone)', kind: 'Open app' },
    ],
  },
  {
    id: 'wide', label: 'Local network', start: 41, move: 1.8,
    caption: 'No cloud. No account. Just your local network.',
    // Same pose as chapter 0 at t=0 so the loop is seamless.
    cam: { pos: [0, 0.8, 2.05], look: [0, 0.22, -0.05], fov: 36 },
    drift: { pos: [0, 0, 0], look: [0, 0, 0] },
    events: [],
  },
];

// ---- helpers ----------------------------------------------------------------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const S = (a, b, x) => clamp((x - a) / (b - a));
const smooth = (x) => x * x * (3 - 2 * x);
const easeIO = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const mixV = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const backOut = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2)); // slight overshoot

export const chapterEnd = (i) => (i + 1 < chapters.length ? chapters[i + 1].start : DURATION);

export function chapterIndexAt(t) {
  let idx = 0;
  chapters.forEach((c, i) => { if (t >= c.start) idx = i; });
  return idx;
}

/** Time to show when a chapter is "jumped to" without playing: its finished state. */
export function chapterEndState(i) {
  return Math.min(chapterEnd(i) - 0.05, STATIC_T);
}

// ---- camera -----------------------------------------------------------------
const endPose = (c) => ({
  pos: c.cam.pos.map((v, i) => v + c.drift.pos[i]),
  look: c.cam.look.map((v, i) => v + c.drift.look[i]),
  fov: c.cam.fov,
});

export function cameraAt(t) {
  const i = chapterIndexAt(t);
  const c = chapters[i];
  const prev = endPose(chapters[(i + chapters.length - 1) % chapters.length]);
  const u = clamp((t - c.start) / (chapterEnd(i) - c.start));
  const e = c.move > 0 ? easeIO(S(0, c.move, t - c.start)) : 1;
  const hold = {
    pos: c.cam.pos.map((v, k) => v + c.drift.pos[k] * u),
    look: c.cam.look.map((v, k) => v + c.drift.look[k] * u),
    fov: c.cam.fov,
  };
  return {
    pos: mixV(prev.pos, hold.pos, e),
    look: mixV(prev.look, hold.look, e),
    fov: prev.fov + (hold.fov - prev.fov) * e,
  };
}

// ---- per-run effects --------------------------------------------------------
const EVENTS = chapters.flatMap((c) => c.events.map((e) => ({ ...e, T: c.start + e.at })));

// A hand reaches in before each tap and pulls back after it: s = seconds from the touch (HAND_IN..HAND_OUT).
export const HAND_IN = -0.65, HAND_OUT = 0.75;

// Flying dot, guide arc, Wi-Fi rings and LED blink for one hop starting at P.
function hop(st, t, P, from = 'surface') {
  const s = t - P;
  if (s >= 0 && s < FLIGHT) st.pulses.push({ p: s / FLIGHT, from });
  if (s >= -0.1 && s < FLIGHT + 0.3) st.guide[from] = Math.max(st.guide[from], Math.min(1, (s + 0.1) / 0.2, (FLIGHT + 0.3 - s) / 0.2));
  if (s >= 0 && s < 0.9) st.rings[from] = st.rings[from] < 0 ? s : Math.min(st.rings[from], s);
  const a = s - FLIGHT;
  if (a >= 0 && a < 0.9) st.rings.studio = st.rings.studio < 0 ? a : Math.min(st.rings.studio, a);
  if (a >= 0 && a < 0.5) st.led = Math.max(st.led, Math.sin((Math.PI * a) / 0.5));
}

// Press, tap ripple, "Sent" -> done chip and Recent entry; common to every run.
function keyFx(st, ev, t, doneAt) {
  const s = t - ev.T;
  const k = (st.keys[ev.key] = st.keys[ev.key] || { press: 0, chip: null });
  k.press = s < 0.12 ? s / 0.12 : s < 0.4 ? 1 - (s - 0.12) / 0.28 : 0;
  if (s < 0.8) st.tap = { key: ev.key, device: ev.device || 'surface', p: s / 0.8 };
  if (s >= 0.15 && t < doneAt) k.chip = { kind: 'sent', text: 'Sent', alpha: clamp((s - 0.15) / 0.12) };
  else if (t >= doneAt && t < doneAt + 2.6) k.chip = { kind: 'done', text: ev.done, alpha: clamp((doneAt + 2.6 - t) / 0.4) };
  if (t >= doneAt) st.recent.push({ text: ev.recent, kind: ev.kind, at: doneAt });
  hop(st, t, ev.T + 0.2); // every control device stands in the Surface's spot when it taps
}

const flashAt = (st, name, t, t0) => {
  const s = t - t0;
  if (s >= 0 && s < 1.4) st.flash[name] = s / 1.4;
};

const RUNS = {
  // A plain key run from another device: pulse to the Mac, then "Done" back on that device.
  tap(st, t, ev) {
    keyFx(st, ev, t, ev.T + LAND + 0.6);
  },
  open(st, t, ev) {
    const R = ev.T + LAND;
    st.editor.open = easeIO(S(R, R + 0.7, t));
    keyFx(st, ev, t, R + 0.9);
  },
  activate(st, t, ev) {
    const R = ev.T + LAND;
    st.docs.front = easeIO(S(R, R + 0.45, t));
    flashAt(st, 'docs', t, R);
    keyFx(st, ev, t, R + 0.7);
  },
  script(st, t, ev) {
    const R = ev.T + LAND;
    const n = [0, 1, 2, 3].filter((i) => t >= R + 0.25 + i * 0.7).length;
    st.term = { mode: 'build', n };
    keyFx(st, ev, t, R + 2.65);
  },
  shortcut(st, t, ev) {
    const R = ev.T + LAND;
    st.editor.palette = easeIO(S(R, R + 0.3, t)) * (1 - easeIO(S(R + 2.0, R + 2.35, t)));
    keyFx(st, ev, t, R + 0.5);
  },
  workflow(st, t, ev) {
    const P = (i) => ev.T + 0.2 + 1.05 * i; // hop start of step i
    const A = (i) => P(i) + FLIGHT; // arrival of step i
    const doneAt = A(2) + 1.5;
    keyFx(st, ev, t, doneAt);
    [1, 2].forEach((i) => hop(st, t, P(i)));
    const k = st.keys[ev.key];
    const started = [0, 1, 2].filter((i) => t >= P(i)).length;
    if (started > 0 && t < doneAt) k.chip = { kind: 'step', text: `${started}/3`, alpha: 1 };
    if (t >= A(0)) { st.editor.full = easeIO(S(A(0), A(0) + 0.8, t)); flashAt(st, 'editor', t, A(0)); }
    if (t >= A(1)) { st.docs.page = easeIO(S(A(1), A(1) + 0.6, t)); flashAt(st, 'docs', t, A(1)); }
    if (t >= A(2)) {
      st.term = { mode: 'work', n: [0, 1, 2].filter((j) => t >= A(2) + 0.2 + 0.45 * j).length };
      flashAt(st, 'term', t, A(2));
    }
  },
};

// Any-device chapter, seconds after its start:
//   1.0-1.4 Surface steps out, 1.3-1.8 tablet steps in on the same spot, taps at 2.3;
//   4.0-4.4 tablet out, 4.3-4.8 phone in, taps at 5.2;
//   6.9-7.4 phone moves to its own place, 7.3-7.8 Surface back, 7.5-8.0 tablet back beside it (all three);
//   9.0-9.5 tablet and phone leave; the Surface stays.
function devicesAt(st, t) {
  const D = chapters.find((c) => c.id === 'devices').start, at = (a, b) => S(D + a, D + b, t);
  st.extra.surface = t < D + 7.3 ? 1 - smooth(at(1.0, 1.4)) : backOut(at(7.3, 7.8));
  st.extra.pad = t < D + 7.5 ? backOut(at(1.3, 1.8)) * (1 - smooth(at(4.0, 4.4))) : backOut(at(7.5, 8.0)) * (1 - smooth(at(9.0, 9.5)));
  st.extra.padSide = t < D + 7.5 ? 0 : 1;
  st.extra.phone = backOut(at(4.3, 4.8)) * (1 - smooth(at(9.0, 9.5)));
  st.extra.phoneSide = easeIO(at(6.9, 7.4));
}

/** The complete visual state at time t (pure). */
export function stateAt(t) {
  const st = {
    t,
    chapter: chapterIndexAt(t),
    reset: smooth(S(RESET_START, DURATION, t)),
    keys: {}, tap: null, hand: null, recent: [],
    pulses: [], guide: { surface: 0 }, led: 0, rings: { surface: -1, studio: -1 },
    // Scale of each control device (0 hidden, 1 shown) and, for the tablet and phone, how far they
    // have moved from the Surface's spot (0) to their own place beside it (1).
    extra: { surface: 1, pad: 0, phone: 0, padSide: 0, phoneSide: 0 },
    editor: { open: 0, full: 0, palette: 0 },
    docs: { front: 0, page: 0 },
    term: { mode: null, n: 0 },
    flash: { editor: -1, docs: -1, term: -1 },
  };
  for (const ev of EVENTS) {
    if (t >= ev.T) RUNS[ev.run](st, t, ev);
    const s = t - ev.T;
    if (s >= HAND_IN && s < HAND_OUT) st.hand = { device: ev.device || 'surface', key: ev.key, s };
  }
  devicesAt(st, t);
  st.recent = st.recent.sort((a, b) => b.at - a.at).slice(0, 5);
  return st;
}
