import AsyncStorage from '@react-native-async-storage/async-storage';
import { splitArtists, formatArtists } from './artists';
import * as FileSystem from 'expo-file-system';
import { EQ_MIN, EQ_MAX, BAND_COUNT, clampEQBand } from './eq';
import AudioEngine from '../native/AudioEngine';

const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };

// Real bug found here ("selected EQ preset doesn't save between closing
// and reopening"): this is a per-playlist setting (eq:<path>), which is
// correct when you've actually picked a DIFFERENT preset for that specific
// playlist before — but if nothing was ever saved under that exact key
// (new playlist, or you usually play from All Songs/Queue/a different
// playlist than whichever one you had open when you picked a preset),
// this fell straight to the hardcoded 'flat' default, silently ignoring
// whatever preset you'd actually set elsewhere. Now falls through to the
// global preset first — only lands on 'flat' if NEITHER this playlist nor
// the global slot has ever had one saved.
export const getEQPreset = (path) => safe(async () => {
    if (path) {
        const perPlaylist = await AsyncStorage.getItem(`eq:${path}`);
        if (perPlaylist !== null) return perPlaylist;
    }
    const global = await AsyncStorage.getItem('eq:global');
    return global ?? 'flat';
}, 'flat');
export const getCrossfadeEnabled = () => safe(() => AsyncStorage.getItem('crossfade_enabled').then(v => v !== 'false'), true);
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
export const getCrossfadeDurationSkip = () => safe(() => AsyncStorage.getItem('crossfade_duration_skip').then(v => v !== null ? parseFloat(v) : 2), 2);
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
export const getWithinTrackNorm = () => safe(() => AsyncStorage.getItem('vol_norm').then(v => v === 'true'), false);
export const setWithinTrackNorm = (v) => safe(() => AsyncStorage.setItem('vol_norm', String(v)), null);

// Pre-amp: a single broadband gain in dB (-12 to +12), applied on top of
// whatever the current EQ preset already does — see AudioEngine.swift's
// setPreAmp for why this is its own native global-gain stage rather than
// an 11th band. 0 = off/unity, same meaning as a flat EQ preset.
export const getPreAmp = () => safe(() => AsyncStorage.getItem('preamp_db').then(v => v !== null ? parseFloat(v) : 0), 0);
export const setPreAmp = (v) => safe(() => AsyncStorage.setItem('preamp_db', String(v)), null);
// Spatial: stereo width in percent (100 = as recorded) and balance in percent (0 = centre, -100 left, 100 right).
export const getSpatialWidth = () => safe(() => AsyncStorage.getItem('spatial_width').then(v => { const n = v !== null ? parseFloat(v) : 100; return Number.isFinite(n) ? n : 100; }), 100);
export const setSpatialWidth = (v) => safe(() => AsyncStorage.setItem('spatial_width', String(v)), null);
export const getSpatialBalance = () => safe(() => AsyncStorage.getItem('spatial_balance').then(v => { const n = v !== null ? parseFloat(v) : 0; return Number.isFinite(n) ? n : 0; }), 0);
export const setSpatialBalance = (v) => safe(() => AsyncStorage.setItem('spatial_balance', String(v)), null);

// Whether built-in ("premade") presets are shown in the Settings screen's
// own EQ Presets grid. Separate from hiddenPresets (which governs the
// EQModal picker) — this is purely a Settings-screen declutter switch, per
// the actual ask: "show premade presets... in the settings, not just
// enabling them." Flat is never affected by this — it's filtered out of
// the built-in id list wherever this is consumed, same as hiddenPresets.
export const getShowPremadeInSettings = () => safe(() => AsyncStorage.getItem('show_premade_settings').then(v => v !== 'false'), true);
export const setShowPremadeInSettings = (v) => safe(() => AsyncStorage.setItem('show_premade_settings', String(v)), null);
export const getBetweenTrackNorm = () => safe(() => AsyncStorage.getItem('between_track_norm').then(v => v === 'true'), false);
export const setBetweenTrackNorm = (v) => safe(() => AsyncStorage.setItem('between_track_norm', String(v)), null);
export const getSilenceTrim = () => safe(() => AsyncStorage.getItem('silence_trim').then(v => v === 'true'), false);
export const setSilenceTrim = (v) => safe(() => AsyncStorage.setItem('silence_trim', String(v)), null);
export const getAudioRamp = () => safe(() => AsyncStorage.getItem('audio_ramp').then(v => v !== null ? parseFloat(v) : 2), 2);
export const setAudioRamp = (s) => safe(() => AsyncStorage.setItem('audio_ramp', String(s)), null);
export const getRampOnPause = () => safe(() => AsyncStorage.getItem('ramp_on_pause').then(v => v === 'true'), false);
export const setRampOnPause = (v) => safe(() => AsyncStorage.setItem('ramp_on_pause', String(v)), null);
// Real gap found here, same class as playlist_sort_orders above — this is
// user-crafted data (a custom EQ preset someone built and tuned by hand)
// that can't be regenerated automatically like a song's embedded art can,
// so it's exactly the kind of thing that "resets after an update" hurts
// most. Same backup-file fallback as playlist_order/playlist_covers.
export const getCustomPresets = () => safe(async () => {
    const v = await AsyncStorage.getItem('custom_eq_presets');
    if (v) return JSON.parse(v);
    const backup = await readBackup();
    if (backup?.custom_eq_presets?.length) {
        await AsyncStorage.setItem('custom_eq_presets', JSON.stringify(backup.custom_eq_presets));
        return backup.custom_eq_presets;
    }
    return [];
}, []);
export const setCustomPresets = (p) => safe(async () => {
    await AsyncStorage.setItem('custom_eq_presets', JSON.stringify(p));
    await writeBackup({ custom_eq_presets: p });
}, null);
export const getHiddenPresets = () => safe(async () => {
    const v = await AsyncStorage.getItem('hidden_eq_presets');
    if (v) return JSON.parse(v);
    const backup = await readBackup();
    if (backup?.hidden_eq_presets?.length) {
        await AsyncStorage.setItem('hidden_eq_presets', JSON.stringify(backup.hidden_eq_presets));
        return backup.hidden_eq_presets;
    }
    return [];
}, []);
export const setHiddenPresets = (p) => safe(async () => {
    await AsyncStorage.setItem('hidden_eq_presets', JSON.stringify(p));
    await writeBackup({ hidden_eq_presets: p });
}, null);
// Per-built-in-preset band overrides — { [builtInPresetId]: bands[] } — so
// editing a built-in preset (e.g. "Bass Boost") overwrites it in place
// instead of spinning off a separate custom preset, while still being
// resettable back to the original BUILT_IN_PRESETS values (see eq.js's
// getPresetById/mergePresetsForDisplay) without deleting the preset itself.
// Same backup fallback as the two presets lists above, same reasoning.
export const getEQOverrides = () => safe(async () => {
    const v = await AsyncStorage.getItem('eq_preset_overrides');
    if (v) return JSON.parse(v);
    const backup = await readBackup();
    if (backup?.eq_preset_overrides && Object.keys(backup.eq_preset_overrides).length) {
        await AsyncStorage.setItem('eq_preset_overrides', JSON.stringify(backup.eq_preset_overrides));
        return backup.eq_preset_overrides;
    }
    return {};
}, {});
export const setEQOverrides = (o) => safe(async () => {
    await AsyncStorage.setItem('eq_preset_overrides', JSON.stringify(o));
    await writeBackup({ eq_preset_overrides: o });
}, null);
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

// The Playlists screen layout is kept in the Documents backup file too, like
// the order, covers and sorts, so it also comes back after an update.
export const getPlaylistViewFormat = () => safe(async () => {
    const v = await AsyncStorage.getItem('playlist_view_format');
    if (v) return v;
    const backup = await readBackup();
    if (backup?.playlist_view_format) {
        await AsyncStorage.setItem('playlist_view_format', backup.playlist_view_format);
        return backup.playlist_view_format;
    }
    return 'list';
}, 'list');
export const setPlaylistViewFormat = (f) => safe(async () => {
    await AsyncStorage.setItem('playlist_view_format', f);
    await writeBackup({ playlist_view_format: f });
}, null);

// Playlist covers, playlist order and per-playlist sort were all saved under
// the playlist's full file path. That path contains an app-container ID which
// iOS changes whenever the app is reinstalled or updated (and with sideloading
// it changes often), so after an update every saved cover, order and sort
// was filed under a path that no longer existed. They are now saved relative
// to the Documents folder ("doc:Name/") and turned back into the current full
// path when read. Anything saved the old way is converted on the way in, so
// existing covers, orders and sorts come back as long as the folder is still
// in Documents.
const docDir = () => FileSystem.documentDirectory || '';
export const toStablePath = (p) => {
    if (typeof p !== 'string' || p.startsWith('doc:')) return p;
    if (!p.startsWith('file:') && !p.startsWith('/')) return p;      // not a path (e.g. the All Songs key)
    const d = docDir();
    if (d && p.startsWith(d)) return 'doc:' + p.slice(d.length);
    const i = p.lastIndexOf('/Documents/');
    return i >= 0 ? 'doc:' + p.slice(i + '/Documents/'.length) : p;
};
export const fromStablePath = (p) => (typeof p === 'string' && p.startsWith('doc:') && docDir()) ? docDir() + p.slice(4) : p;
const stableMap = (map, valuesArePaths) => {
    const out = {};
    for (const [k, v] of Object.entries(map || {})) out[toStablePath(k)] = valuesArePaths ? toStablePath(v) : v;
    return out;
};
const expandMap = (map, valuesArePaths) => {
    const out = {};
    for (const [k, v] of Object.entries(map || {})) out[fromStablePath(k)] = valuesArePaths ? fromStablePath(v) : v;
    return out;
};

