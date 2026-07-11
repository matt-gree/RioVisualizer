// renderer.js — data-agnostic RioVisualizer rendering core.
//
// Owns the Three.js scene: stadium mesh, flight paths, animated ball(s), labels,
// and the camera systems — manual orbit (debug tool), a cinematic play-once
// follow camera (live OBS overlay), and a set of named fixed-cam broadcast
// modes (character spotlight). Driven entirely through method calls; knows
// nothing about how the sim data or stadium JSON arrive.
//
//   const r = new HitRenderer({ viewport, labels, cinematic: true, viewMode: 'stream' });
//   r.setStadium(name, stadiumJson);
//   r.setHit(simResult, opts);   // simResult = rio_visualizer.api.simulate() shape
//   r.replay();                  // re-fire the play-once animation
//
// setHit(sim, opts) options:
//   unitsFeet          bool — label units. Default: feet in stream view,
//                      meters in debug view (pass an explicit bool to force).
//   showMaxHeight      bool — label the apex of each path.
//   showCurveOnGround  bool — extra flattened copy of each path (debug aid).
//   camera             string — fixed-cam camera mode name; see CAMERA MODES.
//   hero               bool — alias for camera: 'hero' (back-compat).
//   spray              bool — spray-chart mode: no ball flight; trails
//                      materialize staggered, markers pop; the camera holds a
//                      static establishing view until every trail has drawn
//                      on, then drifts in a slow back-and-forth partial orbit.
//   batterHand         'Left' | 'Right' | null — highlight the batter's box
//                      the batter stands in (null clears; omit = unchanged).
//
// Per-path flags consumed from sim.paths[i]:
//   points  [[x,y,z], ...] 60 fps flight samples (game coords)
//   final   [x,y,z] landing point
//   out     bool — red-X landing marker + trail transitions to red after
//           landing (plain trails fade; a star shimmer blends to red)
//   hr      bool — home run: celebratory gradient-crawl tube trail. The drawn
//           flight is truncated where it first meets stadium geometry
//           (_truncateAtStadium) so the ball visibly stops at the stands
//           instead of clipping through; the distance label keeps the
//           recorded (untruncated) carry.
//   star    bool — star swing: shimmering golden crawl + soft opacity pulse.
//           Outranks hr when both are set (a star-swing homer still reads
//           "star swing" — the HR is already told by the camera, the stamp
//           and the distance label; the swing identity has no other channel).
//
// In spray mode the hr/star gradient crawls loop for as long as the chart is
// displayed (never freeze); in walkthrough mode they freeze after a hold.
//
// clearHit({ animate: true }) empties the theater and GLIDES the camera back
// to the locked broadcast pose (fixedCam) instead of snapping — the reset
// reads as part of the replay sequence.
//
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { getTheme, COLLISION_TYPE_KEYS } from './themes.js';

const METERS_TO_FEET = 3.28084;
const PATH_COLORS = [0xffffff, 0xffd24d, 0x6ecbff, 0xff8fe1, 0x9dff8f];

// ---- effect timing (all cinematic-mode; pure functions of elapsed time) ----
const RED_FADE_MS = 500;            // out-trail color fade after landing
const OUT_RED = new THREE.Color(0xff3b30); // matches the landing X marker
const TRAIL_RADIUS = 0.34;          // every flight trail is a tube this thick; the HR
                                    // treatment is distinct by gradient, not girth
const HR_CRAWL_HOLD_MS = 4000;      // gradient keeps crawling this long after landing, then freezes
const HR_CRAWL_PERIOD_MS = 1200;    // one full gradient cycle
const HR_GRAD_REPEAT = 1.5;         // gradient cycles visible along the trail at once
// celebratory default; a theme may override via theme.hrGradient
const HR_GRADIENT = ['#ffd24d', '#ffffff', '#ff8fe1', '#57e0e7'];
// star-swing trail: golden shimmer (faster crawl + tighter repeats than the HR
// parade, plus a soft opacity pulse) — reads as "star swing" with no UI
const STAR_GRADIENT = ['#ffd24d', '#fff3b0', '#e8a013', '#ffe98a'];
const STAR_CRAWL_HOLD_MS = 4000;    // shimmer runs this long after landing, then freezes
const STAR_CRAWL_PERIOD_MS = 650;
const STAR_GRAD_REPEAT = 3;
const STAR_PULSE_PERIOD_MS = 900;   // opacity breathing period
const SPRAY_REVEAL_MS = 450;        // per-trail draw-on duration (spray mode)
const SPRAY_STAGGER_MS = 110;       // per-trail start offset (spray mode)
const SPRAY_SETTLE_MS = 1400;       // static establishing hold after the last trail lands
// spray idle drift — a PRESENTATION camera, not a replay camera: a whole-
// field aerial that can hold on screen indefinitely. Very slow pendulum yaw
// around the field plus a softer radius/height breathe on an incommensurate
// period, so the large, gradual motion never reads as a repeating loop.
const SPRAY_ORBIT_ARC = 0.3;        // rad — peak yaw either side of the establishing view
const SPRAY_ORBIT_PERIOD_MS = 52000; // one full back-and-forth
const SPRAY_BREATHE = 0.055;        // ± radius scale (also breathes the height)
const SPRAY_BREATHE_PERIOD_MS = 34000;
const SPRAY_ORBIT_RAMP_MS = 6000;   // velocity ease-in so the hold releases imperceptibly
const SPRAY_AERIAL = 0.7;           // vertical component of the establishing direction
const HERO_HOLD_MS = 450;           // hero cam: contact hold before the crane starts
const HERO_GLIDE_EXTRA_MS = 700;    // hero cam keeps gliding this long past landing
const HERO_SETTLE_MS = 1100;        // hero cam: look settles on the landing after the glide
const HERO_WALL_MARGIN_M = 6;       // hero cam may chase this far past the wall, no further
const FOLLOW_PUSH_M = 7;            // follow cam: push-in distance over the flight
const FOLLOW_SETTLE_MS = 1000;      // follow cam: look settles after landing
// gentle cam — the automatic short-hit variant of hero/follow, speaking the
// SAME language as the big-hit cameras: an eased move TOWARD the play while
// tracking the ball, sized for a shallow ball. A real push toward the
// landing (follow pushes 7 m; gentle 4.5 m) plus a crane-up that keeps the
// framing slightly wider than broadcast so the move stays easy to follow —
// consistent with the long-hit treatment, just less dramatic.
const GENTLE_RISE_M = 2.5;          // crane-up keeps the framing a touch wider
const GENTLE_PUSH_M = 4.5;          // push toward the landing (follow uses 7)
const GENTLE_MOVE_MS = 1600;        // minimum eased move duration (flight can run longer)
const GENTLE_SETTLE_MS = 1200;      // look keeps settling this long after landing
const GENTLE_LOOK_LERP = 0.07;      // match follow's tracking energy
const GENTLE_RECOMMENDED_HOLD_MS = 2300; // see recommendedHoldMs()
const RETURN_MS = 1150;             // clearHit({animate}) glide back to the broadcast pose
const ANIM_TAIL_MS = 150;           // extra rendered frames so the final state lands on screen

