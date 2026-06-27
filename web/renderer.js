// renderer.js — data-agnostic RioVisualizer rendering core.
//
// Owns the Three.js scene: stadium mesh, flight paths, animated ball(s), labels,
// and two camera modes — manual orbit (debug tool) and a cinematic play-once
// follow camera (OBS overlay). Driven entirely through method calls; knows
// nothing about how the sim data or stadium JSON arrive.
//
//   const r = new HitRenderer({ viewport, labels, cinematic: true, viewMode: 'stream' });
//   r.setStadium(name, stadiumJson);
//   r.setHit(simResult, opts);   // simResult = rio_visualizer.api.simulate() shape
//   r.replay();                  // re-fire the play-once animation
//
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { getTheme, COLLISION_TYPE_KEYS } from './themes.js';

const METERS_TO_FEET = 3.28084;
const PATH_COLORS = [0xffffff, 0xffd24d, 0x6ecbff, 0xff8fe1, 0x9dff8f];

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

let _rainbowTexture = null;
function makeRainbowTexture() {
  if (_rainbowTexture) return _rainbowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  const stops = ['#7a2fd4', '#2f55d4', '#2fb8d4', '#2fd45a', '#e8e02f', '#e8862f', '#d42b2b'];
  stops.forEach((color, i) => g.addColorStop(i / (stops.length - 1), color));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  _rainbowTexture = new THREE.CanvasTexture(c);
  return _rainbowTexture;
}

function fmt(v, feet) {
  return feet ? `${(v * METERS_TO_FEET).toFixed(2)} ft` : `${v.toFixed(2)} m`;
}

