// statfile.js — load a decoded Rio stat file, filter its contact events, and
// replay a chosen one. Talks to /api/stat/{load,events,simulate}; hands the
// resulting (simulate()-shaped) hit back to the caller via onEvent so the shared
// renderer can draw it.

const RESULT_LABELS = {
  '': 'Any result',
  hit: 'Hits (any)',
  single: 'Singles',
  double: 'Doubles',
  triple: 'Triples',
  homerun: 'Home runs',
  out: 'Outs',
  caught: 'Caught',
  five_star_dinger: 'Five-star dingers',
  star_pitch: 'Star pitches',
};

export function buildStatPanel(container, { onEvent, onStatus }) {
  let statId = null;
  let summary = null;

  const el = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    for (const k of kids) e.append(k);
    return e;
  };

  const fileInput = el('input', { type: 'file', accept: '.json,application/json' });
  const meta = el('div', { style: 'font-size:12px;opacity:.85;margin:6px 0;' });
  const filterBox = el('div', { style: 'display:none;' });
  const listBox = el('div', {
    style: 'display:none;margin-top:6px;max-height:260px;overflow-y:auto;'
          + 'border:1px solid var(--border);border-radius:6px;',
  });

  // filter widgets
  const resultSel = el('select');
  for (const v of ['', 'hit', 'single', 'double', 'triple', 'homerun', 'out', 'caught', 'five_star_dinger', 'star_pitch'])
    resultSel.append(el('option', { value: v, textContent: RESULT_LABELS[v] || v }));
  const inningSel = el('select');
  const halfSel = el('select');
  for (const [v, t] of [['', 'Top & Bottom'], ['0', 'Top only'], ['1', 'Bottom only']])
    halfSel.append(el('option', { value: v, textContent: t }));
  const batterSel = el('select');

  const countLine = el('div', { style: 'font-size:11px;opacity:.6;margin:4px 0;' });
  const showAllBtn = el('button', { type: 'button', textContent: 'Show all matching' });
  const labelled = (text, w) => el('div', { className: 'row' }, el('label', { textContent: text }), w);
  filterBox.append(
    labelled('Result', resultSel),
    labelled('Inning', inningSel),
    labelled('Half', halfSel),
    labelled('Batter', batterSel),
    countLine,
    showAllBtn,
  );

  container.append(fileInput, meta, filterBox, listBox);

  function status(msg) { if (onStatus) onStatus(msg); }

  function currentFilters() {
    const f = {};
    if (resultSel.value) f.result = resultSel.value;
    if (inningSel.value) f.inning = Number(inningSel.value);
    if (halfSel.value !== '') f.half = Number(halfSel.value);
    if (batterSel.value) f.batter = batterSel.value;
    return f;
  }

  function renderList(events) {
    listBox.textContent = '';
    listBox.style.display = events.length ? 'block' : 'none';
    if (!events.length) { countLine.textContent = 'No matching events'; return; }
    countLine.textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;
    for (const ev of events) {
      const row = el('button', {
        type: 'button',
        style: 'width:100%;text-align:left;border:none;border-bottom:1px solid var(--border);'
             + 'border-radius:0;background:transparent;padding:6px 8px;font-size:12px;cursor:pointer;',
      });
      const rbi = ev.rbi ? ` · ${ev.rbi} RBI` : '';
      row.append(
        el('div', { textContent: `${ev.batter} — ${ev.result}${rbi}`, style: 'font-weight:600;' }),
        el('div', { textContent: `Inn ${ev.inning} ${ev.half} · vs ${ev.pitcher} · ${ev.swing}`, style: 'opacity:.7;' }),
      );
      row.addEventListener('click', () => selectEvent(row, ev.event_num));
      listBox.append(row);
    }
  }

  async function refreshList() {
    if (!statId) return;
    const resp = await fetch('/api/stat/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stat_id: statId, filters: currentFilters() }),
    });
    const data = await resp.json();
    if (data.error) { status(data.error); return; }
    renderList(data.events);
  }

  async function selectEvent(row, eventNum) {
    for (const b of listBox.children) b.style.background = 'transparent';
    row.style.background = 'rgba(69,212,255,0.18)';
    const resp = await fetch('/api/stat/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stat_id: statId, event_num: eventNum }),
    });
    onEvent(await resp.json());
  }

  for (const w of [resultSel, inningSel, halfSel, batterSel])
    w.addEventListener('change', refreshList);

  showAllBtn.addEventListener('click', async () => {
    if (!statId) return;
    for (const b of listBox.children) b.style.background = 'transparent';
    status('Replaying all matching events…');
    const resp = await fetch('/api/stat/simulate_all', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stat_id: statId, filters: currentFilters() }),
    });
    const sim = await resp.json();
    status(sim.error || '');
    onEvent(sim);
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    status('Loading stat file…');
    let json;
    try { json = JSON.parse(await file.text()); }
    catch (e) { status(`Not valid JSON: ${e}`); return; }

    const resp = await fetch('/api/stat/load', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(json),
    });
    const data = await resp.json();
    if (data.error) { status(data.error); return; }

    statId = data.stat_id;
    summary = data.summary;
    status('');

    const stadiumNote = summary.stadium ? '' : ` (stadium "${summary.stadium_raw}" not available)`;
    meta.textContent = `${summary.away} ${summary.score[0]} – ${summary.score[1]} ${summary.home}`
                     + ` · ${summary.stadium_raw}${stadiumNote}`;

    // populate inning / batter option lists from the summary
    inningSel.textContent = '';
    inningSel.append(el('option', { value: '', textContent: 'All innings' }));
    for (let i = 1; i <= summary.innings; i++)
      inningSel.append(el('option', { value: String(i), textContent: `Inning ${i}` }));
    batterSel.textContent = '';
    batterSel.append(el('option', { value: '', textContent: 'All batters' }));
    for (const b of summary.batters) batterSel.append(el('option', { value: b, textContent: b }));

    filterBox.style.display = 'block';
    renderList(data.events);
  });
}