// Persisted playlist order — array of playlist paths, most-preferred first
export const getPlaylistOrder = () => safe(async () => {
    let raw = null;
    const v = await AsyncStorage.getItem('playlist_order');
    if (v) raw = JSON.parse(v);
    else {
        const backup = await readBackup();
        if (backup?.playlist_order?.length) {
            raw = backup.playlist_order;
            await AsyncStorage.setItem('playlist_order', JSON.stringify(raw));
        }
    }
    return (raw || []).map(p => fromStablePath(toStablePath(p)));
}, []);
export const setPlaylistOrder = (orderIn) => safe(async () => {
    const order = (orderIn || []).map(toStablePath);
    await AsyncStorage.setItem('playlist_order', JSON.stringify(order));
    await writeBackup({ playlist_order: order });
}, null);

// Custom cover image per playlist, keyed by playlist path -> local image URI
// (both saved relative to Documents, see toStablePath above).
const readCoverMap = async () => {
    const v = await AsyncStorage.getItem('playlist_covers');
    if (v) return stableMap(JSON.parse(v), true);
    const backup = await readBackup();
    if (backup?.playlist_covers && Object.keys(backup.playlist_covers).length) {
        await AsyncStorage.setItem('playlist_covers', JSON.stringify(backup.playlist_covers));
        return stableMap(backup.playlist_covers, true);
    }
    return {};
};
export const getPlaylistCovers = () => safe(async () => expandMap(await readCoverMap(), true), {});
export const setPlaylistCover = async (path, uri) => {
    if (!path) return;   // same guard: no empty-key writes
    const covers = await readCoverMap();
    const key = toStablePath(path);
    const previous = covers[key];
    if (uri) covers[key] = toStablePath(uri); else delete covers[key];
    // A replaced or removed cover picture is deleted from storage so old
    // picks do not pile up (only ever touches files in our own .covers/).
    if (previous && previous !== covers[key]) deleteStoredImage(fromStablePath(previous));
    await safe(() => AsyncStorage.setItem('playlist_covers', JSON.stringify(covers)), null);
    await writeBackup({ playlist_covers: covers });
    return expandMap(covers, true);
};

// Wipes every playlist cover picture and puts the playlists back in
// alphabetical order, and the layout back to the default list. Clears the documentDirectory backup copy too, since
// the getters would otherwise restore both from it.
export const resetPlaylistScreen = async () => {
    try {
        const covers = await getPlaylistCovers();
        for (const uri of new Set(Object.values(covers || {}))) await deleteStoredImage(uri);
    } catch { }
    await safe(() => AsyncStorage.setItem('playlist_covers', '{}'), null);
    await safe(() => AsyncStorage.setItem('playlist_order', '[]'), null);
    await safe(() => AsyncStorage.setItem('playlist_view_format', 'list'), null);
    await writeBackup({ playlist_covers: {}, playlist_order: [], playlist_view_format: 'list' });
};

// One-time (per app launch) shrink of playlist covers picked before covers
// were stored at 600px: those full-size pictures were being decoded again on
// every render of the grid. Returns true when anything changed.
let oldCoversChecked = false;
export const shrinkOldPlaylistCovers = async () => {
    if (oldCoversChecked) return false;
    oldCoversChecked = true;
    let changed = false;
    try {
        const covers = await getPlaylistCovers();
        const uses = {};
        Object.values(covers).forEach(u => { uses[u] = (uses[u] || 0) + 1; });
        for (const [path, uri] of Object.entries(covers)) {
            if (!uri || typeof uri !== 'string' || !uri.includes('/.covers/') || /_s\.jpg$/.test(uri) || uses[uri] > 1) continue;
            const small = uri.replace(/\.[^./]+$/, '') + '_s.jpg';
            try {
                if (await AudioEngine.makeThumbnail(uri, small, 600)) {
                    await setPlaylistCover(path, small); // also deletes the big original
                    changed = true;
                }
            } catch { }
        }
    } catch { }
    return changed;
};

export const getShowPlayCount = () => safe(() => AsyncStorage.getItem('show_play_count').then(v => v !== 'false'), true);
export const setShowPlayCount = (v) => safe(() => AsyncStorage.setItem('show_play_count', String(v)), null);

// Off by default — showing a cover next to every row means extracting art
// for the whole visible list (not just the currently-playing song), which
// is real, noticeable work for a big library. Opt-in rather than surprising
// someone with a slow first load.
export const getShowSongCovers = () => safe(() => AsyncStorage.getItem('show_song_covers').then(v => v !== 'false'), true);
export const setShowSongCovers = (v) => safe(() => AsyncStorage.setItem('show_song_covers', String(v)), null);

// New settings this round: independent show/hide for playlist track counts
// ("25 tracks") and playlist titles on the Playlists grid/list AND the
// playlist-detail header — both default true (matches current always-on
// behavior, so nobody's view changes just from this shipping). Plain
// conditional rendering in the screens themselves (not a fixed-height
// placeholder) is what makes the spacing "adapt smoothly" when hidden —
// nothing to add here for that part.
export const getShowPlaylistTrackCount = () => safe(() => AsyncStorage.getItem('show_playlist_track_count').then(v => v !== 'false'), true);
export const setShowPlaylistTrackCount = (v) => safe(() => AsyncStorage.setItem('show_playlist_track_count', String(v)), null);
export const getShowPlaylistTitles = () => safe(() => AsyncStorage.getItem('show_playlist_titles').then(v => v !== 'false'), true);
export const setShowPlaylistTitles = (v) => safe(() => AsyncStorage.setItem('show_playlist_titles', String(v)), null);

// Unscrollable lyrics: when on, swiping on the lyrics panel closes the
// player (same gesture as swiping anywhere else on it) instead of
// scrolling through the lyrics text. Off by default — matches current
// behavior (lyrics scroll, swipe-to-close doesn't work over them).
export const getLyricsScrollLocked = () => safe(() => AsyncStorage.getItem('lyrics_scroll_locked').then(v => v === 'true'), false);
export const setLyricsScrollLocked = (v) => safe(() => AsyncStorage.setItem('lyrics_scroll_locked', String(v)), null);

// How multiple artists on one track get displayed/reported — separate from
// artistSeparator above, which only controls what counts as a split point
// in the raw tag. This controls the join string used to put them back
// together for display, in-app AND in the metadata sent to
// MPNowPlayingInfoCenter (lock screen / Control Center / Bluetooth/CarPlay
// displays) — see utils/artists.js's formatArtists and AudioEngine.swift's
// updateNowPlayingInfo. 'comma' (", ") matches the current hardcoded
// behavior, so this defaults to it.
export const getArtistDisplayJoin = () => safe(() => AsyncStorage.getItem('artist_display_join').then(v => v ?? 'comma'), 'comma');
export const setArtistDisplayJoin = (v) => safe(() => AsyncStorage.setItem('artist_display_join', v), null);

// Splits a multi-artist tag string on a configurable separator ('none'
// disables splitting entirely — the tag displays and matches as one whole
// string, same as before this feature existed). Defaults to [';'] rather
// than ',' or '&' specifically because those two are common WITHIN a
// single real artist/band name ("Earth, Wind & Fire"), so using either as
// the default would misparse plenty of untagged-for-this libraries right
// out of the box. ';' essentially never appears inside a real artist name,
// so defaulting to it is safe even for a library that was never tagged
// with multiple artists in mind — nothing with no ';' in it is affected.
//
// Now stores a JSON array (multiple separators can be active at once —
// e.g. a library that mixes "A; B" and "C & D" style tags). Still reads a
// plain legacy string fine (anyone who set this before multi-select
// existed) by wrapping it in a single-item array rather than needing a
// one-time migration step.
export const getArtistSeparator = () => safe(() => AsyncStorage.getItem('artist_separator').then(v => {
    if (v == null) return [';'];
    try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed) ? parsed : [v];
    } catch {
        return [v]; // pre-multi-select legacy value, e.g. plain ";"
    }
}), [';']);
export const setArtistSeparator = (arr) => safe(() => AsyncStorage.setItem('artist_separator', JSON.stringify(arr)), null);

