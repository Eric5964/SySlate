import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, StyleSheet } from 'react-native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { BUILT_IN_PRESETS } from '../utils/eq';
import { getCustomPresets, getHiddenPresets } from '../utils/storage';

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
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={onClose} />
            <View style={s.sheet}>
                <View style={s.handle} />
                <Text style={s.sheetTitle}>EQ Preset</Text>
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
            </View>
        </Modal>
    );
}

const s = StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)' },
    sheet: { backgroundColor: '#0f0f0f', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 24, paddingTop: 12, paddingBottom: 52 },
    handle: { width: 36, height: 4, backgroundColor: '#222', borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
    sheetTitle: { color: '#555', fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 16 },
    presetRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
    presetName: { color: '#555', fontSize: 17 },
    empty: { color: '#333', fontSize: 14, textAlign: 'center', paddingVertical: 24 },
});