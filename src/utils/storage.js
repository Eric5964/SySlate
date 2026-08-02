import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';

const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };

export const getEQPreset = (path) => safe(() => AsyncStorage.getItem(path ? `eq:${path}` : 'eq:global').then(v => v ?? 'flat'), 'flat');
export const setEQPreset = (id, path) => safe(() => AsyncStorage.setItem(path ? `eq:${path}` : 'eq:global', id), null);
// `shuffle_mode` now holds ONLY the algorithm preference (full_cycle /
// true_random / smart) and is never written as 'off' going forward — that
// used to double as the on/off flag too, which is why picking a mode in
// Settings silently turned shuffle on. Old installs may still have 'off'
// sitting in this key from before; getShuffleMode() below treats that the
// same as "no preference yet" and falls back to the default, since the
// on/off state itself now lives separately in `shuffle_on`.
export const getShuffleMode = () => safe(async () => {
    const v = await AsyncStorage.getItem('shuffle_mode');
    return (v && v !== 'off') ? v : 'full_cycle';
}, 'full_cycle');
export const setShuffleMode = (m) => safe(() => AsyncStorage.setItem('shuffle_mode', m), null);

// Whether shuffle is currently enabled, independent of which algorithm is
// selected. Falls back to reading the legacy combined `shuffle_mode` value
// on first read after updating (old 'off' -> false, any real mode -> true,
// matching what those installs actually had turned on before).
export const getShuffleOn = () => safe(async () => {
    const v = await AsyncStorage.getItem('shuffle_on');
    if (v !== null) return v === 'true';
    const legacy = await AsyncStorage.getItem('shuffle_mode');
    return legacy !== 'off';
}, true);
export const setShuffleOn = (v) => safe(() => AsyncStorage.setItem('shuffle_on', String(v)), null);
export const getCrossfade = () => safe(() => AsyncStorage.getItem('crossfade').then(v => v !== null ? parseFloat(v) : 3.0), 3.0);
export const setCrossfade = (s) => safe(() => AsyncStorage.setItem('crossfade', String(s)), null);
export const getSkipCrossfade = () => safe(() => AsyncStorage.getItem('skip_crossfade').then(v => v !== null ? parseFloat(v) : 0.5), 0.5);
export const setSkipCrossfade = (s) => safe(() => AsyncStorage.setItem('skip_crossfade', String(s)), null);
export const getSession = (path) => safe(() => AsyncStorage.getItem(`session:${path}`).then(v => v ? JSON.parse(v) : null), null);
export const setSession = (path, data) => safe(() => AsyncStorage.setItem(`session:${path}`, JSON.stringify(data)), null);
export const getVolNorm = () => safe(() => AsyncStorage.getItem('vol_norm').then(v => v !== 'false'), true);
export const setVolNorm = (v) => safe(() => AsyncStorage.setItem('vol_norm', String(v)), null);
export const getAudioRamp = () => safe(() => AsyncStorage.getItem('audio_ramp').then(v => v !== null ? parseFloat(v) : 0), 0);
export const setAudioRamp = (s) => safe(() => AsyncStorage.setItem('audio_ramp', String(s)), null);
export const getRampOnPause = () => safe(() => AsyncStorage.getItem('ramp_on_pause').then(v => v === 'true'), false);
export const setRampOnPause = (v) => safe(() => AsyncStorage.setItem('ramp_on_pause', String(v)), null);
export const getCustomPresets = () => safe(() => AsyncStorage.getItem('custom_eq_presets').then(v => v ? JSON.parse(v) : []), []);
export const setCustomPresets = (p) => safe(() => AsyncStorage.setItem('custom_eq_presets', JSON.stringify(p)), null);
export const getHiddenPresets = () => safe(() => AsyncStorage.getItem('hidden_eq_presets').then(v => v ? JSON.parse(v) : []), []);
export const setHiddenPresets = (p) => safe(() => AsyncStorage.setItem('hidden_eq_presets', JSON.stringify(p)), null);
export const getPlaylistViewFormat = () => safe(() => AsyncStorage.getItem('playlist_view_format').then(v => v ?? 'list'), 'list');
export const setPlaylistViewFormat = (f) => safe(() => AsyncStorage.setItem('playlist_view_format', f), null);
export const getLastSession = () => safe(() => AsyncStorage.getItem('last_session').then(v => v ? JSON.parse(v) : null), null);
export const setLastSession = (d) => safe(() => AsyncStorage.setItem('last_session', JSON.stringify(d)), null);

