import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput, Switch, Alert, Share, KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import BottomSheet from './BottomSheet';
import PureSlider from './PureSlider';
import { useTheme } from '../context/ThemeContext';
import { usePlayback, applyEQPreset } from '../context/PlaybackContext';
import { usePreferences } from '../context/PreferencesContext';
import { getCustomEQ, setCustomEQ, getCustomPresets, setCustomPresets, getEQOverrides, setEQOverrides } from '../utils/storage';
import { getPresetById } from '../utils/eq';
import {
    defaultCustomEQ, sanitizeCustomEQ, bandsFromPreset, FILTER_TYPES, FILTER_LABELS,
    GAIN_MIN, GAIN_MAX, freqToPos, posToFreq, qToPos, posToQ, formatFreq,
    exportGraphicEQ, exportParametricEQ, exportSySlateEQ, parseEQText,
} from '../utils/customEQ';

// Rows for the Settings "EQ" group (custom parametric EQ, import, export) plus the two sheets they open.
// `s` is Settings' own style sheet so the rows look like every other row there.
export default function EQAdvancedRows({ s, onPresetsChanged }) {
    const { theme, base } = useTheme();
    const { eqPresetId } = usePlayback();
    const { preAmp, setPreAmp } = usePreferences();
    const [custom, setCustom] = useState(defaultCustomEQ());
    const [showEditor, setShowEditor] = useState(false);
    const [showImport, setShowImport] = useState(false);
    const [importText, setImportText] = useState('');
    const eqPresetIdRef = useRef(eqPresetId);
    eqPresetIdRef.current = eqPresetId;

    useEffect(() => { (async () => { const c = await getCustomEQ(); if (c) setCustom(c); })(); }, []);

    // Save, then re-apply so the engine uses the custom EQ (or goes back to the picked preset).
    const commit = useCallback(async (next) => {
        const clean = sanitizeCustomEQ(next) || defaultCustomEQ();
        setCustom(clean);
        await setCustomEQ(clean);
        applyEQPreset(eqPresetIdRef.current);
    }, []);

    const setBand = (i, patch) => setCustom(c => ({ ...c, bands: c.bands.map((b, j) => (j === i ? { ...b, ...patch } : b)) }));
    const bandsRef = useRef(custom);
    bandsRef.current = custom;
    const commitBand = (i, patch) => {
        const c = bandsRef.current;
        commit({ ...c, bands: c.bands.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
    };

    const currentEffectiveBands = async () => {
        const c = await getCustomEQ();
        if (c?.enabled) return c.bands;
        const [cp, ov] = await Promise.all([getCustomPresets(), getEQOverrides()]);
        return bandsFromPreset(getPresetById(eqPresetIdRef.current, cp, ov).bands);
    };

    const share = async (message, title) => {
        try { await Share.share({ message, title }); } catch (e) { Alert.alert('Export failed', String(e?.message)); }
    };

    const askExport = () => {
        Alert.alert('Export EQ', 'Choose a format', [
            { text: 'SySlate (all EQ settings)', onPress: async () => share(exportSySlateEQ({ customPresets: await getCustomPresets(), overrides: await getEQOverrides(), custom: await getCustomEQ(), preAmp }), 'SySlate EQ') },
            { text: 'GraphicEQ (Equalizer APO)', onPress: async () => share(exportGraphicEQ(await currentEffectiveBands(), preAmp), 'SySlate GraphicEQ') },
            { text: 'Parametric (Equalizer APO)', onPress: async () => share(exportParametricEQ(await currentEffectiveBands(), preAmp), 'SySlate Parametric EQ') },
            { text: 'Cancel', style: 'cancel' },
        ]);
    };

    const applyImport = async () => {
        const r = parseEQText(importText);
        if (r.kind === 'error') { Alert.alert('Import failed', r.message); return; }
        try {
            if (r.kind === 'syslate') {
                const existing = await getCustomPresets();
                const have = new Set(existing.map(p => `${p.name}|${p.bands.join(',')}`));
                const added = [];
                r.customPresets.forEach((p, i) => {
                    if (have.has(`${p.name}|${p.bands.join(',')}`)) return;
                    added.push({ id: `custom_${Date.now()}_${i}`, name: p.name, bands: p.bands });
                });
                if (added.length) await setCustomPresets([...existing, ...added]);
                if (Object.keys(r.overrides).length) await setEQOverrides({ ...(await getEQOverrides()), ...r.overrides });
                if (r.custom) await commit(r.custom); else applyEQPreset(eqPresetIdRef.current);
                if (r.preAmp !== null) setPreAmp(r.preAmp);
                onPresetsChanged?.();
                setShowImport(false); setImportText('');
                Alert.alert('Done', `${added.length} preset${added.length === 1 ? '' : 's'} added${Object.keys(r.overrides).length ? `, ${Object.keys(r.overrides).length} premade preset edit(s) restored` : ''}${r.custom ? ', Custom EQ restored' : ''}.`);
                return;
            }
            // GraphicEQ / parametric: becomes the Custom EQ (it needs the wider range and the Q values).
            const label = r.kind === 'graphic' ? `GraphicEQ with ${r.points} points, resampled to 10 bands` : `${r.count} filter${r.count === 1 ? '' : 's'}`;
            Alert.alert('Replace Custom EQ?', `${label}${r.skipped ? ` (${r.skipped} filter${r.skipped === 1 ? '' : 's'} skipped: unsupported type or more than 10)` : ''}. This replaces your current Custom EQ and turns it on.`, [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Replace', onPress: async () => {
                    await commit({ enabled: true, bands: r.bands });
                    if (r.preAmp !== null) setPreAmp(r.preAmp);
                    setShowImport(false); setImportText('');
                } },
            ]);
        } catch (e) { Alert.alert('Import failed', String(e?.message || e)); }
    };

    return (
        <>
            <View style={[s.toggleRow, { borderTopWidth: 0 }]}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={s.toggleLabel}>Custom EQ</Text>
                    <Text style={s.rowSub}>10 bands with your own frequency, gain and Q. While on, it replaces the preset</Text>
                </View>
                <Switch value={!!custom.enabled} onValueChange={(v) => commit({ ...custom, enabled: v })} trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
            </View>
            <TouchableOpacity style={[s.row, { borderTopWidth: 1, borderTopColor: base.border }]} onPress={() => setShowEditor(true)}>
                <Text style={s.rowLabel}>Edit Custom EQ</Text>
                <Text style={s.rowSub}>Frequency, gain, Q and filter type for each of the 10 bands. Swipe up on the handle for full screen</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.row} onPress={askExport}>
                <Text style={s.rowLabel}>Export EQ</Text>
                <Text style={s.rowSub}>Share as SySlate, Equalizer APO GraphicEQ or parametric text</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.row, { borderBottomWidth: 0 }]} onPress={() => { setImportText(''); setShowImport(true); }}>
                <Text style={s.rowLabel}>Import EQ</Text>
                <Text style={s.rowSub}>Paste a SySlate export, a GraphicEQ line or Equalizer APO / AutoEq filters</Text>
            </TouchableOpacity>

            <BottomSheet visible={showEditor} onClose={() => setShowEditor(false)} expandable
                header={<Text style={[s.sheetTitle, { paddingHorizontal: 24 }]}>Custom EQ</Text>}>
                <View style={{ flex: 1, paddingHorizontal: 16 }}>
                    <View style={st.topRow}>
                        <Text style={{ color: base.text, fontSize: 14, flex: 1 }}>{custom.enabled ? 'On' : 'Off'}</Text>
                        <Switch value={!!custom.enabled} onValueChange={(v) => commit({ ...custom, enabled: v })} trackColor={{ false: '#222', true: theme.accent }} thumbColor="#fff" />
                    </View>
                    <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                        {custom.bands.map((b, i) => (
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
                                <SliderLine label="Freq" value={formatFreq(b.f)} base={base}>
                                    <PureSlider style={{ flex: 1 }} minimumValue={0} maximumValue={1} step={0.001} value={freqToPos(b.f)}
                                        onValueChange={p => setBand(i, { f: posToFreq(p) })} onSlidingComplete={p => commitBand(i, { f: posToFreq(p) })}
                                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                                </SliderLine>
                                <SliderLine label="Gain" value={`${b.g > 0 ? '+' : ''}${b.g.toFixed(1)} dB`} base={base}>
                                    <PureSlider style={{ flex: 1 }} minimumValue={GAIN_MIN} maximumValue={GAIN_MAX} step={0.1} value={b.g}
                                        onValueChange={v => setBand(i, { g: Math.round(v * 10) / 10 })} onSlidingComplete={v => commitBand(i, { g: Math.round(v * 10) / 10 })}
                                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                                </SliderLine>
                                <SliderLine label="Q" value={b.q.toFixed(2)} base={base} dim={b.t !== 'peak'}>
                                    <PureSlider style={{ flex: 1 }} minimumValue={0} maximumValue={1} step={0.001} value={qToPos(b.q)}
                                        onValueChange={p => setBand(i, { q: posToQ(p) })} onSlidingComplete={p => commitBand(i, { q: posToQ(p) })}
                                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                                </SliderLine>
                            </View>
                        ))}
                        <TouchableOpacity style={[s.resetBtn, { borderColor: base.border }]} onPress={async () => {
                            const [cp, ov] = await Promise.all([getCustomPresets(), getEQOverrides()]);
                            commit({ ...custom, bands: bandsFromPreset(getPresetById(eqPresetIdRef.current, cp, ov).bands) });
                        }}>
                            <Text style={[s.resetBtnText, { color: base.textFaint }]}>Start from the current preset</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[s.resetBtn, { borderColor: base.border }]} onPress={() => commit({ ...defaultCustomEQ(), enabled: custom.enabled })}>
                            <Text style={[s.resetBtnText, { color: base.textFaint }]}>Reset all bands to flat</Text>
                        </TouchableOpacity>
                        <View style={{ height: 24 }} />
                    </ScrollView>
                </View>
            </BottomSheet>

            <BottomSheet visible={showImport} onClose={() => setShowImport(false)} expandable>
                <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, paddingHorizontal: 20 }}>
                    <Text style={s.sheetTitle}>Import EQ</Text>
                    <Text style={{ color: base.textFaint, fontSize: 13, marginBottom: 12 }}>
                        Paste a SySlate EQ export, an Equalizer APO "GraphicEQ:" line, or "Filter 1: ON PK Fc 100 Hz Gain -2 dB Q 1.0" lines (AutoEq):
                    </Text>
                    <TextInput
                        style={[s.nameInput, { flex: 1, minHeight: 120, textAlignVertical: 'top', borderColor: theme.accent }]}
                        value={importText} onChangeText={setImportText}
                        placeholder="Paste here..." placeholderTextColor="#333"
                        multiline autoCorrect={false} autoCapitalize="none"
                    />
                    <TouchableOpacity style={[s.saveBtn, { backgroundColor: theme.accent }]} onPress={applyImport}>
                        <Text style={[s.saveBtnText, { color: theme.onAccent }]}>Import</Text>
                    </TouchableOpacity>
                </KeyboardAvoidingView>
            </BottomSheet>
        </>
    );
}

function SliderLine({ label, value, base, dim, children }) {
    return (
        <View style={[st.line, dim && { opacity: 0.45 }]}>
            <Text style={{ color: base.textFaint, fontSize: 11, width: 34 }}>{label}</Text>
            {children}
            <Text style={{ color: base.textDim ?? base.textFaint, fontSize: 11, width: 74, textAlign: 'right' }}>{value}</Text>
        </View>
    );
}

const st = StyleSheet.create({
    topRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 8 },
    card: { borderWidth: 1, borderRadius: 12, padding: 10, marginBottom: 10 },
    cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
    typeRow: { flexDirection: 'row', gap: 6 },
    typeChip: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
    line: { flexDirection: 'row', alignItems: 'center', marginVertical: 2 },
});