// 'off' — feature entirely disabled, no .lrc lookup ever happens (no wasted
// file I/O for anyone who doesn't want this). 'manual' — lyrics available
// via the toggle button when a song has a matching .lrc file, defaulting to
// the cover each time a new song starts. 'auto' — same, but defaults to
// showing lyrics automatically whenever the new song has them, rather than
// requiring a tap each time.
export const getLyricsMode = () => safe(() => AsyncStorage.getItem('lyrics_mode').then(v => v ?? 'manual'), 'manual');
export const setLyricsMode = (v) => safe(() => AsyncStorage.setItem('lyrics_mode', v), null);
// What the Player opens on for each song: 'cover', 'lyrics' or 'disc'.
// First read upgrades the older Show Lyrics / Auto Disc settings.
export const getAutoShow = () => safe(async () => {
    const v = await AsyncStorage.getItem('auto_show');
    if (v === 'cover' || v === 'lyrics' || v === 'disc') return v;
    const [lm, disc, auto] = await Promise.all([AsyncStorage.getItem('lyrics_mode'), AsyncStorage.getItem('dj_disc'), AsyncStorage.getItem('dj_disc_auto')]);
    const mig = lm === 'auto' ? 'lyrics' : (disc === '1' && auto === '1' ? 'disc' : 'cover');
    await AsyncStorage.setItem('auto_show', mig);
    return mig;
}, 'cover');
export const setAutoShow = (v) => safe(() => AsyncStorage.setItem('auto_show', v), null);
// Song-list visualizer: 'off', 'cover' (on the song's cover only) or 'pill' (across the whole row).
export const getVizMode = () => safe(async () => {
    const v = await AsyncStorage.getItem('viz_mode');
    return v === 'cover' || v === 'pill' ? v : 'off';
}, 'off');
export const setVizMode = (v) => safe(() => AsyncStorage.setItem('viz_mode', v), null);
// Disc spinning (idle turning) and disc touch (moving / scratching it with a
// finger) are separate switches. Both default on.
export const getDjDiscSpin = () => safe(() => AsyncStorage.getItem('dj_disc_spin').then(v => v !== 'false'), true);
export const setDjDiscSpin = (v) => safe(() => AsyncStorage.setItem('dj_disc_spin', String(v)), null);
export const getDjDiscTouch = () => safe(() => AsyncStorage.getItem('dj_disc_touch').then(v => v !== 'false'), true);
export const setDjDiscTouch = (v) => safe(() => AsyncStorage.setItem('dj_disc_touch', String(v)), null);
export const getDjDisc = () => safe(() => AsyncStorage.getItem('dj_disc').then(v => v === '1'), false);
export const setDjDisc = (v) => safe(() => AsyncStorage.setItem('dj_disc', v ? '1' : '0'), null);
export const getDjDiscAuto = () => safe(() => AsyncStorage.getItem('dj_disc_auto').then(v => v === '1'), false);
export const setDjDiscAuto = (v) => safe(() => AsyncStorage.setItem('dj_disc_auto', v ? '1' : '0'), null);
// What a new song opens on in the Player. Three separate switches replace the
// old Show Lyrics (Off / Auto-show / Manual), DJ Disc and Auto Disc settings:
// lyrics and the disc are always one tap away on the button under the cover,
// and these only say which view opens first. Anything saved under the old
// settings is carried over the first time these are read.
export const getAutoShowCover = () => safe(() => AsyncStorage.getItem('auto_show_cover').then(v => v !== 'false'), true);
export const setAutoShowCover = (v) => safe(() => AsyncStorage.setItem('auto_show_cover', String(v)), null);
export const getAutoShowLyrics = () => safe(async () => {
    const v = await AsyncStorage.getItem('auto_show_lyrics');
    if (v !== null) return v === 'true';
    return (await AsyncStorage.getItem('lyrics_mode')) === 'auto';
}, false);
export const setAutoShowLyrics = (v) => safe(() => AsyncStorage.setItem('auto_show_lyrics', String(v)), null);
export const getAutoShowDisc = () => safe(async () => {
    const v = await AsyncStorage.getItem('auto_show_disc');
    if (v !== null) return v === 'true';
    return (await AsyncStorage.getItem('dj_disc')) === '1' && (await AsyncStorage.getItem('dj_disc_auto')) === '1';
}, false);
export const setAutoShowDisc = (v) => safe(() => AsyncStorage.setItem('auto_show_disc', String(v)), null);
// How fast the DJ disc turns: a real record speed ('33' is 33 1/3 rpm).
export const DISC_RPMS = { '33': 100 / 3, '45': 45, '78': 78 };
// Vinyl record or CD for the DJ disc.
export const getDjDiscType = () => safe(() => AsyncStorage.getItem('dj_disc_type').then(v => (v === 'cd' ? 'cd' : 'vinyl')), 'vinyl');
export const setDjDiscType = (v) => safe(() => AsyncStorage.setItem('dj_disc_type', v === 'cd' ? 'cd' : 'vinyl'), null);
// Scratch speed assist: with it on, the disc clings to 0.5x, 1x and 2x.
export const getDjDiscAssist = () => safe(() => AsyncStorage.getItem('dj_disc_assist').then(v => v !== 'false'), true);
export const setDjDiscAssist = (v) => safe(() => AsyncStorage.setItem('dj_disc_assist', String(v)), null);
// Which main groups on the Settings screen are hidden (also kept in the
// Documents backup so it survives an update).
export const getHiddenGroups = () => safe(async () => {
    let v = await AsyncStorage.getItem('settings_hidden_groups');
    if (v === null) {
        const backup = await readBackup();
        if (Array.isArray(backup?.settings_hidden_groups)) { v = JSON.stringify(backup.settings_hidden_groups); await AsyncStorage.setItem('settings_hidden_groups', v); }
    }
    const arr = v ? JSON.parse(v) : [];
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
}, []);
export const setHiddenGroups = (arr) => safe(async () => {
    await AsyncStorage.setItem('settings_hidden_groups', JSON.stringify(arr));
    await writeBackup({ settings_hidden_groups: arr });
}, null);
export const getDjDiscRpm = () => safe(() => AsyncStorage.getItem('dj_disc_rpm').then(v => (v && DISC_RPMS[v] ? v : '33')), '33');
export const setDjDiscRpm = (v) => safe(() => AsyncStorage.setItem('dj_disc_rpm', v), null);
// Card-style outline around the Player cover and disc, and around the cover
// on the Playlist screen (same look as the cards on the Playlists screen).
export const getPlayerOutline = () => safe(() => AsyncStorage.getItem('player_outline').then(v => v === 'true'), false);
export const setPlayerOutline = (v) => safe(() => AsyncStorage.setItem('player_outline', String(v)), null);
export const getDetailOutline = () => safe(() => AsyncStorage.getItem('detail_outline').then(v => v === 'true'), false);
export const setDetailOutline = (v) => safe(() => AsyncStorage.setItem('detail_outline', String(v)), null);
// Shadow under the song pills (All Songs, Playlist screen and the queue).
export const getMiniPlayerShadow = () => safe(() => AsyncStorage.getItem('mini_player_shadow').then(v => v !== 'false'), true);
export const setMiniPlayerShadow = (v) => safe(() => AsyncStorage.setItem('mini_player_shadow', String(v)), null);
// Performance mode: one switch for older iPhones (no shadows, lighter lists,
// fewer background saves, no debug capture). Stored values are never changed
// by it, so turning it off brings everything back as it was.
export const getPerformanceMode = () => safe(() => AsyncStorage.getItem('performance_mode').then(v => v === 'true'), false);
export const setPerformanceMode = (v) => safe(() => AsyncStorage.setItem('performance_mode', String(v)), null);
// Use the song's own volume tag (ReplayGain) for Match Volume when it has one.
export const getUseVolumeTags = () => safe(() => AsyncStorage.getItem('use_volume_tags').then(v => v !== 'false'), true);
export const setUseVolumeTags = (v) => safe(() => AsyncStorage.setItem('use_volume_tags', String(v)), null);
// Simple or Advanced Settings screen.
export const getSettingsMode = () => safe(() => AsyncStorage.getItem('settings_mode').then(v => (v === 'advanced' ? 'advanced' : 'simple')), 'simple');
export const setSettingsMode = (v) => safe(() => AsyncStorage.setItem('settings_mode', v === 'advanced' ? 'advanced' : 'simple'), null);
// One saved "My Look" slot (a snapshot of the shadow/outline/shape settings).
export const getMyLook = () => safe(async () => {
    let v = await AsyncStorage.getItem('my_look');
    if (v === null) { const b = await readBackup(); if (b?.my_look) { v = JSON.stringify(b.my_look); await AsyncStorage.setItem('my_look', v); } }
    return v ? JSON.parse(v) : null;
}, null);
export const setMyLook = (o) => safe(async () => {
    await AsyncStorage.setItem('my_look', JSON.stringify(o));
    await writeBackup({ my_look: o });
}, null);
export const getSongPillShadow = () => safe(() => AsyncStorage.getItem('song_pill_shadow').then(v => v === 'true'), false);
export const setSongPillShadow = (v) => safe(() => AsyncStorage.setItem('song_pill_shadow', String(v)), null);
// Which of the Player's four top-right buttons are shown (all on by default).
// Only affects the Player screen; EQ and Queue stay reachable elsewhere.
export const getPlayerBtn = (name) => safe(() => AsyncStorage.getItem(`player_btn_${name}`).then(v => v !== '0'), true);
export const setPlayerBtn = (name, v) => safe(() => AsyncStorage.setItem(`player_btn_${name}`, v ? '1' : '0'), null);

