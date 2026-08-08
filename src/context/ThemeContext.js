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
    light_purple: { name: 'Light Purple', bg: '#221a38', surface: '#2c2247', border: '#3d2f63' },
    dark_purple: { name: 'Dark Purple', bg: '#120e22', surface: '#191430', border: '#241d47' },
    slate: { name: 'Gray', bg: '#1c1c1e', surface: '#242426', border: '#333335' },
    black: { name: 'Black', bg: '#000000', surface: '#0a0a0a', border: '#161616' },
};

const ThemeContext = createContext({
    theme: THEMES.purple, themeId: 'purple', setTheme: () => { },
    base: BASE_COLORS.black, baseId: 'black', setBase: () => { },
});

export function ThemeProvider({ children }) {
    const [themeId, setThemeId] = useState('purple');
    const [baseId, setBaseId] = useState('black');

    useEffect(() => {
        AsyncStorage.getItem('theme_id').then(id => {
            if (id && THEMES[id]) { setThemeId(id); return; }
            // Migrate old ids that no longer exist. "white" specifically
            // becomes the new "pink" rather than falling back to rose,
            // since pink is now its own distinct color again.
            const migrate = { indigo: 'blue', lime: 'green', amber: 'orange', white: 'pink' };
            if (id && migrate[id]) setThemeId(migrate[id]);
        });
        AsyncStorage.getItem('base_color_id').then(id => {
            if (id && BASE_COLORS[id]) { setBaseId(id); return; }
            // light_gray -> galaxy -> light_purple (chained through two
            // renames); the old "gray" id held a purple (Nebula) by the time
            // of this rename, so it continues on as dark_purple; dark_gray
            // (near-black) is closest to the new flat black.
            const migrate = { light_gray: 'light_purple', galaxy: 'light_purple', gray: 'dark_purple', dark_gray: 'black' };
            if (id && migrate[id]) setBaseId(migrate[id]);
        });
    }, []);

    const setTheme = async (id) => { setThemeId(id); await AsyncStorage.setItem('theme_id', id); };
    const setBase = async (id) => { setBaseId(id); await AsyncStorage.setItem('base_color_id', id); };

    return (
        <ThemeContext.Provider value={{
            theme: THEMES[themeId], themeId, setTheme,
            base: BASE_COLORS[baseId], baseId, setBase,
        }}>
            {children}
        </ThemeContext.Provider>
    );
}

export const useTheme = () => useContext(ThemeContext);
