import React, { useState, useEffect, useContext } from 'react';
import {
    View, Text, StyleSheet, ScrollView, Switch,
    TouchableOpacity, StatusBar, Modal, TextInput,
    Share, Alert,
} from 'react-native';
import { LibraryContext } from '../context/LibraryContext';
import { useLibrary } from '../context/LibraryContext';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme, THEMES } from '../context/ThemeContext';
import PureSlider from '../components/PureSlider';
import { BUILT_IN_PRESETS, BAND_HZ, BAND_COUNT } from '../utils/eq';
import {
    getCrossfade, setCrossfade,
    getSkipCrossfade, setSkipCrossfade,
    getVolNorm, setVolNorm,
    getCustomPresets, setCustomPresets,
    getHiddenPresets, setHiddenPresets,
    exportAllSettings, importAllSettings,
} from '../utils/storage';

export default function SettingsScreen() {
    const { shuffleMode, changeShuffleMode } = usePlayback();
    const { reload } = useContext(LibraryContext);
    const { themeId, setTheme, theme } = useTheme();

    const [cf, setCf] = useState(3.0);
    const [skipCf, setSkipCf] = useState(0.5);
    const [volNorm, setVN] = useState(true);
    const [customPresets, setCP] = useState([]);
    const [hiddenPresets, setHP] = useState([]);
    const [showNewEQ, setShowNewEQ] = useState(false);
    const [newPresetName, setNewName] = useState('');
    const [newBands, setNewBands] = useState(new Array(BAND_COUNT).fill(0));
    const { scanPath } = useLibrary();
    const [showImport, setShowImport] = useState(false);
    const [importText, setImportText] = useState('');

    useEffect(() => {
        (async () => {
            setCf(await getCrossfade());
            setSkipCf(await getSkipCrossfade());
            setVN(await getVolNorm());
            setCP(await getCustomPresets());
            setHP(await getHiddenPresets());
        })();
    }, []);

    const togglePresetVisible = async (id) => {
        const next = hiddenPresets.includes(id)
            ? hiddenPresets.filter(x => x !== id)
            : [...hiddenPresets, id];
        setHP(next);
        await setHiddenPresets(next);
    };

    const deleteCustomPreset = async (id) => {
        const next = customPresets.filter(p => p.id !== id);
        setCP(next);
        await setCustomPresets(next);
    };

    const saveNewPreset = async () => {
        if (!newPresetName.trim()) return;
        const id = 'custom_' + Date.now();
        const next = [...customPresets, { id, name: newPresetName.trim(), bands: [...newBands] }];
        setCP(next);
        await setCustomPresets(next);
        setShowNewEQ(false);
        setNewName('');
        setNewBands(new Array(BAND_COUNT).fill(0));
    };

    const allPresets = [...BUILT_IN_PRESETS, ...customPresets];

    const MODES = [
        { id: 'off', label: 'Off', sub: 'Play in order' },
        { id: 'full_cycle', label: 'Full Cycle', sub: 'All songs once before repeat' },
        { id: 'true_random', label: 'True Random', sub: 'Completely random' },
        { id: 'smart', label: 'Smart', sub: 'Avoids same artist back to back' },
    ];

    return (
        <ScrollView style={s.container} contentContainerStyle={{ paddingBottom: 140 }}>
            <StatusBar barStyle="light-content" />
            <View style={s.header}><Text style={s.title}>Settings</Text></View>

            {/* 1. EQ */}
            <Section title="EQ Presets">
                <View style={s.eqNote}>
                    <Text style={s.eqNoteText}>Audio processing coming in next update. Presets save and apply automatically.</Text>
                </View>
                {allPresets.map(p => (
                    <View key={p.id} style={s.eqRow}>
                        <TouchableOpacity onPress={() => togglePresetVisible(p.id)} style={s.eqCheck}>
                            <Text style={[s.eqCheckBox, { borderColor: theme.accent }, !hiddenPresets.includes(p.id) && { backgroundColor: theme.accent }]}>
                                {!hiddenPresets.includes(p.id) ? '✓' : ''}
                            </Text>
                        </TouchableOpacity>
                        <Text style={s.eqName}>{p.name}</Text>
                        {customPresets.find(c => c.id === p.id) && (
                            <TouchableOpacity onPress={() => deleteCustomPreset(p.id)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                                <Text style={s.eqDelete}>✕</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                ))}
                <TouchableOpacity style={[s.addPreset, { borderColor: theme.accent }]} onPress={() => setShowNewEQ(true)}>
                    <Text style={[s.addPresetText, { color: theme.accent }]}>+ Add Custom Preset</Text>
                </TouchableOpacity>
            </Section>

            {/* 2. Crossfade */}
            <Section title="Crossfade — Track End">
                <Text style={s.sliderSub}>Fades out when a track naturally ends</Text>
                <Text style={[s.sliderVal, { color: theme.accent }]}>{cf.toFixed(1)}s</Text>
                <PureSlider
                    style={s.slider} minimumValue={0} maximumValue={12} step={0.5} value={cf}
                    onValueChange={setCf} onSlidingComplete={v => { setCf(v); setCrossfade(v); }}
                    minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent}
                />
                <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>12s</Text></View>
            </Section>

            <Section title="Crossfade — Skip">
                <Text style={s.sliderSub}>Softens the cut when you skip manually</Text>
                <Text style={[s.sliderVal, { color: theme.accent }]}>{skipCf.toFixed(1)}s</Text>
                <PureSlider
                    style={s.slider} minimumValue={0} maximumValue={3} step={0.5} value={skipCf}
                    onValueChange={setSkipCf} onSlidingComplete={v => { setSkipCf(v); setSkipCrossfade(v); }}
                    minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent}
                />
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

            {/* 4. Volume normalization */}
            <Section title="Audio">
                <View style={s.toggleRow}>
                    <View style={{ flex: 1 }}>
                        <Text style={s.toggleLabel}>Volume Normalization</Text>
                        <Text style={s.toggleSub}>Equalizes loudness between tracks</Text>
                    </View>
                    <Switch
                        value={volNorm}
                        onValueChange={v => { setVN(v); setVolNorm(v); }}
                        trackColor={{ false: '#222', true: theme.accent }}
                        thumbColor="#fff"
                    />
                </View>
            </Section>

            {/* 5. Color */}
            <Section title="Accent Color">
                <View style={s.colorGrid}>
                    {Object.entries(THEMES).map(([id, t]) => (
                        <TouchableOpacity
                            key={id}
                            onPress={() => setTheme(id)}
                            style={[
                                s.colorSwatch,
                                { backgroundColor: t.accent },
                                themeId === id && s.colorSwatchActive,
                            ]}
                        >
                            {themeId === id && <Text style={s.colorCheck}>✓</Text>}
                        </TouchableOpacity>
                    ))}
                </View>
            </Section>

            {/* Music Path */}
            <Section title="Music Location">
                <View style={{ padding: 16, paddingHorizontal: 20 }}>
                    <Text style={{ color: '#555', fontSize: 12, lineHeight: 18 }}>
                        Put music files or folders at:
                    </Text>
                    <Text style={{ color: theme.accent, fontSize: 11, marginTop: 6, fontFamily: 'Courier' }}>
                        {scanPath ? scanPath.replace('file://', '') : 'Loading...'}
                    </Text>
                    <Text style={{ color: '#333', fontSize: 11, marginTop: 8, lineHeight: 16 }}>
                        Folders inside become playlists. Files in root appear in All Songs.
                    </Text>
                </View>
            </Section>

            {/* Rescan */}
            <Section title="Library">
                <TouchableOpacity style={s.row} onPress={reload}>
                    <Text style={s.rowLabel}>Rescan Music</Text>
                    <Text style={s.rowSub}>Re-reads music from the location above</Text>
                </TouchableOpacity>
            </Section>

            {/* Export / Import */}
            <Section title="Backup & Sync">
                <TouchableOpacity style={s.row} onPress={async () => {
                    try {
                        const json = await exportAllSettings();
                        await Share.share({ message: json, title: 'SySlate Settings' });
                    } catch (e) { Alert.alert('Export failed', String(e.message)); }
                }}>
                    <Text style={s.rowLabel}>Export Settings</Text>
                    <Text style={s.rowSub}>Share your EQ, crossfade, theme settings</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.row} onPress={() => { setImportText(''); setShowImport(true); }}>
                    <Text style={s.rowLabel}>Import Settings</Text>
                    <Text style={s.rowSub}>Paste exported settings JSON here</Text>
                </TouchableOpacity>
            </Section>

            {/* New EQ Preset Modal */}
            <Modal visible={showNewEQ} transparent animationType="slide" onRequestClose={() => setShowNewEQ(false)}>
                <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setShowNewEQ(false)} />
                <View style={s.sheet}>
                    <View style={s.sheetHandle} />
                    <Text style={s.sheetTitle}>New EQ Preset</Text>
                    <TextInput
                        style={[s.nameInput, { borderColor: theme.accent }]}
                        value={newPresetName}
                        onChangeText={setNewName}
                        placeholder="Preset name..."
                        placeholderTextColor="#444"
                    />
                    <Text style={s.bandLabel}>Bands (dB)</Text>
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
                    <TouchableOpacity
                        style={[s.saveBtn, { backgroundColor: theme.accent }]}
                        onPress={saveNewPreset}
                    >
                        <Text style={s.saveBtnText}>Save Preset</Text>
                    </TouchableOpacity>
                </View>
            </Modal>

            {/* Import Settings Modal */}
            <Modal visible={showImport} transparent animationType="slide" onRequestClose={() => setShowImport(false)}>
                <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setShowImport(false)} />
                <View style={s.sheet}>
                    <View style={s.sheetHandle} />
                    <Text style={s.sheetTitle}>Import Settings</Text>
                    <Text style={{ color: '#555', fontSize: 13, marginBottom: 12 }}>
                        Paste your exported settings JSON below:
                    </Text>
                    <TextInput
                        style={[s.nameInput, { height: 140, textAlignVertical: 'top', borderColor: theme.accent }]}
                        value={importText}
                        onChangeText={setImportText}
                        placeholder="Paste JSON here..."
                        placeholderTextColor="#333"
                        multiline
                        autoCorrect={false}
                        autoCapitalize="none"
                    />
                    <TouchableOpacity
                        style={[s.saveBtn, { backgroundColor: theme.accent }]}
                        onPress={async () => {
                            try {
                                await importAllSettings(importText);
                                setShowImport(false);
                                Alert.alert('Done', 'Settings imported. Restart the app to see all changes.');
                            } catch (e) {
                                Alert.alert('Import failed', 'Invalid JSON. Make sure you pasted the full exported text.');
                            }
                        }}
                    >
                        <Text style={s.saveBtnText}>Apply Settings</Text>
                    </TouchableOpacity>
                </View>
            </Modal>
        </ScrollView>
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
    sliderSub: { color: '#555', fontSize: 12, paddingHorizontal: 24, paddingTop: 12 },
    sliderVal: { fontSize: 22, fontWeight: '700', textAlign: 'center', marginTop: 8 },
    slider: { marginHorizontal: 16, marginTop: 4 },
    sliderEnds: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 24, paddingBottom: 12 },
    sliderEnd: { color: '#444', fontSize: 11 },
    toggleRow: { flexDirection: 'row', alignItems: 'center', padding: 18, paddingHorizontal: 24 },
    toggleLabel: { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
    toggleSub: { color: '#555', fontSize: 12, marginTop: 3 },
    colorGrid: { flexDirection: 'row', flexWrap: 'wrap', padding: 18, gap: 14 },
    colorSwatch: { width: 46, height: 46, borderRadius: 23 },
    colorSwatchActive: { borderWidth: 3, borderColor: '#fff' },
    colorCheck: { color: '#000', textAlign: 'center', lineHeight: 42, fontWeight: '700', fontSize: 16 },
    eqNote: { padding: 14, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: '#141414' },
    eqNoteText: { color: '#444', fontSize: 12, lineHeight: 18 },
    eqRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: '#141414' },
    eqCheck: { marginRight: 14 },
    eqCheckBox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, textAlign: 'center', lineHeight: 20, fontSize: 13, color: '#fff', fontWeight: '700' },
    eqName: { flex: 1, color: '#e5e5e5', fontSize: 15 },
    eqDelete: { color: '#555', fontSize: 16 },
    addPreset: { margin: 16, padding: 14, borderRadius: 12, borderWidth: 1.5, alignItems: 'center' },
    addPresetText: { fontSize: 15, fontWeight: '600' },
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)' },
    sheet: { backgroundColor: '#0f0f0f', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 52, maxHeight: '85%' },
    sheetHandle: { width: 36, height: 4, backgroundColor: '#222', borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
    sheetTitle: { color: '#e5e5e5', fontSize: 16, fontWeight: '700', marginBottom: 16 },
    nameInput: { backgroundColor: '#1a1a1a', borderRadius: 10, padding: 14, color: '#e5e5e5', fontSize: 15, borderWidth: 1, marginBottom: 16 },
    bandLabel: { color: '#555', fontSize: 11, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 },
    bandRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 4 },
    bandHz: { color: '#555', fontSize: 11, width: 34, textAlign: 'right', marginRight: 4 },
    bandVal: { color: '#888', fontSize: 11, width: 38, textAlign: 'right' },
    saveBtn: { borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 16 },
    saveBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});