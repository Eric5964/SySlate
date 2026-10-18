import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// 10 accents. Pink replaces the old White (which read as broken/invisible in
// several places against the app's dark chrome and iOS's own white UI
// elements). Ordered cool-to-warm: pink+purple+blue+teal+green on top,
// yellow+orange+red+rose+mono (warm + neutral) on the bottom.
export const THEMES = {
    pink: { name: 'Pink', accent: '#ec4899', accentDim: '#3d1a30', onAccent: '#fff' },
    purple: { name: 'Purple', accent: '#7c3aed', accentDim: '#2a1f3d', onAccent: '#fff' },
    blue: { name: 'Blue', accent: '#2563eb', accentDim: '#1e2a4d', onAccent: '#fff' },
    teal: { name: 'Teal', accent: '#0891b2', accentDim: '#0a2a33', onAccent: '#fff' },
    green: { name: 'Green', accent: '#16a34a', accentDim: '#1a3d2a', onAccent: '#fff' },
    yellow: { name: 'Yellow', accent: '#eab308', accentDim: '#332c08', onAccent: '#000' },
    orange: { name: 'Orange', accent: '#ea580c', accentDim: '#3d2a1a', onAccent: '#fff' },
    red: { name: 'Red', accent: '#dc2626', accentDim: '#3d1a1a', onAccent: '#fff' },
    // Was "Rose" (#db2777, a pink-leaning red) — the "second pink" sitting
    // next to Orange and Mono. Recolored to a distinct, more orange-shifted
    // red so it reads clearly apart from the existing Red above it.
    rose: { name: 'Crimson', accent: '#b91c1c', accentDim: '#3d1616', onAccent: '#fff' },
    mono: { name: 'Mono', accent: '#9ca3af', accentDim: '#26282c', onAccent: '#000' },
};

