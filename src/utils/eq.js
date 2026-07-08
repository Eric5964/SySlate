export const BUILT_IN_PRESETS = [
    { id: 'flat', name: 'Flat', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { id: 'bass_boost', name: 'Bass Boost', bands: [6, 5, 3, 1, 0, 0, 0, 0, 0, 0] },
    { id: 'treble_boost', name: 'Treble Boost', bands: [0, 0, 0, 0, 0, 1, 3, 5, 6, 6] },
    { id: 'vocal', name: 'Vocal', bands: [-2, -1, 0, 2, 4, 4, 3, 1, 0, 0] },
    { id: 'classical', name: 'Classical', bands: [3, 2, 0, 0, 0, 0, 0, 2, 3, 4] },
    { id: 'electronic', name: 'Electronic', bands: [5, 4, 1, 0, -2, 0, 1, 3, 4, 4] },
    { id: 'acoustic', name: 'Acoustic', bands: [3, 2, 1, 2, 3, 2, 2, 3, 3, 2] },
    { id: 'loudness', name: 'Loudness', bands: [6, 4, 0, 0, -1, 0, 0, 2, 4, 5] },
];

export const BAND_HZ = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
export const BAND_COUNT = 10;

export function getPresetById(id, customPresets = []) {
    return [...BUILT_IN_PRESETS, ...customPresets].find(p => p.id === id) ?? BUILT_IN_PRESETS[0];
}

// Keep EQ_PRESETS as alias for components that import it
export const EQ_PRESETS = BUILT_IN_PRESETS;