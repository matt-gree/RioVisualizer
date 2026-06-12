// Schema-driven parameter form. Builds the hit-parameter JSON that
// POST /api/simulate expects (same schema as instructions.txt).
//
// Widget types:
//   select(options)        — dropdown; options may be 'characters' (fetched)
//   radio(options)         — segmented buttons
//   slider(min,max,step)   — range input with live value readout
//   check                  — checkbox
//   number(min,max)        — numeric input; blank = key omitted from JSON
//   checkset(options)      — multiple checkboxes -> list of values

const SECTIONS = [
  {
    title: 'Matchup', open: true,
    fields: [
      { key: 'batter_id', label: 'Batter', type: 'select', options: 'characters', def: 0 },
      { key: 'handedness', label: 'Bats', type: 'radio', def: 0,
        options: [[0, 'Righty'], [1, 'Lefty']] },
      { key: 'is_batter_captain', label: 'Batter is captain', type: 'check', def: false },
      { key: 'pitcher_id', label: 'Pitcher', type: 'select', options: 'characters', def: 0 },
      { key: 'chem', label: 'Chem links on base', type: 'slider', min: 0, max: 3, step: 1, def: 0 },
      { key: 'num_stars', label: 'Team stars (moonshot calc)', type: 'slider', min: 0, max: 5, step: 1, def: 4 },
      { key: 'easy_batting', label: 'Easy batting', type: 'check', def: false },
    ],
  },
  {
    title: 'Swing', open: true,
    fields: [
      { key: 'hit_type', label: 'Swing type', type: 'radio', def: 0,
        options: [[0, 'Slap'], [1, 'Charge']] },
      { key: 'charge_up', label: 'Charge up', type: 'slider', min: 0, max: 1, step: 0.01, def: 0 },
      { key: 'charge_down', label: 'Overcharge', type: 'slider', min: 0, max: 1, step: 0.01, def: 0 },
      { key: 'is_star_hit', label: 'Star swing', type: 'check', def: false },
      { key: 'is_starred', label: 'Batter starred', type: 'check', def: false },
      { key: 'frame', label: 'Contact frame', type: 'slider', min: 2, max: 14, step: 1, def: 2 },
      { key: '_stick', label: 'Stick input', type: 'stick' },
    ],
  },
  {
    title: 'Pitch & contact position', open: true,
    fields: [
      { key: 'pitch_type', label: 'Pitch type', type: 'radio', def: 0,
        options: [[0, 'Curve'], [1, 'Charge'], [2, 'Perfect'], [3, 'ChangeUp']] },
      { key: 'batter_x', label: 'Batter X', type: 'slider', min: -2, max: 2, step: 0.01, def: 0 },
      { key: 'ball_x', label: 'Ball X', type: 'slider', min: -2, max: 2, step: 0.01, def: 0 },
      { key: 'ball_z', label: 'Ball Z', type: 'slider', min: -2, max: 2, step: 0.01, def: 0 },
    ],
  },
  {
    title: 'RNG & overrides', open: false,
    fields: [
      { key: 'rand_1', label: 'RNG 1 (blank = fixed default)', type: 'number', min: 0, max: 32767 },
      { key: 'rand_2', label: 'RNG 2', type: 'number', min: 0, max: 32767 },
      { key: 'rand_3', label: 'RNG 3', type: 'number', min: 0, max: 32767 },
      { key: 'override_vertical_range', label: 'Vertical range (0-4)', type: 'number', min: 0, max: 4 },
      { key: 'override_vertical_angle', label: 'Vertical angle (0-1024)', type: 'number', min: 0, max: 1024 },
      { key: 'override_horizontal_angle', label: 'Horizontal angle (0-2048)', type: 'number', min: 0, max: 2048 },
      { key: 'override_power', label: 'Power (0-150)', type: 'number', min: 0, max: 150 },
      { key: 'generate_random_hits', label: 'Generate N random hits', type: 'number', min: 0, max: 10000 },
      { key: 'show_one_hit', label: 'Show one hit only', type: 'check', def: false },
    ],
  },
  {
    title: 'Fielder ranges', open: false,
    fields: [
      { key: 'choose_fielder', label: 'Show positions', type: 'checkset',
        options: [[0, 'P'], [1, 'C'], [2, '1B'], [3, '2B'], [4, '3B'], [5, 'SS'], [6, 'LF'], [7, 'CF'], [8, 'RF']] },
      { key: 'fielder_id', label: 'Fielder character', type: 'select', options: 'characters', def: 0 },
      { key: 'dive_type', label: 'Dive type', type: 'radio', def: 'popfly',
        options: [['popfly', 'Pop fly'], ['linedrive', 'Line drive (IF)']] },
      { key: 'hangtime', label: 'Hangtime (frames)', type: 'slider', min: 0, max: 360, step: 1, def: 100 },
    ],
  },
  {
    title: 'Display', open: false,
    fields: [
      { key: 'units_feet', label: 'Units in feet', type: 'check', def: false },
      { key: 'show_max_height', label: 'Show max height', type: 'check', def: false },
      { key: 'show_curve_on_ground', label: 'Show curve on ground', type: 'check', def: false },
    ],
  },
];

