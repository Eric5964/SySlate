import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';

const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };

export const getEQPreset = (path) => safe(() => AsyncStorage.getItem(path ? `eq:${path}` : 'eq:global').then(v => v ?? 'flat'), 'flat');
export const getCrossfadeEnabled = () => safe(() => AsyncStorage.getItem('crossfade_enabled').then(v => v === 'true'), false);
export const setCrossfadeEnabled = (v) => safe(() => AsyncStorage.setItem('crossfade_enabled', String(v)), null);
export const getCrossfadeDuration = () => safe(() => AsyncStorage.getItem('crossfade_duration').then(v => v !== null ? parseFloat(v) : 4), 4);
// setCrossfadeDuration (the writer) was removed — nothing writes the old
// combined key anymore now that Skip/EndOfTrack are separate below; the
// getter stays only as their one-time migration fallback.
// Split from the single Crossfade Duration above to match Audio Ramp's
// granularity (On Skip / End of Track each get their own duration — see
// AudioEngine.swift's advance() comment for why there's no "On Play" one
// for crossfade specifically). Each new getter falls back to the OLD
// single 'crossfade_duration' value the first time it's read (before
// either new key has ever been written), so an existing install's
// already-configured duration carries over as the starting point for
// both instead of silently resetting to a fresh default of 4.
export const getCrossfadeDurationSkip = () => safe(() => AsyncStorage.getItem('crossfade_duration_skip').then(v => v !== null ? parseFloat(v) : getCrossfadeDuration()), 4);
export const setCrossfadeDurationSkip = (v) => safe(() => AsyncStorage.setItem('crossfade_duration_skip', String(v)), null);
export const getCrossfadeDurationEndOfTrack = () => safe(() => AsyncStorage.getItem('crossfade_duration_eot').then(v => v !== null ? parseFloat(v) : getCrossfadeDuration()), 4);
export const setCrossfadeDurationEndOfTrack = (v) => safe(() => AsyncStorage.setItem('crossfade_duration_eot', String(v)), null);
export const getKeepPriorityOnPlaylistSwitch = () => safe(() => AsyncStorage.getItem('keep_priority_on_switch').then(v => v !== 'false'), true);
export const setKeepPriorityOnPlaylistSwitch = (v) => safe(() => AsyncStorage.setItem('keep_priority_on_switch', String(v)), null);
// When true, Album always comes from the containing folder name, same as
// before real tag reading existed — real ALBUM tag values (when found) are
// ignored entirely, not just deprioritized. Off by default now that real
// tags are read, since a genuine ALBUM tag is normally more accurate than a
// folder name, but folder structure is sometimes the more meaningful
// grouping for how a library's actually organized, hence the toggle back.
export const getAlbumFromFolder = () => safe(() => AsyncStorage.getItem('album_from_folder').then(v => v === 'true'), false);
export const setAlbumFromFolder = (v) => safe(() => AsyncStorage.setItem('album_from_folder', String(v)), null);
// Keeps the screen from auto-locking while a song is actively playing
// (paused doesn't count) — see hooks/useScreenAwake.js for where this
// actually gets applied.
export const getKeepScreenAwake = () => safe(() => AsyncStorage.getItem('keep_screen_awake').then(v => v === 'true'), false);
export const setKeepScreenAwake = (v) => safe(() => AsyncStorage.setItem('keep_screen_awake', String(v)), null);
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
// matching what those installs actually had turned on before) — but if
// NEITHER key has ever been written (a genuinely fresh install/session,
// nothing to fall back to), this now defaults to false. It previously fell
// through to `legacy !== 'off'` even with legacy === null, which evaluates
// true — so a brand new install started shuffled with no shuffle ever
// having been turned on anywhere, the opposite of "plays in order unless
// last left on shuffle."
export const getShuffleOn = () => safe(async () => {
    const v = await AsyncStorage.getItem('shuffle_on');
    if (v !== null) return v === 'true';
    const legacy = await AsyncStorage.getItem('shuffle_mode');
    if (legacy === null) return false;
    return legacy !== 'off';
}, false);
export const setShuffleOn = (v) => safe(() => AsyncStorage.setItem('shuffle_on', String(v)), null);
// Function names say "ramp" (there's no actual overlap between two tracks —
// see the "Crossfade" comment in SettingsScreen.js). The AsyncStorage key
// strings ('crossfade', 'skip_crossfade') are deliberately left as-is even
// though the functions are renamed — changing the key itself would silently
// reset anyone's already-saved value back to default on this update, since
// AsyncStorage.getItem would just find nothing under the new key name.
export const getEndOfTrackRamp = () => safe(() => AsyncStorage.getItem('crossfade').then(v => v !== null ? parseFloat(v) : 3.0), 3.0);
export const setEndOfTrackRamp = (s) => safe(() => AsyncStorage.setItem('crossfade', String(s)), null);
export const getSkipRamp = () => safe(() => AsyncStorage.getItem('skip_crossfade').then(v => v !== null ? parseFloat(v) : 0.5), 0.5);
export const setSkipRamp = (s) => safe(() => AsyncStorage.setItem('skip_crossfade', String(s)), null);
export const getSession = (path) => safe(() => AsyncStorage.getItem(`session:${path}`).then(v => v ? JSON.parse(v) : null), null);
export const setSession = (path, data) => safe(() => AsyncStorage.setItem(`session:${path}`, JSON.stringify(data)), null);
// Split into two distinct features per user request: this one is the
// original per-track dynamics compressor (WITHIN a track) — kept on the
// same 'vol_norm' storage key so nobody's existing setting gets reset.
// getBetweenTrackNorm/getSilenceTrim below are the new ones, both new
// keys defaulting off.
export const getWithinTrackNorm = () => safe(() => AsyncStorage.getItem('vol_norm').then(v => v !== 'false'), true);
export const setWithinTrackNorm = (v) => safe(() => AsyncStorage.setItem('vol_norm', String(v)), null);
export const getBetweenTrackNorm = () => safe(() => AsyncStorage.getItem('between_track_norm').then(v => v === 'true'), false);
export const setBetweenTrackNorm = (v) => safe(() => AsyncStorage.setItem('between_track_norm', String(v)), null);
export const getSilenceTrim = () => safe(() => AsyncStorage.getItem('silence_trim').then(v => v === 'true'), false);
export const setSilenceTrim = (v) => safe(() => AsyncStorage.setItem('silence_trim', String(v)), null);
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