// Colored top bars on the three main screens (Playlists, All Songs, Settings).
export const getTopBarColor = () => safe(() => AsyncStorage.getItem('top_bar_color').then(v => v !== 'false'), true);
export const setTopBarColor = (v) => safe(() => AsyncStorage.setItem('top_bar_color', String(v)), null);
export const getBottomBarColor = () => safe(() => AsyncStorage.getItem('bottom_bar_color').then(v => v !== 'false'), true);
export const setBottomBarColor = (v) => safe(() => AsyncStorage.setItem('bottom_bar_color', String(v)), null);
// Playlist covers have their own shape and shadow, separate from song covers
// and the Player cover.
export const getPlaylistCoverShape = () => safe(() => AsyncStorage.getItem('playlist_cover_shape').then(v => v || 'rounded'), 'rounded');
export const setPlaylistCoverShape = (v) => safe(() => AsyncStorage.setItem('playlist_cover_shape', v), null);
export const getPlaylistCoverShadow = () => safe(() => AsyncStorage.getItem('playlist_cover_shadow').then(v => v !== 'false'), true);
export const setPlaylistCoverShadow = (v) => safe(() => AsyncStorage.setItem('playlist_cover_shadow', String(v)), null);
// A card behind each playlist (all layouts), and the arrow on the bar layouts.
export const getPlaylistCards = () => safe(() => AsyncStorage.getItem('playlist_cards').then(v => v !== 'false'), true);
export const setPlaylistCards = (v) => safe(() => AsyncStorage.setItem('playlist_cards', String(v)), null);
export const getPlaylistArrow = () => safe(() => AsyncStorage.getItem('playlist_arrow').then(v => v !== 'false'), true);
export const setPlaylistArrow = (v) => safe(() => AsyncStorage.setItem('playlist_arrow', String(v)), null);
// Show or hide individual items on the Playlists, All Songs and Playlist
// screens (stored as ui_<name>, '1' / '0', default on).
export const UI_TOGGLE_NAMES = ['pl_title', 'pl_layout', 'pl_reload', 'as_title', 'as_search', 'as_sort', 'as_eq', 'as_queue', 'pd_back', 'pd_search', 'pd_eq', 'pd_queue', 'pd_cover', 'pd_play', 'pd_shuffle', 'pd_sort', 'pd_hours'];
export const getUiToggle = (name) => safe(() => AsyncStorage.getItem(`ui_${name}`).then(v => v !== '0'), true);
export const setUiToggle = (name, v) => safe(() => AsyncStorage.setItem(`ui_${name}`, v ? '1' : '0'), null);
export const getPlaybackRate = () => safe(() => AsyncStorage.getItem('playback_rate').then(v => { const n = v !== null ? parseFloat(v) : 1; return Number.isFinite(n) ? Math.max(0.25, Math.min(3, n)) : 1; }), 1);
export const setPlaybackRateStored = (v) => safe(() => AsyncStorage.setItem('playback_rate', String(v)), null);

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
// New setting: a drop shadow around the player cover, off by default.
// Works with either cover_shape (the shadow's own corner radius always
// matches whatever squircle(...) the cover itself is using — see
// PlayerScreen's coverShadowWrap style) and is simply never rendered when
// show_player_cover is off, same as the cover art itself.
export const getCoverShadow = () => safe(() => AsyncStorage.getItem('cover_shadow').then(v => v !== 'false'), true);
export const setCoverShadow = (v) => safe(() => AsyncStorage.setItem('cover_shadow', String(v)), null);

// Whole-app custom background image — off by default, and the URI is only
// meaningful once persisted locally (see persistCoverImage/the same pattern
// used for playlist covers; a raw picker URI lives in a volatile cache dir).
// Same backup-file fallback as above — a custom background image the user
// picked and cropped is exactly as un-regenerable as a custom EQ preset.
// Both the toggle and the URI are backed up together (setBackgroundImageUri
// writes both keys into the SAME backup patch call) so a restore can't land
// in the inconsistent state of "image restored but still switched off".
export const getBackgroundImageEnabled = () => safe(async () => {
    const v = await AsyncStorage.getItem('bg_image_enabled');
    if (v !== null) return v === 'true';
    const backup = await readBackup();
    if (backup && typeof backup.bg_image_enabled === 'boolean') {
        await AsyncStorage.setItem('bg_image_enabled', backup.bg_image_enabled ? 'true' : 'false');
        return backup.bg_image_enabled;
    }
    return false;
}, false);
export const setBackgroundImageEnabled = (v) => safe(async () => {
    await AsyncStorage.setItem('bg_image_enabled', v ? 'true' : 'false');
    await writeBackup({ bg_image_enabled: v });
}, null);
export const getBackgroundImageUri = () => safe(async () => {
    // Saved relative to Documents (like playlist covers) so it still points
    // at the right file after an update changes the app's container path.
    // A value saved the old way (full path) is converted when read.
    let v = await AsyncStorage.getItem('bg_image_uri');
    if (v === null) {
        const backup = await readBackup();
        if (backup?.bg_image_uri) {
            v = backup.bg_image_uri;
            await AsyncStorage.setItem('bg_image_uri', toStablePath(v));
        }
    }
    return v ? fromStablePath(toStablePath(v)) : null;
}, null);
export const setBackgroundImageUri = (v) => safe(async () => {
    const stable = v ? toStablePath(v) : null;
    if (stable) await AsyncStorage.setItem('bg_image_uri', stable); else await AsyncStorage.removeItem('bg_image_uri');
    await writeBackup({ bg_image_uri: stable });
}, null);

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
// The Previous-Track Window can be a flat number of seconds ('sec', above) or
// a percentage of the song's length ('pct'), so long songs get a longer window.
export const getRestartThresholdUnit = () => safe(() => AsyncStorage.getItem('restart_threshold_unit').then(v => (v === 'pct' ? 'pct' : 'sec')), 'sec');
export const setRestartThresholdUnit = (v) => safe(() => AsyncStorage.setItem('restart_threshold_unit', v), null);
export const getRestartThresholdPct = () => safe(() => AsyncStorage.getItem('restart_threshold_pct').then(v => v !== null ? parseFloat(v) : 5), 5);
export const setRestartThresholdPct = (v) => safe(() => AsyncStorage.setItem('restart_threshold_pct', String(v)), null);

// How long a manual scroll through the lyrics view sits idle before it
// snaps back to following the song automatically. 0 = never auto-follow
// again until the user re-enables it — wait, 0 actually means "snap back
// immediately", i.e. effectively no manual scrolling sticks at all.
export const getLyricsResyncSec = () => safe(() => AsyncStorage.getItem('lyrics_resync_sec').then(v => v !== null ? parseFloat(v) : 2), 2);
export const setLyricsResyncSec = (v) => safe(() => AsyncStorage.setItem('lyrics_resync_sec', String(v)), null);

// Shifts which line counts as "active" earlier/later relative to the
// song's real position, in seconds — some .lrc files are timed a beat off.
// Positive = lyrics shown earlier (subtracted from playback position before
// matching against the timestamps), negative = later.
export const getLyricsOffsetSec = () => safe(() => AsyncStorage.getItem('lyrics_offset_sec').then(v => v !== null ? parseFloat(v) : 0), 0);
export const setLyricsOffsetSec = (v) => safe(() => AsyncStorage.setItem('lyrics_offset_sec', String(v)), null);

// Remembers each playlist's chosen sort (A-Z / Z-A / Most Played / etc.)
// separately, persisted across app restarts.
//
// Real gap found here while chasing "playlist/song covers and sort order
// all reset after updating the app (or LiveContainer)": playlist_order and
// playlist_covers already got the documentDirectory backup-file fallback
// above (see BACKUP_PATH's own comment — added specifically because
// AsyncStorage's own persistence isn't holding up across an update/reinstall
// in this environment), but this key never got the same treatment — it was
// still pure AsyncStorage, unprotected, the whole time. If AsyncStorage
// really is what's not surviving here, this specific setting had nothing
// to fall back to while playlist order/covers already did — which fits
// "some of this resets and some doesn't" better than "everything's equally
// broken." Same backup pattern as the other two, applied here too.
const readSortMap = async () => {
    let map = {};
    const backup = await readBackup();
    if (backup?.playlist_sort_orders) map = { ...stableMap(backup.playlist_sort_orders) };
    const all = await AsyncStorage.getItem('playlist_sort_orders');
    if (all) map = { ...map, ...stableMap(JSON.parse(all)) };
    return map;
};
export const getPlaylistSort = (playlistPath) => safe(async () => {
    // Both copies are read and merged (the app's own storage wins), so a
    // sort that only made it into one of them is still found.
    let map = {};
    const backup = await readBackup();
    if (backup?.playlist_sort_orders) map = { ...stableMap(backup.playlist_sort_orders) };
    const all = await AsyncStorage.getItem('playlist_sort_orders');
    if (all) map = { ...map, ...stableMap(JSON.parse(all)) };
    return map[toStablePath(playlistPath)] ?? 'alpha';
}, 'alpha');

export const setPlaylistSort = async (playlistPath, sortId) => {
    if (!playlistPath) return;   // a screen opened without a playlist must not write under an empty key
    try {
        const all = await AsyncStorage.getItem('playlist_sort_orders');
        const backup = await readBackup();
        const map = { ...stableMap(backup?.playlist_sort_orders || {}), ...stableMap(all ? JSON.parse(all) : {}) };
        map[toStablePath(playlistPath)] = sortId;
        await AsyncStorage.setItem('playlist_sort_orders', JSON.stringify(map));
        await writeBackup({ playlist_sort_orders: map });
    } catch { }
};

// expo-image-picker's result URI lives in a CACHE directory, which iOS can
// clear at any time and which was also the likely cause of covers flashing
// on re-render (the cache file wasn't being decoded/served consistently).
// Copying it into Documents gives it a permanent, stable path.
// Deletes a picture we stored under .covers/ (and the small companion copy
// of a background, if any). Anything outside .covers/ is left alone.
export const deleteStoredImage = async (uri) => {
    try {
        if (!uri || typeof uri !== 'string' || !uri.includes('/.covers/')) return;
        // A path like ".covers/../../x" passes the check above but points elsewhere
        // (imported settings can carry any string), so only plain paths under our own folder are deleted.
        let plain = uri;
        try { plain = decodeURIComponent(uri); } catch { return; }
        if (plain.includes('..') || !uri.startsWith(FileSystem.documentDirectory + '.covers/')) return;
        await FileSystem.deleteAsync(uri, { idempotent: true });
        if (/_screen\.jpg$/.test(uri)) {
            await FileSystem.deleteAsync(uri.replace(/_screen\.jpg$/, '_lo.jpg'), { idempotent: true });
        }
    } catch { }
};

