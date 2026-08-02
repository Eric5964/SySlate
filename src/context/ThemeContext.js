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
    rose: { name: 'Rose', accent: '#db2777', accentDim: '#3d1428', onAccent: '#fff' },
    mono: { name: 'Mono', accent: '#9ca3af', accentDim: '#26282c', onAccent: '#000' },
};

// The app's neutral/background palette, independent of accent color.
// "dark_gray" matches the app's original hardcoded look, so existing
// installs default to looking exactly the same as before this existed.
// The old "Light Gray" option is now a deep galaxy purple/blue instead —
// still the lightest/most colorful of the four, just not literally gray.
export const BASE_COLORS = {
    galaxy: { name: 'Galaxy', bg: '#1a1730', surface: '#231f42', border: '#332d55' },
    // Was flat gray (#1c1c1e) — the lightest/flattest of the four in
    // practice, even though "Galaxy" already covers the deep-purple end.
    // Replaced with a gentler, lighter galaxy tone instead of plain gray.
    gray: { name: 'Nebula', bg: '#242038', surface: '#2d2850', border: '#413a6b' },
    dark_gray: { name: 'Dark Gray', bg: '#0a0a0a', surface: '#0f0f0f', border: '#1a1a1a' },
    black: { name: 'Black', bg: '#000000', surface: '#0a0a0a', border: '#161616' },
};

const ThemeContext = createContext({
    theme: THEMES.purple, themeId: 'purple', setTheme: () => { },
    base: BASE_COLORS.dark_gray, baseId: 'dark_gray', setBase: () => { },
});

export function ThemeProvider({ children }) {
    const [themeId, setThemeId] = useState('purple');
    const [baseId, setBaseId] = useState('dark_gray');

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
            const migrate = { light_gray: 'galaxy' };
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
