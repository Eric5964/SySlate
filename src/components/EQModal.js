import React, { useEffect, useState } from 'react';
import { Text, TouchableOpacity, StyleSheet, ScrollView, View } from 'react-native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { BUILT_IN_PRESETS } from '../utils/eq';
import { getCustomPresets, getHiddenPresets, setEQLayering, toStablePath } from '../utils/storage';
import BottomSheet from './BottomSheet';

// Picking a preset changes your CURRENT EQ (the one that plays unless a song or playlist has its own).
// With "EQ per playlist and song" on, the footer also lets you give a preset to this playlist or to songs;
// with it off, a quiet line offers to turn it on.
// pickMode: choosing an EQ to assign to songs (onPick gets the preset id) instead of changing the current EQ.
// onAssign: shows the "Assign to songs" button.
export default function EQModal({ visible, onClose, playlistPath, pickMode = false, onPick, onAssign }) {
    const { theme, base } = useTheme();
    const { eqPresetId, changeEQPreset, eqLayer, eqOverride, playlistEQMap, assignPlaylistEQ, assignSongEQ, currentTrack, currentPlaylist } = usePlayback();
    const [eqPresets, setEqPresets] = useState(BUILT_IN_PRESETS);
    const [allPresets, setAllPresets] = useState(BUILT_IN_PRESETS);

    useEffect(() => {
        if (!visible) return;
        (async () => {
            const custom = await getCustomPresets();
            const hidden = await getHiddenPresets();
            setAllPresets([...BUILT_IN_PRESETS, ...custom]);
            // Flat used to be exempt from hiding, so unchecking it in Settings did nothing here.
            setEqPresets([...BUILT_IN_PRESETS, ...custom].filter(p => !hidden.includes(p.id)));
        })();
    }, [visible]);

    const nameOf = (id) => allPresets.find(p => p.id === id)?.name || id;
    const plKey = playlistPath ? toStablePath(playlistPath) : null;
    const plEQ = plKey ? playlistEQMap?.[plKey] : null;
    const showLayers = !pickMode && eqLayer;
    const showPlaylistBtn = showLayers && !!plKey;
    // Only what is playing can be overridden: say so, so a pick that has no audible effect is not a mystery.
    const overrideText = showLayers && eqOverride
        ? (eqOverride.source === 'song' ? `This song plays with its own EQ (${nameOf(eqOverride.id)}).` : `This playlist plays with its own EQ (${nameOf(eqOverride.id)}).`)
        : null;

    const footer = pickMode ? null : (showLayers ? (
        <View style={{ gap: 8 }}>
            {showPlaylistBtn ? (
                <TouchableOpacity style={[s.assignBtn, { borderColor: theme.accent }]}
                    onPress={() => assignPlaylistEQ(playlistPath, plEQ ? null : eqPresetId)}>
                    <Text style={[s.assignText, { color: theme.accent }]} numberOfLines={1}>
                        {plEQ ? `Stop using ${nameOf(plEQ)} for this playlist` : `Use ${nameOf(eqPresetId)} for this playlist`}
                    </Text>
                </TouchableOpacity>
            ) : null}
            {onAssign ? (
                <TouchableOpacity style={[s.assignBtn, { borderColor: theme.accent }]} onPress={onAssign}>
                    <Text style={[s.assignText, { color: theme.accent }]}>Assign an EQ to songs</Text>
                </TouchableOpacity>
            ) : null}
        </View>
    ) : (
        <TouchableOpacity style={s.offBtn} onPress={() => setEQLayering(true)}>
            <Text style={[s.offText, { color: base.textFaint }]}>Want a different EQ per playlist or song? Turn it on</Text>
        </TouchableOpacity>
    ));

    return (
        <BottomSheet visible={visible} onClose={onClose} expandable footer={footer}
            header={<View>
                <Text style={[s.sheetTitle, { color: base.text }]}>{pickMode ? 'Assign which EQ?' : 'EQ Preset'}</Text>
                {overrideText ? (
                    <View style={s.overrideRow}>
                        <Text style={[s.overrideText, { color: base.textFaint }]}>{overrideText}</Text>
                        <TouchableOpacity onPress={() => {
                            if (eqOverride.source === 'song') assignSongEQ([currentTrack], null);
                            else assignPlaylistEQ(currentPlaylist?.path, null);
                        }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <Text style={[s.overrideText, { color: theme.accent, fontWeight: '700' }]}>Remove</Text>
                        </TouchableOpacity>
                    </View>
                ) : null}
            </View>}>
            <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
                {eqPresets.length === 0
                    ? <Text style={[s.empty, { color: base.textFaint }]}>No presets visible — manage in Settings</Text>
                    : eqPresets.map(p => (
                        <TouchableOpacity key={p.id} style={[s.presetRow, { borderBottomColor: base.border }]}
                            onPress={() => {
                                if (pickMode) { onPick?.(p.id); onClose(); return; }
                                changeEQPreset(p.id);
                                // With the playlist buttons showing, stay open so "Use ... for this playlist" is one tap away.
                                if (!showPlaylistBtn) onClose();
                            }}
                        >
                            <Text style={[s.presetName, { color: base.textFaint }, !pickMode && eqPresetId === p.id && { color: base.text, fontWeight: '700' }]}>{p.name}</Text>
                            {!pickMode && eqPresetId === p.id && <Text style={{ color: theme.accent, fontSize: 20 }}>✓</Text>}
                        </TouchableOpacity>
                    ))
                }
            </ScrollView>
        </BottomSheet>
    );
}

const s = StyleSheet.create({
    sheetTitle: { fontSize: 16, fontWeight: '700', marginBottom: 4, paddingHorizontal: 24 },
    overrideRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingBottom: 6, gap: 12 },
    overrideText: { fontSize: 12, flex: 1 },
    presetRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 18, paddingHorizontal: 24, borderBottomWidth: 1 },
    presetName: { fontSize: 17 },
    assignBtn: { borderWidth: 1.5, borderRadius: 14, paddingVertical: 13, alignItems: 'center', paddingHorizontal: 12 },
    assignText: { fontSize: 15, fontWeight: '700' },
    offBtn: { paddingVertical: 12, alignItems: 'center' },
    offText: { fontSize: 13 },
    empty: { fontSize: 14, textAlign: 'center', paddingVertical: 24, paddingHorizontal: 24 },
});
