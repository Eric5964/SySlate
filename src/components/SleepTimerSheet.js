import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import BottomSheet from './BottomSheet';

const DURATIONS = [15, 30, 45, 60, 90];

function formatRemaining(ms) {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
}

export default function SleepTimerSheet({ visible, onClose }) {
    const { theme } = useTheme();
    const { sleepTimerEndAt, sleepAtTrackEnd, setSleepTimer, setSleepTimerAtTrackEnd, cancelSleepTimer } = usePlayback();
    const [now, setNow] = useState(Date.now());

    // Only ticks while a duration timer is actually active and this sheet is
    // open — no reason to run a 1s interval in the background otherwise.
    useEffect(() => {
        if (!visible || !sleepTimerEndAt) return;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [visible, sleepTimerEndAt]);

    const active = !!sleepTimerEndAt || sleepAtTrackEnd;

    return (
        <BottomSheet visible={visible} onClose={onClose} header={<Text style={s.sheetTitle}>Sleep Timer</Text>}>
            {active && (
                <View style={s.activeRow}>
                    <Text style={s.activeLabel}>
                        {sleepAtTrackEnd ? 'Pausing at the end of this track' : `Pausing in ${formatRemaining(sleepTimerEndAt - now)}`}
                    </Text>
                    <TouchableOpacity onPress={() => { cancelSleepTimer(); onClose(); }}>
                        <Text style={[s.cancelText, { color: theme.accent }]}>Cancel</Text>
                    </TouchableOpacity>
                </View>
            )}
            {DURATIONS.map(min => (
                <TouchableOpacity key={min} style={s.row}
                    onPress={() => { setSleepTimer(min); onClose(); }}
                >
                    <Text style={s.rowText}>{min} minutes</Text>
                </TouchableOpacity>
            ))}
            <TouchableOpacity style={s.row}
                onPress={() => { setSleepTimerAtTrackEnd(); onClose(); }}
            >
                <Text style={s.rowText}>End of current track</Text>
            </TouchableOpacity>
        </BottomSheet>
    );
}

const s = StyleSheet.create({
    sheetTitle: { color: '#e5e5e5', fontSize: 16, fontWeight: '700', marginBottom: 4, paddingHorizontal: 24 },
    activeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 16, paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: '#1a1a1a', marginBottom: 4 },
    activeLabel: { color: '#999', fontSize: 14 },
    cancelText: { fontSize: 14, fontWeight: '700' },
    row: { paddingVertical: 18, paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
    rowText: { color: '#e5e5e5', fontSize: 17 },
});
