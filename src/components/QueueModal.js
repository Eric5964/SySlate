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

    const refresh = useCallback(async (priorityOverride) => {
        try {
            const queue = await TrackPlayer.getQueue();
            const currentIndex = await TrackPlayer.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) { setRows([]); return; }
            const activePriority = priorityOverride ?? priorityQueue;
            const upcoming = queue.slice(currentIndex + 1).map((song, i) => ({
                realIndex: currentIndex + 1 + i,
                song,
                isPriority: activePriority.includes(song.id),
            }));
            setRows(upcoming);
        } catch { setRows([]); }
    }, [priorityQueue]);

    useEffect(() => { if (visible) refresh(); }, [visible, refresh]);

    const priorityRows = rows.filter(r => r.isPriority);
    const upNextRows = rows.filter(r => !r.isPriority);

    const jump = async (realIndex) => { await jumpToQueueIndex(realIndex); await refresh(); };
    const remove = async (song) => { const next = await removeFromQueue(song.id); await refresh(next); };
    const promote = async (song) => { const next = await promoteToQueue(song.id); await refresh(next); };

    const renderRow = ({ song, realIndex, isPriority }) => (
        <SwipeableRow
            key={song.id + '-' + realIndex}
            onSwipeLeft={() => remove(song)}
            onSwipeRight={isPriority ? undefined : () => promote(song)}
            rightColor={theme.accent}
            leftColor="#dc2626"
        >
            <TouchableOpacity style={s.qRow} onPress={() => jump(realIndex)} activeOpacity={0.7}>
                <View style={{ flex: 1 }}>
                    <Text style={s.qTitle} numberOfLines={1}>{song.ourTitle ?? song.title}</Text>
                    <Text style={s.qArtist} numberOfLines={1}>{song.ourArtist ?? song.artist}</Text>
                </View>
            </TouchableOpacity>
        </SwipeableRow>
    );

    return (
        <BottomSheet visible={visible} onClose={onClose}>
            <Text style={s.sheetTitle}>Queue</Text>
            {rows.length === 0 ? (
                <View style={{ flex: 1, justifyContent: 'center' }}>
                    <Text style={s.empty}>Nothing up next</Text>
                </View>
            ) : (
                <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
                    {priorityRows.length > 0 && (
                        <>
                            <View style={s.groupPill}><Text style={s.groupLabel}>Priority</Text></View>
                            {priorityRows.map(renderRow)}
                        </>
                    )}
                    {priorityRows.length > 0 && upNextRows.length > 0 && <View style={s.divider} />}
                    {upNextRows.length > 0 && (
                        <>
                            <View style={s.groupPill}><Text style={s.groupLabel}>Up Next</Text></View>
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
    groupPill: { marginHorizontal: 24, marginTop: 14, marginBottom: 6, alignSelf: 'flex-start', backgroundColor: '#1a1a1a', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
    groupLabel: { color: '#999', fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
    divider: { height: 1, backgroundColor: '#1e1e1e', marginHorizontal: 24, marginTop: 8 },
    empty: { color: '#333', fontSize: 14, textAlign: 'center' },
    qRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: '#1a1a1a', backgroundColor: '#0f0f0f' },
    qTitle: { color: '#d0d0d0', fontSize: 14, fontWeight: '500' },
    qArtist: { color: '#444', fontSize: 12, marginTop: 2 },
});
