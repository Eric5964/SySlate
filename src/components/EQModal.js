import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { BUILT_IN_PRESETS } from '../utils/eq';
import { getCustomPresets, getHiddenPresets } from '../utils/storage';
import BottomSheet from './BottomSheet';

export default function EQModal({ visible, onClose, playlistPath }) {
    const { theme } = useTheme();
    const { eqPresetId, changeEQPreset } = usePlayback();
    const [eqPresets, setEqPresets] = useState(BUILT_IN_PRESETS);

    useEffect(() => {
        if (!visible) return;
        (async () => {
            const custom = await getCustomPresets();
            const hidden = await getHiddenPresets();
            setEqPresets([...BUILT_IN_PRESETS, ...custom].filter(p => !hidden.includes(p.id)));
        })();
    }, [visible]);

    return (
        <BottomSheet visible={visible} onClose={onClose}>
            <Text style={s.sheetTitle}>EQ Preset</Text>
            <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
                {eqPresets.length === 0
                    ? <Text style={s.empty}>No presets visible — manage in Settings</Text>
                    : eqPresets.map(p => (
                        <TouchableOpacity key={p.id} style={s.presetRow}
                            onPress={() => { changeEQPreset(p.id, playlistPath); onClose(); }}
                        >
                            <Text style={[s.presetName, eqPresetId === p.id && { color: '#f0f0f0', fontWeight: '700' }]}>{p.name}</Text>
                            {eqPresetId === p.id && <Text style={{ color: theme.accent, fontSize: 20 }}>✓</Text>}
                        </TouchableOpacity>
                    ))
                }
            </ScrollView>
        </BottomSheet>
    );
}

const s = StyleSheet.create({
    sheetTitle: { color: '#555', fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 16, paddingHorizontal: 24 },
    presetRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 18, paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
    presetName: { color: '#555', fontSize: 17 },
    empty: { color: '#333', fontSize: 14, textAlign: 'center', paddingVertical: 24, paddingHorizontal: 24 },
});
