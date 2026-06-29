// app.js — standalone debug tool driver.
//
// Thin shell over the shared HitRenderer: wires the parameter form + stadium
// picker + view-mode buttons to /api/simulate and /api/stadium. The OBS overlay
// in PRSH is a separate, equally-thin driver over the same renderer core.
import { buildControls } from './controls.js';
import { buildStatPanel } from './statfile.js';
import { HitRenderer } from './renderer.js';

const renderer = new HitRenderer({
  viewport: document.getElementById('viewport'),
  labels: document.getElementById('labels'),
  orbit: true,
  cinematic: false,
  viewMode: 'stream',
});

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

  renderer.setHit(sim, {
    unitsFeet: params.units_feet === true,
    showMaxHeight: params.show_max_height === true,
    showCurveOnGround: params.show_curve_on_ground === true,
  });
}

function onParamsChanged(params) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => simulate(params), 150);
}

async function loadStadium(name) {
  const resp = await fetch(`/api/stadium/${encodeURIComponent(name)}`);
  renderer.setStadium(name, await resp.json());
}
stadiumSelect.addEventListener('change', () => loadStadium(stadiumSelect.value));

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
  renderer.setHit(sim, {});
}

for (const btn of document.querySelectorAll('[data-mode]')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-mode]').forEach(b =>
      b.classList.toggle('on', b === btn));
    renderer.setViewMode(btn.dataset.mode);
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
