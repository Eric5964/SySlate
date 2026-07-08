import React, { createContext, useContext, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const THEMES = {
    purple: { name: 'Purple', accent: '#7c3aed', accentDim: '#2a1f3d' },
    blue: { name: 'Blue', accent: '#2563eb', accentDim: '#1e2a4d' },
    green: { name: 'Green', accent: '#16a34a', accentDim: '#1a3d2a' },
    red: { name: 'Red', accent: '#dc2626', accentDim: '#3d1a1a' },
    orange: { name: 'Orange', accent: '#ea580c', accentDim: '#3d2a1a' },
    pink: { name: 'Pink', accent: '#db2777', accentDim: '#3d1a2e' },
    mono: { name: 'Mono', accent: '#888888', accentDim: '#222222' },
};

const ThemeContext = createContext({
    theme: THEMES.purple,
    themeId: 'purple',
    setTheme: () => { },
});

export function ThemeProvider({ children }) {
    const [themeId, setThemeId] = useState('purple');

    const setTheme = useCallback(async (id) => {
        setThemeId(id);
        await AsyncStorage.setItem('theme_id', id);
    }, []);

    React.useEffect(() => {
        AsyncStorage.getItem('theme_id').then(id => { if (id && THEMES[id]) setThemeId(id); });
    }, []);

    return (
        <ThemeContext.Provider value={{ theme: THEMES[themeId], themeId, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export const useTheme = () => useContext(ThemeContext);