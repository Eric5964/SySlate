import React, { useState, useEffect, useContext } from 'react';
import {
    View, Text, StyleSheet, ScrollView, Switch,
    TouchableOpacity, StatusBar, Modal, TextInput,
    Share, Alert, KeyboardAvoidingView, Platform, Dimensions,
} from 'react-native';
import { LibraryContext } from '../context/LibraryContext';
import { useLibrary } from '../context/LibraryContext';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme, THEMES } from '../context/ThemeContext';
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
    exportAllSettings, importAllSettings,
} from '../utils/storage';

export default function SettingsScreen() {
    const SCREEN_W = Dimensions.get('window').width;
    const SWATCH_COLS = 5;
    const SWATCH_PADDING = 16;
    const SWATCH_GAP = 12;
    const SWATCH_SIZE = Math.floor((SCREEN_W - SWATCH_PADDING * 2 - SWATCH_GAP * (SWATCH_COLS - 1)) / SWATCH_COLS * 0.78);

    const { shuffleMode, changeShuffleMode } = usePlayback();
    const { reload, scanPath } = useLibrary();
    const { themeId, setTheme, theme } = useTheme();

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

    useEffect(() => {
        (async () => {
            setCf(await getCrossfade());
            setSkipCf(await getSkipCrossfade());
            setVN(await getVolNorm());
            setRamp(await getAudioRamp());
            setRampPause(await getRampOnPause());
            setCP(await getCustomPresets());
            setHP(await getHiddenPresets());
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
        { id: 'off', label: 'Off', sub: 'Play in order' },
        { id: 'full_cycle', label: 'Full Cycle', sub: 'All songs once before repeat' },
        { id: 'true_random', label: 'True Random', sub: 'Completely random' },
        { id: 'smart', label: 'Smart', sub: 'Avoids same artist back to back' },
    ];

    // Best-effort detection of which sideload tool is running this build.
    // LiveContainer runs apps inside its own virtualized container, which
    // shows up in the sandboxed document path; SideStore installs the app
    // as a normal standalone app. If we can't tell, show both.
    const pathLower = (scanPath ?? '').toLowerCase();
    const isLiveContainer = pathLower.includes('livecontainer');
    const isSideStore = !isLiveContainer && !!scanPath;
    const showBoth = !scanPath || (!isLiveContainer && !isSideStore);

    return (
        <View style={s.container}>
            <StatusBar barStyle="light-content" />
            {/* Header stays fixed above the scroll, matching All Songs / Playlists */}
            <View style={s.header}><Text style={s.title}>Settings</Text></View>

            <ScrollView contentContainerStyle={{ paddingBottom: 160 }}>
                {/* 1. EQ */}
                <Section title="EQ Presets">
                    {[...BUILT_IN_PRESETS, ...customPresets].map(p => (
                        <View key={p.id} style={s.eqRow}>
                            <TouchableOpacity onPress={() => togglePreset(p.id)} style={s.checkWrap}>
                                <View style={[s.checkbox, { borderColor: theme.accent }, !hiddenPresets.includes(p.id) && { backgroundColor: theme.accent }]}>
                                    {!hiddenPresets.includes(p.id) && <Text style={{ color: theme.onAccent, fontSize: 12, fontWeight: '700' }}>✓</Text>}
                                </View>
                            </TouchableOpacity>
                            <Text style={s.eqName}>{p.name}</Text>
                            {customPresets.find(c => c.id === p.id) && (
                                <TouchableOpacity onPress={() => deletePreset(p.id)} hitSlop={HIT}>
                                    <Text style={s.eqDel}>✕</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    ))}
                    <TouchableOpacity style={[s.addBtn, { borderColor: theme.accent }]} onPress={() => setShowNewEQ(true)}>
                        <Text style={[s.addBtnText, { color: theme.accent }]}>+ Add Custom Preset</Text>
                    </TouchableOpacity>
                </Section>

                {/* 2. Crossfade */}
                <Section title="Crossfade — Track End">
                    <Text style={s.sliderSub}>Fade out when a track ends naturally</Text>
                    <Text style={[s.sliderVal, { color: theme.accent }]}>{cf.toFixed(1)}s</Text>
                    <PureSlider style={s.slider} minimumValue={0} maximumValue={12} step={0.5} value={cf}
                        onValueChange={setCf} onSlidingComplete={v => { setCf(v); setCrossfade(v); }}
                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                    <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>12s</Text></View>
                </Section>

                <Section title="Crossfade — Skip">
                    <Text style={s.sliderSub}>Soften manual skips</Text>
                    <Text style={[s.sliderVal, { color: theme.accent }]}>{skipCf.toFixed(1)}s</Text>
                    <PureSlider style={s.slider} minimumValue={0} maximumValue={3} step={0.5} value={skipCf}
                        onValueChange={setSkipCf} onSlidingComplete={v => { setSkipCf(v); setSkipCrossfade(v); }}
                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                    <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>3s</Text></View>
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

                {/* 4. Volume + Audio */}
                <Section title="Audio">
                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Volume Normalization</Text>
                            <Text style={s.toggleSub}>Equalizes loudness between tracks</Text>
                        </View>
                        <Switch value={volNorm} onValueChange={v => { setVN(v); setVolNorm(v); }}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <Text style={s.sliderSub}>Audio ramp on play</Text>
                    <Text style={[s.sliderVal, { color: theme.accent }]}>{ramp.toFixed(1)}s</Text>
                    <PureSlider style={s.slider} minimumValue={0} maximumValue={2} step={0.1} value={ramp}
                        onValueChange={setRamp} onSlidingComplete={v => { setRamp(v); setAudioRamp(v); }}
                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                    <View style={s.sliderEnds}><Text style={s.sliderEnd}>Off</Text><Text style={s.sliderEnd}>2s</Text></View>
                    <View style={s.toggleRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.toggleLabel}>Ramp on Pause</Text>
                            <Text style={s.toggleSub}>Fade out when pausing too</Text>
                        </View>
                        <Switch value={rampPause} onValueChange={v => { setRampPause(v); setRampOnPause(v); }}
                            trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                </Section>

                {/* 5. Color — 10 accents, laid out to fill each row evenly with no leftover gap */}
                <Section title="Accent Color">
                    <View style={[s.colorGrid, { gap: SWATCH_GAP, justifyContent: 'center' }]}>
                        {Object.entries(THEMES).map(([id, t]) => (
                            <TouchableOpacity key={id} onPress={() => setTheme(id)}
                                style={[s.swatch, {
                                    width: SWATCH_SIZE, height: SWATCH_SIZE, borderRadius: squircle(SWATCH_SIZE),
                                    backgroundColor: t.accent,
                                }, themeId === id && s.swatchActive,
                                id === 'white' && { borderWidth: 1, borderColor: '#444' }]}>
                                {themeId === id && <Text style={{ color: t.onAccent, fontWeight: '700', fontSize: 13 }}>✓</Text>}
                            </TouchableOpacity>
                        ))}
                    </View>
                </Section>

                {/* 6. Music location — split by sideload tool, or just show the
                     one that matches this actual install when we can tell */}
                <Section title="Music Location">
                    {(showBoth || isLiveContainer) && (
                        <View style={s.locBlock}>
                            <Text style={s.locHeading}>If using LiveContainer</Text>
                            <Text style={s.locBody}>
                                Files → On My iPhone → LiveContainer → SySlate's data folder. LiveContainer nests the app's Documents folder under its own entry rather than a top-level SySlate entry.
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
                    </View>
                </Section>

                {/* 7. Rescan */}
                <Section title="Library">
                    <TouchableOpacity style={s.row} onPress={reload}>
                        <Text style={s.rowLabel}>Rescan Music</Text>
                        <Text style={s.rowSub}>Re-reads all folders</Text>
                    </TouchableOpacity>
                </Section>

                {/* 8. Export/Import */}
                <Section title="Backup & Sync">
                    <TouchableOpacity style={s.row} onPress={async () => {
                        try { const json = await exportAllSettings(); await Share.share({ message: json, title: 'SySlate Settings' }); }
                        catch (e) { Alert.alert('Export failed', String(e?.message)); }
                    }}>
                        <Text style={s.rowLabel}>Export Settings</Text>
                        <Text style={s.rowSub}>Share EQ, crossfade, theme…</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.row} onPress={() => { setImportText(''); setShowImport(true); }}>
                        <Text style={s.rowLabel}>Import Settings</Text>
                        <Text style={s.rowSub}>Paste exported JSON</Text>
                    </TouchableOpacity>
                </Section>
            </ScrollView>

            {/* New EQ Preset Modal */}
            <Modal visible={showNewEQ} transparent animationType="slide" onRequestClose={() => setShowNewEQ(false)}>
                <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setShowNewEQ(false)} />
                <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
                    <View style={s.sheet}>
                        <View style={s.handle} />
                        <Text style={s.sheetTitle}>New EQ Preset</Text>
                        <TextInput
                            style={[s.nameInput, { borderColor: theme.accent }]}
                            value={newName} onChangeText={setNewName}
                            placeholder="Preset name..." placeholderTextColor="#444"
                        />
                        <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false}>
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
                    </View>
                </KeyboardAvoidingView>
            </Modal>

            {/* Import Modal */}
            <Modal visible={showImport} transparent animationType="slide" onRequestClose={() => setShowImport(false)}>
                <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setShowImport(false)} />
                <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
                    <View style={s.sheet}>
                        <View style={s.handle} />
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
                    </View>
                </KeyboardAvoidingView>
            </Modal>
        </View>
    );
}

function Section({ title, children }) {
    return (
        <View style={s.section}>
            <Text style={s.sectionLabel}>{title}</Text>
            <View style={s.sectionBody}>{children}</View>
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
    sliderSub: { color: '#555', fontSize: 12, paddingHorizontal: 24, paddingTop: 14 },
    sliderVal: { fontSize: 22, fontWeight: '700', textAlign: 'center', marginTop: 6 },
    slider: { marginHorizontal: 16, marginTop: 2 },
    sliderEnds: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 24, paddingBottom: 12 },
    sliderEnd: { color: '#444', fontSize: 11 },
    toggleRow: { flexDirection: 'row', alignItems: 'center', padding: 18, paddingHorizontal: 24, borderTopWidth: 1, borderTopColor: '#141414' },
    toggleLabel: { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
    toggleSub: { color: '#555', fontSize: 12, marginTop: 3 },
    // 5 per row x 2 rows for 10 swatches, percentage-based so each row fills
    // edge to edge with no leftover gap on the last row.
    colorGrid: { flexDirection: 'row', flexWrap: 'wrap', padding: 16 },
    swatch: { justifyContent: 'center', alignItems: 'center', marginBottom: 14 },
    swatchActive: { borderWidth: 3, borderColor: '#fff' },
    eqRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: '#141414' },
    checkWrap: { marginRight: 14 },
    checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, justifyContent: 'center', alignItems: 'center' },
    eqName: { flex: 1, color: '#e5e5e5', fontSize: 15 },
    eqDel: { color: '#555', fontSize: 16 },
    addBtn: { margin: 14, padding: 16, borderRadius: 12, borderWidth: 1.5, alignItems: 'center' },
    addBtnText: { fontSize: 15, fontWeight: '600' },
    locBlock: { padding: 16, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: '#141414' },
    locHeading: { color: '#888', fontSize: 12, fontWeight: '700', marginBottom: 4 },
    locBody: { color: '#555', fontSize: 13, lineHeight: 20 },
    locPath: { fontSize: 11, marginTop: 4, lineHeight: 16 },
    locNote: { color: '#333', fontSize: 11, marginTop: 8, lineHeight: 16 },
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)' },
    sheet: { backgroundColor: '#0f0f0f', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },
    handle: { width: 36, height: 4, backgroundColor: '#222', borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
    sheetTitle: { color: '#e5e5e5', fontSize: 16, fontWeight: '700', marginBottom: 16 },
    nameInput: { backgroundColor: '#1a1a1a', borderRadius: 10, padding: 14, color: '#e5e5e5', fontSize: 15, borderWidth: 1, marginBottom: 12 },
    bandRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 2 },
    bandHz: { color: '#555', fontSize: 11, width: 36, textAlign: 'right', marginRight: 4 },
    bandVal: { color: '#888', fontSize: 11, width: 40, textAlign: 'right' },
    saveBtn: { borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 14 },
    saveBtnText: { fontSize: 16, fontWeight: '700' },
});
