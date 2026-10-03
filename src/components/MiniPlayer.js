import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { listArtUri } from '../utils/embeddedArt';
import AudioEngine, { usePlaybackState, State, useProgress } from '../native/AudioEngine';
import { useNavigation } from '@react-navigation/native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { usePreferences } from '../context/PreferencesContext';
import { skipWithRamp, playWithRamp, pauseWithRamp } from '../services/PlaybackService';
import { PlayIcon, PauseIcon, SkipNextIcon, SkipPrevIcon } from './Icons';
import GradientCap from './GradientCap';
import { squircle } from '../utils/squircle';
import { formatArtists } from '../utils/artists';

const TAB_BAR_HEIGHT = 49;
const ART_SIZE = 44;
const SKIP_ICON_COLOR = '#bbb'; // fixed regardless of accent, including white

export default function MiniPlayer({ withTabBar = true }) {
    const navigation = useNavigation();
    const { currentTrack, playbackRate } = usePlayback();
    const { theme, base } = useTheme();
    const { coverShape, showSongCovers, artistSeparator, artistDisplayJoin } = usePreferences();
    const playbackState = usePlaybackState();
    const isPlaying = playbackState.state === State.Playing;
    const progress = useProgress(500);
    const insets = useSafeAreaInsets();

    // Replaces the old Animated.timing-based smoothing, which only
    // restarted its animation when the freshly-polled pct had "drifted"
    // more than 2% from wherever the animation currently was — meant to
    // avoid visibly resetting/re-easing on every 500ms poll. The bug: right
    // after a skip, the first render(s) still carry the PREVIOUS track's
    // stale position/duration pair (useProgress hasn't repolled yet, but
    // currentTrack.id already changed) — and that stale pct is usually
    // close to wherever the old animation already was, so drift stays
    // under the threshold and nothing restarts. The animation just kept
    // gliding along the OLD track's timeline under the NEW track's title.
    // It would eventually self-correct once a real poll landed with a big
    // enough jump to cross the drift threshold — but repeated skips faster
    // than that (exactly what the reported "seems to be when I'm skipping"
    // looks like) meant it could stay wrong indefinitely, or its width
    // could land on/near 0% and read as "the bar just isn't there."
    //
    // This basis+elapsed-time approach can't get stuck the same way: every
    // currentTrack.id change unconditionally resets the basis to whatever
    // useProgress currently holds (stale or not, exactly like before), but
    // there's no drift comparison gating whether that reset actually takes
    // effect — it always does. A short ticker just extrapolates forward in
    // plain JS between real polls instead of running an Animated.timing
    // that has its own start/stop state to get out of sync.
    const basisRef = useRef({ position: progress.position, duration: progress.duration, at: Date.now() });
    const [, forceTick] = useState(0);
    const lastTrackIdRef = useRef(currentTrack?.id);

    useEffect(() => {
        const trackChanged = lastTrackIdRef.current !== currentTrack?.id;
        lastTrackIdRef.current = currentTrack?.id;
        if (trackChanged) {
            // Same fix as PlayerScreen's own progress bar for this — see
            // its trackChanged comment. Right after a track change,
            // `progress` can still be one poll behind (or, during a
            // crossfade specifically, native pairs the OUTGOING track's
            // position with the INCOMING track's duration for a moment —
            // see AudioEngine.swift's getProgress), so don't trust it yet.
            // Force 0 and let the very next real poll (this same effect,
            // trackChanged now false) bring in the correct pair.
            basisRef.current = { position: 0, duration: 0, at: Date.now() };
        } else {
            basisRef.current = { position: progress.position, duration: progress.duration, at: Date.now() };
        }
        forceTick(t => t + 1);
        // Depends on the whole `progress` object (a new one arrives on every
        // poll) and on isPlaying. Before, a poll that returned the SAME
        // position (always the case while paused) never re-stamped the
        // basis time, so on Play the bar computed "time since the last
        // change" (the whole pause) and leapt toward the end until the
        // next poll moved. Now the basis is re-stamped on every poll and
        // on every play/pause toggle.
    }, [progress, isPlaying, currentTrack?.id, playbackRate]);

    // On every play/pause change, read the true position right now instead
    // of trusting a poll that can be up to 500ms old (a pause from the lock
    // screen or Control Center otherwise left the bar a beat behind/ahead).
    useEffect(() => {
        let cancelled = false;
        const trackAtStart = lastTrackIdRef.current;
        AudioEngine.getProgress().then(p => {
            if (cancelled || lastTrackIdRef.current !== trackAtStart || !(p?.duration > 0)) return;
            basisRef.current = { position: p.position, duration: p.duration, at: Date.now() };
            forceTick(t => t + 1);
        }).catch(() => { });
        return () => { cancelled = true; };
    }, [isPlaying]);

    useEffect(() => {
        if (!isPlaying) return;
        const id = setInterval(() => forceTick(t => t + 1), 250);
        return () => clearInterval(id);
    }, [isPlaying]);

    const basis = basisRef.current;
    const elapsed = isPlaying ? ((Date.now() - basis.at) / 1000) * (playbackRate || 1) : 0;
    const livePct = basis.duration > 0 ? Math.min(1, Math.max(0, (basis.position + elapsed) / basis.duration)) : 0;

    if (!currentTrack) return null;

    const bottom = (withTabBar ? TAB_BAR_HEIGHT : 0) + insets.bottom + 6;
    const title = currentTrack.ourTitle ?? currentTrack.title ?? '';
    const artist = formatArtists(currentTrack.ourArtist ?? currentTrack.artist ?? '', artistSeparator, artistDisplayJoin);
    const artwork = listArtUri(currentTrack.artwork);

    return (
        <TouchableOpacity
            style={[styles.shell, { bottom, backgroundColor: base.surface }]}
            onPress={() => navigation.navigate('Player', {})}
            activeOpacity={0.9}
        >
          {/* Outer shell carries the shadow (a shadow can't coexist with
              overflow: hidden on the same view on iOS). This inner view owns
              the outline and clips everything inside it, the gradient,
              progress fill and content, to the exact same rounded shape, so
              nothing can stop short of or poke past the outline on either
              side. */}
          <View style={[styles.container, { borderColor: theme.accentDim, backgroundColor: base.surface }]}>
            <GradientCap color={theme.accent} height={68} style={{ opacity: 0.5 }} />
            <View pointerEvents="none" style={styles.miniProgressTrack}>
                <View style={[styles.miniProgressFill, { width: `${livePct * 100}%`, backgroundColor: theme.accent }]} />
            </View>
            {/* "Show Song Covers In Lists" previously only applied to All
                Songs/Playlist rows and the Queue sheet — the mini player
                always showed art regardless, unlike everywhere else covers
                appear. */}
            {showSongCovers && (
                <View style={[styles.art, { backgroundColor: base.surface, borderColor: theme.accentDim, overflow: 'hidden', borderRadius: squircle(ART_SIZE, coverShape) }]}>
                    {artwork
                        ? <Image source={{ uri: artwork }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                        : <Text style={{ fontSize: 18, color: theme.accentDim }}>♪</Text>
                    }
                </View>
            )}
            <View style={styles.info}>
                <Text style={[styles.title, { color: base.text }]} numberOfLines={1}>{title}</Text>
                <Text style={[styles.artist, { color: base.textFaint }]} numberOfLines={1}>{artist}</Text>
            </View>
            <TouchableOpacity onPress={() => skipWithRamp('prev')} style={styles.btn} hitSlop={HIT}>
                <SkipPrevIcon size={20} color={SKIP_ICON_COLOR} />
            </TouchableOpacity>
            <TouchableOpacity
                onPress={() => isPlaying ? pauseWithRamp() : playWithRamp()}
                style={styles.btn} hitSlop={HIT}
            >
                {isPlaying ? <PauseIcon size={20} color={theme.accent} /> : <PlayIcon size={18} color={theme.accent} />}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => skipWithRamp('next')} style={styles.btn} hitSlop={HIT}>
                <SkipNextIcon size={20} color={SKIP_ICON_COLOR} />
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
    );
}

const HIT = { top: 16, bottom: 16, left: 16, right: 16 };

const styles = StyleSheet.create({
    shell: { position: 'absolute', left: 10, right: 10, height: 68, borderRadius: 16, borderCurve: 'continuous', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 12 },
    container: { flex: 1, borderRadius: 16, borderCurve: 'continuous', borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, overflow: 'hidden' },
    art: { width: ART_SIZE, height: ART_SIZE, marginRight: 12, backgroundColor: '#0f0f0f', borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
    info: { flex: 1, marginRight: 4 },
    title: { color: '#e5e5e5', fontSize: 14, fontWeight: '600' },
    artist: { color: '#555', fontSize: 12, marginTop: 2 },
    // marginHorizontal added — the three buttons sat directly adjacent with
    // no gap at all, just their own 40px width apart, which read as too
    // close together.
    btn: { width: 40, height: 40, marginHorizontal: 3, justifyContent: 'center', alignItems: 'center' },
    miniProgressTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 6, backgroundColor: 'transparent' },
    miniProgressFill: { height: 6, borderRadius: 0 },
});
