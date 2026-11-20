// scene.js - the three.js desk scene. Units are meters, desk top surface is y = 0.
// Exports createView(canvas) -> { resize(w, h), render(state, cam, force) }.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createScreens, touchPoint } from './screens.js';
import { HAND, drawHand } from './hand.js';
import { stateAt, HAND_IN, HAND_OUT } from './timeline.js';

const DEVICES_X = -0.1; // metres: the device layout sits this far left of the desk's centre
const REF_ASPECT = 16 / 9; // camera poses in timeline.js are authored for this aspect
const ACCENT = 0xf26b1d;

// ---- small canvas-made textures ------------------------------------------------
function canvasTex(w, h, draw, srgb = true) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const woodTexture = () => canvasTex(1024, 512, (c, w, h) => {
  c.fillStyle = '#2b2119'; c.fillRect(0, 0, w, h);
  let s = 11;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 280; i++) {
    const y = rnd() * h, len = 200 + rnd() * 800, x = rnd() * w;
    c.strokeStyle = rnd() < 0.5 ? `rgba(0,0,0,${0.05 + rnd() * 0.08})` : `rgba(255,200,150,${0.015 + rnd() * 0.03})`;
    c.lineWidth = 1 + rnd() * 3;
    c.beginPath(); c.moveTo(x, y); c.bezierCurveTo(x + len * 0.3, y + rnd() * 8 - 4, x + len * 0.6, y + rnd() * 8 - 4, x + len, y + rnd() * 6 - 3); c.stroke();
  }
});

// Top of a white compact keyboard: silver deck, white keys, a narrow function row,
// half-height arrow keys and a round key top-right. Texture maps onto 0.279 x 0.115 m.
const keyboardTexture = () => canvasTex(1024, 422, (c, w, h) => {
  c.fillStyle = '#d7d8da'; c.fillRect(0, 0, w, h);
  const pad = 22, gap = 7, unit = (w - 2 * pad - 13.5 * gap) / 14.5;
  const key = (x, y, kw, kh, r = 7) => {
    c.fillStyle = 'rgba(0,0,0,0.10)';
    c.beginPath(); c.roundRect(x, y + 2, kw, kh, r); c.fill();
    c.fillStyle = '#fbfbfa';
    c.beginPath(); c.roundRect(x, y, kw, kh, r); c.fill();
  };
  const fnH = unit * 0.55, rowH = unit, top = pad;
  // function row (13 small keys + round key)
  for (let k = 0; k < 13; k++) key(pad + k * ((w - 2 * pad - fnH - gap) / 13), top, (w - 2 * pad - fnH - gap) / 13 - gap, fnH, 5);
  c.fillStyle = '#fbfbfa'; c.beginPath(); c.arc(w - pad - fnH / 2, top + fnH / 2, fnH / 2, 0, Math.PI * 2); c.fill();
  // main rows: widths in key units, each row sums to 14.5
  const rows = [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5],
    [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1.8, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.7],
    [2.3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.2],
  ];
  let y = top + fnH + gap;
  for (const row of rows) {
    let x = pad;
    for (const u of row) { const kw = u * unit + (u - 1) * gap; key(x, y, kw, rowH); x += kw + gap; }
    y += rowH + gap;
  }
  // bottom row: modifiers, space bar, arrows
  let x = pad;
  for (const u of [1, 1, 1, 1.25, 5, 1.25, 1]) { const kw = u * unit + (u - 1) * gap; key(x, y, kw, rowH); x += kw + gap; }
  const ah = (rowH - gap) / 2;
  key(x, y + ah + gap, unit, ah, 5); key(x + unit + gap, y, unit, ah, 5); key(x + unit + gap, y + ah + gap, unit, ah, 5); key(x + 2 * (unit + gap), y + ah + gap, unit, ah, 5);
});

const glowTexture = () => canvasTex(64, 64, (c, w, h) => {
  const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.fillRect(0, 0, w, h);
}, false);

const backdropTexture = () => canvasTex(512, 256, (c, w, h) => {
  const g = c.createRadialGradient(w / 2, h * 0.55, 10, w / 2, h * 0.55, w * 0.6);
  g.addColorStop(0, '#2f2720'); g.addColorStop(0.55, '#1c1815'); g.addColorStop(1, '#141311');
  c.fillStyle = g; c.fillRect(0, 0, w, h);
});

