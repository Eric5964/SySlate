import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Dimensions, Image, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { playerArtUri } from '../utils/embeddedArt';
import AudioEngine, { useProgress, usePlaybackState, matchProgress, State } from '../native/AudioEngine';
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
import DJDisc from '../components/DJDisc';
import PlaybackSpeedSheet, { formatSpeed } from '../components/PlaybackSpeedSheet';
import { squircle, cardRadius } from '../utils/squircle';
import { getPlayCounts } from '../utils/storage';

const { width } = Dimensions.get('window');

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
// A gray/neutral accent (white, silver, gray) is nearly the same color as the
// dim gray the non-playing lyric lines use, so the current line couldn't be
// told apart. For those accents the current line uses the full-strength text
// color and the rest drop to the faintest gray, so the contrast is always there.
function isNeutralColor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
    if (!m) return false;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return Math.max(r, g, b) - Math.min(r, g, b) < 28;
}

export default function PlayerScreen() {
    const navigation = useNavigation();
    const route = useRoute();
    const { playlist } = route.params ?? {};
    const { theme, base } = useTheme();
    const insets = useSafeAreaInsets();
    const lyricNeutral = isNeutralColor(theme.accent);
    const lyricActiveColor = lyricNeutral ? base.text : theme.accent;
    const lyricIdleColor = lyricNeutral ? base.textFaint : base.textDim;

    const {
        currentPlaylist, queueSource, playbackRate, currentTrack, shuffleOn, singleLoop,
        loadPlaylist, toggleShuffle, toggleSingleLoop,
        sleepTimerEndAt, sleepAtTrackEnd,
    } = usePlayback();

    const rawProgress = useProgress(500);
    // Only readings that belong to the song being shown count (a late reading
    // from before a skip used to drag the bar to the old song's spot).
    const progress = useMemo(
        () => matchProgress(rawProgress, currentTrack?._qid, currentTrack?.duration, currentTrack?.id),
        [rawProgress, currentTrack?._qid, currentTrack?.duration, currentTrack?.id]
    );
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
    const [showSpeed, setShowSpeed] = useState(false);
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
    const { showPlayCount, artistSeparator, lyricsResyncSec, lyricsOffsetSec, coverShape, showPlayerCover, coverShadow, lyricsScrollLocked, artistDisplayJoin, lyricsMode, djDisc, djDiscType, djDiscAssist, djDiscSpin, djDiscTouch, autoShowLyrics, autoShowDisc, discRpmValue, playerOutline, playerBtns, crossfadeEnabled, crossfadeDuration, crossfadeDurationEndOfTrack } = usePreferences();

    // The count is credited once a song passes half way, so the shown count is read again
    // at that moment (it used to stay stale until the next song). The `cancelled` flag stops a
    // slow read for the previous song from landing on the new one after a quick skip.
    const pastHalf = progress.duration > 0 && progress.position / progress.duration >= 0.5;
    useEffect(() => {
        if (!currentTrack?.id) { setPlayCount(0); return; }
        let cancelled = false;
        const id = currentTrack.id;
        const t = setTimeout(() => {
            getPlayCounts([currentTrack]).then(counts => { if (!cancelled) setPlayCount(counts[id] ?? 0); });
        }, pastHalf ? 400 : 0);
        return () => { cancelled = true; clearTimeout(t); };
    }, [currentTrack?.id, pastHalf]);

    const progressRef = useRef(null);
    const controlsRef = useRef(null);
    const progressLayout = useRef({ pageX: 28, width: width - 56 });
    const [dragRatio, setDragRatio] = useState(null);
    const [barW, setBarW] = useState(width - 56);
    const seekChainRef = useRef(Promise.resolve());
    const latestSeekRatioRef = useRef(null);
    const clearDragTimer = useRef(null);
    const committedRef = useRef(false);
    const gestureTrackIdRef = useRef(null);
    // Real cause of "the progress bar moves with my taps/drags but never
    // actually seeks, then snaps back" (no [SEEK-DEBUG] line ever appeared
    // in a real capture — the commit was being dropped BEFORE reaching
    // seekTo): the gesture handlers below are created once (useRef(...)
    // .current, deliberately, to stay referentially stable mid-gesture) so
    // anything they read directly from render scope is frozen at whatever
    // it was on the FIRST render. gestureTrackIdRef was being set from that
    // frozen currentTrack, while onScrub's "did the track change while you
    // were dragging?" check compares it against the CURRENT one — so as
    // soon as the playing track differed from whatever was loaded when this
    // screen first mounted, every seek got dropped as "track changed under
    // us". Taps were worse: they never set gestureTrackIdRef at all (null
    // -> always "changed") and never reset committedRef either. This ref is
    // refreshed every render, so the stable handlers can read it fresh.
    const nowTrackIdRef = useRef(currentTrack?._qid ?? currentTrack?.id ?? null);
    nowTrackIdRef.current = currentTrack?._qid ?? currentTrack?.id ?? null;
    // Set whenever the lyrics view's active line is about to move for a
    // reason OTHER than natural playback advancing one line at a time — a
    // manual seek (below) or a track change (see the lyrics reset effect
    // further down). Both are "jumps": the correct line could be anywhere
    // in the list, so the scroll should SNAP straight there, not animate
    // through everything in between the way a normal line-to-line advance
    // does. Consumed (and cleared) by the scroll-to-line effect itself.
    const lyricsJustJumpedRef = useRef(false);
    // Set on commit to the ratio we just asked the native side to seek to;
    // cleared once the polled position actually agrees (see the
    // convergence effect below) rather than on a fixed timer. See onScrub's
    // commit branch for why the fixed timer this replaced caused a visible
    // "jumps back" glitch.
    const pendingSeekRatioRef = useRef(null);
    // See the dedup check in onScrub's commit branch — tracks the last
    // ratio/time a native seekTo actually fired for.
    const lastNativeSeekRef = useRef({ ratio: -1, at: 0 });
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
    const animPctValueRef = useRef(progress.duration > 0 ? progress.position / progress.duration : 0); // the bar's value when it is not running
    // The bar runs as a native animation (it keeps moving smoothly even when
    // the JS thread is busy, e.g. right after Play or a skip), so its current
    // value is worked out from when it started instead of read back.
    const barRun = useRef(null);          // { from, at, rate } while it runs
    const barGraceUntil = useRef(0);      // right after a start the audio position is still settling
    const barPctNow = () => {
        const r = barRun.current;
        if (!r) return animPctValueRef.current;
        return Math.min(1, r.from + ((Date.now() - r.at) / 1000) * r.rate);
    };

    const stopAnim = () => {
        if (barRun.current) { animPctValueRef.current = barPctNow(); barRun.current = null; }
        animRunRef.current?.stop();
        animRunRef.current = null;
    };

    const startRealTimeAnim = (fromPct, grace = false) => {
        stopAnim();
        animPct.setValue(fromPct);
        animPctValueRef.current = fromPct;
        if (grace) barGraceUntil.current = Date.now() + 2500;
        if (!isPlaying || progress.duration <= 0 || fromPct >= 1) return;
        // Real time to the end = remaining song time / playback speed.
        const remainingMs = Math.max(0, ((1 - fromPct) * progress.duration * 1000) / (playbackRate || 1));
        barRun.current = { from: fromPct, at: Date.now(), rate: (playbackRate || 1) / progress.duration };
        const anim = Animated.timing(animPct, { toValue: 1, duration: remainingMs, easing: Easing.linear, useNativeDriver: true });
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
        if (committedRef.current) { console.log('[SEEK-DEBUG] commit ignored: already committed this gesture'); return; }
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
        if (nowTrackId !== gestureTrackIdRef.current) { console.log('[SEEK-DEBUG] commit dropped: track id mismatch', { nowTrackId, gesture: gestureTrackIdRef.current }); setDragRatio(null); return; }

        if (progress.duration > 0) {
            const targetRatio = ratio;
            const duration = progress.duration;
            // Moved ahead of everything below (was only guarding the final
            // seekTo call) — now also guards the isTransitionLocked()
            // interrupt-cleanup just below. Best working theory for BOTH
            // this and the double-audio bug: a real pan-gesture release can
            // apparently still be followed by a spurious extra BEGAN→END
            // from the simultaneous tap handler at the same position (see
            // realDragMovedRef's comment elsewhere in this file for the
            // general fragility here), which resets committedRef for what
            // LOOKS like a fresh gesture and lets a second, redundant
            // commit through to the same spot. That second commit's own
            // isTransitionLocked() cleanup (forceReleaseFade +
            // setVolume(1)) firing a beat later — possibly after the user
            // has already tapped Play and a fresh ramp-in has started —
            // would forcibly kill that ramp and slam volume to 1, matching
            // "swipe while paused, hit play, doesn't ramp." Bailing out
            // this early means a redundant commit does nothing at all
            // instead of just skipping the seek call.
            const now = Date.now();
            if (Math.abs(targetRatio - lastNativeSeekRef.current.ratio) < 0.005 && now - lastNativeSeekRef.current.at < 800) {
                console.log('[SEEK-DEBUG] commit skipped: same spot as the seek just made');
                return;
            }
            lastNativeSeekRef.current = { ratio: targetRatio, at: now };
            latestSeekRatioRef.current = targetRatio;
            // A seek can land the active lyric line anywhere — see
            // lyricsJustJumpedRef's declaration for why that means the
            // lyrics scroll-to-line effect should snap instead of animate.
            lyricsJustJumpedRef.current = true;
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
            // A fade (play ramp-in or pause ramp-out) that is running keeps
            // running: the seek moves the song position underneath it, the
            // bar shows the new spot at once, and the fade finishes on its
            // own (a pause ramp still ends in the pause). It used to cut the
            // fade and set the volume to full, which left a pause half done.
            if (isTransitionLocked()) console.log('[SEEK-DEBUG] seek during a fade: fade left running');
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
            // [SEEK-DEBUG] Temporary — same pattern as [RAMP-DEBUG]. Reported:
            // bar shows the drag, snaps back after ~0.5s, playback position
            // never actually changes. Every plausible cause I could confirm
            // by reading (bridge wiring, native seekTo/seekWithinCurrentTrack,
            // the dragRatio-holds-until-convergence logic) checked out fine
            // on paper, so this logs the one thing static reading can't
            // settle: whether AudioEngine.seekTo actually gets called, what
            // it resolves/throws, and whether the polled position (pct) ever
            // moves afterward. Safe to strip once diagnosed.
            console.log('[SEEK-DEBUG] committing seek', { targetRatio, targetSeconds: targetRatio * duration, duration });
            seekChainRef.current = seekChainRef.current.then(async () => {
                if (latestSeekRatioRef.current !== targetRatio) {
                    console.log('[SEEK-DEBUG] superseded before its turn, skipped', { targetRatio });
                    return;
                }
                try {
                    await AudioEngine.seekTo(targetRatio * duration);
                    console.log('[SEEK-DEBUG] seekTo resolved', { targetRatio });
                } catch (e) {
                    console.log('[SEEK-DEBUG] seekTo THREW', { targetRatio, error: String(e) });
                }
            });
        } else {
            console.log('[SEEK-DEBUG] commit skipped: no duration known yet');
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
            gestureTrackIdRef.current = nowTrackIdRef.current;
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
            // A tap is its own complete gesture: it must start from a
            // clean slate (see nowTrackIdRef's comment) instead of
            // inheriting whatever the last drag left behind.
            committedRef.current = false;
            gestureTrackIdRef.current = nowTrackIdRef.current;
            onScrubRef.current(e.nativeEvent.absoluteX, true);
        }
    }).current;

    useEffect(() => {
        if (playlist && (!currentPlaylist || currentPlaylist.path !== playlist.path)) {
            loadPlaylist(playlist);
        }
    }, []);

    const displayTitle = currentTrack?.ourTitle ?? currentTrack?.title ?? '—';
    const displayArtist = formatArtists(currentTrack?.ourArtist ?? currentTrack?.artist ?? '', artistSeparator, artistDisplayJoin);
    // No per-song embedded-artwork (ID3/FLAC picture tag) extraction exists
    // anywhere in this codebase yet — currentTrack.artwork is never actually
    // populated, so "song covers" were always silently falling back to the
    // note glyph. This falls back to the PLAYLIST's cover image instead,
    // which is real data we already have. True per-file embedded artwork
    // would need a native module or a metadata-parsing library — a separate,
    // bigger feature if you want it.
    const artwork = playerArtUri(currentTrack?.artwork);
    const pct = justSwitched ? 0 : (progress.duration > 0 ? progress.position / progress.duration : 0);

    // Lyrics: 'off' never even attempts a .lrc lookup (no wasted file I/O
    // for anyone who doesn't use this). 'manual' and 'auto' both look up
    // lyrics for every new track; the only difference is whether
    // `showingLyrics` starts true or false for a track that has them —
    // 'auto' defaults to showing them, 'manual' still defaults to the
    // cover but makes the toggle available. Either way this resets on
    // every track change, not just once — a manual toggle from a previous
    // song shouldn't carry over to the next one.
    const initialLyricsPeek = peekLyrics(currentTrack?.id);
    const [lyricsData, setLyricsData] = useState(() => (initialLyricsPeek !== undefined ? initialLyricsPeek : null));
    const [showingLyrics, setShowingLyrics] = useState(() => autoShowLyrics && !!initialLyricsPeek);
    useEffect(() => {
        if (!currentTrack?.id || lyricsMode === 'off') {
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
            setShowingLyrics(autoShowLyrics && !!cached);
            return;
        }
        let cancelled = false;
        getLyrics(currentTrack).then(data => {
            if (cancelled) return;
            setLyricsData(data);
            setShowingLyrics(autoShowLyrics && !!data);
        });
        return () => { cancelled = true; };
    }, [currentTrack?.id, autoShowLyrics, lyricsMode]);

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
    // Real gap found here (opening straight into lyrics from a cold-launch
    // restore, paused, before ever pressing Play): this always started at
    // position:0/duration:0 regardless of what was already known, so even
    // though activeLine's own gate (below) is correct, there was still a
    // real — if brief — window right as showingLyrics flips true where
    // activeLine had nothing to work with yet, landing on the activeLine<0
    // branch (scrolls to the top / whatever it last was) before the first
    // getProgress() round trip below actually resolves a moment later and
    // the real position takes over. useProgress's own poll (progress,
    // above) may well already have a real value by the time lyrics finish
    // resolving — seeding from that instead of a hardcoded zero closes the
    // gap for that common case instead of always eating one avoidable
    // async round trip's worth of wrong-content flash.
    const [lyricsProgress, setLyricsProgress] = useState(() => (progress.duration > 0 ? progress : { position: 0, duration: 0 }));
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
    // DJ disc view. Lives alongside the lyrics view: the button under the
    // cover cycles cover -> lyrics (if the song has them) -> disc (if the
    // setting is on) -> cover. At most one of the two is showing.
    // Starts already on the disc when Auto Disc is on, so reopening the Player
    // does not show the cover for a moment and then fade over to the disc.
    const [showingDisc, setShowingDisc] = useState(() => !!(autoShowDisc && !autoShowLyrics));
    const discFade = useRef(new Animated.Value(showingDisc ? 1 : 0)).current;
    // True from the moment the disc is chosen until it has completely faded
    // out again: the disc keeps spinning for that whole time, so switching
    // away looks like it is still playing in the background.
    const [discActive, setDiscActive] = useState(() => !!(autoShowDisc && !autoShowLyrics));
    useEffect(() => { if (showingDisc) setDiscActive(true); }, [showingDisc]);
    // Auto Disc: every new song opens on the disc (like Auto-show lyrics does
    // for lyrics; the two settings can never both be on). Otherwise each new
    // song goes back to the cover unless the lyrics view claims it.
    // A new song opens on lyrics if Auto Show Lyrics is on and the song has
    // them, else on the disc if Auto Show Disc is on, else the cover (also
    // the fallback when all three are off). The lyrics part is decided in the
    // lyrics effect above once the lyrics are known.
    useEffect(() => {
        if (autoShowDisc && !(autoShowLyrics && peekLyrics(currentTrack?.id))) setShowingDisc(true);
        else setShowingDisc(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentTrack?.id, autoShowDisc, autoShowLyrics]);
    // The Player's swipe-down-to-close works from anywhere above the controls,
    // which would close it whenever the disc is dragged downward. It is turned
    // off only while a finger is on the disc itself (see DJDisc's onTouching).
    const [discHeld, setDiscHeld] = useState(false);
    const discHeldRef = useRef(false);
    const setDiscTouching = useCallback((touching) => {
        discHeldRef.current = !!touching;
        setDiscHeld(!!touching);
        navigation.setOptions({ gestureEnabled: !touching });
    }, [navigation]);
    useEffect(() => () => navigation.setOptions({ gestureEnabled: true }), [navigation]);
    useEffect(() => { if (showingLyrics && showingDisc) setShowingDisc(false); }, [showingLyrics, showingDisc]);
    const hasLyricsView = !!lyricsData;
    // The disc only exists when the DJ Disc setting is on.
    useEffect(() => { if (!djDisc) setShowingDisc(false); }, [djDisc]);
    const cycleView = () => {
        // cover -> lyrics -> disc -> cover, skipping what is unavailable.
        if (showingLyrics) { setShowingLyrics(false); if (djDisc) setShowingDisc(true); return; }
        if (showingDisc) { setShowingDisc(false); return; }
        if (hasLyricsView) { setShowingLyrics(true); return; }
        if (djDisc) setShowingDisc(true);
    };
    const nextViewLabel = showingLyrics ? (djDisc ? 'Show disc' : 'Show cover')
        : showingDisc ? 'Show cover'
        : hasLyricsView ? 'Show lyrics' : 'Show disc';
    // Protected zones for scratching: start of the song, and the end where a
    // crossfade or fade-out runs, plus a safety margin.
    // The start of a song that came in by crossfade overlaps the end of the
    // one before it for the crossfade's length, so the disc keeps out of that too.
    const scratchStartGuard = Math.max(crossfadeEnabled ? Math.max(crossfadeDuration || 0, crossfadeDurationEndOfTrack || 0) : 0, 2) + 1;
    const scratchEndGuard = Math.max(crossfadeEnabled ? Math.max(crossfadeDuration || 0, crossfadeDurationEndOfTrack || 0) : 0, 2) + 8;
    // Cover / lyrics / disc share one slot. Each has ONE opacity (no nested
    // fades, no scaling: stacked fades on the shadowed cover were what made
    // its outline flash). The outgoing view fades out first and the incoming
    // one starts a moment later, so the two never sit on screen half
    // transparent on top of each other (the old cover-peeking-through).
    const lyricsFade = useRef(new Animated.Value(showingLyrics ? 1 : 0)).current; // lyrics layer
    const coverFade = useRef(new Animated.Value(showingLyrics || showingDisc ? 0 : 1)).current; // cover layer
    const viewMounted = useRef(false);
    useEffect(() => {
        if (!viewMounted.current) { viewMounted.current = true; return; }
        const go = (v, on) => on
            ? Animated.sequence([Animated.delay(170), Animated.timing(v, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true })])
            : Animated.timing(v, { toValue: 0, duration: 190, easing: Easing.in(Easing.quad), useNativeDriver: true });
        const coverOn = !showingLyrics && !showingDisc;
        Animated.parallel([go(coverFade, coverOn), go(lyricsFade, showingLyrics), go(discFade, showingDisc)]).start(({ finished }) => {
            if (finished && !showingDisc) setDiscActive(false);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showingLyrics, showingDisc]);

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
        // A track change (skip, crossfade landing, natural advance) is a
        // jump too, same as a manual seek — see lyricsJustJumpedRef's
        // declaration.
        lyricsJustJumpedRef.current = true;
        lyricsScrollRef.current?.scrollTo({ y: 0, animated: false });
    }, [currentTrack?.id]);
    // "Lyrics should already be at the place in the song before needing to
    // move when the music player is opened" — this effect's scrollTo was
    // ALWAYS animated, including the very first positioning right after
    // showingLyrics flips true, so opening the lyrics view visibly
    // scrolled from the top into place instead of just appearing already
    // correct. Tracks whether showingLyrics was already true last render;
    // only that specific "just opened" transition snaps instantly — a
    // genuine active-line advance while already looking at the view still
    // animates normally.
    const wasShowingLyricsRef = useRef(showingLyrics);
    useEffect(() => {
        if (!showingLyrics) { wasShowingLyricsRef.current = false; return; }
        const justOpened = !wasShowingLyricsRef.current;
        // Real gap found here: this used to mark "opened" true on the very
        // first run regardless of activeLine. But activeLine starts at -1
        // (progress hasn't polled yet, duration still 0 — see its own
        // computation above) for whatever brief window that takes, so the
        // FIRST positioning this effect does is necessarily a guess (top of
        // the list, the activeLine<0 branch below). Once real progress
        // lands a moment later and activeLine becomes the actual current
        // line, wasShowingLyricsRef was already true — so THAT correction
        // (top → the real position) no longer counted as "just opened" and
        // animated instead of snapping, which is exactly "opening the
        // player visibly scrolls the lyrics into place" rather than
        // already being there. Only mark "opened" once there's a genuine
        // line to have opened on, so that first real correction still
        // counts as part of opening.
        // Either kind of jump (view just opened, or a seek/track-change
        // just happened) should snap instead of animate — only a natural
        // one-line-at-a-time advance while already sitting on the view
        // should animate. Only actually consumed (both this and
        // wasShowingLyricsRef below) once a scrollTo genuinely happens —
        // see the y===undefined bail-out below for why: the target row not
        // being measured yet is a second, separate way this could still
        // end up animating a correction that should have snapped.
        const skipAnimation = justOpened || lyricsJustJumpedRef.current;
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
            // Real gap in the fix above (the y===undefined guard's twin
            // case, missed on the first pass): activeLine is forced to -1
            // for TWO different reasons — genuinely before the song's
            // first timed line (duration>0, a real, stable state worth
            // consuming the flags for), or simply because
            // effectiveLyricsProgress.duration isn't known yet right after
            // opening (progress hasn't polled). That second case looked
            // identical to the first here, so the very first run — before
            // real position data ever arrived — was scrolling to 0 (fine,
            // that's where it already was) AND immediately marking
            // "opened" + clearing the jump flag. The NEXT run, once
            // duration/position actually loaded and activeLine resolved to
            // the real current line, then found both flags already
            // consumed and animated the correction — which is exactly
            // "starts at the top, then scrolls down by itself." Only
            // consuming the flags once duration>0 confirms this -1 is the
            // real, stable answer (not a placeholder) closes that gap.
            const isRealPosition = effectiveLyricsProgress.duration > 0;
            lyricsScrollRef.current?.scrollTo({ y: 0, animated: !skipAnimation });
            if (isRealPosition) {
                wasShowingLyricsRef.current = true;
                lyricsJustJumpedRef.current = false;
            }
            return;
        }
        if (lyricsManualScroll) return;
        const y = lyricsRowYRef.current.get(activeLine);
        // Real gap found here too: this used to bail out on an unmeasured
        // row WITHOUT the guard above — meaning by the time
        // lyricsLayoutVersion bumps (the row finally lays out) and this
        // effect re-runs, justOpened/lyricsJustJumpedRef had already been
        // consumed by THIS run even though it never actually positioned
        // anything. The real, only-successful positioning then landed on a
        // later run with skipAnimation already false — animating in
        // exactly the same way the activeLine<0 race above did. Returning
        // before consuming either flag means the eventual real positioning
        // still sees them intact.
        if (y === undefined) return;
        // Was 0.32 (a third of the way down) — with only a few short lines
        // around the active one (typical for this box's height), anchoring
        // near the top third left most of the box empty below it, since
        // there usually isn't enough surrounding lyric text to fill the
        // rest of the frame either way. The box is exactly the same size as
        // the cover art it swaps places with, so centering the active line
        // instead means the used/empty space splits evenly top and bottom —
        // matching how the cover fills that box symmetrically, which is the
        // actual ask ("symmetrical around the song cover").
        lyricsScrollRef.current?.scrollTo({ y: Math.max(0, y - (width - 56) * 0.5), animated: !skipAnimation });
        wasShowingLyricsRef.current = true;
        lyricsJustJumpedRef.current = false;
    }, [activeLine, showingLyrics, lyricsManualScroll, lyricsLayoutVersion]);

    // Re-sync only when needed: on mount, on play/pause toggling, on a track
    // switch, or if the running animation has drifted noticeably from what
    // the real progress hook reports (e.g. after a system hiccup). Anything
    // else, the animation just keeps running uninterrupted at real-time speed
    // — no restart, no stutter.
    const lastSyncedTrackIdRef = useRef(currentTrack?.id);
    const discResyncTimer = useRef(null);
    // While a finger is on the disc the song's speed is the finger's, so the
    // bar's own timer would be wrong: it follows the real position instead
    // (quick readings), and takes over again a moment after the finger lifts.
    const syncPausedUntil = useRef(0);
    useEffect(() => {
        if (!discHeld) return;
        stopAnim();
        syncPausedUntil.current = Number.MAX_SAFE_INTEGER;
        let cancelled = false;
        const songId = currentTrack?.id;
        const follow = () => AudioEngine.getProgress().then((p) => {
            if (cancelled || !(p?.duration > 0)) return;
            if (songId && p.id && p.id !== songId) return;   // a reading for the other song
            const r = Math.max(0, Math.min(1, p.position / p.duration));
            animPctValueRef.current = r;
            animPct.setValue(r);
        }).catch(() => { });
        follow();
        const id = setInterval(follow, 90);
        return () => {
            cancelled = true;
            clearInterval(id);
            // Let the scratch finish ending, then restart the bar from the exact spot.
            syncPausedUntil.current = Date.now() + 300;
            clearTimeout(discResyncTimer.current);
            discResyncTimer.current = setTimeout(() => {
                if (discHeldRef.current) return;
                AudioEngine.getProgress().then((p) => {
                    if (discHeldRef.current || !(p?.duration > 0)) return;
                    if (songId && p.id && p.id !== songId) return;   // a reading for the other song
                    syncPausedUntil.current = 0;
                    startRealTimeAnim(Math.max(0, Math.min(1, p.position / p.duration)), true);
                }).catch(() => { syncPausedUntil.current = 0; });
            }, 300);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [discHeld]);
    useEffect(() => {
        if (dragRatio !== null) return; // scrubbing owns the value right now
        if (discHeld || Date.now() < syncPausedUntil.current) return; // the disc is being scratched (or just let go)
        const trackChanged = lastSyncedTrackIdRef.current !== currentTrack?.id;
        // A reading for the other song (around a crossfade's song change) says
        // nothing about this one: leave the bar alone until a real one comes.
        if (progress.stale && !trackChanged) return;
        lastSyncedTrackIdRef.current = currentTrack?.id;
        // Same fix as MiniPlayer: always stop on pause regardless of drift,
        // since a drift-gated check skips the stop() call whenever drift
        // happens to be near-zero at the moment of pausing — which is the
        // normal case, since pausing is immediate.
        if (!isPlaying) {
            stopAnim();
            // A song change while paused (skip, restore, queue tap) must
            // start the bar fresh too. `pct` is still the OLD song's value
            // until the next poll, which left the bar parked at the old spot.
            // Parked where the bar is, unless the real position is clearly
            // somewhere else (the app was away and the song moved, e.g. after
            // a Bluetooth connection): then it goes there.
            const farOff = Math.abs(pct - animPctValueRef.current) * (progress.duration || 0) > 1;
            const startPct = trackChanged ? 0 : (farOff ? pct : animPctValueRef.current);
            animPct.setValue(startPct);
            animPctValueRef.current = startPct;
            // `pct` can be up to 500ms old at the instant of a pause (lock
            // screen, Control Center, headphones). Read the exact position
            // so the frozen bar sits where playback really stopped.
            const trackAtPause = currentTrack?.id;
            AudioEngine.getProgress().then(p => {
                if (lastSyncedTrackIdRef.current !== trackAtPause || !(p?.duration > 0)) return;
                const exact = Math.max(0, Math.min(1, p.position / p.duration));
                animPct.setValue(exact);
                animPctValueRef.current = exact;
            }).catch(() => { });
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
            console.log(`[BAR] track changed: bar reset to 0, last poll said ${(progress.position || 0).toFixed(1)}s of ${(progress.duration || 0).toFixed(1)}s`);
            startRealTimeAnim(0, true);
            // The new song may already be a couple of seconds in (a
            // crossfade flips the display halfway through). Ask for the real
            // spot right away instead of sitting at 0 until the next poll
            // and then jumping, so the bar starts where the sound is.
            const trackAtChange = currentTrack?.id;
            const idAtChange = currentTrack?.id;
            AudioEngine.getProgress().then(p => {
                if (lastSyncedTrackIdRef.current !== trackAtChange || !(p?.duration > 0)) return;
                if (idAtChange && p.id && p.id !== idAtChange) return;   // a reading for the other song
                if (p.position > p.duration || p.position > 40) return;   // not a fresh song's spot, don't trust
                startRealTimeAnim(Math.max(0, Math.min(1, p.position / p.duration)), true);
            }).catch(() => { });
            return;
        }
        // Drift is judged in SECONDS now. 2% of the song was 3-4 seconds on
        // a normal track, which is what let the bar sit visibly wrong
        // after a skip, resume or outside pause before it corrected.
        // + = the bar is ahead of the sound. Right after a start (play, song
        // change) the audio position is still settling, so a bigger gap is
        // tolerated; later a bar that is ahead is left alone until it is
        // clearly off (a backward jump is the visible kind of glitch).
        const aheadSec = (barPctNow() - pct) * (progress.duration || 0);
        const inGrace = Date.now() < barGraceUntil.current;
        const tooFarAhead = aheadSec > (inGrace ? 1.5 : 1.2);
        const tooFarBehind = -aheadSec > (inGrace ? 1.5 : 0.4);
        // (the bar's running speed already follows playbackRate: see startRealTimeAnim)
        if (!animRunRef.current || tooFarAhead || tooFarBehind) {
            if (animRunRef.current) console.log(`[BAR] resync: bar was ${aheadSec.toFixed(1)}s ahead, poll says ${(progress.position || 0).toFixed(1)}s of ${(progress.duration || 0).toFixed(1)}s`);
            startRealTimeAnim(pct, !animRunRef.current);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [progress.position, isPlaying, currentTrack?.id, playbackRate, discHeld]);

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
        return () => { stopAnim(); clearTimeout(stuckSafetyTimer.current); clearTimeout(clearDragTimer.current); clearTimeout(discResyncTimer.current); };
    }, []);

    // Both move with transforms so they can run on the native side.
    const fillX = useMemo(() => animPct.interpolate({ inputRange: [0, 1], outputRange: [-barW, 0] }), [animPct, barW]);
    const thumbX = useMemo(() => animPct.interpolate({ inputRange: [0, 1], outputRange: [0, barW] }), [animPct, barW]);
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
    // Just a quick fade between dark (off) and light (on). No press-dim, no
    // other motion. A tap within 250ms of the last one on the same button is
    // ignored, so a double tap counts once and the button never shows two
    // changes while only one registered.
    const SIDE_BTN_FADE_MS = 120;
    const SIDE_BTN_IGNORE_MS = 250;
    const shuffleAnim = useRef(new Animated.Value(shuffleOn ? 1 : 0)).current;
    const loopAnim = useRef(new Animated.Value(singleLoop ? 1 : 0)).current;
    const shuffleTargetRef = useRef(shuffleOn ? 1 : 0);
    const loopTargetRef = useRef(singleLoop ? 1 : 0);
    const animateSideBtn = (anim, targetRef, to) => {
        if (targetRef.current === to) return;
        targetRef.current = to;
        Animated.timing(anim, { toValue: to, duration: SIDE_BTN_FADE_MS, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
    };
    // Also follows changes that come from somewhere else (restoring a session).
    useEffect(() => { animateSideBtn(shuffleAnim, shuffleTargetRef, shuffleOn ? 1 : 0); }, [shuffleOn]);
    useEffect(() => { animateSideBtn(loopAnim, loopTargetRef, singleLoop ? 1 : 0); }, [singleLoop]);
    const shuffleColor = shuffleAnim.interpolate({ inputRange: [0, 1], outputRange: [base.textFaint, theme.accent] });
    const loopColor = loopAnim.interpolate({ inputRange: [0, 1], outputRange: [base.textFaint, theme.accent] });

    const lastTapRef = useRef({ shuffle: 0, loop: 0 });
    const onPressShuffle = () => {
        const now = Date.now();
        if (now - lastTapRef.current.shuffle < SIDE_BTN_IGNORE_MS) return;
        lastTapRef.current.shuffle = now;
        animateSideBtn(shuffleAnim, shuffleTargetRef, shuffleTargetRef.current ? 0 : 1);
        // The queue rebuild is heavy, so it starts once the quick fade is done.
        setTimeout(() => toggleShuffle(), SIDE_BTN_FADE_MS + 10);
    };
    const onPressLoop = () => {
        const now = Date.now();
        if (now - lastTapRef.current.loop < SIDE_BTN_IGNORE_MS) return;
        lastTapRef.current.loop = now;
        animateSideBtn(loopAnim, loopTargetRef, loopTargetRef.current ? 0 : 1);
        toggleSingleLoop();   // one cheap call: applied right at the tap
    };

    return (
        <ScreenBackground ownImage style={[s.container, { paddingTop: insets.top + 6 }]}>
            <GradientCap color={theme.accent} height={68} style={{ borderBottomLeftRadius: 16, borderBottomRightRadius: 16, opacity: 0.5 }} />

            <View style={s.topBar}>
                {playerBtns.back
                    ? <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={HIT} style={s.topBtn}>
                        <Text style={[s.topIcon, { color: theme.accent }]}>↓</Text>
                    </TouchableOpacity>
                    : <View style={s.topBtn} />}
                {playerBtns.label
                    ? <Text style={[s.topLabel, { color: theme.accent }]} numberOfLines={1}>{(queueSource && currentTrack?.id === queueSource.id ? queueSource.name : null) ?? (currentPlaylist?.name && (!currentPlaylist.songs || currentPlaylist.songs.some(x => x.id === currentTrack?.id)) ? currentPlaylist.name : null) ?? 'Now Playing'}</Text>
                    : <View style={{ flex: 1 }} />}
                <View style={{ flexDirection: 'row', gap: 6 }}>
                    {/* EQ used to be hidden here with a comment saying
                        react-native-track-player didn't support real audio
                        EQ — true when that comment was written, but the
                        engine was replaced with the custom AudioEngine
                        (which DOES support EQ) several rounds ago and this
                        was never un-hidden. */}
                    {playerBtns.sleep && <TouchableOpacity onPress={() => setShowSleepTimer(true)} hitSlop={HIT} style={s.topBtn}>
                        <MoonIcon size={19} color={(sleepTimerEndAt || sleepAtTrackEnd) ? theme.accent : base.textFaint} />
                    </TouchableOpacity>}
                    {playerBtns.speed && <TouchableOpacity onPress={() => setShowSpeed(true)} hitSlop={HIT} style={s.topBtn}>
                        <Text style={[s.eqTag, { color: Math.abs(playbackRate - 1) > 0.001 ? theme.accent : base.textFaint }]}>{formatSpeed(playbackRate)}</Text>
                    </TouchableOpacity>}
                    {playerBtns.eq && <TouchableOpacity onPress={() => setShowEQ(true)} hitSlop={HIT} style={s.topBtn}>
                        <Text style={[s.eqTag, { color: theme.accent }]}>EQ</Text>
                    </TouchableOpacity>}
                    {playerBtns.queue && <TouchableOpacity onPress={() => setShowQueue(true)} hitSlop={HIT} style={s.topBtn}>
                        <MenuBarsIcon size={20} color={theme.accent} />
                    </TouchableOpacity>}
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
                        <Animated.View style={[StyleSheet.absoluteFill, { opacity: coverFade }]} pointerEvents={showingDisc || showingLyrics ? 'none' : 'auto'}>
                        <View style={{ flex: 1 }}>
                        {showPlayerCover && (
                            // The whole box (background/shadow/rounded corners) now
                            // fades with lyricsFade too, not just the artwork inside
                            // it — previously only the inner content faded, so the
                            // box's own dark background + shadow stayed visible as a
                            // flat square sitting behind the lyrics text. Fully
                            // transparent (and non-interactive) once lyrics are showing.
                            //
                            // New "Cover Shadow" setting: s.art itself has
                            // overflow:'hidden' (needed to clip the artwork/rounded
                            // corners), which also clips any shadow applied directly
                            // to it — a shadow property sitting right there in s.art's
                            // own style was actually dead/invisible for that reason.
                            // When the setting's on, wrap in a second Animated.View
                            // that carries ONLY the shadow (no overflow:hidden) at the
                            // same squircle radius as the cover itself, so it works
                            // identically for rounded or square cover_shape and simply
                            // isn't rendered at all — not just invisible, actually
                            // absent — whenever showPlayerCover is off, same as the
                            // cover art it surrounds.
                            // Real bug found here: this override always set the
                            // wrapper's shadow to the theme's ACCENT color, so
                            // "shadow" was actually a colored glow (purple, etc.)
                            // instead of a real dark drop shadow — coverShadowWrap's
                            // own base style already has the correct shadowColor
                            // ('#000'), same idea as the lyrics text using a dark
                            // shadow for legibility, not an accent-colored one.
                            <Animated.View style={coverShadow ? [s.coverShadowWrap, { borderRadius: squircle(width - 56, coverShape) }, ] : null}>
                                {/* Card-style outline, like the playlist cards: a band of card color
                                    behind the cover, same thickness all the way round. */}
                                {playerOutline && (
                                    <View pointerEvents="none" style={[{ position: 'absolute', top: -3, left: -3, right: -3, bottom: -3, backgroundColor: base.surface, borderRadius: cardRadius(width - 56, 3, coverShape) }]} />
                                )}
                                <Animated.View
                                    style={[s.art, { backgroundColor: base.surface, shadowColor: theme.accent, borderRadius: squircle(width - 56, coverShape) }, ]}
                                    pointerEvents={showingLyrics ? 'none' : 'auto'}
                                >
                                    {artwork
                                        ? <Image source={{ uri: artwork }} style={s.artImg} resizeMode="cover" />
                                        : null
                                    }
                                </Animated.View>
                            </Animated.View>
                        )}
                        </View>
                        </Animated.View>
                        <Animated.View style={[StyleSheet.absoluteFill, { opacity: discFade }]} pointerEvents={showingDisc ? 'auto' : 'none'}>
                            {djDisc && (
                                <DJDisc
                                    size={width - 56}
                                    artwork={artwork}
                                    accent={theme.accent}
                                    shadow={coverShadow}
                                    outline={playerOutline}
                                    outlineColor={base.surface}
                                    spinDegPerSec={discRpmValue * 6 * (playbackRate || 1)}
                                    scratchDegPerSec={discRpmValue * 6}
                                    discType={djDiscType}
                                    placeholderColor={base.surface}
                                    assist={djDiscAssist}
                                    spinOn={djDiscSpin}
                                    touchOn={djDiscTouch}
                                    isPlaying={isPlaying}
                                    visible={showingDisc}
                                    trackKey={currentTrack?._qid ?? currentTrack?.id}
                                    active={discActive}
                                    position={progress.position}
                                    duration={progress.duration}
                                    endGuard={scratchEndGuard}
                                    startGuard={scratchStartGuard}
                                    onTouching={setDiscTouching}
                                />
                            )}
                        </Animated.View>
                        {lyricsData && (
                            <Animated.View
                                // Real bug found here: top/bottom -60 made this
                                // taller than (and offset 60px above) the cover art
                                // box it's meant to replace visually — the cover is a
                                // plain (width-56) square in normal flow, this was
                                // absolutely positioned to start 60px above THAT and
                                // extend 60px past its bottom. That's exactly "lyrics
                                // aren't where they're supposed to be, shouldn't be
                                // further up" and "should be the same size as the
                                // cover" — matching the art's own footprint exactly
                                // (top: 0, height: width-56) instead of guessing at a
                                // taller offset box fixes both at once.
                                style={[{ position: 'absolute', top: 0, height: width - 56, left: 0, right: 0 }, { opacity: lyricsFade, overflow: 'hidden' }]}
                                pointerEvents={showingLyrics ? 'auto' : 'none'}
                            >
                                <Animated.ScrollView
                                    ref={lyricsScrollRef}
                                    style={{ flex: 1 }}
                                    contentContainerStyle={s.lyricsContent}
                                    showsVerticalScrollIndicator={false}
                                    scrollEnabled={showingLyrics && !lyricsScrollLocked}
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
                                    {/* scrollEnabled above now also respects the
                                        "Unscrollable Lyrics" setting — when it's on,
                                        this stays non-scrollable so the same swipe
                                        that closes the player elsewhere also works
                                        over the lyrics panel instead of scrolling
                                        through the text. Off by default: the
                                        swipe-to-dismiss gesture is limited (via
                                        gestureResponseDistance, set from the controls
                                        row below) to starting above the control row,
                                        and a RNGH-composed ScrollView generally yields
                                        to a surrounding pan gesture at its own scroll
                                        bounds anyway. */}
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
                                                // "Doesn't pop enough when it's their turn" — only
                                                // the active line gets heavier/larger here (idle
                                                // lines keep s.lyricLine's normal 700/24 untouched,
                                                // so nothing about the resting state changes). iOS's
                                                // system font renders 700 and 900 as genuinely
                                                // distinct weights (not synthesized), so this reads
                                                // as a real emphasis jump rather than a same-weight
                                                // color change.
                                                style={[s.lyricLine, { textShadowColor: base.bg, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 4 }, { color: i === activeLine ? lyricActiveColor : lyricIdleColor, opacity: opacityStyle }, i === activeLine && s.lyricLineActive]}
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
                        {(hasLyricsView || djDisc) && (
                            <TouchableOpacity onPress={cycleView} style={s.lyricsToggleBtn}>
                                <Text style={[s.lyricsToggleText, { color: theme.accent }]}>
                                    {nextViewLabel}
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
                                    onLayout={(e) => { const w = e.nativeEvent.layout.width; if (w > 0 && Math.abs(w - barW) > 0.5) setBarW(w); measureProgress(); }}
                                >
                                    <View style={[s.progressTrack, { backgroundColor: base.border, overflow: 'hidden' }]}>
                                        <Animated.View style={[s.progressFill, { width: barW, backgroundColor: theme.accent, transform: [{ translateX: fillX }] }]} />
                                    </View>
                                    <Animated.View style={[s.progressThumb, { left: 0, marginLeft: -10, backgroundColor: theme.accent, transform: [{ translateX: thumbX }] }]} />
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
                    <TouchableOpacity onPress={onPressShuffle} style={s.sideBtn} hitSlop={HIT} activeOpacity={1}>
                        <ShuffleIcon size={35} color={shuffleColor} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => skipWithRamp('prev')} style={s.skipBtn} hitSlop={HIT}>
                        <SkipPrevIcon size={38} color={skipIconColor} />
                    </TouchableOpacity>
                    <TouchableOpacity
                        onPress={() => isPlaying ? pauseWithRamp() : playWithRamp()}
                        style={[s.playBtn, { backgroundColor: theme.accent, shadowColor: theme.accent }]}
                    >
                        {isPlaying ? <PauseIcon size={33} color={theme.onAccent} /> : <PlayIcon size={33} color={theme.onAccent} />}
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => skipWithRamp('next')} style={s.skipBtn} hitSlop={HIT}>
                        <SkipNextIcon size={38} color={skipIconColor} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={onPressLoop} style={s.sideBtn} hitSlop={HIT} activeOpacity={1}>
                        <LoopIcon size={35} color={loopColor} single={singleLoop} />
                    </TouchableOpacity>
                </View>
            </View>

            <EQModal visible={showEQ} onClose={() => setShowEQ(false)} playlistPath={currentPlaylist?.path} />
            <QueueModal visible={showQueue} onClose={() => setShowQueue(false)} />
            <SleepTimerSheet visible={showSleepTimer} onClose={() => setShowSleepTimer(false)} />
            <PlaybackSpeedSheet visible={showSpeed} onClose={() => setShowSpeed(false)} />
        </ScreenBackground>
    );
}

const HIT = { top: 20, bottom: 20, left: 20, right: 20 };

const s = StyleSheet.create({
    container: { flex: 1 },
    // Was 12 — PlaylistDetailScreen's own topBar (the same row: back/down
    // arrow, title, shuffle, EQ, hamburger) uses 8. Same row, two different
    // edge insets depending on which screen you're looking at it from —
    // the back arrow and hamburger/EQ icons visibly shift a few pixels
    // left/right crossing between the two, which is what "buttons on the
    // music player vs outside it are not aligned" was pointing at.
    topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, marginBottom: 4 },
    // Matches PlaylistDetailScreen/AllSongsScreen's topBtn — was 44 here,
    // 40 there, 36 on All Songs: three different tap-target sizes for the
    // same EQ/queue controls, which is part of what made them look
    // misaligned crossing between screens even after the paddingHorizontal
    // fix below (see topBar comment).
    topBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
    eqTag: { fontSize: 14, fontWeight: '700' },
    topIcon: { fontSize: 26 },
    topLabel: { fontSize: 15, fontWeight: '500', flex: 1, textAlign: 'center' },
    middle: { flex: 1, justifyContent: 'space-evenly' },
    artWrap: { alignItems: 'center' },
    art: { width: width - 56, height: width - 56, backgroundColor: '#0f0f0f', justifyContent: 'center', alignItems: 'center', overflow: 'hidden', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8 },
    // shadowOffset/Opacity/Radius above on `art` itself are dead weight —
    // `overflow:'hidden'` on that same view clips its own shadow on iOS, so
    // it was never actually visible. This is the real, visible one, one
    // step further out where nothing clips it. Deliberately a bit more
    // pronounced than art's old (invisible) values, since a shadow subtle
    // enough to match those wouldn't have been worth adding a setting for.
    // Was shadowRadius:16/offset:10/opacity:0.35 — a much heavier shadow
    // than anything else on this screen. Scaled down to roughly match the
    // lyrics' own textShadowRadius:4 glow instead of standing out as its
    // own much bigger effect.
    coverShadowWrap: { width: width - 56, height: width - 56, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.38, shadowRadius: 3.5, elevation: 4 },
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
    // Was 700 base / 800 active — a real weight change between the two,
    // which shifts glyph widths enough to reflow line-wrapping right as a
    // line becomes active (Eric: "the boldness makes the lyrics have a
    // different layout because of like wrapping"). Both now render at the
    // same 800 weight always; active vs inactive is still clearly
    // distinguished by color/opacity alone (see the color/opacity props
    // where this style gets applied), just without the reflow.
    lyricLine: { fontSize: 24, lineHeight: 34, fontWeight: '800', textAlign: 'center', marginVertical: 7 },
    // Two fixes here per direct feedback:
    // 1. "too bolded, just a normal bold ideally, noticeable but not over
    //    the top" — was 900/26 (bigger jump, bigger size too). Dialed back
    //    to 800, same 24 size as idle lines.
    // 2. "bolding changes line wrap, words wrap differently than they were
    //    supposed to" — a heavier weight has wider glyphs, so switching a
    //    line's weight can genuinely shift where it wraps. Dropping the
    //    fontSize bump removes HALF of what was changing width (size and
    //    weight were compounding); keeping some weight difference from
    //    idle's 700 still risks a SMALLER version of the same reflow —
    //    700→800 is a much smaller jump than 700→900 was, but if lines
    //    still visibly reflow, the next step would be dropping the weight
    //    difference entirely and using color/glow alone for emphasis.
    lyricLineActive: { fontWeight: '800' },
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
    sideBtn: { width: 62, height: 62, alignItems: 'center', justifyContent: 'center' },
    skipBtn: { width: 70, height: 70, alignItems: 'center', justifyContent: 'center' },
    playBtn: { width: 84, height: 84, borderRadius: 42, justifyContent: 'center', alignItems: 'center', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 8 },
});