const STICK_KEYS = [['stick_up', '↑'], ['stick_left', '←'], ['stick_right', '→'], ['stick_down', '↓']];

export async function buildControls(container, onChange) {
  const characters = (await (await fetch('/api/characters')).json()).characters;
  const state = {};   // form state; buildParams() derives the JSON from this
  const fieldDefs = [];

  const notify = () => onChange(buildParams());

  function buildParams() {
    const params = {};
    for (const f of fieldDefs) {
      if (f.type === 'stick') {
        for (const [k] of STICK_KEYS) if (state[k]) params[k] = true;
      } else if (f.type === 'checkset') {
        if (state[f.key].length > 0) params[f.key] = [...state[f.key]];
      } else if (f.type === 'number') {
        if (state[f.key] !== null) params[f.key] = state[f.key];
      } else if (state[f.key] !== f.def) {
        params[f.key] = state[f.key]; // only emit non-defaults; keeps JSON readable
      }
    }
    // fielder options only matter when positions are shown
    if (!params.choose_fielder) {
      delete params.fielder_id;
      delete params.dive_type;
      delete params.hangtime;
    }
    return params;
  }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  for (const section of SECTIONS) {
    const details = el('details', 'section');
    details.open = section.open;
    details.appendChild(el('summary', null, section.title));

    for (const f of section.fields) {
      fieldDefs.push(f);
      const row = el('div', 'row');

      if (f.type === 'check') {
        state[f.key] = f.def;
        const label = el('label', 'inline');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = f.def;
        cb.addEventListener('change', () => { state[f.key] = cb.checked; notify(); });
        label.append(cb, ' ' + f.label);
        row.appendChild(label);

      } else if (f.type === 'stick') {
        row.appendChild(el('label', null, f.label));
        const group = el('div', 'btnrow');
        for (const [k, glyph] of STICK_KEYS) {
          state[k] = false;
          const b = el('button', 'seg', glyph);
          b.type = 'button';
          b.addEventListener('click', () => {
            state[k] = !state[k];
            b.classList.toggle('on', state[k]);
            notify();
          });
          group.appendChild(b);
        }
        row.appendChild(group);

      } else if (f.type === 'radio') {
        state[f.key] = f.def;
        row.appendChild(el('label', null, f.label));
        const group = el('div', 'btnrow');
        const buttons = [];
        for (const [value, name] of f.options) {
          const b = el('button', 'seg', name);
          b.type = 'button';
          if (value === f.def) b.classList.add('on');
          b.addEventListener('click', () => {
            state[f.key] = value;
            buttons.forEach(x => x.classList.remove('on'));
            b.classList.add('on');
            notify();
          });
          buttons.push(b);
          group.appendChild(b);
        }
        row.appendChild(group);

      } else if (f.type === 'select') {
        state[f.key] = f.def;
        row.appendChild(el('label', null, f.label));
        const sel = el('select');
        const opts = f.options === 'characters'
          ? characters.map(c => [c.id, c.name])
          : f.options;
        for (const [value, name] of opts) {
          const o = el('option', null, name);
          o.value = JSON.stringify(value);
          sel.appendChild(o);
        }
        sel.value = JSON.stringify(f.def);
        sel.addEventListener('change', () => { state[f.key] = JSON.parse(sel.value); notify(); });
        row.appendChild(sel);

      } else if (f.type === 'slider') {
        state[f.key] = f.def;
        const label = el('label', null, f.label + ' ');
        const readout = el('span', 'val', String(f.def));
        label.appendChild(readout);
        row.appendChild(label);
        const input = el('input');
        input.type = 'range';
        input.min = f.min; input.max = f.max; input.step = f.step;
        input.value = f.def;
        input.addEventListener('input', () => {
          state[f.key] = f.step >= 1 ? parseInt(input.value) : parseFloat(input.value);
          readout.textContent = input.value;
          notify();
        });
        row.appendChild(input);

      } else if (f.type === 'number') {
        state[f.key] = null;
        row.appendChild(el('label', null, f.label));
        const input = el('input');
        input.type = 'number';
        input.min = f.min; input.max = f.max;
        input.placeholder = '—';
        input.addEventListener('input', () => {
          const v = input.value.trim();
          state[f.key] = v === '' || isNaN(+v) ? null : Math.max(f.min, Math.min(f.max, Math.trunc(+v)));
          notify();
        });
        row.appendChild(input);

      } else if (f.type === 'checkset') {
        state[f.key] = [];
        row.appendChild(el('label', null, f.label));
        const group = el('div', 'btnrow');
        for (const [value, name] of f.options) {
          const b = el('button', 'seg', name);
          b.type = 'button';
          b.addEventListener('click', () => {
            const list = state[f.key];
            const i = list.indexOf(value);
            if (i >= 0) list.splice(i, 1); else { list.push(value); list.sort((a, b2) => a - b2); }
            b.classList.toggle('on', i < 0);
            notify();
          });
          group.appendChild(b);
        }
        row.appendChild(group);
      }

      details.appendChild(row);
    }
    container.appendChild(details);
  }

  return { buildParams };
}