// Best-effort resilience for playlist order/covers looking inconsistent
// across app updates (reinstalls via SideStore/LiveContainer). AsyncStorage's
// underlying store may not survive an IPA reinstall the same way the
// Documents directory does — Documents is where the music library itself
// lives, which does survive — so these two are also mirrored into a small
// JSON file there on every write. If AsyncStorage ever comes back empty for
// one of them but this file has real data, it's restored automatically.
// This is a defensive backstop rather than a confirmed diagnosis of the
// exact cause — worth testing across an actual update to see if it helps.
const BACKUP_PATH = FileSystem.documentDirectory + '.syslate_settings_backup.json';
const writeBackup = async (patch) => {
    try {
        let existing = {};
        try { existing = JSON.parse(await FileSystem.readAsStringAsync(BACKUP_PATH)); } catch { }
        await FileSystem.writeAsStringAsync(BACKUP_PATH, JSON.stringify({ ...existing, ...patch }));
    } catch { }
};
const readBackup = async () => {
    try { return JSON.parse(await FileSystem.readAsStringAsync(BACKUP_PATH)); } catch { return null; }
};

// Persisted playlist order — array of playlist paths, most-preferred first
export const getPlaylistOrder = () => safe(async () => {
    const v = await AsyncStorage.getItem('playlist_order');
    if (v) return JSON.parse(v);
    const backup = await readBackup();
    if (backup?.playlist_order?.length) {
        await AsyncStorage.setItem('playlist_order', JSON.stringify(backup.playlist_order));
        return backup.playlist_order;
    }
    return [];
}, []);
export const setPlaylistOrder = (order) => safe(async () => {
    await AsyncStorage.setItem('playlist_order', JSON.stringify(order));
    await writeBackup({ playlist_order: order });
}, null);

// Custom cover image per playlist, keyed by playlist path -> local image URI
export const getPlaylistCovers = () => safe(async () => {
    const v = await AsyncStorage.getItem('playlist_covers');
    if (v) return JSON.parse(v);
    const backup = await readBackup();
    if (backup?.playlist_covers && Object.keys(backup.playlist_covers).length) {
        await AsyncStorage.setItem('playlist_covers', JSON.stringify(backup.playlist_covers));
        return backup.playlist_covers;
    }
    return {};
}, {});
export const setPlaylistCover = async (path, uri) => {
    const covers = await getPlaylistCovers();
    if (uri) covers[path] = uri; else delete covers[path];
    await safe(() => AsyncStorage.setItem('playlist_covers', JSON.stringify(covers)), null);
    await writeBackup({ playlist_covers: covers });
    return covers;
};

export const getShowPlayCount = () => safe(() => AsyncStorage.getItem('show_play_count').then(v => v !== 'false'), true);
export const setShowPlayCount = (v) => safe(() => AsyncStorage.setItem('show_play_count', String(v)), null);

