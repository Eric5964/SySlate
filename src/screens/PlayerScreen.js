import React, { useEffect, useState, useRef } from 'react';
import {
    View, Text, TouchableOpacity, StyleSheet,
    Dimensions, Animated, PanResponder, Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TrackPlayer, { useProgress, usePlaybackState, State, Event } from 'react-native-track-player';
import { useNavigation, useRoute } from '@react-navigation/native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { skipWithCrossfade, playWithRamp, pauseWithRamp } from '../services/PlaybackService';
import { PlayIcon, PauseIcon, SkipNextIcon, SkipPrevIcon, ShuffleIcon, MenuBarsIcon } from '../components/Icons';
import EQModal from '../components/EQModal';
import QueueModal from '../components/QueueModal';

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
    const insets = useSafeAreaInsets();

    const {
        currentPlaylist, currentTrack, eqPresetId, shuffleOn, singleLoop,
        loadPlaylist, toggleShuffle, toggleSingleLoop, saveSession,
    } = usePlayback();

    const progress = useProgress(150);
    const playbackState = usePlaybackState();
    const isPlaying = playbackState.state === State.Playing;

    const [showEQ, setShowEQ] = useState(false);
    const [showQueue, setShowQueue] = useState(false);

    // Progress bar — tracks the finger in real time instead of only reflecting
    // the throttled native progress value, and only calls seekTo a few times
    // a second (not every pixel) so dragging doesn't stutter the audio.
    const progressRef = useRef(null);
    const progressLayout = useRef({ pageX: 28, width: width - 56 });
    const [dragRatio, setDragRatio] = useState(null);
    const lastSeekAt = useRef(0);
    const clearDragTimer = useRef(null);

    const measureProgress = () => {
        progressRef.current?.measure((_x, _y, w, _h, pageX) => {
            if (w > 0) progressLayout.current = { pageX, width: w };
        });
    };

    const touchToRatio = (pageX) => Math.max(0, Math.min(1,
        (pageX - progressLayout.current.pageX) / progressLayout.current.width
    ));

    const onScrub = (pageX, commit) => {
        const ratio = touchToRatio(pageX);
        setDragRatio(ratio);
        const now = Date.now();
        if (progress.duration > 0 && (commit || now - lastSeekAt.current > 110)) {
            lastSeekAt.current = now;
            TrackPlayer.seekTo(ratio * progress.duration);
        }
        if (commit) {
            clearTimeout(clearDragTimer.current);
            clearDragTimer.current = setTimeout(() => setDragRatio(null), 250);
        }
    };

    // Swipe down to close — the sheet now visually follows the finger instead
    // of only reacting on release.
    const translateY = useRef(new Animated.Value(0)).current;
    const swipePan = useRef(PanResponder.create({
        onMoveShouldSetPanResponder: (_, gs) => gs.dy > 6 && Math.abs(gs.dy) > Math.abs(gs.dx) * 1.5,
        onPanResponderMove: (_, gs) => { if (gs.dy > 0) translateY.setValue(gs.dy); },
        onPanResponderRelease: (_, gs) => {
            if (gs.dy > 90 || gs.vy > 1.2) {
                Animated.timing(translateY, { toValue: height, duration: 200, useNativeDriver: true })
                    .start(() => navigation.goBack());
            } else {
                Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 8, tension: 60 }).start();
            }
        },
        onPanResponderTerminate: () => {
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 8, tension: 60 }).start();
        },
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

    const displayTitle = currentTrack?.ourTitle ?? currentTrack?.title ?? '—';
    const displayArtist = currentTrack?.ourArtist ?? currentTrack?.artist ?? '';
    const artwork = currentTrack?.artwork;
    const pct = dragRatio !== null ? dragRatio : (progress.duration > 0 ? progress.position / progress.duration : 0);
    const skipIconColor = theme.accent === '#f2f2f2' ? '#333' : '#ccc';

    return (
        <Animated.View style={[s.container, { paddingTop: insets.top + 6, transform: [{ translateY }] }]} {...swipePan.panHandlers}>
            <View style={s.dragHandle} />

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
                    <TouchableOpacity onPress={() => setShowQueue(true)} hitSlop={HIT} style={s.topBtn}>
                        <MenuBarsIcon size={22} color={theme.accent} />
                    </TouchableOpacity>
                </View>
            </View>

            {/* Middle content, vertically centered so leftover space is shared evenly */}
            <View style={s.middle}>
                <View style={s.artWrap}>
                    <View style={[s.art, { borderColor: theme.accentDim, shadowColor: theme.accent }]}>
                        {artwork
                            ? <Image source={{ uri: artwork }} style={s.artImg} resizeMode="cover" />
                            : <Text style={[s.artNote, { color: theme.accentDim }]}>♪</Text>
                        }
                    </View>
                </View>

                <View style={s.info}>
                    <Text style={s.trackTitle} numberOfLines={2}>{displayTitle}</Text>
                    <Text style={[s.trackArtist, { color: theme.accent }]} numberOfLines={1}>{displayArtist}</Text>
                </View>

                <View style={s.progressSection}>
                    <View
                        ref={progressRef}
                        style={s.progressTouch}
                        onLayout={measureProgress}
                        onStartShouldSetResponder={() => true}
                        onResponderGrant={e => { measureProgress(); onScrub(e.nativeEvent.pageX, false); }}
                        onResponderMove={e => onScrub(e.nativeEvent.pageX, false)}
                        onResponderRelease={e => onScrub(e.nativeEvent.pageX, true)}
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
                        <Text style={s.time}>{fmt(dragRatio !== null ? dragRatio * progress.duration : progress.position)}</Text>
                        <Text style={s.time}>{fmt(progress.duration)}</Text>
                    </View>
                </View>
            </View>

            {/* Controls */}
            <View style={[s.controls, { paddingBottom: insets.bottom + 10 }]}>
                <TouchableOpacity onPress={toggleShuffle} style={s.sideBtn} hitSlop={HIT}>
                    <ShuffleIcon size={22} color={shuffleOn ? theme.accent : '#333'} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => skipWithCrossfade('prev')} style={s.skipBtn} hitSlop={HIT}>
                    <SkipPrevIcon size={28} color={skipIconColor} />
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={() => isPlaying ? pauseWithRamp() : playWithRamp()}
                    style={[s.playBtn, { backgroundColor: theme.accent, shadowColor: theme.accent }]}
                >
                    {isPlaying ? <PauseIcon size={26} color={theme.onAccent} /> : <PlayIcon size={26} color={theme.onAccent} />}
                </TouchableOpacity>
                <TouchableOpacity onPress={() => skipWithCrossfade('next')} style={s.skipBtn} hitSlop={HIT}>
                    <SkipNextIcon size={28} color={skipIconColor} />
                </TouchableOpacity>
                <TouchableOpacity onPress={toggleSingleLoop} style={s.sideBtn} hitSlop={HIT}>
                    <Text style={[s.sideIcon, { color: singleLoop ? theme.accent : '#333' }]}>↺¹</Text>
                </TouchableOpacity>
            </View>

            <EQModal visible={showEQ} onClose={() => setShowEQ(false)} playlistPath={currentPlaylist?.path} />
            <QueueModal visible={showQueue} onClose={() => setShowQueue(false)} />
        </Animated.View>
    );
}

