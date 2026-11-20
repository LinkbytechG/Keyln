// main.js - hero controller: loads the 3D scene, drives time, captions, dots.
import { chapters, DURATION, STATIC_T, stateAt, cameraAt, chapterIndexAt, chapterEndState } from './timeline.js';

const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const canvas = $('#hero-canvas');
const captionEl = $('#caption');
const dotsEl = $('#dots');
const playBtn = $('#play');

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let view = null;
let t = 0;
let wantPlay = !motionQuery.matches; // the user's intent (button), not the effective state
let inView = true;
let raf = 0;
let last = 0;
let shownChapter = -1;

// ---- chapter dots, caption, play button -------------------------------------
function buildDots() {
  chapters.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dot';
    b.innerHTML = '<span class="dot-mark"></span><span class="dot-label"></span>';
    b.querySelector('.dot-label').textContent = c.label;
    b.setAttribute('aria-label', `Chapter ${i + 1} of ${chapters.length}: ${c.label}`);
    b.addEventListener('click', () => seek(i));
    dotsEl.appendChild(b);
  });
}

function showChapter(i) {
  if (i === shownChapter) return;
  shownChapter = i;
  captionEl.textContent = chapters[i].caption;
  [...dotsEl.children].forEach((b, k) => (k === i ? b.setAttribute('aria-current', 'step') : b.removeAttribute('aria-current')));
}

function setPlayLabel() {
  const playing = wantPlay;
  playBtn.setAttribute('aria-pressed', String(playing));
  playBtn.querySelector('.play-label').textContent = playing ? 'Pause' : 'Play';
  playBtn.querySelector('.icon-pause').toggleAttribute('hidden', !playing);
  playBtn.querySelector('.icon-play').toggleAttribute('hidden', playing);
}

// ---- rendering and the loop ---------------------------------------------------
function draw(force) {
  if (!view) return;
  view.render(stateAt(t), cameraAt(t), force);
  showChapter(chapterIndexAt(t));
}

function running() {
  return !!view && wantPlay && inView && !document.hidden;
}

function tick(now) {
  raf = 0;
  if (!running()) return;
  t = (t + Math.min(0.1, (now - last) / 1000)) % DURATION;
  last = now;
  draw(false);
  raf = requestAnimationFrame(tick);
}

function sync() {
  if (running() && !raf) {
    last = performance.now();
    raf = requestAnimationFrame(tick);
  } else if (!running() && raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
}

function seek(i) {
  // Playing: replay the chapter from its start. Paused / reduced motion: show its finished state.
  t = wantPlay ? chapters[i].start : chapterEndState(i);
  draw(true);
  sync();
}

function fitCanvas() {
  const r = canvas.parentElement.getBoundingClientRect();
  if (!view || !r.width || !r.height) return;
  view.resize(Math.round(r.width), Math.round(r.height));
  if (!running()) draw(true);
}

function useFallback(reason) {
  console.warn('Keyln hero: using static fallback.', reason);
  stage.dataset.mode = 'fallback';
  captionEl.textContent = chapters[0].caption;
}

// ---- boot ---------------------------------------------------------------------
async function init() {
  buildDots();
  showChapter(0);
  setPlayLabel();
  playBtn.addEventListener('click', () => {
    wantPlay = !wantPlay;
    setPlayLabel();
    sync();
  });

  try {
    const { createView } = await import('./scene.js');
    view = createView(canvas);
  } catch (err) {
    useFallback(err);
    return;
  }
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); view = null; sync(); useFallback('context lost'); });

  stage.dataset.mode = 'webgl';
  if (!wantPlay) t = STATIC_T; // reduced motion: start on the final wide shot
  // ?t=<seconds> opens paused on that moment (handy for checking or sharing a single frame).
  const fixed = parseFloat(new URLSearchParams(location.search).get('t'));
  if (Number.isFinite(fixed)) { t = Math.min(Math.max(0, fixed), DURATION - 0.01); wantPlay = false; setPlayLabel(); }
  new ResizeObserver(fitCanvas).observe(canvas.parentElement);
  new IntersectionObserver(([e]) => { inView = e.isIntersecting; sync(); }, { threshold: 0.05 }).observe(stage);
  document.addEventListener('visibilitychange', sync);
  motionQuery.addEventListener?.('change', (e) => { if (e.matches) { wantPlay = false; setPlayLabel(); sync(); } });
  fitCanvas();
  draw(true);
  sync();
}

init();
