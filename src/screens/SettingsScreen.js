import React, { useState, useEffect } from 'react';
import {
    View, Text, StyleSheet, ScrollView, Switch,
    TouchableOpacity, StatusBar, TextInput,
    Share, Alert, KeyboardAvoidingView, Platform, Dimensions,
} from 'react-native';
import BottomSheet from '../components/BottomSheet';
import { useLibrary } from '../context/LibraryContext';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme, THEMES, BASE_COLORS } from '../context/ThemeContext';
import { squircle } from '../utils/squircle';
import PureSlider from '../components/PureSlider';
import { BUILT_IN_PRESETS, BAND_HZ, BAND_COUNT } from '../utils/eq';
import {
    getCrossfade, setCrossfade,
    getSkipCrossfade, setSkipCrossfade,
    getVolNorm, setVolNorm,
    getAudioRamp, setAudioRamp,
    getRampOnPause, setRampOnPause,
    getCustomPresets, setCustomPresets,
    getHiddenPresets, setHiddenPresets,
    getShowPlayCount, setShowPlayCount,
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
    const { shuffleMode, changeShuffleMode } = usePlayback();
    const { reload, scanPath, scanError } = useLibrary();
    const { themeId, setTheme, theme, baseId, setBase, base } = useTheme();

    const [cf, setCf] = useState(3.0);
    const [skipCf, setSkipCf] = useState(0.5);
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
    const [showPlayCount, setSPC] = useState(true);

    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        (async () => {
            setCf(await getCrossfade());
            setSkipCf(await getSkipCrossfade());
            setVN(await getVolNorm());
            setRamp(await getAudioRamp());
            setRampPause(await getRampOnPause());
            setCP(await getCustomPresets());
            setHP(await getHiddenPresets());
            setSPC(await getShowPlayCount());
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
            id === 'white' && { borderWidth: 1, borderColor: '#444' }]}>
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
            <ScrollView contentContainerStyle={{ paddingBottom: 160 }}>
                {/* 1. EQ — built-in presets as a condensed 2-wide grid, custom ones as a list below */}
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

                {/* 2. Audio — everything that fades/ramps volume, plus normalization,
                     all together under one heading in the spot Crossfade used to be.
                     ("Crossfade" was a misnomer — nothing here overlaps two tracks,
                     it's all fade/ramp, so it's named accordingly.) */}
                <Section title="Audio">
                    <Text style={s.sliderSub}>Audio Ramp — End of Track</Text>
                    <Text style={s.sliderNote}>Fades out when a track ends naturally, fades the next one in</Text>
                    <Text style={[s.sliderVal, { color: theme.accent }]}>{cf.toFixed(1)}s</Text>
                    <PureSlider style={s.slider} minimumValue={0} maximumValue={6} step={0.5} value={cf}
                        onValueChange={setCf} onSlidingComplete={v => { setCf(v); setCrossfade(v); }}
                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                    <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>6s</Text></View>

                    <Text style={[s.sliderSub, { paddingTop: 20 }]}>Audio Ramp — On Skip</Text>
                    <Text style={s.sliderNote}>Softens manual skips, both out and back in</Text>
                    <Text style={[s.sliderVal, { color: theme.accent }]}>{skipCf.toFixed(1)}s</Text>
                    <PureSlider style={s.slider} minimumValue={0} maximumValue={3} step={0.5} value={skipCf}
                        onValueChange={setSkipCf} onSlidingComplete={v => { setSkipCf(v); setSkipCrossfade(v); }}
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
                            <Text style={s.toggleSub}>Fade out when pausing too</Text>
                        </View>
                        <Switch value={rampPause} onValueChange={v => { setRampPause(v); setRampOnPause(v); }}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Volume Normalization</Text>
                            <Text style={s.toggleSub}>Equalizes loudness between tracks</Text>
                        </View>
                        <Switch value={volNorm} onValueChange={v => { setVN(v); setVolNorm(v); }}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                </Section>

                {/* 3. Shuffle */}
                <Section title="Shuffle Mode">
                    {MODES.map(m => (
                        <TouchableOpacity key={m.id} style={s.modeRow} onPress={() => changeShuffleMode(m.id)}>
                            <View style={{ flex: 1 }}>
                                <Text style={s.modeLabel}>{m.label}</Text>
                                <Text style={s.modeSub}>{m.sub}</Text>
                            </View>
                            <View style={[s.radio, shuffleMode === m.id && { borderColor: theme.accent, backgroundColor: theme.accent }]} />
                        </TouchableOpacity>
                    ))}
                </Section>

                {/* Between Shuffle and Accent Color, per request. Play counts are
                     always tracked regardless of this setting — it only controls
                     whether the number is shown. */}
                <Section title="Play Count">
                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Show Play Count</Text>
                            <Text style={s.toggleSub}>Next to songs in a playlist, and on the player</Text>
                        </View>
                        <Switch value={showPlayCount} onValueChange={v => { setSPC(v); setShowPlayCount(v); }}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
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
                                Files → On My iPhone → SySlate, appearing as its own top-level app folder.
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

            <BottomSheet visible={showNewEQ} onClose={() => setShowNewEQ(false)}>
                <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, paddingHorizontal: 20 }}>
                    <Text style={s.sheetTitle}>New EQ Preset</Text>
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
    slider: { marginHorizontal: 16, marginTop: 2 },
    sliderEnds: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 24, paddingBottom: 12 },
    sliderEnd: { color: '#444', fontSize: 11 },
    toggleRow: { flexDirection: 'row', alignItems: 'center', padding: 18, paddingHorizontal: 24, borderTopWidth: 1, borderTopColor: '#141414' },
    toggleLabel: { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
    toggleSub: { color: '#555', fontSize: 12, marginTop: 3 },
    swatchRow: { flexDirection: 'row', justifyContent: 'space-between' },
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
    sheetTitle: { color: '#e5e5e5', fontSize: 16, fontWeight: '700', marginBottom: 16 },
    nameInput: { backgroundColor: '#1a1a1a', borderRadius: 10, padding: 14, color: '#e5e5e5', fontSize: 15, borderWidth: 1, marginBottom: 12 },
    bandRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 2 },
    bandHz: { color: '#555', fontSize: 11, width: 36, textAlign: 'right', marginRight: 4 },
    bandVal: { color: '#888', fontSize: 11, width: 40, textAlign: 'right' },
    saveBtn: { borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 14 },
    saveBtnText: { fontSize: 16, fontWeight: '700' },
});
