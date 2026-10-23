import React, { useState, useEffect, useRef, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { listArtUri } from '../utils/embeddedArt';
import AudioEngine, { usePlaybackState, State, useProgress, matchProgress } from '../native/AudioEngine';
import { useNavigation } from '@react-navigation/native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { usePreferences } from '../context/PreferencesContext';
import { skipWithRamp, playWithRamp, pauseWithRamp } from '../services/PlaybackService';
import { PlayIcon, PauseIcon, SkipNextIcon, SkipPrevIcon } from './Icons';
import GradientCap from './GradientCap';
import DimPressable from './DimPressable';
import { squircle } from '../utils/squircle';
import { formatArtists } from '../utils/artists';
import { PILL_H, PILL_COVER, PILL_COVER_PAD } from '../utils/layout';
import { getProgressSeed, setProgressSeed } from '../utils/progressSeed';

const TAB_BAR_HEIGHT = 49;
const ART_SIZE = PILL_COVER;   // same cover size as the song pills
const SKIP_ICON_COLOR = '#bbb'; // fixed regardless of accent, including white

export default function MiniPlayer({ withTabBar = true }) {
    const navigation = useNavigation();
    const { currentTrack, playbackRate } = usePlayback();
    const { theme, base } = useTheme();
    const { coverShape, showSongCovers, artistSeparator, artistDisplayJoin, miniPlayerShadow } = usePreferences();
    const playbackState = usePlaybackState();
    const isPlaying = playbackState.state === State.Playing;
    const rawProgress = useProgress(500);
    // Only readings that belong to the song being shown count (a late reading
    // from before a skip used to make the bar jump to the old song's spot).
    const progress = useMemo(
        () => matchProgress(rawProgress, currentTrack?._qid, currentTrack?.duration, currentTrack?.id),
        [rawProgress, currentTrack?._qid, currentTrack?.duration, currentTrack?.id]
    );
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
        if (progress.stale && !trackChanged) return;   // a reading for the other song: ignore it
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
            // Same as the Player's bar: ask for the real spot now (a crossfade
            // flips the display halfway, so the new song is already a few
            // seconds in) and start there. Falls back to 0 if no usable answer
            // arrives quickly.
            const trackAtChange = currentTrack?.id;
            const idAtChange = currentTrack?.id;
            // The old song's position must not stay on screen while the real one is asked for:
            // the bar goes to the start at once, then moves to the real spot when it is known.
            basisRef.current = { position: 0, duration: 0, at: Date.now() };
            // Right after a session restore the position is already known: draw the bar from it at once.
            const seed = getProgressSeed();
            const seeded = !!(seed && seed.id === currentTrack?.id && seed.duration > 0 && (!seed.qid || !currentTrack?._qid || seed.qid === currentTrack._qid));
            if (seeded) {
                basisRef.current = { position: seed.position, duration: seed.duration, at: Date.now() };
                setProgressSeed(null);
            }
            let settled = seeded;
            const toZero = () => { if (settled || lastTrackIdRef.current !== trackAtChange) return; settled = true; basisRef.current = { position: 0, duration: 0, at: Date.now() }; forceTick(t => t + 1); };
            setTimeout(toZero, 250);
            AudioEngine.getProgress().then(p => {
                if (settled || lastTrackIdRef.current !== trackAtChange || !(p?.duration > 0)) return;
                if (idAtChange && p.id && p.id !== idAtChange) return;   // a reading for the other song
                if (p.position > p.duration || p.position > 40) return;
                settled = true;
                basisRef.current = { position: p.position, duration: p.duration, at: Date.now() };
                forceTick(t => t + 1);
            }).catch(() => { toZero(); });
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
        const idAtStart = currentTrack?.id;
        AudioEngine.getProgress().then(p => {
            if (cancelled || lastTrackIdRef.current !== trackAtStart || !(p?.duration > 0)) return;
            if (idAtStart && p.id && p.id !== idAtStart) return;
            basisRef.current = { position: p.position, duration: p.duration, at: Date.now() };
            forceTick(t => t + 1);
        }).catch(() => { });
        return () => { cancelled = true; };
    }, [isPlaying]);

    if (!currentTrack) return null;

    const bottom = (withTabBar ? TAB_BAR_HEIGHT : 0) + insets.bottom + 6;
    const title = currentTrack.ourTitle ?? currentTrack.title ?? '';
    const artist = formatArtists(currentTrack.ourArtist ?? currentTrack.artist ?? '', artistSeparator, artistDisplayJoin);
    const artwork = listArtUri(currentTrack.artwork);

    return (
        <DimPressable
            style={[styles.shell, miniPlayerShadow && styles.shellShadow, { bottom, backgroundColor: base.surface }]}
            onPress={() => navigation.navigate('Player', {})}
        >
          {/* Outer shell carries the shadow (a shadow can't coexist with
              overflow: hidden on the same view on iOS). This inner view owns
              the outline and clips everything inside it, the gradient,
              progress fill and content, to the exact same rounded shape, so
              nothing can stop short of or poke past the outline on either
              side. */}
          <View style={[styles.container, { borderColor: theme.accentDim, backgroundColor: base.surface }, !showSongCovers && { paddingLeft: 18 }]}>
            <GradientCap color={theme.accent} height={PILL_H} style={{ opacity: 0.5 }} />
            <View pointerEvents="none" style={styles.miniProgressTrack}>
                <MiniProgressFill basis={basisRef.current} isPlaying={isPlaying} playbackRate={playbackRate} trackKey={currentTrack?._qid ?? currentTrack?.id} color={theme.accent} />
            </View>
            {/* "Show Song Covers In Lists" previously only applied to All
                Songs/Playlist rows and the Queue sheet — the mini player
                always showed art regardless, unlike everywhere else covers
                appear. */}
            {showSongCovers && (
                <View style={[styles.art, { backgroundColor: base.surface, overflow: 'hidden', borderRadius: squircle(ART_SIZE, coverShape) }]}>
                    {artwork
                        ? <Image source={{ uri: artwork }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                        : null
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
        </DimPressable>
    );
}

// The moving progress fill. Like the main progress bar it runs ONE continuous
// animation at the song's real-time rate (on the native side, so it is
// perfectly smooth and costs the JS thread nothing) and only restarts it when
// the real position has drifted, the song or speed changed, or play/pause
// flipped. It used to redraw the whole mini player four times a second.
function MiniProgressFill({ basis, isPlaying, playbackRate, trackKey, color }) {
    const [w, setW] = useState(0);
    const pctVal = useRef(new Animated.Value(0)).current;
    const run = useRef(null);   // { anim, from, at, rate, duration, trackKey }
    useEffect(() => {
        if (w <= 0) return;
        const duration = basis.duration;
        const pct = duration > 0 ? Math.min(1, Math.max(0, basis.position / duration)) : 0;
        const rate = playbackRate || 1;
        const r = run.current;
        if (r && isPlaying && r.playing && r.trackKey === trackKey && r.rate === rate && r.duration === duration) {
            const expected = r.from + ((Date.now() - r.at) / 1000) * rate / duration;
            // + = the bar is ahead of the sound. Right after a start the audio
            // position is still settling, and a bar that is a little ahead is
            // left alone (a backward jump is the visible glitch).
            const aheadSec = (expected - pct) * duration;
            const settling = Date.now() - (r.startedAt || 0) < 2500;
            const tol = settling ? 1.5 : (aheadSec > 0 ? 1.2 : 0.5);
            if (Math.abs(aheadSec) < tol) return;   // still on track, leave it running
        }
        const fresh = !(r && r.playing && r.trackKey === trackKey);
        if (r?.anim) r.anim.stop();
        pctVal.setValue(pct);
        if (!isPlaying || duration <= 0 || pct >= 1) { run.current = { anim: null, playing: false, trackKey, rate, duration }; return; }
        const anim = Animated.timing(pctVal, { toValue: 1, duration: ((1 - pct) * duration * 1000) / rate, easing: Easing.linear, useNativeDriver: true });
        run.current = { anim, playing: true, from: pct, at: Date.now(), rate, duration, trackKey, startedAt: fresh ? Date.now() : (r.startedAt || Date.now()) };
        anim.start();
    }, [basis.at, basis.position, basis.duration, isPlaying, playbackRate, trackKey, w, pctVal]);
    useEffect(() => () => { run.current?.anim?.stop(); }, []);
    return (
        <View style={{ height: 6, overflow: 'hidden' }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
            {w > 0 && (
                <Animated.View style={{ height: 6, width: w, backgroundColor: color, transform: [{ translateX: pctVal.interpolate({ inputRange: [0, 1], outputRange: [-w, 0] }) }] }} />
            )}
        </View>
    );
}

const HIT = { top: 16, bottom: 16, left: 16, right: 16 };

const styles = StyleSheet.create({
    shell: { position: 'absolute', left: 10, right: 10, height: PILL_H, borderRadius: 16, borderCurve: 'continuous' },
    shellShadow: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 12 },
    container: { flex: 1, borderRadius: 16, borderCurve: 'continuous', borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingLeft: PILL_COVER_PAD - 1, paddingRight: 14, overflow: 'hidden' },
    art: { width: ART_SIZE, height: ART_SIZE, marginRight: 12, backgroundColor: '#0f0f0f', justifyContent: 'center', alignItems: 'center' },
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
