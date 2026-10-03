import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import PureSlider from './PureSlider';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import BottomSheet from './BottomSheet';

const DURATIONS = [15, 30, 45, 60, 90];

function formatCustom(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h === 0) return `${m} min`;
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function formatRemaining(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
}

export default function SleepTimerSheet({ visible, onClose }) {
    const { theme, base } = useTheme();
    const { sleepTimerEndAt, sleepAtTrackEnd, setSleepTimer, setSleepTimerAtTrackEnd, cancelSleepTimer } = usePlayback();
    const [now, setNow] = useState(Date.now());
    const [customOpen, setCustomOpen] = useState(false);
    const [customMin, setCustomMin] = useState(20);
    useEffect(() => { if (!visible) setCustomOpen(false); }, [visible]);

    // Only ticks while a duration timer is actually active and this sheet is
    // open — no reason to run a 1s interval in the background otherwise.
    // Refreshes immediately on start rather than waiting for the first
    // setInterval tick (which doesn't fire until a full second has already
    // passed) — that gap was what made the countdown look frozen at the
    // starting value for up to a second after opening the sheet.
    useEffect(() => {
        if (!visible || !sleepTimerEndAt) return;
        setNow(Date.now());
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [visible, sleepTimerEndAt]);

    const active = !!sleepTimerEndAt || sleepAtTrackEnd;

    return (
        <BottomSheet visible={visible} onClose={onClose} header={<Text style={[s.sheetTitle, { color: base.text }]}>Sleep Timer</Text>}>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 }}>
            {active && (
                <View style={[s.activeRow, { borderBottomColor: base.border }]}>
                    <Text style={[s.activeLabel, { color: base.textDim }]}>
                        {sleepAtTrackEnd ? 'Pausing at the end of this track' : `Pausing in ${formatRemaining(sleepTimerEndAt - now)}`}
                    </Text>
                    <TouchableOpacity onPress={() => { cancelSleepTimer(); onClose(); }}>
                        <Text style={[s.cancelText, { color: theme.accent }]}>Cancel</Text>
                    </TouchableOpacity>
                </View>
            )}
            {DURATIONS.map(min => (
                <TouchableOpacity key={min} style={[s.row, { borderBottomColor: base.border }]}
                    onPress={() => { setSleepTimer(min); onClose(); }}
                >
                    <Text style={[s.rowText, { color: base.text }]}>{min} minutes</Text>
                </TouchableOpacity>
            ))}
            <TouchableOpacity style={[s.row, { borderBottomColor: base.border }]} onPress={() => setCustomOpen(o => !o)}>
                <Text style={[s.rowText, { color: customOpen ? theme.accent : base.text }]}>Custom…</Text>
            </TouchableOpacity>
            {customOpen && (
                <View style={[s.customBox, { borderBottomColor: base.border }]}>
                    <Text style={[s.customVal, { color: theme.accent }]}>{formatCustom(customMin)}</Text>
                    <PureSlider style={{ width: '100%', height: 40 }} minimumValue={1} maximumValue={180} step={1} value={customMin}
                        onValueChange={setCustomMin}
                        minimumTrackTintColor={theme.accent} thumbTintColor={theme.accent} />
                    <View style={s.customEnds}><Text style={[s.customEnd, { color: base.textFaint }]}>1 min</Text><Text style={[s.customEnd, { color: base.textFaint }]}>3 h</Text></View>
                    <TouchableOpacity style={[s.startBtn, { backgroundColor: theme.accent }]} onPress={() => { setSleepTimer(customMin); onClose(); }}>
                        <Text style={[s.startText, { color: theme.onAccent }]}>Start</Text>
                    </TouchableOpacity>
                </View>
            )}
            <TouchableOpacity style={[s.row, { borderBottomColor: base.border }]}
                onPress={() => { setSleepTimerAtTrackEnd(); onClose(); }}
            >
                <Text style={[s.rowText, { color: base.text }]}>End of current track</Text>
            </TouchableOpacity>
            </ScrollView>
        </BottomSheet>
    );
}

const s = StyleSheet.create({
    sheetTitle: { fontSize: 16, fontWeight: '700', marginBottom: 4, paddingHorizontal: 24 },
    activeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 16, paddingHorizontal: 24, borderBottomWidth: 1, marginBottom: 4 },
    activeLabel: { fontSize: 14 },
    cancelText: { fontSize: 14, fontWeight: '700' },
    row: { paddingVertical: 18, paddingHorizontal: 24, borderBottomWidth: 1 },
    rowText: { fontSize: 17 },
    customBox: { paddingVertical: 16, paddingHorizontal: 24, borderBottomWidth: 1, alignItems: 'stretch' },
    customVal: { fontSize: 22, fontWeight: '700', textAlign: 'center', marginBottom: 4 },
    customEnds: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
    customEnd: { fontSize: 12 },
    startBtn: { borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
    startText: { fontSize: 15, fontWeight: '700' },
});
