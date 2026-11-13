import React, { useEffect, useState } from 'react';
import { Text, TouchableOpacity, StyleSheet, ScrollView, View, Alert } from 'react-native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { BUILT_IN_PRESETS } from '../utils/eq';
import { getCustomPresets, getHiddenPresets, toStablePath } from '../utils/storage';
import BottomSheet, { useSheetGuard, sheetBottomPad } from './BottomSheet';

// Picking a preset changes your CURRENT EQ (the one that plays unless a song or playlist has its own).
// With "EQ per playlist and song" on, the footer also lets you give a preset to this playlist or to songs;
// with it off, a quiet line offers to turn it on.
// pickMode: choosing an EQ to assign to songs (onPick gets the preset id) instead of changing the current EQ.
// onAssign: shows the "Assign to songs" button.
export default function EQModal({ visible, onClose, playlistPath, pickMode = false, onPick, onAssign }) {
    const { theme, base } = useTheme();
    const { eqPresetId, changeEQPreset, eqLayer, eqOverride, playlistEQMap, assignPlaylistEQ, assignSongEQ, currentTrack, currentPlaylist } = usePlayback();
    const { guard, contentDragging } = useSheetGuard();
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
    // An assigned preset that was deleted later has no name to show.
    const ovName = (id) => allPresets.find(p => p.id === id)?.name || 'a deleted preset';
    const plKey = playlistPath ? toStablePath(playlistPath) : null;
    const plEQ = plKey ? playlistEQMap?.[plKey] : null;
    const showLayers = !pickMode && eqLayer;
    const showPlaylistBtn = showLayers && !!plKey;
    // Only what is playing can be overridden: say so, so a pick that has no audible effect is not a mystery.
    // Giving a playlist its own EQ changes what every song in it sounds like, so say so first.
    const assignToPlaylist = () => {
        if (plEQ) { assignPlaylistEQ(playlistPath, eqPresetId); return; }   // already a deliberate choice: just change it
        Alert.alert(
            `Use ${nameOf(eqPresetId)} for this playlist?`,
            'Every song in this playlist will play with it. Songs you gave their own EQ keep theirs. Your regular EQ stays as it is for everything else.',
            [{ text: 'Cancel', style: 'cancel' }, { text: 'Use it', onPress: () => assignPlaylistEQ(playlistPath, eqPresetId) }]
        );
    };
    const overrideText = showLayers && eqOverride
        ? (eqOverride.source === 'song' ? `This song plays with its own EQ (${ovName(eqOverride.id)}).` : `This playlist plays with its own EQ (${ovName(eqOverride.id)}).`)
        : null;

    // Remove only appears where it can be understood: a song's own EQ on a playlist or All Songs screen, a playlist's EQ only on that playlist's screen.
    const canRemove = !!eqOverride && (eqOverride.source === 'song'
        ? (!!playlistPath || !!onAssign)
        : (!!plKey && toStablePath(currentPlaylist?.path) === plKey));

    // The note about this song's (or playlist's) own EQ sits at the bottom, above the buttons.
    const overrideBlock = overrideText ? (
        <View style={s.overrideRow}>
            <Text style={[s.overrideText, { color: base.textFaint }]}>{overrideText}</Text>
            {canRemove ? <TouchableOpacity onPress={() => {
                if (eqOverride.source === 'song') assignSongEQ([currentTrack], null);
                else assignPlaylistEQ(currentPlaylist?.path, null);
            }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={[s.overrideText, { color: theme.accent, fontWeight: '700' }]}>Remove</Text>
            </TouchableOpacity> : null}
        </View>
    ) : null;

    // Only on a playlist's own screen (it passes playlistPath / onAssign); the player and All Songs have no buttons.
    const footer = (!pickMode && showLayers && (showPlaylistBtn || onAssign || overrideText)) ? (
        <View style={{ gap: 8 }}>
            {overrideBlock}
            {showPlaylistBtn && (!plEQ || plEQ !== eqPresetId) ? (
                <TouchableOpacity style={[s.assignBtn, { borderColor: theme.accent }]} onPress={() => assignToPlaylist()}>
                    <Text style={[s.assignText, { color: theme.accent }]} numberOfLines={1}>
                        {plEQ ? `Change this playlist to ${nameOf(eqPresetId)}` : `Use ${nameOf(eqPresetId)} for this playlist`}
                    </Text>
                </TouchableOpacity>
            ) : null}
            {showPlaylistBtn && plEQ ? (
                <TouchableOpacity style={[s.assignBtn, { borderColor: base.border }]} onPress={() => assignPlaylistEQ(playlistPath, null)}>
                    <Text style={[s.assignText, { color: base.textFaint }]} numberOfLines={1}>Stop using {nameOf(plEQ)} for this playlist</Text>
                </TouchableOpacity>
            ) : null}
            {onAssign ? (
                <TouchableOpacity style={[s.assignBtn, { borderColor: theme.accent }]} onPress={() => onAssign(eqPresetId)}>
                    <Text style={[s.assignText, { color: theme.accent }]} numberOfLines={1}>Assign {nameOf(eqPresetId)} to songs</Text>
                </TouchableOpacity>
            ) : null}
        </View>
    ) : null;

    return (
        <BottomSheet visible={visible} onClose={onClose} expandable selfPadded footer={footer} guard={guard}
            header={<View style={{ alignSelf: 'stretch' }}>
                <Text style={[s.sheetTitle, { color: base.text }]}>{pickMode ? 'Assign which EQ?' : 'EQ Preset'}</Text>
            </View>}>
            <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} scrollEventThrottle={16} scrollEnabled={!contentDragging} contentContainerStyle={{ paddingBottom: sheetBottomPad() }}
                onScroll={(e) => { guard.current.atTop = e.nativeEvent.contentOffset.y <= 2; }}>
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
    overrideRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingHorizontal: 4, paddingBottom: 2, gap: 12, alignSelf: 'stretch' },
    overrideText: { fontSize: 12, flexShrink: 1 },
    presetRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 18, paddingHorizontal: 24, borderBottomWidth: 1 },
    presetName: { fontSize: 17 },
    assignBtn: { borderWidth: 1.5, borderRadius: 14, paddingVertical: 13, alignItems: 'center', paddingHorizontal: 12 },
    assignText: { fontSize: 15, fontWeight: '700' },
    empty: { fontSize: 14, textAlign: 'center', paddingVertical: 24, paddingHorizontal: 24 },
});