// the locked broadcast pose (lockCamera)
const BROADCAST_POS = [0, 19, -32];
const BROADCAST_LOOK = [0, 2, 42];
// pitcher's mound center (game/scene z; x = 0), every stadium
const MOUND_Z = 18.5;
const UP_Y = new THREE.Vector3(0, 1, 0);

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

// Sample a wrapping multi-stop gradient at t (any real; wraps into [0,1)).
function sampleGradient(stops, t, out) {
  const n = stops.length;
  const x = (((t % 1) + 1) % 1) * n;
  const i = Math.floor(x) % n;
  return out.copy(stops[i]).lerp(stops[(i + 1) % n], x - Math.floor(x));
}

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

// whole=true → broadcast style: whole feet, no decimals ("342 ft")
function fmt(v, feet, whole = false) {
  if (!feet) return `${v.toFixed(2)} m`;
  const ft = v * METERS_TO_FEET;
  return whole ? `${Math.round(ft)} ft` : `${ft.toFixed(2)} ft`;
}

export class HitRenderer {
  /**
   * @param {object} o
   * @param {HTMLElement} o.viewport  container for the WebGL canvas
   * @param {HTMLElement} o.labels    container for CSS2D labels
   * @param {boolean} [o.orbit=true]  enable manual OrbitControls (debug tool)
   * @param {boolean} [o.cinematic=false] play-once follow camera (overlay)
   * @param {boolean} [o.fixedCam=false] cinematic variant: named broadcast
   *                  camera modes (see CAMERA MODES below); default mode is
   *                  the locked framing from lockCamera()
   * @param {string}  [o.viewMode='stream']  'stream' | 'debug'
   * @param {number}  [o.shortHitM] landing distance (m, horizontal) below
   *                  which hero/follow swap for the gentle short-hit camera.
   *                  Default HitRenderer.SHORT_HIT_DISTANCE_M.
   */
  constructor({ viewport, labels, orbit = true, cinematic = false, fixedCam = false, viewMode = 'stream', perf = false, shortHitM = null }) {
    this.viewport = viewport;
    this.viewMode = viewMode;
    this.cinematic = cinematic;
    this.fixedCam = fixedCam;
    this.perf = perf; // log frames that blow the budget (opt-in, ?perf=1)
    this.shortHitM = shortHitM ?? HitRenderer.SHORT_HIT_DISTANCE_M;

    this.stadiumJsonCache = null;
    this.currentStadiumName = null;
    this._wallProfile = null; // per-azimuth outfield-wall distances (hero clamp)
    this._stadiumMesh = null; // stream stadium mesh (HR truncation raycasts)
    this._lastShotShort = false; // last setHit resolved to the gentle cam
    this.pulsingMaterials = [];
    this.animatedBalls = []; // { mesh, points }
    this.trails = [];        // per-path effect state (cinematic stream mode)
    this._drawnStops = [];   // per-path truncated stop point (game coords) or null
    this.lastSim = null;
    this.lastOpts = {
      unitsFeet: null, showMaxHeight: false, showCurveOnGround: false,
      spray: false, hero: false, camera: null,
    };

    // play-once-hold state
    this._playStart = 0;
    this._playing = false;
    this._flightMs = 0;      // longest ball flight in the current shot (0 in spray mode)
    this._fxMs = 0;          // when the last trail effect (red fade / HR crawl) ends
    this._totalAnimMs = 0;   // effects + camera; drives _animUntil on replay()
    this._animUntil = 0;     // absolute time until which frames must render
    this._cam = null; // legacy cinematic framing { pos, contact, landing, lastBall }
    // fixed-cam camera-mode state
    this._camModeName = 'broadcast';
    this._camState = null;
    this._camStart = 0;
    this._camMs = 0;
    this._camLookCur = null; // smoothed look-at target (hero/follow)
    this._ballScene = new THREE.Vector3(); // paths[0] ball, scene space
    this._tmpLook = new THREE.Vector3();
    this._tmpCol = new THREE.Color();
    // batter's-box handedness highlight
    this._batterHand = null;
    this._handBoxes = null;
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
    // Re-fit the cinematic framing to the new aspect so flight/landing never clip.
    if (this.cinematic && this.lastSim) {
      if (this.fixedCam) this._setupCameraMode(this._camModeName);
      else this._frameShot();
    }
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
    this._wallProfile = this._computeWallProfile(json);
    this.buildStadium();
    if (this.fixedCam) this.lockCamera();
    this._dirty = true;
  }

  // Per-azimuth outfield-wall distance profile (game coords, horizontal),
  // measured from wall-typed collision triangles. Azimuth 0 = dead center
  // field; ±~45° = the foul lines. Used to stop the hero crane at the fence.
  _computeWallProfile(json) {
    const N = 24, HALF = Math.PI / 3.2; // wedge slightly wider than fair territory
    const buckets = new Array(N).fill(Infinity);
    const all = [];
    for (const box of json['Triangle Collections']) {
      for (const coll of box['Triangles']) {
        const pts = coll['Points'];
        const step = coll['CollectionType'] === 0 ? 3 : 1;
        for (let i = 0; i + 2 < pts.length; i += step) {
          if ((pts[i + 2].CollisionType & 0x0f) !== 0x02) continue; // wall only
          const cx = (pts[i].Point.X + pts[i + 1].Point.X + pts[i + 2].Point.X) / 3;
          const cz = (pts[i].Point.Z + pts[i + 1].Point.Z + pts[i + 2].Point.Z) / 3;
          const d = Math.hypot(cx, cz);
          if (d < 40) continue; // backstop / dugout walls
          const az = Math.atan2(cx, cz);
          if (Math.abs(az) > HALF) continue;
          const b = Math.min(N - 1, Math.floor(((az + HALF) / (2 * HALF)) * N));
          buckets[b] = Math.min(buckets[b], d);
          all.push(d);
        }
      }
    }
    if (!all.length) return null;
    all.sort((a, b) => a - b);
    return { buckets, half: HALF, median: all[(all.length - 1) >> 1] };
  }

  // Wall distance (m from home) at a game-coords azimuth: nearest populated
  // bucket, falling back to the stadium's median wall distance.
  _wallDistanceAt(az) {
    const wp = this._wallProfile;
    if (!wp) return null;
    const N = wp.buckets.length;
    const b0 = Math.max(0, Math.min(N - 1, Math.floor(((az + wp.half) / (2 * wp.half)) * N)));
    for (let r = 0; r < N; r++) {
      for (const b of r === 0 ? [b0] : [b0 - r, b0 + r]) {
        if (b >= 0 && b < N && wp.buckets[b] < Infinity) return wp.buckets[b];
      }
    }
    return wp.median;
  }

