import React, { createContext, useContext, useState, useEffect } from 'react';
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

// Four base palettes: light purple, dark purple, gray, black. The purples
// were flagged as too muddy/desaturated before — pushed more saturated
// (more blue/violet, less gray mixed in) so they read as genuinely vibrant
// rather than a slightly-tinted dark gray.
export const BASE_COLORS = {
    black: { name: 'Black', bg: '#000000', surface: '#0a0a0a', border: '#161616' },
    dark_purple: { name: 'Purple', bg: '#120e22', surface: '#191430', border: '#241d47' },
    dark_pink: { name: 'Pink', bg: '#22101a', surface: '#301522', border: '#47213a' },
    dark_blue: { name: 'Blue', bg: '#0e1626', surface: '#141f33', border: '#1f2d4a' },
    dark_teal: { name: 'Teal', bg: '#0a1f22', surface: '#0f2a2e', border: '#163a3f' },
    dark_green: { name: 'Green', bg: '#0e2016', surface: '#14301f', border: '#1f4530' },
    dark_yellow: { name: 'Yellow', bg: '#221c0a', surface: '#302810', border: '#473a18' },
    dark_orange: { name: 'Orange', bg: '#221408', surface: '#301c0d', border: '#472a14' },
    dark_red: { name: 'Red', bg: '#220e0e', surface: '#301414', border: '#471e1e' },
    dark_rose: { name: 'Crimson', bg: '#1e0d0d', surface: '#2a1212', border: '#3d1a1a' },
};

const ThemeContext = createContext({
    theme: THEMES.purple, themeId: 'purple', setTheme: () => { },
    base: BASE_COLORS.black, baseId: 'black', setBase: () => { },
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
                // Old chains that used to land on light_purple now go straight
                // to dark_purple instead, since light_purple no longer exists
                // (base colors expanded to match the 10 accent colors — kept
                // only black and dark_purple from the old 4, dropped
                // light_purple and slate). Direct light_purple/slate selections
                // migrate the same way for the same reason.
                const migrate = {
                    light_gray: 'dark_purple', galaxy: 'dark_purple', gray: 'dark_purple', dark_gray: 'black',
                    light_purple: 'dark_purple', slate: 'black',
                };
                if (id && migrate[id]) setBaseId(migrate[id]);
            }),
        ]).finally(() => { if (!cancelled) setReady(true); });
        return () => { cancelled = true; };
    }, []);

    const setTheme = async (id) => { setThemeId(id); await AsyncStorage.setItem('theme_id', id); };
    const setBase = async (id) => { setBaseId(id); await AsyncStorage.setItem('base_color_id', id); };

    return (
        <ThemeContext.Provider value={{
            theme: THEMES[themeId], themeId, setTheme,
            base: BASE_COLORS[baseId], baseId, setBase,
            ready,
        }}>
            {children}
        </ThemeContext.Provider>
    );
}

export const useTheme = () => useContext(ThemeContext);
