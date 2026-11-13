import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput, Alert, Share, KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import BottomSheet from './BottomSheet';
import PureSlider from './PureSlider';
import AudioEngine from '../native/AudioEngine';
import { useTheme } from '../context/ThemeContext';
import { usePlayback, applyEQPreset } from '../context/PlaybackContext';
import { usePreferences } from '../context/PreferencesContext';
import { getCustomEQ, clearCustomEQ, getCustomPresets, setCustomPresets, getEQOverrides, setEQOverrides } from '../utils/storage';
import { getPresetById } from '../utils/eq';
import {
    defaultCustomEQ, sanitizeCustomEQ, bandsFromPreset, makeParamPreset, presetParamBands, toNativeArrays,
    FILTER_TYPES, FILTER_LABELS, GAIN_MIN, GAIN_MAX, freqToPos, posToFreq, qToPos, posToQ, formatFreq,
    snapFreq, snapQ, snapGain, parseFreqInput, parseGainInput, parseQInput,
    exportGraphicEQ, exportParametricEQ, exportSySlateEQ, parseEQText,
} from '../utils/customEQ';

// Advanced EQ: a preset with 10 bands that each have their own frequency, gain, Q and filter type.
// It is saved into the same preset list as every other preset (so it shows up in the EQ picker, can be
// chosen per playlist, hidden, deleted, exported); it just carries extra data (`param`).

const uniqueName = (base, existing) => {
    const names = new Set(existing.map(p => p.name));
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
};