  // Stop a home-run flight where it first enters stadium geometry (stands /
  // back wall) instead of clipping through it. Returns `points` unchanged, or
  // a shortened copy ending at the intersection. Raycasts segment-by-segment
  // against the stream stadium mesh, but only once the ball is past ~70% of
  // the outfield-wall distance at its azimuth (cheap prefilter) — a one-time
  // cost per HR shot, not per frame.
  _truncateAtStadium(points) {
    const mesh = this._stadiumMesh;
    if (!mesh || points.length < 2) return points;
    const last = points[points.length - 1];
    const wall = this._wallDistanceAt(Math.atan2(last[0], last[2]));
    const startDist = wall != null ? wall * 0.7 : 60;
    this.scene.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    const a = new THREE.Vector3(), seg = new THREE.Vector3();
    for (let i = 0; i < points.length - 1; i++) {
      const p = points[i], q = points[i + 1];
      if (Math.hypot(p[0], p[2]) < startDist) continue;
      // world X is flipped (world.scale.x = -1): game → scene negates X
      a.set(-p[0], p[1], p[2]);
      seg.set(-q[0], q[1], q[2]).sub(a);
      const len = seg.length();
      if (len < 1e-6) continue;
      ray.set(a, seg.divideScalar(len));
      ray.far = len;
      const hit = ray.intersectObject(mesh, false)[0];
      if (hit) {
        const cut = points.slice(0, i + 1);
        cut.push([-hit.point.x, hit.point.y, hit.point.z]);
        return cut;
      }
    }
    return points;
  }

  // The locked broadcast framing: high behind home plate, wide enough that any
  // recorded arc (apex ~45m, HR landings ~130m, foul-ground bunts) stays in
  // frame without ever moving. Standard MLB-dimension stadiums, meters.
  lockCamera() {
    this.camera.position.set(...BROADCAST_POS);
    this.camera.lookAt(...BROADCAST_LOOK);
    this._dirty = true;
  }

  /** Highlight the batter's box for a hand ('Left' | 'Right'); null clears. */
  setBatterHand(hand) {
    let norm = null;
    if (typeof hand === 'string') {
      const c = hand.trim().toLowerCase()[0];
      norm = c === 'l' ? 'Left' : c === 'r' ? 'Right' : null;
    }
    this._batterHand = norm;
    this._applyBatterHand();
    this._dirty = true;
  }

  _applyBatterHand() {
    if (!this._handBoxes) return;
    for (const [hand, box] of Object.entries(this._handBoxes)) {
      const on = hand === this._batterHand;
      box.userData.fillMat.opacity = on ? 0.3 : 0;
      box.userData.outlineMat.opacity = on ? 0.95 : 0.5;
    }
  }

  setHit(sim, opts = {}) {
    this.lastSim = sim;
    this.lastOpts = {
      // null = default by view mode (feet in stream, meters in debug)
      unitsFeet: typeof opts.unitsFeet === 'boolean' ? opts.unitsFeet : null,
      showMaxHeight: opts.showMaxHeight === true,
      showCurveOnGround: opts.showCurveOnGround === true,
      spray: opts.spray === true,
      hero: opts.hero === true,
      camera: typeof opts.camera === 'string' ? opts.camera : null,
    };
    if (opts.batterHand !== undefined) this.setBatterHand(opts.batterHand);
    this.buildHitScene();
    if (this.cinematic) {
      if (this.fixedCam) {
        const mode = this._resolveCameraMode();
        // gentle eases from the camera's current pose — no snap reset
        if (mode !== 'gentle') this.lockCamera();
        this._setupCameraMode(mode);
      } else {
        this._frameShot();
        this._totalAnimMs = this._fxMs + ANIM_TAIL_MS;
      }
      this.replay();
    } else {
      this._dirty = true;
    }
  }

  /**
   * Empty the hit scene (trails, balls, markers, labels) and return to the
   * locked broadcast pose (fixedCam). With { animate: true } the camera
   * GLIDES back home (RETURN_MS, eased) instead of snapping, so the reset
   * reads as part of the replay sequence — the Character Spotlight clears
   * between at-bats this way while its inning transition card plays.
   */
  clearHit(opts = {}) {
    this.lastSim = null;
    this._playing = false;
    disposeGroup(this.hitGroup);
    this.animatedBalls = [];
    this.trails = [];
    this._drawnStops = [];
    this._flightMs = 0;
    this._fxMs = 0;
    this._totalAnimMs = 0;
    const from = this.camera.position.clone();
    const look0 = this._camLookCur ? this._camLookCur.clone() : null;
    this._camLookCur = null;
    const home = new THREE.Vector3(...BROADCAST_POS);
    if (opts.animate === true && this.fixedCam
        && (look0 || from.distanceToSquared(home) > 0.04)) {
      this._camModeName = 'return';
      this._camState = {
        from, to: home,
        look0: look0 || new THREE.Vector3(...BROADCAST_LOOK),
        look1: new THREE.Vector3(...BROADCAST_LOOK),
      };
      this._camStart = performance.now();
      this._camMs = RETURN_MS;
      this._animUntil = this._camStart + RETURN_MS + ANIM_TAIL_MS;
    } else {
      this._camModeName = 'broadcast';
      this._camState = null;
      this._animUntil = 0;
      if (this.fixedCam) this.lockCamera();
    }
    this._dirty = true;
  }

