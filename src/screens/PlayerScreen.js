import React, { useEffect, useState } from 'react';
import {
    View, Text, TouchableOpacity, StyleSheet,
    Dimensions, Modal, FlatList, Image,
} from 'react-native';
import TrackPlayer, { useProgress, usePlaybackState, State, Event } from 'react-native-track-player';
import { useNavigation, useRoute } from '@react-navigation/native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { BUILT_IN_PRESETS, getPresetById } from '../utils/eq';
import { skipWithCrossfade } from '../services/PlaybackService';
import { getCustomPresets, getHiddenPresets } from '../utils/storage';

const { width } = Dimensions.get('window');

function fmt(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

export default function PlayerScreen() {
    const navigation = useNavigation();
    const route = useRoute();
    const { playlist } = route.params ?? {};
    const { theme } = useTheme();

    const {
        currentPlaylist, eqPresetId, shuffleOn, repeatMode,
        loadPlaylist, changeEQPreset, toggleShuffle, cycleRepeat, saveSession,
    } = usePlayback();

    const progress = useProgress();
    const playbackState = usePlaybackState();
    const isPlaying = playbackState.state === State.Playing;

    const [track, setTrack] = useState(null);
    const [showEQ, setShowEQ] = useState(false);
    const [showQueue, setShowQueue] = useState(false);
    const [queue, setQueue] = useState([]);
    const [eqPresets, setEqPresets] = useState(BUILT_IN_PRESETS);

    useEffect(() => {
        if (playlist && (!currentPlaylist || currentPlaylist.path !== playlist.path)) {
            loadPlaylist(playlist);
        }
    }, []);

    useEffect(() => {
        const refresh = async () => {
            try {
                const idx = await TrackPlayer.getCurrentTrack();
                if (idx !== null && idx !== undefined) {
                    const t = await TrackPlayer.getTrack(idx);
                    setTrack(t);
                    saveSession();
                }
            } catch { }
        };
        refresh();
        const sub = TrackPlayer.addEventListener(Event.PlaybackTrackChanged, refresh);
        return () => sub.remove();
    }, []);

    useEffect(() => {
        (async () => {
            const custom = await getCustomPresets();
            const hidden = await getHiddenPresets();
            const visible = [...BUILT_IN_PRESETS, ...custom].filter(p => !hidden.includes(p.id));
            setEqPresets(visible);
        })();
    }, [showEQ]);

    const openQueue = async () => {
        try {
            const q = await TrackPlayer.getQueue();
            const idx = await TrackPlayer.getCurrentTrack();
            setQueue(q.slice(idx !== null ? idx + 1 : 0));
            setShowQueue(true);
        } catch { }
    };

    const seekRatio = (ratio) => {
        if (progress.duration > 0) TrackPlayer.seekTo(ratio * progress.duration);
    };

    const pct = progress.duration > 0 ? (progress.position / progress.duration) : 0;

    return (
        <View style={s.container}>
            {/* Top bar */}
            <View style={s.topBar}>
                <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={HIT} style={s.topBtn}>
                    <Text style={[s.topIcon, { color: theme.accent }]}>↓</Text>
                </TouchableOpacity>
                <Text style={s.topLabel} numberOfLines={1}>{currentPlaylist?.name ?? 'Now Playing'}</Text>
                <View style={{ flexDirection: 'row' }}>
                    <TouchableOpacity onPress={() => setShowEQ(true)} hitSlop={HIT} style={s.topBtn}>
                        <Text style={[s.topTag, { color: theme.accent }]}>EQ</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={openQueue} hitSlop={HIT} style={s.topBtn}>
                        <Text style={[s.topTag, { color: theme.accent }]}>≡</Text>
                    </TouchableOpacity>
                </View>
            </View>

            {/* Art */}
            <View style={s.artWrap}>
                <View style={[s.art, { borderColor: theme.accentDim, shadowColor: theme.accent }]}>
                    {track?.artwork
                        ? <Image source={{ uri: track.artwork }} style={s.artImage} resizeMode="cover" />
                        : <Text style={[s.artNote, { color: theme.accentDim }]}>♪</Text>
                    }
                </View>
            </View>

            {/* Info */}
            <View style={s.info}>
                <Text style={s.trackTitle} numberOfLines={2}>{track?.title ?? '—'}</Text>
                <Text style={[s.trackArtist, { color: theme.accent }]} numberOfLines={1}>{track?.artist ?? '—'}</Text>
            </View>

            {/* Progress */}
            <View style={s.progressSection}>
                <View
                    style={s.progressTouch}
                    onStartShouldSetResponder={() => true}
                    onResponderGrant={e => seekRatio(Math.max(0, Math.min(1, e.nativeEvent.locationX / (width - 56))))}
                    onResponderMove={e => seekRatio(Math.max(0, Math.min(1, e.nativeEvent.locationX / (width - 56))))}
                >
                    <View style={s.progressTrack}>
                        <View style={[s.progressFill, { width: `${pct * 100}%`, backgroundColor: theme.accent }]} />
                    </View>
                </View>
                <View style={s.times}>
                    <Text style={s.time}>{fmt(progress.position)}</Text>
                    <Text style={s.time}>{fmt(progress.duration)}</Text>
                </View>
            </View>

            {/* Controls */}
            <View style={s.controls}>
                <TouchableOpacity onPress={toggleShuffle} style={s.sideBtn} hitSlop={HIT}>
                    <Text style={[s.sideIcon, { color: shuffleOn ? theme.accent : '#333' }]}>⇌</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => skipWithCrossfade('prev')} style={s.skipBtn} hitSlop={HIT}>
                    <Text style={s.skipIcon}>|◁</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={() => isPlaying ? TrackPlayer.pause() : TrackPlayer.play()}
                    style={[s.playBtn, { backgroundColor: theme.accent, shadowColor: theme.accent }]}
                >
                    <Text style={s.playIcon}>{isPlaying ? '❙❙' : '▶'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => skipWithCrossfade('next')} style={s.skipBtn} hitSlop={HIT}>
                    <Text style={s.skipIcon}>▷|</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={cycleRepeat} style={s.sideBtn} hitSlop={HIT}>
                    <Text style={[s.sideIcon, { color: repeatMode !== 'off' ? theme.accent : '#333' }]}>
                        {repeatMode === 'one' ? '↺¹' : '↺'}
                    </Text>
                </TouchableOpacity>
            </View>

            {/* EQ Modal */}
            <Modal visible={showEQ} transparent animationType="slide" onRequestClose={() => setShowEQ(false)}>
                <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setShowEQ(false)} />
                <View style={s.sheet}>
                    <View style={s.sheetHandle} />
                    <Text style={s.sheetTitle}>EQ Preset</Text>
                    {eqPresets.length === 0
                        ? <Text style={s.queueEmpty}>No presets — manage in Settings</Text>
                        : eqPresets.map(p => (
                            <TouchableOpacity
                                key={p.id} style={s.presetRow}
                                onPress={() => { changeEQPreset(p.id, currentPlaylist?.path); setShowEQ(false); }}
                            >
                                <Text style={[s.presetName, eqPresetId === p.id && { color: '#f0f0f0', fontWeight: '600' }]}>{p.name}</Text>
                                {eqPresetId === p.id && <Text style={{ color: theme.accent, fontSize: 18 }}>✓</Text>}
                            </TouchableOpacity>
                        ))
                    }
                </View>
            </Modal>

            {/* Queue Modal */}
            <Modal visible={showQueue} transparent animationType="slide" onRequestClose={() => setShowQueue(false)}>
                <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setShowQueue(false)} />
                <View style={s.sheet}>
                    <View style={s.sheetHandle} />
                    <Text style={s.sheetTitle}>Up Next</Text>
                    {queue.length === 0
                        ? <Text style={s.queueEmpty}>Nothing queued</Text>
                        : <FlatList
                            data={queue}
                            keyExtractor={(item, i) => item.id + i}
                            style={{ maxHeight: 340 }}
                            renderItem={({ item, index }) => (
                                <View style={s.qRow}>
                                    <Text style={s.qNum}>{index + 1}</Text>
                                    <View style={{ flex: 1 }}>
                                        <Text style={s.qTitle} numberOfLines={1}>{item.title}</Text>
                                        <Text style={s.qArtist} numberOfLines={1}>{item.artist}</Text>
                                    </View>
                                </View>
                            )}
                        />
                    }
                </View>
            </Modal>
        </View>
    );
}

