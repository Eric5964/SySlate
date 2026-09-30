import React, { useEffect, useState } from 'react';
import { Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { BUILT_IN_PRESETS } from '../utils/eq';
import { getCustomPresets, getHiddenPresets } from '../utils/storage';
import BottomSheet from './BottomSheet';

export default function EQModal({ visible, onClose, playlistPath }) {
    const { theme, base } = useTheme();
    const { eqPresetId, changeEQPreset } = usePlayback();
    const [eqPresets, setEqPresets] = useState(BUILT_IN_PRESETS);

    useEffect(() => {
        if (!visible) return;
        (async () => {
            const custom = await getCustomPresets();
            const hidden = await getHiddenPresets();
            setEqPresets([...BUILT_IN_PRESETS, ...custom].filter(p => p.id === 'flat' || !hidden.includes(p.id)));
        })();
    }, [visible]);

    return (
        <BottomSheet visible={visible} onClose={onClose} header={<Text style={[s.sheetTitle, { color: base.text }]}>EQ Preset</Text>}>
            <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
                {eqPresets.length === 0
                    ? <Text style={[s.empty, { color: base.textFaint }]}>No presets visible — manage in Settings</Text>
                    : eqPresets.map(p => (
                        <TouchableOpacity key={p.id} style={[s.presetRow, { borderBottomColor: base.border }]}
                            onPress={() => { changeEQPreset(p.id, playlistPath); onClose(); }}
                        >
                            <Text style={[s.presetName, { color: base.textFaint }, eqPresetId === p.id && { color: base.text, fontWeight: '700' }]}>{p.name}</Text>
                            {eqPresetId === p.id && <Text style={{ color: theme.accent, fontSize: 20 }}>✓</Text>}
                        </TouchableOpacity>
                    ))
                }
            </ScrollView>
        </BottomSheet>
    );
}

const s = StyleSheet.create({
    sheetTitle: { fontSize: 16, fontWeight: '700', marginBottom: 4, paddingHorizontal: 24 },
    presetRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 18, paddingHorizontal: 24, borderBottomWidth: 1 },
    presetName: { fontSize: 17 },
    empty: { fontSize: 14, textAlign: 'center', paddingVertical: 24, paddingHorizontal: 24 },
});