  /** Restart the play-once animation (flight, trail effects, camera) from contact. */
  replay() {
    this._playStart = performance.now();
    this._playing = this._flightMs > 0;
    this._camStart = this._playStart;
    this._camLookCur = null;
    this._animUntil = this._playStart + this._totalAnimMs;
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
    this._handBoxes = null;
    this._stadiumMesh = null;

    const theme = getTheme(this.currentStadiumName);
    this.applyEnvironment(theme);

    const positions = [], colors = [];
    const edgePositions = [], edgeColors = [];
    const emissivePositions = {}; // hex color -> positions array (stream lava etc.)

    // theme.moundPanels: repaint the zig-zag grass-typed panels ringing the
    // mound (Wario Palace). The green base pads share the same collision type
    // ~19 m out, so membership is by triangle-centroid distance from the mound
    // center, not by type alone — the pads keep the palette green.
    const mp = this.viewMode === 'stream' ? theme.moundPanels : null;
    const mpColor = mp ? (() => { const c = new THREE.Color(mp.color); return [c.r, c.g, c.b]; })() : null;
    const mpR2 = mp ? (mp.radius ?? 13) ** 2 : 0;

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
        let c = streamColor(collisionType, theme);
        if (mpColor && key === 'grass') {
          const cx = (pa.X + pb.X + pc.X) / 3, cz = (pa.Z + pb.Z + pc.Z) / 3 - MOUND_Z;
          if (cx * cx + cz * cz < mpR2) c = mpColor;
        }
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
      const stadiumMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
        vertexColors: true, side: THREE.DoubleSide,
      }));
      this.stadiumGroup.add(stadiumMesh);
      this._stadiumMesh = stadiumMesh; // HR flight-truncation raycast target

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

      this._buildInfield(theme);
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

  // Bases, home plate, batter's boxes + pitcher's mound (stream view). Every
  // stadium uses the standard MLB diamond, meters, matching the game's
  // throw-target coordinates. theme.infield can override mound colors;
  // theme.moundPanels (buildStadium) recolors the stadium's own panel
  // geometry around the mound.
  _buildInfield(theme) {
    const infield = theme.infield || {};
    const white = new THREE.MeshLambertMaterial({ color: 0xf4f2ea, side: THREE.DoubleSide });
    const dirt = new THREE.MeshLambertMaterial({ color: infield.mound || 0xb98d5e });

    // mound: low dirt cone + rubber, centered on the pitching coordinate
    const mound = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 3.0, 0.42, 32), dirt);
    mound.position.set(0, 0.21, MOUND_Z);
    this.stadiumGroup.add(mound);
    const rubber = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 0.22), white);
    rubber.position.set(0, 0.46, MOUND_Z);
    this.stadiumGroup.add(rubber);

    // 1B/2B/3B at the game's throw-target coordinates; corners face the basepaths
    const BASES = [[18.95, 19.4], [0.1, 39], [-18.95, 19.4]];
    for (const [x, z] of BASES) {
      const base = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.12, 1.15), white);
      base.rotation.y = Math.PI / 4;
      base.position.set(x, 0.08, z);
      this.stadiumGroup.add(base);
    }

    // home plate: proper pentagon — flat edge toward the pitcher (+z), point
    // toward the catcher. Scaled up like the bases so it reads on broadcast.
    // Shape y maps to -z after rotation.x = -PI/2, so front edge = shape -y.
    const plateShape = new THREE.Shape();
    plateShape.moveTo(-0.575, -0.35);
    plateShape.lineTo(0.575, -0.35);   // flat front edge (faces pitcher)
    plateShape.lineTo(0.575, 0.05);
    plateShape.lineTo(0, 0.62);        // point (faces catcher)
    plateShape.lineTo(-0.575, 0.05);
    plateShape.closePath();
    const plateGeo = new THREE.ExtrudeGeometry(plateShape, { depth: 0.1, bevelEnabled: false });
    const plate = new THREE.Mesh(plateGeo, white);
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(0.05, 0.02, 0.25);
    this.stadiumGroup.add(plate);

    // batter's boxes flanking the plate. Handedness (from behind home looking
    // at the pitcher): a RIGHT-handed batter stands on the third-base side —
    // 3B is game-x -18.95, which renders screen-LEFT (world X is flipped;
    // 1B at game-x +18.95 renders on the right).
    const BOX_W = 1.35, BOX_D = 2.35, BOX_OFF = 1.5;
    const makeBox = (gx) => {
      const g = new THREE.Group();
      const hw = BOX_W / 2, hd = BOX_D / 2;
      const outlineMat = new THREE.LineBasicMaterial({
        color: 0xf4f2ea, transparent: true, opacity: 0.5,
      });
      const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-hw, 0, -hd), new THREE.Vector3(hw, 0, -hd),
        new THREE.Vector3(hw, 0, hd), new THREE.Vector3(-hw, 0, hd),
      ]), outlineMat);
      outline.position.y = 0.035;
      g.add(outline);
      const fillMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      });
      const fill = new THREE.Mesh(new THREE.PlaneGeometry(BOX_W * 0.92, BOX_D * 0.92), fillMat);
      fill.rotation.x = -Math.PI / 2;
      fill.position.y = 0.03;
      g.add(fill);
      g.position.set(0.05 + gx, 0, 0.3);
      g.userData = { fillMat, outlineMat };
      this.stadiumGroup.add(g);
      return g;
    };
    this._handBoxes = {
      Right: makeBox(-BOX_OFF), // third-base side
      Left: makeBox(BOX_OFF),   // first-base side
    };
    this._applyBatterHand();
  }

  buildHitScene() {
    disposeGroup(this.hitGroup);
    this.animatedBalls = [];
    this.trails = [];
    this._drawnStops = [];
    this._flightMs = 0;
    this._fxMs = 0;
    if (!this.lastSim) return;
    const sim = this.lastSim, opts = this.lastOpts;
    const stream = this.viewMode === 'stream';
    const theme = getTheme(this.currentStadiumName);
    // trail effects (progressive tube reveal, red fade, HR/star crawl, marker
    // gating) only run in cinematic stream mode; orbit/debug keeps thin
    // static lines
    const fx = this.cinematic && stream;
    const spray = fx && opts.spray;
    const feet = opts.unitsFeet ?? stream; // stream defaults to feet
    const whole = stream;                  // broadcast: whole feet, no decimals

    sim.paths.forEach((path, idx) => {
      const color = PATH_COLORS[idx % PATH_COLORS.length];
      const isStar = fx && path.star === true; // star outranks hr (see header)
      const isHR = fx && !isStar && path.hr === true;
      const isOut = path.out === true;
      // HRs (star-swing homers included): stop the drawn flight where it
      // first meets stadium geometry so the ball never clips through the
      // stands. The recorded final/distance stay untruncated.
      const pts = (fx && path.hr === true)
        ? this._truncateAtStadium(path.points) : path.points;
      // where the drawn ball actually stops (the wall on a truncated HR) —
      // the hero camera settles its look here, not on the phantom landing
      this._drawnStops[idx] = pts !== path.points ? pts[pts.length - 1] : null;
      const nFrames = pts.length;
      const doneAtMs = spray
        ? SPRAY_STAGGER_MS * idx + SPRAY_REVEAL_MS
        : (Math.max(nFrames - 1, 0) / 60) * 1000;

      let trail = null;
      if (fx) {
        // every flight trail is a thick tube; HR/star differ by gradient only
        trail = this._makeFxTube(pts, theme, isStar ? 'star' : isHR ? 'hr' : 'plain');
        this.hitGroup.add(trail.tube);
      } else {
        this.hitGroup.add(lineFromPoints(pts, stream ? theme.lineGlow : color));
      }
      if (trail) {
        trail.fullCount = nFrames;
        trail.out = isOut;
        trail.doneAtMs = doneAtMs;
        trail.revealDelayMs = spray ? SPRAY_STAGGER_MS * idx : 0;
        trail.revealDurMs = spray ? SPRAY_REVEAL_MS : null; // null = flight-synced
        // out: plain trails fade to red; a star swing that ends in an out
        // blends its golden shimmer to red too (HRs are never outs)
        trail.redAtMs = isOut && trail.kind !== 'hr' ? doneAtMs : null;
        // hr/star crawls: hold-then-freeze in the walkthrough, loop for as
        // long as the spray chart is displayed
        trail.crawlEndMs = (isHR || isStar)
          ? (spray ? Infinity
            : doneAtMs + (isHR ? HR_CRAWL_HOLD_MS : STAR_CRAWL_HOLD_MS))
          : null;
        trail.finishers = []; // markers/labels revealed when this path completes
        this.trails.push(trail);
      }
      const gate = (obj) => { // hide until the path's flight/reveal completes
        if (trail) { obj.visible = false; trail.finishers.push(obj); }
      };

      // Spray mode replays no flight: trails materialize, no balls.
      if (!spray) {
        // A solid ball reads better on stream than the old additive glow orb.
        const ball = new THREE.Mesh(
          new THREE.SphereGeometry(stream ? 0.45 : 0.18, 16, 16),
          stream
            ? new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x666666 })
            : new THREE.MeshBasicMaterial({ color }));
        this.hitGroup.add(ball);
        this.animatedBalls.push({ mesh: ball, points: pts });
        this._flightMs = Math.max(this._flightMs, doneAtMs);
      }

      const [fx_, fy, fz] = path.final;
      // marker/label sit where the drawn ball stops (the wall on a truncated
      // HR); the labeled distance is always the recorded carry
      const mark = pts !== path.points ? pts[pts.length - 1] : path.final;
      const scale = feet ? METERS_TO_FEET : 1;
      const dist = Math.hypot(fx_, fy, fz);
      const distText = fmt(dist, feet, whole);
      const label = makeLabel(
        // broadcast (cinematic stream): distance only; debug tool keeps coords
        this.cinematic && stream
          ? distText
          : `(${(fx_ * scale).toFixed(2)}, ${(fz * scale).toFixed(2)})\n${distText}`,
        [mark[0], mark[1] + 0.5, mark[2]], stream ? 'lbl stream' : 'lbl');
      this.hitGroup.add(label);
      gate(label);

      if (stream) {
        // ground marker at the landing: circle = safe hit, red X = out.
        // Sized to read from the locked broadcast cam even at the wall.
        if (isOut) {
          const red = new THREE.MeshBasicMaterial({ color: 0xff3b30, side: THREE.DoubleSide });
          for (const rot of [Math.PI / 4, -Math.PI / 4]) {
            const bar = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.7), red);
            bar.rotation.x = -Math.PI / 2;
            bar.rotation.z = rot;
            bar.position.set(mark[0], 0.04, mark[2]);
            this.hitGroup.add(bar);
            gate(bar);
          }
        } else {
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(1.25, 1.8, 40),
            new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }));
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(mark[0], 0.04, mark[2]);
          this.hitGroup.add(ring);
          gate(ring);
        }
      }

      if (opts.showMaxHeight) {
        const mh = path.max_height_point;
        const mhLabel = makeLabel(fmt(mh[1], feet, whole), [mh[0], mh[1] + 0.5, mh[2]], stream ? 'lbl stream' : 'lbl');
        this.hitGroup.add(mhLabel);
        gate(mhLabel);
      }

      if (opts.showCurveOnGround) {
        this.hitGroup.add(lineFromPoints(path.points, 0xff6464, 0.01));
      }
    });

    // when the last trail effect ends (red fades, HR/star crawls), relative to play start
    this._fxMs = this._flightMs;
    for (const tr of this.trails) {
      this._fxMs = Math.max(this._fxMs,
        tr.doneAtMs + (tr.redAtMs != null ? RED_FADE_MS : 0),
        tr.crawlEndMs || 0);
    }

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

  // Flight trail: WebGL clamps line width to 1px, so every trail is a tube
  // (TRAIL_RADIUS thick). kind:
  //   'plain' — solid theme.lineGlow (fades to red after an out lands)
  //   'hr'    — vertex-colored gradient that crawls along the length during
  //             the flight and for HR_CRAWL_HOLD_MS after landing, then
  //             freezes (so held frames stop rendering)
  //   'star'  — golden shimmer: faster crawl, tighter repeats, soft opacity
  //             pulse; freezes like 'hr'
  // The tube is arc-length parameterized (TubeGeometry samples getPointAt)
  // while the ball moves in time, so the trail stores the cumulative arc
  // fraction at each input sample — _updateTube maps the ball's frame through
  // it so the revealed tip stays ON the ball (see _updateEffects).
  _makeFxTube(points, theme, kind) {
    const curve = new THREE.CatmullRomCurve3(
      points.map(p => new THREE.Vector3(p[0], p[1], p[2])));
    const tubularSegments = 180, radialSegments = 8;
    const geo = new THREE.TubeGeometry(curve, tubularSegments, TRAIL_RADIUS, radialSegments, false);
    geo.setDrawRange(0, 0);

    // cumulative arc fraction of the sample polyline at each input frame
    const n = points.length;
    const arcFrac = new Float32Array(Math.max(n, 1));
    let total = 0;
    for (let i = 1; i < n; i++) {
      total += Math.hypot(points[i][0] - points[i - 1][0],
        points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]);
      arcFrac[i] = total;
    }
    if (total > 0) { for (let i = 1; i < n; i++) arcFrac[i] /= total; }
    else { for (let i = 0; i < n; i++) arcFrac[i] = n > 1 ? i / (n - 1) : 1; }

    let mat;
    const trail = { tubularSegments, radialSegments, arcFrac, kind, _lastPhase: -1 };
    if (kind === 'plain') {
      mat = new THREE.MeshBasicMaterial({
        color: theme.lineGlow, transparent: true, opacity: 0.92,
        depthWrite: false, side: THREE.DoubleSide,
      });
      trail.lineMat = mat; // red-fade target (see _updateEffects)
      trail.baseColor = new THREE.Color(theme.lineGlow);
    } else {
      const count = geo.getAttribute('position').count;
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      mat = new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.92,
        depthWrite: false, side: THREE.DoubleSide,
      });
      if (kind === 'star') {
        trail.gradient = (theme.starGradient || STAR_GRADIENT).map(c => new THREE.Color(c));
        trail.crawlPeriod = STAR_CRAWL_PERIOD_MS;
        trail.gradRepeat = STAR_GRAD_REPEAT;
        trail.pulse = true;
      } else {
        trail.gradient = (theme.hrGradient || HR_GRADIENT).map(c => new THREE.Color(c));
        trail.crawlPeriod = HR_CRAWL_PERIOD_MS;
        trail.gradRepeat = HR_GRAD_REPEAT;
      }
    }
    trail.tube = new THREE.Mesh(geo, mat);
    return trail;
  }

  // Reveal the tube up to the ball's (possibly fractional) input frame, and
  // advance the gradient crawl for hr/star kinds.
  _updateTube(trail, elapsed, frameFloat) {
    // time frame -> arc-length fraction, so the tip coincides with the ball
    const af = trail.arcFrac;
    const f0 = Math.min(Math.floor(frameFloat), af.length - 1);
    const k = frameFloat - f0;
    const arc = f0 >= af.length - 1 ? af[af.length - 1]
      : af[f0] + (af[f0 + 1] - af[f0]) * k;
    const segs = Math.round(arc * trail.tubularSegments);
    trail.tube.geometry.setDrawRange(0, segs * trail.radialSegments * 6);
    if (trail.kind === 'plain') return; // solid color; red fade handled by caller

    // crawl phase; freezes at crawlEndMs so held frames skip the write
    const t = Math.min(elapsed, trail.crawlEndMs);
    const phase = t / trail.crawlPeriod;
    if (trail.pulse) { // star: opacity breathing, frozen with the crawl
      trail.tube.material.opacity = 0.8 + 0.14 * Math.sin((t / STAR_PULSE_PERIOD_MS) * Math.PI * 2);
    }
    const mix = trail.redMix || 0; // star-out: shimmer blends toward red
    if (phase === trail._lastPhase && arc === trail._lastFrac
        && mix === trail._lastMix) return;
    trail._lastPhase = phase;
    trail._lastFrac = arc;
    trail._lastMix = mix;
    const attr = trail.tube.geometry.getAttribute('color');
    const ring = trail.radialSegments + 1;
    for (let i = 0; i <= trail.tubularSegments; i++) {
      const c = sampleGradient(trail.gradient,
        (i / trail.tubularSegments) * trail.gradRepeat - phase, this._tmpCol);
      if (mix > 0) c.lerp(OUT_RED, mix);
      for (let j = 0; j < ring; j++) attr.setXYZ(i * ring + j, c.r, c.g, c.b);
    }
    attr.needsUpdate = true;
  }

  // The one clock every flight-synced visual derives from: input frame index
  // at `elapsed` ms (60 fps samples, clamped to the last frame). The ball and
  // its trail both go through here, so they cannot diverge.
  _flightFrame(elapsed, nFrames) {
    return Math.max(0, Math.min(Math.floor(elapsed * 60 / 1000), nFrames - 1));
  }

  // Advance every trail effect to `elapsed` ms since play start. Everything is
  // a pure function of elapsed time, so replay() only has to reset the clock.
  _updateEffects(elapsed) {
    for (const tr of this.trails) {
      let frameFloat; // time-domain progress, in input samples
      if (tr.revealDurMs != null) { // spray: fast staggered draw-on
        const frac = easeOutCubic(clamp01((elapsed - tr.revealDelayMs) / tr.revealDurMs));
        frameFloat = frac * (tr.fullCount - 1);
      } else { // flight-synced: same clock + quantization as the ball
        frameFloat = this._flightFrame(elapsed, tr.fullCount);
      }
      this._updateTube(tr, elapsed, frameFloat);

      const done = elapsed >= tr.doneAtMs;
      for (const f of tr.finishers) f.visible = done;

      if (tr.redAtMs != null) { // out: completed trail transitions to red
        const k = easeInOutSine(clamp01((elapsed - tr.redAtMs) / RED_FADE_MS));
        if (tr.lineMat) tr.lineMat.color.copy(tr.baseColor).lerp(OUT_RED, k);
        else tr.redMix = k; // gradient kinds blend per-vertex in _updateTube
      }
    }
  }

  // ============================== CAMERA MODES ==============================
  //
  // Cinematic fixed-cam camera system, selected per shot via
  // setHit(sim, { camera: '<name>' }). Modes:
  //
  //   'broadcast' (default) — the locked framing from lockCamera(): high
  //       behind home plate, never moves. Use for: anything that must stay
  //       rock-still under other graphics; safe fallback for every shot.
  //   'follow'    — broadcast position with a gentle tracking pan: the view
  //       eases after the ball in flight with a ~7 m push-in, then settles on
  //       the landing. Single-path shots only (falls back to 'broadcast').
  //       Use for: normal contact when a little life is wanted.
  //   'hero'      — home-run treatment. Contact hold (~0.45 s) on the
  //       broadcast framing, then an accelerating crane/chase along a rising
  //       arc that tracks the ball, glides through the landing area, and
  //       settles on a wide shot of the landing. The crane stops advancing at
  //       the outfield wall (+ a small margin) — a moonshot far into the
  //       stands is tracked rotationally from the fence, never by clipping
  //       through stadium geometry. Single-path shots only.
  //       setHit opts.hero === true is a back-compat alias. Use for: home runs.
  //   'gentle'    — the short-hit variant of hero/follow, selected
  //       AUTOMATICALLY when either resolves on a flight landing closer than
  //       shortHitM (constructor option; default SHORT_HIT_DISTANCE_M).
  //       The same language as the big-hit cameras at a smaller size: an
  //       eased push TOWARD the landing (a scaled-down follow push) with a
  //       crane-up that keeps the framing slightly wider than broadcast, and
  //       follow-grade ball tracking. Consistent with the long-hit
  //       treatment; deeper hits still out-dramatize it. Callers should
  //       dwell longer after these land; see recommendedHoldMs(). Can be
  //       requested explicitly.
  //   'spray'     — selected automatically by setHit(sim, { spray: true }).
  //       A PRESENTATION camera designed to hold on screen indefinitely: the
  //       framing takes in the whole field (outfield extent + home plate, not
  //       just the hit cluster). Static establishing view until EVERY trail
  //       has finished drawing on (stagger + reveal + a settle beat; no
  //       frames rendered while static), then a very slow pendulum yaw
  //       (~52 s period, ~17° arc) layered with a soft radius/height breathe
  //       on an incommensurate period — large, gradual motion that loops
  //       comfortably forever. Renders continuously once the drift starts.
  //       Use for: spray charts / multi-path finales.
  //
  // Modes only apply when the renderer was constructed with fixedCam; the
  // non-fixedCam cinematic camera (_frameShot follow) is unchanged.
  // All moves are position/look interpolations — no roll, no orbit spins.

  static CAMERA_MODES = ['broadcast', 'follow', 'hero', 'gentle', 'spray'];
  /** Landing distance (m) under which hero/follow auto-swap to 'gentle'. */
  static SHORT_HIT_DISTANCE_M = 45;

  _resolveCameraMode() {
    const o = this.lastOpts, sim = this.lastSim;
    if (o.spray) return 'spray';
    let name = o.camera || (o.hero ? 'hero' : 'broadcast');
    if (!HitRenderer.CAMERA_MODES.includes(name)) name = 'broadcast';
    if ((name === 'hero' || name === 'follow' || name === 'gentle')
        && (!sim || !sim.paths || sim.paths.length !== 1)) {
      name = 'broadcast';
    }
    // short flights get the gentle treatment regardless of what was asked
    if ((name === 'hero' || name === 'follow') && this._isShortHit(sim.paths[0])) {
      name = 'gentle';
    }
    return name;
  }

  _isShortHit(path) {
    const p = path.final || path.points[path.points.length - 1];
    return Math.hypot(p[0], p[2]) < this.shortHitM;
  }

  /**
   * Post-landing dwell (ms) the caller should allow before advancing to the
   * next play. Short hits return a longer hold (the gentle camera is still
   * settling when the flight ends and the shot deserves a beat); everything
   * else returns null = use the caller's own pacing.
   */
  recommendedHoldMs() {
    return this._lastShotShort ? GENTLE_RECOMMENDED_HOLD_MS : null;
  }

  _setupCameraMode(name) {
    this._camModeName = name;
    this._camState = null;
    this._camMs = 0;
    this._lastShotShort = name === 'gentle';
    const sim = this.lastSim;
    if (sim && sim.paths && sim.paths.length) {
      if (name === 'hero') this._setupHeroCam();
      else if (name === 'follow') this._setupFollowCam();
      else if (name === 'gentle') this._setupGentleCam();
      else if (name === 'spray') this._setupSprayCam();
    }
    // gentle captures the previous shot's look target in its setup, so the
    // smoothed look state is cleared after setup (replay() clears it again)
    this._camLookCur = null;
    this._totalAnimMs = Math.max(this._fxMs, this._camMs) + ANIM_TAIL_MS;
  }

  // Where the shot visually ends, scene space: the truncated stop point when
  // the drawn flight was cut at stadium geometry (the ball's visible rest),
  // otherwise the recorded landing. Cameras settle on what the viewer SAW —
  // a hero shot must come to a natural stop at the point of impact instead
  // of panning on toward where the ball would have landed beyond the stands.
  _sceneLanding(path, idx = 0) {
    const p = this._drawnStops[idx] || path.final || path.points[path.points.length - 1];
    return this._toScene(p);
  }

  _setupHeroCam() {
    const path = this.lastSim.paths[0];
    const landing = this._sceneLanding(path);
    let apexY = 0;
    for (const p of path.points) apexY = Math.max(apexY, p[1]);

    // Crane anchor: where the drawn ball stops (impact point on a truncated
    // HR), clamped to the outfield wall (+ margin) along its azimuth — on a
    // moonshot the camera stops advancing at the fence and only keeps
    // tracking rotationally (landingLook stays true to the visible stop).
    const fin = this._drawnStops[0] || path.final || path.points[path.points.length - 1];
    const landDist = Math.hypot(fin[0], fin[2]);
    const wall = this._wallDistanceAt(Math.atan2(fin[0], fin[2])); // game coords
    const chaseDist = wall != null ? Math.min(landDist, wall + HERO_WALL_MARGIN_M) : landDist;
    const chase = landing.clone();
    if (landDist > 1e-3 && chaseDist < landDist) {
      chase.x *= chaseDist / landDist;
      chase.z *= chaseDist / landDist;
    }

    const from = new THREE.Vector3(...BROADCAST_POS);
    // end pose: pulled back from the chase anchor toward home, offset + raised,
    // far enough (aspect-aware fit) that the landing area + context stays framed
    const back = new THREE.Vector3(-chase.x, 0, -chase.z);
    if (back.lengthSq() < 1e-4) back.set(0, 0, -1);
    back.normalize();
    const side = new THREE.Vector3(back.z, 0, -back.x);
    const camDir = new THREE.Vector3()
      .addScaledVector(back, 1.0)
      .addScaledVector(side, 0.42)
      .add(new THREE.Vector3(0, 0.5, 0))
      .normalize();
    const dist = this._fitDistance(new THREE.Vector3(56, Math.max(apexY * 0.5, 18), 56));
    const end = chase.clone().addScaledVector(camDir, dist);
    end.y = Math.max(end.y, 10);
    // rising crane path: quadratic bezier lifted with the ball's apex
    const ctrl = from.clone().lerp(end, 0.5);
    ctrl.y += Math.max(8, apexY * 0.55);

    this._camState = {
      from, ctrl, end,
      look0: new THREE.Vector3(...BROADCAST_LOOK),
      landingLook: landing.clone().add(new THREE.Vector3(0, 2, 0)),
      glideMs: this._flightMs + HERO_GLIDE_EXTRA_MS,
    };
    this._camMs = this._flightMs + HERO_GLIDE_EXTRA_MS + HERO_SETTLE_MS;
  }

  _setupFollowCam() {
    const path = this.lastSim.paths[0];
    const landing = this._sceneLanding(path);
    const from = new THREE.Vector3(...BROADCAST_POS);
    const look0 = new THREE.Vector3(...BROADCAST_LOOK);
    this._camState = {
      from,
      dir: look0.clone().sub(from).normalize(),
      look0,
      landingLook: landing.clone().add(new THREE.Vector3(0, 1.5, 0)),
    };
    this._camMs = this._flightMs + FOLLOW_SETTLE_MS;
  }

  // Gentle short-hit cam: the same language as follow/hero — an eased push
  // TOWARD the play while tracking the ball — sized for a shallow ball. The
  // camera pushes toward the landing (a smaller follow push) and cranes up
  // so the framing stays slightly wider than broadcast, keeping the livelier
  // move easy to follow. Deeper hits still out-dramatize it; this just keeps
  // every batted ball inside one camera vocabulary.
  _setupGentleCam() {
    const path = this.lastSim.paths[0];
    const landing = this._sceneLanding(path);
    const from = this.camera.position.clone();
    const look0 = this._camLookCur ? this._camLookCur.clone()
      : new THREE.Vector3(...BROADCAST_LOOK);
    const base = new THREE.Vector3(...BROADCAST_POS);
    const toward = landing.clone().sub(base);
    toward.y = 0;
    if (toward.lengthSq() < 1e-4) toward.set(0, 0, 1);
    toward.normalize();
    const to = base.addScaledVector(toward, GENTLE_PUSH_M);
    to.y += GENTLE_RISE_M;
    this._camState = {
      from,
      to,
      look0,
      moveMs: Math.max(this._flightMs, GENTLE_MOVE_MS),
      landingLook: landing.clone().add(new THREE.Vector3(0, 1.5, 0)),
    };
    this._camMs = this._camState.moveMs + GENTLE_SETTLE_MS;
  }

  _setupSprayCam() {
    const pts = this.lastSim.paths.flatMap(path => path.points.map(p => this._toScene(p)));
    if (!pts.length) return;
    // PRESENTATION framing: the whole field, not the hit cluster. Fold home
    // plate and the outfield extent (from the wall profile) into the box so
    // the chart reads as a complete overview of the game — never a tight
    // zoom on wherever the balls happened to land.
    const wall = (this._wallProfile && this._wallProfile.median) || 95;
    const box = new THREE.Box3().setFromPoints(pts);
    box.expandByPoint(new THREE.Vector3(0, 0, 0));
    box.expandByPoint(new THREE.Vector3(-wall * 0.72, 0, wall * 0.75));
    box.expandByPoint(new THREE.Vector3(wall * 0.72, 0, wall * 0.75));
    box.expandByPoint(new THREE.Vector3(0, 0, wall * 1.04));
    box.expandByScalar(4);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const dirH = new THREE.Vector3(center.x, 0, center.z);
    if (dirH.lengthSq() < 1e-4) dirH.set(0, 0, 1);
    dirH.normalize();
    // establishing pose: behind home plate, lifted for an aerial read; the
    // idle drift pivots around the field center from here. Fit margin keeps
    // everything in frame through the drift's extremes (yaw + breathe).
    const d = new THREE.Vector3()
      .addScaledVector(dirH, -1.0)
      .add(new THREE.Vector3(0, SPRAY_AERIAL, 0))
      .normalize();
    const pos = center.clone().addScaledVector(d, this._fitDistance(size) * 1.08);
    // the aerial angle can park the camera nearly overhead of home plate,
    // dropping the plate below the FOV no matter the fit distance — enforce
    // a horizontal standoff behind the plate proportional to camera height
    const standoff = pos.y * 0.3;
    const behind = -(pos.x * dirH.x + pos.z * dirH.z);
    if (behind < standoff) pos.addScaledVector(dirH, -(standoff - behind));
    this._camState = {
      center, pos,
      // aim between the field center and home plate — the plate (where every
      // trail converges) must never fall off the bottom of frame, and the
      // rebalance trades empty sky at the top for it
      look: center.clone().multiplyScalar(0.8),
      // static until EVERY trail has drawn on, plus a settle beat
      orbitStartMs: SPRAY_STAGGER_MS * (this.lastSim.paths.length - 1)
        + SPRAY_REVEAL_MS + SPRAY_SETTLE_MS,
    };
    this._camMs = this._camState.orbitStartMs;
  }

  // True once the spray idle orbit has begun (frames must render from then
  // on); false during the static establishing hold (frames are skipped —
  // the reveal window itself is covered by _animUntil).
  _sprayCamActive(now) {
    if (this._camModeName !== 'spray' || !this._camState) return false;
    return now - this._camStart >= this._camState.orbitStartMs;
  }

  _updateHeroCam(st, elapsed) {
    const u = clamp01((elapsed - HERO_HOLD_MS) / Math.max(st.glideMs - HERO_HOLD_MS, 1));
    const e = easeInOutCubic(u);
    const s = 1 - e;
    this.camera.position.set(
      s * s * st.from.x + 2 * s * e * st.ctrl.x + e * e * st.end.x,
      s * s * st.from.y + 2 * s * e * st.ctrl.y + e * e * st.end.y,
      s * s * st.from.z + 2 * s * e * st.ctrl.z + e * e * st.end.z);
    if (!this._camLookCur) this._camLookCur = st.look0.clone();
    const desired = this._playing ? this._ballScene : st.landingLook;
    this._camLookCur.lerp(desired, 0.09);
    this.camera.lookAt(this._camLookCur);
  }

  _updateFollowCam(st, elapsed) {
    const p = clamp01(this._flightMs > 0 ? elapsed / this._flightMs : 1);
    this.camera.position.copy(st.from)
      .addScaledVector(st.dir, FOLLOW_PUSH_M * easeInOutSine(p));
    if (!this._camLookCur) this._camLookCur = st.look0.clone();
    const desired = this._playing ? this._ballScene : st.landingLook;
    this._camLookCur.lerp(desired, 0.07);
    this.camera.lookAt(this._camLookCur);
  }

  _updateGentleCam(st, elapsed) {
    // eased push toward the play, paced with the flight (never shorter than
    // GENTLE_MOVE_MS) — cubic ease-in-out for the smoothest acceleration
    const k = easeInOutCubic(clamp01(elapsed / st.moveMs));
    this.camera.position.lerpVectors(st.from, st.to, k);
    if (!this._camLookCur) this._camLookCur = st.look0.clone();
    const desired = this._playing ? this._ballScene : st.landingLook;
    this._camLookCur.lerp(desired, GENTLE_LOOK_LERP);
    this.camera.lookAt(this._camLookCur);
  }

  // clearHit({animate}): eased glide from wherever the last shot left the
  // camera back to the locked broadcast pose (position + look together).
  _updateReturnCam(st, now) {
    const k = easeInOutCubic(clamp01((now - this._camStart) / RETURN_MS));
    this.camera.position.lerpVectors(st.from, st.to, k);
    this._tmpLook.lerpVectors(st.look0, st.look1, k);
    this.camera.lookAt(this._tmpLook);
  }

  _updateSprayCam(st, now) {
    const t = Math.max(now - this._camStart, 0) - st.orbitStartMs;
    if (t <= 0) {
      this.camera.position.copy(st.pos); // static establishing hold
    } else {
      // the idle presentation drift: a very slow pendulum yaw around the
      // field center layered with a softer radius/height breathe on an
      // incommensurate period — large, gradual, loopable-forever motion.
      // The ramp envelope zeroes the initial velocity so the hold releases
      // invisibly.
      const env = easeInOutSine(clamp01(t / SPRAY_ORBIT_RAMP_MS));
      const yaw = env * SPRAY_ORBIT_ARC * Math.sin((t / SPRAY_ORBIT_PERIOD_MS) * Math.PI * 2);
      const breathe = 1 + env * SPRAY_BREATHE * Math.sin((t / SPRAY_BREATHE_PERIOD_MS) * Math.PI * 2);
      this._tmpLook.copy(st.pos).sub(st.center).applyAxisAngle(UP_Y, yaw).multiplyScalar(breathe);
      this.camera.position.copy(st.center).add(this._tmpLook);
    }
    this.camera.lookAt(st.look || st.center);
  }

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
  // (Legacy non-fixedCam cinematic path — the live overlay.)
  _frameShot() {
    if (!this.lastSim || !this.lastSim.paths.length) return;
    // Frame across every path so multi-path shots (spray charts) fit; with a
    // single path this is identical to the old paths[0] framing.
    const pts = this.lastSim.paths.flatMap(path => path.points.map(p => this._toScene(p)));
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

  _updateCinematicCamera(now, elapsed) {
    if (this.fixedCam) {
      const st = this._camState;
      if (!st) return; // 'broadcast': the locked pose never moves
      if (this._camModeName === 'hero') this._updateHeroCam(st, elapsed);
      else if (this._camModeName === 'follow') this._updateFollowCam(st, elapsed);
      else if (this._camModeName === 'gentle') this._updateGentleCam(st, elapsed);
      else if (this._camModeName === 'spray') this._updateSprayCam(st, now);
      else if (this._camModeName === 'return') this._updateReturnCam(st, now);
      return;
    }
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
      // Render-on-demand: while held with nothing moving, skip all GPU/label
      // work so we don't contend with the OBS encoder. Frames stay alive while
      // the flight plays, trail effects run out (_animUntil covers red fades,
      // HR/star crawls, camera glides + a small tail), the spray idle orbit
      // is running, a hazard pulses, or a discrete change set _dirty.
      const pulsing = this.pulsingMaterials.length > 0;
      const active = this._playing || pulsing || this._dirty
        || now < this._animUntil || this._sprayCamActive(now);
      if (!active) return;

      const elapsed = now - this._playStart;
      if (this._playing && elapsed >= this._flightMs) this._playing = false;

      // play-once-hold: advance to the end, then hold on the final frame
      this.animatedBalls.forEach(({ mesh, points }, i) => {
        const frame = this._flightFrame(elapsed, points.length);
        const p = points[frame];
        mesh.position.set(p[0], p[1], p[2]);
        if (i === 0) this._ballScene.set(-p[0], p[1], p[2]); // scene space
        if (this._cam) this._cam.lastBall.set(-p[0], p[1], p[2]);
      });
      this._updateEffects(elapsed);
      this._updateCinematicCamera(now, elapsed);
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
