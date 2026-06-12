import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { buildControls } from './controls.js';
import { getTheme, COLLISION_TYPE_KEYS } from './themes.js';

const METERS_TO_FEET = 3.28084;

// ---- debug-view triangle colors (mirrors utils/viscolor.py + utils/stadium.py) ----
const DEBUG_COLOR_MAP = {
  0x01: [74, 103, 65],   // grass
  0x02: [128, 128, 128], // wall
  0x03: [255, 255, 0],   // out of bounds
  0x04: [0, 0, 255],     // foul line markers
  0x05: [255, 128, 128], // back
  0x06: [165, 92, 42],   // dirt
  0x07: [106, 50, 159],  // pit wall
  0x08: [255, 0, 0],     // pit
  0x09: [22, 83, 126],   // rough terrain
  0x0A: [69, 212, 255],  // water
  0x0B: [255, 208, 63],  // chomp hazard
};

function debugColor(t) {
  let c = DEBUG_COLOR_MAP[t & 0x0f] || [255, 0, 255];
  if ((t & 0xf0) === 0x80) c = [c[0] >> 1, c[1] >> 1, c[2] >> 1];
  return c.map(v => v / 255);
}

function contrastColor(c) {
  return c.map(v => 1 - v / 2);
}

function streamColor(t, theme) {
  const key = COLLISION_TYPE_KEYS[t & 0x0f];
  const hex = theme.palette[key] || '#ff00ff';
  const c = new THREE.Color(hex);
  if ((t & 0xf0) === 0x80) c.multiplyScalar(theme.foulMult);
  return [c.r, c.g, c.b];
}

// ---- renderer setup ----
const viewport = document.getElementById('viewport');

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
camera.position.set(0, 55, -70);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer({ element: document.getElementById('labels') });

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 40);
controls.enableDamping = true;
controls.update();

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x404040, 1);
const sunLight = new THREE.DirectionalLight(0xffffff, 1);
scene.add(hemiLight, sunLight);

// The game's coordinate system is mirrored relative to three.js (1B is +X but
// should appear on the right from behind home plate), so everything renders
// inside a group with X flipped. Materials are DoubleSide to survive the flip.
const world = new THREE.Group();
world.scale.x = -1;
scene.add(world);

const stadiumGroup = new THREE.Group();
const hitGroup = new THREE.Group();
world.add(stadiumGroup, hitGroup);

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
}
window.addEventListener('resize', resize);
resize();

// ---- helpers ----
function disposeGroup(group) {
  group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
    if (obj.isCSS2DObject) obj.element.remove();
  });
  group.clear();
}

function makeLabel(text, pos, cls = 'lbl') {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  const lbl = new CSS2DObject(div);
  lbl.position.set(pos[0], pos[1], pos[2]);
  return lbl;
}

function lineFromPoints(points, color, yOverride = null) {
  const geo = new THREE.BufferGeometry().setFromPoints(
    points.map(p => new THREE.Vector3(p[0], yOverride ?? p[1], p[2])));
  return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
}

function boxWithEdges(center, size, color, filled) {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
  if (filled) {
    group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })));
    group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0xffffff })));
  } else {
    group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color })));
  }
  group.position.set(center[0], center[1], center[2]);
  return group;
}

function circleLine(radius, color, segments = 64) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color }));
}

// radial-gradient sprite texture for the glowing stream-view ball
function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const glowTexture = makeGlowTexture();

// radial rainbow texture for Toy Field's '?' pads
let rainbowTexture = null;
function makeRainbowTexture() {
  if (rainbowTexture) return rainbowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  const stops = ['#7a2fd4', '#2f55d4', '#2fb8d4', '#2fd45a', '#e8e02f', '#e8862f', '#d42b2b'];
  stops.forEach((color, i) => g.addColorStop(i / (stops.length - 1), color));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  rainbowTexture = new THREE.CanvasTexture(c);
  return rainbowTexture;
}

// ---- stadium ----
let stadiumJsonCache = null;
let currentStadiumName = null;
let viewMode = 'stream'; // 'stream' | 'debug'
let pulsingMaterials = [];

function applyEnvironment(theme) {
  if (viewMode === 'stream') {
    viewport.style.background = `linear-gradient(${theme.skyTop}, ${theme.skyBottom})`;
    scene.fog = new THREE.FogExp2(new THREE.Color(theme.fog), theme.fogDensity);
    hemiLight.color.set(theme.hemi.sky);
    hemiLight.groundColor.set(theme.hemi.ground);
    hemiLight.intensity = theme.hemi.intensity;
    sunLight.color.set(theme.sun.color);
    sunLight.intensity = theme.sun.intensity;
    sunLight.position.set(...theme.sun.position);
  } else {
    viewport.style.background = '#0a0a12';
    scene.fog = null;
  }
}

