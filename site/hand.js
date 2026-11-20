// hand.js - the tapping hand: a soft, clay-like LEFT hand seen from the back, index finger pointing
// up, the other fingers folded, in a cream cuff. Drawn on a 2D canvas (original artwork, no images).
// HAND.tip is the fingertip in canvas pixels; the 3D sprite is anchored there.

export const HAND = { w: 600, h: 900, tip: { x: 420, y: 92 } };

const SKIN = { hi: '#FFD3B2', mid: '#F7B88E', lo: '#E59A6E', crease: 'rgba(196,112,70,0.38)' };

function lin(c, x0, y0, x1, y1, stops) {
  const g = c.createLinearGradient(x0, y0, x1, y1);
  stops.forEach(([o, col]) => g.addColorStop(o, col));
  return g;
}
function rad(c, x, y, r0, r1, stops) {
  const g = c.createRadialGradient(x, y, r0, x, y, r1);
  stops.forEach(([o, col]) => g.addColorStop(o, col));
  return g;
}
function blob(c, fill, draw) { c.beginPath(); draw(); c.fillStyle = fill; c.fill(); }
function softLine(c, pts, width, color, blur) {
  c.save();
  c.strokeStyle = color; c.lineWidth = width; c.lineCap = 'round'; c.lineJoin = 'round';
  c.filter = `blur(${blur}px)`;
  c.beginPath(); c.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 4) c.quadraticCurveTo(pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
  c.stroke();
  c.restore();
}

// Outline of the back of the hand and the folded fingers, as one soft mass.
function bodyPath() {
  const p = new Path2D();
  p.moveTo(172, 712);                                   // wrist, left
  p.bezierCurveTo(150, 640, 118, 560, 112, 470);        // left side of the hand
  p.bezierCurveTo(106, 400, 112, 350, 140, 330);        // up to the little-finger knuckle
  p.bezierCurveTo(168, 300, 205, 306, 214, 326);        // little-finger knuckle
  p.bezierCurveTo(228, 296, 268, 290, 284, 314);        // ring-finger knuckle
  p.bezierCurveTo(298, 280, 352, 274, 372, 300);        // middle-finger knuckle
  p.bezierCurveTo(392, 318, 410, 326, 430, 330);        // under the index finger
  p.bezierCurveTo(474, 360, 498, 410, 494, 470);        // thumb side, bulging
  p.bezierCurveTo(490, 540, 460, 590, 432, 640);
  p.lineTo(420, 712);                                   // wrist, right
  p.closePath();
  return p;
}

export function drawHand(c) {
  const body = bodyPath();
  const bodyFill = lin(c, 120, 300, 500, 700, [[0, SKIN.hi], [0.45, SKIN.mid], [1, SKIN.lo]]);
  const finger = lin(c, 372, 0, 470, 0, [[0, SKIN.hi], [0.55, SKIN.mid], [1, SKIN.lo]]);

  // 1. drop shadow of the fist only
  c.save();
  c.shadowColor = 'rgba(60,30,15,0.30)'; c.shadowBlur = 30; c.shadowOffsetY = 14;
  c.fillStyle = bodyFill; c.fill(body);
  c.restore();

  // 2. index finger, pointing up (its base is covered by the fist below)
  blob(c, finger, () => c.roundRect(372, 90, 98, 330, 49));
  c.save();
  c.beginPath(); c.roundRect(372, 90, 98, 330, 49); c.clip();
  blob(c, lin(c, 0, 92, 0, 200, [[0, 'rgba(255,220,196,0.5)'], [1, 'rgba(255,220,196,0)']]), () => c.rect(372, 90, 98, 120));
  c.restore();
  // nail with a pale tip
  c.save();
  c.beginPath(); c.roundRect(390, 106, 62, 66, 28); c.clip();
  c.fillStyle = lin(c, 0, 106, 0, 172, [[0, '#FBE7DC'], [0.22, '#FBE7DC'], [0.3, '#F6C5B2'], [1, '#EFB39C']]);
  c.fillRect(390, 106, 62, 66);
  c.restore();
  c.save(); c.strokeStyle = 'rgba(196,112,70,0.30)'; c.lineWidth = 2.5;
  c.beginPath(); c.roundRect(390, 106, 62, 66, 28); c.stroke(); c.restore();

  // 3. the fist over the finger's base, with its light and shade kept inside its outline
  c.fillStyle = bodyFill; c.fill(body);
  c.save();
  c.clip(body);
  c.fillStyle = rad(c, 250, 470, 10, 240, [[0, 'rgba(255,226,204,0.55)'], [1, 'rgba(255,226,204,0)']]); c.fillRect(100, 280, 420, 450);
  c.fillStyle = rad(c, 480, 520, 10, 150, [[0, 'rgba(214,132,90,0.35)'], [1, 'rgba(214,132,90,0)']]); c.fillRect(300, 330, 220, 380);
  [[176, 334, 34], [250, 318, 36], [330, 302, 38]].forEach(([x, y, r]) =>
    blob(c, rad(c, x - 6, y - 6, 2, r, [[0, 'rgba(255,232,214,0.75)'], [1, 'rgba(255,232,214,0)']]), () => c.arc(x, y, r, 0, Math.PI * 2)));
  softLine(c, [214, 330, 219, 350, 222, 372], 7, SKIN.crease, 3);
  softLine(c, [284, 316, 288, 336, 290, 358], 7, SKIN.crease, 3);
  softLine(c, [372, 304, 380, 322, 386, 344], 7, SKIN.crease, 3);   // fold where the index finger leaves the fist
  softLine(c, [128, 360, 138, 420, 150, 470], 6, 'rgba(196,112,70,0.22)', 5);
  c.restore();

  // 4. cuff with a button
  c.save();
  c.shadowColor = 'rgba(60,30,15,0.25)'; c.shadowBlur = 22; c.shadowOffsetY = 10;
  blob(c, lin(c, 140, 0, 440, 0, [[0, '#F7F1EB'], [0.6, '#EFE6DD'], [1, '#DED2C6']]), () => c.roundRect(142, 700, 296, 166, 36));
  c.restore();
  blob(c, lin(c, 0, 700, 0, 740, [[0, '#D9CCBF'], [1, 'rgba(217,204,191,0)']]), () => c.roundRect(142, 700, 296, 40, [36, 36, 0, 0]));
  blob(c, rad(c, 404, 778, 2, 20, [[0, '#7A7C80'], [0.7, '#55575B'], [1, '#3E4044']]), () => c.arc(406, 780, 19, 0, Math.PI * 2));
  blob(c, 'rgba(255,255,255,0.35)', () => c.arc(400, 773, 5, 0, Math.PI * 2));
}
