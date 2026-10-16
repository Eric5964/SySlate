import React, { useState, useEffect, useRef, useMemo, useContext } from 'react';
import {
    View, Text, StyleSheet, ScrollView, Switch,
    TouchableOpacity, StatusBar, TextInput,
    Share, Alert, KeyboardAvoidingView, Platform, Dimensions,
} from 'react-native';
import { useScrollToTop } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';
import BottomSheet from '../components/BottomSheet';
import AudioEngine from '../native/AudioEngine';
import { useLibrary } from '../context/LibraryContext';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme, THEMES, BASE_COLORS } from '../context/ThemeContext';
import { usePreferences } from '../context/PreferencesContext';
import { squircle } from '../utils/squircle';
import { MODE_PARTS, modeId } from '../utils/shuffle';
import PureSlider from '../components/PureSlider';
import ScreenBackground from '../components/ScreenBackground';
import TopBarBack from '../components/TopBarFade';
import { noteScroll } from '../utils/scrollGuard';
import { TOP_PAD, TOP_FADE, OVERLAY_HEADER, useMeasuredHeight } from '../utils/layout';
import { BUILT_IN_PRESETS, BAND_HZ, BAND_COUNT, mergePresetsForDisplay, EQ_MIN, EQ_MAX } from '../utils/eq';
import { applyEQPreset } from '../context/PlaybackContext';

// 'none' turns off multi-artist splitting entirely (see getArtistSeparator
// in storage.js for the default-';' reasoning).
const ARTIST_SEPARATORS = [
    { id: ';', label: ';' },
    { id: ',', label: ',' },
    { id: '/', label: '/' },
    // Two literal backslashes, not one — that's what Mp3tag and MusicBee
    // actually write for multi-artist tags ("Artist A\\Artist B"), a
    // single '\' isn't a real-world convention either of those uses.
    { id: '\\\\', label: '\\' },
    { id: '&', label: '&' },
    { id: 'none', label: 'None' },
];

// Real record speeds for the DJ disc ('33' is 33 1/3 rpm).
const DISC_RPM_OPTIONS = [
    { id: '33', label: '33\u2153 RPM' },
    { id: '45', label: '45 RPM' },
    { id: '78', label: '78 RPM' },
];
// See getPrevButtonMode in storage.js — 'previous_track' is the simple,
// always-the-same behavior; 'restart_or_previous' is the conventional
// streaming-app behavior (restart if you're into the song, go back if
// you're near the start of it), with its own threshold slider shown below
// only when it's selected.
const PREV_BUTTON_MODES = [
    { id: 'previous_track', label: 'Always Previous Track' },
    { id: 'restart_or_previous', label: 'Restart, Then Previous' },
];
import {
    getEndOfTrackRamp, setEndOfTrackRamp,
    getSkipRamp, setSkipRamp,
    getShowPremadeInSettings, setShowPremadeInSettings,
    getAudioRamp, setAudioRamp,
    getRampOnPause, setRampOnPause,
    getCustomPresets, setCustomPresets,
    getHiddenPresets, setHiddenPresets,
    getEQOverrides, setEQOverrides,
    getShuffleMode,
    getKeepPriorityOnPlaylistSwitch, setKeepPriorityOnPlaylistSwitch,
    getPrevButtonMode, setPrevButtonMode,
    getRestartThresholdUnit, setRestartThresholdUnit, getRestartThresholdPct, setRestartThresholdPct,
    getRestartThresholdSec, setRestartThresholdSec,
    getAlbumFromFolder, setAlbumFromFolder,
    exportAllSettings, importAllSettings,
    exportPicturesFile, importPicturesFile, getHiddenGroups, setHiddenGroups,
    getSettingsMode, setSettingsMode, autoBackupNow, listAutoBackups, restoreAutoBackup, getBackgroundImageUri, getBackgroundImageEnabled,
    persistCoverImage,
    deleteStoredImage,
    resetPlaylistScreen,
} from '../utils/storage';
import { importSongs } from '../utils/importMusic';
import * as ImagePicker from 'expo-image-picker';

const SCREEN_W = Dimensions.get('window').width;
const SWATCH_GAP = 12;
// Fills the row edge-to-edge (space-between) instead of a smaller centered
// cluster with empty margin on the sides — matches the EQ preset grid's
// full-width feel.
const SWATCH_SIZE = Math.floor((SCREEN_W - 32 - SWATCH_GAP * 4) / 5);
const BASE_SWATCH_SIZE = Math.floor((SCREEN_W - 32 - SWATCH_GAP * 4) / 5);