// maxPx (optional): also shrinks the stored copy so its decoded size stays
// small. Playlist covers are drawn at ~150pt, so 600px is plenty, and a
// multi-megapixel picker result was being decoded again on every render.
export const persistCoverImage = async (pickerUri, maxPx = 0) => {
    try {
        const dir = FileSystem.documentDirectory + '.covers/';
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => { });
        const ext = pickerUri.split('.').pop().split('?')[0] || 'jpg';
        const stamp = Date.now() + '_' + Math.floor(Math.random() * 10000);
        const dest = dir + 'cover_' + stamp + '.' + ext;
        await FileSystem.copyAsync({ from: pickerUri, to: dest });
        if (maxPx > 0) {
            try {
                const small = dir + 'cover_' + stamp + '_s.jpg';
                if (await AudioEngine.makeThumbnail(dest, small, maxPx)) {
                    await FileSystem.deleteAsync(dest, { idempotent: true });
                    return small;
                }
            } catch { }
        }
        return dest;
    } catch (e) {
        console.error('persistCoverImage:', e);
        return pickerUri; // fall back to the original (volatile) URI rather than losing the pick entirely
    }
};

// Keyed by title + artist + album rather than song.id (a file path): two files of the
// "same song" living in different playlists share one count, whatever their format,
// length, size or file name. The album is the one written in the file's TAGS (never the
// folder name that "Album from folder" shows), so the same title + artist on two albums
// is two songs. A song whose tags are not read yet, or that has no album tag, has no
// album part, which is also the form every older count was filed under.
const albumOf = (song) => (typeof song?.tagAlbum === 'string' ? song.tagAlbum.trim() : '');
export const baseCountKey = (song) => {
    const t = (song?.ourTitle ?? song?.title ?? '').trim().toLowerCase();
    const a = (song?.ourArtist ?? song?.artist ?? '').trim().toLowerCase();
    return `pcn:${t}::${a}`;
};
export const playCountKey = (song) => {
    const alb = albumOf(song).toLowerCase();
    return alb ? `${baseCountKey(song)}::${alb}` : baseCountKey(song);
};

// The same key with the spelling smoothed out: letters and digits only, and the artists
// split on every usual separator (; , & / | + x feat. and) and put in order. A song with
// several artists is spelled differently depending on where it came from (the file name
// says "A, B", the tags are joined with the Multiple Artists separator, the queue may hold
// an older spelling), and its count was filed under whichever spelling was playing. Every
// spelling of one song now reaches the same `pcx:` count.
const alnum = (x) => String(x ?? '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
const ARTIST_SPLIT = /\s*(?:[;,&\/|+\u00d7]|\s(?:x|feat\.?|ft\.?|featuring|and)\s)\s*/i;
const normKey = (title, artist, album) => {
    const t = alnum(title) || String(title ?? '').trim().toLowerCase();
    const a = String(artist ?? '').split(ARTIST_SPLIT).map(alnum).filter(Boolean).sort().join('|');
    const alb = alnum(album);
    return `pcx:${t}::${a}${alb ? '::' + alb : ''}`;
};
const baseCountKeyN = (song) => normKey(song?.ourTitle ?? song?.title, song?.ourArtist ?? song?.artist, '');
export const playCountKeyN = (song) => normKey(song?.ourTitle ?? song?.title, song?.ourArtist ?? song?.artist, albumOf(song));
const fileNameParts = (song) => {
    const f = song?.filename;
    if (!f) return null;
    const dot = f.lastIndexOf('.');
    const parts = (dot > 0 ? f.slice(0, dot) : f).split(' - ');
    return { t: (parts[0] || '').trim(), a: parts.length >= 2 ? parts.slice(1).join(' - ').trim() : '' };
};
// The keys a count is filed under for this song right now (exact + smoothed spelling).
const primaryKeys = (song) => [...new Set([playCountKey(song), playCountKeyN(song)])];
// Older keys without the album (and the ones from the file-name spelling): only used
// when the song has no count of its own under its album yet, so counts from before the
// album was part of the key are not lost. The first play afterwards moves them over.
const fallbackKeys = (song) => {
    const out = [baseCountKey(song), baseCountKeyN(song)];
    const f = fileNameParts(song);
    if (f) out.push(`pcn:${f.t.toLowerCase()}::${f.a.toLowerCase()}`, normKey(f.t, f.a, ''));
    return [...new Set(out)].filter(k => !primaryKeys(song).includes(k));
};

// Screens that show play counts listen here, so a count changes on screen the moment
// it is counted. They only change the number shown: the order of a list and any queue
// are left alone (see useLivePlayCounts).
const playCountListeners = new Set();
export const subscribePlayCount = (fn) => { playCountListeners.add(fn); return () => { playCountListeners.delete(fn); }; };

// A song's count is kept under its title + artist (shared by copies of the same song)
// AND under its own file (`pci:<path>`, never shared). A list reads the larger of the two,
// so a song whose title/artist spelling differs between two lists (one scanned before its
// tags were read, one after) still shows the same number everywhere.
// `libSong` is the library's own copy of the song, when known: its spelling is the one the
// lists use, so the shared count is written under that one.
export const incrementPlayCount = async (song, durationSec, libSong) => {
    if (!song) return;
    try {
        // The library's copy has the best spelling and the album tag; it is the one the
        // count is filed under (one `pcn:` key per song, which Listening Stats adds up).
        const main = libSong || song;
        const idKey = `pci:${song.id}`;
        const mine = primaryKeys(main);
        const others = libSong ? primaryKeys(song) : [];
        const fb = fallbackKeys(main);
        const keys = [...new Set([...mine, ...others, ...fb, ...fallbackKeys(song), idKey, `pc:${song.id}`])];
        const rows = await AsyncStorage.multiGet(keys);
        const val = {};
        rows.forEach(([key, v]) => { val[key] = parseInt(v) || 0; });
        const hasAlbum = !!albumOf(main);
        const ownBase = Math.max(0, ...mine.map(x => val[x] || 0), ...others.map(x => val[x] || 0), val[idKey] || 0);
        // With an album, only its own count is used once it has one; before that the older
        // album-less count (if any) is carried over.
        const migrating = hasAlbum && ownBase === 0;
        const base = migrating ? Math.max(0, ...keys.map(x => val[x] || 0)) : Math.max(ownBase, hasAlbum ? 0 : Math.max(0, ...fb.map(x => val[x] || 0)));
        const n = base + 1;
        const k = playCountKey(main);
        const writes = [[k, String(n)], [playCountKeyN(main), String(n)], [idKey, String(n)]];
        if (libSong && libSong.id !== song.id) writes.push([`pci:${libSong.id}`, String(n)]);
        await AsyncStorage.multiSet(writes);
        // The old album-less count now lives under the album: removed so Listening Stats does
        // not count it twice.
        if (migrating) { const old = fb.filter(x => val[x] > 0 && x !== k); if (old.length) await AsyncStorage.multiRemove(old); }
        // The song's length is only known to the player, never to the library, so it
        // is remembered here for the "hours" figure in Listening Stats.
        if (durationSec > 5 && durationSec < 7200) await AsyncStorage.setItem(`pdur:${k.slice(4)}`, String(Math.round(durationSec)));
        playCountCache.clear();
        // The screens match on the spelling THEY hold, so tell them under all of them.
        const notify = (key) => playCountListeners.forEach(fn => { try { fn({ key, n }); } catch { } });
        [...new Set([...mine, ...others])].forEach(notify);
    } catch { }
};

// Takes full song objects (needs title/artist to compute the shared key),
// not bare ids. Returns counts keyed by song.id for callers, but the VALUE
// is the same for every song sharing a title+artist. The first time a given
// combined key has no count yet, falls back to summing the old per-file
// ('pc:<path>') counts for every song sharing it, so history from before
// this change isn't lost.
// Remembers the last counts read, so a screen can show a count the moment it opens
// instead of waiting for storage (the Player's title used to re-wrap when it arrived).
const playCountCache = new Map();
export const peekPlayCount = (id) => playCountCache.get(id);

export const getPlayCounts = async (songs) => {
    try {
        const byKey = {};
        songs.forEach(s => { (byKey[playCountKey(s)] ??= []).push(s); });
        const prim = songs.map(primaryKeys);
        const fall = songs.map(fallbackKeys);
        const lookup = [...new Set([...prim.flat(), ...fall.flat(), ...songs.map(sg => `pci:${sg.id}`)])];
        const got = {};
        (await AsyncStorage.multiGet(lookup)).forEach(([k, v]) => { const n = parseInt(v); if (n > 0) got[k] = n; });
        const ownOf = (s, i) => Math.max(got[`pci:${s.id}`] ?? 0, ...prim[i].map(k => got[k] ?? 0));
        const fallOf = (i) => Math.max(0, ...fall[i].map(k => got[k] ?? 0));
        // A song with an album tag uses its own count; only without one is the album-less
        // (older) count read, so two albums never share a count.
        const base = songs.map((s, i) => { const own = ownOf(s, i); return own > 0 ? own : fallOf(i); });
        // Old per-file counts ('pc:<path>') from before counts were shared by title + artist:
        // only looked at for a song nothing else knows, summed over every copy of it.
        const needLegacy = Object.keys(byKey).filter(k => byKey[k].every(s => !base[songs.indexOf(s)]));
        const legacy = {};
        if (needLegacy.length) {
            const legacyKeys = needLegacy.flatMap(k => byKey[k].map(s => `pc:${s.id}`));
            (await AsyncStorage.multiGet(legacyKeys)).forEach(([k, v]) => { legacy[k] = parseInt(v) || 0; });
        }
        const out = {};
        songs.forEach((s, i) => {
            let n = base[i];
            const k = playCountKey(s);
            if (!n && needLegacy.includes(k)) n = byKey[k].reduce((sum, x) => sum + (legacy[`pc:${x.id}`] || 0), 0);
            out[s.id] = n; playCountCache.set(s.id, n);
        });
        return out;
    } catch { return {}; }
};


// ---- Pictures file: playlist covers + background picture --------------------
// The settings text only carries settings. The actual pictures live in their
// own file (SySlate-Pictures.json) that can be shared/saved and imported on
// another device. Each picture is stored once, as base64, with a list saying
// which playlist (path relative to Documents) uses which picture.
const PICTURE_EXTS = ['jpg', 'jpeg', 'png', 'webp'];
const extOf = (u) => { const e = (String(u).split('.').pop() || 'jpg').toLowerCase().split('?')[0]; return PICTURE_EXTS.includes(e) ? e : 'jpg'; };
const readB64 = (uri) => FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });

