// Stream-view themes. One entry per stadium file stem.
//
// Each theme recolors the stadium's collision-type triangles to evoke the real
// arena (palettes sampled from gameplay screenshots) using only colors, fog,
// and lighting — no copyrighted assets. Collision types (utils/stadium.py):
//   grass, wall, oob, foulLine, back, dirt, pitWall, pit, rough, water, chomp
//
// Palettes are tuned to how each stadium ACTUALLY uses the types
// (measured from the stadium JSONs):
//   Bowser Castle:  floor is mostly `oob`; lava pools are `pit`
//   DK Jungle:      brown dirt patches are `rough`; `dirt` unused
//   Wario Palace:   sand is `dirt`; the green base pads are `grass`
//   Yoshi Park:     surrounding hills are `oob`; fence is `wall`
//   Toy Field:      blue panel floor is `grass`/`oob`; the foul panels are
//                   `pit` (a step lower); their sides are `pitWall`
//
// emissive: collision types rendered as glowing, pulsing surfaces (lava etc.)
// foulMult: brightness multiplier for foul-territory variants of each type
// moundPanels: { color, radius } — repaint the stadium's grass-typed panel
//           triangles within `radius` m of the mound center (see Wario Palace)
// infield:  { mound } — color of the built mound cone (renderer.js _buildInfield)
// horizon:  ground color past the collision data (concourse, hills, void),
//           drawn as a huge disc at `horizonY`
// mow:      mowing-stripe contrast on grass (0–1); `mowCell` is the stripe
//           width in stadium units
// lamps:    point lights that cast shadows (towers, torches, spotlights), each
//           with a soft glow sprite of size `glow` (0 for none). Use decay 1 —
//           with the physical decay of 2 the numbers get silly.
// stars:    sprinkle stars on the sky
// exposure: tone-mapping exposure
// night:    overrides for the park after dark (the Night toggle; the
//           pre-rendered stills use it when present)
// decals:   flat colored circles drawn on the floor (positions approximate),
//           e.g. Toy Field's HIT/COIN/bonus pads. color 'rainbow' uses a
//           generated radial rainbow texture. No text — colors only.
//
// The same values live in ProjectRio-frontend (components/visualizer/
// stadiumThemes.ts), which pre-renders these scenes for the draft room.

