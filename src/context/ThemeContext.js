import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const THEMES = {
    purple: { name: 'Purple', accent: '#7c3aed', accentDim: '#2a1f3d', onAccent: '#fff' },
    blue: { name: 'Blue', accent: '#2563eb', accentDim: '#1e2a4d', onAccent: '#fff' },
    green: { name: 'Green', accent: '#16a34a', accentDim: '#1a3d2a', onAccent: '#fff' },
    red: { name: 'Red', accent: '#dc2626', accentDim: '#3d1a1a', onAccent: '#fff' },
    orange: { name: 'Orange', accent: '#ea580c', accentDim: '#3d2a1a', onAccent: '#fff' },
    pink: { name: 'Pink', accent: '#f0047f', accentDim: '#3d0a24', onAccent: '#fff' },
    mono: { name: 'Mono', accent: '#888888', accentDim: '#222222', onAccent: '#fff' },
    white: { name: 'White', accent: '#e5e5e5', accentDim: '#2a2a2a', onAccent: '#000' },
    teal: { name: 'Teal', accent: '#0891b2', accentDim: '#0a2a33', onAccent: '#fff' },
    amber: { name: 'Amber', accent: '#d97706', accentDim: '#332208', onAccent: '#fff' },
    indigo: { name: 'Indigo', accent: '#4338ca', accentDim: '#1a1a4d', onAccent: '#fff' },
    lime: { name: 'Lime', accent: '#65a30d', accentDim: '#1a2a05', onAccent: '#fff' },
};

const ThemeContext = createContext({ theme: THEMES.purple, themeId: 'purple', setTheme: () => { } });

export function ThemeProvider({ children }) {
    const [themeId, setThemeId] = useState('purple');
    useEffect(() => {
        AsyncStorage.getItem('theme_id').then(id => { if (id && THEMES[id]) setThemeId(id); });
    }, []);
    const setTheme = async (id) => { setThemeId(id); await AsyncStorage.setItem('theme_id', id); };
    return (
        <ThemeContext.Provider value={{ theme: THEMES[themeId], themeId, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export const useTheme = () => useContext(ThemeContext);