import AsyncStorage from '@react-native-async-storage/async-storage';

const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };

// EQ
export const getEQPreset  = (path) => safe(() => AsyncStorage.getItem(path ? `eq:${path}` : 'eq:global').then(v => v ?? 'flat'), 'flat');
export const setEQPreset  = (id, path) => safe(() => AsyncStorage.setItem(path ? `eq:${path}` : 'eq:global', id), null);

// Shuffle
export const getShuffleMode = () => safe(() => AsyncStorage.getItem('shuffle_mode').then(v => v ?? 'full_cycle'), 'full_cycle');
export const setShuffleMode = (m) => safe(() => AsyncStorage.setItem('shuffle_mode', m), null);

// Crossfade
export const getCrossfade      = () => safe(() => AsyncStorage.getItem('crossfade').then(v => v !== null ? parseFloat(v) : 3.0), 3.0);
export const setCrossfade      = (s) => safe(() => AsyncStorage.setItem('crossfade', String(s)), null);
export const getSkipCrossfade  = () => safe(() => AsyncStorage.getItem('skip_crossfade').then(v => v !== null ? parseFloat(v) : 0.5), 0.5);
export const setSkipCrossfade  = (s) => safe(() => AsyncStorage.setItem('skip_crossfade', String(s)), null);

// Playlist session (saved queue order + track index)
export const getSession = (path) => safe(() => AsyncStorage.getItem(`session:${path}`).then(v => v ? JSON.parse(v) : null), null);
export const setSession = (path, data) => safe(() => AsyncStorage.setItem(`session:${path}`, JSON.stringify(data)), null);

// Volume normalization
export const getVolNorm = () => safe(() => AsyncStorage.getItem('vol_norm').then(v => v !== 'false'), true);
export const setVolNorm = (v) => safe(() => AsyncStorage.setItem('vol_norm', String(v)), null);