export class HitRenderer {
  /**
   * @param {object} o
   * @param {HTMLElement} o.viewport  container for the WebGL canvas
   * @param {HTMLElement} o.labels    container for CSS2D labels
   * @param {boolean} [o.orbit=true]  enable manual OrbitControls (debug tool)
   * @param {boolean} [o.cinematic=false] play-once follow camera (overlay)
   * @param {string}  [o.viewMode='stream']  'stream' | 'debug'
   */
  constructor({ viewport, labels, orbit = true, cinematic = false, viewMode = 'stream', perf = false }) {
    this.viewport = viewport;
    this.viewMode = viewMode;
    this.cinematic = cinematic;
    this.perf = perf; // log frames that blow the budget (opt-in, ?perf=1)

    this.stadiumJsonCache = null;
    this.currentStadiumName = null;
    this.pulsingMaterials = [];
    this.animatedBalls = []; // { mesh, points }
    this.lastSim = null;
    this.lastOpts = { unitsFeet: false, showMaxHeight: false, showCurveOnGround: false };

    // play-once-hold state
    this._playStart = 0;
    this._playing = false;
    this._cam = null; // cinematic framing { from, to, lookFrom, lookTo, durationMs }
    // Render-on-demand: in cinematic mode we only do GPU/label work while the
    // shot is animating (or a hazard pulse needs it). When held on the final
    // frame with nothing moving, frames are skipped so we don't fight the OBS
    // encoder for GPU. `_dirty` forces one render after a discrete change.
    this._dirty = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
    this.camera.position.set(0, 55, -70);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    // Cap the backing resolution. OBS/CEF can report a high devicePixelRatio (or
    // the source gets scaled up), and uncapped this multiplies every antialiased
    // fragment — the main steady-state cost. 2x is plenty for a broadcast canvas.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    viewport.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer({ element: labels });

    if (orbit) {
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.target.set(0, 0, 40);
      this.controls.enableDamping = true;
      this.controls.update();
    }

    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x404040, 1);
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1);
    this.scene.add(this.hemiLight, this.sunLight);

    // The game's X axis is mirrored relative to three.js (1B is +X but should
    // appear on the right from behind home plate), so everything renders inside
    // a group with X flipped. Materials are DoubleSide to survive the flip.
    this.world = new THREE.Group();
    this.world.scale.x = -1;
    this.scene.add(this.world);

    this.stadiumGroup = new THREE.Group();
    this.hitGroup = new THREE.Group();
    this.world.add(this.stadiumGroup, this.hitGroup);

    this.glowTexture = makeGlowTexture();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();

    this._startTime = performance.now();
    this._raf = null;
    this._animate = this._animate.bind(this);
    this._animate();
  }

  resize() {
    const w = this.viewport.clientWidth, h = this.viewport.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    // Re-fit the cinematic frame to the new aspect so flight/landing never clip.
    if (this.cinematic && this.lastSim) this._frameShot();
    this._dirty = true;
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this.buildStadium();
    this.buildHitScene();
    this._dirty = true;
  }

  setStadium(name, json) {
    this.currentStadiumName = name;
    this.stadiumJsonCache = json;
    this.buildStadium();
    this._dirty = true;
  }

  setHit(sim, opts = {}) {
    this.lastSim = sim;
    this.lastOpts = {
      unitsFeet: opts.unitsFeet === true,
      showMaxHeight: opts.showMaxHeight === true,
      showCurveOnGround: opts.showCurveOnGround === true,
    };
    this.buildHitScene();
    if (this.cinematic) {
      this._frameShot();
      this.replay();
    }
  }

  /** Restart the play-once animation from contact. */
  replay() {
    this._playStart = performance.now();
    this._playing = true;
    this._dirty = true;
  }

  applyEnvironment(theme) {
    if (this.viewMode === 'stream') {
      this.viewport.style.background = `linear-gradient(${theme.skyTop}, ${theme.skyBottom})`;
      this.scene.fog = new THREE.FogExp2(new THREE.Color(theme.fog), theme.fogDensity);
      this.hemiLight.color.set(theme.hemi.sky);
      this.hemiLight.groundColor.set(theme.hemi.ground);
      this.hemiLight.intensity = theme.hemi.intensity;
      this.sunLight.color.set(theme.sun.color);
      this.sunLight.intensity = theme.sun.intensity;
      this.sunLight.position.set(...theme.sun.position);
    } else {
      this.viewport.style.background = '#0a0a12';
      this.scene.fog = null;
    }
  }

  buildStadium() {
    if (!this.stadiumJsonCache) return;
    disposeGroup(this.stadiumGroup);
    this.pulsingMaterials = [];

    const theme = getTheme(this.currentStadiumName);
    this.applyEnvironment(theme);

    const positions = [], colors = [];
    const edgePositions = [], edgeColors = [];
    const emissivePositions = {}; // hex color -> positions array (stream lava etc.)

    const pushTri = (pa, pb, pc, collisionType) => {
      // stadium data is y-down; flip to y-up like the pygame renderer does
      const tri = [pa, pb, pc].map(p => [p.X, -p.Y, p.Z]);

      if (this.viewMode === 'stream') {
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

    for (const box of this.stadiumJsonCache['Triangle Collections']) {
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

    if (this.viewMode === 'stream') {
      geo.computeVertexNormals();
      this.stadiumGroup.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
        vertexColors: true, side: THREE.DoubleSide,
      })));

      for (const [hex, pos] of Object.entries(emissivePositions)) {
        const eg = new THREE.BufferGeometry();
        eg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        const mat = new THREE.MeshBasicMaterial({ color: hex, side: THREE.DoubleSide });
        mat.userData.baseColor = new THREE.Color(hex);
        this.pulsingMaterials.push(mat);
        this.stadiumGroup.add(new THREE.Mesh(eg, mat));
      }

      for (const d of theme.decals || []) {
        const mat = d.color === 'rainbow'
          ? new THREE.MeshBasicMaterial({ map: makeRainbowTexture(), side: THREE.DoubleSide })
          : new THREE.MeshBasicMaterial({ color: d.color, side: THREE.DoubleSide });
        const pad = new THREE.Mesh(new THREE.CircleGeometry(d.r, 48), mat);
        pad.rotation.x = -Math.PI / 2;
        pad.position.set(d.x, 0.06, d.z);
        this.stadiumGroup.add(pad);
      }
    } else {
      this.stadiumGroup.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      })));

      const edgeGeo = new THREE.BufferGeometry();
      edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
      edgeGeo.setAttribute('color', new THREE.Float32BufferAttribute(edgeColors, 3));
      this.stadiumGroup.add(new THREE.LineSegments(edgeGeo,
        new THREE.LineBasicMaterial({ vertexColors: true })));
    }
  }

  buildHitScene() {
    disposeGroup(this.hitGroup);
    this.animatedBalls = [];
    if (!this.lastSim) return;
    const sim = this.lastSim, opts = this.lastOpts;
    const stream = this.viewMode === 'stream';
    const theme = getTheme(this.currentStadiumName);

    sim.paths.forEach((path, idx) => {
      const color = PATH_COLORS[idx % PATH_COLORS.length];
      this.hitGroup.add(lineFromPoints(path.points, stream ? theme.lineGlow : color));

      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 12, 12),
        new THREE.MeshBasicMaterial({ color: stream ? 0xffffff : color }));
      if (stream) {
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this.glowTexture, color, transparent: true, depthWrite: false,
          blending: THREE.AdditiveBlending,
        }));
        glow.scale.set(2.2, 2.2, 1);
        ball.add(glow);
      }
      this.hitGroup.add(ball);
      this.animatedBalls.push({ mesh: ball, points: path.points });

      const [fx, fy, fz] = path.final;
      const scale = opts.unitsFeet ? METERS_TO_FEET : 1;
      const dist = Math.hypot(fx, fy, fz);
      this.hitGroup.add(makeLabel(
        `(${(fx * scale).toFixed(2)}, ${(fz * scale).toFixed(2)})\n${fmt(dist, opts.unitsFeet)}`,
        [fx, fy + 0.5, fz], stream ? 'lbl stream' : 'lbl'));

      if (stream) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.35, 0.55, 32),
          new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(fx, 0.03, fz);
        this.hitGroup.add(ring);
      }

      if (opts.showMaxHeight) {
        const mh = path.max_height_point;
        this.hitGroup.add(makeLabel(fmt(mh[1], opts.unitsFeet), [mh[0], mh[1] + 0.5, mh[2]], stream ? 'lbl stream' : 'lbl'));
      }

      if (opts.showCurveOnGround) {
        this.hitGroup.add(lineFromPoints(path.points, 0xff6464, 0.01));
      }
    });

    if (sim.random_points && sim.random_points.length > 0) {
      const geo = new THREE.BufferGeometry().setFromPoints(
        sim.random_points.map(p => new THREE.Vector3(p[0], p[1], p[2])));
      this.hitGroup.add(new THREE.Points(geo,
        new THREE.PointsMaterial({ color: stream ? 0xfff4c8 : 0xffffff, size: 0.35 })));
    }

    if (sim.batter && !stream) {
      for (const b of sim.batter.boxes) {
        this.hitGroup.add(boxWithEdges(b.center, b.size, 0x00ffff, false));
      }
      for (const b of sim.batter.bat_boxes) {
        this.hitGroup.add(boxWithEdges(b.center, b.size, 0xff0000, true));
      }
      this.hitGroup.add(makeLabel(sim.batter.name, sim.batter.label_pos));
    }

    for (const f of (sim.fielders || [])) {
      if (stream) {
        this.hitGroup.add(makeLabel(`${f.position_name}`, [f.coords[0], f.coords[1] + 1.2, f.coords[2]], 'lbl stream'));
      } else {
        this.hitGroup.add(boxWithEdges(f.coords, [1, 1, 1], 0x00ffff, true));
        this.hitGroup.add(makeLabel(`${f.position_name}: ${f.name}`, [f.coords[0], f.coords[1] + 1.2, f.coords[2]]));
      }

      for (const [radius, color] of [[f.running_radius, stream ? 0x66aaff : 0x3355ff], [f.dive_radius, 0xff3333]]) {
        const circle = circleLine(radius, color);
        circle.position.set(f.coords[0], 0.02, f.coords[2]);
        this.hitGroup.add(circle);
        if (f.line_height > 0.01) {
          const top = circleLine(radius, color);
          top.position.set(f.coords[0], f.line_height, f.coords[2]);
          this.hitGroup.add(top);
          const cyl = new THREE.Mesh(
            new THREE.CylinderGeometry(radius, radius, f.line_height, 48, 1, true),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide }));
          cyl.position.set(f.coords[0], f.line_height / 2, f.coords[2]);
          this.hitGroup.add(cyl);
        }
      }
    }
  }

  // ---- cinematic camera ----

  // World X is flipped (world.scale.x = -1), so a game-space path point maps to
  // scene space by negating X.
  _toScene(p) {
    return new THREE.Vector3(-p[0], p[1], p[2]);
  }

  // Distance the camera must sit from a target so a box of `size` fits the
  // current viewport (both axes), given the camera fov + aspect.
  _fitDistance(size) {
    const fov = this.camera.fov * Math.PI / 180;
    const halfV = Math.tan(fov / 2);
    const halfH = halfV * this.camera.aspect;
    const distV = (size.y * 0.5) / halfV;
    const distH = (Math.max(size.x, size.z) * 0.5) / halfH;
    return Math.max(distV, distH) * 1.25 + 6;
  }

  // Compute a fixed broadcast framing for the current shot: camera behind home
  // plate, raised and offset, far enough that the whole arc + landing fit.
  _frameShot() {
    if (!this.lastSim || !this.lastSim.paths.length) return;
    const pts = this.lastSim.paths[0].points.map(p => this._toScene(p));
    const box = new THREE.Box3().setFromPoints(pts);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    const landing = pts[pts.length - 1];
    // azimuth from home plate (origin) to landing, on the ground plane
    const dir = new THREE.Vector3(landing.x, 0, landing.z);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
    dir.normalize();
    const side = new THREE.Vector3(dir.z, 0, -dir.x); // perpendicular, ground plane
    // behind home plate (-dir), pulled to one side, and lifted
    const camDir = new THREE.Vector3()
      .addScaledVector(dir, -1.0)
      .addScaledVector(side, 0.35)
      .add(new THREE.Vector3(0, 0.62, 0))
      .normalize();

    const dist = this._fitDistance(size);
    this._cam = {
      pos: center.clone().addScaledVector(camDir, dist),
      contact: pts[0].clone(),
      landing: landing.clone(),
      lastBall: pts[0].clone(),
    };
    this.camera.position.copy(this._cam.pos);
    this.camera.lookAt(this._cam.contact);
  }

  _updateCinematicCamera() {
    if (!this._cam) return;
    // Fixed framing; the view follows the ball (eased) and settles on landing.
    this.camera.position.lerp(this._cam.pos, 0.08);
    const target = this._cam.lastBall;
    this.camera.lookAt(target);
  }

  _animate() {
    this._raf = requestAnimationFrame(this._animate);
    const now = performance.now();

    if (this.cinematic) {
      // Render-on-demand: while held on the final frame with nothing moving,
      // skip all GPU/label work so we don't contend with the OBS encoder. A
      // hazard pulse or a discrete change (_dirty) still forces a frame.
      const pulsing = this.pulsingMaterials.length > 0;
      if (!this._playing && !pulsing && !this._dirty) return;

      // play-once-hold: advance to the end, then hold on the final frame
      for (const { mesh, points } of this.animatedBalls) {
        let frame = points.length - 1;
        if (this._playing) {
          frame = Math.floor((now - this._playStart) * 60 / 1000);
          if (frame >= points.length - 1) { frame = points.length - 1; this._playing = false; }
        }
        const p = points[Math.max(0, Math.min(frame, points.length - 1))];
        mesh.position.set(p[0], p[1], p[2]);
        if (this._cam) this._cam.lastBall.set(-p[0], p[1], p[2]); // scene space
      }
      this._updateCinematicCamera();
      this._renderFrame(now, pulsing);
      this._dirty = false;
    } else {
      // debug/orbit: loop the ball(s) continuously (always renders)
      const frame = Math.floor((now - this._startTime) * 60 / 1000);
      for (const { mesh, points } of this.animatedBalls) {
        const p = points[frame % points.length];
        mesh.position.set(p[0], p[1], p[2]);
      }
      if (this.controls) this.controls.update();
      this._renderFrame(now, true);
    }
  }

  _renderFrame(now, pulsing) {
    // hazard pulse in stream view (only when there are emissive materials)
    if (pulsing) {
      const pulse = 0.82 + 0.18 * Math.sin(now / 280);
      for (const mat of this.pulsingMaterials) {
        mat.color.copy(mat.userData.baseColor).multiplyScalar(pulse);
      }
    }
    const t0 = this.perf ? performance.now() : 0;
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
    if (this.perf) {
      const dt = performance.now() - t0;
      if (dt > 12) console.warn(`[RioVisualizer] long render frame: ${dt.toFixed(1)}ms`);
    }
  }

  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    disposeGroup(this.stadiumGroup);
    disposeGroup(this.hitGroup);
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
    // The sky gradient lives as a CSS background on the viewport (applyEnvironment),
    // not on the canvas — clear it too, else it lingers after the canvas is gone.
    this.viewport.style.background = '';
  }
}
