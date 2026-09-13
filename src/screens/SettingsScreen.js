import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
    View, Text, StyleSheet, ScrollView, Switch,
    TouchableOpacity, StatusBar, TextInput,
    Share, Alert, KeyboardAvoidingView, Platform, Dimensions,
} from 'react-native';
import { useScrollToTop } from '@react-navigation/native';
import BottomSheet from '../components/BottomSheet';
import { useLibrary } from '../context/LibraryContext';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme, THEMES, BASE_COLORS } from '../context/ThemeContext';
import { usePreferences } from '../context/PreferencesContext';
import { squircle } from '../utils/squircle';
import PureSlider from '../components/PureSlider';
import ScreenBackground from '../components/ScreenBackground';
import { BUILT_IN_PRESETS, BAND_HZ, BAND_COUNT } from '../utils/eq';

// 'none' turns off multi-artist splitting entirely (see getArtistSeparator
// in storage.js for the default-';' reasoning).
const ARTIST_SEPARATORS = [
    { id: ';', label: ';' },
    { id: ',', label: ',' },
    { id: '/', label: '/' },
    { id: '&', label: '&' },
    { id: 'none', label: 'None' },
];

const LYRICS_MODES = [
    { id: 'off', label: 'Off' },
    { id: 'auto', label: 'Auto-show' },
    { id: 'manual', label: 'Manual' },
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
    getAudioRamp, setAudioRamp,
    getRampOnPause, setRampOnPause,
    getCustomPresets, setCustomPresets,
    getHiddenPresets, setHiddenPresets,
    getShuffleMode,
    getKeepPriorityOnPlaylistSwitch, setKeepPriorityOnPlaylistSwitch,
    getPrevButtonMode, setPrevButtonMode,
    getRestartThresholdSec, setRestartThresholdSec,
    getAlbumFromFolder, setAlbumFromFolder,
    exportAllSettings, importAllSettings,
    persistCoverImage,
} from '../utils/storage';
import * as ImagePicker from 'expo-image-picker';

const SCREEN_W = Dimensions.get('window').width;
const SWATCH_GAP = 12;
// Fills the row edge-to-edge (space-between) instead of a smaller centered
// cluster with empty margin on the sides — matches the EQ preset grid's
// full-width feel.
const SWATCH_SIZE = Math.floor((SCREEN_W - 32 - SWATCH_GAP * 4) / 5);
const BASE_SWATCH_SIZE = Math.floor((SCREEN_W - 32 - SWATCH_GAP * 4) / 5);

