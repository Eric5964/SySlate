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

// overrides is { [builtInPresetId]: bands[] } — see storage.js's
// getEQOverrides. Checked before customPresets so a built-in's override
// always wins for its own id (a custom preset can never collide with a
// built-in id anyway, since new custom ids are always 'custom_<timestamp>').
export function getPresetById(id, customPresets = [], overrides = {}) {
    const builtIn = BUILT_IN_PRESETS.find(p => p.id === id);
    if (builtIn) {
        const override = overrides?.[id];
        return override ? { ...builtIn, bands: override } : builtIn;
    }
    return customPresets.find(p => p.id === id) ?? BUILT_IN_PRESETS[0];
}

// Single combined list for the Settings EQ grid — every built-in (with its
// override applied on top if it has one) followed by every custom preset,
// each tagged with isBuiltIn/isOverridden so the UI can decide what
// editing/deleting/resetting means for that particular row.
export function mergePresetsForDisplay(customPresets = [], overrides = {}) {
    const builtIns = BUILT_IN_PRESETS.map(p => {
        const override = overrides?.[p.id];
        return override
            ? { ...p, bands: override, isBuiltIn: true, isOverridden: true }
            : { ...p, isBuiltIn: true, isOverridden: false };
    });
    const customs = customPresets.map(p => ({ ...p, isBuiltIn: false, isOverridden: false }));
    return [...builtIns, ...customs];
}

// Keep EQ_PRESETS as alias for components that import it
export const EQ_PRESETS = BUILT_IN_PRESETS;