export const exportPicturesFile = async () => {
    const images = {};          // id -> { ext, data }
    const byUri = {};           // uri -> id
    const addImage = async (uri) => {
        if (!uri) return null;
        if (byUri[uri]) return byUri[uri];
        try {
            const info = await FileSystem.getInfoAsync(uri);
            if (!info.exists) return null;
            const id = 'i' + Object.keys(images).length;
            images[id] = { ext: extOf(uri), data: await readB64(uri) };
            byUri[uri] = id;
            return id;
        } catch { return null; }
    };
    const covers = {};
    const map = await getPlaylistCovers();
    for (const [path, uri] of Object.entries(map)) {
        const id = await addImage(uri);
        if (id) covers[toStablePath(path)] = id;
    }
    const bgUri = await getBackgroundImageUri();
    const bgId = await addImage(bgUri);
    const out = {
        format: 'syslate-pictures', version: 1,
        images, covers,
        background: bgId ? { id: bgId, enabled: await getBackgroundImageEnabled() } : null,
    };
    if (!Object.keys(images).length) throw new Error('No cover or background pictures to export.');
    const dest = FileSystem.cacheDirectory + 'SySlate-Pictures.json';
    await FileSystem.writeAsStringAsync(dest, JSON.stringify(out));
    return { uri: dest, covers: Object.keys(covers).length, background: !!bgId };
};

export const importPicturesFile = async (fileUri) => {
    // A pasted-in or shared file can be any size: refuse huge ones before reading
    // them into memory, and cap how many pictures one file may hold.
    const fileInfo = await FileSystem.getInfoAsync(fileUri).catch(() => null);
    if (fileInfo && fileInfo.size > 300 * 1024 * 1024) throw new Error('That file is too large to be a SySlate pictures file.');
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(fileUri));
    if (!parsed || parsed.format !== 'syslate-pictures' || !parsed.images || typeof parsed.images !== 'object' || Object.keys(parsed.images).length > 5000) throw new Error('Not a SySlate pictures file.');
    const dir = FileSystem.documentDirectory + '.covers/';
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => { });
    const stamp = Date.now();
    const written = {};         // id -> new uri
    for (const [id, img] of Object.entries(parsed.images)) {
        // The id ends up in a file name, so anything but plain letters/digits (e.g. "../") is refused.
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) continue;
        if (!img || typeof img.data !== 'string' || !PICTURE_EXTS.includes(img.ext)) continue;
        const isBg = parsed.background?.id === id;
        const dest = dir + 'cover_' + stamp + '_' + id + (isBg ? '_screen.jpg' : '_s.jpg');
        // Background keeps the "_screen.jpg" name the app expects (and gets
        // its tiny "_lo" copy back); covers keep whatever format they were.
        const realDest = isBg ? dest : dir + 'cover_' + stamp + '_' + id + '.' + img.ext;
        await FileSystem.writeAsStringAsync(realDest, img.data, { encoding: FileSystem.EncodingType.Base64 });
        written[id] = realDest;
    }
    let coverCount = 0;
    for (const [path, id] of Object.entries(parsed.covers || {})) {
        if (!written[id] || typeof path !== 'string') continue;
        await setPlaylistCover(fromStablePath(path), written[id]);
        coverCount++;
    }
    let bg = false;
    const b = parsed.background;
    if (b && written[b.id]) {
        const old = await getBackgroundImageUri();
        const uri = written[b.id];
        try { await AudioEngine.makeThumbnail(uri, uri.replace(/_screen\.jpg$/, '_lo.jpg'), 240); } catch { }
        await setBackgroundImageUri(uri);
        await setBackgroundImageEnabled(!!b.enabled);
        if (old && old !== uri) deleteStoredImage(old);
        bg = true;
    }
    return { covers: coverCount, background: bg };
};

// ---- Auto backup: the last 3 copies of all settings, kept in Documents ------
// (covers and the background are not in it, they live in their own files and
// stay in Documents anyway). A copy is made about once a day when the app
// opens, or on demand.
const autoPath = (n) => FileSystem.documentDirectory + `.syslate_autobackup_${n}.json`;
export const autoBackupNow = async () => {
    const text = await exportAllSettings();
    for (const [from, to] of [[2, 3], [1, 2]]) {
        try {
            const info = await FileSystem.getInfoAsync(autoPath(from));
            if (info.exists) { await FileSystem.deleteAsync(autoPath(to), { idempotent: true }); await FileSystem.moveAsync({ from: autoPath(from), to: autoPath(to) }); }
        } catch { }
    }
    await FileSystem.writeAsStringAsync(autoPath(1), text);
    await AsyncStorage.setItem('last_auto_backup', String(Date.now()));
};
export const autoBackupIfDue = () => safe(async () => {
    const last = parseInt(await AsyncStorage.getItem('last_auto_backup')) || 0;
    if (Date.now() - last > 20 * 3600 * 1000) await autoBackupNow();
}, null);
export const listAutoBackups = () => safe(async () => {
    const out = [];
    for (const n of [1, 2, 3]) {
        const info = await FileSystem.getInfoAsync(autoPath(n));
        if (info.exists) out.push({ n, time: (info.modificationTime || 0) * 1000 });
    }
    return out;
}, []);
export const restoreAutoBackup = async (n) => importAllSettings(await FileSystem.readAsStringAsync(autoPath(n)));

// ---- Listening stats ---------------------------------------------------------
// Everything comes from the play counts that are already kept (one per song,
// matched by title + artist). Time is an estimate: plays x song length.
// Total length of a list of songs, in seconds. The library has no song lengths of its
// own: a length is learned the first time a song is counted as played (see
// incrementPlayCount). Songs not heard yet count as the average of the known ones, and
// `estimated` says so, so the total becomes exact once every song has been played.
export const getSongsTotalLength = async (songs) => {
    const list = songs || [];
    if (!list.length) return { seconds: 0, estimated: false };
    const keys = list.map(sg => 'pdur:' + playCountKey(sg).slice(4));
    let seconds = 0, known = 0, knownSec = 0;
    try {
        const rows = await AsyncStorage.multiGet(keys);
        list.forEach((sg, i) => {
            const d = sg.duration > 0 ? sg.duration : parseFloat(rows[i] && rows[i][1]);
            if (d > 0) { knownSec += d; known++; }
        });
    } catch { }
    if (!known) return { seconds: 0, estimated: true, none: true };
    const unknown = list.length - known;
    seconds = knownSec + unknown * (knownSec / known);
    return { seconds, estimated: unknown > 0 };
};

export const getListeningStats = async (songs, separators, joinId) => {
    const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith('pcn:'));
    const counts = {};
    (await AsyncStorage.multiGet(keys)).forEach(([k, v]) => { const n = parseInt(v); if (n > 0) counts[k] = n; });
    // Song lengths remembered while playing (see incrementPlayCount).
    const durs = {};
    const durKeys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith('pdur:'));
    (await AsyncStorage.multiGet(durKeys)).forEach(([k, v]) => { const d = parseFloat(v); if (d > 0) durs['pcn:' + k.slice(5)] = d; });
    let knownSec = 0, knownPlays = 0;
    const byKey = {};
    // Counts filed before the album was part of the key have no album on them: they are matched to a
    // song by title + artist alone, until that song's next play moves them under its album.
    const byBase = {};
    for (const s of songs) { const k = playCountKey(s); if (!byKey[k]) byKey[k] = s; const bk = baseCountKey(s); if (!byBase[bk]) byBase[bk] = s; }
    let totalPlays = 0, seconds = 0, played = 0, unknownPlays = 0;
    const rows = [];
    const artists = {};
    // One song can have its count filed under more than one spelling (and an older copy of the same count
    // can still be around): such keys are one song here, and the largest count is the one used.
    const groups = {};
    for (const [k, n] of Object.entries(counts)) {
        const [gt, ga, galb] = k.slice(4).split('::');
        const gk = normKey(gt, ga, galb);
        if (!groups[gk] || n > groups[gk].n) groups[gk] = { k, n };
    }
    for (const { k, n } of Object.values(groups)) {
        const song = byKey[k] || byBase[k];
        totalPlays += n;
        const [t, a] = k.slice(4).split('::');
        const title = song ? (song.ourTitle ?? song.title) : t;
        const artist = song ? (song.ourArtist ?? song.artist) : a;
        if (song) played++;
        const dur = (song && song.duration > 0) ? song.duration : durs[k];
        if (dur > 0) { seconds += n * dur; knownSec += n * dur; knownPlays += n; }
        else unknownPlays += n;
        rows.push({ title, artist: formatArtists(artist, separators, joinId), n });
        // A song with several artists counts for each of them.
        const parts = splitArtists(artist, separators);
        for (const part of (parts.length ? parts : ['Unknown'])) {
            const id = part.toLowerCase();
            if (!artists[id]) artists[id] = { name: part, n: 0 };
            artists[id].n += n;
        }
    }
    // Songs whose length has not been seen yet count as an average song (3 min if none is known).
    seconds += unknownPlays * (knownPlays > 0 ? knownSec / knownPlays : 180);
    rows.sort((x, y) => y.n - x.n);
    const topArtists = Object.values(artists).sort((x, y) => y.n - x.n).slice(0, 5);
    return { totalPlays, hours: seconds / 3600, played, librarySize: songs.length, topSongs: rows.slice(0, 10), topArtists };
};

