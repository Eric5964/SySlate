import React, { useEffect, useState, useRef } from 'react';
import {
    View, Text, TouchableOpacity, StyleSheet,
    Dimensions, Modal, FlatList, Image, PanResponder,
} from 'react-native';
import TrackPlayer, { useProgress, usePlaybackState, State, Event } from 'react-native-track-player';
import { useNavigation, useRoute } from '@react-navigation/native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { BUILT_IN_PRESETS } from '../utils/eq';
import { skipWithCrossfade, playWithRamp, pauseWithRamp } from '../services/PlaybackService';
import { getCustomPresets, getHiddenPresets } from '../utils/storage';

const { width, height } = Dimensions.get('window');

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
        currentPlaylist, currentTrack, eqPresetId, shuffleOn, singleLoop,
        loadPlaylist, changeEQPreset, toggleShuffle, toggleSingleLoop, saveSession,
    } = usePlayback();

    const progress = useProgress(200);
    const playbackState = usePlaybackState();
    const isPlaying = playbackState.state === State.Playing;

    const [showEQ, setShowEQ] = useState(false);
    const [showQueue, setShowQueue] = useState(false);
    const [queue, setQueue] = useState([]);
    const [eqPresets, setEqPresets] = useState(BUILT_IN_PRESETS);

    // Progress bar measurement
    const progressRef = useRef(null);
    const progressLayout = useRef({ pageX: 28, width: width - 56 });

    // Swipe down to close
    const swipePan = useRef(PanResponder.create({
        onMoveShouldSetPanResponder: (_, gs) => gs.dy > 8 && Math.abs(gs.dy) > Math.abs(gs.dx) * 1.5,
        onPanResponderRelease: (_, gs) => { if (gs.dy > 70) navigation.goBack(); },
    })).current;

    useEffect(() => {
        if (playlist && (!currentPlaylist || currentPlaylist.path !== playlist.path)) {
            loadPlaylist(playlist);
        }
    }, []);

    useEffect(() => {
        const sub = TrackPlayer.addEventListener(Event.PlaybackTrackChanged, () => saveSession());
        return () => sub.remove();
    }, [saveSession]);

    useEffect(() => {
        if (!showEQ) return;
        (async () => {
            const custom = await getCustomPresets();
            const hidden = await getHiddenPresets();
            setEqPresets([...BUILT_IN_PRESETS, ...custom].filter(p => !hidden.includes(p.id)));
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

    const measureProgress = () => {
        progressRef.current?.measure((_x, _y, w, _h, pageX) => {
            if (w > 0) progressLayout.current = { pageX, width: w };
        });
    };

    const seekTo = (pageX) => {
        const ratio = Math.max(0, Math.min(1, (pageX - progressLayout.current.pageX) / progressLayout.current.width));
        if (progress.duration > 0) TrackPlayer.seekTo(ratio * progress.duration);
    };

    // Use ourTitle/ourArtist from PlaybackContext's currentTrack (from our queue, not RNTP metadata)
    const displayTitle = currentTrack?.ourTitle ?? currentTrack?.title ?? '—';
    const displayArtist = currentTrack?.ourArtist ?? currentTrack?.artist ?? '';
    const artwork = currentTrack?.artwork;
    const pct = progress.duration > 0 ? progress.position / progress.duration : 0;

    return (
        <View style={s.container} {...swipePan.panHandlers}>
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
                    {artwork
                        ? <Image source={{ uri: artwork }} style={s.artImg} resizeMode="cover" />
                        : <Text style={[s.artNote, { color: theme.accentDim }]}>♪</Text>
                    }
                </View>
            </View>

            {/* Info */}
            <View style={s.info}>
                <Text style={s.trackTitle} numberOfLines={2}>{displayTitle}</Text>
                <Text style={[s.trackArtist, { color: theme.accent }]} numberOfLines={1}>{displayArtist}</Text>
            </View>

            {/* Progress */}
            <View style={s.progressSection}>
                <View
                    ref={progressRef}
                    style={s.progressTouch}
                    onLayout={measureProgress}
                    onStartShouldSetResponder={() => true}
                    onResponderGrant={e => seekTo(e.nativeEvent.pageX)}
                    onResponderMove={e => seekTo(e.nativeEvent.pageX)}
                >
                    <View style={s.progressTrack}>
                        <View style={[s.progressFill, { width: `${pct * 100}%`, backgroundColor: theme.accent }]} />
                    </View>
                    <View style={[s.progressThumb, {
                        left: `${pct * 100}%`,
                        marginLeft: -10,
                        backgroundColor: theme.accent,
                    }]} />
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
                    <Text style={[s.skipIcon, { color: '#ccc' }]}>⏮</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={() => isPlaying ? pauseWithRamp() : playWithRamp()}
                    style={[s.playBtn, { backgroundColor: theme.accent, shadowColor: theme.accent }]}
                >
                    <Text style={[s.playIcon, { color: theme.onAccent }]}>{isPlaying ? '⏸' : '▶'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => skipWithCrossfade('next')} style={s.skipBtn} hitSlop={HIT}>
                    <Text style={[s.skipIcon, { color: '#ccc' }]}>⏭</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={toggleSingleLoop} style={s.sideBtn} hitSlop={HIT}>
                    <Text style={[s.sideIcon, { color: singleLoop ? theme.accent : '#333' }]}>↺¹</Text>
                </TouchableOpacity>
            </View>

            {/* EQ Modal */}
            <Modal visible={showEQ} transparent animationType="slide" onRequestClose={() => setShowEQ(false)}>
                <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setShowEQ(false)} />
                <View style={s.sheet}>
                    <View style={s.handle} />
                    <Text style={s.sheetTitle}>EQ Preset</Text>
                    {eqPresets.length === 0
                        ? <Text style={s.empty}>No presets visible — manage in Settings</Text>
                        : eqPresets.map(p => (
                            <TouchableOpacity key={p.id} style={s.presetRow}
                                onPress={() => { changeEQPreset(p.id, currentPlaylist?.path); setShowEQ(false); }}
                            >
                                <Text style={[s.presetName, eqPresetId === p.id && { color: '#f0f0f0', fontWeight: '700' }]}>{p.name}</Text>
                                {eqPresetId === p.id && <Text style={{ color: theme.accent, fontSize: 20 }}>✓</Text>}
                            </TouchableOpacity>
                        ))
                    }
                </View>
            </Modal>

            {/* Queue Modal */}
            <Modal visible={showQueue} transparent animationType="slide" onRequestClose={() => setShowQueue(false)}>
                <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setShowQueue(false)} />
                <View style={s.sheet}>
                    <View style={s.handle} />
                    <Text style={s.sheetTitle}>Up Next</Text>
                    {queue.length === 0
                        ? <Text style={s.empty}>Nothing up next</Text>
                        : <FlatList data={queue} keyExtractor={(item, i) => item.id + i} style={{ maxHeight: 360 }}
                            renderItem={({ item, index }) => (
                                <View style={s.qRow}>
                                    <Text style={s.qNum}>{index + 1}</Text>
                                    <View style={{ flex: 1 }}>
                                        <Text style={s.qTitle} numberOfLines={1}>{item.ourTitle ?? item.title}</Text>
                                        <Text style={s.qArtist} numberOfLines={1}>{item.ourArtist ?? item.artist}</Text>
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

const HIT = { top: 20, bottom: 20, left: 20, right: 20 };

const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0a0a0a', paddingTop: 56 },
    topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, marginBottom: 12 },
    topBtn: { width: 56, height: 56, justifyContent: 'center', alignItems: 'center' },
    topIcon: { fontSize: 28 },
    topTag: { fontSize: 16, fontWeight: '700' },
    topLabel: { color: '#444', fontSize: 13, flex: 1, textAlign: 'center' },
    artWrap: { alignItems: 'center', marginBottom: 18 },
    art: { width: width - 48, height: width - 48, borderRadius: 20, backgroundColor: '#0f0f0f', borderWidth: 1, justifyContent: 'center', alignItems: 'center', overflow: 'hidden', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 20 },
    artImg: { width: '100%', height: '100%' },
    artNote: { fontSize: 80 },
    info: { paddingHorizontal: 28, marginBottom: 14 },
    trackTitle: { color: '#f0f0f0', fontSize: 22, fontWeight: '700', marginBottom: 4, letterSpacing: -0.3 },
    trackArtist: { fontSize: 15, fontWeight: '500' },
    progressSection: { paddingHorizontal: 28, marginBottom: 24 },
    progressTouch: { height: 44, justifyContent: 'center' },
    progressTrack: { height: 4, backgroundColor: '#1a1a1a', borderRadius: 2 },
    progressFill: { height: 4, borderRadius: 2 },
    progressThumb: { position: 'absolute', width: 20, height: 20, borderRadius: 10, top: 12 },
    times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
    time: { color: '#3a3a3a', fontSize: 12 },
    controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12 },
    sideBtn: { width: 60, height: 60, alignItems: 'center', justifyContent: 'center' },
    sideIcon: { fontSize: 28 },
    skipBtn: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center' },
    skipIcon: { fontSize: 34 },
    playBtn: { width: 84, height: 84, borderRadius: 42, justifyContent: 'center', alignItems: 'center', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.45, shadowRadius: 16 },
    playIcon: { fontSize: 32 },
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)' },
    sheet: { backgroundColor: '#0f0f0f', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 24, paddingTop: 12, paddingBottom: 52 },
    handle: { width: 36, height: 4, backgroundColor: '#222', borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
    sheetTitle: { color: '#555', fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 16 },
    presetRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
    presetName: { color: '#555', fontSize: 17 },
    empty: { color: '#333', fontSize: 14, textAlign: 'center', paddingVertical: 24 },
    qRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
    qNum: { color: '#2a2a2a', fontSize: 13, width: 28 },
    qTitle: { color: '#d0d0d0', fontSize: 14, fontWeight: '500' },
    qArtist: { color: '#444', fontSize: 12, marginTop: 2 },
});