// Ten base palettes, one per accent color (plus a neutral black standing in
// for Mono's slot). Reordered to match the accent grid position-for-position
// — pink/purple/blue/teal/green on row 1, yellow/orange/red/rose/black on
// row 2 — same as THEMES below. It used to lead with "black", which bumped
// every other color one slot off from where its matching accent sits, so
// the two grids didn't line up column-to-column like they were meant to.
// Also pushed the warm end (yellow/orange/red/rose) further apart from each
// other — at the old low-saturation values they all read as near-identical
// dark brown/maroon smudges, the same complaint the purples got fixed for
// previously (kept the purple/blue/teal/green values as-is, those already
// read distinctly).
export const BASE_COLORS = {
    // text/textDim/textFaint are new: every screen used to hardcode its own
    // literal grays (#f0f0f0, #999, #666, #555...) directly rather than
    // reading them from here, which is exactly why a light mode couldn't
    // just swap `bg` before — none of that hardcoded text would have
    // followed it. Values below match what was already ambient across the
    // app for dark, so existing dark themes look pixel-identical; only
    // `light` at the bottom is new, with its OWN distinct grays rather than
    // reusing the dark set. Reusing the same mid-grays for light was the
    // actual old bug, not the light/dark concept itself — a value like
    // #999 sits in a contrast no-man's-land, mediocre against black AND
    // against white, so it read as "illegible no matter the base/accent."
    // Light's textDim/textFaint are deliberately darker than you might
    // expect a "dim" gray to be, specifically to keep real contrast against
    // a white surface.
    dark_pink: { name: 'Pink', bg: '#22101a', surface: '#301522', border: '#47213a', text: '#f0f0f0', textDim: '#999', textFaint: '#666' },
    dark_purple: { name: 'Purple', bg: '#120e22', surface: '#191430', border: '#241d47', text: '#f0f0f0', textDim: '#999', textFaint: '#666' },
    dark_blue: { name: 'Blue', bg: '#0e1626', surface: '#141f33', border: '#1f2d4a', text: '#f0f0f0', textDim: '#999', textFaint: '#666' },
    dark_teal: { name: 'Teal', bg: '#0a1f22', surface: '#0f2a2e', border: '#163a3f', text: '#f0f0f0', textDim: '#999', textFaint: '#666' },
    dark_green: { name: 'Green', bg: '#0e2016', surface: '#14301f', border: '#1f4530', text: '#f0f0f0', textDim: '#999', textFaint: '#666' },
    dark_yellow: { name: 'Yellow', bg: '#241f04', surface: '#332b08', border: '#4a3d10', text: '#f0f0f0', textDim: '#999', textFaint: '#666' },
    dark_orange: { name: 'Orange', bg: '#291404', surface: '#3a1d09', border: '#522a10', text: '#f0f0f0', textDim: '#999', textFaint: '#666' },
    dark_red: { name: 'Red', bg: '#270707', surface: '#390d0d', border: '#521212', text: '#f0f0f0', textDim: '#999', textFaint: '#666' },
    // Crimson sits between Red and Pink in hue (a bit of magenta mixed into
    // the red, short of Pink's actual magenta) rather than landing on
    // almost the same value as either — that's what made Red/Crimson hard
    // to tell apart before, and briefly during a first pass at this fix.
    dark_rose: { name: 'Crimson', bg: '#2a0f14', surface: '#3a151c', border: '#522029', text: '#f0f0f0', textDim: '#999', textFaint: '#666' },
    black: { name: 'Black', bg: '#000000', surface: '#0a0a0a', border: '#161616', text: '#f0f0f0', textDim: '#999', textFaint: '#666' },
    // Requested: light mode should have a base color PER dark base — "just
    // replace the dark mode colors when light mode is on, match the colors
    // but have them light/pastel" — not one single generic light theme
    // regardless of which dark base was active. Each light_X below is the
    // corresponding dark_X's hue carried through: same hue angle, pushed to
    // a very high lightness with modest saturation (a proper pastel, not
    // just "the dark color but inverted") — border is where the tint reads
    // most clearly, bg/surface stay closer to white so text contrast holds.
    // text/textDim/textFaint reuse the same values across all ten — those
    // were already tuned for contrast against a light/white surface
    // specifically, and that doesn't change with which pastel hue sits
    // under it.
    // Was basically-white (#f8f4f6-ish across the board) — visibly
    // distinct from each other in code, but at actual swatch size on
    // screen they all read as the same near-white square with barely-
    // visible borders, functionally indistinguishable — "basically white"
    // / felt like nothing was actually selectable. Pushed lightness down
    // and saturation up substantially (was L~97%/low-S pastel, now more a
    // proper visible pastel) while keeping `text` (#161616, unchanged)
    // comfortably high-contrast against all of them.
    light_pink: { name: 'Pink', bg: '#fbdfe9', surface: '#fdf0f5', border: '#f0b8cd', text: '#161616', textDim: '#54545a', textFaint: '#8a8a90' },
    light_purple: { name: 'Purple', bg: '#e7dbf7', surface: '#f2eafb', border: '#c7a8ec', text: '#161616', textDim: '#54545a', textFaint: '#8a8a90' },
    light_blue: { name: 'Blue', bg: '#dbe7fb', surface: '#eaf1fd', border: '#a9cbf5', text: '#161616', textDim: '#54545a', textFaint: '#8a8a90' },
    light_teal: { name: 'Teal', bg: '#d5f0f1', surface: '#e8f7f8', border: '#9fe0e3', text: '#161616', textDim: '#54545a', textFaint: '#8a8a90' },
    light_green: { name: 'Green', bg: '#dcf2e1', surface: '#eaf8ed', border: '#a6e0b6', text: '#161616', textDim: '#54545a', textFaint: '#8a8a90' },
    light_yellow: { name: 'Yellow', bg: '#faf0c4', surface: '#fdf8e0', border: '#ecd97e', text: '#161616', textDim: '#54545a', textFaint: '#8a8a90' },
    light_orange: { name: 'Orange', bg: '#fbe2cd', surface: '#fdf0e4', border: '#f0bb8c', text: '#161616', textDim: '#54545a', textFaint: '#8a8a90' },
    light_red: { name: 'Red', bg: '#fbdada', surface: '#fdeded', border: '#f0aeae', text: '#161616', textDim: '#54545a', textFaint: '#8a8a90' },
    light_rose: { name: 'Crimson', bg: '#f7d9e0', surface: '#fbebee', border: '#e8a9b7', text: '#161616', textDim: '#54545a', textFaint: '#8a8a90' },
    // black has no real "hue" to carry through — this is the neutral pastel
    // (was the old single generic `light` entry, kept as-is and renamed to
    // fit the light_X pattern; see the migration in the useEffect below for
    // installs that still have the literal 'light' stored).
    light_black: { name: 'Light', bg: '#e7e7ea', surface: '#f2f2f4', border: '#c7c7cd', text: '#161616', textDim: '#54545a', textFaint: '#8a8a90' },
};

// Whether a given base id is the light one — screens that need to invert
// something base.text/textDim/textFaint doesn't already cover (an icon
// tinted to a literal color, an image overlay scrim meant for a dark photo)
// can check this rather than hardcoding 'light' as a string. Matches the
// provider's own isLight exactly: the real light bases are light_X (one per
// hue) plus light_black, so checking only for the literal 'light' — the single
// generic light theme that existed before it was split up — was always false.
export const isLightBase = (id) => id === 'light' || !!id?.startsWith('light_');

const ThemeContext = createContext({
    theme: THEMES.purple, themeId: 'purple', setTheme: () => { },
    base: BASE_COLORS.black, baseId: 'black', setBase: () => { },
    isLight: false, toggleLightMode: () => { },
    ready: false,
});

