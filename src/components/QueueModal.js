import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import TrackPlayer from 'react-native-track-player';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import SwipeableRow from './SwipeableRow';
import BottomSheet from './BottomSheet';

export default function QueueModal({ visible, onClose }) {
    const { theme, base } = useTheme();
    const { priorityQueue, jumpToQueueIndex, removeFromQueue, promoteToQueue } = usePlayback();
    const [rows, setRows] = useState([]); // [{ realIndex, song, isPriority, stableKey }]

    const refresh = useCallback(async (priorityOverride) => {
        try {
            const queue = await TrackPlayer.getQueue();
            const currentIndex = await TrackPlayer.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) { setRows([]); return; }
            const activePriority = priorityOverride ?? priorityQueue;
            // stableKey is song.id + which occurrence of that id this is,
            // NOT realIndex. Keying by realIndex meant every row after a
            // removed/added item got a brand-new key on each refresh (since
            // their queue position shifted), so React treated them as
            // entirely new components and remounted the whole tail of the
            // list — that remount-flash was the actual "flash" on add/remove,
            // separate from the swipe feedback glow. Occurrence-based keys
            // only change for a row when a duplicate of ITS OWN song is
            // added/removed earlier in the list, which is rare.
            const idOccurrence = {};
            const upcoming = queue.slice(currentIndex + 1).map((song, i) => {
                const n = (idOccurrence[song.id] = (idOccurrence[song.id] || 0) + 1);
                return {
                    realIndex: currentIndex + 1 + i,
                    song,
                    isPriority: activePriority.includes(song.id),
                    stableKey: `${song.id}#${n}`,
                };
            });
            setRows(upcoming);
        } catch { setRows([]); }
    }, [priorityQueue]);

    useEffect(() => { if (visible) refresh(); }, [visible, refresh]);

    const priorityRows = rows.filter(r => r.isPriority);
    const upNextRows = rows.filter(r => !r.isPriority);

    const jump = async (realIndex) => { await jumpToQueueIndex(realIndex); await refresh(); };
    const remove = async (song) => { const next = await removeFromQueue(song.id); await refresh(next); };
    const promote = async (song) => { const next = await promoteToQueue(song.id); await refresh(next); };

    const renderRow = ({ song, realIndex, isPriority, stableKey }) => (
        <SwipeableRow
            key={stableKey}
            onSwipeLeft={() => remove(song)}
            onSwipeRight={isPriority ? undefined : () => promote(song)}
            rightColor={theme.accent}
            leftColor="#dc2626"
        >
            {/* Same shape as the All Songs / Playlist rows (rounded card,
                same padding/margins/colors) — only the interaction (swipe
                feedback, glow, etc.) stays specific to the queue context. */}
            <TouchableOpacity style={[s.qRow, { backgroundColor: base.surface }]} onPress={() => jump(realIndex)} activeOpacity={0.7}>
                <View style={{ flex: 1 }}>
                    <Text style={s.qTitle} numberOfLines={1}>{song.ourTitle ?? song.title}</Text>
                    <Text style={s.qArtist} numberOfLines={1}>{song.ourArtist ?? song.artist}</Text>
                </View>
            </TouchableOpacity>
        </SwipeableRow>
    );

    return (
        <BottomSheet visible={visible} onClose={onClose} header={<Text style={s.sheetTitle}>Queue</Text>}>
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
    // Matches SettingsScreen's "New EQ Preset" sheet title font — that was
    // the reference Eric pointed at (bigger/brighter, not the small dim
    // uppercase "eyebrow" style this used before).
    sheetTitle: { color: '#e5e5e5', fontSize: 16, fontWeight: '700', marginBottom: 4, paddingHorizontal: 24 },
    groupPill: { marginHorizontal: 24, marginTop: 14, marginBottom: 6, alignSelf: 'flex-start', backgroundColor: '#1a1a1a', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
    groupLabel: { color: '#999', fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
    divider: { height: 1, backgroundColor: '#1e1e1e', marginHorizontal: 24, marginTop: 8 },
    empty: { color: '#333', fontSize: 14, textAlign: 'center' },
    qRow: { paddingVertical: 14, paddingHorizontal: 20, marginHorizontal: 14, marginVertical: 2, borderRadius: 12 },
    qTitle: { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
    qArtist: { color: '#555', fontSize: 12, marginTop: 3 },
});