export function createView(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x141311);
  scene.fog = new THREE.Fog(0x141311, 3.2, 7);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const camera = new THREE.PerspectiveCamera(36, 16 / 9, 0.05, 20);

  // ---- materials & helpers ----
  const std = (color, rough, metal, env = 0.5, extra = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, envMapIntensity: env, ...extra });
  const M = {
    wood: std(0xffffff, 0.5, 0, 0.5, { map: woodTexture() }),
    legs: std(0x1d1d20, 0.5, 0.5),
    body: std(0x17171a, 0.5, 0.2, 0.6),
    metal: std(0x2c2c30, 0.4, 0.7, 0.7),
    alu: std(0xbcbec1, 0.35, 0.9, 0.9),
    // Bead-blasted aluminium: even, softly matte metal with bright environment reflections.
    studio: new THREE.MeshPhysicalMaterial({ color: 0xdcdee1, metalness: 0.9, roughness: 0.38, envMapIntensity: 1.7, clearcoat: 0.08, clearcoatRoughness: 0.4 }),
    magicAlu: std(0xe4e5e7, 0.3, 0.85, 1.2),
    magicWhite: new THREE.MeshPhysicalMaterial({ color: 0xf6f6f4, roughness: 0.22, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.2, envMapIntensity: 0.9 }),
    dark: std(0x0c0c0e, 0.6, 0.1),
    glass: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.05, depthWrite: false, envMapIntensity: 1 }),
  };
  const box = (w, h, d, r, mat, shadow = true) => {
    const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, Math.max(0.0005, Math.min(r, Math.min(w, h, d) / 2 - 0.0003))), mat);
    m.castShadow = shadow; m.receiveShadow = shadow;
    return m;
  };
  const place = (obj, x, y, z, parent = scene) => { obj.position.set(x, y, z); parent.add(obj); return obj; };

  // ---- screens ----
  const screens = createScreens(stateAt(0));
  const tex = {};
  const mats = {};
  for (const [k, s] of Object.entries(screens)) {
    const t = new THREE.CanvasTexture(s.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    tex[k] = t;
    mats[k] = new THREE.MeshBasicMaterial({ map: t, toneMapped: false });
  }

  // A flat panel: rounded body, emissive screen plane, faint glass and a soft glow light.
  function makePanel(w, h, bez, depth, mat, glow) {
    const g = new THREE.Group();
    g.add(box(w + 2 * bez, h + 2 * bez, depth, 0.006, M.body));
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    scr.position.z = depth / 2 + 0.0004; g.add(scr);
    const gl = new THREE.Mesh(new THREE.PlaneGeometry(w, h), M.glass);
    gl.position.z = depth / 2 + 0.0009; g.add(gl);
    if (glow) { const l = new THREE.PointLight(glow, 0.12, 1.4, 2); l.position.set(0, 0, 0.35); g.add(l); }
    return g;
  }

  // ---- room: floor, backdrop, desk ----
  const floor = new THREE.Mesh(new THREE.CircleGeometry(5, 48), std(0x171513, 0.95, 0, 0.1));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.74; floor.receiveShadow = true; scene.add(floor);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(7, 3.5), new THREE.MeshBasicMaterial({ map: backdropTexture(), fog: false, toneMapped: false }));
  back.position.set(0, 0.7, -1.6); scene.add(back);

  place(box(2.0, 0.04, 0.8, 0.012, M.wood), 0, -0.02, 0);
  [[-0.94, -0.34], [0.94, -0.34], [-0.94, 0.34], [0.94, 0.34]].forEach(([x, z]) => place(box(0.05, 0.7, 0.05, 0.01, M.legs), x, -0.39, z));
  // Everything added after this point (monitors, Mac Studio, tablet, keyboard, mouse, mug) is a
  // device on the desk; they are shifted together by DEVICES_X before the network visuals are built.
  const firstDevice = scene.children.length;

  // ---- 34" ultrawide, centre back, raised so the 16" fits right under it ----
  const ultra = makePanel(1.0, 0.42, 0.003, 0.016, mats.ultra, 0xffd2a8); // thin 3 mm bezel
  // Bottom edge sits 1 cm above the top of the 16" (its top edge is at y = 0.224).
  place(ultra, 0, 0.447, -0.32).rotation.x = -0.03; // 0.234 + outer half-height 0.213
  place(box(0.07, 0.45, 0.03, 0.008, M.metal), 0, 0.225, -0.355);
  place(box(0.3, 0.012, 0.09, 0.005, M.metal), 0, 0.006, -0.355); // shallow foot, set back behind the portable monitor

  // ---- Portable monitor directly below it: near-borderless (1 mm bezel), 16:10, leaned back ~14 deg.
  // Its top edge just meets the 34"'s bottom bezel (y 0.234, front face z -0.306): outer height 0.239
  // rises 0.232 and runs back 0.057 from a bottom edge on the desk at y 0.002, z -0.245.
  const portable = makePanel(0.379, 0.237, 0.001, 0.008, mats.small, 0xffd2a8);
  place(portable, 0, 0.118, -0.274).rotation.x = -0.24;
  const kick = place(box(0.2, 0.118, 0.005, 0.0025, M.metal), 0, 0.065, -0.304);
  kick.rotation.x = 0.46; // from the panel's back down to the 34" stand base

  // ---- 28" portrait monitor, right, angled toward the user; its left edge meets the 34"'s right edge ----
  // Left front edge = rig + (-0.226, -0.090) for this angle, so it lands at (0.505, -0.31).
  const rig = new THREE.Group();
  place(rig, 0.731, 0, -0.22).rotation.y = -0.38;
  const portrait = makePanel(0.47, 0.52, 0.008, 0.03, mats.portrait, 0xffd2a8);
  place(portrait, 0, 0.4, 0, rig).rotation.x = -0.05;
  place(box(0.07, 0.4, 0.03, 0.008, M.metal), 0, 0.2, -0.035, rig);
  place(box(0.28, 0.012, 0.22, 0.005, M.metal), 0, 0.006, -0.03, rig);

  // ---- Mac Studio: 19.7 cm square, 9.5 cm tall. Rounded only in plan view, crisp small bevels on
  // the top and bottom edges, a dark recessed foot, front ports, SD slot and a status LED.
  // Group origin = centre of the footprint on the desk; front face at z = +0.0985.
  // Tucked back under the corner where the three screens meet: right of the 16", clear of both stand bases.
  const studio = place(new THREE.Group(), 0.36, 0, -0.27);
  const plan = (half, r) => {
    const s = new THREE.Shape();
    s.moveTo(-half + r, -half);
    s.lineTo(half - r, -half); s.quadraticCurveTo(half, -half, half, -half + r);
    s.lineTo(half, half - r); s.quadraticCurveTo(half, half, half - r, half);
    s.lineTo(-half + r, half); s.quadraticCurveTo(-half, half, -half, half - r);
    s.lineTo(-half, -half + r); s.quadraticCurveTo(-half, -half, -half + r, -half);
    return s;
  };
  const FOOT = 0.005, BEV = 0.0018;
  const shell = new THREE.Mesh(
    new THREE.ExtrudeGeometry(plan(0.0985 - BEV, 0.03), { depth: 0.095 - FOOT - 2 * BEV, bevelEnabled: true, bevelThickness: BEV, bevelSize: BEV, bevelSegments: 3, curveSegments: 32 }),
    M.studio
  );
  shell.rotation.x = -Math.PI / 2; // extrude upwards
  shell.position.y = FOOT + BEV;
  shell.castShadow = shell.receiveShadow = true;
  studio.add(shell);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.088, 0.088, FOOT, 64), std(0x0e0e10, 0.7, 0.2, 0.3));
  foot.position.y = FOOT / 2; studio.add(foot);
  const hole = std(0x070708, 0.8, 0, 0.1);
  const FRONT = 0.0986, PORT_Y = FOOT + 0.024;
  // two USB-C ports and the SD slot, recessed dark shapes on the front face
  [-0.064, -0.05].forEach((x) => place(new THREE.Mesh(new THREE.CapsuleGeometry(0.0013, 0.0058, 4, 8), hole), x, PORT_Y, FRONT, studio).rotation.z = Math.PI / 2);
  place(new THREE.Mesh(new THREE.PlaneGeometry(0.024, 0.0018), hole), -0.025, PORT_Y, FRONT, studio);
  const ledMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  place(new THREE.Mesh(new THREE.CircleGeometry(0.0012, 16), ledMat), 0.078, PORT_Y, FRONT + 0.0002, studio);
  const glowTex = glowTexture();
  const ledHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xfff2e0, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0, toneMapped: false }));
  place(ledHalo, 0.078, PORT_Y, FRONT + 0.004, studio);

  // ---- Surface tablet: left of the keyboard, on its kickstand ----
  const tabletRig = new THREE.Group();
  place(tabletRig, -0.36, 0, 0.0).rotation.y = 0.28; // left of the keyboard, set back a little
  const tablet = makePanel(0.287, 0.191, 0.006, 0.008, mats.surface, 0xffd2a8);
  tablet.rotation.order = 'YXZ';
  place(tablet, 0, 0.0935, 0, tabletRig).rotation.x = -0.45;
  const stand = place(box(0.2, 0.136, 0.005, 0.0025, M.metal), 0, 0.0457, -0.0536, tabletRig);
  stand.rotation.x = 0.83;

  // ---- small details: keyboard, mouse, mug ----
  // White compact keyboard: a thin aluminium wedge (4 mm at the front, 10.9 mm at the back)
  // with the key layout as a texture on its sloped top.
  const KB_W = 0.279, KB_D = 0.115, KB_F = 0.004, KB_B = 0.0109;
  const wedge = new THREE.Shape([
    new THREE.Vector2(-KB_D / 2, 0), new THREE.Vector2(KB_D / 2, 0),
    new THREE.Vector2(KB_D / 2, KB_B), new THREE.Vector2(-KB_D / 2, KB_F),
  ]);
  const kbGeo = new THREE.ExtrudeGeometry(wedge, { depth: KB_W, bevelEnabled: true, bevelThickness: 0.0008, bevelSize: 0.0008, bevelSegments: 2 });
  kbGeo.translate(0, 0, -KB_W / 2);
  const kbx = -0.02, kbz = 0.25;
  const kbBody = place(new THREE.Mesh(kbGeo, M.magicAlu), kbx, 0, kbz);
  kbBody.rotation.y = Math.PI / 2; // shape x -> world -z, so the tall edge sits at the back
  kbBody.castShadow = kbBody.receiveShadow = true;
  const tilt = Math.atan((KB_B - KB_F) / KB_D);
  const keys = place(new THREE.Mesh(new THREE.PlaneGeometry(KB_W - 0.002, KB_D - 0.002), std(0xffffff, 0.45, 0, 0.5, { map: keyboardTexture() })), kbx, (KB_F + KB_B) / 2 + 0.0009, kbz);
  keys.rotation.x = -Math.PI / 2 + tilt;
  keys.receiveShadow = true;

  // White mouse: a low glossy dome on a thin silver base.
  const mouse = place(new THREE.Group(), 0.25, 0, 0.25);
  const mBase = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.003, 48), M.magicAlu);
  mBase.scale.set(0.0285, 1, 0.0565); mBase.position.y = 0.0015; mouse.add(mBase);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), M.magicWhite);
  dome.scale.set(0.0283, 0.0185, 0.0563); dome.position.y = 0.003; dome.castShadow = true; mouse.add(dome);
  const mug = place(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.036, 0.09, 24), std(0xd8d2c4, 0.4, 0, 0.6)), 0.6, 0.045, 0.12); // right of the mouse
  mug.castShadow = true;
  const handle = place(new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.006, 8, 16, Math.PI), std(0xd8d2c4, 0.4, 0, 0.6)), 0.04, 0, 0, mug);
  handle.rotation.z = -Math.PI / 2;
  place(new THREE.Mesh(new THREE.CircleGeometry(0.034, 24), std(0x2a1710, 0.3, 0)), 0, 0.0452, 0, mug).rotation.x = -Math.PI / 2;

  // ---- extra control devices for the "any device" chapter: a generic tablet and a phone ----
  // Hidden until that chapter; they scale up from the desk (see render()). No logos.
  const darkBody = std(0x2b2c2f, 0.45, 0.6, 0.7);
  const padRig = place(new THREE.Group(), -0.7, 0, 0.1);
  padRig.rotation.y = 0.42;
  // Tablet: silver aluminium body with an even black glass border around the screen.
  const PAD_W = 0.245, PAD_H = 0.184, PAD_BEZ = 0.011, PAD_D = 0.0065;
  const pad = makePanel(PAD_W, PAD_H, PAD_BEZ, PAD_D, mats.pad);
  pad.children[0].material = std(0xdadcdf, 0.32, 0.9, 1.3);
  const padGlass = new THREE.Mesh(new THREE.PlaneGeometry(PAD_W + 2 * PAD_BEZ - 0.003, PAD_H + 2 * PAD_BEZ - 0.003),
    new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.15, metalness: 0, envMapIntensity: 0.8 }));
  padGlass.position.z = PAD_D / 2 + 0.0002;
  pad.add(padGlass);
  place(pad, 0, 0.097, 0, padRig).rotation.x = -0.42;
  place(box(0.12, 0.1, 0.006, 0.003, M.metal), 0, 0.046, -0.05, padRig).rotation.x = 0.8;

  const phoneRig = place(new THREE.Group(), -0.27, 0, 0.27);
  phoneRig.rotation.y = 0.15;
  place(box(0.08, 0.012, 0.06, 0.005, M.metal), 0, 0.006, -0.01, phoneRig); // cradle
  const phone = makePanel(0.068, 0.148, 0.004, 0.008, mats.phone);
  phone.children[0].material = darkBody;
  place(phone, 0, 0.0865, 0, phoneRig).rotation.x = -0.3;
  place(box(0.05, 0.07, 0.006, 0.003, M.metal), 0, 0.045, -0.035, phoneRig).rotation.x = 0.5;
  padRig.visible = phoneRig.visible = false;

  // Shift the whole device arrangement left so the desk doesn't look empty on the left.
  scene.children.slice(firstDevice).forEach((o) => { o.position.x += DEVICES_X; });

  // ---- lights: warm key, cool rim, weak fill ----
  const key = new THREE.DirectionalLight(0xffd9b0, 2.4);
  key.position.set(-0.9, 1.7, 1.1);
  key.castShadow = true;
  key.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
  Object.assign(key.shadow.camera, { left: -1.3, right: 1.3, top: 1.0, bottom: -1.0, near: 0.5, far: 5 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8ab4ff, 1.1);
  rim.position.set(1.5, 0.8, -1.5);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0x6a6560, 0x1a1816, 0.4));

  // ---- network visuals: guide arc, flying dot, Wi-Fi rings ----
  scene.updateMatrixWorld(true);
  const B = studio.localToWorld(new THREE.Vector3(0, 0.11, 0));
  // One arc per control device, from just above its screen to the Mac Studio.
  // The tablet and phone tap from the Surface's spot, so there is one source.
  const SOURCES = { surface: tablet.localToWorld(new THREE.Vector3(0, 0.11, 0.01)) };
  // Where each control device stands: the Surface's spot (shared during the rotation) and their own places.
  const SPOT = { pos: tabletRig.position.clone(), rot: tabletRig.rotation.y };
  const SIDE = {
    pad: { rig: padRig, pos: padRig.position.clone(), rot: padRig.rotation.y },
    phone: { rig: phoneRig, pos: phoneRig.position.clone(), rot: phoneRig.rotation.y },
  };
  const curves = {}, guides = {};
  for (const [k, A] of Object.entries(SOURCES)) {
    curves[k] = new THREE.QuadraticBezierCurve3(A, A.clone().lerp(B, 0.5).add(new THREE.Vector3(0, 0.3, 0.05)), B);
    const g = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(curves[k].getPoints(48)),
      new THREE.LineDashedMaterial({ color: ACCENT, dashSize: 0.02, gapSize: 0.016, transparent: true, opacity: 0, depthWrite: false })
    );
    g.computeLineDistances();
    scene.add(g);
    guides[k] = g;
  }

  const glowSprite = (color, order) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }));
    s.renderOrder = order; return s;
  };
  const dotGroup = new THREE.Group();
  const halo = glowSprite(0xff7a30, 5), core = glowSprite(0xfff0d8, 6);
  const trail = Array.from({ length: 6 }, () => glowSprite(0xff7a30, 4));
  dotGroup.add(halo, core, ...trail);
  dotGroup.visible = false;
  scene.add(dotGroup);

  function makeRings(pos) {
    const g = new THREE.Group();
    g.position.copy(pos);
    for (let k = 0; k < 3; k++) {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.05, 0.055, 32, 1, Math.PI / 2 - 0.8, 1.6),
        new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false })
      );
      g.add(m);
    }
    g.visible = false; scene.add(g);
    return g;
  }
  const ringsFrom = Object.fromEntries(Object.entries(SOURCES).map(([k, A]) => [k, makeRings(A.clone().add(new THREE.Vector3(0, 0.03, 0)))]));
  const ringsStudio = makeRings(B.clone().add(new THREE.Vector3(0, 0.03, 0)));

  function updateRings(g, s) {
    g.visible = s >= 0;
    if (!g.visible) return;
    g.lookAt(camera.position);
    g.children.forEach((m, k) => {
      const l = (s - 0.15 * k) / 0.6;
      m.visible = l >= 0 && l <= 1;
      if (m.visible) { m.scale.setScalar(0.6 + l * 1.2); m.material.opacity = 0.75 * (1 - l); }
    });
  }

  function updatePulse(st) {
    for (const k of Object.keys(guides)) guides[k].material.opacity = 0.35 * st.guide[k];
    const pl = st.pulses[0];
    dotGroup.visible = !!pl;
    if (!pl) return;
    const p = pl.p * pl.p * (3 - 2 * pl.p);
    const curve = curves[pl.from];
    const at = (u) => curve.getPoint(Math.max(0, u));
    halo.position.copy(at(p)); halo.scale.setScalar(0.07);
    core.position.copy(halo.position); core.scale.setScalar(0.028);
    trail.forEach((s, i) => {
      s.position.copy(at(p - 0.035 * (i + 1)));
      s.scale.setScalar(0.04 * (1 - i / 7));
      s.material.opacity = 0.6 * (1 - i / 6);
    });
  }

  // ---- a hand that taps the touch screens ----
  // A soft, clay-style LEFT pointing hand in a cuff (hand.js; the right hand is on the mouse and the
  // Surface stands to the left), shown as a camera-facing sprite. The sprite's anchor is the
  // fingertip, so the tip sits exactly on the key.
  const handMat = new THREE.SpriteMaterial({ map: canvasTex(HAND.w, HAND.h, (c) => drawHand(c)), transparent: true, depthTest: false, depthWrite: false, toneMapped: false, color: 0xeee8e2 });
  const hand = new THREE.Sprite(handMat);
  hand.center.set(HAND.tip.x / HAND.w, 1 - HAND.tip.y / HAND.h);
  hand.renderOrder = 20; // drawn last, over the device it touches
  handMat.rotation = -0.5; // finger points up and to the right: the hand comes from the lower left
  hand.visible = false;
  scene.add(hand);

  const SCREENS = {
    surface: { panel: tablet, w: 0.287, h: 0.191, d: 0.008 },
    pad: { panel: pad, w: PAD_W, h: PAD_H, d: PAD_D },
    phone: { panel: phone, w: 0.068, h: 0.148, d: 0.008 },
  };
  const tip = new THREE.Vector3(), nrm = new THREE.Vector3(), upv = new THREE.Vector3(), rgt = new THREE.Vector3(), dir = new THREE.Vector3();
  const REACH = 0.12, HAND_SIZE = 0.16; // metres; HAND_SIZE is the drawing's full height (finger to cuff)
  const easeOut = (x) => 1 - Math.pow(1 - x, 3), easeIn = (x) => x * x * x;
  function updateHand(st) {
    const h = st.hand;
    hand.visible = !!h;
    if (!h) return;
    const sc = SCREENS[h.device], { u, v } = touchPoint(h.device, h.key);
    sc.panel.updateWorldMatrix(true, false);
    tip.set((u - 0.5) * sc.w, (0.5 - v) * sc.h, sc.d / 2 + 0.0012);
    sc.panel.localToWorld(tip);
    nrm.set(0, 0, 1).transformDirection(sc.panel.matrixWorld);
    upv.set(0, 1, 0).transformDirection(sc.panel.matrixWorld);
    rgt.set(1, 0, 0).transformDirection(sc.panel.matrixWorld);
    // The finger comes in from the front, a little from below and from the left, like a real tap.
    dir.copy(nrm).addScaledVector(upv, -0.3).addScaledVector(rgt, -0.35).normalize();
    // Distance of the fingertip from the glass: reach in, a slight press, pull back.
    const s = h.s;
    const d = s < 0 ? REACH * (1 - easeOut((s - HAND_IN) / -HAND_IN)) : s < 0.12 ? -0.0012 : REACH * easeIn((s - 0.12) / (HAND_OUT - 0.12));
    const fade = Math.min(1, (s - HAND_IN) / 0.18, (HAND_OUT - s) / 0.18);
    handMat.opacity = Math.max(0, fade);
    hand.position.copy(tip).addScaledVector(dir, d);
    // A little larger while away from the glass, a little smaller at the press.
    const k = s >= 0 && s < 0.12 ? 0.96 : 1 + 0.5 * Math.max(0, d) / REACH;
    hand.scale.set(HAND_SIZE * k * HAND.w / HAND.h, HAND_SIZE * k, 1);
  }

  // ---- camera adaptation for narrow viewports ----
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
  function applyCamera(cam) {
    const aspect = camera.aspect;
    const pull = aspect < REF_ASPECT ? Math.min(1.5, Math.sqrt(REF_ASPECT / aspect)) : 1;
    camLook.fromArray(cam.look);
    camPos.fromArray(cam.pos).sub(camLook).multiplyScalar(pull).add(camLook);
    const tanH = Math.tan((cam.fov * Math.PI) / 360) * REF_ASPECT;
    const tanV = aspect < REF_ASPECT ? tanH / pull / aspect : tanH / REF_ASPECT;
    const fov = Math.min(70, (2 * Math.atan(tanV) * 180) / Math.PI);
    if (Math.abs(camera.fov - fov) > 1e-3) { camera.fov = fov; camera.updateProjectionMatrix(); }
    camera.position.copy(camPos);
    camera.lookAt(camLook);
  }

  // ---- public API ----
  const lastDraw = {};
  const api = {
    resize(w, h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    /** Draw state `st` seen from `cam`. `force` bypasses the 30 fps cap on texture repaints. */
    render(st, cam, force = false) {
      const now = performance.now();
      for (const k of Object.keys(screens)) {
        if (!force && now - (lastDraw[k] || 0) < 30) continue;
        if (screens[k].update(st, force)) { tex[k].needsUpdate = true; lastDraw[k] = now; }
      }
      const kv = 0.35 + 0.65 * st.led;
      ledMat.color.setRGB(kv, kv, kv);
      ledHalo.material.opacity = 0.9 * st.led;
      ledHalo.scale.setScalar(0.03 + 0.03 * st.led);
      applyCamera(cam);
      updatePulse(st);
      for (const k of Object.keys(ringsFrom)) updateRings(ringsFrom[k], st.rings[k]);
      for (const [k, d] of Object.entries(SIDE)) {
        const v = st.extra[k], side = st.extra[k + 'Side'];
        d.rig.visible = v > 0.001;
        d.rig.scale.setScalar(Math.max(0.001, v));
        d.rig.position.lerpVectors(SPOT.pos, d.pos, side);
        d.rig.rotation.y = SPOT.rot + (d.rot - SPOT.rot) * side;
      }
      // Scaled, not hidden: hiding would switch off its screen-glow light and force a shader recompile.
      tabletRig.scale.setScalar(Math.max(0.001, st.extra.surface));
      updateRings(ringsStudio, st.rings.studio);
      updateHand(st);
      renderer.render(scene, camera);
    },
  };
  return api;
}
