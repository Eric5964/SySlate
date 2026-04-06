export const EQ_PRESETS = [
  { id: 'flat',         name: 'Flat',         bands: [0,  0,  0,  0,  0,  0,  0,  0,  0,  0] },
  { id: 'bass_boost',   name: 'Bass Boost',   bands: [6,  5,  3,  1,  0,  0,  0,  0,  0,  0] },
  { id: 'treble_boost', name: 'Treble Boost', bands: [0,  0,  0,  0,  0,  1,  3,  5,  6,  6] },
  { id: 'vocal',        name: 'Vocal',        bands: [-2,-1,  0,  2,  4,  4,  3,  1,  0,  0] },
  { id: 'classical',    name: 'Classical',    bands: [3,  2,  0,  0,  0,  0,  0,  2,  3,  4] },
  { id: 'electronic',   name: 'Electronic',   bands: [5,  4,  1,  0, -2,  0,  1,  3,  4,  4] },
  { id: 'acoustic',     name: 'Acoustic',     bands: [3,  2,  1,  2,  3,  2,  2,  3,  3,  2] },
];

export const BAND_HZ = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export function getPresetById(id) {
  return EQ_PRESETS.find(p => p.id === id) ?? EQ_PRESETS[0];
}