const HIT = { top: 16, bottom: 16, left: 16, right: 16 };

const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0a0a0a', paddingTop: 56 },
    topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, marginBottom: 20 },
    topBtn: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
    topIcon: { fontSize: 24 },
    topTag: { fontSize: 15, fontWeight: '700' },
    topLabel: { color: '#444', fontSize: 13, flex: 1, textAlign: 'center', marginHorizontal: 4 },
    artWrap: { alignItems: 'center', marginBottom: 24 },
    art: { width: width - 64, height: width - 64, borderRadius: 20, backgroundColor: '#0f0f0f', borderWidth: 1, justifyContent: 'center', alignItems: 'center', overflow: 'hidden', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.25, shadowRadius: 20 },
    artImage: { width: '100%', height: '100%' },
    artNote: { fontSize: 80 },
    info: { paddingHorizontal: 28, marginBottom: 18 },
    trackTitle: { color: '#f0f0f0', fontSize: 21, fontWeight: '700', marginBottom: 4, letterSpacing: -0.3 },
    trackArtist: { fontSize: 14, fontWeight: '500' },
    progressSection: { paddingHorizontal: 28, marginBottom: 28 },
    progressTouch: { height: 36, justifyContent: 'center' },
    progressTrack: { height: 4, backgroundColor: '#1a1a1a', borderRadius: 2 },
    progressFill: { height: 4, borderRadius: 2 },
    times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
    time: { color: '#3a3a3a', fontSize: 12 },
    controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20 },
    sideBtn: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
    sideIcon: { fontSize: 24 },
    skipBtn: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
    skipIcon: { color: '#ccc', fontSize: 26 },
    playBtn: { width: 72, height: 72, borderRadius: 36, justifyContent: 'center', alignItems: 'center', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 12 },
    playIcon: { color: '#fff', fontSize: 26 },
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)' },
    sheet: { backgroundColor: '#0f0f0f', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 24, paddingTop: 12, paddingBottom: 52 },
    sheetHandle: { width: 36, height: 4, backgroundColor: '#222', borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
    sheetTitle: { color: '#555', fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 16 },
    presetRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
    presetName: { color: '#555', fontSize: 16 },
    queueEmpty: { color: '#333', fontSize: 14, textAlign: 'center', paddingVertical: 24 },
    qRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
    qNum: { color: '#2a2a2a', fontSize: 13, width: 28 },
    qTitle: { color: '#d0d0d0', fontSize: 14, fontWeight: '500' },
    qArtist: { color: '#444', fontSize: 12, marginTop: 2 },
});