export default function SettingsScreen() {
    const { changeShuffleMode } = usePlayback();
    const { reload, scanPath, scanError } = useLibrary();
    const { themeId, setTheme, theme, baseId, setBase, base, isLight, toggleLightMode } = useTheme();
    const s = useMemo(() => makeStyles(base), [base]);
    const scrollRef = useRef(null);
    useScrollToTop(scrollRef);

    const [eotRamp, setEotRampState] = useState(3.0);
    const [skipRamp, setSkipRampState] = useState(0.5);
    const [ramp, setRamp] = useState(0);
    const [rampPause, setRampPause] = useState(false);
    const [customPresets, setCP] = useState([]);
    const [hiddenPresets, setHP] = useState([]);
    const [showNewEQ, setShowNewEQ] = useState(false);
    const [newName, setNewName] = useState('');
    const [newBands, setNewBands] = useState(new Array(BAND_COUNT).fill(0));
    const [showImport, setShowImport] = useState(false);
    const [importText, setImportText] = useState('');
    const { showPlayCount, setShowPlayCount, showSongCovers, setShowSongCovers, artistSeparator, setArtistSeparator, lyricsMode, setLyricsMode, lyricsResyncSec, setLyricsResyncSec, lyricsOffsetSec, setLyricsOffsetSec, keepScreenAwake, setKeepScreenAwake, coverShape, setCoverShape, showPlayerCover, setShowPlayerCover, coverShadow, setCoverShadow, backgroundImageEnabled, setBackgroundImageEnabled, backgroundImageUri, setBackgroundImageUri, crossfadeEnabled, setCrossfadeEnabled, crossfadeDuration, setCrossfadeDuration, crossfadeDurationEndOfTrack, setCrossfadeDurationEndOfTrack, withinTrackNorm, setWithinTrackNorm, betweenTrackNorm, setBetweenTrackNorm, silenceTrim, setSilenceTrim } = usePreferences();

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
    const [prevButtonMode, setPrevButtonModeState] = useState('previous_track');
    const [restartThreshold, setRestartThresholdState] = useState(3);
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
    useEffect(() => { setCrossfadeDurationLocal(crossfadeDuration); }, [crossfadeDuration]);
    // Same local-mirror pattern, now for the split-out End of Track
    // crossfade duration (was one shared "Crossfade Duration" slider —
    // split to match the Audio Ramp section's On Skip / End of Track
    // granularity just below it).
    const [crossfadeDurationEotLocal, setCrossfadeDurationEotLocal] = useState(crossfadeDurationEndOfTrack);
    useEffect(() => { setCrossfadeDurationEotLocal(crossfadeDurationEndOfTrack); }, [crossfadeDurationEndOfTrack]);

    useEffect(() => {
        (async () => {
            setEotRampState(await getEndOfTrackRamp());
            setSkipRampState(await getSkipRamp());
            setRamp(await getAudioRamp());
            setRampPause(await getRampOnPause());
            setCP(await getCustomPresets());
            setHP(await getHiddenPresets());
            setShuffleTypePref(await getShuffleMode());
            setKeepPriority(await getKeepPriorityOnPlaylistSwitch());
            setAlbumFromFolderState(await getAlbumFromFolder());
            setPrevButtonModeState(await getPrevButtonMode());
            setRestartThresholdState(await getRestartThresholdSec());
            setLoaded(true);
        })();
    }, []);

    const togglePreset = async (id) => {
        const next = hiddenPresets.includes(id)
            ? hiddenPresets.filter(x => x !== id)
            : [...hiddenPresets, id];
        setHP(next); await setHiddenPresets(next);
    };

    const deletePreset = async (id) => {
        const next = customPresets.filter(p => p.id !== id);
        setCP(next); await setCustomPresets(next);
    };

    const saveNewPreset = async () => {
        if (!newName.trim()) return;
        const id = 'custom_' + Date.now();
        const next = [...customPresets, { id, name: newName.trim(), bands: [...newBands] }];
        setCP(next); await setCustomPresets(next);
        setShowNewEQ(false); setNewName(''); setNewBands(new Array(BAND_COUNT).fill(0));
    };

    const MODES = [
        { id: 'full_cycle', label: 'Full Cycle', sub: 'All songs once before repeat' },
        { id: 'true_random', label: 'True Random', sub: 'Can repeat sooner, no fixed order' },
        { id: 'smart', label: 'Smart', sub: 'Avoids same artist back to back' },
    ];

    // Best-effort detection of which sideload tool is running this build.
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
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: false,
            quality: 0.8,
        });
        if (result.canceled || !result.assets?.[0]?.uri) return;
        const permanentUri = await persistCoverImage(result.assets[0].uri);
        setBackgroundImageUri(permanentUri);
        setBackgroundImageEnabled(true);
    };

    return (
        <ScreenBackground style={s.container}>
            <StatusBar barStyle="light-content" />
            <View style={s.header}><Text style={s.title}>Settings</Text></View>
            {!loaded ? null : (
                <>
            <ScrollView ref={scrollRef} contentContainerStyle={{ paddingBottom: 160 }}>
                {/* EQ now runs for real through AudioEngine's AVAudioUnitEQ —
                    this whole section was left commented out from the old
                    react-native-track-player era (which had no real EQ) and
                    never un-hidden. Un-hidden now, kept at the top of
                    Settings. Checking a preset here hides it from the
                    picker in EQModal; it doesn't change what's currently
                    playing. "+ Add Custom Preset" opens the band-by-band
                    builder below (sliders per BAND_HZ), already wired to
                    getCustomPresets/setCustomPresets. */}
                <Section title="EQ Presets">
                    <View style={s.eqGrid}>
                        {BUILT_IN_PRESETS.map(p => (
                            <TouchableOpacity key={p.id} style={s.eqChip} onPress={() => togglePreset(p.id)}>
                                <View style={[s.checkbox, { borderColor: theme.accent }, !hiddenPresets.includes(p.id) && { backgroundColor: theme.accent }]}>
                                    {!hiddenPresets.includes(p.id) && <Text style={{ color: theme.onAccent, fontSize: 11, fontWeight: '700' }}>✓</Text>}
                                </View>
                                <Text style={s.eqChipName} numberOfLines={1}>{p.name}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                    {customPresets.length > 0 && customPresets.map(p => (
                        <View key={p.id} style={s.eqRow}>
                            <TouchableOpacity onPress={() => togglePreset(p.id)} style={s.checkWrap}>
                                <View style={[s.checkbox, { borderColor: theme.accent }, !hiddenPresets.includes(p.id) && { backgroundColor: theme.accent }]}>
                                    {!hiddenPresets.includes(p.id) && <Text style={{ color: theme.onAccent, fontSize: 12, fontWeight: '700' }}>✓</Text>}
                                </View>
                            </TouchableOpacity>
                            <Text style={s.eqName}>{p.name}</Text>
                            <TouchableOpacity onPress={() => deletePreset(p.id)} hitSlop={HIT}>
                                <Text style={s.eqDel}>✕</Text>
                            </TouchableOpacity>
                        </View>
                    ))}
                    <TouchableOpacity style={[s.addBtn, { borderColor: theme.accent }]} onPress={() => setShowNewEQ(true)}>
                        <Text style={[s.addBtnText, { color: theme.accent }]}>+ Add Custom Preset</Text>
                    </TouchableOpacity>
                </Section>

                {/* 2. Audio — fade/ramp settings, crossfade, and normalization,
                     all together under one heading. */}
                <Section title="Audio">
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
                            <Text style={s.toggleSub}>Overlaps tracks instead of fading between them — replaces the End of Track / On Skip ramps below while it's on (Ramp on Pause/Play are unaffected)</Text>
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
                            <Text style={[s.sliderSub, { paddingTop: 20 }]}>Crossfade Duration — End of Track</Text>
                            <Text style={s.sliderNote}>Overlaps into the next track as this one ends</Text>
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
                            <PureSlider style={s.slider} minimumValue={0} maximumValue={6} step={0.5} value={crossfadeDurationEotLocal}
                                onValueChange={setCrossfadeDurationEotLocal}
                                onSlidingComplete={v => { setCrossfadeDurationEotLocal(v); setCrossfadeDurationEndOfTrack(v); }}
                                minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                            <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>6s</Text></View>

                            <Text style={[s.sliderSub, { paddingTop: 20 }]}>Crossfade Duration — On Skip</Text>
                            <Text style={s.sliderNote}>Overlaps into the next track on a manual skip</Text>
                            <Text style={[s.sliderVal, { color: theme.accent }]}>{crossfadeDurationLocal.toFixed(1)}s</Text>
                            {/* Max lowered 10→3, matching Ramp's On Skip cap.
                                minimumValue same fix as above — 0 instead of 1. */}
                            <PureSlider style={s.slider} minimumValue={0} maximumValue={3} step={0.5} value={crossfadeDurationLocal}
                                onValueChange={setCrossfadeDurationLocal}
                                onSlidingComplete={v => { setCrossfadeDurationLocal(v); setCrossfadeDuration(v); }}
                                minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                            <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>3s</Text></View>
                        </>
                    ) : (
                        <>
                            <Text style={[s.sliderSub, { paddingTop: 20 }]}>Audio Ramp — End of Track</Text>
                            <Text style={s.sliderNote}>Fades out at the end of a track, fades in the next</Text>
                            <Text style={[s.sliderVal, { color: theme.accent }]}>{eotRamp.toFixed(1)}s</Text>
                            <PureSlider style={s.slider} minimumValue={0} maximumValue={6} step={0.5} value={eotRamp}
                                onValueChange={setEotRampState} onSlidingComplete={v => { setEotRampState(v); setEndOfTrackRamp(v); }}
                                minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                            <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>6s</Text></View>

                            <Text style={[s.sliderSub, { paddingTop: 20 }]}>Audio Ramp — On Skip</Text>
                            <Text style={s.sliderNote}>Softens manual skips</Text>
                            <Text style={[s.sliderVal, { color: theme.accent }]}>{skipRamp.toFixed(1)}s</Text>
                            <PureSlider style={s.slider} minimumValue={0} maximumValue={3} step={0.5} value={skipRamp}
                                onValueChange={setSkipRampState} onSlidingComplete={v => { setSkipRampState(v); setSkipRamp(v); }}
                                minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                            <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>3s</Text></View>
                        </>
                    )}

                    <Text style={[s.sliderSub, { paddingTop: 20 }]}>Audio Ramp — On Play</Text>
                    <Text style={s.sliderNote}>Fades in whenever playback starts</Text>
                    <Text style={[s.sliderVal, { color: theme.accent }]}>{ramp.toFixed(1)}s</Text>
                    <PureSlider style={s.slider} minimumValue={0} maximumValue={3} step={0.5} value={ramp}
                        onValueChange={setRamp} onSlidingComplete={v => { setRamp(v); setAudioRamp(v); }}
                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                    <View style={s.sliderEnds}><Text style={s.sliderEnd}>Off</Text><Text style={s.sliderEnd}>3s</Text></View>

                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Ramp on Pause</Text>
                            <Text style={s.toggleSub}>Fade out on pause</Text>
                        </View>
                        <Switch value={rampPause} onValueChange={v => { setRampPause(v); setRampOnPause(v); }}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Volume Normalization</Text>
                            {/* This label used to say "Equalizes loudness between
                                tracks" — but the actual implementation (Apple's
                                Dynamics Processor) is compression WITHIN a
                                track, not loudness matching across tracks. Split
                                into two real, separate settings below. */}
                            <Text style={s.toggleSub}>Evens out loud and quiet moments within a track</Text>
                        </View>
                        <Switch value={withinTrackNorm} onValueChange={setWithinTrackNorm}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={[s.toggleRow, { borderTopWidth: 1, borderTopColor: base.border }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Match Volume Between Songs</Text>
                            <Text style={s.toggleSub}>Keeps different songs at a similar volume — a quick estimate, not exact, and only runs once per song</Text>
                        </View>
                        <Switch value={betweenTrackNorm} onValueChange={setBetweenTrackNorm}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={[s.toggleRow, { borderTopWidth: 1, borderTopColor: base.border }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Trim Silence</Text>
                            <Text style={s.toggleSub}>Skips silence at the start and end of a track</Text>
                        </View>
                        <Switch value={silenceTrim} onValueChange={setSilenceTrim}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                </Section>

                {/* 3. Shuffle */}
                <Section title="Shuffle Mode">
                    {MODES.map(m => (
                        <TouchableOpacity key={m.id} style={s.modeRow} onPress={() => { setShuffleTypePref(m.id); changeShuffleMode(m.id); }}>
                            <View style={{ flex: 1 }}>
                                <Text style={s.modeLabel}>{m.label}</Text>
                                <Text style={s.modeSub}>{m.sub}</Text>
                            </View>
                            <View style={[s.radio, shuffleTypePref === m.id && { borderColor: theme.accent, backgroundColor: theme.accent }]} />
                        </TouchableOpacity>
                    ))}
                </Section>

                <Section title="Queue">
                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Keep Priority Queue When Switching Playlists</Text>
                            <Text style={s.toggleSub}>Keeps your queued-up songs when you switch playlists</Text>
                        </View>
                        <Switch value={keepPriority} onValueChange={v => { setKeepPriority(v); setKeepPriorityOnPlaylistSwitch(v); }}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                </Section>

                {/* Between Shuffle and Accent Color, per request. Play counts are
                     always tracked regardless of this setting — it only controls
                     whether the number is shown. */}
                <Section title="Visual Settings">
                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Show Song Covers in Lists</Text>
                            <Text style={s.toggleSub}>Shows cover art next to songs in a list</Text>
                        </View>
                        <Switch value={showSongCovers} onValueChange={setShowSongCovers}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={[s.toggleRow, { borderTopWidth: 1, borderTopColor: base.border }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Show Play Count</Text>
                            <Text style={s.toggleSub}>Next to songs in a playlist, and on the player</Text>
                        </View>
                        <Switch value={showPlayCount} onValueChange={setShowPlayCount}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={[s.toggleRow, { borderTopWidth: 1, borderTopColor: base.border }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Keep Screen Awake</Text>
                            <Text style={s.toggleSub}>Only while a song is playing</Text>
                        </View>
                        <Switch value={keepScreenAwake} onValueChange={setKeepScreenAwake}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={[s.toggleRow, { borderTopWidth: 1, borderTopColor: base.border }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Rounded Cover Art</Text>
                            <Text style={s.toggleSub}>Rounds corners on art throughout the app</Text>
                        </View>
                        <Switch value={coverShape === 'rounded'} onValueChange={v => setCoverShape(v ? 'rounded' : 'square')}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={[s.toggleRow, { borderTopWidth: 1, borderTopColor: base.border }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Show Player Cover</Text>
                            <Text style={s.toggleSub}>Shows the album art on the Player screen</Text>
                        </View>
                        <Switch value={showPlayerCover} onValueChange={setShowPlayerCover}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    {showPlayerCover && (
                        <View style={[s.toggleRow, { borderTopWidth: 1, borderTopColor: base.border }]}>
                            <View style={{ flex: 1 }}>
                                <Text style={s.toggleLabel}>Cover Shadow</Text>
                                <Text style={s.toggleSub}>Adds a drop shadow around the Player cover — matches whichever corner style above is picked</Text>
                            </View>
                            <Switch value={coverShadow} onValueChange={setCoverShadow}
                                trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                        </View>
                    )}
                </Section>

                {/* Splits a tag's artist field into individual artists on this
                     character before display/search, so "Artist A; Artist B"
                     shows and searches as two artists instead of one long
                     string. 'None' turns splitting off entirely — the tag
                     displays exactly as stored, same as before this setting
                     existed. Defaults to ';' (see getArtistSeparator's own
                     comment for why that's the safe default) — songs with no
                     separator character in their tag are never affected by
                     this setting either way. */}
                <Section title="Multiple Artists">
                    <View style={s.settingHeader}>
                        <Text style={s.toggleLabel}>Artist Separator</Text>
                        <Text style={s.toggleSub}>How multiple artists are separated in your files, like "A; B"</Text>
                    </View>
                    <View style={s.sortRow}>
                        {ARTIST_SEPARATORS.map(opt => (
                            <TouchableOpacity
                                key={opt.id}
                                style={[s.sortChip, artistSeparator === opt.id && { backgroundColor: theme.accent }]}
                                onPress={() => setArtistSeparator(opt.id)}
                            >
                                <Text style={[s.sortChipText, artistSeparator === opt.id && { color: theme.onAccent }]}>
                                    {opt.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </Section>

                {/* 'Off' never attempts a .lrc lookup on the Player screen at
                     all. 'Auto-show' opens straight into lyrics (if a
                     matching .lrc file exists) whenever a track with lyrics
                     starts. 'Manual' still fetches lyrics in the background
                     so the toggle button under the cover art appears, but
                     leaves the cover showing until the user taps it. */}
                <Section title="Lyrics">
                    <View style={s.settingHeader}>
                        <Text style={s.toggleLabel}>Show Lyrics</Text>
                        <Text style={s.toggleSub}>Shows synced lyrics from a matching .lrc file</Text>
                    </View>
                    <View style={s.sortRow}>
                        {LYRICS_MODES.map(opt => (
                            <TouchableOpacity
                                key={opt.id}
                                style={[s.sortChip, lyricsMode === opt.id && { backgroundColor: theme.accent }]}
                                onPress={() => setLyricsMode(opt.id)}
                            >
                                <Text style={[s.sortChipText, lyricsMode === opt.id && { color: theme.onAccent }]}>
                                    {opt.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                    {lyricsMode !== 'off' && (
                        <>
                            <Text style={[s.sliderSub, { paddingTop: 6 }]}>Resync Delay</Text>
                            <Text style={s.sliderNote}>
                                How long the lyrics view stays where you scrolled it before
                                snapping back to follow the song automatically
                            </Text>
                            <Text style={[s.sliderVal, { color: theme.accent }]}>{lyricsResyncLocal.toFixed(0)}s</Text>
                            <PureSlider style={s.slider} minimumValue={0} maximumValue={12} step={1} value={lyricsResyncLocal}
                                onValueChange={setLyricsResyncLocal}
                                onSlidingComplete={v => { setLyricsResyncLocal(v); setLyricsResyncSec(v); }}
                                minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                            <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>12s</Text></View>
                            <Text style={[s.sliderSub, { paddingTop: 14 }]}>Sync Offset</Text>
                            <Text style={s.sliderNote}>
                                If a song's lyrics are consistently early or late, nudge them —
                                positive shows each line sooner, negative later
                            </Text>
                            <Text style={[s.sliderVal, { color: theme.accent }]}>
                                {lyricsOffsetLocal > 0 ? '+' : ''}{lyricsOffsetLocal.toFixed(1)}s
                            </Text>
                            <PureSlider style={s.slider} minimumValue={-3} maximumValue={3} step={0.5} value={lyricsOffsetLocal}
                                onValueChange={setLyricsOffsetLocal}
                                onSlidingComplete={v => { setLyricsOffsetLocal(v); setLyricsOffsetSec(v); }}
                                minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                            <View style={s.sliderEnds}><Text style={s.sliderEnd}>-3s</Text><Text style={s.sliderEnd}>+3s</Text></View>
                        </>
                    )}
                </Section>

                {/* Off by default: a real ALBUM tag (when tags.js finds one)
                     is normally more accurate than a folder name, so it wins
                     by default now that tags are actually read. Flip this on
                     to go back to how it worked before — folder name always
                     wins, real tag ignored for this field specifically —
                     for anyone whose library is organized by folder more
                     meaningfully than its actual tags are filled in. */}
                <Section title="Album From Folder Name">
                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Use Folder Name for Album</Text>
                            <Text style={s.toggleSub}>Instead of the song's own Album tag</Text>
                        </View>
                        <Switch value={albumFromFolder} onValueChange={v => { setAlbumFromFolderState(v); setAlbumFromFolder(v); }}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                </Section>

                {/* Explains itself precisely rather than leaning on "unskip" /
                     "rewind" — the button's real behavior is either "always go
                     to the previous track" or "restart this one, except right
                     near its start" — describing it in those terms up front
                     avoids needing the label to also do the explaining. */}
                <Section title="Previous Button">
                    <View style={s.settingHeader}>
                        <Text style={s.toggleLabel}>Previous Button Behavior</Text>
                        <Text style={s.toggleSub}>
                            Always go to the previous track, or restart the current one
                            if you're still near its start
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
                            <Text style={[s.sliderSub, { paddingTop: 6 }]}>Previous-Track Window</Text>
                            <Text style={s.sliderNote}>
                                Pressing Previous within this window goes back a track;
                                any later, it restarts the current one
                            </Text>
                            <Text style={[s.sliderVal, { color: theme.accent }]}>{restartThreshold.toFixed(0)}s</Text>
                            <PureSlider style={s.slider} minimumValue={0} maximumValue={24} step={1} value={restartThreshold}
                                onValueChange={setRestartThresholdState}
                                onSlidingComplete={v => { setRestartThresholdState(v); setRestartThresholdSec(v); }}
                                minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                            <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>24s</Text></View>
                        </>
                    )}
                </Section>


                {/* 4. Color — explicit 2 rows of 5, not flex-wrapped (a shrunk swatch
                     size let 6 fit per row instead of 5, leaving an uneven second row) */}
                <Section title="Accent Color">
                    <View style={{ paddingVertical: 16, paddingHorizontal: 16 }}>
                        {swatchRows.map((row, i) => (
                            <View key={i} style={[s.swatchRow, i > 0 && { marginTop: 14 }]}>
                                {row.map(renderSwatch)}
                            </View>
                        ))}
                    </View>
                </Section>

                <Section title="Base Color">
                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Light Mode</Text>
                            <Text style={s.toggleSub}>Switches to a light background — remembers your dark base color and restores it when you turn this back off</Text>
                        </View>
                        <Switch value={isLight} onValueChange={toggleLightMode}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={{ paddingVertical: 16, paddingHorizontal: 16, opacity: isLight ? 0.35 : 1 }} pointerEvents={isLight ? 'none' : 'auto'}>
                        <View style={s.swatchRow}>
                            {baseEntries.map(renderBaseSwatch)}
                        </View>
                    </View>
                </Section>

                <Section title="Custom Background">
                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Use Background Image</Text>
                            <Text style={s.toggleSub}>Replaces the background on every screen — colors stay the same</Text>
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
                            <TouchableOpacity onPress={() => { setBackgroundImageEnabled(false); setBackgroundImageUri(null); }} style={s.sortChip}>
                                <Text style={s.sortChipText}>Remove</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </Section>

                {/* 5. Music location */}
                <Section title="Music Location">
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
                </Section>

                {/* 6. Rescan */}
                <Section title="Library">
                    <TouchableOpacity style={s.row} onPress={reload}>
                        <Text style={s.rowLabel}>Rescan Music</Text>
                        <Text style={s.rowSub}>Re-reads all folders</Text>
                    </TouchableOpacity>
                </Section>

                {/* 7. Export/Import */}
                <Section title="Backup & Sync">
                    <TouchableOpacity style={s.row} onPress={async () => {
                        try { const json = await exportAllSettings(); await Share.share({ message: json, title: 'SySlate Settings' }); }
                        catch (e) { Alert.alert('Export failed', String(e?.message)); }
                    }}>
                        <Text style={s.rowLabel}>Export Settings</Text>
                        <Text style={s.rowSub}>Share EQ, audio ramp, theme…</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.row} onPress={() => { setImportText(''); setShowImport(true); }}>
                        <Text style={s.rowLabel}>Import Settings</Text>
                        <Text style={s.rowSub}>Paste exported JSON</Text>
                    </TouchableOpacity>
                </Section>
            </ScrollView>
                </>
            )}

            {/* This was still commented out even after the EQ Presets *list*
                section above got un-hidden — "+ Add Custom Preset" flipped
                showNewEQ to true, but the sheet it's supposed to open was
                dead code, so nothing ever appeared. That's the actual
                "adding a custom preset doesn't work" bug. */}
            <BottomSheet visible={showNewEQ} onClose={() => setShowNewEQ(false)} header={<Text style={[s.sheetTitle, { paddingHorizontal: 24 }]}>New EQ Preset</Text>}>
                <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, paddingHorizontal: 20 }}>
                    <TextInput
                        style={[s.nameInput, { borderColor: theme.accent }]}
                        value={newName} onChangeText={setNewName}
                        placeholder="Preset name..." placeholderTextColor="#444"
                    />
                    <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
                        {newBands.map((val, i) => (
                            <View key={i} style={s.bandRow}>
                                <Text style={s.bandHz}>{BAND_HZ[i]}</Text>
                                <PureSlider
                                    style={{ flex: 1, marginHorizontal: 8 }}
                                    minimumValue={-12} maximumValue={12} step={0.5} value={val}
                                    onValueChange={v => { const b = [...newBands]; b[i] = v; setNewBands(b); }}
                                    minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent}
                                />
                                <Text style={s.bandVal}>{val > 0 ? '+' : ''}{val.toFixed(1)}</Text>
                            </View>
                        ))}
                    </ScrollView>
                    <TouchableOpacity style={[s.saveBtn, { backgroundColor: theme.accent }]} onPress={saveNewPreset}>
                        <Text style={[s.saveBtnText, { color: theme.onAccent }]}>Save Preset</Text>
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

function Section({ title, children }) {
    const { base } = useTheme();
    const s = useMemo(() => makeStyles(base), [base]);
    return (
        <View style={s.section}>
            {/* Small backing chip behind the label, same fill as the section
                body below it — otherwise the label is bare text straight over
                whatever's behind the screen (including a custom background
                image, where it was reported as barely readable). */}
            <View style={[s.sectionLabelWrap, { backgroundColor: base.surface }]}>
                <Text style={s.sectionLabel}>{title}</Text>
            </View>
            <View style={[s.sectionBody, { backgroundColor: base.surface, borderColor: base.border }]}>{children}</View>
        </View>
    );
}

const HIT = { top: 12, bottom: 12, left: 12, right: 12 };

const makeStyles = (base) => StyleSheet.create({
    container: { flex: 1 },
    header: { paddingTop: 60, paddingHorizontal: 24, paddingBottom: 20 },
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
    eqGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingVertical: 8, paddingHorizontal: 8 },
    eqChip: { width: '50%', flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12 },
    eqChipName: { color: base.text, fontSize: 14, marginLeft: 10, flexShrink: 1 },
    eqRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 20, borderTopWidth: 1, borderTopColor: base.border },
    checkWrap: { marginRight: 14 },
    checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, justifyContent: 'center', alignItems: 'center' },
    eqName: { flex: 1, color: base.text, fontSize: 15 },
    eqDel: { color: base.textFaint, fontSize: 16 },
    addBtn: { margin: 14, padding: 16, borderRadius: 12, borderWidth: 1.5, alignItems: 'center' },
    addBtnText: { fontSize: 15, fontWeight: '600' },
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
});