function buildStadium() {
  if (!stadiumJsonCache) return;
  disposeGroup(stadiumGroup);
  pulsingMaterials = [];

  const theme = getTheme(currentStadiumName);
  applyEnvironment(theme);

  const positions = [], colors = [];
  const edgePositions = [], edgeColors = [];
  const emissivePositions = {}; // hex color -> positions array (stream lava etc.)

  const pushTri = (pa, pb, pc, collisionType) => {
    // stadium data is y-down; flip to y-up like the pygame renderer does
    const tri = [pa, pb, pc].map(p => [p.X, -p.Y, p.Z]);

    if (viewMode === 'stream') {
      const key = COLLISION_TYPE_KEYS[collisionType & 0x0f];
      const glow = theme.emissive[key];
      if (glow) {
        (emissivePositions[glow] ||= []).push(...tri[0], ...tri[1], ...tri[2]);
        return;
      }
      const c = streamColor(collisionType, theme);
      for (const v of tri) { positions.push(...v); colors.push(...c); }
    } else {
      const c = debugColor(collisionType);
      const e = contrastColor(c);
      for (const v of tri) { positions.push(...v); colors.push(...c); }
      for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
        edgePositions.push(...tri[i], ...tri[j]);
        edgeColors.push(...e, ...e);
      }
    }
  };

  for (const box of stadiumJsonCache['Triangle Collections']) {
    for (const coll of box['Triangles']) {
      const pts = coll['Points'];
      if (coll['CollectionType'] === 0) { // singles
        for (let i = 0; i + 2 < pts.length; i += 3) {
          pushTri(pts[i].Point, pts[i + 1].Point, pts[i + 2].Point, pts[i + 2].CollisionType);
        }
      } else { // strip
        for (let i = 0; i + 2 < pts.length; i++) {
          pushTri(pts[i].Point, pts[i + 1].Point, pts[i + 2].Point, pts[i + 2].CollisionType);
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  if (viewMode === 'stream') {
    geo.computeVertexNormals();
    stadiumGroup.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      vertexColors: true, side: THREE.DoubleSide,
    })));

    for (const [hex, pos] of Object.entries(emissivePositions)) {
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const mat = new THREE.MeshBasicMaterial({ color: hex, side: THREE.DoubleSide });
      mat.userData.baseColor = new THREE.Color(hex);
      pulsingMaterials.push(mat);
      stadiumGroup.add(new THREE.Mesh(eg, mat));
    }

    for (const d of theme.decals || []) {
      const mat = d.color === 'rainbow'
        ? new THREE.MeshBasicMaterial({ map: makeRainbowTexture(), side: THREE.DoubleSide })
        : new THREE.MeshBasicMaterial({ color: d.color, side: THREE.DoubleSide });
      const pad = new THREE.Mesh(new THREE.CircleGeometry(d.r, 48), mat);
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(d.x, 0.06, d.z);
      stadiumGroup.add(pad);
    }
  } else {
    stadiumGroup.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    })));

    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
    edgeGeo.setAttribute('color', new THREE.Float32BufferAttribute(edgeColors, 3));
    stadiumGroup.add(new THREE.LineSegments(edgeGeo,
      new THREE.LineBasicMaterial({ vertexColors: true })));
  }
}

// ---- hit scene ----
const PATH_COLORS = [0xffffff, 0xffd24d, 0x6ecbff, 0xff8fe1, 0x9dff8f];
let animatedBalls = []; // { mesh, points }
let lastSim = null;
let lastOpts = { unitsFeet: false, showMaxHeight: false, showCurveOnGround: false };

function fmt(v, feet) {
  return feet ? `${(v * METERS_TO_FEET).toFixed(2)} ft` : `${v.toFixed(2)} m`;
}

