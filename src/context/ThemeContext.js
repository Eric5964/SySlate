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

const ThemeContext = createContext({ theme: THEMES.purple, themeId: 'purple', setTheme: () => { } });

export function ThemeProvider({ children }) {
    const [themeId, setThemeId] = useState('purple');
    useEffect(() => {
        AsyncStorage.getItem('theme_id').then(id => {
            if (id && THEMES[id]) { setThemeId(id); return; }
            const migrate = { indigo: 'blue', lime: 'green', amber: 'orange', pink: 'rose' };
            if (id && migrate[id]) setThemeId(migrate[id]);
        });
    }, []);
    const setTheme = async (id) => { setThemeId(id); await AsyncStorage.setItem('theme_id', id); };
    return (
        <ThemeContext.Provider value={{ theme: THEMES[themeId], themeId, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export const useTheme = () => useContext(ThemeContext);
