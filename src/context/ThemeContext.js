import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// 10 accents, spread evenly around the color wheel (plus 2 neutrals) so none
// feel like a near-duplicate of another (previous set had blue/indigo,
// green/lime, and orange/amber sitting right on top of each other).
export const THEMES = {
    purple: { name: 'Purple', accent: '#7c3aed', accentDim: '#2a1f3d', onAccent: '#fff' },
    blue: { name: 'Blue', accent: '#2563eb', accentDim: '#1e2a4d', onAccent: '#fff' },
    teal: { name: 'Teal', accent: '#0891b2', accentDim: '#0a2a33', onAccent: '#fff' },
    green: { name: 'Green', accent: '#16a34a', accentDim: '#1a3d2a', onAccent: '#fff' },
    yellow: { name: 'Yellow', accent: '#eab308', accentDim: '#332c08', onAccent: '#000' },
    orange: { name: 'Orange', accent: '#ea580c', accentDim: '#3d2a1a', onAccent: '#fff' },
    red: { name: 'Red', accent: '#dc2626', accentDim: '#3d1a1a', onAccent: '#fff' },
    rose: { name: 'Rose', accent: '#db2777', accentDim: '#3d1428', onAccent: '#fff' },
    mono: { name: 'Mono', accent: '#9ca3af', accentDim: '#26282c', onAccent: '#000' },
    white: { name: 'White', accent: '#f2f2f2', accentDim: '#2a2a2a', onAccent: '#000' },
};

// The app's neutral/background palette, independent of accent color.
// "dark_gray" matches the app's original hardcoded look, so existing
// installs default to looking exactly the same as before this existed.
export const BASE_COLORS = {
    light_gray: { name: 'Light Gray', bg: '#2c2c2e', surface: '#363638', border: '#48484a' },
    gray: { name: 'Gray', bg: '#1c1c1e', surface: '#242426', border: '#333335' },
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
            const migrate = { indigo: 'blue', lime: 'green', amber: 'orange', pink: 'rose' };
            if (id && migrate[id]) setThemeId(migrate[id]);
        });
        AsyncStorage.getItem('base_color_id').then(id => {
            if (id && BASE_COLORS[id]) setBaseId(id);
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