// Persisted playlist order — array of playlist paths, most-preferred first
export const getPlaylistOrder = () => safe(() => AsyncStorage.getItem('playlist_order').then(v => v ? JSON.parse(v) : []), []);
export const setPlaylistOrder = (order) => safe(() => AsyncStorage.setItem('playlist_order', JSON.stringify(order)), null);

// Custom cover image per playlist, keyed by playlist path -> local image URI
export const getPlaylistCovers = () => safe(() => AsyncStorage.getItem('playlist_covers').then(v => v ? JSON.parse(v) : {}), {});
export const setPlaylistCover = async (path, uri) => {
    const covers = await getPlaylistCovers();
    if (uri) covers[path] = uri; else delete covers[path];
    await safe(() => AsyncStorage.setItem('playlist_covers', JSON.stringify(covers)), null);
    return covers;
};

export const getShowPlayCount = () => safe(() => AsyncStorage.getItem('show_play_count').then(v => v !== 'false'), true);
export const setShowPlayCount = (v) => safe(() => AsyncStorage.setItem('show_play_count', String(v)), null);

// Remembers each playlist's chosen sort (A-Z / Z-A / Most Played / etc.)
// separately, persisted across app restarts.
export const getPlaylistSort = (playlistPath) => safe(async () => {
    const all = await AsyncStorage.getItem('playlist_sort_orders');
    const map = all ? JSON.parse(all) : {};
    return map[playlistPath] ?? 'alpha';
}, 'alpha');

export const setPlaylistSort = async (playlistPath, sortId) => {
    try {
        const all = await AsyncStorage.getItem('playlist_sort_orders');
        const map = all ? JSON.parse(all) : {};
        map[playlistPath] = sortId;
        await AsyncStorage.setItem('playlist_sort_orders', JSON.stringify(map));
    } catch { }
};

// expo-image-picker's result URI lives in a CACHE directory, which iOS can
// clear at any time and which was also the likely cause of covers flashing
// on re-render (the cache file wasn't being decoded/served consistently).
// Copying it into Documents gives it a permanent, stable path.
export const persistCoverImage = async (pickerUri) => {
    try {
        const dir = FileSystem.documentDirectory + '.covers/';
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => { });
        const ext = pickerUri.split('.').pop().split('?')[0] || 'jpg';
        const dest = dir + 'cover_' + Date.now() + '_' + Math.floor(Math.random() * 10000) + '.' + ext;
        await FileSystem.copyAsync({ from: pickerUri, to: dest });
        return dest;
    } catch (e) {
        console.error('persistCoverImage:', e);
        return pickerUri; // fall back to the original (volatile) URI rather than losing the pick entirely
    }
};

export const incrementPlayCount = async (songId) => {
    if (!songId) return;
    try {
        const k = `pc:${songId}`;
        const v = await AsyncStorage.getItem(k);
        await AsyncStorage.setItem(k, String(v ? parseInt(v) + 1 : 1));
    } catch { }
};

export const getPlayCounts = async (songIds) => {
    try {
        const pairs = await AsyncStorage.multiGet(songIds.map(id => `pc:${id}`));
        const out = {};
        pairs.forEach(([k, v]) => { out[k.replace('pc:', '')] = v ? parseInt(v) : 0; });
        return out;
    } catch { return {}; }
};

export const exportAllSettings = async () => {
    const keys = ['theme_id', 'base_color_id', 'shuffle_mode', 'shuffle_on', 'crossfade', 'skip_crossfade', 'vol_norm', 'audio_ramp', 'ramp_on_pause', 'custom_eq_presets', 'hidden_eq_presets', 'playlist_view_format', 'playlist_order', 'playlist_covers', 'show_play_count', 'playlist_sort_orders'];
    const pairs = await AsyncStorage.multiGet(keys);
    const obj = {};
    pairs.forEach(([k, v]) => { if (v !== null) obj[k] = v; });
    return JSON.stringify(obj, null, 2);
};

export const importAllSettings = async (jsonString) => {
    const obj = JSON.parse(jsonString);
    await AsyncStorage.multiSet(Object.entries(obj).map(([k, v]) => [k, v]));
};