export const exportAllSettings = async () => {
    // crossfade_duration_eot and crossfade_duration_skip (the split-out End
    // of Track / On Skip crossfade durations) were missing from this list —
    // added. base_color_id_pre_light (which dark base to restore when
    // toggling light mode back off) was missing too — added. hide_player_cover
    // intentionally left out — it's a one-time migration source for
    // show_player_cover (see its comment in this file), nothing actively
    // writes it anymore. last_session — confirmed include it — added below.
    // Added this round: preamp_db, show_premade_settings, cover_shadow,
    // eq_preset_overrides — all four are real, currently-used settings
    // (pre-amp added round 39, Show Premade Presets round 40, the other
    // two older) that were never added here, so Export Settings silently
    // dropped them and Import Settings could never restore them.
    // Added this round: show_playlist_track_count, show_playlist_titles,
    // lyrics_scroll_locked, artist_display_join — 4 new settings, same
    // "silently dropped from export/import" risk as the note above if
    // left out.
    // Added this round: bottom_bar_color and bg_image_enabled, both are live
    // settings that were in the validation lists but missing from this list,
    // so Export Settings (and the auto-backup, which is built from this) threw
    // them away, and import could never restore them.
    const keys = ['theme_id', 'base_color_id', 'base_color_id_pre_light', 'shuffle_mode', 'shuffle_on', 'crossfade', 'crossfade_enabled', 'crossfade_duration', 'crossfade_duration_eot', 'crossfade_duration_skip', 'skip_crossfade', 'vol_norm', 'between_track_norm', 'silence_trim', 'audio_ramp', 'ramp_on_pause', 'custom_eq_presets', 'hidden_eq_presets', 'eq_preset_overrides', 'preamp_db', 'spatial_width', 'spatial_balance', 'show_premade_settings', 'show_play_count', 'show_song_covers', 'keep_priority_on_switch', 'artist_separator', 'lyrics_mode', 'lyrics_resync_sec', 'lyrics_offset_sec', 'prev_button_mode', 'restart_threshold_sec', 'album_from_folder', 'keep_screen_awake', 'cover_shape', 'cover_shadow', 'show_player_cover', 'last_session', 'show_playlist_track_count', 'show_playlist_titles', 'lyrics_scroll_locked', 'artist_display_join', 'dj_disc', 'dj_disc_auto', 'playback_rate', 'player_btn_sleep', 'player_btn_speed', 'player_btn_eq', 'player_btn_queue', 'player_btn_label', 'player_btn_back', 'top_bar_color', 'bottom_bar_color', 'bg_image_enabled', 'playlist_cover_shape', 'playlist_cover_shadow', 'playlist_cards', 'playlist_arrow', 'dj_disc_rpm', 'dj_disc_type', 'dj_disc_assist', 'dj_disc_spin', 'dj_disc_touch', 'auto_show', 'viz_mode', 'performance_mode', 'use_volume_tags', 'settings_hidden_groups', 'player_outline', 'detail_outline', 'song_pill_shadow', 'mini_player_shadow', 'restart_threshold_unit', 'restart_threshold_pct', 'settings_mode', 'my_look', ...UI_TOGGLE_NAMES.map(n => `ui_${n}`)];
    const pairs = await AsyncStorage.multiGet(keys);
    const obj = {};
    pairs.forEach(([k, v]) => { if (v !== null) obj[k] = v; });
    // Layout, playlist order and every sort (each playlist's, and All Songs')
    // are read through their getters, which also look in the Documents backup
    // file, so the export is complete even when the app's own storage lost
    // them. Paths are written relative to Documents, so they match on any
    // device that has the same folders.
    try {
        obj.playlist_view_format = await getPlaylistViewFormat();
        const order = (await getPlaylistOrder()).map(toStablePath);
        if (order.length) obj.playlist_order = JSON.stringify(order);
        const sorts = await readSortMap();
        if (Object.keys(sorts).length) obj.playlist_sort_orders = JSON.stringify(sorts);
    } catch { }
    // Play counts, so "Most Played" sorting means the same thing on the other
    // device. (Covers and the background picture are in the separate
    // pictures file, see exportPicturesFile.)
    try {
        const allKeys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith('pcn:'));
        if (allKeys.length) {
            const counts = {};
            (await AsyncStorage.multiGet(allKeys)).forEach(([k, v]) => { const n = parseInt(v); if (n > 0) counts[k] = n; });
            if (Object.keys(counts).length) obj.play_counts = JSON.stringify(counts);
        }
    } catch { }
    return JSON.stringify(obj, null, 2);
};

