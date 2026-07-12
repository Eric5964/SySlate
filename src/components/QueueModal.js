import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import TrackPlayer from 'react-native-track-player';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import SwipeableRow from './SwipeableRow';
import BottomSheet from './BottomSheet';

export default function QueueModal({ visible, onClose }) {
    const { theme } = useTheme();
    const { priorityQueue, jumpToQueueIndex, removeFromQueue, promoteToQueue } = usePlayback();
    const [rows, setRows] = useState([]); // [{ realIndex, song, isPriority }]
    const [scrollLock, setScrollLock] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const queue = await TrackPlayer.getQueue();
            const currentIndex = await TrackPlayer.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) { setRows([]); return; }
            const upcoming = queue.slice(currentIndex + 1).map((song, i) => ({
                realIndex: currentIndex + 1 + i,
                song,
                isPriority: priorityQueue.includes(song.id),
            }));
            setRows(upcoming);
        } catch { setRows([]); }
    }, [priorityQueue]);

    useEffect(() => { if (visible) refresh(); }, [visible, refresh]);

    const priorityRows = rows.filter(r => r.isPriority);
    const upNextRows = rows.filter(r => !r.isPriority);

    const jump = async (realIndex) => { await jumpToQueueIndex(realIndex); await refresh(); };
    const remove = async (song) => { await removeFromQueue(song.id); await refresh(); };
    const promote = async (song) => { await promoteToQueue(song.id); await refresh(); };

    const renderRow = ({ song, realIndex, isPriority }) => (
        <SwipeableRow
            key={song.id + '-' + realIndex}
            onSwipeLeft={() => remove(song)}
            onSwipeRight={isPriority ? undefined : () => promote(song)}
            rightColor={theme.accent}
            leftColor="#dc2626"
            onGestureActive={setScrollLock}
        >
            <TouchableOpacity style={s.qRow} onPress={() => jump(realIndex)} activeOpacity={0.7}>
                <View style={{ flex: 1 }}>
                    <Text style={s.qTitle} numberOfLines={1}>{song.ourTitle ?? song.title}</Text>
                    <Text style={s.qArtist} numberOfLines={1}>{song.ourArtist ?? song.artist}</Text>
                </View>
                {!isPriority && <Text style={s.hint}>swipe →</Text>}
            </TouchableOpacity>
        </SwipeableRow>
    );

    return (
        <BottomSheet visible={visible} onClose={onClose}>
            <Text style={s.sheetTitle}>Up Next</Text>
            {rows.length === 0 ? (
                <Text style={s.empty}>Nothing up next</Text>
            ) : (
                <ScrollView scrollEnabled={!scrollLock} showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
                    {priorityRows.length > 0 && (
                        <>
                            <Text style={[s.groupLabel, { color: theme.accent }]}>Priority</Text>
                            {priorityRows.map(renderRow)}
                        </>
                    )}
                    {upNextRows.length > 0 && (
                        <>
                            <Text style={s.groupLabel}>Up Next</Text>
                            {upNextRows.map(renderRow)}
                        </>
                    )}
                </ScrollView>
            )}
        </BottomSheet>
    );
}

const s = StyleSheet.create({
    sheetTitle: { color: '#555', fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 16, paddingHorizontal: 24 },
    groupLabel: { color: '#444', fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginTop: 10, marginBottom: 4, paddingHorizontal: 24 },
    empty: { color: '#333', fontSize: 14, textAlign: 'center', paddingVertical: 24 },
    qRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: '#1a1a1a', backgroundColor: '#0f0f0f' },
    qTitle: { color: '#d0d0d0', fontSize: 14, fontWeight: '500' },
    qArtist: { color: '#444', fontSize: 12, marginTop: 2 },
    hint: { color: '#2a2a2a', fontSize: 10 },
});