function buildHitScene() {
  disposeGroup(hitGroup);
  animatedBalls = [];
  if (!lastSim) return;
  const sim = lastSim, opts = lastOpts;
  const stream = viewMode === 'stream';
  const theme = getTheme(currentStadiumName);

  sim.paths.forEach((path, idx) => {
    const color = PATH_COLORS[idx % PATH_COLORS.length];
    hitGroup.add(lineFromPoints(path.points, stream ? theme.lineGlow : color));

    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 12, 12),
      new THREE.MeshBasicMaterial({ color: stream ? 0xffffff : color }));
    if (stream) {
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture, color, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      glow.scale.set(2.2, 2.2, 1);
      ball.add(glow);
    }
    hitGroup.add(ball);
    animatedBalls.push({ mesh: ball, points: path.points });

    const [fx, fy, fz] = path.final;
    const scale = opts.unitsFeet ? METERS_TO_FEET : 1;
    const dist = Math.hypot(fx, fy, fz);
    hitGroup.add(makeLabel(
      `(${(fx * scale).toFixed(2)}, ${(fz * scale).toFixed(2)})\n${fmt(dist, opts.unitsFeet)}`,
      [fx, fy + 0.5, fz], stream ? 'lbl stream' : 'lbl'));

    if (stream) {
      // landing ring marker
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.35, 0.55, 32),
        new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(fx, 0.03, fz);
      hitGroup.add(ring);
    }

    if (opts.showMaxHeight) {
      const mh = path.max_height_point;
      hitGroup.add(makeLabel(fmt(mh[1], opts.unitsFeet), [mh[0], mh[1] + 0.5, mh[2]], stream ? 'lbl stream' : 'lbl'));
    }

    if (opts.showCurveOnGround) {
      hitGroup.add(lineFromPoints(path.points, 0xff6464, 0.01));
    }
  });

  if (sim.random_points.length > 0) {
    const geo = new THREE.BufferGeometry().setFromPoints(
      sim.random_points.map(p => new THREE.Vector3(p[0], p[1], p[2])));
    hitGroup.add(new THREE.Points(geo,
      new THREE.PointsMaterial({ color: stream ? 0xfff4c8 : 0xffffff, size: 0.35 })));
  }

  if (sim.batter && !stream) {
    for (const b of sim.batter.boxes) {
      hitGroup.add(boxWithEdges(b.center, b.size, 0x00ffff, false));
    }
    for (const b of sim.batter.bat_boxes) {
      hitGroup.add(boxWithEdges(b.center, b.size, 0xff0000, true));
    }
    hitGroup.add(makeLabel(sim.batter.name, sim.batter.label_pos));
  }

  for (const f of sim.fielders) {
    if (stream) {
      hitGroup.add(makeLabel(`${f.position_name}`, [f.coords[0], f.coords[1] + 1.2, f.coords[2]], 'lbl stream'));
    } else {
      hitGroup.add(boxWithEdges(f.coords, [1, 1, 1], 0x00ffff, true));
      hitGroup.add(makeLabel(`${f.position_name}: ${f.name}`, [f.coords[0], f.coords[1] + 1.2, f.coords[2]]));
    }

    for (const [radius, color] of [[f.running_radius, stream ? 0x66aaff : 0x3355ff], [f.dive_radius, 0xff3333]]) {
      const circle = circleLine(radius, color);
      circle.position.set(f.coords[0], 0.02, f.coords[2]);
      hitGroup.add(circle);
      if (f.line_height > 0.01) {
        const top = circleLine(radius, color);
        top.position.set(f.coords[0], f.line_height, f.coords[2]);
        hitGroup.add(top);
        const cyl = new THREE.Mesh(
          new THREE.CylinderGeometry(radius, radius, f.line_height, 48, 1, true),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide }));
        cyl.position.set(f.coords[0], f.line_height / 2, f.coords[2]);
        hitGroup.add(cyl);
      }
    }
  }
}

// ---- simulation / UI wiring ----
const statusBox = document.getElementById('status');
const stadiumSelect = document.getElementById('stadium');
const detailsPre = document.getElementById('detailsPre');
const jsonPre = document.getElementById('jsonPre');

let simSeq = 0;
let debounceTimer;

async function simulate(params) {
  jsonPre.textContent = JSON.stringify(params, null, 2);

  const seq = ++simSeq;
  const resp = await fetch('/api/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const sim = await resp.json();
  if (seq !== simSeq) return; // stale response

  if (sim.error) {
    statusBox.textContent = sim.error;
    return;
  }
  statusBox.textContent = (sim.errors || []).join('\n');
  detailsPre.textContent = sim.details ? JSON.stringify(sim.details, null, 2) : '';

  lastSim = sim;
  lastOpts = {
    unitsFeet: params.units_feet === true,
    showMaxHeight: params.show_max_height === true,
    showCurveOnGround: params.show_curve_on_ground === true,
  };
  buildHitScene();
}

function onParamsChanged(params) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => simulate(params), 150);
}

async function loadStadium(name) {
  const resp = await fetch(`/api/stadium/${encodeURIComponent(name)}`);
  stadiumJsonCache = await resp.json();
  currentStadiumName = name;
  buildStadium();
}
stadiumSelect.addEventListener('change', () => loadStadium(stadiumSelect.value));

for (const btn of document.querySelectorAll('[data-mode]')) {
  btn.addEventListener('click', () => {
    viewMode = btn.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach(b =>
      b.classList.toggle('on', b.dataset.mode === viewMode));
    buildStadium();
    buildHitScene();
  });
}

async function init() {
  const { stadiums, default: def } = await (await fetch('/api/stadiums')).json();
  for (const name of stadiums) {
    const opt = document.createElement('option');
    opt.value = opt.textContent = name;
    if (name === def) opt.selected = true;
    stadiumSelect.appendChild(opt);
  }
  await loadStadium(stadiumSelect.value || stadiums[0]);

  fetch('/api/instructions')
    .then(r => r.text())
    .then(t => { document.getElementById('instructionsPre').textContent = t; });

  const form = await buildControls(document.getElementById('controls'), onParamsChanged);
  await simulate(form.buildParams());
}
init();

// ---- render loop ----
const startTime = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const frame = Math.floor((now - startTime) * 60 / 1000);
  for (const { mesh, points } of animatedBalls) {
    const p = points[frame % points.length];
    mesh.position.set(p[0], p[1], p[2]);
  }
  // lava / hazard pulse in stream view
  const pulse = 0.82 + 0.18 * Math.sin(now / 280);
  for (const mat of pulsingMaterials) {
    mat.color.copy(mat.userData.baseColor).multiplyScalar(pulse);
  }
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
animate();