const HIT = { top: 20, bottom: 20, left: 20, right: 20 };

const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0a0a0a' },
    dragHandle: { width: 36, height: 4, backgroundColor: '#222', borderRadius: 2, alignSelf: 'center', marginBottom: 8 },
    topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, marginBottom: 4 },
    topBtn: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
    topIcon: { fontSize: 26 },
    topTag: { fontSize: 16, fontWeight: '700' },
    topLabel: { color: '#444', fontSize: 13, flex: 1, textAlign: 'center' },
    middle: { flex: 1, justifyContent: 'center' },
    artWrap: { alignItems: 'center', marginBottom: 18 },
    art: { width: width - 64, height: width - 64, borderRadius: 20, backgroundColor: '#0f0f0f', borderWidth: 1, justifyContent: 'center', alignItems: 'center', overflow: 'hidden', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 20 },
    artImg: { width: '100%', height: '100%' },
    artNote: { fontSize: 80 },
    info: { paddingHorizontal: 28, marginBottom: 14 },
    trackTitle: { color: '#f0f0f0', fontSize: 22, fontWeight: '700', marginBottom: 4, letterSpacing: -0.3 },
    trackArtist: { fontSize: 15, fontWeight: '500' },
    progressSection: { paddingHorizontal: 28 },
    progressTouch: { height: 44, justifyContent: 'center' },
    progressTrack: { height: 4, backgroundColor: '#1a1a1a', borderRadius: 2 },
    progressFill: { height: 4, borderRadius: 2 },
    progressThumb: { position: 'absolute', width: 20, height: 20, borderRadius: 10, top: 12 },
    times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
    time: { color: '#3a3a3a', fontSize: 12 },
    controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12 },
    sideBtn: { width: 60, height: 60, alignItems: 'center', justifyContent: 'center' },
    sideIcon: { fontSize: 26 },
    skipBtn: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center' },
    playBtn: { width: 84, height: 84, borderRadius: 42, justifyContent: 'center', alignItems: 'center', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.45, shadowRadius: 16 },
});