export function ThemeProvider({ children }) {
    const [themeId, setThemeId] = useState('purple');
    const [baseId, setBaseId] = useState('black');
    // Real theme/base ids only exist in AsyncStorage, so themeId/baseId above
    // are just placeholders until this resolves. Anything that reads
    // theme.accent before `ready` is true (e.g. a component mounted during
    // that very first frame) sees the purple/black placeholder regardless of
    // what the user actually picked — this is the leading theory for the
    // "purple flash near the start of a session" report. `ready` lets
    // consumers (see App.js) hold off rendering themed UI until the real
    // values are in, instead of rendering-then-correcting.
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let cancelled = false;
        Promise.all([
            AsyncStorage.getItem('theme_id').then(id => {
                if (id && THEMES[id]) { setThemeId(id); return; }
                // Migrate old ids that no longer exist. "white" specifically
                // becomes the new "pink" rather than falling back to rose,
                // since pink is now its own distinct color again.
                const migrate = { indigo: 'blue', lime: 'green', amber: 'orange', white: 'pink' };
                if (id && migrate[id]) setThemeId(migrate[id]);
            }),
            AsyncStorage.getItem('base_color_id').then(id => {
                if (id && BASE_COLORS[id]) { setBaseId(id); return; }
                // Old chains that used to land on the legacy light_purple
                // (a completely different, now-removed light-gray-ish theme
                // from several rounds back) used to migrate to dark_purple.
                // That entry is gone now — light_purple is a real, valid
                // BASE_COLORS key again (the new pastel purple below, paired
                // with dark_purple), so it's caught by the check above and
                // never reaches this migration map at all. Genuinely fine as
                // an outcome (a stored "light_purple" landing on an actual
                // light purple theme fits the name better than the old
                // migration target ever did) — noted here so it's not
                // mistaken for a bug if that old migration line looks like
                // it's missing.
                //
                // 'light' (the old single generic light theme, before it was
                // split into one pastel per hue below) migrates to
                // light_black specifically — that neutral entry IS the old
                // 'light' theme's exact colors, just renamed to fit the
                // light_X-per-hue pattern.
                const migrate = {
                    light_gray: 'dark_purple', galaxy: 'dark_purple', gray: 'dark_purple', dark_gray: 'black',
                    slate: 'black',
                    light: 'light_black',
                };
                if (id && migrate[id]) setBaseId(migrate[id]);
            }),
        ]).finally(() => { if (!cancelled) setReady(true); });
        return () => { cancelled = true; };
    }, []);

    // Real bug found here (contributes to overall app sluggishness,
    // possibly the "settings feels slow" complaint too): setTheme/setBase
    // were plain arrow functions recreated fresh on every render, and the
    // Provider's own value object below was a brand-new object literal
    // every render too — meaning EVERY consumer of useTheme() anywhere in
    // the app (which is nearly every screen and component here) re-
    // rendered on every single ThemeProvider render, regardless of whether
    // theme/base actually changed. Wrapped in useCallback/useMemo so
    // consumers only actually re-render when theme, base, or ready
    // genuinely change.
    const setTheme = useCallback(async (id) => { setThemeId(id); await AsyncStorage.setItem('theme_id', id); }, []);
    const setBase = useCallback(async (id) => { setBaseId(id); await AsyncStorage.setItem('base_color_id', id); }, []);

    // Simple toggle rather than making the user pick "Light" out of the
    // same grid as the ten dark bases — remembers whichever dark base was
    // active before switching to Light, so flipping back doesn't lose it.
    //
    // Real gap found here: this used to switch straight to the single
    // literal 'light' base regardless of which dark hue was active —
    // exactly "there are still no light mode base colors, just replace the
    // dark mode colors when light mode is on, match the colors but have
    // them light/pastel." Now derives the matching light_X for whichever
    // dark_X (or black) was active, so the hue actually carries through
    // instead of always landing on the same neutral light theme.
    const toggleLightMode = useCallback(async () => {
        if (baseId?.startsWith('light_')) {
            const prev = (await AsyncStorage.getItem('base_color_id_pre_light')) || 'black';
            await setBase(BASE_COLORS[prev] ? prev : 'black');
        } else {
            await AsyncStorage.setItem('base_color_id_pre_light', baseId);
            const hue = baseId === 'black' ? 'black' : baseId.replace(/^dark_/, '');
            const lightId = `light_${hue}`;
            await setBase(BASE_COLORS[lightId] ? lightId : 'light_black');
        }
    }, [baseId, setBase]);

    const value = useMemo(() => ({
        theme: THEMES[themeId], themeId, setTheme,
        base: BASE_COLORS[baseId], baseId, setBase,
        isLight: !!baseId?.startsWith('light_'), toggleLightMode,
        ready,
    }), [themeId, baseId, ready, setTheme, setBase, toggleLightMode]);

    return (
        <ThemeContext.Provider value={value}>
            {children}
        </ThemeContext.Provider>
    );
}

export const useTheme = () => useContext(ThemeContext);
