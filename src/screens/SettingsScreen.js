import React, { useState, useEffect, useRef } from 'react';
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
    getVolNorm, setVolNorm,
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
} from '../utils/storage';

const SCREEN_W = Dimensions.get('window').width;
const SWATCH_GAP = 12;
// Fills the row edge-to-edge (space-between) instead of a smaller centered
// cluster with empty margin on the sides — matches the EQ preset grid's
// full-width feel.
const SWATCH_SIZE = Math.floor((SCREEN_W - 32 - SWATCH_GAP * 4) / 5);
const BASE_SWATCH_SIZE = Math.floor((SCREEN_W - 32 - SWATCH_GAP * 3) / 4);

export default function SettingsScreen() {
    const { changeShuffleMode } = usePlayback();
    const { reload, scanPath, scanError } = useLibrary();
    const { themeId, setTheme, theme, baseId, setBase, base } = useTheme();
    const scrollRef = useRef(null);
    useScrollToTop(scrollRef);

    const [eotRamp, setEotRampState] = useState(3.0);
    const [skipRamp, setSkipRampState] = useState(0.5);
    const [volNorm, setVN] = useState(true);
    const [ramp, setRamp] = useState(0);
    const [rampPause, setRampPause] = useState(false);
    const [customPresets, setCP] = useState([]);
    const [hiddenPresets, setHP] = useState([]);
    const [showNewEQ, setShowNewEQ] = useState(false);
    const [newName, setNewName] = useState('');
    const [newBands, setNewBands] = useState(new Array(BAND_COUNT).fill(0));
    const [showImport, setShowImport] = useState(false);
    const [importText, setImportText] = useState('');
    const { showPlayCount, setShowPlayCount, showSongCovers, setShowSongCovers, artistSeparator, setArtistSeparator, lyricsMode, setLyricsMode, lyricsResyncSec, setLyricsResyncSec, lyricsOffsetSec, setLyricsOffsetSec, keepScreenAwake, setKeepScreenAwake, coverShape, setCoverShape } = usePreferences();

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

    useEffect(() => {
        (async () => {
            setEotRampState(await getEndOfTrackRamp());
            setSkipRampState(await getSkipRamp());
            setVN(await getVolNorm());
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
    const baseEntries = Object.entries(BASE_COLORS);

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

    const renderBaseSwatch = ([id, b]) => (
        <TouchableOpacity key={id} onPress={() => setBase(id)}
            style={[s.swatch, {
                width: BASE_SWATCH_SIZE, height: BASE_SWATCH_SIZE, borderRadius: squircle(BASE_SWATCH_SIZE),
                backgroundColor: b.bg, borderWidth: 1, borderColor: b.border,
            }, baseId === id && s.swatchActive]}>
            {baseId === id && <Text style={{ color: theme.accent, fontWeight: '700', fontSize: 13 }}>✓</Text>}
        </TouchableOpacity>
    );

    return (
        <View style={[s.container, { backgroundColor: base.bg }]}>
            <StatusBar barStyle="light-content" />
            <View style={s.header}><Text style={s.title}>Settings</Text></View>
            {!loaded ? null : (
                <>
            <ScrollView ref={scrollRef} contentContainerStyle={{ paddingBottom: 160 }}>
                {/*
                EQ hidden — not supported by react-native-track-player, so
                presets never did anything audible.
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
                */}

                {/* 2. Audio — everything that fades/ramps volume, plus normalization,
                     all together under one heading in the spot Crossfade used to be.
                     ("Crossfade" was a misnomer — nothing here overlaps two tracks,
                     it's all fade/ramp, so it's named accordingly.) */}
                <Section title="Audio">
                    <Text style={s.sliderSub}>Audio Ramp — End of Track</Text>
                    <Text style={s.sliderNote}>Fades out when a track ends naturally, fades the next one in</Text>
                    <Text style={[s.sliderVal, { color: theme.accent }]}>{eotRamp.toFixed(1)}s</Text>
                    <PureSlider style={s.slider} minimumValue={0} maximumValue={6} step={0.5} value={eotRamp}
                        onValueChange={setEotRampState} onSlidingComplete={v => { setEotRampState(v); setEndOfTrackRamp(v); }}
                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                    <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>6s</Text></View>

                    <Text style={[s.sliderSub, { paddingTop: 20 }]}>Audio Ramp — On Skip</Text>
                    <Text style={s.sliderNote}>Softens manual skips, both out and back in</Text>
                    <Text style={[s.sliderVal, { color: theme.accent }]}>{skipRamp.toFixed(1)}s</Text>
                    <PureSlider style={s.slider} minimumValue={0} maximumValue={3} step={0.5} value={skipRamp}
                        onValueChange={setSkipRampState} onSlidingComplete={v => { setSkipRampState(v); setSkipRamp(v); }}
                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                    <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>3s</Text></View>

                    <Text style={[s.sliderSub, { paddingTop: 20 }]}>Audio Ramp — On Play</Text>
                    <Text style={s.sliderNote}>Fade-in used any time playback starts fresh</Text>
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
                    {/* Volume Normalization hidden — never actually wired to
                        the playback pipeline anywhere; react-native-track-player
                        has no built-in loudness normalization to hook it up to,
                        so this toggle never did anything audible either. */}
                    {/* <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Volume Normalization</Text>
                            <Text style={s.toggleSub}>Equalizes loudness between tracks</Text>
                        </View>
                        <Switch value={volNorm} onValueChange={v => { setVN(v); setVolNorm(v); }}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View> */}
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
                            <Text style={s.toggleSub}>Carries over songs you've queued up next instead of clearing them</Text>
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
                            <Text style={s.toggleSub}>Embedded cover art next to songs in a list</Text>
                        </View>
                        <Switch value={showSongCovers} onValueChange={setShowSongCovers}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={[s.toggleRow, { borderTopWidth: 1, borderTopColor: '#1a1a1a' }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Show Play Count</Text>
                            <Text style={s.toggleSub}>Next to songs in a playlist, and on the player</Text>
                        </View>
                        <Switch value={showPlayCount} onValueChange={setShowPlayCount}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={[s.toggleRow, { borderTopWidth: 1, borderTopColor: '#1a1a1a' }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Keep Screen Awake</Text>
                            <Text style={s.toggleSub}>Only while a song is actively playing, not just while the app's open</Text>
                        </View>
                        <Switch value={keepScreenAwake} onValueChange={setKeepScreenAwake}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={[s.toggleRow, { borderTopWidth: 1, borderTopColor: '#1a1a1a' }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Rounded Cover Art</Text>
                            <Text style={s.toggleSub}>Player, mini player, playlists, and song lists — off for square, sharp corners</Text>
                        </View>
                        <Switch value={coverShape === 'rounded'} onValueChange={v => setCoverShape(v ? 'rounded' : 'square')}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
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
                        <Text style={s.toggleSub}>Splits an artist tag like "A; B" into separate artists</Text>
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
                        <Text style={s.toggleSub}>Synced lyrics from a matching .lrc file next to the song, on the Player screen</Text>
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
                            <Text style={[s.sliderVal, { color: theme.accent }]}>{lyricsResyncSec.toFixed(0)}s</Text>
                            <PureSlider style={s.slider} minimumValue={0} maximumValue={12} step={1} value={lyricsResyncSec}
                                onSlidingComplete={setLyricsResyncSec}
                                minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                            <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>12s</Text></View>
                            <Text style={[s.sliderSub, { paddingTop: 14 }]}>Sync Offset</Text>
                            <Text style={s.sliderNote}>
                                If a song's lyrics are consistently early or late, nudge them —
                                positive shows each line sooner, negative later
                            </Text>
                            <Text style={[s.sliderVal, { color: theme.accent }]}>
                                {lyricsOffsetSec > 0 ? '+' : ''}{lyricsOffsetSec.toFixed(1)}s
                            </Text>
                            <PureSlider style={s.slider} minimumValue={-3} maximumValue={3} step={0.5} value={lyricsOffsetSec}
                                onSlidingComplete={setLyricsOffsetSec}
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
                            Always jump to the previous track, or restart the current
                            track (going to the previous one only if you're still near
                            its start)
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
                                Pressing Previous within this many seconds of the track
                                starting goes to the previous track; pressing it any later
                                restarts the current track instead
                            </Text>
                            <Text style={[s.sliderVal, { color: theme.accent }]}>{restartThreshold.toFixed(0)}s</Text>
                            <PureSlider style={s.slider} minimumValue={0} maximumValue={24} step={1} value={restartThreshold}
                                onValueChange={setRestartThresholdState}
                                onSlidingComplete={v => { setRestartThresholdState(v); setRestartThresholdSec(v); }}
                                minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                            <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>12s</Text></View>
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
                    <View style={{ paddingVertical: 16, paddingHorizontal: 16 }}>
                        <View style={s.swatchRow}>
                            {baseEntries.map(renderBaseSwatch)}
                        </View>
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

            {/*
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
            */}

            <BottomSheet visible={showImport} onClose={() => setShowImport(false)}>
                <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, paddingHorizontal: 20 }}>
                    <Text style={s.sheetTitle}>Import Settings</Text>
                    <Text style={{ color: '#555', fontSize: 13, marginBottom: 12 }}>Paste exported JSON:</Text>
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
        </View>
    );
}

function Section({ title, children }) {
    const { base } = useTheme();
    return (
        <View style={s.section}>
            <Text style={s.sectionLabel}>{title}</Text>
            <View style={[s.sectionBody, { backgroundColor: base.surface, borderColor: base.border }]}>{children}</View>
        </View>
    );
}

const HIT = { top: 12, bottom: 12, left: 12, right: 12 };

const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0a0a0a' },
    header: { paddingTop: 60, paddingHorizontal: 24, paddingBottom: 20 },
    title: { color: '#e5e5e5', fontSize: 28, fontWeight: '700' },
    section: { marginBottom: 24 },
    sectionLabel: { color: '#555', fontSize: 11, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', paddingHorizontal: 24, marginBottom: 6 },
    sectionBody: { backgroundColor: '#0f0f0f', borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#1a1a1a' },
    row: { paddingVertical: 16, paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: '#141414' },
    rowLabel: { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
    rowSub: { color: '#555', fontSize: 12, marginTop: 3 },
    modeRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16, paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: '#141414' },
    modeLabel: { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
    modeSub: { color: '#555', fontSize: 12, marginTop: 2 },
    radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: '#333' },
    sliderSub: { color: '#888', fontSize: 13, fontWeight: '700', paddingHorizontal: 24, paddingTop: 14 },
    sliderNote: { color: '#555', fontSize: 12, paddingHorizontal: 24, marginTop: 2 },
    sliderVal: { fontSize: 22, fontWeight: '700', textAlign: 'center', marginTop: 6 },
    // Matches sliderSub/sliderNote/sliderEnds' paddingHorizontal (24) — was
    // 16, meaning the slider extended 8px further out on each side than the
    // text above and below it, instead of lining up with the same margin.
    slider: { marginHorizontal: 24, marginTop: 2 },
    sliderEnds: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 24, paddingBottom: 12 },
    sliderEnd: { color: '#444', fontSize: 11 },
    toggleRow: { flexDirection: 'row', alignItems: 'center', padding: 18, paddingHorizontal: 24, borderTopWidth: 1, borderTopColor: '#141414' },
    toggleLabel: { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
    toggleSub: { color: '#555', fontSize: 12, marginTop: 3 },
    // Header block for a multi-option setting (chips/slider below, so it
    // can't collapse into a single toggleRow) — same label/sub typography
    // and left inset as toggleRow, just without the switch on the right.
    settingHeader: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 6 },
    swatchRow: { flexDirection: 'row', justifyContent: 'space-between' },
    // Matches the sort-chip pattern used in All Songs / Playlist Detail —
    // same shape, same interaction, for the same kind of "pick one of a
    // few options" control.
    sortRow: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 24, paddingBottom: 16, gap: 8 },
    sortChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#1a1a1a' },
    sortChipText: { color: '#888', fontSize: 13, fontWeight: '600' },
    swatch: { justifyContent: 'center', alignItems: 'center' },
    swatchActive: { borderWidth: 3, borderColor: '#fff' },
    eqGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingVertical: 8, paddingHorizontal: 8 },
    eqChip: { width: '50%', flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12 },
    eqChipName: { color: '#e5e5e5', fontSize: 14, marginLeft: 10, flexShrink: 1 },
    eqRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 20, borderTopWidth: 1, borderTopColor: '#141414' },
    checkWrap: { marginRight: 14 },
    checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, justifyContent: 'center', alignItems: 'center' },
    eqName: { flex: 1, color: '#e5e5e5', fontSize: 15 },
    eqDel: { color: '#555', fontSize: 16 },
    addBtn: { margin: 14, padding: 16, borderRadius: 12, borderWidth: 1.5, alignItems: 'center' },
    addBtnText: { fontSize: 15, fontWeight: '600' },
    locBlock: { padding: 16, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: '#141414' },
    locHeading: { color: '#888', fontSize: 12, fontWeight: '700', marginBottom: 4 },
    locBody: { color: '#555', fontSize: 13, lineHeight: 20 },
    locPath: { fontSize: 11, marginTop: 4, lineHeight: 16 },
    locNote: { color: '#333', fontSize: 11, marginTop: 8, lineHeight: 16 },
    sheetTitle: { color: '#e5e5e5', fontSize: 16, fontWeight: '700', marginBottom: 4 },
    nameInput: { backgroundColor: '#1a1a1a', borderRadius: 10, padding: 14, color: '#e5e5e5', fontSize: 15, borderWidth: 1, marginBottom: 12 },
    bandRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 2 },
    bandHz: { color: '#555', fontSize: 11, width: 36, textAlign: 'right', marginRight: 4 },
    bandVal: { color: '#888', fontSize: 11, width: 40, textAlign: 'right' },
    saveBtn: { borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 14 },
    saveBtnText: { fontSize: 16, fontWeight: '700' },
});