// The editor sheet. `preset` is an existing Advanced EQ preset to edit, or null for a new one.
export function AdvancedEQSheet({ visible, preset, s, onClose, onSaved }) {
    const { theme, base } = useTheme();
    const { eqPresetId } = usePlayback();
    const eqPresetIdRef = useRef(eqPresetId);
    eqPresetIdRef.current = eqPresetId;
    const [name, setName] = useState('');
    const [bands, setBands] = useState(defaultCustomEQ().bands);
    const bandsRef = useRef(bands);
    bandsRef.current = bands;
    const wasVisible = useRef(false);

    useEffect(() => {
        if (visible && !wasVisible.current) {
            const pb = presetParamBands(preset);
            setName(preset ? preset.name : '');
            setBands(pb || defaultCustomEQ().bands);
        }
        if (!visible && wasVisible.current) applyEQPreset(eqPresetIdRef.current);   // stop previewing
        wasVisible.current = visible;
    }, [visible, preset]);

    // Hear it while editing.
    const preview = (next) => {
        const n = toNativeArrays({ bands: next });
        AudioEngine.setEQParametric(n.freqs, n.gains, n.bws, n.types).catch(() => { });
    };
    const setBand = (i, patch) => setBands(b => b.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    const commitBand = (i, patch) => {
        const next = bandsRef.current.map((x, j) => (j === i ? { ...x, ...patch } : x));
        const clean = sanitizeCustomEQ({ bands: next })?.bands || next;
        setBands(clean);
        preview(clean);
    };

    // Hold a value (or its slider) to type an exact one. iOS only (Alert.prompt); elsewhere the sliders are all there is.
    const askValue = (title, hint, current, parse, apply) => {
        if (Platform.OS !== 'ios' || !Alert.prompt) return;
        Alert.prompt(title, hint, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Set', onPress: (txt) => { const v = parse(txt); if (v === null) Alert.alert('Not a valid value', hint); else apply(v); } },
        ], 'plain-text', String(current), 'numbers-and-punctuation');
    };
    const askFreq = (i) => askValue(`Band ${i + 1} frequency`, 'In Hz, or with k for kHz (for example 440 or 2.5k). 20 Hz to 20 kHz.', bandsRef.current[i].f, parseFreqInput, v => commitBand(i, { f: v }));
    const askGain = (i) => askValue(`Band ${i + 1} gain`, 'In dB, from -6 to 6 (for example -3.5).', bandsRef.current[i].g, parseGainInput, v => commitBand(i, { g: v }));
    const askQ = (i) => askValue(`Band ${i + 1} Q`, 'From 0.2 to 10 (for example 0.71 or 2).', bandsRef.current[i].q, parseQInput, v => commitBand(i, { q: v }));

    const startFromCurrent = () => {
        Alert.alert('Start from the current preset?', 'This replaces all 10 bands in this editor with the preset you are using now. Nothing is saved until you press Save.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Replace', onPress: async () => {
                const [cp, ov] = await Promise.all([getCustomPresets(), getEQOverrides()]);
                const cur = getPresetById(eqPresetIdRef.current, cp, ov);
                const next = presetParamBands(cur) || bandsFromPreset(cur.bands);
                setBands(next); preview(next);
            } },
        ]);
    };
    const resetAll = () => {
        Alert.alert('Reset all bands?', 'Every band goes back to flat: 0 dB, Q 1.41, Peak, at the standard frequencies (32 Hz to 16 kHz). Your saved preset is not changed until you press Save.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Reset', style: 'destructive', onPress: () => { const next = defaultCustomEQ().bands; setBands(next); preview(next); } },
        ]);
    };

    const save = async () => {
        const trimmed = name.trim();
        if (!trimmed) { Alert.alert('Name needed', 'Give this preset a name first.'); return; }
        const list = await getCustomPresets();
        if (preset && list.some(p => p.id === preset.id)) {
            const made = makeParamPreset(preset.id, trimmed, bandsRef.current);
            await setCustomPresets(list.map(p => (p.id === preset.id ? { ...p, ...made } : p)));
        } else {
            await setCustomPresets([...list, makeParamPreset(`custom_${Date.now()}`, uniqueName(trimmed, list), bandsRef.current)]);
        }
        onSaved?.();
        onClose();
    };

    return (
        <BottomSheet visible={visible} onClose={onClose} expandable
            header={<Text style={[s.sheetTitle, { paddingHorizontal: 24 }]}>{preset ? 'Edit Advanced EQ' : 'New Advanced EQ'}</Text>}
            footer={(
                <TouchableOpacity style={[s.saveBtn, { backgroundColor: theme.accent, marginTop: 0 }]} onPress={save}>
                    <Text style={[s.saveBtnText, { color: theme.onAccent }]}>{preset ? 'Save Changes' : 'Save Preset'}</Text>
                </TouchableOpacity>
            )}>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, paddingHorizontal: 16 }}>
                <TextInput style={[s.nameInput, { borderColor: theme.accent }]} value={name} onChangeText={setName}
                    placeholder="Preset name..." placeholderTextColor="#444" />
                <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                    {bands.map((b, i) => (
                        <View key={i} style={[st.card, { borderColor: base.border }]}>
                            <View style={st.cardHead}>
                                <Text style={{ color: base.text, fontWeight: '700', fontSize: 13 }}>Band {i + 1}</Text>
                                <View style={st.typeRow}>
                                    {FILTER_TYPES.map(t => (
                                        <TouchableOpacity key={t} onPress={() => { setBand(i, { t }); commitBand(i, { t }); }}
                                            style={[st.typeChip, { borderColor: b.t === t ? theme.accent : base.border }, b.t === t && { backgroundColor: theme.accent }]}>
                                            <Text style={{ color: b.t === t ? theme.onAccent : base.textFaint, fontSize: 11, fontWeight: '600' }}>{FILTER_LABELS[t]}</Text>
                                        </TouchableOpacity>
                                    ))}
                                </View>
                            </View>
                            <SliderLine label="Freq" value={formatFreq(b.f)} base={base} onHold={() => askFreq(i)}>
                                <PureSlider style={{ flex: 1 }} minimumValue={0} maximumValue={1} step={0.001} value={freqToPos(b.f)} onLongPress={() => askFreq(i)}
                                    onValueChange={p => setBand(i, { f: snapFreq(posToFreq(p)) })} onSlidingComplete={p => commitBand(i, { f: snapFreq(posToFreq(p)) })}
                                    minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                            </SliderLine>
                            <SliderLine label="Gain" value={`${b.g > 0 ? '+' : ''}${b.g.toFixed(1)} dB`} base={base} onHold={() => askGain(i)}>
                                <PureSlider style={{ flex: 1 }} minimumValue={GAIN_MIN} maximumValue={GAIN_MAX} step={0.1} value={b.g} onLongPress={() => askGain(i)}
                                    onValueChange={v => setBand(i, { g: snapGain(v) })} onSlidingComplete={v => commitBand(i, { g: snapGain(v) })}
                                    minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                            </SliderLine>
                            <SliderLine label="Q" value={b.q.toFixed(2)} base={base} dim={b.t !== 'peak'} onHold={() => askQ(i)}>
                                <PureSlider style={{ flex: 1 }} minimumValue={0} maximumValue={1} step={0.001} value={qToPos(b.q)} onLongPress={() => askQ(i)}
                                    onValueChange={p => setBand(i, { q: snapQ(posToQ(p)) })} onSlidingComplete={p => commitBand(i, { q: snapQ(posToQ(p)) })}
                                    minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                            </SliderLine>
                        </View>
                    ))}
                    <TouchableOpacity style={[s.resetBtn, { borderColor: base.border }]} onPress={startFromCurrent}>
                        <Text style={[s.resetBtnText, { color: base.textFaint }]}>Start from the current preset</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[s.resetBtn, { borderColor: base.border }]} onPress={resetAll}>
                        <Text style={[s.resetBtnText, { color: base.textFaint }]}>Reset all bands to flat</Text>
                    </TouchableOpacity>
                    <View style={{ height: 24 }} />
                </ScrollView>
            </KeyboardAvoidingView>
        </BottomSheet>
    );
}

