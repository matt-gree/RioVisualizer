// app.js — standalone debug tool driver.
//
// Thin shell over the shared HitRenderer: wires the parameter form + stadium
// picker + view-mode buttons to /api/simulate and /api/stadium. The OBS overlay
// in PRSH is a separate, equally-thin driver over the same renderer core.
//
// The named fixed-cam broadcast modes (see CAMERA MODES in renderer.js) are
// built for the character-spotlight overlay but aren't spotlight-specific, so
// the "Camera" control section previews them here too. Previewing a mode
// means swapping the debug orbit renderer for a cinematic fixedCam one (the
// two are mutually exclusive per HitRenderer's constructor contract) — see
// setCinematicPreview().
import { buildControls } from './controls.js';
import { buildStatPanel } from './statfile.js';
import { HitRenderer } from './renderer.js';
import { hasNight } from './themes.js';

const viewportEl = document.getElementById('viewport');
const labelsEl = document.getElementById('labels');
const statusBox = document.getElementById('status');
const stadiumSelect = document.getElementById('stadium');
const detailsPre = document.getElementById('detailsPre');
const jsonPre = document.getElementById('jsonPre');

let viewModeState = 'stream';
let cinematicPreview = false;
let nightMode = false;
let currentParams = {};
let renderer = makeRenderer();

function makeRenderer() {
  return new HitRenderer({
    viewport: viewportEl,
    labels: labelsEl,
    orbit: !cinematicPreview,
    cinematic: cinematicPreview,
    fixedCam: cinematicPreview,
    viewMode: viewModeState,
    night: nightMode,
  });
}

// Swap renderers when the "Cinematic camera preview" toggle changes; a no-op
// otherwise. The new instance starts with no stadium, so the current one is
// re-fetched and re-applied before returning.
async function setCinematicPreview(on) {
  if (on === cinematicPreview) return;
  cinematicPreview = on;
  renderer.dispose();
  renderer = makeRenderer();
  if (stadiumSelect.value) await loadStadium(stadiumSelect.value);
}

let simSeq = 0;
let debounceTimer;

async function simulate(params) {
  currentParams = params;
  jsonPre.textContent = JSON.stringify(params, null, 2);
  await setCinematicPreview(params.cinematic_preview === true);

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

  // the sim response carries no per-path star flag, so the debug tool tags
  // paths itself when the form asked for a star swing (previews the golden
  // shimmer trail; see renderer.js per-path flags)
  if (params.is_star_hit === true) for (const p of sim.paths) p.star = true;

  renderer.setHit(sim, {
    unitsFeet: params.units_feet === true,
    showMaxHeight: params.show_max_height === true,
    showCurveOnGround: params.show_curve_on_ground === true,
    ...(cinematicPreview ? { camera: params.camera_mode || 'broadcast' } : {}),
  });
}

function onParamsChanged(params) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => simulate(params), 150);
}

async function loadStadium(name) {
  const resp = await fetch(`/api/stadium/${encodeURIComponent(name)}`);
  renderer.setStadium(name, await resp.json());
  syncNightButton();
}
stadiumSelect.addEventListener('change', () => loadStadium(stadiumSelect.value));

// Night: the park after dark, for parks whose theme has a night look.
const nightBtn = document.getElementById('night');
function syncNightButton() {
  const available = hasNight(stadiumSelect.value);
  nightBtn.disabled = !available;
  nightBtn.classList.toggle('on', nightMode && available);
}
nightBtn.addEventListener('click', () => {
  nightMode = !nightMode;
  syncNightButton();
  renderer.setNight(nightMode);
});

// Render a replayed stat-file event: switch to its stadium, then draw the hit.
async function showStatHit(sim) {
  if (sim.error) { statusBox.textContent = sim.error; return; }
  statusBox.textContent = (sim.errors || []).join('\n');
  if (sim.stadium && sim.stadium !== stadiumSelect.value) {
    stadiumSelect.value = sim.stadium;
    await loadStadium(sim.stadium);
  }
  const detail = sim.meta ? { event: sim.meta, ...sim.details } : sim.details;
  detailsPre.textContent = detail ? JSON.stringify(detail, null, 2) : '';
  // recorded star swings get the golden shimmer trail
  if (sim.meta && sim.meta.swing === 'Star') for (const p of (sim.paths || [])) p.star = true;
  renderer.setHit(sim, cinematicPreview ? { camera: currentParams.camera_mode || 'broadcast' } : {});
}

for (const btn of document.querySelectorAll('[data-mode]')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-mode]').forEach(b =>
      b.classList.toggle('on', b === btn));
    viewModeState = btn.dataset.mode;
    renderer.setViewMode(viewModeState);
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

  buildStatPanel(document.getElementById('statpanel'), {
    onEvent: showStatHit,
    onStatus: (msg) => { statusBox.textContent = msg; },
  });

  const form = await buildControls(document.getElementById('controls'), onParamsChanged);
  await simulate(form.buildParams());
}
init();
