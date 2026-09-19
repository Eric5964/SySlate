// Names/curves researched against common audiophile/IEM-community usage
// (sub-bass "rumble", kick/bass-body "punch", vocal/instrument "presence"
// around 1.5-6.6kHz, treble "sparkle"/"air", the "V-shape"/"smile curve"
// bass+treble boost with a mid scoop, and a "W-shape" — a V-shape with an
// added presence bump in the middle for vocal clarity on top of it) rather
// than made-up marketing names. Bands: 32/64/125/250/500/1k/2k/4k/8k/16k.
// Real feedback found here: these were tuned for a ±12dB range, and even
// within that came across "too intense" — cut down to fit the new ±6dB
// range (see the EQ band sliders in SettingsScreen.js) with a bit of extra
// headroom trimmed on top, roughly 70% of each old value, same shape/curve
// per preset, just gentler across the board.
export const BUILT_IN_PRESETS = [
    { id: 'flat', name: 'Flat', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { id: 'rumble', name: 'Rumble', bands: [5, 3.5, 0.5, 0, 0, 0, 0, 0, 0, 0] },
    { id: 'punch', name: 'Punch', bands: [2, 3.5, 3.5, 2, 0.5, 0, 0, 0, 0, 0] },
    { id: 'warm', name: 'Warm', bands: [1.5, 2, 2, 1.5, 0.5, 0, 0, -0.5, -0.5, 0] },
    { id: 'presence', name: 'Presence', bands: [-1.5, -0.5, 0, 1.5, 3, 3, 2, 0.5, 0, 0] },
    { id: 'sparkle', name: 'Sparkle', bands: [0, 0, 0, 0, 0, 0.5, 2, 3.5, 4, 4] },
    { id: 'v_shape', name: 'V-Shape', bands: [3.5, 3, 1.5, 0, -1.5, -1.5, 0, 1.5, 3, 3.5] },
    { id: 'w_shape', name: 'W-Shape', bands: [3.5, 3, 0.5, -0.5, -1.5, 2, -0.5, 0.5, 3, 3.5] },
    { id: 'classical', name: 'Classical', bands: [2, 1.5, 0, 0, 0, 0, 0, 1.5, 2, 3] },
    { id: 'electronic', name: 'Electronic', bands: [3.5, 3, 0.5, 0, -1.5, 0, 0.5, 2, 3, 3] },
    { id: 'acoustic', name: 'Acoustic', bands: [2, 1.5, 0.5, 1.5, 2, 1.5, 1.5, 2, 2, 1.5] },
    { id: 'loudness', name: 'Loudness', bands: [4, 3, 0, 0, -0.5, 0, 0, 1.5, 3, 3.5] },
];

// ±6dB — matches the band sliders in SettingsScreen.js. Applied here too
// (not just at the slider input) so a custom preset or override saved
// before the range shrank from ±12 can't hand the native EQ unit a gain
// outside what it's now meant to support.
export const EQ_MIN = -6;
export const EQ_MAX = 6;
export const clampEQBand = (v) => Math.max(EQ_MIN, Math.min(EQ_MAX, v));

export const BAND_HZ = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
export const BAND_COUNT = 10;

// Old ids, kept resolvable after the built-in rename below (Bass Boost →
// Rumble, Treble Boost → Sparkle, Vocal → Presence) — otherwise anyone
// with one of these already selected (per-playlist eqPresetId, or an
// override keyed by the old id) would silently fall back to Flat the
// moment this shipped, since the old id just wouldn't exist anymore.
const LEGACY_PRESET_IDS = { bass_boost: 'rumble', treble_boost: 'sparkle', vocal: 'presence' };

// overrides is { [builtInPresetId]: bands[] } — see storage.js's
// getEQOverrides. Checked before customPresets so a built-in's override
// always wins for its own id (a custom preset can never collide with a
// built-in id anyway, since new custom ids are always 'custom_<timestamp>').
export function getPresetById(id, customPresets = [], overrides = {}) {
    const resolvedId = LEGACY_PRESET_IDS[id] || id;
    const builtIn = BUILT_IN_PRESETS.find(p => p.id === resolvedId);
    if (builtIn) {
        const override = overrides?.[resolvedId];
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