// Off by default — showing a cover next to every row means extracting art
// for the whole visible list (not just the currently-playing song), which
// is real, noticeable work for a big library. Opt-in rather than surprising
// someone with a slow first load.
export const getShowSongCovers = () => safe(() => AsyncStorage.getItem('show_song_covers').then(v => v === 'true'), false);
export const setShowSongCovers = (v) => safe(() => AsyncStorage.setItem('show_song_covers', String(v)), null);

// Splits a multi-artist tag string on a configurable separator ('none'
// disables splitting entirely — the tag displays and matches as one whole
// string, same as before this feature existed). Defaults to ';' rather
// than ',' or '&' specifically because those two are common WITHIN a
// single real artist/band name ("Earth, Wind & Fire"), so using either as
// the default would misparse plenty of untagged-for-this libraries right
// out of the box. ';' essentially never appears inside a real artist name,
// so defaulting to it is safe even for a library that was never tagged
// with multiple artists in mind — nothing with no ';' in it is affected.
export const getArtistSeparator = () => safe(() => AsyncStorage.getItem('artist_separator').then(v => v ?? ';'), ';');
export const setArtistSeparator = (v) => safe(() => AsyncStorage.setItem('artist_separator', v), null);

// 'off' — feature entirely disabled, no .lrc lookup ever happens (no wasted
// file I/O for anyone who doesn't want this). 'manual' — lyrics available
// via the toggle button when a song has a matching .lrc file, defaulting to
// the cover each time a new song starts. 'auto' — same, but defaults to
// showing lyrics automatically whenever the new song has them, rather than
// requiring a tap each time.
export const getLyricsMode = () => safe(() => AsyncStorage.getItem('lyrics_mode').then(v => v ?? 'off'), 'off');
export const setLyricsMode = (v) => safe(() => AsyncStorage.setItem('lyrics_mode', v), null);

// 'rounded' (squircle, matches the app's existing default everywhere) or
// 'square' (sharp corners) — applies to every cover-art element app-wide
// (see utils/squircle.js).
export const getCoverShape = () => safe(() => AsyncStorage.getItem('cover_shape').then(v => v ?? 'rounded'), 'rounded');
export const setCoverShape = (v) => safe(() => AsyncStorage.setItem('cover_shape', v), null);
// Renamed + inverted from the old "Hide Player Cover" (hide_player_cover,
// default false meaning shown — a double-negative toggle) to "Show Player
// Cover" (show_player_cover, default true, auto-enabled). Migrates an
// existing hide_player_cover value once rather than silently re-showing the
// cover for anyone who'd already turned it off under the old key.
export const getShowPlayerCover = () => safe(async () => {
    const v = await AsyncStorage.getItem('show_player_cover');
    if (v !== null) return v === 'true';
    const legacyHide = await AsyncStorage.getItem('hide_player_cover');
    if (legacyHide !== null) return legacyHide !== 'true';
    return true;
}, true);
export const setShowPlayerCover = (v) => safe(() => AsyncStorage.setItem('show_player_cover', String(v)), null);

// Whole-app custom background image — off by default, and the URI is only
// meaningful once persisted locally (see persistCoverImage/the same pattern
// used for playlist covers; a raw picker URI lives in a volatile cache dir).
export const getBackgroundImageEnabled = () => safe(() => AsyncStorage.getItem('bg_image_enabled').then(v => v === 'true'), false);
export const setBackgroundImageEnabled = (v) => safe(() => AsyncStorage.setItem('bg_image_enabled', v ? 'true' : 'false'), null);
export const getBackgroundImageUri = () => safe(() => AsyncStorage.getItem('bg_image_uri'), null);
export const setBackgroundImageUri = (v) => safe(() => v ? AsyncStorage.setItem('bg_image_uri', v) : AsyncStorage.removeItem('bg_image_uri'), null);

// Previous button behavior. 'previous_track' — pressing it always skips to
// the previous track, no matter where you are in the current one.
// 'restart_or_previous' — pressing it restarts the CURRENT track from
// 0:00 instead, UNLESS you're still within the first
// `restart_threshold_sec` seconds of the track, in which case it skips to
// the previous track — this is the conventional behavior most streaming
// apps use (a quick double-tap-ish press near the start goes back, a press
// once you're actually into the song just restarts it).
export const getPrevButtonMode = () => safe(() => AsyncStorage.getItem('prev_button_mode').then(v => v ?? 'previous_track'), 'previous_track');
export const setPrevButtonMode = (v) => safe(() => AsyncStorage.setItem('prev_button_mode', v), null);

// Only read when prev_button_mode is 'restart_or_previous'. Seconds
// (0-12) from the start of a track during which pressing Previous still
// goes to the previous track instead of restarting the current one.
export const getRestartThresholdSec = () => safe(() => AsyncStorage.getItem('restart_threshold_sec').then(v => v !== null ? parseFloat(v) : 3), 3);
export const setRestartThresholdSec = (v) => safe(() => AsyncStorage.setItem('restart_threshold_sec', String(v)), null);