export default function SettingsScreen() {
    const navigation = useNavigation();
    const { changeShuffleMode, eqPresetId } = usePlayback();
    const { reload, scanPath, scanError } = useLibrary();
    const { themeId, setTheme, theme, baseId, setBase, base, isLight, toggleLightMode } = useTheme();
    const s = useMemo(() => makeStyles(base), [base]);
    const scrollRef = useRef(null);
    useScrollToTop(scrollRef);

    const [eotRamp, setEotRampState] = useState(3.0);
    const [skipRamp, setSkipRampState] = useState(0.5);
    const [ramp, setRamp] = useState(2);
    const [rampPause, setRampPause] = useState(false);
    const [customPresets, setCP] = useState([]);
    const [hiddenPresets, setHP] = useState([]);
    const [eqOverrides, setEO] = useState({});
    // Real UX confusion found here (direct feedback: "eq presets are a bit
    // confusing... it should be 'manage presets' so you can enable/disable
    // the presets, not touching your personal shit"): this single grid
    // did enable/disable AND rename/edit-bands AND delete all at once, and
    // unchecking a preset made it vanish from THIS view immediately unless
    // you separately toggled "Manage Disabled" back on — a jarring
    // disappear-on-tap that's exactly what "without them disappearing"
    // was asking to stop. This main grid always shows every preset
    // (built-in + custom, nothing hidden from it) and still handles
    // edit/delete for your own custom ones; each chip's own checkbox is
    // still the fine-grained per-preset hide/show. The separate "Manage
    // Presets" sheet that used to sit below this — a plain duplicate of
    // that same per-chip checkbox, just as a list instead of a grid — is
    // gone now, replaced by the "Show Premade Presets" switch next to
    // "+ Add Custom Preset": a bulk on/off for every built-in at once
    // (Flat excluded, always shown), which the per-chip checkbox alone
    // couldn't do without tapping through all of them one at a time.

    const [showNewEQ, setShowNewEQ] = useState(false);
    // null editingId = creating a brand new custom preset. Non-null +
    // editingIsBuiltIn = editing/overwriting a built-in (via eqOverrides).
    // Non-null + !editingIsBuiltIn = editing an existing custom preset in place.
    const [editingId, setEditingId] = useState(null);
    const [editingIsBuiltIn, setEditingIsBuiltIn] = useState(false);
    const [newName, setNewName] = useState('');
    const [newBands, setNewBands] = useState(new Array(BAND_COUNT).fill(0));
    // Always the full set now, regardless of hidden state — see the
    // comment above for why (this grid is the editor, not the picker;
    // EQModal.js's picker is what actually respects hiddenPresets).
    const displayPresets = useMemo(() => mergePresetsForDisplay(customPresets, eqOverrides), [customPresets, eqOverrides]);
    const [showImport, setShowImport] = useState(false);
    const [importText, setImportText] = useState('');
    const { showPlayCount, setShowPlayCount, showSongCovers, setShowSongCovers, artistSeparator, setArtistSeparator, lyricsOn, setLyricsOn, djDisc, setDjDisc, autoShow, setAutoShow, djDiscSpin, setDjDiscSpin, djDiscTouch, setDjDiscTouch, miniPlayerShadow, setMiniPlayerShadow, performanceMode, setPerformanceMode, useVolumeTags, setUseVolumeTags, shadowsRaw, djDiscRpm, setDjDiscRpm, djDiscType, setDjDiscType, djDiscAssist, setDjDiscAssist, playerOutline, setPlayerOutline, detailOutline, setDetailOutline, songPillShadow, setSongPillShadow, playerBtns, setPlayerBtnShown, lyricsResyncSec, setLyricsResyncSec, lyricsOffsetSec, setLyricsOffsetSec, keepScreenAwake, setKeepScreenAwake, coverShape, setCoverShape, showPlayerCover, setShowPlayerCover, coverShadow, setCoverShadow, backgroundImageEnabled, setBackgroundImageEnabled, backgroundImageUri, setBackgroundImageUri, crossfadeEnabled, setCrossfadeEnabled, crossfadeDuration, setCrossfadeDuration, crossfadeDurationEndOfTrack, setCrossfadeDurationEndOfTrack, withinTrackNorm, setWithinTrackNorm, betweenTrackNorm, setBetweenTrackNorm, silenceTrim, setSilenceTrim, preAmp, setPreAmp, showPlaylistTrackCount, setShowPlaylistTrackCount, showPlaylistTitles, setShowPlaylistTitles, lyricsScrollLocked, setLyricsScrollLocked, artistDisplayJoin, setArtistDisplayJoin, topBarColor, setTopBarColor, playlistCoverShape, setPlaylistCoverShape, playlistCoverShadow, setPlaylistCoverShadow, playlistCards, setPlaylistCards, playlistArrow, setPlaylistArrow, ui, setUiShown } = usePreferences();
    const [hdrH, onHdrLayout] = useMeasuredHeight(TOP_PAD + 48 + TOP_FADE);

    const [loaded, setLoaded] = useState(false);
    // Separate from `shuffleMode` (from usePlayback) on purpose — that one
    // reflects LIVE playback state and is legitimately 'off' whenever
    // nothing's actively shuffling, which doesn't match any of the 3 radio
    // options below and left the whole section showing nothing selected.
    // This tracks the persisted TYPE preference instead, which stays one of
    // the 3 real types regardless of whether shuffle happens to be on right
    // now — shuffle_mode in storage is only ever written as one of those,
    // never 'off' (only the live state uses 'off').
    const [shuffleTypePref, setShuffleTypePref] = useState('full_cycle');
    const [keepPriority, setKeepPriority] = useState(true);
    const [albumFromFolder, setAlbumFromFolderState] = useState(false);
    // Simple or Advanced view (kept saved) and the search box.
    const [mode, setModeState] = useState('simple');
    useEffect(() => { getSettingsMode().then(setModeState); }, []);
    const changeMode = (m) => { setModeState(m); setSettingsMode(m); };
    const [query, setQuery] = useState('');
    const q = query.trim().toLowerCase();
    // Main groups the user has hidden (kept saved).
    const [hiddenGroups, setHiddenGroupsState] = useState([]);
    useEffect(() => { getHiddenGroups().then(setHiddenGroupsState); }, []);
    const isHidden = (k) => !q && mode === 'advanced' && hiddenGroups.includes(k);
    const toggleGroupHidden = (k) => {
        const next = hiddenGroups.includes(k) ? hiddenGroups.filter(x => x !== k) : [...hiddenGroups, k];
        setHiddenGroupsState(next); setHiddenGroups(next);
    };
    const [prevButtonMode, setPrevButtonModeState] = useState('previous_track');
    const [restartThreshold, setRestartThresholdState] = useState(3);
    const [restartUnit, setRestartUnitState] = useState('sec');
    const [restartPct, setRestartPctState] = useState(5);
    // Local mirrors for live drag feedback — lyricsResyncSec/lyricsOffsetSec
    // themselves live in PreferencesContext (PlayerScreen needs them too),
    // but PureSlider needs onValueChange to update something on every drag
    // tick, not just onSlidingComplete on release. Using the context setter
    // directly for onValueChange would work visually but fire an
    // AsyncStorage write on every pixel of drag movement instead of once on
    // release — mirroring locally and only persisting via onSlidingComplete
    // avoids that. Resynced from context whenever it changes, so this still
    // picks up the real value once PreferencesContext's own async load
    // resolves, not just whatever it was at this component's mount.
    const [lyricsResyncLocal, setLyricsResyncLocal] = useState(lyricsResyncSec);
    useEffect(() => { setLyricsResyncLocal(lyricsResyncSec); }, [lyricsResyncSec]);
    const [lyricsOffsetLocal, setLyricsOffsetLocal] = useState(lyricsOffsetSec);
    useEffect(() => { setLyricsOffsetLocal(lyricsOffsetSec); }, [lyricsOffsetSec]);
    // Crossfade Duration was the one slider in this screen calling the real
    // (persisting + native-bridge) setter directly from onValueChange,
    // instead of mirroring locally like every other slider here and only
    // committing on release — meaning every tick of the drag wrote to
    // AsyncStorage and crossed the native bridge, not just the one value on
    // release. Same local-mirror pattern as lyricsResyncLocal/lyricsOffsetLocal above.
    const [crossfadeDurationLocal, setCrossfadeDurationLocal] = useState(crossfadeDuration);
    const [preAmpLocal, setPreAmpLocal] = useState(preAmp);
    // Real bug found here — this is "pre-amp doesn't stay between
    // sessions": preAmpLocal only ever took preAmp's value at this
    // component's FIRST render (useState(preAmp) only reads it once).
    // preAmp itself gets correctly restored from storage in
    // PreferencesContext — but that restore resolves asynchronously,
    // after this screen has almost certainly already mounted and already
    // captured preAmp as its still-default 0. Nothing ever re-synced
    // preAmpLocal once the real value arrived, so the slider (and the dB
    // label, since both read preAmpLocal) sat at 0 regardless of what was
    // actually persisted and actually applied to native — the setting
    // itself was fine the whole time, just never reflected here unless
    // you happened to drag the slider yourself.
    useEffect(() => { setPreAmpLocal(preAmp); }, [preAmp]);
    useEffect(() => { setCrossfadeDurationLocal(crossfadeDuration); }, [crossfadeDuration]);
    // Same local-mirror pattern, now for the split-out End of Track
    // crossfade duration (was one shared "Crossfade Duration" slider —
    // split to match the Audio Ramp section's On Skip / End of Track
    // granularity just below it).
    const [showPremadeInSettings, setShowPremadeInSettingsState] = useState(true);
    const [crossfadeDurationEotLocal, setCrossfadeDurationEotLocal] = useState(crossfadeDurationEndOfTrack);
    useEffect(() => { setCrossfadeDurationEotLocal(crossfadeDurationEndOfTrack); }, [crossfadeDurationEndOfTrack]);

    useEffect(() => {
        (async () => {
            setEotRampState(await getEndOfTrackRamp());
            setSkipRampState(await getSkipRamp());
            setShowPremadeInSettingsState(await getShowPremadeInSettings());
            setRamp(await getAudioRamp());
            setRampPause(await getRampOnPause());
            setCP(await getCustomPresets());
            setHP(await getHiddenPresets());
            setEO(await getEQOverrides());
            setShuffleTypePref(await getShuffleMode());
            setKeepPriority(await getKeepPriorityOnPlaylistSwitch());
            setAlbumFromFolderState(await getAlbumFromFolder());
            setPrevButtonModeState(await getPrevButtonMode());
            setRestartUnitState(await getRestartThresholdUnit());
            setRestartPctState(await getRestartThresholdPct());
            setRestartThresholdState(await getRestartThresholdSec());
            setLoaded(true);
        })();
    }, []);

    const togglePresetVisible = async (id) => {
        const wasHidden = hiddenPresets.includes(id);
        const next = wasHidden
            ? hiddenPresets.filter(x => x !== id)
            : [...hiddenPresets, id];
        setHP(next); await setHiddenPresets(next);
        // Re-enabling a built-in that had been customized resets it back to
        // its original bundled bands — "if disabled and reenabled, they are
        // reset to their original settings." Disabling doesn't touch the
        // override (nothing to reset yet, and toggling off and back on
        // without ever actually re-enabling shouldn't lose anything).
        if (wasHidden && eqOverrides[id]) {
            const nextOverrides = { ...eqOverrides };
            delete nextOverrides[id];
            setEO(nextOverrides); await setEQOverrides(nextOverrides);
            if (eqPresetId === id) applyEQPreset(id);
        }
    };

    // Replaces the old "Manage Presets" sheet, which was a plain duplicate
    // of the checkbox already on every preset chip in the grid below. This
    // is a Settings-screen-only declutter switch (per direct correction:
    // "I wanted 'show premade presets' to be showing them in the settings,
    // not just enabling them") — it hides built-in preset chips from THIS
    // grid entirely, separate from hiddenPresets (which still independently
    // governs the EQModal picker via each chip's own checkbox, unaffected
    // by this switch). Flat is deliberately excluded from builtInIds so it
    // can never be hidden by this switch — it's the one preset always
    // guaranteed to be there, in the grid or the picker either way.
    const togglePremadeInSettings = (v) => {
        setShowPremadeInSettingsState(v);
        setShowPremadeInSettings(v);
    };
    const visiblePresets = useMemo(
        () => showPremadeInSettings ? displayPresets : displayPresets.filter(p => p.isBuiltIn ? p.id === 'flat' : true),
        [displayPresets, showPremadeInSettings]
    );

    // Built-ins can only be hidden (above), never actually removed from the
    // list — they're baked into BUILT_IN_PRESETS. This is for custom
    // (user-created) presets only.
    const deleteCustomPreset = async (id) => {
        const next = customPresets.filter(p => p.id !== id);
        setCP(next); await setCustomPresets(next);
    };

    const confirmDeleteCustomPreset = (preset) => {
        Alert.alert(
            'Delete EQ Preset',
            `Delete "${preset.name}"? This can't be undone.`,
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: () => deleteCustomPreset(preset.id) },
            ]
        );
    };

    // The editor's contents (title, name, sliders) used to be wiped the
    // instant Close was pressed, so during the ~200ms slide-down the sheet
    // visibly turned into a blank "New EQ Preset" with flat sliders. Now the
    // sheet hides first and the contents are only cleared once it has fully
    // left the screen. A timer ref lets a quick reopen cancel the pending
    // clear so it can never wipe a sheet that just opened.
    const eqClearTimerRef = useRef(null);
    const closeEQSheet = () => {
        setShowNewEQ(false);
        if (eqClearTimerRef.current) clearTimeout(eqClearTimerRef.current);
        eqClearTimerRef.current = setTimeout(() => {
            eqClearTimerRef.current = null;
            setEditingId(null);
            setEditingIsBuiltIn(false);
            setNewName('');
            setNewBands(new Array(BAND_COUNT).fill(0));
        }, 380);
    };
    useEffect(() => () => { if (eqClearTimerRef.current) clearTimeout(eqClearTimerRef.current); }, []);

    const openNewPresetSheet = () => {
        if (eqClearTimerRef.current) { clearTimeout(eqClearTimerRef.current); eqClearTimerRef.current = null; }
        setEditingId(null);
        setEditingIsBuiltIn(false);
        setNewName('');
        setNewBands(new Array(BAND_COUNT).fill(0));
        setShowNewEQ(true);
    };

    // Tapping any preset row (built-in or custom) opens the same
    // band-by-band editor, pre-filled with that preset's current bands
    // (its override, if it has one).
    const openEditPresetSheet = (preset) => {
        if (eqClearTimerRef.current) { clearTimeout(eqClearTimerRef.current); eqClearTimerRef.current = null; }
        setEditingId(preset.id);
        setEditingIsBuiltIn(!!preset.isBuiltIn);
        setNewName(preset.name);
        setNewBands([...preset.bands]);
        setShowNewEQ(true);
    };

    // Editing a built-in overwrites it in place via eqOverrides (see
    // eq.js/storage.js) rather than spinning off a separate custom preset —
    // per request. Editing an existing custom preset updates it in place.
    // No existing editingId at all means a genuinely new custom preset,
    // same as before.
    const savePreset = async () => {
        if (editingIsBuiltIn && editingId) {
            const nextOverrides = { ...eqOverrides, [editingId]: [...newBands] };
            setEO(nextOverrides); await setEQOverrides(nextOverrides);
        } else if (editingId) {
            const next = customPresets.map(p => p.id === editingId ? { ...p, name: newName.trim() || p.name, bands: [...newBands] } : p);
            setCP(next); await setCustomPresets(next);
        } else {
            if (!newName.trim()) return;
            const id = 'custom_' + Date.now();
            const next = [...customPresets, { id, name: newName.trim(), bands: [...newBands] }];
            setCP(next); await setCustomPresets(next);
        }
        // If the preset just edited is the one actually playing right now,
        // refresh the live EQ immediately instead of the change only
        // taking effect the next time a preset gets picked.
        if (editingId && eqPresetId === editingId) applyEQPreset(eqPresetId);
        closeEQSheet();
    };

    // "reset EQ to normal" for an overwritten built-in — restores its
    // original BUILT_IN_PRESETS bands. The preset itself stays right where
    // it was in the list (not deleted), just no longer overridden.
    const resetEditingPresetToDefault = async () => {
        if (!editingIsBuiltIn || !editingId) return;
        const builtIn = BUILT_IN_PRESETS.find(p => p.id === editingId);
        if (!builtIn) return;
        const nextOverrides = { ...eqOverrides };
        delete nextOverrides[editingId];
        setEO(nextOverrides); await setEQOverrides(nextOverrides);
        setNewBands([...builtIn.bands]);
        if (eqPresetId === editingId) applyEQPreset(eqPresetId);
    };

    const MODES = [
        { id: 'full_cycle', label: 'Full Cycle', sub: 'Every song once before any repeat' },
        { id: 'true_random', label: 'True Random', sub: 'Any song, any time. No cycle, repeats possible' },
        { id: 'smart', label: 'Smart', sub: 'Random, but leans toward songs you have played less. No cycle' },
        { id: 'dumb', label: 'Dumb', sub: 'Random, but leans toward songs you have played more. No cycle' },
    ];

    // Best-effort detection of which sideload tool is running this build.
    // Copies songs picked in the Files app into the app's own Documents folder (see utils/importMusic.js).
    const importSongsFlow = () => {
        const run = async (folder) => {
            try {
                const r = await importSongs(folder);
                if (!r) return;
                await reload();
                Alert.alert('Import finished', `${r.copied} song(s) added${folder ? ` to "${folder}"` : ''}.${r.skipped ? ` ${r.skipped} skipped (not audio).` : ''}${r.failed ? ` ${r.failed} could not be copied.` : ''}`);
            } catch (e) { Alert.alert('Import failed', String(e?.message ?? e)); }
        };
        Alert.prompt('Import Songs', 'Playlist folder to put them in. Leave empty to add them to All Songs only.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Choose Files', onPress: (name) => run((name || '').trim()) },
        ], 'plain-text', 'Imported');
    };
    const pathLower = (scanPath ?? '').toLowerCase();
    const isLiveContainer = pathLower.includes('livecontainer');
    const isSideStore = !isLiveContainer && !!scanPath;
    const showBoth = !scanPath || (!isLiveContainer && !isSideStore);

    const themeEntries = Object.entries(THEMES);
    const swatchRows = [themeEntries.slice(0, 5), themeEntries.slice(5, 10)];
    // 'light' has its own dedicated toggle below rather than sitting in this
    // grid alongside the ten dark bases — one clear way to reach it, not two.
    // Was `id !== 'light'` — that excluded the old single generic light
    // theme from this grid (this picks the DARK base only; light mode is a
    // separate toggle elsewhere). Now that light mode has one pastel
    // variant per hue (light_pink, light_purple, etc.) instead of one
    // generic entry, all ten needed excluding the same way or they'd leak
    // into this grid as 10 extra, redundant-looking swatches.
    const baseEntries = Object.entries(BASE_COLORS).filter(([id]) => !id.startsWith('light_'));

    const renderSwatch = ([id, t]) => (
        <TouchableOpacity key={id} onPress={() => setTheme(id)}
            style={[s.swatch, {
                width: SWATCH_SIZE, height: SWATCH_SIZE, borderRadius: squircle(SWATCH_SIZE),
                backgroundColor: t.accent,
            }, themeId === id && s.swatchActive,
            ]}>
            {themeId === id && <Text style={{ color: t.onAccent, fontWeight: '700', fontSize: 13 }}>✓</Text>}
        </TouchableOpacity>
    );

    const renderBaseSwatch = ([id, b]) => {
        // Real bug found here: this always called setBase(id) with the
        // DARK id shown in the grid, no matter what. While in Light Mode,
        // tapping any swatch to change the accent hue set baseId to a
        // dark_X id directly — which makes isLight recompute to false, so
        // the whole app silently dropped back to dark mode on every tap.
        // That's exactly "light mode has no selectable base colors": there
        // was no way to change hue and STAY in light mode. It also meant
        // no swatch ever showed the checkmark while in light mode at all
        // (baseId was always some light_X, which never equals the dark_X
        // id being compared here) — so even before tapping anything, the
        // grid looked like nothing was selected. Fixed by mapping to the
        // matching light_X id (same hue-derivation toggleLightMode itself
        // uses) whenever Light Mode is currently on, both for what tapping
        // actually sets and for which swatch shows as active/previewed.
        const targetId = isLight ? (BASE_COLORS[`light_${id.replace(/^dark_/, '')}`] ? `light_${id.replace(/^dark_/, '')}` : 'light_black') : id;
        const swatchColors = BASE_COLORS[targetId] ?? b;
        return (
            <TouchableOpacity key={id} onPress={() => setBase(targetId)}
                style={[s.swatch, {
                    width: BASE_SWATCH_SIZE, height: BASE_SWATCH_SIZE, borderRadius: squircle(BASE_SWATCH_SIZE),
                    backgroundColor: swatchColors.bg, borderWidth: 1, borderColor: swatchColors.border,
                }, baseId === targetId && s.swatchActive]}>
                {baseId === targetId && <Text style={{ color: theme.accent, fontWeight: '700', fontSize: 13 }}>✓</Text>}
            </TouchableOpacity>
        );
    };

    const pickBackgroundImage = async () => {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
            Alert.alert('Permission needed', 'Allow Photos access in Settings to set a background image.');
            return;
        }
        // Real bug found here: allowsEditing was explicitly off, so picking
        // a background image never showed iOS's own crop/position step at
        // all — whatever photo you picked got used exactly as the library
        // returned it, uncropped, regardless of its aspect ratio vs the
        // screen's. Flipping this on brings back the native crop UI (drag
        // to reposition/zoom before confirming), same one Playlist covers
        // already use elsewhere in this screen.
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            // iOS's crop step is always a square (it ignores any aspect
            // setting), which is why backgrounds came out square. Off now:
            // the image is drawn to fill the whole screen instead.
            allowsEditing: false,
            quality: 0.8,
        });
        if (result.canceled || !result.assets?.[0]?.uri) return;
        let permanentUri = await persistCoverImage(result.assets[0].uri);
        // A screen-sized copy: a full-resolution photo has to be decoded again
        // each time a screen shows it, which is the black flash on opening
        // screens. This one decodes far faster and looks identical.
        try {
            const small = permanentUri.replace(/\.[^./]+$/, '') + '_screen.jpg';
            if (await AudioEngine.makeThumbnail(permanentUri, small, 1800)) {
                // Keep only the screen-sized copy; the picked original is
                // never read again, so it is deleted right away.
                await deleteStoredImage(permanentUri);
                permanentUri = small;
                // Tiny copy shown instantly while the full one decodes
                // (see ScreenBackground), so opening a screen never shows
                // a black flash.
                await AudioEngine.makeThumbnail(small, small.replace(/_screen\.jpg$/, '_lo.jpg'), 240).catch(() => { });
            }
        } catch { }
        // Replacing the background: the previous picture is deleted.
        if (backgroundImageUri && backgroundImageUri !== permanentUri) deleteStoredImage(backgroundImageUri);
        setBackgroundImageUri(permanentUri);
        setBackgroundImageEnabled(true);
    };

    // One on/off row. `first` rows have no divider above them.
    const toggle = (label, sub, value, onChange, first) => (
        <View style={[s.toggleRow, !first && { borderTopWidth: 1, borderTopColor: base.border }]}>
            <View style={{ flex: 1 }}>
                <Text style={s.toggleLabel}>{label}</Text>
                {!!sub && <Text style={s.toggleSub}>{sub}</Text>}
            </View>
            <Switch value={value} onValueChange={onChange}
                trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
        </View>
    );
    const uiOn = (id) => ui[id] !== false;
    const uiPick = (id) => setUiShown(id, ui[id] === false);
    const uiRow = (name, label, sub, first) => toggle(label, sub, ui[name] !== false, (v) => setUiShown(name, v), first);

    // ---- Reset to default (per section, and everything) -------------------
    // Each one uses the same setters the switches and sliders use, so the
    // audio engine and the other screens follow along immediately.
    const resetters = {
        volume: () => { setWithinTrackNorm(false); setBetweenTrackNorm(false); },
        shuffle: () => { setShuffleTypePref('full_cycle'); changeShuffleMode('full_cycle'); },
        crossfade: () => {
            setCrossfadeEnabled(true);
            setCrossfadeDurationEotLocal(4); setCrossfadeDurationEndOfTrack(4);
            setCrossfadeDurationLocal(2); setCrossfadeDuration(2);
            setEotRampState(3); setEndOfTrackRamp(3);
            setSkipRampState(0.5); setSkipRamp(0.5);
            setRamp(2); setAudioRamp(2);
            setRampPause(false); setRampOnPause(false);
            setSilenceTrim(false);
        },
        queue: () => { setKeepPriority(true); setKeepPriorityOnPlaylistSwitch(true); },
        prev: () => { setPrevButtonModeState('previous_track'); setPrevButtonMode('previous_track'); setRestartThresholdState(3); setRestartThresholdSec(3); setRestartUnitState('sec'); setRestartThresholdUnit('sec'); setRestartPctState(5); setRestartThresholdPct(5); },
        lists: () => { setShowSongCovers(true); setShowPlayCount(true); setShowPlaylistTrackCount(true); setShowPlaylistTitles(true); setPlaylistCards(true); setPlaylistArrow(true); setSongPillShadow(false); setMiniPlayerShadow(true); },
        playlistsScreen: () => ['pl_layout', 'pl_reload'].forEach(n => setUiShown(n, true)),
        allSongsScreen: () => ['as_eq', 'as_queue'].forEach(n => setUiShown(n, true)),
        playlistScreen: () => { ['pd_back', 'pd_search', 'pd_eq', 'pd_queue', 'pd_cover', 'pd_play', 'pd_shuffle'].forEach(n => setUiShown(n, true)); setDetailOutline(false); },
        playerButtons: () => ['sleep', 'speed', 'eq', 'queue', 'back', 'label'].forEach(n => setPlayerBtnShown(n, true)),
        playerCover: () => {
            setShowPlayerCover(true); setCoverShadow(true); setPlayerOutline(false);
            setAutoShow('cover'); setLyricsOn(true); setDjDisc(false); setDjDiscSpin(true); setDjDiscTouch(true); setDjDiscRpm('33'); setDjDiscType('vinyl'); setDjDiscAssist(true);
            setLyricsResyncLocal(2); setLyricsResyncSec(2);
            setLyricsOffsetLocal(0); setLyricsOffsetSec(0);
            setLyricsScrollLocked(false);
        },
        screen: () => { setTopBarColor(true); setKeepScreenAwake(false); },
        covers: () => { setCoverShape('rounded'); setPlaylistCoverShape('rounded'); setPlaylistCoverShadow(true); },
        artists: () => { setArtistSeparator([';']); setArtistDisplayJoin('comma'); },
        album: () => { setAlbumFromFolderState(false); setAlbumFromFolder(false); },
    };
    // Reset buttons are per group (Playback, Screens, ...), not per section.
    const groupResetters = {
        playback: () => ['volume', 'shuffle', 'crossfade', 'queue', 'prev'].forEach(k => resetters[k]()),
        screens: () => ['lists', 'playlistsScreen', 'allSongsScreen', 'playlistScreen', 'playerButtons', 'playerCover'].forEach(k => resetters[k]()),
        appearance: () => ['covers', 'screen'].forEach(k => resetters[k]()),
        library: () => ['artists', 'album'].forEach(k => resetters[k]()),
    };
    const GROUP_RESET_NOTE = {
        playback: 'Volume levelling, shuffle, crossfade and fades, queue and the Previous button go back to their defaults. EQ presets are not touched.',
        screens: 'Every switch and option for the Playlists, All Songs, Playlist and Player screens goes back to its default.',
        appearance: 'Cover shapes, shadows, colored top bars and keep-screen-awake go back to their defaults. Accent color, base color and the custom background are not touched.',
        library: 'Multiple Artists and Album From Folder Name go back to their defaults. Your music and its location are not touched.',
    };
    const askGroupReset = (key, title) => Alert.alert(
        `Reset ${title}?`,
        `${GROUP_RESET_NOTE[key]} Nothing outside ${title} changes.`,
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Reset', style: 'destructive', onPress: groupResetters[key] }]
    );
    // One button for all of the above. Asks twice, because it is a lot to undo.
    const resetEverything = () => {
        Alert.alert(
            'Reset all settings?',
            'Every setting in Playback, Screens, Appearance (look only) and Library & Data goes back to its default.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Continue', style: 'destructive', onPress: () => Alert.alert(
                        'Are you sure?',
                        'Your music, playlists, cover pictures, EQ presets, colors, background and play counts are not touched. This cannot be undone.',
                        [
                            { text: 'Cancel', style: 'cancel' },
                            { text: 'Yes, reset all', style: 'destructive', onPress: () => Object.values(resetters).forEach(fn => fn()) },
                        ]
                    ),
                },
            ]
        );
    };

    // ---- Simple settings helpers -------------------------------------------
    // One crossfade length in Simple sets every related Advanced setting:
    // the end-of-song crossfade, the skip crossfade, and the fade when you
    // play or pause. Every one of them has the same 0 to 6 s range here and in
    // Advanced.
    const SIMPLE_XF = [0, 1, 2, 3, 4, 5, 6];
    const simpleXfSelected = !crossfadeEnabled ? 0 : (SIMPLE_XF.includes(Math.round(crossfadeDurationEndOfTrack)) ? Math.round(crossfadeDurationEndOfTrack) : -1);
    const applySimpleCrossfade = (sec) => {
        if (sec === 0) { setCrossfadeEnabled(false); return; }
        setCrossfadeEnabled(true);
        setCrossfadeDuration(sec); setCrossfadeDurationLocal(sec);
        setCrossfadeDurationEndOfTrack(sec);
        setRamp(sec); setAudioRamp(sec);
        setRampPause(true); setRampOnPause(true);
    };
    const chipRow = (items, isOn, onPick, extraStyle) => (
        <View style={[s.sortRow, extraStyle]}>
            {items.map(it => (
                <TouchableOpacity key={String(it.id)} style={[s.sortChip, isOn(it.id) && { backgroundColor: theme.accent }]} onPress={() => onPick(it.id)}>
                    <Text style={[s.sortChipText, isOn(it.id) && { color: theme.onAccent }]}>{it.label}</Text>
                </TouchableOpacity>
            ))}
        </View>
    );
    // Looks: shadows and outlines in one pick. Cover shape is its own toggle.
    const LOOKS = {
        minimal: { cs: false, pcs: false, sps: false, mps: false, po: false, dout: false },
        soft: { cs: true, pcs: true, sps: true, mps: true, po: false, dout: false },
        bold: { cs: true, pcs: true, sps: true, mps: true, po: true, dout: true },
        sharp: { cs: false, pcs: false, sps: false, mps: false, po: true, dout: true, shape: 'square' },
    };
    const currentLook = () => ({ cs: shadowsRaw.coverShadow, pcs: shadowsRaw.playlistCoverShadow, sps: shadowsRaw.songPillShadow, mps: shadowsRaw.miniPlayerShadow, po: playerOutline, dout: detailOutline });
    const sameLook = (a, b) => !!a && !!b && ['cs', 'pcs', 'sps', 'mps', 'po', 'dout'].every(k => !!a[k] === !!b[k]);
    const setRoundedCovers = (v) => { setCoverShape(v ? 'rounded' : 'square'); setPlaylistCoverShape(v ? 'rounded' : 'square'); };
    const applyLook = (L) => {
        setCoverShadow(L.cs); setPlaylistCoverShadow(L.pcs); setSongPillShadow(L.sps); setMiniPlayerShadow(L.mps);
        setPlayerOutline(L.po); setDetailOutline(L.dout);
        if (L.shape) setRoundedCovers(false);
    };
    const LOOK_CHIPS = [{ id: 'minimal', label: 'Minimal' }, { id: 'soft', label: 'Soft' }, { id: 'bold', label: 'Bold' }, { id: 'sharp', label: 'Sharp' }];
    const lookOn = (id) => sameLook(currentLook(), LOOKS[id]);
    const looksUi = (
        <>
            {chipRow(LOOK_CHIPS, lookOn, (id) => applyLook(LOOKS[id]))}
            <View style={s.settingHeader}>
                <Text style={s.toggleSub}>Minimal: flat, no shadows or outlines.{'\n'}Soft: shadows only.{'\n'}Bold: shadows and outlines.{'\n'}Sharp: outlines only, and square covers.</Text>
            </View>
            {toggle('Rounded Covers', 'Round the corners of song and playlist covers', coverShape === 'rounded', setRoundedCovers)}
        </>
    );
    const performanceToggle = toggle('Performance Mode', 'For older iPhones. Turns off shadows, loads lists lighter, saves less in the background and stops the debug log. Your own shadow settings come back when it is off', performanceMode, setPerformanceMode, true);
    const volumeTagToggle = toggle('Use Volume Tags', 'When Match Volume is on, use the volume value stored in the song file (ReplayGain) if it has one. Songs without one still use the estimate', useVolumeTags, setUseVolumeTags);
    const askRestoreBackup = async () => {
        const list = await listAutoBackups();
        if (!list.length) { Alert.alert('No backups yet', 'A copy is made about once a day when the app opens, or tap Back Up Now.'); return; }
        Alert.alert('Restore a backup', 'Restores all settings from the copy you pick. Close and reopen the app afterwards.', [
            ...list.map(b => ({ text: b.time ? new Date(b.time).toLocaleString() : `Copy ${b.n}`, onPress: async () => { try { await restoreAutoBackup(b.n); Alert.alert('Restored', 'Close and reopen SySlate to apply.'); } catch { Alert.alert('Could not restore', 'That backup could not be read.'); } } })),
            { text: 'Cancel', style: 'cancel' },
        ]);
    };
    // Shuffle = how songs are weighted (Normal / Smart / Dumb) and how they
    // are ordered (Shuffle = each song once per round, Random = any song any
    // time, repeats possible). Saved as one id, see utils/shuffle.js.
    const shuffleParts = MODE_PARTS[shuffleTypePref] || MODE_PARTS.full_cycle;
    const pickShuffle = (weight, order) => { const id = modeId(weight, order); setShuffleTypePref(id); changeShuffleMode(id); };
    const WEIGHTS = [{ id: 'normal', label: 'Normal', sub: 'Every song equally likely' }, { id: 'smart', label: 'Smart', sub: 'Leans toward songs you have played less' }, { id: 'dumb', label: 'Dumb', sub: 'Leans toward songs you have played more' }];
    const ORDERS = [{ id: 'cycle', label: 'Shuffle', sub: 'Every song once per round' }, { id: 'random', label: 'Random', sub: 'Any song any time, repeats possible, no rounds' }];
    const shuffleUi = (
        <>
            {chipRow(WEIGHTS, (id) => shuffleParts.weight === id, (id) => pickShuffle(id, shuffleParts.order), { paddingBottom: 8 })}
            {chipRow(ORDERS, (id) => shuffleParts.order === id, (id) => pickShuffle(shuffleParts.weight, id), { paddingBottom: 12 })}
            <Text style={[s.toggleSub, { paddingHorizontal: 24, paddingBottom: 16 }]}>
                {WEIGHTS.find(w => w.id === shuffleParts.weight)?.sub}. {ORDERS.find(o => o.id === shuffleParts.order)?.sub}.
            </Text>
        </>
    );
    const noMatch = !!q && !SECTION_TITLES.some(t => sectionMatches(t, q));

    return (
        <ScreenBackground style={s.container}>
            <StatusBar barStyle="light-content" />
            {/* Same bar as Playlists and All Songs: same height, same title
                spot, and the same soft fade at the bottom. */}
            <View style={[s.header, !topBarColor && OVERLAY_HEADER]} pointerEvents={topBarColor ? 'auto' : 'box-none'} onLayout={onHdrLayout}>
                {topBarColor && <TopBarBack color={base.surface} />}
                <View style={s.titleBox}><Text style={s.title}>Settings</Text></View>
            </View>
            {!loaded ? null : (
                <>
            <ScrollView
                ref={scrollRef}
                // Lets sliders know when the page is moving, so they do not
                // grab the finger while it scrolls.
                onScroll={(e) => noteScroll(e.nativeEvent.contentOffset.y)}
                scrollEventThrottle={16}
                // The list runs up under the bar's fade (so rows fade out
                // instead of being cut off) and starts lower by the same
                // amount, so nothing sits higher than before.
                // Colored bar: the list runs up under the bar's fade. Transparent
                // bar: the list fills the whole screen and passes behind the
                // floating bar, starting the bar's height lower so that at the
                // top it sits exactly where it does with the colored bar.
                style={topBarColor ? { marginTop: -TOP_FADE } : null}
                contentContainerStyle={{ paddingTop: topBarColor ? TOP_FADE : hdrH, paddingBottom: 160 }}
                scrollIndicatorInsets={topBarColor ? undefined : { top: hdrH }}
            >
                <SettingsViewCtx.Provider value={{ mode, q }}>
                <View style={s.modeBar}>
                    {[{ id: 'simple', label: 'Simple' }, { id: 'advanced', label: 'Advanced' }].map(m => (
                        <TouchableOpacity key={m.id} style={[s.modeBtn, mode === m.id && { backgroundColor: theme.accent }]} onPress={() => changeMode(m.id)} activeOpacity={0.8}>
                            <Text style={[s.modeBtnText, mode === m.id && { color: theme.onAccent }]}>{m.label}</Text>
                        </TouchableOpacity>
                    ))}
                </View>
                <View style={s.searchBox}>
                    <TextInput value={query} onChangeText={setQuery} placeholder="Search settings" placeholderTextColor={base.textFaint}
                        style={s.searchInput} autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" returnKeyType="search" />
                </View>
                {noMatch && <Text style={s.noMatch}>No settings match "{query}"</Text>}

                {/* ---- Simple view: a few everyday settings. Each one sets
                     several Advanced settings at once. ---- */}
                <Section title="Sound" only="simple">
                    <View style={s.settingHeader}>
                        <Text style={s.toggleLabel}>Crossfade & Fades</Text>
                        <Text style={s.toggleSub}>One length (0 to 6s) for the end-of-song crossfade, skipping, and the fade when you play or pause</Text>
                    </View>
                    {chipRow(SIMPLE_XF.map(v => ({ id: v, label: v === 0 ? 'Off' : `${v}s` })), (id) => simpleXfSelected === id, applySimpleCrossfade)}
                    <View style={[s.settingHeader, { borderTopWidth: 1, borderTopColor: base.border }]}>
                        <Text style={s.toggleLabel}>Shuffle</Text>
                        <Text style={s.toggleSub}>How songs are picked when shuffle is on</Text>
                    </View>
                    {shuffleUi}
                    {toggle('Match Volume', 'Keeps songs at a similar loudness', betweenTrackNorm, setBetweenTrackNorm)}
                </Section>
                <Section title="Player" only="simple">
                    <View style={s.settingHeader}>
                        <Text style={s.toggleLabel}>Opens On</Text>
                        <Text style={s.toggleSub}>What the Player shows first for each song</Text>
                    </View>
                    {chipRow([{ id: 'cover', label: 'Cover' }, { id: 'lyrics', label: 'Lyrics' }, { id: 'disc', label: 'DJ Disc' }], (id) => autoShow === id, setAutoShow)}
                </Section>
                <Section title="Looks" only="simple">
                    <View style={s.settingHeader}>
                        <Text style={s.toggleLabel}>Style</Text>
                        <Text style={s.toggleSub}>Shadows and outlines</Text>
                    </View>
                    {looksUi}
                </Section>
                <Section title="Performance" only="simple">
                    {performanceToggle}
                </Section>

                {/* EQ now runs for real through AudioEngine's AVAudioUnitEQ —
                    this whole section was left commented out from the old
                    react-native-track-player era (which had no real EQ) and
                    never un-hidden. Un-hidden now, kept at the top of
                    Settings. Checking a preset here hides it from the
                    picker in EQModal; it doesn't change what's currently
                    playing. "+ Add Custom Preset" opens the band-by-band
                    builder below (sliders per BAND_HZ), already wired to
                    getCustomPresets/setCustomPresets. */}

                <GroupHeader title="Playback" onReset={() => askGroupReset('playback', 'Playback')} hidden={isHidden('playback')} onToggleHidden={() => toggleGroupHidden('playback')} />
                {!isHidden('playback') && (<>

                <Section title="EQ Presets">
                    {/* Built-ins and custom presets now share one 2-column
                        grid instead of built-ins living in a grid above a
                        separate full-width list of customs — tapping a
                        preset's name (not its checkbox, not its ✕) opens
                        the same band editor for either kind. Each row is a
                        plain View with three independently-tappable
                        children (checkbox / name / delete) instead of one
                        big TouchableOpacity, since a name tap now needs to
                        mean something different from a checkbox tap. */}
                    <View style={s.eqGrid}>
                        {visiblePresets.map(p => (
                            <View key={p.id} style={s.eqChip}>
                                <TouchableOpacity onPress={() => togglePresetVisible(p.id)} hitSlop={HIT} style={s.checkWrapGrid}>
                                    <View style={[s.checkbox, { borderColor: theme.accent }, !hiddenPresets.includes(p.id) && { backgroundColor: theme.accent }]}>
                                        {!hiddenPresets.includes(p.id) && <Text style={{ color: theme.onAccent, fontSize: 11, fontWeight: '700' }}>✓</Text>}
                                    </View>
                                </TouchableOpacity>
                                <TouchableOpacity style={s.eqChipNameWrap} onPress={() => openEditPresetSheet(p)}>
                                    <Text style={s.eqChipName} numberOfLines={1}>
                                        {p.name}{p.isOverridden ? ' •' : ''}
                                    </Text>
                                </TouchableOpacity>
                                {!p.isBuiltIn && (
                                    <TouchableOpacity onPress={() => confirmDeleteCustomPreset(p)} hitSlop={HIT} style={s.eqDelWrap}>
                                        <Text style={s.eqDel}>✕</Text>
                                    </TouchableOpacity>
                                )}
                            </View>
                        ))}
                    </View>
                    <View style={s.eqButtonRow}>
                        <TouchableOpacity style={[s.addBtn, s.eqButtonHalf, { borderColor: theme.accent }]} onPress={openNewPresetSheet}>
                            <Text style={[s.addBtnText, { color: theme.accent }]}>+ Add Custom Preset</Text>
                        </TouchableOpacity>
                        <View style={[s.toggleRow, s.eqButtonHalf, { paddingVertical: 0 }]}>
                            <Text style={[s.toggleLabel, { flex: 1, fontSize: 13 }]}>Show Premade Presets</Text>
                            <Switch value={showPremadeInSettings} onValueChange={togglePremadeInSettings}
                                trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                        </View>
                    </View>

                    {/* Pre-amp: a single broadband gain on top of whatever
                        preset is active, not tied to any one preset — lives
                        here rather than inside the preset editor since it
                        applies globally regardless of which preset is
                        picked (same as how a hardware EQ's master gain knob
                        works alongside its band sliders). */}
                    <Text style={[s.sliderSub, { paddingTop: 20 }]}>Pre-amp</Text>
                    <Text style={s.sliderNote}>Overall gain on top of the current preset — boost a quiet library or pull back a hot one</Text>
                    <Text style={[s.sliderVal, { color: theme.accent }]}>{preAmpLocal > 0 ? '+' : ''}{preAmpLocal.toFixed(1)}dB</Text>
                    <PureSlider guardScroll style={s.slider} minimumValue={-12} maximumValue={12} step={0.5} value={preAmpLocal}
                        onValueChange={setPreAmpLocal} onSlidingComplete={v => { setPreAmpLocal(v); setPreAmp(v); }}
                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                    <View style={s.sliderEnds}><Text style={s.sliderEnd}>-12dB</Text><Text style={s.sliderEnd}>+12dB</Text></View>
                </Section>

                <Section title="Volume Levelling">
                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Volume Normalization</Text>
                            {/* This label used to say "Equalizes loudness between
                                tracks" — but the actual implementation (Apple's
                                Dynamics Processor) is compression WITHIN a
                                track, not loudness matching across tracks. Split
                                into two real, separate settings below. */}
                            <Text style={s.toggleSub}>Evens out loud and quiet parts of a song</Text>
                        </View>
                        <Switch value={withinTrackNorm} onValueChange={setWithinTrackNorm}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={[s.toggleRow, { borderTopWidth: 1, borderTopColor: base.border }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Match Volume Between Songs</Text>
                            <Text style={s.toggleSub}>Keeps songs at a similar volume. An estimate, checked once per song</Text>
                        </View>
                        <Switch value={betweenTrackNorm} onValueChange={setBetweenTrackNorm}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    {volumeTagToggle}
                </Section>

                {/* 3. Shuffle */}
                {/* 2. Audio — fade/ramp settings, crossfade, and normalization,
                     all together under one heading. */}
                <Section title="Crossfade & Fades">
                    {/* Moved Crossfade to the top of the section, and now
                        actually REPLACES the End of Track / On Skip ramp
                        controls when it's on, instead of just graying them
                        out in place — those two ramps do the same job as
                        Crossfade (smoothing a track transition) so showing
                        both at once was clutter once one was chosen. Ramp
                        on Pause / Ramp on Play are a different thing (they
                        respond to play/pause, not track transitions) and
                        stay fully independent, further down. */}
                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Crossfade</Text>
                            <Text style={s.toggleSub}>Overlaps songs. Replaces the End of Track and On Skip ramps</Text>
                        </View>
                        <Switch value={crossfadeEnabled} onValueChange={setCrossfadeEnabled}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    {crossfadeEnabled ? (
                        <>
                            {/* Split from one shared "Crossfade Duration" slider
                                into On Skip / End of Track, mirroring the Audio
                                Ramp section right below (same two triggers, same
                                reasoning for why they're worth separate values —
                                a natural track-ending transition and a manual
                                skip are different enough moments). There's no
                                Crossfade equivalent of "On Play" — crossfade only
                                ever runs on a forward track change (see
                                AudioEngine.swift's advance()), so there's nothing
                                for a fresh play to overlap FROM. */}
                            <Text style={[s.sliderSub, { paddingTop: 20 }]}>Crossfade at End of Track</Text>
                            <Text style={s.sliderNote}>Overlap as a song ends, also when looping</Text>
                            <Text style={[s.sliderVal, { color: theme.accent }]}>{crossfadeDurationEotLocal.toFixed(1)}s</Text>
                            {/* Max lowered 10→6 to match Ramp's End of Track
                                cap right below — direct ask ("crossfade
                                settings should be 6,3,3 just like audio
                                ramping"). A 10s crossfade was also just
                                genuinely too long to use in practice — most
                                of what read as "doesn't switch song, just
                                cover" / "lasts too long" was a real 10-second
                                overlap, not only the mid-crossfade
                                announcement being late. */}
                            {/* minimumValue was 1 — inconsistent with Ramp's
                                sliders (which all start at 0) and with what
                                the underlying value actually supports: 0 is a
                                valid, meaningful "off" here, same as Ramp's 0
                                (native/storage already floor at 0, not 1 —
                                this was purely a UI-imposed floor). */}
                            <PureSlider guardScroll style={s.slider} minimumValue={0} maximumValue={6} step={0.5} value={crossfadeDurationEotLocal}
                                onValueChange={setCrossfadeDurationEotLocal}
                                onSlidingComplete={v => { setCrossfadeDurationEotLocal(v); setCrossfadeDurationEndOfTrack(v); }}
                                minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                            <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>6s</Text></View>

                            <Text style={[s.sliderSub, { paddingTop: 20 }]}>Crossfade on Skip</Text>
                            <Text style={s.sliderNote}>Overlap when you skip</Text>
                            <Text style={[s.sliderVal, { color: theme.accent }]}>{crossfadeDurationLocal.toFixed(1)}s</Text>
                            {/* Max lowered 10→3, matching Ramp's On Skip cap.
                                minimumValue same fix as above — 0 instead of 1. */}
                            <PureSlider guardScroll style={s.slider} minimumValue={0} maximumValue={6} step={0.5} value={crossfadeDurationLocal}
                                onValueChange={setCrossfadeDurationLocal}
                                onSlidingComplete={v => { setCrossfadeDurationLocal(v); setCrossfadeDuration(v); }}
                                minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                            <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>6s</Text></View>
                        </>
                    ) : (
                        <>
                            <Text style={[s.sliderSub, { paddingTop: 20 }]}>Ramp at End of Track</Text>
                            <Text style={s.sliderNote}>Fade out at the end, fade in the next</Text>
                            <Text style={[s.sliderVal, { color: theme.accent }]}>{eotRamp.toFixed(1)}s</Text>
                            <PureSlider guardScroll style={s.slider} minimumValue={0} maximumValue={6} step={0.5} value={eotRamp}
                                onValueChange={setEotRampState} onSlidingComplete={v => { setEotRampState(v); setEndOfTrackRamp(v); }}
                                minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                            <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>6s</Text></View>

                            <Text style={[s.sliderSub, { paddingTop: 20 }]}>Ramp on Skip</Text>
                            <Text style={s.sliderNote}>Softens skips</Text>
                            <Text style={[s.sliderVal, { color: theme.accent }]}>{skipRamp.toFixed(1)}s</Text>
                            <PureSlider guardScroll style={s.slider} minimumValue={0} maximumValue={6} step={0.5} value={skipRamp}
                                onValueChange={setSkipRampState} onSlidingComplete={v => { setSkipRampState(v); setSkipRamp(v); }}
                                minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                            <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>6s</Text></View>
                        </>
                    )}

                    <Text style={[s.sliderSub, { paddingTop: 20 }]}>Ramp on Play</Text>
                    <Text style={s.sliderNote}>Fade in when playback starts</Text>
                    <Text style={[s.sliderVal, { color: theme.accent }]}>{ramp.toFixed(1)}s</Text>
                    <PureSlider guardScroll style={s.slider} minimumValue={0} maximumValue={6} step={0.5} value={ramp}
                        onValueChange={setRamp} onSlidingComplete={v => { setRamp(v); setAudioRamp(v); }}
                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                    <View style={s.sliderEnds}><Text style={s.sliderEnd}>Off</Text><Text style={s.sliderEnd}>6s</Text></View>

                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Ramp on Pause</Text>
                            <Text style={s.toggleSub}>Fade out on pause</Text>
                        </View>
                        <Switch value={rampPause} onValueChange={v => { setRampPause(v); setRampOnPause(v); }}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={[s.toggleRow, { borderTopWidth: 1, borderTopColor: base.border }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Trim Silence</Text>
                            <Text style={s.toggleSub}>Skips silence at the start and end of songs</Text>
                        </View>
                        <Switch value={silenceTrim} onValueChange={setSilenceTrim}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                </Section>

                <Section title="Playback">
                    <SubGroup title="Shuffle" first>
                    <View style={{ paddingTop: 14 }}>{shuffleUi}</View>
                    </SubGroup>
                    <SubGroup title="Queue">
                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Keep Priority Queue When Switching Playlists</Text>
                            <Text style={s.toggleSub}>Keeps queued songs when you switch playlists</Text>
                        </View>
                        <Switch value={keepPriority} onValueChange={v => { setKeepPriority(v); setKeepPriorityOnPlaylistSwitch(v); }}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    </SubGroup>
                    <SubGroup title="Previous button">
                    <View style={s.settingHeader}>
                        <Text style={s.toggleLabel}>Previous Button Behavior</Text>
                        <Text style={s.toggleSub}>
                            Always go back, or restart the song if you're past its start
                        </Text>
                    </View>
                    <View style={s.sortRow}>
                        {PREV_BUTTON_MODES.map(opt => (
                            <TouchableOpacity
                                key={opt.id}
                                style={[s.sortChip, prevButtonMode === opt.id && { backgroundColor: theme.accent }]}
                                onPress={() => { setPrevButtonModeState(opt.id); setPrevButtonMode(opt.id); }}
                            >
                                <Text style={[s.sortChipText, prevButtonMode === opt.id && { color: theme.onAccent }]}>
                                    {opt.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                    {prevButtonMode === 'restart_or_previous' && (
                        <>
                            <View style={[s.settingHeader, { borderTopWidth: 1, borderTopColor: base.border }]}>
                                <Text style={s.toggleLabel}>Previous-Track Window</Text>
                                <Text style={s.toggleSub}>
                                    Within this much of the song Previous goes back a song. After it, Previous restarts the song
                                </Text>
                            </View>
                            <View style={s.sortRow}>
                                {[{ id: 'sec', label: 'Seconds' }, { id: 'pct', label: 'Percent of song' }].map(opt => (
                                    <TouchableOpacity
                                        key={opt.id}
                                        style={[s.sortChip, restartUnit === opt.id && { backgroundColor: theme.accent }]}
                                        onPress={() => { setRestartUnitState(opt.id); setRestartThresholdUnit(opt.id); }}
                                    >
                                        <Text style={[s.sortChipText, restartUnit === opt.id && { color: theme.onAccent }]}>{opt.label}</Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                            {restartUnit === 'pct' ? (
                                <>
                                    <Text style={[s.sliderVal, { color: theme.accent, marginTop: 0 }]}>{restartPct.toFixed(0)}%</Text>
                                    <PureSlider guardScroll style={s.slider} minimumValue={0} maximumValue={50} step={1} value={restartPct}
                                        onValueChange={setRestartPctState}
                                        onSlidingComplete={v => { setRestartPctState(v); setRestartThresholdPct(v); }}
                                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                                    <View style={s.sliderEnds}><Text style={s.sliderEnd}>0%</Text><Text style={s.sliderEnd}>50%</Text></View>
                                </>
                            ) : (
                                <>
                                    <Text style={[s.sliderVal, { color: theme.accent, marginTop: 0 }]}>{restartThreshold.toFixed(0)}s</Text>
                                    <PureSlider guardScroll style={s.slider} minimumValue={0} maximumValue={24} step={1} value={restartThreshold}
                                        onValueChange={setRestartThresholdState}
                                        onSlidingComplete={v => { setRestartThresholdState(v); setRestartThresholdSec(v); }}
                                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                                    <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>24s</Text></View>
                                </>
                            )}
                        </>
                    )}
                    </SubGroup>
                </Section>

                {/* Explains itself precisely rather than leaning on "unskip" /
                     "rewind" — the button's real behavior is either "always go
                     to the previous track" or "restart this one, except right
                     near its start" — describing it in those terms up front
                     avoids needing the label to also do the explaining. */}
                </>)}

                <GroupHeader title="Screens" onReset={() => askGroupReset('screens', 'Screens')} hidden={isHidden('screens')} onToggleHidden={() => toggleGroupHidden('screens')} />
                {!isHidden('screens') && (<>

                <Section title="Lists">
                    <SubGroup title="Songs & playlists" first>
                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Show Song Covers</Text>
                            <Text style={s.toggleSub}>Cover art next to songs in lists</Text>
                        </View>
                        <Switch value={showSongCovers} onValueChange={setShowSongCovers}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={[s.toggleRow, { borderTopWidth: 1, borderTopColor: base.border }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Show Play Count</Text>
                            <Text style={s.toggleSub}>In lists, the queue and the player</Text>
                        </View>
                        <Switch value={showPlayCount} onValueChange={setShowPlayCount}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={[s.toggleRow, { borderTopWidth: 1, borderTopColor: base.border }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Show Track Count</Text>
                            <Text style={s.toggleSub}>Track counts on Playlists and inside each one</Text>
                        </View>
                        <Switch value={showPlaylistTrackCount} onValueChange={setShowPlaylistTrackCount}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={[s.toggleRow, { borderTopWidth: 1, borderTopColor: base.border }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Show Playlist Titles</Text>
                            <Text style={s.toggleSub}>Playlist names under their covers and above the songs inside a playlist</Text>
                        </View>
                        <Switch value={showPlaylistTitles} onValueChange={setShowPlaylistTitles}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    {toggle('Playlist Cards', 'A card behind every playlist, in all layouts', playlistCards, setPlaylistCards)}
                    {toggle('Show Arrow', 'The arrow on the list layouts', playlistArrow, setPlaylistArrow)}
                    </SubGroup>
                    <SubGroup title="Playlists screen">
                    {chipRow([{ id: 'pl_layout', label: 'Layout' }, { id: 'pl_reload', label: 'Reload' }], uiOn, uiPick)}
                    <View style={s.settingHeader}><Text style={s.toggleSub}>Tap to show or hide. Highlighted buttons are shown.</Text></View>
                    </SubGroup>
                    <SubGroup title="All Songs screen">
                    {chipRow([{ id: 'as_eq', label: 'EQ' }, { id: 'as_queue', label: 'Queue' }], uiOn, uiPick)}
                    <View style={s.settingHeader}><Text style={s.toggleSub}>Tap to show or hide. Highlighted buttons are shown.</Text></View>
                    </SubGroup>
                    <SubGroup title="Playlist screen">
                    {chipRow([{ id: 'pd_back', label: 'Back' }, { id: 'pd_search', label: 'Search' }, { id: 'pd_eq', label: 'EQ' }, { id: 'pd_queue', label: 'Queue' }, { id: 'pd_cover', label: 'Cover' }, { id: 'pd_play', label: 'Play' }, { id: 'pd_shuffle', label: 'Shuffle' }], uiOn, uiPick)}
                    <View style={s.settingHeader}><Text style={s.toggleSub}>Tap to show or hide. Highlighted buttons are shown.</Text></View>
                    </SubGroup>
                </Section>

                <Section title="Player">
                    <SubGroup title="Buttons" first>
                    {chipRow([{ id: 'sleep', label: 'Sleep' }, { id: 'speed', label: 'Speed' }, { id: 'eq', label: 'EQ' }, { id: 'queue', label: 'Queue' }, { id: 'back', label: 'Down arrow' }, { id: 'label', label: 'Playlist name' }], (id) => !!playerBtns[id], (id) => setPlayerBtnShown(id, !playerBtns[id]))}
                    <View style={s.settingHeader}><Text style={s.toggleSub}>Tap to show or hide. Highlighted buttons are shown.</Text></View>
                    </SubGroup>
                    <SubGroup title="Views">
                    <View style={s.settingHeader}>
                        <Text style={s.toggleLabel}>Opens On</Text>
                        <Text style={s.toggleSub}>What the Player shows first for each song. The button under the cover cycles through the views that are on</Text>
                    </View>
                    {chipRow([{ id: 'cover', label: 'Cover' }, { id: 'lyrics', label: 'Lyrics' }, { id: 'disc', label: 'DJ Disc' }], (id) => autoShow === id, setAutoShow)}
                    {toggle('Cover', 'Album art on the Player', showPlayerCover, setShowPlayerCover, true)}
                    <View style={{ height: 22 }} />
                    {toggle('Lyrics', 'A lyrics view, for songs that have lyrics', lyricsOn, setLyricsOn, true)}
                    {lyricsOn && (<>
                    <Text style={[s.sliderSub, { paddingTop: 6 }]}>Resync Delay</Text>
                    <Text style={s.sliderNote}>
                        How long lyrics stay where you scrolled before following the song again
                    </Text>
                    <Text style={[s.sliderVal, { color: theme.accent }]}>{lyricsResyncLocal.toFixed(1)}s</Text>
                    <PureSlider guardScroll style={s.slider} minimumValue={0} maximumValue={6} step={0.5} value={lyricsResyncLocal}
                        onValueChange={setLyricsResyncLocal}
                        onSlidingComplete={v => { setLyricsResyncLocal(v); setLyricsResyncSec(v); }}
                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                    <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>6s</Text></View>
                    <Text style={[s.sliderSub, { paddingTop: 14 }]}>Sync Offset</Text>
                    <Text style={s.sliderNote}>
                        Fixes lyrics that run early or late. Positive shows lines sooner
                    </Text>
                    <Text style={[s.sliderVal, { color: theme.accent }]}>
                        {lyricsOffsetLocal > 0 ? '+' : ''}{lyricsOffsetLocal.toFixed(1)}s
                    </Text>
                    <PureSlider guardScroll style={s.slider} minimumValue={-3} maximumValue={3} step={0.5} value={lyricsOffsetLocal}
                        onValueChange={setLyricsOffsetLocal}
                        onSlidingComplete={v => { setLyricsOffsetLocal(v); setLyricsOffsetSec(v); }}
                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                    <View style={s.sliderEnds}><Text style={s.sliderEnd}>-3s</Text><Text style={s.sliderEnd}>+3s</Text></View>
                    {toggle('Unscrollable Lyrics', 'Swiping lyrics closes the player instead of scrolling', lyricsScrollLocked, setLyricsScrollLocked)}
                    </>)}
                    <View style={{ height: 22 }} />
                    {toggle('DJ Disc', 'A spinning record you can scratch', djDisc, setDjDisc, true)}
                    {djDisc && (<>
                    <View style={[s.settingHeader, { borderTopWidth: 1, borderTopColor: base.border }]}>
                        <Text style={s.toggleLabel}>DJ Disc Speed</Text>
                        <Text style={s.toggleSub}>How fast the disc turns at normal playback speed. It follows the speed button in the Player</Text>
                    </View>
                    <View style={s.sortRow}>
                        {DISC_RPM_OPTIONS.map(opt => (
                            <TouchableOpacity
                                key={opt.id}
                                style={[s.sortChip, djDiscRpm === opt.id && { backgroundColor: theme.accent }]}
                                onPress={() => setDjDiscRpm(opt.id)}
                            >
                                <Text style={[s.sortChipText, djDiscRpm === opt.id && { color: theme.onAccent }]}>
                                    {opt.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                    <View style={[s.settingHeader, { borderTopWidth: 1, borderTopColor: base.border }]}>
                        <Text style={s.toggleLabel}>Disc Type</Text>
                        <Text style={s.toggleSub}>Look of the disc: a vinyl record with the cover as its label, or a CD with the cover printed on it</Text>
                    </View>
                    <View style={s.sortRow}>
                        {[{ id: 'vinyl', label: 'Vinyl' }, { id: 'cd', label: 'CD' }].map(opt => (
                            <TouchableOpacity
                                key={opt.id}
                                style={[s.sortChip, djDiscType === opt.id && { backgroundColor: theme.accent }]}
                                onPress={() => setDjDiscType(opt.id)}
                            >
                                <Text style={[s.sortChipText, djDiscType === opt.id && { color: theme.onAccent }]}>{opt.label}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                    {toggle('Scratch Speed Assist', 'While scratching, the speed clings to 0.5x, 1x and 2x when your finger is close. Off = exactly your finger speed. Your finger plays at 1x when it turns the disc as fast as it idles at the speed above', djDiscAssist, setDjDiscAssist)}
                    {toggle('Disc Spins', 'The disc keeps turning while a song plays', djDiscSpin, setDjDiscSpin)}
                    {toggle('Touch & Scratch', 'Move or scratch the disc with a finger. Off also stops the dimming near the ends of songs', djDiscTouch, setDjDiscTouch)}
                    </>)}
                    </SubGroup>
                </Section>

                </>)}

                <GroupHeader title="Appearance" onReset={() => askGroupReset('appearance', 'Appearance')} hidden={isHidden('appearance')} onToggleHidden={() => toggleGroupHidden('appearance')} />
                {!isHidden('appearance') && (<>

                {/* 4. Color — explicit 2 rows of 5, not flex-wrapped (a shrunk swatch
                     size let 6 fit per row instead of 5, leaving an uneven second row) */}
                <Section title="Look">
                    <SubGroup title="Style" first>
                    {looksUi}
                    </SubGroup>
                    <SubGroup title="Top bars & screen">
                    {toggle('Colored Top Bars', 'Playlists, All Songs, Settings and playlist top bars use the base color. Off: transparent, and lists scroll behind them', topBarColor, setTopBarColor, true)}
                    <View style={[s.toggleRow, { borderTopWidth: 1, borderTopColor: base.border }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Keep Screen Awake</Text>
                            <Text style={s.toggleSub}>Only while a song plays</Text>
                        </View>
                        <Switch value={keepScreenAwake} onValueChange={setKeepScreenAwake}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    </SubGroup>
                </Section>

                <Section title="Accent Color" simple>
                    <View style={{ paddingVertical: 16, paddingHorizontal: 16 }}>
                        {swatchRows.map((row, i) => (
                            <View key={i} style={[s.swatchRow, i > 0 && { marginTop: 14 }]}>
                                {row.map(renderSwatch)}
                            </View>
                        ))}
                    </View>
                </Section>

                <Section title="Base Color" simple>
                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Light Mode</Text>
                            <Text style={s.toggleSub}>Light background. Your dark base color returns when you turn it off</Text>
                        </View>
                        <Switch value={isLight} onValueChange={toggleLightMode}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    {/* Real bug found here: this whole grid used to be
                        dimmed AND pointerEvents="none" whenever isLight was
                        true — meaning renderBaseSwatch's careful dark→light
                        id mapping above was completely unreachable while in
                        Light Mode. The only way to change hue was to flip
                        back to dark, pick a swatch, then flip light mode
                        back on — exactly "light mode is locked, can only
                        change by picking a dark color then switching."
                        Nothing else needed to change; the mapping logic was
                        already correct, this container was just blocking
                        all touches from ever reaching it. */}
                    <View style={{ paddingVertical: 16, paddingHorizontal: 16 }}>
                        <View style={s.swatchRow}>
                            {baseEntries.map(renderBaseSwatch)}
                        </View>
                    </View>
                </Section>

                <Section title="Custom Background" simple>
                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Use Background Image</Text>
                            <Text style={s.toggleSub}>Image behind every screen. Colors stay the same</Text>
                        </View>
                        <Switch value={backgroundImageEnabled} onValueChange={v => {
                            if (v && !backgroundImageUri) { pickBackgroundImage(); return; }
                            setBackgroundImageEnabled(v);
                        }}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={{ flexDirection: 'row', paddingHorizontal: 24, paddingVertical: 14, gap: 10 }}>
                        <TouchableOpacity onPress={pickBackgroundImage} style={[s.sortChip, { backgroundColor: theme.accent }]}>
                            <Text style={[s.sortChipText, { color: theme.onAccent }]}>
                                {backgroundImageUri ? 'Change Image' : 'Choose Image'}
                            </Text>
                        </TouchableOpacity>
                        {backgroundImageUri && (
                            <TouchableOpacity onPress={() => { setBackgroundImageEnabled(false); deleteStoredImage(backgroundImageUri); setBackgroundImageUri(null); }} style={s.sortChip}>
                                <Text style={s.sortChipText}>Remove</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </Section>

                </>)}

                <GroupHeader title="Library & Data" onReset={() => askGroupReset('library', 'Library & Data')} hidden={isHidden('library')} onToggleHidden={() => toggleGroupHidden('library')} />
                {!isHidden('library') && (<>

                {/* Splits a tag's artist field into individual artists on this
                     character before display/search, so "Artist A; Artist B"
                     shows and searches as two artists instead of one long
                     string. 'None' turns splitting off entirely — the tag
                     displays exactly as stored, same as before this setting
                     existed. Defaults to ';' (see getArtistSeparator's own
                     comment for why that's the safe default) — songs with no
                     separator character in their tag are never affected by
                     this setting either way. */}
                <Section title="Artists & Albums">
                    <SubGroup title="Multiple artists" first>
                    <View style={s.settingHeader}>
                        <Text style={s.toggleLabel}>Artist Separator</Text>
                        <Text style={s.toggleSub}>What splits multiple artists in your files, like "A; B". Pick all you use</Text>
                    </View>
                    <View style={s.sortRow}>
                        {ARTIST_SEPARATORS.map(opt => {
                            // Multi-select now (a library can genuinely mix
                            // more than one separator convention) — 'None'
                            // is the one mutually-exclusive option, since it
                            // means "don't split at all" and picking it
                            // alongside a real separator wouldn't make
                            // sense. Selecting 'None' clears everything
                            // else; selecting any real separator while
                            // 'None' is active drops 'None'.
                            const selected = opt.id === 'none'
                                ? artistSeparator.includes('none') || artistSeparator.length === 0
                                : artistSeparator.includes(opt.id);
                            return (
                                <TouchableOpacity
                                    key={opt.id}
                                    style={[s.sortChip, selected && { backgroundColor: theme.accent }]}
                                    onPress={() => {
                                        if (opt.id === 'none') {
                                            setArtistSeparator(['none']);
                                            return;
                                        }
                                        const withoutNone = artistSeparator.filter(sep => sep !== 'none');
                                        setArtistSeparator(
                                            withoutNone.includes(opt.id)
                                                ? withoutNone.filter(sep => sep !== opt.id)
                                                : [...withoutNone, opt.id]
                                        );
                                    }}
                                >
                                    <Text style={[s.sortChipText, selected && { color: theme.onAccent }]}>
                                        {opt.label}
                                    </Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>

                    {/* Separate from the separator picker above — that
                         controls what counts as a split point in the raw
                         tag; this controls how the split artists get
                         re-joined for display. Applies in-app everywhere
                         formatArtists is used (Player, queue, playlist and
                         All Songs rows). Does not yet reach the lock-screen/
                         Bluetooth/CarPlay "Now Playing" artist field — that
                         goes through native metadata sent at queue-add time
                         from many call sites, and doing that safely needs
                         its own centralized pass rather than being bolted
                         on here; noted as a followup, not silently skipped. */}
                    <View style={[s.settingHeader, { marginTop: 14 }]}>
                        <Text style={s.toggleLabel}>Artist Display Format</Text>
                        <Text style={s.toggleSub}>How multiple artists show in the app</Text>
                    </View>
                    <View style={s.sortRow}>
                        {[
                            { id: 'comma', label: 'A, B' },
                            { id: 'ampersand', label: 'A & B' },
                            { id: 'slash', label: 'A / B' },
                        ].map(opt => (
                            <TouchableOpacity
                                key={opt.id}
                                style={[s.sortChip, artistDisplayJoin === opt.id && { backgroundColor: theme.accent }]}
                                onPress={() => setArtistDisplayJoin(opt.id)}
                            >
                                <Text style={[s.sortChipText, artistDisplayJoin === opt.id && { color: theme.onAccent }]}>
                                    {opt.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                    </SubGroup>
                    <SubGroup title="Album from folder name">
                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Use Folder Name for Album</Text>
                            <Text style={s.toggleSub}>Instead of the song's Album tag</Text>
                        </View>
                        <Switch value={albumFromFolder} onValueChange={v => { setAlbumFromFolderState(v); setAlbumFromFolder(v); }}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    </SubGroup>
                </Section>

                {/* Off by default: a real ALBUM tag (when tags.js finds one)
                     is normally more accurate than a folder name, so it wins
                     by default now that tags are actually read. Flip this on
                     to go back to how it worked before — folder name always
                     wins, real tag ignored for this field specifically —
                     for anyone whose library is organized by folder more
                     meaningfully than its actual tags are filled in. */}
                {/* 5. Music location */}
                {/* 6. Rescan */}
                <Section title="Music & Library">
                    <SubGroup title="Library" first>
                    <TouchableOpacity style={s.row} onPress={importSongsFlow}>
                        <Text style={s.rowLabel}>Import Songs</Text>
                        <Text style={s.rowSub}>Pick audio files from the Files app (use this if the Documents folder cannot be reached)</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.row} onPress={reload}>
                        <Text style={s.rowLabel}>Rescan Music</Text>
                        <Text style={s.rowSub}>Re-reads all folders</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.row} onPress={() => Alert.alert(
                        'Reset Playlist Screen?',
                        'This removes every playlist cover picture, puts the playlists back in alphabetical order and resets the layout to the default list. Your music is not touched.',
                        [
                            { text: 'Cancel', style: 'cancel' },
                            { text: 'Reset', style: 'destructive', onPress: async () => { await resetPlaylistScreen(); reload(); } },
                        ],
                    )}>
                        <Text style={s.rowLabel}>Reset Playlist Screen</Text>
                        <Text style={s.rowSub}>Remove covers, sort A to Z, default layout</Text>
                    </TouchableOpacity>
                    </SubGroup>
                    <SubGroup title="Music location">
                    {(showBoth || isLiveContainer) && (
                        <View style={s.locBlock}>
                            <Text style={s.locHeading}>If using LiveContainer</Text>
                            <Text style={s.locBody}>
                                Files → On My iPhone → LiveContainer → Data → Application → (SySlate's app ID) → Documents
                            </Text>
                        </View>
                    )}
                    {(showBoth || isSideStore) && (
                        <View style={s.locBlock}>
                            <Text style={s.locHeading}>If using SideStore</Text>
                            <Text style={s.locBody}>
                                Files → On My iPhone → SideStore → Data → Application → (SySlate's app ID) → Documents
                            </Text>
                            <Text style={[s.locNote, { marginTop: 6 }]}>
                                Known issue: on some SideStore installs this Documents folder shows as empty/unreachable
                                even though the path above is correct — a sandboxing limitation on SideStore's side, not
                                something adding files elsewhere (like a manually made top-level "SySlate" folder) works
                                around, since that folder isn't actually connected to the app's real storage.
                                Use Library → Import Songs to add music without needing that folder.
                            </Text>
                        </View>
                    )}
                    <View style={[s.locBlock, { borderBottomWidth: 0 }]}>
                        <Text style={s.locHeading}>This install's actual path</Text>
                        <Text style={[s.locPath, { color: theme.accent }]} selectable>
                            {(scanPath ?? '').replace('file://', '')}
                        </Text>
                        <Text style={s.locNote}>Folders become playlists. Files in the root appear in All Songs.</Text>
                        {scanError && (
                            <Text style={[s.locNote, { color: '#dc6262', marginTop: 10 }]} selectable>
                                Scan diagnostic: {scanError}
                            </Text>
                        )}
                    </View>
                    </SubGroup>
                    <SubGroup title="Performance">
                    {performanceToggle}
                    </SubGroup>
                </Section>

                {/* 7. Export/Import */}
                <Section title="Listening Stats" simple>
                    <TouchableOpacity style={s.row} onPress={() => navigation.navigate('Stats')}>
                        <Text style={s.rowLabel}>Listening Stats</Text>
                        <Text style={s.rowSub}>Plays, hours, most played songs and top artists</Text>
                    </TouchableOpacity>
                </Section>

                <Section title="Backup & Sync">
                    <TouchableOpacity style={s.row} onPress={async () => { try { await autoBackupNow(); Alert.alert('Done', 'Settings backed up. The last 3 copies are kept.'); } catch (e) { Alert.alert('Backup failed', String(e?.message)); } }}>
                        <Text style={s.rowLabel}>Back Up Now</Text>
                        <Text style={s.rowSub}>A copy is also made about once a day</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[s.row, { borderTopWidth: 1, borderTopColor: base.border }]} onPress={askRestoreBackup}>
                        <Text style={s.rowLabel}>Restore a Backup</Text>
                        <Text style={s.rowSub}>Pick one of the last 3 copies</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.row} onPress={async () => {
                        try { const json = await exportAllSettings(); await Share.share({ message: json, title: 'SySlate Settings' }); }
                        catch (e) { Alert.alert('Export failed', String(e?.message)); }
                    }}>
                        <Text style={s.rowLabel}>Export Settings</Text>
                        <Text style={s.rowSub}>Share all your settings as text</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.row} onPress={() => { setImportText(''); setShowImport(true); }}>
                        <Text style={s.rowLabel}>Import Settings</Text>
                        <Text style={s.rowSub}>Paste settings you exported</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.row} onPress={async () => {
                        try {
                            const r = await exportPicturesFile();
                            await Share.share({ url: r.uri, title: 'SySlate Pictures' });
                        } catch (e) { Alert.alert('Export failed', String(e?.message)); }
                    }}>
                        <Text style={s.rowLabel}>Export Covers & Background</Text>
                        <Text style={s.rowSub}>Save the pictures as a file to move to another device</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.row} onPress={async () => {
                        try {
                            let DocumentPicker;
                            try { DocumentPicker = require('expo-document-picker'); } catch { }
                            if (!DocumentPicker?.getDocumentAsync) { Alert.alert('Not available', 'File picking is not part of this build.'); return; }
                            const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
                            if (res.canceled || !res.assets?.[0]?.uri) return;
                            const r = await importPicturesFile(res.assets[0].uri);
                            // Pull the new background into the running app.
                            if (r.background) {
                                setBackgroundImageUri(await getBackgroundImageUri());
                                setBackgroundImageEnabled(await getBackgroundImageEnabled());
                            }
                            reload();
                            Alert.alert('Done', `${r.covers} playlist cover${r.covers === 1 ? '' : 's'} imported${r.background ? ' and the background' : ''}.`);
                        } catch (e) { Alert.alert('Import failed', 'That is not a SySlate pictures file.'); }
                    }}>
                        <Text style={s.rowLabel}>Import Covers & Background</Text>
                        <Text style={s.rowSub}>Pick the pictures file you exported</Text>
                    </TouchableOpacity>
                </Section>

                </>)}

                {/* No Xcode on a GH-Actions/sideloaded build means every
                    [RAMP-DEBUG]/[SEEK-DEBUG] console line so far has been
                    invisible — this is the way in to actually see them. */}
                <Section title="Reset" simple>
                    <TouchableOpacity style={[s.resetRow, { borderTopWidth: 0 }]} onPress={resetEverything} activeOpacity={0.6}>
                        <Text style={[s.resetText, { color: theme.accent }]}>Reset All Settings to Default</Text>
                    </TouchableOpacity>
                </Section>

                <Section title="Debug">
                    <TouchableOpacity style={s.row} onPress={() => navigation.navigate('DebugLog')}>
                        <Text style={s.rowLabel}>Debug Log</Text>
                        <Text style={s.rowSub}>Console output from this session</Text>
                    </TouchableOpacity>
                </Section>

            </SettingsViewCtx.Provider>
            </ScrollView>
                </>
            )}

            {/* This was still commented out even after the EQ Presets *list*
                section above got un-hidden — "+ Add Custom Preset" flipped
                showNewEQ to true, but the sheet it's supposed to open was
                dead code, so nothing ever appeared. That's the actual
                "adding a custom preset doesn't work" bug. */}
            <BottomSheet visible={showNewEQ} onClose={closeEQSheet} header={<Text style={[s.sheetTitle, { paddingHorizontal: 24 }]}>{editingId ? 'Edit EQ Preset' : 'New EQ Preset'}</Text>}>
                <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, paddingHorizontal: 20 }}>
                    {editingIsBuiltIn ? (
                        // Built-in presets keep their fixed name — editing
                        // overwrites its bands, not its identity — so this
                        // is a plain label, not an editable field.
                        <View style={[s.nameInput, { borderColor: base.border }]}>
                            <Text style={{ color: base.textFaint, fontSize: 15 }}>{newName}</Text>
                        </View>
                    ) : (
                        <TextInput
                            style={[s.nameInput, { borderColor: theme.accent }]}
                            value={newName} onChangeText={setNewName}
                            placeholder="Preset name..." placeholderTextColor="#444"
                        />
                    )}
                    <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
                        {/* Per direct feedback: premade preset bands should
                            not be draggable at all — bands are only ever
                            editable for a genuine custom preset now.
                            (Built-ins previously wrote a per-id override on
                            drag via eqOverrides; that mechanism still exists
                            for now — see resetEditingPresetToDefault below —
                            but nothing can create a NEW override anymore.) */}
                        {newBands.map((val, i) => (
                            <View key={i} style={s.bandRow}>
                                <Text style={s.bandHz}>{BAND_HZ[i]}</Text>
                                <PureSlider
                                    style={{ flex: 1, marginHorizontal: 8 }}
                                    minimumValue={EQ_MIN} maximumValue={EQ_MAX} step={0.5} value={val}
                                    disabled={editingIsBuiltIn}
                                    onValueChange={v => { const b = [...newBands]; b[i] = v; setNewBands(b); }}
                                    minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent}
                                />
                                <Text style={s.bandVal}>{val > 0 ? '+' : ''}{val.toFixed(1)}</Text>
                            </View>
                        ))}
                    </ScrollView>
                    {editingIsBuiltIn && !!eqOverrides[editingId] && (
                        <TouchableOpacity style={[s.resetBtn, { borderColor: base.border }]} onPress={resetEditingPresetToDefault}>
                            <Text style={[s.resetBtnText, { color: base.textFaint }]}>Reset to Default</Text>
                        </TouchableOpacity>
                    )}
                    <TouchableOpacity style={[s.saveBtn, { backgroundColor: theme.accent }]} onPress={savePreset}>
                        <Text style={[s.saveBtnText, { color: theme.onAccent }]}>{editingId ? 'Save Changes' : 'Save Preset'}</Text>
                    </TouchableOpacity>
                </KeyboardAvoidingView>
            </BottomSheet>

            <BottomSheet visible={showImport} onClose={() => setShowImport(false)}>
                <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, paddingHorizontal: 20 }}>
                    <Text style={s.sheetTitle}>Import Settings</Text>
                    <Text style={{ color: base.textFaint, fontSize: 13, marginBottom: 12 }}>Paste exported JSON:</Text>
                    <TextInput
                        style={[s.nameInput, { height: 120, textAlignVertical: 'top', borderColor: theme.accent }]}
                        value={importText} onChangeText={setImportText}
                        placeholder="Paste JSON here..." placeholderTextColor="#333"
                        multiline autoCorrect={false} autoCapitalize="none"
                    />
                    <TouchableOpacity style={[s.saveBtn, { backgroundColor: theme.accent }]} onPress={async () => {
                        try {
                            await importAllSettings(importText);
                            setShowImport(false);
                            Alert.alert('Done', 'Settings imported. Restart to see all changes.');
                        } catch { Alert.alert('Import failed', 'Invalid JSON.'); }
                    }}>
                        <Text style={[s.saveBtnText, { color: theme.onAccent }]}>Apply Settings</Text>
                    </TouchableOpacity>
                </KeyboardAvoidingView>
            </BottomSheet>
        </ScreenBackground>
    );
}

function GroupHeader({ title, onReset, hidden, onToggleHidden }) {
    const view = useContext(SettingsViewCtx);
    const { base, theme } = useTheme();
    if (view.q || view.mode === 'simple') return null;
    return (
        <View style={{ marginTop: 26, marginBottom: 12, marginHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: base.surface }}>
                <Text style={{ color: base.text, fontSize: 22, fontWeight: '700' }}>{title}</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
                {onToggleHidden && (
                    <TouchableOpacity onPress={onToggleHidden} activeOpacity={0.6} hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                        style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: base.surface }}>
                        <Text style={{ color: theme.accent, fontSize: 13, fontWeight: '700' }}>{hidden ? 'Show' : 'Hide'}</Text>
                    </TouchableOpacity>
                )}
                {onReset && (
                    <TouchableOpacity onPress={onReset} activeOpacity={0.6} hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                        style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: base.surface }}>
                        <Text style={{ color: theme.accent, fontSize: 13, fontWeight: '700' }}>Reset</Text>
                    </TouchableOpacity>
                )}
            </View>
        </View>
    );
}

// Words each Section answers to in the search box (besides its title).
const SECTION_KW = {
    'EQ Presets': 'equalizer eq bass treble sound tone',
    'Volume Levelling': 'volume normalize normalization loudness match replaygain tag pre-amp preamp gain',
    'Crossfade & Fades': 'crossfade fade ramp pause play skip transition silence trim end of song',
    'Playback': 'shuffle random smart dumb cycle order queue up next priority previous back restart track',
    'Lists': 'sort play count songs covers list artists playlists layout grid cards refresh title all search buttons playlist screen header',
    'Player': 'player buttons speed sleep timer eq queue shuffle loop cover lyrics disc vinyl cd dj scratch rpm auto show opens spin touch',
    'Look': 'shadow outline border looks style cover pill mini player shape rounded square minimal classic bold sharp covers artwork pictures screen awake top bar color',
    'Accent Color': 'accent color theme',
    'Base Color': 'base color dark light theme',
    'Custom Background': 'background image picture wallpaper',
    'Artists & Albums': 'artists separator split join format album folder name',
    'Music & Library': 'music location folder path files library rescan refresh scan performance older iphone slow lag fast battery',
    'Listening Stats': 'stats listening plays most played hours top',
    'Backup & Sync': 'backup restore export import settings covers pictures auto transfer device',
    'Reset': 'reset defaults all',
    'Debug': 'debug log',
};
const SECTION_TITLES = Object.keys(SECTION_KW);
const sectionMatches = (title, q) => {
    const hay = (title + ' ' + (SECTION_KW[title] || '')).toLowerCase();
    return q.split(/\s+/).filter(Boolean).every(w => hay.includes(w));
};
const SettingsViewCtx = React.createContext({ mode: 'advanced', q: '' });

// Small label that separates the parts of a merged section.
const subGroupOpen = {};   // remembers which groups are open while the app runs
function SubGroup({ title, first, children }) {
    const { base } = useTheme();
    const { q } = useContext(SettingsViewCtx);
    const [, force] = useState(0);
    const open = !!q || !!subGroupOpen[title];
    return (
        <>
            <TouchableOpacity activeOpacity={0.6} onPress={() => { subGroupOpen[title] = !open; force(n => n + 1); }}
                style={{ paddingHorizontal: 24, paddingTop: 14, paddingBottom: 10, borderTopWidth: first ? 0 : 1, borderTopColor: base.border, flexDirection: 'row', alignItems: 'center' }}>
                <Text style={{ color: base.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>{title}</Text>
                <Text style={{ color: base.textDim, fontSize: 18, fontWeight: '600', transform: [{ rotate: open ? '90deg' : '0deg' }] }}>›</Text>
            </TouchableOpacity>
            {open ? children : null}
        </>
    );
}

// `simple`: also shown in the Simple view. `only="simple"`: shown only there.
function Section({ title, children, simple, only }) {
    const { base } = useTheme();
    const { mode, q } = useContext(SettingsViewCtx);
    const s = useMemo(() => makeStyles(base), [base]);
    if (q) { if (only === 'simple' || !sectionMatches(title, q)) return null; }
    else if (only === 'simple') { if (mode !== 'simple') return null; }
    else if (mode === 'simple' && !simple) return null;
    return (
        <View style={s.section}>
            {/* Small backing chip behind the label, same fill as the section
                body below it — otherwise the label is bare text straight over
                whatever's behind the screen (including a custom background
                image, where it was reported as barely readable). */}
            <View style={[s.sectionLabelWrap, { backgroundColor: base.surface }]}>
                <Text style={s.sectionLabel}>{title}</Text>
            </View>
            <View style={[s.sectionBody, { backgroundColor: base.surface, borderColor: base.border }]}>
                {children}
            </View>
        </View>
    );
}

const HIT = { top: 12, bottom: 12, left: 12, right: 12 };

const makeStyles = (base) => StyleSheet.create({
    container: { flex: 1 },
    modeBar: { flexDirection: 'row', marginHorizontal: 20, marginTop: 14, marginBottom: 10, padding: 4, borderRadius: 14, backgroundColor: base.surface },
    modeBtn: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 11 },
    modeBtnText: { color: base.text, fontSize: 14, fontWeight: '700' },
    searchBox: { marginHorizontal: 20, marginBottom: 16, borderRadius: 12, backgroundColor: base.surface, paddingHorizontal: 14 },
    searchInput: { color: base.text, fontSize: 15, paddingVertical: 11 },
    noMatch: { color: base.textFaint, textAlign: 'center', marginTop: 20, fontSize: 14 },
    resetRow: { borderTopWidth: 1, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center' },
    resetText: { color: base.textFaint, fontSize: 14, fontWeight: '600' },
    // Same numbers as the Playlists and All Songs top bars (title row 40 tall,
    // 8 in from the sides plus 16 for the title, bar bottom at the same spot).
    header: { paddingTop: TOP_PAD, paddingHorizontal: 8, paddingBottom: 8 + TOP_FADE, zIndex: 5 },
    titleBox: { height: 40, marginLeft: 16, justifyContent: 'center' },
    title: { color: base.text, fontSize: 28, fontWeight: '700' },
    section: { marginBottom: 24 },
    sectionLabelWrap: { alignSelf: 'flex-start', marginLeft: 24, marginBottom: 6, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 6 },
    sectionLabel: { color: base.textDim, fontSize: 11, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase' },
    sectionBody: { backgroundColor: base.surface, borderTopWidth: 1, borderBottomWidth: 1, borderColor: base.border },
    row: { paddingVertical: 16, paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: base.border },
    rowLabel: { color: base.text, fontSize: 15, fontWeight: '500' },
    rowSub: { color: base.textFaint, fontSize: 12, marginTop: 3 },
    modeRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16, paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: base.border },
    modeLabel: { color: base.text, fontSize: 15, fontWeight: '500' },
    modeSub: { color: base.textFaint, fontSize: 12, marginTop: 2 },
    radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: base.border },
    sliderSub: { color: base.textDim, fontSize: 13, fontWeight: '700', paddingHorizontal: 24, paddingTop: 14 },
    sliderNote: { color: base.textFaint, fontSize: 12, paddingHorizontal: 24, marginTop: 2 },
    sliderVal: { fontSize: 22, fontWeight: '700', textAlign: 'center', marginTop: 6 },
    // Matches sliderSub/sliderNote/sliderEnds' paddingHorizontal (24) — was
    // 16, meaning the slider extended 8px further out on each side than the
    // text above and below it, instead of lining up with the same margin.
    slider: { marginHorizontal: 24, marginTop: 2 },
    sliderEnds: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 24, paddingBottom: 12 },
    sliderEnd: { color: base.textFaint, fontSize: 11 },
    toggleRow: { flexDirection: 'row', alignItems: 'center', padding: 18, paddingHorizontal: 24, borderTopWidth: 1, borderTopColor: base.border },
    toggleLabel: { color: base.text, fontSize: 15, fontWeight: '500' },
    toggleSub: { color: base.textFaint, fontSize: 12, marginTop: 3 },
    // Header block for a multi-option setting (chips/slider below, so it
    // can't collapse into a single toggleRow) — same label/sub typography
    // and left inset as toggleRow, just without the switch on the right.
    settingHeader: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 6 },
    swatchRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: SWATCH_GAP },
    // Matches the sort-chip pattern used in All Songs / Playlist Detail —
    // same shape, same interaction, for the same kind of "pick one of a
    // few options" control.
    sortRow: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 24, paddingBottom: 16, gap: 8 },
    sortChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: base.border },
    sortChipText: { color: base.textDim, fontSize: 13, fontWeight: '600' },
    swatch: { justifyContent: 'center', alignItems: 'center' },
    swatchActive: { borderWidth: 3, borderColor: base.text },
    // Explicit fixed widths for the checkbox/delete-✕ instead of letting
    // them size from content — with a delete icon now potentially sharing
    // the same half-width chip as a checkbox + name (customs didn't
    // previously need to fit all three in 50% width, only checkbox+name
    // did), an unconstrained icon width was the main way this could start
    // wrapping/overlapping onto two lines depending on name length. The
    // name itself gets flex:1 on its own wrapping TouchableOpacity so it's
    // the only element that ever shrinks/truncates (numberOfLines={1}),
    // never the checkbox or delete icon.
    eqGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingVertical: 8, paddingHorizontal: 8 },
    eqChip: { width: '50%', flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, minHeight: 40 },
    checkWrapGrid: { width: 22, marginRight: 10 },
    eqChipNameWrap: { flex: 1, paddingRight: 4 },
    eqChipName: { color: base.text, fontSize: 14 },
    checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, justifyContent: 'center', alignItems: 'center' },
    eqDelWrap: { width: 22, alignItems: 'center' },
    eqDel: { color: base.textFaint, fontSize: 15 },
    addBtn: { margin: 14, padding: 16, borderRadius: 12, borderWidth: 1.5, alignItems: 'center' },
    addBtnText: { fontSize: 15, fontWeight: '600' },
    eqButtonRow: { flexDirection: 'row' },
    eqButtonHalf: { flex: 1, margin: 7 },
    locBlock: { padding: 16, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: base.border },
    locHeading: { color: base.textDim, fontSize: 12, fontWeight: '700', marginBottom: 4 },
    locBody: { color: base.textFaint, fontSize: 13, lineHeight: 20 },
    locPath: { fontSize: 11, marginTop: 4, lineHeight: 16 },
    locNote: { color: base.textFaint, fontSize: 11, marginTop: 8, lineHeight: 16 },
    sheetTitle: { color: base.text, fontSize: 16, fontWeight: '700', marginBottom: 4 },
    nameInput: { backgroundColor: base.border, borderRadius: 10, padding: 14, color: base.text, fontSize: 15, borderWidth: 1, marginBottom: 12 },
    bandRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 2 },
    bandHz: { color: base.textFaint, fontSize: 11, width: 36, textAlign: 'right', marginRight: 4 },
    bandVal: { color: base.textDim, fontSize: 11, width: 40, textAlign: 'right' },
    saveBtn: { borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 14 },
    saveBtnText: { fontSize: 16, fontWeight: '700' },
    resetBtn: { borderRadius: 14, padding: 14, alignItems: 'center', marginTop: 10, borderWidth: 1 },
    resetBtnText: { fontSize: 14, fontWeight: '600' },
});