export const THEMES = {
  'Mario Stadium': {
    label: 'Sunny Island Park',
    skyTop: '#4da3e8', skyBottom: '#cdeefb',
    fog: '#cdeefb', fogDensity: 0.0014,
    hemi: { sky: '#bdd9ff', ground: '#7fae6a', intensity: 0.95 },
    sun: { color: '#fff3d6', intensity: 1.25, position: [-60, 120, -40] },
    lineGlow: '#ffffff',
    palette: {
      grass: '#43a047', dirt: '#c98e54', wall: '#3f5fc4', oob: '#d7dde6',
      foulLine: '#f5f5f0', back: '#aeb8ca', pitWall: '#8a93a4', pit: '#c4cdd9',
      rough: '#3a8c3e', water: '#3fc9d8', chomp: '#e8c84a',
    },
    emissive: { water: '#2fb8d8' },
    foulMult: 0.82,
    horizon: '#5b7f8f',
    mow: 0.08, mowCell: 14,
    exposure: 1.0,
    // The night game: a deep sky, four light towers, the grass lit hot under them.
    night: {
      label: 'Night Game',
      skyTop: '#04071a', skyBottom: '#1a2b62',
      fog: '#0f1a3c', fogDensity: 0.00095,
      hemi: { sky: '#33478c', ground: '#132416', intensity: 0.7 },
      sun: { color: '#8ea6ff', intensity: 0.3, position: [-40, 120, -60] },
      palette: {
        grass: '#3f9a48', dirt: '#b8703f', wall: '#2f57c9', oob: '#6b7486',
        foulLine: '#ffffff', back: '#586173', pitWall: '#515a6b', pit: '#6c7586',
        rough: '#36893f', water: '#3fc9d8', chomp: '#e8c84a',
      },
      horizon: '#151c33',
      stars: true,
      exposure: 1.05,
      lamps: [
        { x: -84, y: 46, z: 118, color: '#fff1cf', intensity: 120, decay: 1, glow: 9 },
        { x: 84, y: 46, z: 118, color: '#fff1cf', intensity: 120, decay: 1, glow: 9 },
        { x: -86, y: 44, z: -26, color: '#fff1cf', intensity: 100, decay: 1, glow: 8 },
        { x: 86, y: 44, z: -26, color: '#fff1cf', intensity: 100, decay: 1, glow: 8 },
      ],
    },
  },

  'Bowser Castle': {
    label: 'Molten Keep',
    skyTop: '#171015', skyBottom: '#3a1f16',
    fog: '#2c1812', fogDensity: 0.002,
    hemi: { sky: '#8c88a8', ground: '#2a1a20', intensity: 1.3 },
    sun: { color: '#cfc4ff', intensity: 1.1, position: [60, 90, -90] },
    lineGlow: '#ffd9a0',
    palette: {
      grass: '#7c7690', dirt: '#8d8598', wall: '#8a7d68', oob: '#6e6680',
      foulLine: '#e8d6a8', back: '#5a4e58', pitWall: '#4a4050', pit: '#ff5a00',
      rough: '#4a4456', water: '#ff6a10', chomp: '#ffd03f',
    },
    emissive: { pit: '#ff4800', water: '#ff5a00', chomp: '#ffb300' },
    foulMult: 0.74,
    horizon: '#1a1114', horizonY: -30,
    exposure: 1.25,
    lamps: [
      // torches on the battlements
      { x: -44, y: 24, z: 112, color: '#ff9a3a', intensity: 40, decay: 1, glow: 6 },
      { x: 44, y: 24, z: 112, color: '#ff9a3a', intensity: 40, decay: 1, glow: 6 },
      { x: 0, y: 30, z: 122, color: '#ff8a2a', intensity: 30, decay: 1, glow: 5 },
      { x: -70, y: 20, z: 40, color: '#ff7a1a', intensity: 26, decay: 1, glow: 5 },
      { x: 70, y: 20, z: 40, color: '#ff7a1a', intensity: 26, decay: 1, glow: 5 },
      // the lava pools light the stone around them
      { x: -48, y: 6, z: 46, color: '#ff6a10', intensity: 34, decay: 1, glow: 0 },
      { x: 48, y: 6, z: 46, color: '#ff6a10', intensity: 34, decay: 1, glow: 0 },
      { x: -30, y: 4, z: -14, color: '#ff6a10', intensity: 22, decay: 1, glow: 0 },
      { x: 30, y: 4, z: -14, color: '#ff6a10', intensity: 22, decay: 1, glow: 0 },
    ],
  },

  'DK Jungle': {
    label: 'Volcano Jungle',
    skyTop: '#9fb4bc', skyBottom: '#dde8e6',
    fog: '#cfdcd8', fogDensity: 0.0011,
    hemi: { sky: '#cfe0da', ground: '#42603a', intensity: 1.0 },
    sun: { color: '#eef4e2', intensity: 1.3, position: [-70, 90, -40] },
    lineGlow: '#fff8e0',
    palette: {
      grass: '#4a9c3e', dirt: '#6b4a2e', wall: '#7a5b3a', oob: '#4f8a40',
      foulLine: '#e8e3cf', back: '#5e7264', pitWall: '#4f4438', pit: '#56402a',
      rough: '#6b4a2e', water: '#7fc9dd', chomp: '#e0b84a',
    },
    emissive: { water: '#6fc0d8' },
    foulMult: 0.78,
    horizon: '#3a6236', horizonY: -36,
    mow: 0.03, mowCell: 18,
    exposure: 0.95,
  },

  'Peach Garden': {
    label: 'Royal Garden',
    skyTop: '#7fa9e0', skyBottom: '#f4cfd9',
    fog: '#e9d4dc', fogDensity: 0.0015,
    hemi: { sky: '#dcd4ec', ground: '#7c9c66', intensity: 1.0 },
    sun: { color: '#ffe2ce', intensity: 1.1, position: [-90, 80, -30] },
    lineGlow: '#fff4ec',
    palette: {
      grass: '#4fae44', dirt: '#bd6a42', wall: '#9aa6c4', oob: '#c2bdb4',
      foulLine: '#f6efe2', back: '#b4a8c4', pitWall: '#8e8aa8', pit: '#7d96c9',
      rough: '#2f7a38', water: '#6fb8e8', chomp: '#e8cf6a',
    },
    emissive: { water: '#5fb0e0' },
    foulMult: 0.84,
    horizon: '#8e8a90', horizonY: -48,
    mow: 0.05, mowCell: 12,
    exposure: 1.0,
  },

  'Wario Palace': {
    label: 'Desert Arena',
    skyTop: '#d9a45e', skyBottom: '#f3ddab',
    fog: '#ecd9a8', fogDensity: 0.0018,
    hemi: { sky: '#f0dcb0', ground: '#a08252', intensity: 0.65 },
    // low from the left, so the walls throw long shadows across the sand
    sun: { color: '#ffd9a0', intensity: 1.5, position: [-120, 45, 10] },
    lineGlow: '#fff0c8',
    palette: {
      grass: '#5fae4a', dirt: '#e6cd8c', wall: '#c9b48e', oob: '#b9a077',
      foulLine: '#f6ead0', back: '#9c8a6c', pitWall: '#8a785c', pit: '#d4b56c',
      rough: '#cfb070', water: '#5fc0c9', chomp: '#e8c34a',
    },
    emissive: {},
    foulMult: 0.8,
    horizon: '#b39468', horizonY: -66,
    exposure: 1.0,
    // Wario Palace's mound area: muted purple, breaking from the sandy
    // infield dirt everywhere else uses. infield.mound recolors the built
    // dirt cone/rubber (_buildInfield); moundPanels repaints the stadium's
    // OWN zig-zag panel geometry ringing the mound — grass-typed collision
    // triangles within `radius` m of the mound center (stadium.js). The
    // green base pads share that collision type ~19 m out and keep the
    // palette color (the mound panel cluster ends ~11 m out, the pads start
    // ~16 m out, so radius 13 splits them cleanly).
    infield: { mound: 0x6f5478 },
    moundPanels: { color: '#7c5a86', radius: 13 },
  },

  'Yoshi Park': {
    label: 'Picture-Book Meadow',
    skyTop: '#3f8fe0', skyBottom: '#bfe8f8',
    fog: '#cfeaf4', fogDensity: 0.0011,
    hemi: { sky: '#d8ecff', ground: '#5fa848', intensity: 1.05 },
    sun: { color: '#fff8e0', intensity: 1.2, position: [-50, 110, -50] },
    lineGlow: '#ffffff',
    palette: {
      grass: '#5cc24f', dirt: '#d8b878', wall: '#d9cdb0', oob: '#62b84a',
      foulLine: '#ffffff', back: '#c9aa6e', pitWall: '#8a9c8a', pit: '#b4c4b4',
      rough: '#4aa040', water: '#3fa9e8', chomp: '#e8c84a',
    },
    emissive: { water: '#3fa0e0' },
    foulMult: 0.86,
    horizon: '#5cb44a', horizonY: -42,
    mow: 0.05, mowCell: 16,
    exposure: 1.0,
  },

  'Toy Field': {
    label: 'Midnight Toy Box',
    skyTop: '#040407', skyBottom: '#0b1026',
    fog: '#070910', fogDensity: 0.00075,
    hemi: { sky: '#3a4a7a', ground: '#0a0c18', intensity: 0.85 },
    sun: { color: '#cfe0ff', intensity: 1.3, position: [0, 130, -40] },
    lineGlow: '#ffffff',
    palette: {
      grass: '#2a4fae', dirt: '#33549f', wall: '#2f55b8', oob: '#22408c',
      foulLine: '#e8e8f0', back: '#28448f',
      // the foul-territory panels sit a step lower than the floor
      pit: '#213f96', pitWall: '#2f55b8',
      rough: '#2a4fae', water: '#3fa9e8', chomp: '#e8c84a',
    },
    emissive: {},
    foulMult: 0.92,
    horizon: '#020208', horizonY: -16,
    exposure: 1.1,
    lamps: [
      { x: -70, y: 70, z: 128, color: '#e6efff', intensity: 40, decay: 1, glow: 10 },
      { x: 70, y: 70, z: 128, color: '#e6efff', intensity: 40, decay: 1, glow: 10 },
      { x: -84, y: 62, z: 30, color: '#e6efff', intensity: 32, decay: 1, glow: 9 },
      { x: 84, y: 62, z: 30, color: '#e6efff', intensity: 32, decay: 1, glow: 9 },
    ],
    // HIT / COIN / bonus pads — colors only, positions approximate
    decals: [
      { x: -25, z: 50, r: 7, color: '#d42b2b' },   // HIT
      { x: 25, z: 50, r: 7, color: '#d42b2b' },    // HIT
      { x: 0, z: 62, r: 7, color: '#d42b2b' },     // HIT
      { x: -45, z: 60, r: 8, color: 'rainbow' },   // ? pad
      { x: 45, z: 60, r: 8, color: 'rainbow' },    // ? pad
      { x: -20, z: 78, r: 7, color: '#2fa83c' },   // COIN
      { x: 20, z: 78, r: 7, color: '#2fa83c' },    // COIN
      { x: 0, z: 82, r: 7, color: '#d4742b' },     // 2B HIT
    ],
  },
};

export const COLLISION_TYPE_KEYS = {
  0x01: 'grass', 0x02: 'wall', 0x03: 'oob', 0x04: 'foulLine', 0x05: 'back',
  0x06: 'dirt', 0x07: 'pitWall', 0x08: 'pit', 0x09: 'rough', 0x0A: 'water',
  0x0B: 'chomp',
};

const FALLBACK = THEMES['Mario Stadium'];

export function getTheme(stadiumName, night = false) {
  const theme = THEMES[stadiumName] || FALLBACK;
  return night && theme.night ? { ...theme, ...theme.night } : theme;
}

export function hasNight(stadiumName) {
  return !!(THEMES[stadiumName] || FALLBACK).night;
}

/** The theme the pre-rendered stills use: the park after dark when it has a night look. */
export function getRenderTheme(stadiumName) {
  return getTheme(stadiumName, true);
}
