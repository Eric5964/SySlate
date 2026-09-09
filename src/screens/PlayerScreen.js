import React, { useEffect, useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Dimensions, Image, Animated, Easing, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AudioEngine, { useProgress, usePlaybackState, State } from '../native/AudioEngine';
import { useNavigation, useRoute } from '@react-navigation/native';
import { usePlayback } from '../context/PlaybackContext';
import { usePreferences } from '../context/PreferencesContext';
import { formatArtists } from '../utils/artists';
import { getLyrics, activeLyricIndex, peekLyrics } from '../utils/lyrics';
import { useTheme } from '../context/ThemeContext';
import { skipWithRamp, playWithRamp, pauseWithRamp, isTransitionLocked, forceReleaseFade } from '../services/PlaybackService';
import { PlayIcon, PauseIcon, SkipNextIcon, SkipPrevIcon, ShuffleIcon, LoopIcon, MenuBarsIcon, MoonIcon } from '../components/Icons';
import SleepTimerSheet from '../components/SleepTimerSheet';
import { PanGestureHandler, TapGestureHandler, State as GHState } from 'react-native-gesture-handler';
import EQModal from '../components/EQModal';
import QueueModal from '../components/QueueModal';
import ScreenBackground from '../components/ScreenBackground';
import GradientCap from '../components/GradientCap';
import { squircle } from '../utils/squircle';
import { getPlayCounts } from '../utils/storage';

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
        sleepTimerEndAt, sleepAtTrackEnd,
    } = usePlayback();

    const progress = useProgress(500);
    // Only true right after the CURRENTLY-PLAYING track actually changes —
    // not on every mount. Before, this effect fired on mount regardless of
    // whether currentTrack.id had genuinely changed (that's just how effects
    // work on the dependency they're given), which is why opening the player
    // — even mid-song — briefly showed 0:00 before jumping to the real
    // position. prevTrackIdRef starts equal to the first render's id, so the
    // mount case is a no-op; only a later, real change fires this.
    const prevTrackIdRef = useRef(currentTrack?.id);
    const [justSwitched, setJustSwitched] = useState(false);
    useEffect(() => {
        if (prevTrackIdRef.current === currentTrack?.id) return;
        prevTrackIdRef.current = currentTrack?.id;
        setJustSwitched(true);
        const t = setTimeout(() => setJustSwitched(false), 400);
        return () => clearTimeout(t);
    }, [currentTrack?.id]);
    const playbackState = usePlaybackState();
    const isPlaying = playbackState.state === State.Playing;

    // const [showEQ, setShowEQ] = useState(false); // EQ hidden
    const [showQueue, setShowQueue] = useState(false);
    const [showSleepTimer, setShowSleepTimer] = useState(false);
    const [showEQ, setShowEQ] = useState(false);
    const [playCount, setPlayCount] = useState(0);
    // This used to be its own local `useState(true)`, loaded once on mount
    // via getShowPlayCount() and never touched again — every OTHER screen
    // (All Songs, Playlist Detail, Queue) reads this from the shared
    // PreferencesContext specifically so a toggle in Settings reaches an
    // already-mounted screen immediately (see that context's own comment).
    // Player being the one screen that kept its own stale local copy meant
    // it just wouldn't notice a toggle flip while already open — since
    // Player tends to stay mounted for the whole session, this is likely
    // why play count looked "off" here even after confirming the actual
    // preference was on.
    const { showPlayCount, artistSeparator, lyricsMode, lyricsResyncSec, lyricsOffsetSec, coverShape, backgroundImageEnabled, showPlayerCover } = usePreferences();

    useEffect(() => {
        if (!currentTrack?.id) { setPlayCount(0); return; }
        getPlayCounts([currentTrack]).then(counts => setPlayCount(counts[currentTrack.id] ?? 0));
    }, [currentTrack?.id]);

    const progressRef = useRef(null);
    const controlsRef = useRef(null);
    const progressLayout = useRef({ pageX: 28, width: width - 56 });
    const [dragRatio, setDragRatio] = useState(null);
    const seekChainRef = useRef(Promise.resolve());
    const latestSeekRatioRef = useRef(null);
    const clearDragTimer = useRef(null);
    const committedRef = useRef(false);
    const gestureTrackIdRef = useRef(null);
    // Set on commit to the ratio we just asked the native side to seek to;
    // cleared once the polled position actually agrees (see the
    // convergence effect below) rather than on a fixed timer. See onScrub's
    // commit branch for why the fixed timer this replaced caused a visible
    // "jumps back" glitch.
    const pendingSeekRatioRef = useRef(null);
    // Backstop: if no terminal gesture state ever arrives after a touch
    // starts (this has been the recurring symptom — the bar freezes and
    // STAYS frozen, even across later songs, only unstuck by a real drag),
    // force a commit anyway after 500ms so a touch can never leave dragRatio
    // stuck forever. This doesn't depend on correctly diagnosing which
    // gesture-handler state transition is or isn't firing.
    const stuckSafetyTimer = useRef(null);
    const lastTouchX = useRef(0);

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

    const touchToRatio = (pageX) => Math.max(0.002, Math.min(0.99,
        (pageX - progressLayout.current.pageX) / progressLayout.current.width
    ));

    const onScrub = (absoluteX, commit) => {
        lastTouchX.current = absoluteX;
        const ratio = touchToRatio(absoluteX);
        setDragRatio(ratio);
        stopAnim();
        animPct.setValue(ratio);
        animPctValueRef.current = ratio;

        if (!commit) {
            // Visual feedback only — nothing is seeked until release, so
            // audio keeps playing from wherever it actually is while
            // dragging. Re-arms the stuck-safety backstop on every update
            // (not just once at BEGAN) so it's a true "500ms since
            // anything last happened" watchdog rather than a fixed timeout
            // from touch-start, which used to fire mid-drag on any gesture
            // that simply took longer than 500ms start-to-finish.
            clearTimeout(stuckSafetyTimer.current);
            stuckSafetyTimer.current = setTimeout(() => {
                onScrubRef.current(lastTouchX.current, true);
            }, 500);
            return;
        }

        // Commit — release, a tap, or the stuck-safety backstop. Only
        // fires once per gesture: without this guard, a real release
        // landing right after the safety backstop already fired would
        // seek twice to (almost) the same spot.
        if (committedRef.current) return;
        committedRef.current = true;
        clearTimeout(stuckSafetyTimer.current);

        startRealTimeAnim(ratio);
        clearTimeout(clearDragTimer.current);

        // Abuse case flagged explicitly: held long enough that the track
        // actually changed under us (natural end-of-track, a remote skip,
        // etc.) while still dragging — the position being released at no
        // longer corresponds to whatever's playing now, so drop the seek
        // instead of applying it to the wrong track.
        const nowTrackId = currentTrack?._qid ?? currentTrack?.id ?? null;
        if (nowTrackId !== gestureTrackIdRef.current) { setDragRatio(null); return; }

        if (progress.duration > 0) {
            const targetRatio = ratio;
            const duration = progress.duration;
            latestSeekRatioRef.current = targetRatio;
            // "Double-plays when sliding the bar" with ramping on: seekTo
            // never checked for an in-flight ramp before running. Native
            // seekTo reschedules and immediately resumes playback at
            // whatever volume the node is CURRENTLY at (mid-fade, e.g.
            // 0.4) — but the JS ramp timer that was already running had no
            // idea a seek just happened, and kept firing its own volume
            // steps / its own eventual pause() on top of the freshly
            // resumed audio. Releasing the fade lock (its remaining steps
            // check ownership before touching volume, so this makes them
            // no-op cleanly — see forceReleaseFade above) and restoring
            // full volume before the seek lands means there's exactly one
            // thing driving playback state through a seek, not two.
            if (isTransitionLocked()) {
                forceReleaseFade();
                AudioEngine.setVolume(1).catch(() => { });
            }
            // Was: clearDragTimer fired unconditionally 300ms after commit,
            // regardless of whether this seek had actually landed natively
            // yet. Once dragRatio cleared, the drift-correction effect
            // re-armed immediately — and if the polled position (500ms
            // interval) hadn't caught up to the seek yet, it read that
            // STALE pre-seek position as "drift" and snapped the bar back
            // to it, then snapped forward again once the next poll finally
            // agreed. That's the "shows the movement but then jumps back"
            // symptom. Now dragRatio stays held (bar shows the target
            // position) until the polled position actually agrees — see
            // the convergence effect below — with this timer only as a
            // backstop in case a seek silently fails to land.
            pendingSeekRatioRef.current = targetRatio;
            clearDragTimer.current = setTimeout(() => {
                pendingSeekRatioRef.current = null;
                setDragRatio(null);
            }, 2500);
            seekChainRef.current = seekChainRef.current.then(async () => {
                if (latestSeekRatioRef.current !== targetRatio) return; // superseded by a newer seek before its turn
                try { await AudioEngine.seekTo(targetRatio * duration); } catch { }
            });
        } else {
            // No known duration to seek within — nothing was actually
            // asked of native, so there's nothing to wait on converging.
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
    // Set the moment the PAN handler actually reports movement (which only
    // happens once real dragging has crossed activeOffsetX below) — lets
    // the tap handler's onTapStateChange know a real drag is already
    // underway, so it can bail out below instead of double-committing.
    const realDragMovedRef = useRef(false);

    const onProgressGestureEvent = useRef((e) => {
        realDragMovedRef.current = true;
        onScrubRef.current(e.nativeEvent.absoluteX, false);
    }).current;

    const onProgressStateChange = useRef((e) => {
        const { state, absoluteX } = e.nativeEvent;
        if (state === GHState.BEGAN) {
            measureProgress();
            committedRef.current = false;
            realDragMovedRef.current = false;
            gestureTrackIdRef.current = currentTrack?._qid ?? currentTrack?.id ?? null;
            onScrubRef.current(absoluteX, false);
            clearTimeout(stuckSafetyTimer.current);
            stuckSafetyTimer.current = setTimeout(() => {
                onScrubRef.current(lastTouchX.current, true);
            }, 500);
        }
        if (state === GHState.END || state === GHState.CANCELLED || state === GHState.FAILED) {
            onScrubRef.current(absoluteX, true);
        }
    }).current;

    // A plain stationary tap has been the one case that's stayed broken
    // across several attempts at handling it through PanGestureHandler's own
    // BEGAN/END states — this hands taps to a purpose-built TapGestureHandler
    // running SIMULTANEOUSLY with the pan handler instead, which is the
    // standard gesture-handler pattern for "tap or drag on the same view."
    // It fires reliably on ACTIVE for a genuine tap regardless of whatever
    // the pan handler's own state transitions do for a zero-movement touch,
    // and simply fails (no-op here) for anything that turns into a real
    // drag, since the pan handler already covers that case above.
    //
    // Real bug found here: "fails for anything that turns into a real drag"
    // was the intent, but TapGestureHandler has no maxDist/maxDeltaX
    // configured, so its default recognition window was loose enough to
    // still fire ACTIVE for the first moment of a genuine drag — before
    // enough movement had accrued to fail it out. That meant a drag could
    // trigger an early, premature commit here (seeking to wherever the
    // finger was in that first instant) via this handler, and then the
    // pan handler's OWN later END commit got silently dropped by
    // committedRef's already-committed guard — audible as the position
    // jumping to the wrong place first, then not responding to the actual
    // release ("double-plays when dragging"). Checking realDragMovedRef
    // here — set the moment the pan handler reports any real movement —
    // closes that window: once a real drag has started, this handler is
    // never allowed to commit, full stop, regardless of its own state.
    const panRef = useRef(null);
    const tapRef = useRef(null);
    const onTapStateChange = useRef((e) => {
        if (e.nativeEvent.state === GHState.ACTIVE && !realDragMovedRef.current) {
            measureProgress();
            onScrubRef.current(e.nativeEvent.absoluteX, true);
        }
    }).current;

    useEffect(() => {
        if (playlist && (!currentPlaylist || currentPlaylist.path !== playlist.path)) {
            loadPlaylist(playlist);
        }
    }, []);

    const displayTitle = currentTrack?.ourTitle ?? currentTrack?.title ?? '—';
    const displayArtist = formatArtists(currentTrack?.ourArtist ?? currentTrack?.artist ?? '', artistSeparator);
    // No per-song embedded-artwork (ID3/FLAC picture tag) extraction exists
    // anywhere in this codebase yet — currentTrack.artwork is never actually
    // populated, so "song covers" were always silently falling back to the
    // note glyph. This falls back to the PLAYLIST's cover image instead,
    // which is real data we already have. True per-file embedded artwork
    // would need a native module or a metadata-parsing library — a separate,
    // bigger feature if you want it.
    const artwork = currentTrack?.artwork;
    const pct = justSwitched ? 0 : (progress.duration > 0 ? progress.position / progress.duration : 0);

    // Lyrics: 'off' never even attempts a .lrc lookup (no wasted file I/O
    // for anyone who doesn't use this). 'manual' and 'auto' both look up
    // lyrics for every new track; the only difference is whether
    // `showingLyrics` starts true or false for a track that has them —
    // 'auto' defaults to showing them, 'manual' still defaults to the
    // cover but makes the toggle available. Either way this resets on
    // every track change, not just once — a manual toggle from a previous
    // song shouldn't carry over to the next one.
    const initialLyricsPeek = lyricsMode !== 'off' ? peekLyrics(currentTrack?.id) : undefined;
    const [lyricsData, setLyricsData] = useState(() => (initialLyricsPeek !== undefined ? initialLyricsPeek : null));
    const [showingLyrics, setShowingLyrics] = useState(() => lyricsMode === 'auto' && !!initialLyricsPeek);
    useEffect(() => {
        if (lyricsMode === 'off' || !currentTrack?.id) {
            setLyricsData(null);
            setShowingLyrics(false);
            return;
        }
        // Already resolved this song's lyrics earlier this session (common
        // — reopening the Player, or a background prefetch already ran) —
        // apply immediately instead of always going through the promise
        // below, which was the actual source of the "cover shows for a
        // split second before lyrics" report: even a cache-hit promise
        // still resolves a tick after first paint, so the cover-first frame
        // rendered every time regardless of how fast the real lookup was.
        const cached = peekLyrics(currentTrack.id);
        if (cached !== undefined) {
            setLyricsData(cached);
            setShowingLyrics(lyricsMode === 'auto' && !!cached);
            return;
        }
        let cancelled = false;
        getLyrics(currentTrack).then(data => {
            if (cancelled) return;
            setLyricsData(data);
            setShowingLyrics(lyricsMode === 'auto' && !!data);
        });
        return () => { cancelled = true; };
    }, [currentTrack?.id, lyricsMode]);

    // Only polls directly when useProgress doesn't yet have real data to
    // offer — either genuinely paused (position isn't moving on its own, so
    // one read per pause/track-change is enough), or playing but
    // useProgress hasn't ticked yet since mount/track-change (its own poll
    // interval hasn't landed once yet). That second case is why lyrics
    // previously stayed on the wrong line until the NEXT natural line
    // change caught it up — activeLine was gated on progress.duration but
    // nothing seeded a real value in the meantime. Deliberately NOT
    // continuous while progress.duration is already known and playing:
    // getProgress() and setVolume() share the same JS-bridge queue, so a
    // second poller running throughout playback could delay fadeVol's
    // ~25/sec setVolume steps — audible as jitter, and very likely the
    // actual cause of the newly-reported "ramping is glitchy/jumpy going
    // into a song" after this was first added as an always-on interval.
    const [lyricsProgress, setLyricsProgress] = useState({ position: 0, duration: 0 });
    const progressKnown = progress.duration > 0;
    useEffect(() => {
        if (!showingLyrics || (isPlaying && progressKnown)) return;
        // Was a single one-shot getProgress() call, not a repeating poll —
        // fine as long as (isPlaying && progressKnown) flips true shortly
        // after (useProgress's own poll catches up) and this effect stops
        // being the source of truth. But if progressKnown never becomes
        // true for a given track (useProgress's poll firing but duration
        // never validated — a metadata thing worth its own look, but not
        // reproducible from here), this fallback was never called again
        // either, since none of its dependencies change while stuck in
        // that state — lyricsProgress just froze at whatever position it
        // caught on that first, one-time fetch. That's the "sometimes
        // doesn't follow the song, stays at start" report: whatever
        // position happened to be current at that single fetch (often
        // near the very start) is what the lyrics view was stuck showing
        // forever. Polling here too, same as useProgress's own interval,
        // means lyrics keep tracking regardless of whether the primary
        // progress source ever recovers.
        let cancelled = false;
        const tick = () => {
            AudioEngine.getProgress().then(p => { if (!cancelled) setLyricsProgress(p); }).catch(() => { });
        };
        tick();
        const id = setInterval(tick, 500);
        return () => { cancelled = true; clearInterval(id); };
    }, [showingLyrics, isPlaying, progressKnown, currentTrack?.id]);

    // Prefer useProgress's own live value once it's actually populated;
    // otherwise (paused, or playing but not populated yet) fall back to the
    // one-shot read above.
    const effectiveLyricsProgress = (isPlaying && progressKnown) ? progress : lyricsProgress;

    // Same "is progress real yet" gate used elsewhere in this file (pct,
    // animPct, etc.) — position:0/duration:0 before the first real poll
    // lands. Without this, activeLine briefly computed against position 0
    // regardless of where the song actually is, so the lyrics view jumped
    // to the very first line and then jumped again once the real position
    // arrived a moment later — the reported "not synced when the player is
    // just opened".
    const activeLine = (lyricsData && effectiveLyricsProgress.duration > 0) ? activeLyricIndex(lyricsData, effectiveLyricsProgress.position + lyricsOffsetSec) : -1;

    // Seeded from the same initial guess as showingLyrics above (not always
    // 0/cover) so a cache-hit mount goes straight to lyrics without playing
    // the 280ms crossfade on first paint — that fade is for a real
    // cover<->lyrics transition, not something that should visibly happen
    // every time the Player screen opens.
    const lyricsFade = useRef(new Animated.Value(showingLyrics ? 1 : 0)).current; // 0 = cover, 1 = lyrics
    const lyricsFadeMounted = useRef(false);
    useEffect(() => {
        if (!lyricsFadeMounted.current) { lyricsFadeMounted.current = true; return; }
        Animated.timing(lyricsFade, { toValue: showingLyrics ? 1 : 0, duration: 280, easing: Easing.inOut(Easing.quad), useNativeDriver: true }).start();
    }, [showingLyrics]);

    const lyricsScrollRef = useRef(null);
    // Drives the per-line opacity fade (Spotify-style — replaces the old
    // box-edge gradient overlay entirely, see the lyrics map() below).
    const lyricsScrollY = useRef(new Animated.Value(0)).current;
    const lyricsRowYRef = useRef(new Map());
    // Bumped every time a row's real Y position lands via onLayout — the
    // scroll-to-line effect below depends on this so it re-runs once the
    // position it needs actually exists, instead of only reacting to
    // activeLine/showingLyrics changes. Without it: onLayout for a given
    // line can land a frame or two after lyrics are toggled on or a track
    // just started (React Native's onLayout is inherently async), the
    // effect finds nothing yet in the map for the current line, silently
    // gives up, and — since nothing else re-triggers it — the view just
    // sits wherever it was until activeLine naturally changes to a new
    // line and the effect runs again with the position now populated.
    // That's the reported "doesn't jump to the line until the next line
    // change" — not a timing/animation issue, a dropped retry.
    const [lyricsLayoutVersion, setLyricsLayoutVersion] = useState(0);
    // Manual scroll support: dragging the lyrics view pauses auto-sync;
    // after `lyricsResyncSec` idle seconds (Settings → Lyrics), it resumes
    // and snaps back to the currently-playing line.
    const [lyricsManualScroll, setLyricsManualScroll] = useState(false);
    const lyricsResyncTimer = useRef(null);
    const armResyncTimer = () => {
        if (lyricsResyncTimer.current) clearTimeout(lyricsResyncTimer.current);
        lyricsResyncTimer.current = setTimeout(() => setLyricsManualScroll(false), lyricsResyncSec * 1000);
    };
    useEffect(() => () => { if (lyricsResyncTimer.current) clearTimeout(lyricsResyncTimer.current); }, []);
    // "Lyrics don't reset to the top on a new song" — lyricsRowYRef never
    // got cleared on a track change, so a new song's ScrollView could start
    // out using stale row-Y values left over from the *previous* song's
    // layout (same index, different line, different height) until its own
    // onLayout calls landed and overwrote them one by one. Also explicitly
    // snap the scroll position itself back to the top and drop manual-scroll
    // mode, so a song switch always starts from a clean, unscrolled view
    // instead of wherever the last song's lyrics happened to leave it.
    useEffect(() => {
        lyricsRowYRef.current.clear();
        setLyricsLayoutVersion(v => v + 1);
        setLyricsManualScroll(false);
        lyricsScrollRef.current?.scrollTo({ y: 0, animated: false });
    }, [currentTrack?.id]);
    useEffect(() => {
        if (!showingLyrics) return;
        // Before the song reaches its first timed line (activeLine === -1,
        // e.g. a [00:00]-style intro gap, or seeking back to the very
        // start), this used to just no-op and leave the view wherever it
        // last was — "should automatically go to the start if the song
        // hasn't started the lyrics yet." Scroll to top for that case too,
        // not just skip it, and release manual-scroll so a deliberate
        // scroll-up-to-the-top by the user doesn't immediately get
        // overridden by the very next tick before the position has
        // actually caught up.
        if (activeLine < 0) {
            if (lyricsManualScroll) return;
            lyricsScrollRef.current?.scrollTo({ y: 0, animated: true });
            return;
        }
        if (lyricsManualScroll) return;
        const y = lyricsRowYRef.current.get(activeLine);
        if (y === undefined) return;
        // Centers the active line roughly a third of the way down the
        // lyrics box rather than dead center — reads more naturally, closer
        // to how lock-screen/streaming-app lyrics views usually scroll.
        lyricsScrollRef.current?.scrollTo({ y: Math.max(0, y - (width - 56) * 0.32), animated: true });
    }, [activeLine, showingLyrics, lyricsManualScroll, lyricsLayoutVersion]);

    // Re-sync only when needed: on mount, on play/pause toggling, on a track
    // switch, or if the running animation has drifted noticeably from what
    // the real progress hook reports (e.g. after a system hiccup). Anything
    // else, the animation just keeps running uninterrupted at real-time speed
    // — no restart, no stutter.
    const lastSyncedTrackIdRef = useRef(currentTrack?.id);
    useEffect(() => {
        if (dragRatio !== null) return; // scrubbing owns the value right now
        const trackChanged = lastSyncedTrackIdRef.current !== currentTrack?.id;
        lastSyncedTrackIdRef.current = currentTrack?.id;
        // Same fix as MiniPlayer: always stop on pause regardless of drift,
        // since a drift-gated check skips the stop() call whenever drift
        // happens to be near-zero at the moment of pausing — which is the
        // normal case, since pausing is immediate.
        if (!isPlaying) {
            stopAnim();
            animPct.setValue(pct);
            animPctValueRef.current = pct;
            return;
        }
        if (trackChanged) {
            // Real bug found via screen recording during crossfade: a track
            // change can land in a render where `pct` is a stale/mismatched
            // value from a different song — `progress` (position/duration)
            // comes from a separate 500ms poll and can lag one tick behind
            // `currentTrack` updating, and during a crossfade specifically,
            // native briefly reports the OUTGOING track's position paired
            // with the INCOMING track's duration (see AudioEngine.swift's
            // getProgress — currentIndex already points at the incoming
            // track for the whole crossfade, while position still tracks
            // the outgoing node until the handoff completes). Trusting
            // `pct` here is what made the bar briefly jump to some unrelated
            // high position right as the crossfade handed off, before
            // snapping back down once a fresh poll landed. Resetting
            // straight to 0 instead — a track change always starts the
            // visual bar fresh anyway, same as `justSwitched` already does
            // for the position text above — never shows that wrong
            // intermediate value; the very next real poll corrects it via
            // the ordinary drift check below, same as always.
            startRealTimeAnim(0);
            return;
        }
        const drift = Math.abs(animPctValueRef.current - pct);
        if (!animRunRef.current || drift > 0.02) {
            startRealTimeAnim(pct);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [Math.round(pct * 200), isPlaying, currentTrack?.id]);

    // Clears the post-seek drag overlay once the polled position actually
    // agrees with where we told native to seek to — see the commit branch
    // in onScrub above for why this replaced a fixed timer. Independent of
    // the drift-correction effect above (which stays disabled the whole
    // time dragRatio is non-null, so the two can't fight each other).
    useEffect(() => {
        if (pendingSeekRatioRef.current === null) return;
        if (Math.abs(pct - pendingSeekRatioRef.current) < 0.02) {
            pendingSeekRatioRef.current = null;
            clearTimeout(clearDragTimer.current);
            setDragRatio(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [Math.round(pct * 200)]);

    useEffect(() => {
        return () => { stopAnim(); clearTimeout(stuckSafetyTimer.current); clearTimeout(clearDragTimer.current); };
    }, []);

    const animWidth = animPct.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
    const animLeft = animPct.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
    const skipIconColor = base.textDim; // fixed regardless of ACCENT (not base) — still needs to adapt light/dark

    // Shuffle/loop previously swapped color INSTANTLY on state change while
    // TouchableOpacity's own built-in press-dim (opacity 1 -> 0.2 -> 1) was
    // still running — the color jump landing mid-dim is what read as "goes
    // dark, goes darker, goes back up" (three visible stages) instead of one
    // smooth motion like the skip buttons (whose color never changes, only
    // opacity does). Animating the color itself in step with the same kind
    // of timing lets both properties move together as one transition.
    // Duration bumped from 120 -> 180ms per feedback ("slightly longer
    // fade"). Kept as one constant so the press-time trigger below and the
    // fallback useEffect can't drift apart from each other.
    const SIDE_BTN_FADE_MS = 180;
    const shuffleAnim = useRef(new Animated.Value(shuffleOn ? 1 : 0)).current;
    const loopAnim = useRef(new Animated.Value(singleLoop ? 1 : 0)).current;
    useEffect(() => {
        Animated.timing(shuffleAnim, { toValue: shuffleOn ? 1 : 0, duration: SIDE_BTN_FADE_MS, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
    }, [shuffleOn]);
    useEffect(() => {
        Animated.timing(loopAnim, { toValue: singleLoop ? 1 : 0, duration: SIDE_BTN_FADE_MS, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
    }, [singleLoop]);
    const shuffleColor = shuffleAnim.interpolate({ inputRange: [0, 1], outputRange: [base.textFaint, theme.accent] });
    const loopColor = loopAnim.interpolate({ inputRange: [0, 1], outputRange: [base.textFaint, theme.accent] });

    // Triggers the animation immediately, synchronously, right at the tap —
    // not waiting on the setShuffleOn -> re-render -> useEffect round trip
    // above, which costs at least one full extra render cycle before the
    // animation even starts. The useEffect above still exists as a fallback
    // for shuffleOn/singleLoop changing from somewhere else entirely (e.g.
    // restoring a session), so nothing relies exclusively on this.
    //
    // Both back on the JS driver (useNativeDriver: false) — tried moving
    // just these two onto the native driver to dodge the JS-thread
    // congestion toggleShuffle's real queue work causes (see below), since
    // color interpolation IS natively supported in general. But loop icon
    // uses Animated.Text with the interpolation directly in its own style,
    // while ShuffleIcon renders two separate Animated.Views and only
    // receives the interpolation through a `color` prop — and on the
    // native driver specifically, shuffle came out visibly wrong (loop,
    // same change, stayed correct). Not confident enough in the exact
    // mechanism there to leave it that way with no way to test it, so
    // reverted to the driver that's actually known to render both
    // correctly, and the congestion problem is addressed differently below
    // instead.
    const onPressShuffle = () => {
        Animated.timing(shuffleAnim, { toValue: shuffleOn ? 0 : 1, duration: SIDE_BTN_FADE_MS, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
        // Deferred one tick so the animation's first, most important frames
        // get a clear run on the JS thread before toggleShuffle's real
        // native-queue work (reading the current track, reading the whole
        // queue, rebuilding and re-adding it — see reshuffleUpcoming) starts
        // competing with it. toggleSingleLoop below doesn't need this — it's
        // one setRepeatMode() call, not enough concurrent work to visibly
        // compete with an 180ms animation in the first place.
        setTimeout(() => toggleShuffle(), 0);
    };
    const onPressLoop = () => {
        Animated.timing(loopAnim, { toValue: singleLoop ? 0 : 1, duration: SIDE_BTN_FADE_MS, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
        toggleSingleLoop();
    };

    return (
        <ScreenBackground style={[s.container, { paddingTop: insets.top + 6 }]}>
            <GradientCap color={theme.accent} height={68} style={{ borderBottomLeftRadius: 16, borderBottomRightRadius: 16, opacity: 0.5 }} />

            <View style={s.topBar}>
                <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={HIT} style={s.topBtn}>
                    <Text style={[s.topIcon, { color: theme.accent }]}>↓</Text>
                </TouchableOpacity>
                <Text style={[s.topLabel, { color: theme.accent }]} numberOfLines={1}>{currentPlaylist?.name ?? 'Now Playing'}</Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                    {/* EQ used to be hidden here with a comment saying
                        react-native-track-player didn't support real audio
                        EQ — true when that comment was written, but the
                        engine was replaced with the custom AudioEngine
                        (which DOES support EQ) several rounds ago and this
                        was never un-hidden. */}
                    <TouchableOpacity onPress={() => setShowSleepTimer(true)} hitSlop={HIT} style={[s.topBtn, { marginRight: 4 }]}>
                        <MoonIcon size={19} color={(sleepTimerEndAt || sleepAtTrackEnd) ? theme.accent : base.textFaint} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setShowEQ(true)} hitSlop={HIT} style={s.topBtn}>
                        <Text style={[s.eqTag, { color: theme.accent }]}>EQ</Text>
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
                {/* Cover and lyrics are now separate boxes sharing the same
                     slot (absolute-positioned over each other), not the
                     lyrics view nested inside the cover's own box —
                     previously the lyrics inherited the cover box's
                     background/shadow (a slightly lighter gray, meant to
                     read as a raised card of art), which looked wrong for
                     plain text. Lyrics use the screen's own background
                     instead, no shadow. */}
                <View style={[s.artWrap, { paddingTop: 20 }]}>
                    <View style={{ width: width - 56, height: width - 56 }}>
                        {showPlayerCover && (
                            // The whole box (background/shadow/rounded corners) now
                            // fades with lyricsFade too, not just the artwork inside
                            // it — previously only the inner content faded, so the
                            // box's own dark background + shadow stayed visible as a
                            // flat square sitting behind the lyrics text. Fully
                            // transparent (and non-interactive) once lyrics are showing.
                            <Animated.View
                                style={[s.art, { backgroundColor: base.surface, shadowColor: theme.accent, borderRadius: squircle(width - 56, coverShape) }, { opacity: lyricsFade.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}
                                pointerEvents={showingLyrics ? 'none' : 'auto'}
                            >
                                {artwork
                                    ? <Image source={{ uri: artwork }} style={s.artImg} resizeMode="cover" />
                                    : <Text style={[s.artNote, { color: theme.accentDim }]}>♪</Text>
                                }
                            </Animated.View>
                        )}
                        {lyricsData && (
                            <Animated.View
                                style={[{ position: 'absolute', top: -60, bottom: -60, left: 0, right: 0 }, { opacity: lyricsFade, overflow: 'hidden' }]}
                                pointerEvents={showingLyrics ? 'auto' : 'none'}
                            >
                                <Animated.ScrollView
                                    ref={lyricsScrollRef}
                                    style={{ flex: 1 }}
                                    contentContainerStyle={s.lyricsContent}
                                    showsVerticalScrollIndicator={false}
                                    scrollEnabled={showingLyrics}
                                    onScroll={Animated.event(
                                        [{ nativeEvent: { contentOffset: { y: lyricsScrollY } } }],
                                        { useNativeDriver: true }
                                    )}
                                    scrollEventThrottle={16}
                                    onScrollBeginDrag={() => {
                                        if (lyricsResyncTimer.current) clearTimeout(lyricsResyncTimer.current);
                                        setLyricsManualScroll(true);
                                    }}
                                    onScrollEndDrag={armResyncTimer}
                                    onMomentumScrollEnd={armResyncTimer}
                                >
                                    {/* Was scrollEnabled={false} — the swipe-to-dismiss
                                        gesture that used to be the concern is limited (via
                                        gestureResponseDistance, set from the controls row
                                        below) to starting above the control row, and a
                                        RNGH-composed ScrollView generally yields to a
                                        surrounding pan gesture at its own scroll bounds
                                        anyway. If the two still fight in practice, that's
                                        worth a follow-up report with which one wins. */}
                                    {lyricsData.map((line, i) => {
                                        // Requested Spotify-style: fade the LINES
                                        // themselves near the top/bottom edges, not a
                                        // dark box sitting over them (removed the two
                                        // GradientCap overlays below). A line's own Y
                                        // (lyricsRowYRef, only known after its own
                                        // onLayout) minus the live scroll offset is its
                                        // position within the visible box; interpolating
                                        // THAT against a fixed [0, FADE, boxH-FADE, boxH]
                                        // shape gives each line an independent fade as it
                                        // crosses the edges, driven by the same shared
                                        // scrollY value. Before the first layout pass,
                                        // lineY is unknown — render fully opaque rather
                                        // than guessing, onLayout + lyricsLayoutVersion
                                        // corrects it within a frame.
                                        const lineY = lyricsRowYRef.current.get(i);
                                        const boxH = width - 56;
                                        const FADE = 60;
                                        const opacityStyle = lineY === undefined ? 1 : lyricsScrollY.interpolate({
                                            inputRange: [lineY - boxH, lineY - boxH + FADE, lineY - FADE, lineY],
                                            outputRange: [0, 1, 1, 0],
                                            extrapolate: 'clamp',
                                        });
                                        return (
                                            <Animated.Text
                                                key={i}
                                                onLayout={(e) => { lyricsRowYRef.current.set(i, e.nativeEvent.layout.y); setLyricsLayoutVersion(v => v + 1); }}
                                                style={[s.lyricLine, { textShadowColor: base.bg, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 4 }, { color: i === activeLine ? theme.accent : base.textDim, opacity: opacityStyle }]}
                                            >
                                                {line.text || '\u2026'}
                                            </Animated.Text>
                                        );
                                    })}
                                </Animated.ScrollView>
                            </Animated.View>
                        )}
                    </View>
                </View>

                {/* Always-reserved slot, whether or not the button inside it
                     renders — otherwise `middle`'s space-evenly layout
                     recalculates every gap the moment a song with/without
                     lyrics loads, visibly shifting the title down (or up)
                     depending on whether this song happens to have an .lrc
                     file. The slot's height is fixed regardless. */}
                <View>
                    {/* Real cause of the toggle looking untouched by the
                         earlier margin tweak: it was a SEPARATE sibling of
                         trackInfoGroup, both direct children of `middle`,
                         which uses justifyContent: 'space-evenly' — that
                         inserts its own (much bigger) flexible gap between
                         every top-level child regardless of any marginTop
                         set on either one. Moving the toggle to be the
                         first child INSIDE trackInfoGroup instead of a
                         sibling before it means it's now part of the same
                         single flex item as the title, so the only thing
                         controlling their distance is the marginBottom set
                         here directly — no more competing flex gap. */}
                    <View style={[s.trackInfoGroup, { marginTop: 16 }]}>
                    <View style={[s.lyricsToggleSlot, { marginBottom: 14 }]}>
                        {lyricsMode !== 'off' && lyricsData && (
                            <TouchableOpacity onPress={() => setShowingLyrics(v => !v)} style={s.lyricsToggleBtn}>
                                <Text style={[s.lyricsToggleText, { color: theme.accent }]}>
                                    {showingLyrics ? 'Show cover' : 'Show lyrics'}
                                </Text>
                            </TouchableOpacity>
                        )}
                    </View>
                    <View style={s.info}>
                        <View style={{ flex: 1 }}>
                            <Text style={[s.trackTitle, { color: base.text }]} numberOfLines={2}>{displayTitle}</Text>
                            <Text style={[s.trackArtist, { color: theme.accent }]} numberOfLines={1}>{displayArtist}</Text>
                        </View>
                        {showPlayCount && playCount > 0 && (
                            <Text style={[s.playCount, { color: base.textFaint }]}>{playCount}×</Text>
                        )}
                    </View>

                    <View style={s.progressSection}>
                        <TapGestureHandler ref={tapRef} onHandlerStateChange={onTapStateChange} simultaneousHandlers={panRef}>
                            <PanGestureHandler
                                ref={panRef}
                                onGestureEvent={onProgressGestureEvent}
                                onHandlerStateChange={onProgressStateChange}
                                activeOffsetX={[-6, 6]}
                                failOffsetY={[-14, 14]}
                                simultaneousHandlers={tapRef}
                            >
                                <View
                                    ref={progressRef}
                                    style={s.progressTouch}
                                    onLayout={measureProgress}
                                >
                                    <View style={[s.progressTrack, { backgroundColor: base.border }]}>
                                        <Animated.View style={[s.progressFill, { width: animWidth, backgroundColor: theme.accent }]} />
                                    </View>
                                    <Animated.View style={[s.progressThumb, { left: animLeft, marginLeft: -10, backgroundColor: theme.accent }]} />
                                </View>
                            </PanGestureHandler>
                        </TapGestureHandler>
                        <View style={s.times}>
                            <Text style={[s.time, { color: base.textFaint }]}>{fmt(dragRatio !== null ? dragRatio * progress.duration : (justSwitched ? 0 : progress.position))}</Text>
                            <Text style={[s.time, { color: base.textFaint }]}>{fmt(justSwitched ? 0 : progress.duration)}</Text>
                        </View>
                    </View>
                </View>
                </View>

                <View
                    ref={controlsRef}
                    style={[s.controls, { paddingBottom: insets.bottom + 10 }]}
                    onLayout={() => {
                        // Shrinks the swipe-to-dismiss zone (App.js sets
                        // gestureResponseDistance to the full screen height,
                        // so the sheet can be dismissed by swiping from
                        // anywhere) so it stops right above this row instead
                        // of covering it too. Without this, a tap on
                        // play/skip/shuffle/loop that carries even a little
                        // downward motion — normal with a real finger — could
                        // get stolen by the outer dismiss gesture instead of
                        // registering as a press, or trigger an unwanted
                        // dismiss outright. measureInWindow needs the view
                        // already laid out, which onLayout guarantees.
                        controlsRef.current?.measureInWindow((x, y) => {
                            if (y > 0) navigation.setOptions({ gestureResponseDistance: y });
                        });
                    }}
                >
                    {/* activeOpacity was 1 — meaning zero dimming feedback on
                        touch-down. That's a native, immediate response
                        (TouchableOpacity's own gesture responder, no JS round
                        trip) — without it, the color fade (however fast) was
                        the ONLY acknowledgment a tap had landed, and that's
                        gated behind JS work even at its quickest. This gives
                        an instant visual response the moment the finger
                        touches down, independent of everything else. */}
                    <TouchableOpacity onPress={onPressShuffle} style={s.sideBtn} hitSlop={HIT} activeOpacity={0.5}>
                        <ShuffleIcon size={28} color={shuffleColor} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => skipWithRamp('prev')} style={s.skipBtn} hitSlop={HIT}>
                        <SkipPrevIcon size={31} color={skipIconColor} />
                    </TouchableOpacity>
                    <TouchableOpacity
                        onPress={() => isPlaying ? pauseWithRamp() : playWithRamp()}
                        style={[s.playBtn, { backgroundColor: theme.accent, shadowColor: theme.accent }]}
                    >
                        {isPlaying ? <PauseIcon size={26} color={theme.onAccent} /> : <PlayIcon size={26} color={theme.onAccent} />}
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => skipWithRamp('next')} style={s.skipBtn} hitSlop={HIT}>
                        <SkipNextIcon size={31} color={skipIconColor} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={onPressLoop} style={s.sideBtn} hitSlop={HIT} activeOpacity={0.5}>
                        <LoopIcon size={28} color={loopColor} single={singleLoop} />
                    </TouchableOpacity>
                </View>
            </View>

            <EQModal visible={showEQ} onClose={() => setShowEQ(false)} playlistPath={currentPlaylist?.path} />
            <QueueModal visible={showQueue} onClose={() => setShowQueue(false)} />
            <SleepTimerSheet visible={showSleepTimer} onClose={() => setShowSleepTimer(false)} />
        </ScreenBackground>
    );
}

const HIT = { top: 20, bottom: 20, left: 20, right: 20 };

const s = StyleSheet.create({
    container: { flex: 1 },
    topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, marginBottom: 4 },
    topBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
    eqTag: { fontSize: 14, fontWeight: '700' },
    topIcon: { fontSize: 26 },
    topTag: { fontSize: 16, fontWeight: '700' },
    topLabel: { fontSize: 15, fontWeight: '500', flex: 1, textAlign: 'center' },
    middle: { flex: 1, justifyContent: 'space-evenly' },
    artWrap: { alignItems: 'center' },
    art: { width: width - 56, height: width - 56, backgroundColor: '#0f0f0f', justifyContent: 'center', alignItems: 'center', overflow: 'hidden', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8 },
    artImg: { width: '100%', height: '100%' },
    artNote: { fontSize: 80 },
    // Small text button matching the sort-label style used elsewhere
    // (Playlist/All Songs sort buttons) — plain text, no background, no
    // arrow, same visual weight as those.
    // Condensed and pulled up per feedback — was reading as a prominent
    // standalone button (large tap padding, bold weight, full accent
    // color); now smaller, thinner, and lighter so it sits closer to the
    // title instead of announcing itself as separate control.
    lyricsToggleSlot: { height: 28, justifyContent: 'flex-end', alignItems: 'center' },
    lyricsToggleBtn: { alignSelf: 'center', paddingHorizontal: 10, paddingVertical: 4 },
    lyricsToggleText: { fontSize: 12, fontWeight: '500', opacity: 0.7 },
    lyricsContent: { paddingVertical: '40%', paddingHorizontal: 6 },
    lyricLine: { fontSize: 24, lineHeight: 34, fontWeight: '700', textAlign: 'center', marginVertical: 7 },
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
    sideIcon: { fontSize: 29 },
    skipBtn: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center' },
    playBtn: { width: 84, height: 84, borderRadius: 42, justifyContent: 'center', alignItems: 'center', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 8 },
});
