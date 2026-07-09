import React, { useEffect, useState } from 'react';
import {
    View, Text, TouchableOpacity, StyleSheet,
    Dimensions, Modal, FlatList, Image,
} from 'react-native';
import TrackPlayer, { useProgress, usePlaybackState, State, Event } from 'react-native-track-player';
import { useNavigation, useRoute } from '@react-navigation/native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { BUILT_IN_PRESETS } from '../utils/eq';
import { skipWithCrossfade, playWithRamp } from '../services/PlaybackService';
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
        currentPlaylist, eqPresetId, shuffleOn, singleLoop,
        loadPlaylist, changeEQPreset, toggleShuffle, toggleSingleLoop, saveSession,
    } = usePlayback();

    const progress = useProgress(250);
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
        if (!showEQ) return;
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

    const pct = progress.duration > 0 ? (progress.position / progress.duration) : 0;

    const seekTo = (locationX) => {
        const ratio = Math.max(0, Math.min(1, locationX / (width - 56)));
        if (progress.duration > 0) TrackPlayer.seekTo(ratio * progress.duration);
    };

    return (
        <View style={s.container}>
            {/* Top bar */}
            <View style={s.topBar}>
                <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={HIT} style={s.topBtn}>
                    <Text style={[s.topIcon, { color: theme.accent }]}>↓</Text>
                </TouchableOpacity>
                <Text style={s.topLabel} numberOfLines={1}>
                    {currentPlaylist?.name ?? 'Now Playing'}
                </Text>
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
                <Text style={[s.trackArtist, { color: theme.accent }]} numberOfLines={1}>
                    {track?.artist ?? ''}
                </Text>
            </View>

            {/* Progress */}
            <View style={s.progressSection}>
                <View
                    style={s.progressTouch}
                    onStartShouldSetResponder={() => true}
                    onResponderGrant={e => seekTo(e.nativeEvent.locationX)}
                    onResponderMove={e => seekTo(e.nativeEvent.locationX)}
                >
                    <View style={s.progressTrack}>
                        <View style={[s.progressFill, { width: `${pct * 100}%`, backgroundColor: theme.accent }]} />
                    </View>
                    <View style={[s.progressThumb, {
                        left: `${pct * 100}%`,
                        marginLeft: -8,
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
                {/* Shuffle */}
                <TouchableOpacity onPress={toggleShuffle} style={s.sideBtn} hitSlop={HIT}>
                    <Text style={[s.sideIcon, { color: shuffleOn ? theme.accent : '#333' }]}>⇌</Text>
                </TouchableOpacity>

                {/* Previous */}
                <TouchableOpacity onPress={() => skipWithCrossfade('prev')} style={s.skipBtn} hitSlop={HIT}>
                    <Text style={s.skipIcon}>|◁</Text>
                </TouchableOpacity>

                {/* Play/Pause */}
                <TouchableOpacity
                    onPress={() => isPlaying ? TrackPlayer.pause() : playWithRamp()}
                    style={[s.playBtn, { backgroundColor: theme.accent, shadowColor: theme.accent }]}
                >
                    <Text style={s.playIcon}>{isPlaying ? '❙❙' : '▶'}</Text>
                </TouchableOpacity>

                {/* Next */}
                <TouchableOpacity onPress={() => skipWithCrossfade('next')} style={s.skipBtn} hitSlop={HIT}>
                    <Text style={s.skipIcon}>▷|</Text>
                </TouchableOpacity>

                {/* Single loop */}
                <TouchableOpacity onPress={toggleSingleLoop} style={s.sideBtn} hitSlop={HIT}>
                    <Text style={[s.sideIcon, { color: singleLoop ? theme.accent : '#333' }]}>↺¹</Text>
                </TouchableOpacity>
            </View>

            {/* EQ Modal */}
            <Modal visible={showEQ} transparent animationType="slide" onRequestClose={() => setShowEQ(false)}>
                <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setShowEQ(false)} />
                <View style={s.sheet}>
                    <View style={s.sheetHandle} />
                    <Text style={s.sheetTitle}>EQ Preset</Text>
                    {eqPresets.length === 0
                        ? <Text style={s.queueEmpty}>No presets visible — manage in Settings</Text>
                        : eqPresets.map(p => (
                            <TouchableOpacity
                                key={p.id} style={s.presetRow}
                                onPress={() => { changeEQPreset(p.id, currentPlaylist?.path); setShowEQ(false); }}
                            >
                                <Text style={[s.presetName, eqPresetId === p.id && { color: '#f0f0f0', fontWeight: '600' }]}>
                                    {p.name}
                                </Text>
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
                    <View style={s.sheetHandle} />
                    <Text style={s.sheetTitle}>Up Next</Text>
                    {queue.length === 0
                        ? <Text style={s.queueEmpty}>Nothing up next</Text>
                        : <FlatList
                            data={queue}
                            keyExtractor={(item, i) => item.id + i}
                            style={{ maxHeight: 360 }}
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

const HIT = { top: 18, bottom: 18, left: 18, right: 18 };

const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0a0a0a', paddingTop: 56 },
    topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, marginBottom: 16 },
    topBtn: { width: 52, height: 52, justifyContent: 'center', alignItems: 'center' },
    topIcon: { fontSize: 26 },
    topTag: { fontSize: 16, fontWeight: '700' },
    topLabel: { color: '#444', fontSize: 13, flex: 1, textAlign: 'center' },
    artWrap: { alignItems: 'center', marginBottom: 20 },
    art: { width: width - 56, height: width - 56, borderRadius: 20, backgroundColor: '#0f0f0f', borderWidth: 1, justifyContent: 'center', alignItems: 'center', overflow: 'hidden', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.25, shadowRadius: 20 },
    artImage: { width: '100%', height: '100%' },
    artNote: { fontSize: 80 },
    info: { paddingHorizontal: 28, marginBottom: 16 },
    trackTitle: { color: '#f0f0f0', fontSize: 22, fontWeight: '700', marginBottom: 4, letterSpacing: -0.3 },
    trackArtist: { fontSize: 15, fontWeight: '500' },
    progressSection: { paddingHorizontal: 28, marginBottom: 28 },
    progressTouch: { height: 36, justifyContent: 'center' },
    progressTrack: { height: 4, backgroundColor: '#1a1a1a', borderRadius: 2 },
    progressFill: { height: 4, borderRadius: 2 },
    progressThumb: { position: 'absolute', width: 16, height: 16, borderRadius: 8, top: 10 },
    times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
    time: { color: '#3a3a3a', fontSize: 12 },
    controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
    sideBtn: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
    sideIcon: { fontSize: 26 },
    skipBtn: { width: 60, height: 60, alignItems: 'center', justifyContent: 'center' },
    skipIcon: { color: '#ccc', fontSize: 30 },
    playBtn: { width: 80, height: 80, borderRadius: 40, justifyContent: 'center', alignItems: 'center', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 14 },
    playIcon: { color: '#fff', fontSize: 30 },
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)' },
    sheet: { backgroundColor: '#0f0f0f', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 24, paddingTop: 12, paddingBottom: 52 },
    sheetHandle: { width: 36, height: 4, backgroundColor: '#222', borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
    sheetTitle: { color: '#555', fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 16 },
    presetRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
    presetName: { color: '#555', fontSize: 17 },
    queueEmpty: { color: '#333', fontSize: 14, textAlign: 'center', paddingVertical: 24 },
    qRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
    qNum: { color: '#2a2a2a', fontSize: 13, width: 28 },
    qTitle: { color: '#d0d0d0', fontSize: 14, fontWeight: '500' },
    qArtist: { color: '#444', fontSize: 12, marginTop: 2 },
});