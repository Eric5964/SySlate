import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, Modal, ScrollView, StyleSheet } from 'react-native';
import TrackPlayer from 'react-native-track-player';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import SwipeableRow from './SwipeableRow';

export default function QueueModal({ visible, onClose }) {
    const { theme } = useTheme();
    const { priorityQueue, jumpToQueueIndex, removeFromQueue } = usePlayback();
    const [rows, setRows] = useState([]); // [{ realIndex, song, isPriority }]

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

    const jump = async (realIndex) => {
        await jumpToQueueIndex(realIndex);
        await refresh();
    };

    const remove = async (realIndex) => {
        await removeFromQueue(realIndex);
        await refresh();
    };

    const renderRow = ({ song, realIndex }) => (
        <SwipeableRow key={song.id + realIndex} onSwipeLeft={() => remove(realIndex)} leftColor="#dc2626">
            <TouchableOpacity style={s.qRow} onPress={() => jump(realIndex)} activeOpacity={0.7}>
                <View style={{ flex: 1 }}>
                    <Text style={s.qTitle} numberOfLines={1}>{song.ourTitle ?? song.title}</Text>
                    <Text style={s.qArtist} numberOfLines={1}>{song.ourArtist ?? song.artist}</Text>
                </View>
            </TouchableOpacity>
        </SwipeableRow>
    );

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={onClose} />
            <View style={s.sheet}>
                <View style={s.handle} />
                <Text style={s.sheetTitle}>Up Next</Text>
                {rows.length === 0 ? (
                    <Text style={s.empty}>Nothing up next</Text>
                ) : (
                    <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
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
            </View>
        </Modal>
    );
}

const s = StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)' },
    sheet: { backgroundColor: '#0f0f0f', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 24, paddingTop: 12, paddingBottom: 52 },
    handle: { width: 36, height: 4, backgroundColor: '#222', borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
    sheetTitle: { color: '#555', fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 16 },
    groupLabel: { color: '#444', fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginTop: 10, marginBottom: 4 },
    empty: { color: '#333', fontSize: 14, textAlign: 'center', paddingVertical: 24 },
    qRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1a1a1a', backgroundColor: '#0f0f0f' },
    qTitle: { color: '#d0d0d0', fontSize: 14, fontWeight: '500' },
    qArtist: { color: '#444', fontSize: 12, marginTop: 2 },
});