// How long a manual scroll through the lyrics view sits idle before it
// snaps back to following the song automatically. 0 = never auto-follow
// again until the user re-enables it — wait, 0 actually means "snap back
// immediately", i.e. effectively no manual scrolling sticks at all.
export const getLyricsResyncSec = () => safe(() => AsyncStorage.getItem('lyrics_resync_sec').then(v => v !== null ? parseFloat(v) : 4), 4);
export const setLyricsResyncSec = (v) => safe(() => AsyncStorage.setItem('lyrics_resync_sec', String(v)), null);

// Shifts which line counts as "active" earlier/later relative to the
// song's real position, in seconds — some .lrc files are timed a beat off.
// Positive = lyrics shown earlier (subtracted from playback position before
// matching against the timestamps), negative = later.
export const getLyricsOffsetSec = () => safe(() => AsyncStorage.getItem('lyrics_offset_sec').then(v => v !== null ? parseFloat(v) : 0), 0);
export const setLyricsOffsetSec = (v) => safe(() => AsyncStorage.setItem('lyrics_offset_sec', String(v)), null);

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

// Keyed by title+artist rather than song.id (a file path) — two files of
// the "same song" living in different playlists used to track separate
// counts since they had different paths. Normalizing case/whitespace so
// "Song.flac" and "song.flac" style differences don't split a count.
const playCountKey = (song) => {
    const t = (song?.ourTitle ?? song?.title ?? '').trim().toLowerCase();
    const a = (song?.ourArtist ?? song?.artist ?? '').trim().toLowerCase();
    return `pcn:${t}::${a}`;
};

export const incrementPlayCount = async (song) => {
    if (!song) return;
    try {
        const k = playCountKey(song);
        const v = await AsyncStorage.getItem(k);
        await AsyncStorage.setItem(k, String(v ? parseInt(v) + 1 : 1));
    } catch { }
};

// Takes full song objects (needs title/artist to compute the shared key),
// not bare ids. Returns counts keyed by song.id for callers, but the VALUE
// is the same for every song sharing a title+artist. The first time a given
// combined key has no count yet, falls back to summing the old per-file
// ('pc:<path>') counts for every song sharing it, so history from before
// this change isn't lost.
export const getPlayCounts = async (songs) => {
    try {
        const byKey = {};
        songs.forEach(s => { (byKey[playCountKey(s)] ??= []).push(s); });
        const keys = Object.keys(byKey);
        const pairs = await AsyncStorage.multiGet(keys);
        const keyCounts = {};
        const missingKeys = [];
        pairs.forEach(([k, v]) => {
            if (v) keyCounts[k] = parseInt(v);
            else missingKeys.push(k);
        });
        if (missingKeys.length) {
            const legacyKeys = missingKeys.flatMap(k => byKey[k].map(s => `pc:${s.id}`));
            const legacyPairs = await AsyncStorage.multiGet(legacyKeys);
            const legacyMap = Object.fromEntries(legacyPairs);
            missingKeys.forEach(k => {
                keyCounts[k] = byKey[k].reduce((sum, s) => sum + (parseInt(legacyMap[`pc:${s.id}`]) || 0), 0);
            });
        }
        const out = {};
        songs.forEach(s => { out[s.id] = keyCounts[playCountKey(s)] ?? 0; });
        return out;
    } catch { return {}; }
};

export const exportAllSettings = async () => {
    const keys = ['theme_id', 'base_color_id', 'shuffle_mode', 'shuffle_on', 'crossfade', 'crossfade_enabled', 'crossfade_duration', 'skip_crossfade', 'vol_norm', 'between_track_norm', 'silence_trim', 'audio_ramp', 'ramp_on_pause', 'custom_eq_presets', 'hidden_eq_presets', 'playlist_view_format', 'playlist_order', 'playlist_covers', 'show_play_count', 'show_song_covers', 'playlist_sort_orders', 'keep_priority_on_switch', 'artist_separator', 'lyrics_mode', 'lyrics_resync_sec', 'lyrics_offset_sec', 'prev_button_mode', 'restart_threshold_sec', 'album_from_folder', 'keep_screen_awake', 'cover_shape', 'show_player_cover', 'bg_image_enabled', 'bg_image_uri'];
    const pairs = await AsyncStorage.multiGet(keys);
    const obj = {};
    pairs.forEach(([k, v]) => { if (v !== null) obj[k] = v; });
    return JSON.stringify(obj, null, 2);
};

export const importAllSettings = async (jsonString) => {
    const obj = JSON.parse(jsonString);
    await AsyncStorage.multiSet(Object.entries(obj).map(([k, v]) => [k, v]));
};