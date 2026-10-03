import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import BottomSheet from './BottomSheet';
import PureSlider from './PureSlider';

const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const MIN_SPEED = 0.25;
const MAX_SPEED = 3;

// "1x", "1.25x", "0.5x" (no trailing zeros).
export function formatSpeed(rate) {
    const r = Math.round(rate * 100) / 100;
    return `${String(r)}×`;
}

// Playback speed keeps the pitch (the song gets faster or slower without
// sounding higher or lower). It is a per-session setting: it goes back to 1×
// when the app is reopened.
export default function PlaybackSpeedSheet({ visible, onClose }) {
    const { theme, base } = useTheme();
    const { playbackRate, setPlaybackRate } = usePlayback();
    const [customOpen, setCustomOpen] = useState(false);
    const [custom, setCustom] = useState(playbackRate);
    useEffect(() => { if (!visible) setCustomOpen(false); }, [visible]);
    useEffect(() => { setCustom(playbackRate); }, [playbackRate, visible]);
    const isPreset = PRESETS.some(p => Math.abs(p - playbackRate) < 0.001);

    return (
        <BottomSheet visible={visible} onClose={onClose} header={<Text style={[s.sheetTitle, { color: base.text }]}>Playback Speed</Text>}>
            {PRESETS.map(p => {
                const on = Math.abs(p - playbackRate) < 0.001;
                return (
                    <TouchableOpacity key={p} style={[s.row, { borderBottomColor: base.border }]}
                        onPress={() => { setPlaybackRate(p); onClose(); }}>
                        <Text style={[s.rowText, { color: on ? theme.accent : base.text, fontWeight: on ? '700' : '400' }]}>
                            {p === 1 ? 'Normal (1×)' : formatSpeed(p)}
                        </Text>
                    </TouchableOpacity>
                );
            })}
            <TouchableOpacity style={[s.row, { borderBottomColor: base.border }]} onPress={() => setCustomOpen(o => !o)}>
                <Text style={[s.rowText, { color: customOpen || !isPreset ? theme.accent : base.text, fontWeight: !isPreset ? '700' : '400' }]}>
                    {!isPreset ? `Custom (${formatSpeed(playbackRate)})` : 'Custom…'}
                </Text>
            </TouchableOpacity>
            {customOpen && (
                <View style={[s.customBox, { borderBottomColor: base.border }]}>
                    <Text style={[s.customVal, { color: theme.accent }]}>{formatSpeed(custom)}</Text>
                    <PureSlider style={{ width: '100%', height: 40 }} minimumValue={MIN_SPEED} maximumValue={MAX_SPEED} step={0.05} value={custom}
                        onValueChange={setCustom}
                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                    <View style={s.customEnds}><Text style={[s.customEnd, { color: base.textFaint }]}>{MIN_SPEED}×</Text><Text style={[s.customEnd, { color: base.textFaint }]}>{MAX_SPEED}×</Text></View>
                    <TouchableOpacity style={[s.startBtn, { backgroundColor: theme.accent }]} onPress={() => { setPlaybackRate(Math.round(custom * 100) / 100); onClose(); }}>
                        <Text style={[s.startText, { color: theme.onAccent }]}>Set speed</Text>
                    </TouchableOpacity>
                </View>
            )}
        </BottomSheet>
    );
}

const s = StyleSheet.create({
    sheetTitle: { fontSize: 16, fontWeight: '700', marginBottom: 4, paddingHorizontal: 24 },
    row: { paddingVertical: 18, paddingHorizontal: 24, borderBottomWidth: 1 },
    rowText: { fontSize: 17 },
    customBox: { paddingVertical: 16, paddingHorizontal: 24, borderBottomWidth: 1, alignItems: 'stretch' },
    customVal: { fontSize: 22, fontWeight: '700', textAlign: 'center', marginBottom: 4 },
    customEnds: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
    customEnd: { fontSize: 12 },
    startBtn: { borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
    startText: { fontSize: 15, fontWeight: '700' },
});