export const importAllSettings = async (jsonString) => {
    // Real bug found here (general audit item — "Import Settings accepting
    // out-of-range or wrong-increment numbers, and any other similar
    // input-validation gaps"): this took ANY parsed JSON object and blindly
    // multiSet every key/value into AsyncStorage verbatim — no allowlist
    // (an imported blob could write arbitrary keys, not just the ones
    // exportAllSettings actually produces), no type checking, no range
    // checking. A bad paste — hand-edited, corrupted, or from a future
    // export version with a different shape — could silently plant a
    // crossfade duration of -50 or "banana", EQ bands outside -12..12, or
    // (worst case) a malformed last_session that AsyncStorage happily
    // stores as-is and only blows up later, on the NEXT cold launch, when
    // restoreSession JSON.parses it — i.e. genuinely bricking the app's
    // startup from a settings import days earlier, nowhere near where the
    // actual mistake was made.
    //
    // Each key is now validated against what its own getter/slider in this
    // file and SettingsScreen.js actually expects before being allowed
    // through; anything that fails validation for a given key is just
    // skipped (that one setting silently keeps its current value) rather
    // than either crashing the whole import or writing something that'll
    // crash later. Only keys from the same allowlist exportAllSettings
    // produces are ever considered — nothing else gets written.
    if (typeof jsonString !== 'string' || jsonString.length > 20 * 1024 * 1024) throw new Error('Not a settings file');
    const obj = JSON.parse(jsonString);
    if (!obj || typeof obj !== 'object') throw new Error('Not a settings object');

    const ONE_ZERO_KEYS = new Set(['dj_disc', 'dj_disc_auto', 'player_btn_sleep', 'player_btn_speed', 'player_btn_eq', 'player_btn_queue', 'player_btn_label', 'player_btn_back', ...UI_TOGGLE_NAMES.map(n => `ui_${n}`)]);
    const BOOL_KEYS = new Set([
        'crossfade_enabled', 'vol_norm', 'between_track_norm', 'silence_trim',
        'ramp_on_pause', 'show_play_count', 'show_song_covers',
        'keep_priority_on_switch', 'album_from_folder', 'keep_screen_awake',
        'show_player_cover', 'bg_image_enabled',
        'show_premade_settings', 'cover_shadow',
        'show_playlist_track_count', 'show_playlist_titles', 'lyrics_scroll_locked',
        'top_bar_color', 'bottom_bar_color', 'playlist_cover_shadow', 'playlist_cards', 'playlist_arrow',
        'player_outline', 'detail_outline', 'song_pill_shadow', 'mini_player_shadow', 'dj_disc_assist', 'dj_disc_spin', 'dj_disc_touch', 'performance_mode', 'use_volume_tags',
    ]);
    // [min, max] — matches each setting's own slider bounds in
    // SettingsScreen.js (see e.g. the Crossfade Duration / Audio Ramp /
    // Lyrics Resync / Restart Threshold sliders). Sliders step in 0.5s
    // (1s for restart_threshold) but a stored value doesn't strictly need
    // to land exactly on a step — importing 6 vs 6.0 vs 6.00 are all the
    // same real value — so this checks range, not increment, which is
    // what actually matters for anything downstream reading the number.
    const NUMERIC_RANGES = {
        crossfade: [0, 6], crossfade_duration_eot: [0, 6],
        skip_crossfade: [0, 6], crossfade_duration: [0, 6], crossfade_duration_skip: [0, 6],
        audio_ramp: [0, 6],
        lyrics_resync_sec: [0, 6], lyrics_offset_sec: [-3, 3],
        restart_threshold_sec: [0, 24],
        restart_threshold_pct: [0, 50],
        preamp_db: [-12, 12],
        spatial_width: [0, 200], spatial_balance: [-100, 100],
        playback_rate: [0.25, 3],
    };
    // Keys whose value is a JSON-encoded array of strings.
    const JSON_ARRAY_KEYS = new Set(['hidden_eq_presets', 'playlist_order', 'settings_hidden_groups']);
    // (playlist_covers and bg_image_uri are NOT accepted here: a settings file could point them at any
    // file or web address. Pictures only come in through importPicturesFile, which writes its own copies.)
    // The playlist sort ids the two sort menus actually offer (see SORTS in
    // AllSongsScreen.js / PlaylistDetailScreen.js). An imported sort that isn't
    // one of these would just read back as 'alpha' at the other end, so there's
    // nothing to gain by writing it through.
    const SORT_IDS = new Set(['alpha', 'alpha_r', 'plays', 'plays_r']);
    // Plain string settings (enum-like ids, URIs) — no fixed enum list
    // enforced here (a future app version could legitimately add new
    // theme/cover-shape ids that this exact import code doesn't know about
    // yet), just a sane length cap so a giant garbage string can't get
    // written into, say, a theme id.
    const STRING_KEYS = new Set([
        'theme_id', 'base_color_id', 'base_color_id_pre_light', 'shuffle_mode',
        'playlist_view_format', 'lyrics_mode',
        'prev_button_mode', 'restart_threshold_unit', 'cover_shape', 'playlist_cover_shape',
        'artist_display_join', 'dj_disc_rpm', 'dj_disc_type', 'auto_show', 'viz_mode', 'settings_mode',
    ]);
    // EQ band range — imported from eq.js (EQ_MIN/EQ_MAX) so this can
    // never drift from what the sliders/native side actually support.
    // Also the actual reason custom_eq_presets needed its own validator
    // instead of the generic "is it an array" check the JSON_ARRAY_KEYS
    // branch does for everything else: a preset with a band value outside
    // that range would get silently clamped somewhere downstream in a way
    // that doesn't necessarily match what the user thought they were
    // importing.
    const isValidEqPresets = (parsed) => Array.isArray(parsed) && parsed.every(p =>
        p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string' &&
        Array.isArray(p.bands) && p.bands.every(b => typeof b === 'number' && Number.isFinite(b) && b >= EQ_MIN && b <= EQ_MAX)
    );

    const toWrite = [];
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value !== 'string') continue; // AsyncStorage values are always strings; anything else was never legitimately exported
        if (key === 'shuffle_on') {
            if (value === 'true' || value === 'false') toWrite.push([key, value]);
        } else if (BOOL_KEYS.has(key)) {
            if (value === 'true' || value === 'false') toWrite.push([key, value]);
        } else if (ONE_ZERO_KEYS.has(key)) {
            // Saved as 1 / 0 (not true / false). dj_disc and dj_disc_auto were
            // missing here, so restoring a backup silently dropped them.
            if (value === '1' || value === '0') toWrite.push([key, value]);
        } else if (Object.prototype.hasOwnProperty.call(NUMERIC_RANGES, key)) {
            const [min, max] = NUMERIC_RANGES[key];
            const n = parseFloat(value);
            if (Number.isFinite(n) && n >= min && n <= max) toWrite.push([key, String(n)]);
        } else if (key === 'custom_eq_presets') {
            try { if (isValidEqPresets(JSON.parse(value))) toWrite.push([key, value]); } catch { }
        } else if (key === 'artist_separator') {
            // Now an array (Multiple Artists supports selecting more than
            // one separator at once) — accepts a legacy plain-string value
            // too (anything exported before multi-select existed) by
            // wrapping it, same as getArtistSeparator's own read path does.
            try {
                const parsed = JSON.parse(value);
                const arr = Array.isArray(parsed) ? parsed : [value];
                if (arr.every(sep => typeof sep === 'string' && sep.length <= 20)) toWrite.push([key, JSON.stringify(arr)]);
            } catch {
                if (value.length <= 20) toWrite.push([key, JSON.stringify([value])]);
            }
        } else if (JSON_ARRAY_KEYS.has(key)) {
            // Arrays of plain strings (hidden preset ids, playlist paths,
            // hidden settings groups). Capped in entry count and entry length
            // so a hand-edited file can't write a huge string in as an "id".
            try { const arr = JSON.parse(value); if (Array.isArray(arr) && arr.length <= 5000 && arr.every(x => typeof x === 'string' && x.length <= 500)) toWrite.push([key, value]); } catch { }
        } else if (key === 'eq_preset_overrides') {
            // { [builtInPresetId]: bands[] } — see getPresetById /
            // mergePresetsForDisplay in eq.js. These bands are handed straight
            // to the native EQ unit as "the gains for this preset", so a band
            // that isn't a number or sits outside what the sliders support
            // isn't something to write through and hope for the best — same
            // shape check custom_eq_presets already gets. Out-of-range bands
            // are clamped rather than rejected, which is what every other
            // write path in the app does with a band value too.
            try {
                const parsed = JSON.parse(value);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    const out = {};
                    for (const [id, bands] of Object.entries(parsed)) {
                        if (typeof id !== 'string' || !id || id.length > 100) continue;
                        if (!Array.isArray(bands) || bands.length !== BAND_COUNT || !bands.every(b => typeof b === 'number' && Number.isFinite(b))) continue;
                        out[id] = bands.map(clampEQBand);
                    }
                    if (Object.keys(out).length) toWrite.push([key, JSON.stringify(out)]);
                }
            } catch { }
        } else if (key === 'playlist_sort_orders') {
            // { stablePlaylistPath: sortId } — only the ids the sort menus
            // actually offer (see SORT_IDS above); anything else would read
            // back as 'alpha' anyway, so keeping it out is the same outcome
            // without writing a value nothing understands.
            try {
                const parsed = JSON.parse(value);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    const out = {};
                    for (const [p, sort] of Object.entries(parsed)) {
                        if (typeof p === 'string' && p.length <= 500 && SORT_IDS.has(sort)) out[p] = sort;
                    }
                    if (Object.keys(out).length) toWrite.push([key, JSON.stringify(out)]);
                }
            } catch { }
        } else if (key === 'my_look') {
            // A stored look/preset blob, read back as a whole. Only its size is
            // checked (nothing in the app reads it at the moment, so there is
            // no shape worth being strict about — just a ceiling on how big a
            // single imported value is allowed to be).
            try {
                const parsed = JSON.parse(value);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && value.length <= 20000) toWrite.push([key, value]);
            } catch { }
        } else if (key === 'play_counts') {
            // Merged with this device's own counts (the higher number wins),
            // never lowering anything.
            try {
                const parsed = JSON.parse(value);
                const entries = Object.entries(parsed || {}).filter(([k, n]) => k.startsWith('pcn:') && Number.isInteger(n) && n > 0 && n < 1e7).slice(0, 20000);
                if (entries.length) {
                    const have = Object.fromEntries(await AsyncStorage.multiGet(entries.map(([k]) => k)));
                    entries.forEach(([k, n]) => { if (n > (parseInt(have[k]) || 0)) toWrite.push([k, String(n)]); });
                }
            } catch { }
        } else if (key === 'last_session') {
            // Most safety-critical one to get wrong — restoreSession reads
            // this on every cold launch. Requires the fields it actually
            // dereferences (playlist.path, playlist.queue as an array, index
            // as a number inside that array) to exist and be the right shape
            // before allowing it through at all, and every queue entry to be a
            // real track object with a string id: a queue of nulls or strings
            // would survive the old check and then sit there until the next
            // cold launch, where it would throw inside restoreSession. Anything
            // that fails is dropped rather than risking that.
            try {
                const parsed = JSON.parse(value);
                const queue = parsed?.playlist?.queue;
                if (parsed && parsed.playlist && typeof parsed.playlist.path === 'string' && parsed.playlist.path.length <= 5000
                    && Array.isArray(queue) && queue.length >= 1 && queue.length <= 20000
                    && Number.isInteger(parsed.index) && parsed.index >= 0 && parsed.index < queue.length
                    && queue.every(t => t && typeof t === 'object' && !Array.isArray(t) && typeof t.id === 'string' && t.id.length <= 2000)
                    && (parsed.priorityCount === undefined || (Number.isInteger(parsed.priorityCount) && parsed.priorityCount >= 0 && parsed.priorityCount <= queue.length))
                    && (parsed.position === undefined || (Number.isFinite(parsed.position) && parsed.position >= 0))) {
                    toWrite.push([key, value]);
                }
            } catch { }
        } else if (STRING_KEYS.has(key)) {
            if (value.length <= 500) toWrite.push([key, value]);
        }
        // Any key not recognized above (not in the allowlist at all, e.g.
        // hide_player_cover or something exportAllSettings never produces)
        // is silently dropped, not written.
    }
    if (toWrite.length) await AsyncStorage.multiSet(toWrite);

    // A handful of these keys are also mirrored into the small JSON file in
    // Documents (see writeBackup / BACKUP_PATH above) — that file is the
    // fallback their getters use when AsyncStorage comes back empty after an
    // app update, which is the exact situation it exists for. Importing
    // settings wrote straight to AsyncStorage and left that file holding
    // whatever was there before, so the fallback path could later restore the
    // PRE-import values and quietly undo the import. Mirror whatever was
    // actually accepted, in the same shape writeBackup stores.
    const BACKUP_MIRRORED = {
        custom_eq_presets: JSON.parse, hidden_eq_presets: JSON.parse,
        eq_preset_overrides: JSON.parse, playlist_sort_orders: JSON.parse,
        playlist_order: JSON.parse, settings_hidden_groups: JSON.parse,
        my_look: JSON.parse,
        playlist_view_format: (v) => v,
        bg_image_enabled: (v) => v === 'true',
    };
    const patch = {};
    for (const [k, v] of toWrite) {
        const convert = BACKUP_MIRRORED[k];
        if (!convert) continue;
        try { patch[k] = convert(v); } catch { }
    }
    if (Object.keys(patch).length) await writeBackup(patch);
};