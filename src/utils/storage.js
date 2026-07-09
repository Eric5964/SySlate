import AsyncStorage from '@react-native-async-storage/async-storage';

const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };

export const getEQPreset = (path) => safe(() => AsyncStorage.getItem(path ? `eq:${path}` : 'eq:global').then(v => v ?? 'flat'), 'flat');
export const setEQPreset = (id, path) => safe(() => AsyncStorage.setItem(path ? `eq:${path}` : 'eq:global', id), null);
export const getShuffleMode = () => safe(() => AsyncStorage.getItem('shuffle_mode').then(v => v ?? 'full_cycle'), 'full_cycle');
export const setShuffleMode = (m) => safe(() => AsyncStorage.setItem('shuffle_mode', m), null);
export const getCrossfade = () => safe(() => AsyncStorage.getItem('crossfade').then(v => v !== null ? parseFloat(v) : 3.0), 3.0);
export const setCrossfade = (s) => safe(() => AsyncStorage.setItem('crossfade', String(s)), null);
export const getSkipCrossfade = () => safe(() => AsyncStorage.getItem('skip_crossfade').then(v => v !== null ? parseFloat(v) : 0.5), 0.5);
export const setSkipCrossfade = (s) => safe(() => AsyncStorage.setItem('skip_crossfade', String(s)), null);
export const getSession = (path) => safe(() => AsyncStorage.getItem(`session:${path}`).then(v => v ? JSON.parse(v) : null), null);
export const setSession = (path, data) => safe(() => AsyncStorage.setItem(`session:${path}`, JSON.stringify(data)), null);
export const getVolNorm = () => safe(() => AsyncStorage.getItem('vol_norm').then(v => v !== 'false'), true);
export const setVolNorm = (v) => safe(() => AsyncStorage.setItem('vol_norm', String(v)), null);
export const getCustomPresets = () => safe(() => AsyncStorage.getItem('custom_eq_presets').then(v => v ? JSON.parse(v) : []), []);
export const setCustomPresets = (p) => safe(() => AsyncStorage.setItem('custom_eq_presets', JSON.stringify(p)), null);
export const getHiddenPresets = () => safe(() => AsyncStorage.getItem('hidden_eq_presets').then(v => v ? JSON.parse(v) : []), []);
export const setHiddenPresets = (p) => safe(() => AsyncStorage.setItem('hidden_eq_presets', JSON.stringify(p)), null);
export const getPlaylistViewFormat = () => safe(() => AsyncStorage.getItem('playlist_view_format').then(v => v ?? 'list'), 'list');
export const setPlaylistViewFormat = (f) => safe(() => AsyncStorage.setItem('playlist_view_format', f), null);

// Resume playback
export const getLastSession = () => safe(() => AsyncStorage.getItem('last_session').then(v => v ? JSON.parse(v) : null), null);
export const setLastSession = (data) => safe(() => AsyncStorage.setItem('last_session', JSON.stringify(data)), null);

// Settings export/import
export const exportAllSettings = async () => {
    const keys = ['theme_id', 'shuffle_mode', 'crossfade', 'skip_crossfade', 'vol_norm', 'custom_eq_presets', 'hidden_eq_presets', 'playlist_view_format'];
    const pairs = await AsyncStorage.multiGet(keys);
    const obj = {};
    pairs.forEach(([k, v]) => { if (v !== null) obj[k] = v; });
    return JSON.stringify(obj, null, 2);
};

export const importAllSettings = async (jsonString) => {
    const obj = JSON.parse(jsonString);
    const pairs = Object.entries(obj).map(([k, v]) => [k, v]);
    await AsyncStorage.multiSet(pairs);
};
export const getAudioRamp = () => safe(() => AsyncStorage.getItem('audio_ramp').then(v => v !== null ? parseFloat(v) : 0), 0);
export const setAudioRamp = (s) => safe(() => AsyncStorage.setItem('audio_ramp', String(s)), null);