// The rows under the EQ presets in Settings: new Advanced EQ, export, import.
export default function EQAdvancedRows({ s, onPresetsChanged, onNewAdvanced }) {
    const { theme, base } = useTheme();
    const { eqPresetId } = usePlayback();
    const { preAmp, setPreAmp } = usePreferences();
    const [showImport, setShowImport] = useState(false);
    const [importText, setImportText] = useState('');
    const eqPresetIdRef = useRef(eqPresetId);
    eqPresetIdRef.current = eqPresetId;

    // The first Advanced EQ build kept ONE global custom EQ outside the preset list. If it holds real edits,
    // move it into the list as a preset so nothing is lost, then drop the old copy.
    useEffect(() => {
        (async () => {
            try {
                const old = await getCustomEQ();
                if (!old) return;
                if (old.bands.some(b => b.g !== 0)) {
                    const list = await getCustomPresets();
                    await setCustomPresets([...list, makeParamPreset(`custom_${Date.now()}`, uniqueName('Advanced EQ (earlier)', list), old.bands)]);
                    onPresetsChanged?.();
                }
                await clearCustomEQ();
            } catch { }
        })();
    }, []);

    const currentBands = async () => {
        const [cp, ov] = await Promise.all([getCustomPresets(), getEQOverrides()]);
        const cur = getPresetById(eqPresetIdRef.current, cp, ov);
        return presetParamBands(cur) || bandsFromPreset(cur.bands);
    };
    const share = async (message, title) => {
        try { await Share.share({ message, title }); } catch (e) { Alert.alert('Export failed', String(e?.message)); }
    };
    const askExport = () => {
        Alert.alert('Export EQ', 'Choose a format', [
            { text: 'SySlate (all presets)', onPress: async () => share(exportSySlateEQ({ customPresets: await getCustomPresets(), overrides: await getEQOverrides(), preAmp }), 'SySlate EQ') },
            { text: 'GraphicEQ (current preset)', onPress: async () => share(exportGraphicEQ(await currentBands(), preAmp), 'SySlate GraphicEQ') },
            { text: 'Parametric (current preset)', onPress: async () => share(exportParametricEQ(await currentBands(), preAmp), 'SySlate Parametric EQ') },
            { text: 'Cancel', style: 'cancel' },
        ]);
    };

    const applyImport = async () => {
        const r = parseEQText(importText);
        if (r.kind === 'error') { Alert.alert('Import failed', r.message); return; }
        try {
            const existing = await getCustomPresets();
            if (r.kind === 'syslate') {
                const key = (p) => `${p.name}|${p.bands.join(',')}|${JSON.stringify(p.param || null)}`;
                const have = new Set(existing.map(key));
                const added = [];
                r.customPresets.forEach((p, i) => {
                    if (have.has(key(p))) return;
                    added.push({ ...p, id: `custom_${Date.now()}_${i}` });
                });
                if (r.custom && r.custom.bands.some(b => b.g !== 0)) added.push(makeParamPreset(`custom_${Date.now()}_c`, 'Advanced EQ (imported)', r.custom.bands));
                if (added.length) await setCustomPresets([...existing, ...added]);
                const ovN = Object.keys(r.overrides).length;
                if (ovN) await setEQOverrides({ ...(await getEQOverrides()), ...r.overrides });
                if (r.preAmp !== null) setPreAmp(r.preAmp);
                applyEQPreset(eqPresetIdRef.current);
                onPresetsChanged?.();
                setShowImport(false); setImportText('');
                Alert.alert('Done', `${added.length} preset${added.length === 1 ? '' : 's'} added${ovN ? `, ${ovN} premade preset edit${ovN === 1 ? '' : 's'} restored` : ''}.`);
                return;
            }
            // GraphicEQ, parametric filters, tables, ten gains: each becomes a new Advanced EQ preset.
            const name = uniqueName('Imported EQ', existing);
            await setCustomPresets([...existing, makeParamPreset(`custom_${Date.now()}`, name, r.bands)]);
            if (r.preAmp !== null) setPreAmp(r.preAmp);
            onPresetsChanged?.();
            setShowImport(false); setImportText('');
            const what = r.kind === 'graphic' ? `${r.points} points, resampled to 10 bands` : `${r.count} filter${r.count === 1 ? '' : 's'}`;
            Alert.alert('Done', `Added "${name}" (${what}${r.skipped ? `, ${r.skipped} unsupported or extra skipped` : ''}) to your presets. Pick it in the EQ list.`);
        } catch (e) { Alert.alert('Import failed', String(e?.message || e)); }
    };

    return (
        <>
            <TouchableOpacity style={s.row} onPress={onNewAdvanced}>
                <Text style={s.rowLabel}>New Advanced EQ</Text>
                <Text style={s.rowSub}>A preset with 10 bands that each have their own frequency, gain, Q and filter type. It is saved with your other presets</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.row} onPress={askExport}>
                <Text style={s.rowLabel}>Export EQ</Text>
                <Text style={s.rowSub}>Share as SySlate, Equalizer APO GraphicEQ or parametric text</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.row} onPress={() => { setImportText(''); setShowImport(true); }}>
                <Text style={s.rowLabel}>Import EQ</Text>
                <Text style={s.rowSub}>SySlate export, GraphicEQ, AutoEq / Equalizer APO filters, a frequency and gain table, or ten gains</Text>
            </TouchableOpacity>

            <BottomSheet visible={showImport} onClose={() => setShowImport(false)} expandable
                footer={(
                    <TouchableOpacity style={[s.saveBtn, { backgroundColor: theme.accent, marginTop: 0 }]} onPress={applyImport}>
                        <Text style={[s.saveBtnText, { color: theme.onAccent }]}>Import</Text>
                    </TouchableOpacity>
                )}>
                <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, paddingHorizontal: 20 }}>
                    <Text style={s.sheetTitle}>Import EQ</Text>
                    <Text style={{ color: base.textFaint, fontSize: 13, marginBottom: 12 }}>
                        Paste a SySlate EQ export, a "GraphicEQ:" line, "Filter 1: ON PK Fc 100 Hz Gain -2 dB Q 1.0" lines (AutoEq, Equalizer APO, Peace), a table of "frequency gain" lines, or ten band gains. Imports are added as new presets and never replace one.
                    </Text>
                    <TextInput
                        style={[s.nameInput, { flex: 1, minHeight: 120, textAlignVertical: 'top', borderColor: theme.accent }]}
                        value={importText} onChangeText={setImportText}
                        placeholder="Paste here..." placeholderTextColor="#333"
                        multiline autoCorrect={false} autoCapitalize="none"
                    />
                </KeyboardAvoidingView>
            </BottomSheet>
        </>
    );
}

function SliderLine({ label, value, base, dim, onHold, children }) {
    return (
        <View style={[st.line, dim && { opacity: 0.45 }]}>
            <TouchableOpacity activeOpacity={0.6} delayLongPress={450} onLongPress={onHold} style={{ width: 34, paddingVertical: 8 }}>
                <Text style={{ color: base.textFaint, fontSize: 11 }}>{label}</Text>
            </TouchableOpacity>
            {children}
            <TouchableOpacity activeOpacity={0.6} delayLongPress={450} onLongPress={onHold} style={{ width: 74, paddingVertical: 8 }}>
                <Text style={{ color: base.textDim ?? base.textFaint, fontSize: 11, textAlign: 'right' }}>{value}</Text>
            </TouchableOpacity>
        </View>
    );
}

const st = StyleSheet.create({
    card: { borderWidth: 1, borderRadius: 12, padding: 10, marginBottom: 10 },
    cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
    typeRow: { flexDirection: 'row', gap: 6 },
    typeChip: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
    line: { flexDirection: 'row', alignItems: 'center', marginVertical: 2 },
});
