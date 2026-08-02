import React, { useEffect, useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Dimensions, Image, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TrackPlayer, { useProgress, usePlaybackState, State } from 'react-native-track-player';
import { useNavigation, useRoute } from '@react-navigation/native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { skipWithCrossfade, playWithRamp, pauseWithRamp } from '../services/PlaybackService';
import { PlayIcon, PauseIcon, SkipNextIcon, SkipPrevIcon, ShuffleIcon, MenuBarsIcon } from '../components/Icons';
import { PanGestureHandler, State as GHState } from 'react-native-gesture-handler';
import EQModal from '../components/EQModal';
import QueueModal from '../components/QueueModal';
import GradientCap from '../components/GradientCap';
import { squircle } from '../utils/squircle';
import { getPlaylistCovers, getPlayCounts, getShowPlayCount } from '../utils/storage';

const { width, height } = Dimensions.get('window');

function fmt(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

// Note: the swipe-down-to-close gesture is now handled entirely by
// React Navigation's built-in modal transition (see App.js — gestureEnabled +
// TransitionPresets.ModalSlideFromBottomIOS) instead of a hand-rolled
// PanResponder here. That hand-rolled version was fighting with the
// navigator's own transition (causing the blank-flash-then-double-swipe bug)
// and, being JS-thread-only, never felt as smooth as the library's own
// gesture-handler-backed implementation.
export default function PlayerScreen() {
    const navigation = useNavigation();
    const route = useRoute();
    const { playlist } = route.params ?? {};
    const { theme, base } = useTheme();
    const insets = useSafeAreaInsets();

    const {
        currentPlaylist, currentTrack, eqPresetId, shuffleOn, singleLoop,
        loadPlaylist, toggleShuffle, toggleSingleLoop,
    } = usePlayback();

    const progress = useProgress(500);
    const [justSwitched, setJustSwitched] = useState(false);
    useEffect(() => {
        setJustSwitched(true);
        const t = setTimeout(() => setJustSwitched(false), 400);
        return () => clearTimeout(t);
    }, [currentTrack?.id]);
    const playbackState = usePlaybackState();
    const isPlaying = playbackState.state === State.Playing;

    const [showEQ, setShowEQ] = useState(false);
    const [showQueue, setShowQueue] = useState(false);
    const [fallbackArt, setFallbackArt] = useState(null);
    const [playCount, setPlayCount] = useState(0);
    const [showPlayCount, setShowPlayCountState] = useState(true);

    useEffect(() => { getShowPlayCount().then(setShowPlayCountState); }, []);

    useEffect(() => {
        if (!currentTrack?.id) { setPlayCount(0); return; }
        getPlayCounts([currentTrack.id]).then(counts => setPlayCount(counts[currentTrack.id] ?? 0));
    }, [currentTrack?.id]);

    useEffect(() => {
        if (!currentPlaylist?.path) { setFallbackArt(null); return; }
        let cancelled = false;
        getPlaylistCovers().then(covers => {
            if (!cancelled) setFallbackArt(covers[currentPlaylist.path] ?? null);
        });
        return () => { cancelled = true; };
    }, [currentPlaylist?.path]);

    const progressRef = useRef(null);
    const progressLayout = useRef({ pageX: 28, width: width - 56 });
    const [dragRatio, setDragRatio] = useState(null);
    const lastSeekAt = useRef(0);
    const clearDragTimer = useRef(null);

    // One continuous animation running at the song's actual real-time rate,
    // instead of a new mini-animation restarted on every progress hook tick.
    // Restarting on every tick was the real source of both the choppiness
    // and the post-release jump: a fixed-duration animation racing a
    // variable real-time gap between ticks necessarily drifts, and canceling
    // an in-flight animation to start another one is visually a stutter.
    const animPct = useRef(new Animated.Value(
        progress.duration > 0 ? progress.position / progress.duration : 0
    )).current;
    const animRunRef = useRef(null);
    const animPctValueRef = useRef(progress.duration > 0 ? progress.position / progress.duration : 0); // tracks the animation's own last-set value, since Animated.Value has no public getter
    useEffect(() => {
        const id = animPct.addListener(({ value }) => { animPctValueRef.current = value; });
        return () => animPct.removeListener(id);
    }, []);

    const stopAnim = () => { animRunRef.current?.stop(); animRunRef.current = null; };

    const startRealTimeAnim = (fromPct) => {
        stopAnim();
        animPct.setValue(fromPct);
        animPctValueRef.current = fromPct;
        if (!isPlaying || progress.duration <= 0 || fromPct >= 1) return;
        const remainingMs = Math.max(0, (1 - fromPct) * progress.duration * 1000);
        const anim = Animated.timing(animPct, { toValue: 1, duration: remainingMs, easing: Easing.linear, useNativeDriver: false });
        animRunRef.current = anim;
        anim.start();
    };

    const measureProgress = () => {
        progressRef.current?.measure((_x, _y, w, _h, pageX) => {
            if (w > 0) progressLayout.current = { pageX, width: w };
        });
    };

    const touchToRatio = (pageX) => Math.max(0, Math.min(1,
        (pageX - progressLayout.current.pageX) / progressLayout.current.width
    ));

    const onScrub = (absoluteX, commit) => {
        const ratio = touchToRatio(absoluteX);
        setDragRatio(ratio);
        stopAnim();
        animPct.setValue(ratio);
        animPctValueRef.current = ratio;
        const now = Date.now();
        if (progress.duration > 0 && (commit || now - lastSeekAt.current > 110)) {
            lastSeekAt.current = now;
            TrackPlayer.seekTo(ratio * progress.duration);
        }
        if (commit) {
            // Hand off directly to the real-time animation from this exact
            // ratio right now — waiting for the drag-clear timer and the
            // next progress hook tick (which can be stale for up to another
            // update cycle) was the cause of the visible jump right after
            // letting go.
            startRealTimeAnim(ratio);
            clearTimeout(clearDragTimer.current);
            clearDragTimer.current = setTimeout(() => setDragRatio(null), 300);
        }
    };

    // The whole screen now has its own active vertical swipe-to-close gesture
    // (via React Navigation), which was winning gesture arbitration against
    // the progress bar's old plain-Responder touch handling for any drag with
    // even a slight vertical component — "only tap works now, not swipe."
    // Rebuilt on gesture-handler with activeOffsetX so a horizontal drag on
    // the bar correctly claims priority over the screen's vertical gesture.
    const onScrubRef = useRef(onScrub);
    useEffect(() => { onScrubRef.current = onScrub; });

    // These MUST stay referentially stable across renders (recreating them
    // mid-gesture is what caused the earlier RNGH crash), so they delegate
    // through onScrubRef instead of closing over onScrub directly — closing
    // directly would freeze `progress` at whatever it was on the very first
    // render (duration likely still 0), which is why dragging updated the
    // visual position but never actually called seekTo.
    const onProgressGestureEvent = useRef((e) => {
        onScrubRef.current(e.nativeEvent.absoluteX, false);
    }).current;

    const onProgressStateChange = useRef((e) => {
        const { state, absoluteX } = e.nativeEvent;
        if (state === GHState.BEGAN) {
            measureProgress();
            onScrubRef.current(absoluteX, false);
        }
        if (state === GHState.END || state === GHState.CANCELLED || state === GHState.FAILED) {
            onScrubRef.current(absoluteX, true);
        }
    }).current;

    useEffect(() => {
        if (playlist && (!currentPlaylist || currentPlaylist.path !== playlist.path)) {
            loadPlaylist(playlist);
        }
    }, []);

    const displayTitle = currentTrack?.ourTitle ?? currentTrack?.title ?? '—';
    const displayArtist = currentTrack?.ourArtist ?? currentTrack?.artist ?? '';
    // No per-song embedded-artwork (ID3/FLAC picture tag) extraction exists
    // anywhere in this codebase yet — currentTrack.artwork is never actually
    // populated, so "song covers" were always silently falling back to the
    // note glyph. This falls back to the PLAYLIST's cover image instead,
    // which is real data we already have. True per-file embedded artwork
    // would need a native module or a metadata-parsing library — a separate,
    // bigger feature if you want it.
    const artwork = currentTrack?.artwork ?? fallbackArt;
    const pct = justSwitched ? 0 : (progress.duration > 0 ? progress.position / progress.duration : 0);

    // Re-sync only when needed: on mount, on play/pause toggling, on a track
    // switch, or if the running animation has drifted noticeably from what
    // the real progress hook reports (e.g. after a system hiccup). Anything
    // else, the animation just keeps running uninterrupted at real-time speed
    // — no restart, no stutter.
    useEffect(() => {
        if (dragRatio !== null) return; // scrubbing owns the value right now
        const drift = Math.abs(animPctValueRef.current - pct);
        if (!animRunRef.current || drift > 0.02) {
            startRealTimeAnim(pct);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [Math.round(pct * 200), isPlaying, currentTrack?.id]);

    useEffect(() => {
        return () => stopAnim();
    }, []);

    const animWidth = animPct.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
    const animLeft = animPct.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
    const skipIconColor = '#ccc'; // fixed regardless of accent, including white

    return (
        <View style={[s.container, { paddingTop: insets.top + 6, backgroundColor: base.bg }]}>
            <GradientCap color={theme.accent} height={68} style={{ borderBottomLeftRadius: 16, borderBottomRightRadius: 16, opacity: 0.5 }} />

            <View style={s.topBar}>
                <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={HIT} style={s.topBtn}>
                    <Text style={[s.topIcon, { color: theme.accent }]}>↓</Text>
                </TouchableOpacity>
                <Text style={s.topLabel} numberOfLines={1}>{currentPlaylist?.name ?? 'Now Playing'}</Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                    <TouchableOpacity onPress={() => setShowEQ(true)} hitSlop={HIT} style={s.topBtn}>
                        <Text style={[s.topTag, { color: theme.accent }]}>EQ</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setShowQueue(true)} hitSlop={HIT} style={s.topBtn}>
                        <MenuBarsIcon size={20} color={theme.accent} />
                    </TouchableOpacity>
                </View>
            </View>

            {/* Art, then info+progress kept close together, then controls —
                evenly spaced across whatever room is left so nothing bunches
                up on a taller screen, instead of one big empty gap. */}
            <View style={s.middle}>
                <View style={s.artWrap}>
                    <View style={[s.art, { borderColor: theme.accentDim, shadowColor: theme.accent, borderRadius: squircle(width - 80) }]}>
                        {artwork
                            ? <Image source={{ uri: artwork }} style={s.artImg} resizeMode="cover" />
                            : <Text style={[s.artNote, { color: theme.accentDim }]}>♪</Text>
                        }
                    </View>
                </View>

                <View style={s.trackInfoGroup}>
                    <View style={s.info}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.trackTitle} numberOfLines={2}>{displayTitle}</Text>
                            <Text style={[s.trackArtist, { color: theme.accent }]} numberOfLines={1}>{displayArtist}</Text>
                        </View>
                        {showPlayCount && playCount > 0 && (
                            <Text style={s.playCount}>{playCount}×</Text>
                        )}
                    </View>

                    <View style={s.progressSection}>
                        <PanGestureHandler
                            onGestureEvent={onProgressGestureEvent}
                            onHandlerStateChange={onProgressStateChange}
                            activeOffsetX={[-6, 6]}
                            failOffsetY={[-14, 14]}
                        >
                            <View
                                ref={progressRef}
                                style={s.progressTouch}
                                onLayout={measureProgress}
                            >
                                <View style={s.progressTrack}>
                                    <Animated.View style={[s.progressFill, { width: animWidth, backgroundColor: theme.accent }]} />
                                </View>
                                <Animated.View style={[s.progressThumb, { left: animLeft, marginLeft: -10, backgroundColor: theme.accent }]} />
                            </View>
                        </PanGestureHandler>
                        <View style={s.times}>
                            <Text style={s.time}>{fmt(dragRatio !== null ? dragRatio * progress.duration : (justSwitched ? 0 : progress.position))}</Text>
                            <Text style={s.time}>{fmt(justSwitched ? 0 : progress.duration)}</Text>
                        </View>
                    </View>
                </View>

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
            </View>

            <EQModal visible={showEQ} onClose={() => setShowEQ(false)} playlistPath={currentPlaylist?.path} />
            <QueueModal visible={showQueue} onClose={() => setShowQueue(false)} />
        </View>
    );
}

const HIT = { top: 20, bottom: 20, left: 20, right: 20 };

const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0a0a0a' },
    topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, marginBottom: 4 },
    topBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
    topIcon: { fontSize: 26 },
    topTag: { fontSize: 16, fontWeight: '700' },
    topLabel: { color: '#444', fontSize: 13, flex: 1, textAlign: 'center' },
    middle: { flex: 1, justifyContent: 'space-evenly' },
    artWrap: { alignItems: 'center' },
    art: { width: width - 80, height: width - 80, backgroundColor: '#0f0f0f', borderWidth: 1, justifyContent: 'center', alignItems: 'center', overflow: 'hidden', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8 },
    artImg: { width: '100%', height: '100%' },
    artNote: { fontSize: 80 },
    trackInfoGroup: {},
    info: { paddingHorizontal: 28, marginBottom: 10, flexDirection: 'row', alignItems: 'flex-start' },
    playCount: { color: '#444', fontSize: 13, fontWeight: '600', marginLeft: 10, marginTop: 2 },
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
    playBtn: { width: 84, height: 84, borderRadius: 42, justifyContent: 'center', alignItems: 'center', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 8 },
});
