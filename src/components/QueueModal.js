import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, Image, FlatList, StyleSheet, Animated, Easing, PanResponder } from 'react-native';
import AudioEngine, { Event } from '../native/AudioEngine';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { squircle } from '../utils/squircle';
import { COVER_SHADOW } from '../utils/shadow';
import { pillPad, PILL_COVER, addedClearance } from '../utils/layout';
import SwipeableRow from './SwipeableRow';
import BottomSheet from './BottomSheet';
import { useListArt } from '../hooks/useListArt';
import { listArtUri } from '../utils/embeddedArt';
import { perf } from '../utils/perf';
import { usePreferences } from '../context/PreferencesContext';
import { formatArtists } from '../utils/artists';
import { getPlayCounts } from '../utils/storage';

// Fixed estimate of a row's rendered height (thumb + padding + margins) —
// used instead of measuring each row via onLayout, which would need an
// extra render pass before the animation could even start (and risks a
// one-frame flash at full size while waiting on that measurement). Queue
// rows are a consistent height regardless of content (thumb is fixed size,
// title/artist are single-line truncated), so a constant is close enough
// that the couple of px of slop is not visible.
const ROW_HEIGHT = 68;   // pill height (64) + 2 + 2 margin
// Rows built when the sheet opens (about a screenful and a half), then more
// shortly after the open animation, then more as the list is scrolled.
const INITIAL_ROWS = 16;
// Same timing as moving playlists: hold half a second to pick a row up (a
// tenth of a second once the queue is already being edited).
const LIFT_MS = 500;
const EDIT_LIFT_MS = 120;
// Which list cell is being dragged, so its cell can be drawn above the rest,
// and where every cell sits (measured), so a drag can find the slot under the
// finger even after the list has scrolled.
let draggedListIndex = -1;
const cellLayouts = {};
function Cell({ children, style, index, onLayout, ...props }) {
    return (
        <View
            {...props}
            onLayout={(e) => { cellLayouts[index] = e.nativeEvent.layout; if (onLayout) onLayout(e); }}
            style={[style, { zIndex: index === draggedListIndex ? 50 : 0 }]}
        >
            {children}
        </View>
    );
}
const EDGE = 64;          // auto-scroll zone at the top and bottom of the list
const MAX_SCROLL_PX_S = 330;   // px per second at the very edge (eases in from 0 at the zone's inner border)
const DRAG_SLOP = 6;
// Rows built shortly after the open animation, then more as the list is scrolled.
const MORE_ROWS = 80;

// Grows a newly-added row in from nothing instead of it just abruptly
// appearing in the list (same idea as Spotify's queue-add animation) — both
// its height (so surrounding rows make room for it smoothly instead of
// space just appearing) and its own opacity/scale animate together.
// Existing rows render at full size immediately — only ones QueueModal
// marks as newly added (via `isNew`) animate.
function GrowInRow({ isNew, children }) {
    const opacityScale = useRef(new Animated.Value(isNew ? 0 : 1)).current;
    // Height can't run on the native driver (it's a layout property, not
    // transform/opacity) — so it always animates on the JS thread. This
    // used to run opacityScale on the NATIVE driver instead, since in
    // isolation that's smoother. But the two are supposed to move together,
    // and under real JS-thread load (a queue add/remove firing state
    // updates, list re-renders, and art lookups all at once — exactly when
    // this animation is running) the native-driven half kept finishing on
    // schedule while the JS-driven height lagged behind, visibly pulling
    // apart: content already faded/scaled away, but the space it sat in
    // hadn't caught up yet, reading as a bare gap sitting there for a beat.
    // Keeping both on the JS driver means they're subject to the exact same
    // load and can never visibly desync from each other — worst case the
    // whole animation is a little less buttery under heavy load, but it
    // never shows that gap.
    const heightAnim = useRef(new Animated.Value(isNew ? 0 : 1)).current;
    useEffect(() => {
        if (!isNew) return;
        Animated.parallel([
            Animated.spring(opacityScale, { toValue: 1, useNativeDriver: false, friction: 8, tension: 60 }),
            Animated.timing(heightAnim, { toValue: 1, duration: 220, useNativeDriver: false }),
        ]).start();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    if (!isNew) return <View>{children}</View>;
    return (
        <Animated.View style={{ height: heightAnim.interpolate({ inputRange: [0, 1], outputRange: [0, ROW_HEIGHT] }), overflow: 'hidden' }}>
            <Animated.View style={{ opacity: opacityScale, transform: [{ scaleY: opacityScale }] }}>
                {children}
            </Animated.View>
        </Animated.View>
    );
}

// The "Priority" and "Up Next" pills' own fade — opacity only, no height
// animation (unlike GrowInRow above, which hardcodes ROW_HEIGHT and would
// grow the pill to the wrong height since it's much shorter than a row).
// Driven by the exact same `isNew` flag as the pill's own first row,
// passed in from listData below rather than computed on its own timer —
// see the big comment above where pills used to live for why an
// independent timer was the actual bug last time this was tried: the pill
// used to animate in ~220ms after its rows on its own schedule, so a
// freshly-added priority row could sit there for that whole window with no
// "Priority" label above it yet, reading as if it landed under "Now
// Playing" instead. Sharing the identical flag makes that desync
// structurally impossible instead of just less likely — they can only
// ever start in the same render.
function FadePill({ isNew, children }) {
    const opacity = useRef(new Animated.Value(isNew ? 0 : 1)).current;
    useEffect(() => {
        if (!isNew) return;
        Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: false }).start();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    if (!isNew) return <>{children}</>;
    return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

// Mirrors GrowInRow — shrinks a row's height AND content out before it's
// actually removed from the list, instead of it just vanishing the instant
// the data updates (which is what "the space doesn't close naturally" was
// describing — the content faded/scaled away already, but the space it sat
// in didn't shrink until the row was actually removed, so it just snapped
// shut at the end). The row stays in `rows` (and keeps its layout slot) for
// the duration of this animation and is only actually removed once it's
// finished.
const REMOVE_COLLAPSE_MS = 260;
const REMOVE_ANIM_MS = REMOVE_COLLAPSE_MS + 20;
function ShrinkOutRow({ removing, children }) {
    const t = useRef(new Animated.Value(1)).current;
    useEffect(() => {
        if (!removing) return;
        // The gap closes WHILE the row slides off to the left, and the row
        // itself (its outline included) squishes flat as it goes, so the
        // rows below glide up with it.
        Animated.timing(t, { toValue: 0, duration: REMOVE_COLLAPSE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [removing]);
    // The same two views are rendered whether or not the row is being
    // removed (only their styles change). Swapping to a different wrapper
    // when removal began used to remount the whole swipeable row, which
    // threw away its slide-off and made the row jump back mid-removal.
    // The inner view keeps the full row height and is squashed with scaleY
    // (moved up so it stays centered in the shrinking outer box), instead of
    // the row being cut off by the shrinking box.
    return (
        <Animated.View style={removing ? { height: t.interpolate({ inputRange: [0, 1], outputRange: [0, ROW_HEIGHT] }), overflow: 'hidden' } : null}>
            <Animated.View style={removing ? {
                height: ROW_HEIGHT,
                opacity: t.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0.85, 1] }),
                transform: [
                    { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [-ROW_HEIGHT / 2, 0] }) },
                    { scaleY: t },
                ],
            } : null}>{children}</Animated.View>
        </Animated.View>
    );
}

// A "Priority" / "Up Next" label (or the line between them) that closes up
// smoothly when the last row under it is being removed: the box shrinks to
// nothing while its content shrinks and fades, in step with the row's own
// removal, instead of vanishing at the end.
function CollapseBlock({ collapsing, growing, estH = 0, children }) {
    // `growing`: the block is new (the first row of a section was just added).
    // It opens up the same way it closes: the box grows from nothing while its
    // content grows and fades in, instead of popping in.
    const t = useRef(new Animated.Value(growing ? 0 : 1)).current;
    const natural = useRef(estH);   // measured height while not collapsing (estimate until then)
    const [grown, setGrown] = useState(!growing);
    useEffect(() => {
        if (!growing) return;
        Animated.timing(t, { toValue: 1, duration: REMOVE_COLLAPSE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start(() => setGrown(true));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => {
        if (!collapsing) return;
        Animated.timing(t, { toValue: 0, duration: REMOVE_COLLAPSE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [collapsing]);
    const h = natural.current;
    const animating = h > 0 && (collapsing || !grown);
    return (
        <Animated.View style={animating ? { height: t.interpolate({ inputRange: [0, 1], outputRange: [0, h] }), overflow: 'hidden' } : null}>
            <Animated.View
                onLayout={(e) => { if (!collapsing && grown) natural.current = e.nativeEvent.layout.height; }}
                style={animating ? {
                    opacity: t,
                    transform: [
                        { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [-h / 2, 0] }) },
                        { scale: t },
                    ],
                    transformOrigin: 'left center',
                } : null}
            >{children}</Animated.View>
        </Animated.View>
    );
}

// The "Priority" and "Up Next" pills get a fade-in (FadePill above) tied to
// the exact same isNew flag as their own first row — see FadePill's comment
// for why an independent timer was the actual bug in an earlier attempt at
// animating these. Removal is still a plain unrender, not a fade-out: doing
// that properly would mean tracking a lingering "ghost pill" the same way
// removingKeys does for rows (a pill whose rows just emptied out has no row
// of its own left to key its fade-out off of), which is a bigger, riskier
// change than this pass — the appearing half was the specific complaint.

// One queue row. Memoized: a refresh builds brand new row objects even when
// nothing changed, and art / play-count lookups land one at a time, so
// without this every visible row re-rendered on each of those.
const QueueRow = React.memo(function QueueRow({ row, isNew, removing, art, playCount, showSongCovers, showPlayCount, coverShape, artistSeparator, artistDisplayJoin, theme, base, actions, editing, dragging, shift, live, dragY }) {
    const { songPillShadow } = usePreferences();
    const { song, realIndex, isPriority, stableKey } = row;
    // Rows between the dragged one and its target slide out of the way.
    const shiftAnim = useRef(new Animated.Value(0)).current;
    useEffect(() => {
        const to = shift;
        if (live) Animated.timing(shiftAnim, { toValue: to, duration: 150, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
        else shiftAnim.setValue(0);
    }, [shift, live, shiftAnim]);
    return (
        <GrowInRow isNew={isNew}>
            <ShrinkOutRow removing={removing}>
                <Animated.View style={[{ transform: [{ translateY: dragging ? dragY : shiftAnim }, { scale: dragging ? 1.03 : 1 }] }, dragging && s.dragged]}>
                <SwipeableRow
                    onSwipeLeft={editing ? undefined : () => actions.remove(realIndex, stableKey, song._qid)}
                    // Up Next row: promote it to Priority (a copy plays sooner).
                    // Priority row: add another copy of it to the end of Priority.
                    onSwipeRight={editing ? undefined : () => (isPriority ? actions.addCopy(song) : actions.promote(realIndex, song._qid))}
                    rightColor={theme.accent}
                    leftColor="#dc2626"
                >
                    <TouchableOpacity style={[s.qRow, { backgroundColor: base.border }, pillPad(showSongCovers), songPillShadow && COVER_SHADOW]} onPress={() => actions.jump(realIndex)} onPressIn={(e) => actions.pressIn(stableKey, e && e.nativeEvent ? e.nativeEvent.identifier : null)} onPressOut={() => actions.pressOut()} activeOpacity={0.7}>
                        {showSongCovers && (
                            <View style={[s.thumb, { backgroundColor: base.surface, borderRadius: squircle(PILL_COVER, coverShape) }]}>
                                {art
                                    ? <Image source={{ uri: art }} style={s.thumbImg} resizeMode="cover" />
                                    : null
                                }
                            </View>
                        )}
                        <View style={{ flex: 1, marginRight: addedClearance(showPlayCount ? playCount : 0) }}>
                            <Text style={[s.qTitle, { color: base.text }]} numberOfLines={1}>{song.ourTitle ?? song.title}</Text>
                            <Text style={[s.qArtist, { color: base.textFaint }]} numberOfLines={1}>{formatArtists(song.ourArtist ?? song.artist, artistSeparator, artistDisplayJoin)}</Text>
                        </View>
                        {showPlayCount && playCount > 0 && (
                            <Text style={[s.qPlayCount, { color: base.textFaint }]}>{playCount}×</Text>
                        )}
                    </TouchableOpacity>
                </SwipeableRow>
                </Animated.View>
            </ShrinkOutRow>
        </GrowInRow>
    );
}, (prev, next) => {
    for (const k in next) {
        if (k === 'row') continue;
        if (prev[k] !== next[k]) return false;
    }
    const a = prev.row, b = next.row;
    return a.stableKey === b.stableKey && a.realIndex === b.realIndex && a.isPriority === b.isPriority
        && a.song.id === b.song.id && a.song.title === b.song.title && a.song.artist === b.song.artist
        && a.song.ourTitle === b.song.ourTitle && a.song.ourArtist === b.song.ourArtist;
});

export default function QueueModal({ visible, onClose }) {
    const { theme, base } = useTheme();
    const { priorityQueue, jumpToQueueIndex, removeFromQueue, promoteToQueue, moveInQueue, currentTrack, addToQueue } = usePlayback();
    const { showSongCovers, showPlayCount, artistSeparator, coverShape, artistDisplayJoin, songPillShadow } = usePreferences();
    // allRows is the whole upcoming queue; only the first `visibleCount` are
    // ever turned into list items, cover lookups and row components. A queue
    // built from All Songs can be thousands long, and building all of it on
    // open (and again on every song change) was a large part of the choppy
    // opening and scrolling. More rows are added as the list is scrolled.
    const [allRows, setRows] = useState([]); // [{ realIndex, song, isPriority, stableKey }]
    const [visibleCount, setVisibleCount] = useState(INITIAL_ROWS);
    const rows = useMemo(
        () => (allRows.length > visibleCount ? allRows.slice(0, visibleCount) : allRows),
        [allRows, visibleCount]
    );
    const [newKeys, setNewKeys] = useState(() => new Set());
    const [removingKeys, setRemovingKeys] = useState(() => new Set());
    const [playCounts, setPlayCounts] = useState({});
    // Distinguishes "still working through the retry loop above" from
    // "genuinely nothing queued" — without this, both looked identical
    // (rows.length === 0) and the sheet showed "Nothing up next" during
    // that first loading window too, which read as the queue being empty
    // rather than just not loaded yet.
    const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
    // Keeping the visible rows anchored when content is added above them is
    // only wanted once the list is scrolled down. At the very top it made the
    // list jump to the newly added row instead of staying at the top.
    const [anchorOn, setAnchorOn] = useState(false);
    const anchorRef = useRef(false);

    // remove()/promote() already call refresh() explicitly, right after
    // their own native change, with the correct priorityOverride for that
    // exact moment. refresh() closing over `priorityQueue` (via the
    // dependency array below) meant its identity changed on every priority
    // update too — including the ones remove()/promote() themselves just
    // caused — which re-fired the "refresh on open" effect further down a
    // SECOND, uncoordinated time with no override, racing the deliberate
    // call. That race is what produced the empty-gap flash when removing
    // the last Priority row: one refresh reading the native queue before
    // the removal had landed, the other after, each briefly rendering a
    // different (both individually reasonable, but inconsistent) view.
    // Reading priorityQueue through a ref instead keeps refresh's identity
    // stable so only the explicit calls trigger it.
    const priorityQueueRef = useRef(priorityQueue);
    useEffect(() => { priorityQueueRef.current = priorityQueue; }, [priorityQueue]);

    const refresh = useCallback(async (priorityOverride, justAddedRealIndex) => {
        try {
            // Tapping a song to play resets TrackPlayer's queue entirely and
            // re-adds the new window right after — there's a brief real gap
            // between those two steps where the native queue is legitimately
            // empty and has no current track. If this runs during exactly
            // that gap (e.g. opening the queue sheet right after tapping a
            // song), it used to take that as "nothing's playing" and show a
            // permanently blank sheet, since nothing else ever re-triggers a
            // refresh on its own. Retrying briefly instead of taking the
            // first empty read as final rides out that gap — it's normally
            // gone well within a couple hundred ms.
            let queue, currentIndex;
            for (let attempt = 0; attempt < 5; attempt++) {
                // These were two sequential awaits (getQueue then
                // getCurrentTrack) — each a separate bridge round trip.
                // Running them together halves the round trips on every
                // attempt, which is most of what "queue takes a second to
                // load" was: the sheet showing genuinely blank while this
                // loop worked through its retries one slow step at a time.
                [queue, currentIndex] = await Promise.all([AudioEngine.getQueue(), AudioEngine.getCurrentTrack()]);
                if (currentIndex !== null && currentIndex !== undefined && queue.length > 0) break;
                if (attempt < 4) await new Promise(r => setTimeout(r, 120));
            }
            if (currentIndex === null || currentIndex === undefined) { setRows([]); return; }
            const activePriority = priorityOverride ?? priorityQueueRef.current;
            const priorityEnd = currentIndex + 1 + activePriority.length;
            let justAddedKey = null;
            const upcoming = queue.slice(currentIndex + 1).map((song, i) => {
                const realIndex = currentIndex + 1 + i;
                // Every track gets a unique _qid stamped on the moment it's
                // added to the native queue (see stampQid in
                // PlaybackContext) — using that directly as the row key
                // instead of computing one from song id + occurrence means
                // a row's identity is tied to the actual queue slot it is,
                // permanently, regardless of what gets added or removed
                // elsewhere. Occurrence numbers (which copy of this song is
                // this) shifted whenever a duplicate got added/removed
                // earlier in the list, which was making an UNRELATED
                // existing row look like it had moved or been replaced.
                const stableKey = song._qid ?? `${song.id}#${realIndex}`;
                if (realIndex === justAddedRealIndex) justAddedKey = stableKey;
                return {
                    realIndex,
                    song,
                    // Purely positional — a slot is "priority" based on where
                    // it sits, not by matching song id against a list. That's
                    // what the insertAt math elsewhere already assumes, and
                    // it naturally handles multiple genuine copies of the
                    // same song (each a distinct slot) correctly, unlike
                    // id-matching which can only ever mark one of them.
                    isPriority: realIndex < priorityEnd,
                    stableKey,
                };
            });
            setNewKeys(justAddedKey ? new Set([justAddedKey]) : new Set());
            setRows(upcoming);
        } catch { setRows([]); } finally { setHasLoadedOnce(true); }
    }, []);

    useEffect(() => {
        // Was deferred until the sheet's open animation settled, to stop
        // content-loading from competing with that animation. That traded
        // one complaint for a worse one — the sheet opening instantly but
        // sitting empty for a beat reads as "broken" in a way slow-but-
        // together doesn't. Loading immediately again; the retry-on-open
        // logic below still means a slow first read doesn't show as
        // permanently empty.
        // Deliberately only depends on `visible` now — see the note above
        // refresh's definition for why depending on refresh's identity
        // (which used to shift with every priorityQueue change) was wrong.
        if (!visible) return;
        setHasLoadedOnce(false);
        setVisibleCount(INITIAL_ROWS);
        refresh();
        // The rest of the first window is added once the open animation has
        // finished, so building it never competes with that animation.
        const t = setTimeout(() => setVisibleCount(c => Math.max(c, MORE_ROWS)), 450);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    // Keeps retrying on its own while the sheet is open and showing nothing,
    // instead of only trying once at open time. The retry-with-backoff at
    // open covers the ordinary "queue reset mid-flight" gap, but if
    // something is still wrong past that (or state legitimately hasn't
    // settled yet for some other reason), there was nothing to ever try
    // again — the sheet just sat there empty until closed and reopened.
    // Capped at 10 tries (~10s) so this doesn't poll forever in the one
    // case where "nothing" is actually correct (nothing has ever played
    // yet this session).
    useEffect(() => {
        if (!visible || rows.length > 0) return;
        let cancelled = false;
        let tries = 0;
        const id = setInterval(() => {
            if (cancelled) return;
            tries++;
            if (tries > 10) { clearInterval(id); return; }
            refresh();
        }, 1000);
        return () => { cancelled = true; clearInterval(id); };
    }, [visible, rows.length, refresh]);

    // The sheet previously only ever refreshed when it opened, or right
    // after a remove/promote/jump it triggered itself — nothing refreshed
    // it as playback naturally advanced from one song to the next while it
    // stayed open. Songs kept playing correctly (this doesn't touch
    // playback), the list just silently fell behind what was actually
    // playing until you closed and reopened the sheet.
    useEffect(() => {
        if (!visible) return;
        // Matches PlaybackService.js's own listener — this project targets
        // the PlaybackTrackChanged event (RNTP's older API, `{ nextTrack }`),
        // not the newer PlaybackActiveTrackChanged one, so staying
        // consistent with what's already proven to fire elsewhere in this
        // codebase rather than assuming the newer event is also available.
        const sub = AudioEngine.addEventListener(Event.PlaybackTrackChanged, () => refresh());
        return () => sub.remove();
    }, [visible, refresh]);

    const priorityRows = rows.filter(r => r.isPriority);
    const upNextRows = rows.filter(r => !r.isPriority);

    // useListArt restarts its whole effect whenever the array reference it's
    // given changes — `rows.map(r => r.song)` built a brand new array on
    // every render, including renders caused by useListArt's OWN state
    // updates. That's a feedback loop: effect runs -> resolves cached art ->
    // updates state -> re-render -> new array -> effect runs again -> ...
    // with nothing to stop it while the sheet stayed open. It used to be
    // throttled enough (everything gated behind an interaction+300ms delay)
    // that this was only mildly wasteful; making cache hits apply instantly
    // removed that throttle and let it spin as fast as it could, which is
    // almost certainly what was starving the dismiss gesture of JS-thread
    // time.
    //
    // Memoizing on raw `rows` identity wasn't actually enough on its own
    // once the sheet started refreshing itself live (see the
    // PlaybackTrackChanged listener above, and the Now Playing swipe
    // handler below) — `rows` is a brand new array from every refresh()
    // call, EVEN when the actual songs and order in it haven't changed
    // (e.g. a refresh that only affects priority, or one that's just a
    // no-op re-sync), so memoizing on it still restarted the extraction
    // phase constantly, which is what "covers take forever / stay black"
    // actually was — genuinely slow real-file extractions kept getting
    // cancelled and restarted from scratch before they ever finished.
    // Comparing by an actual VALUE signature (the song ids in order) instead
    // of by array identity means a refresh that doesn't change what's
    // actually being shown keeps the same songsForArt reference, and
    // useListArt's effect only restarts when the visible song list
    // genuinely changed.
    const songsForArtRef = useRef({ sig: '', arr: [] });
    const songsForArtSig = rows.map(r => r.song.id).join('\u0001');
    if (songsForArtRef.current.sig !== songsForArtSig) {
        songsForArtRef.current = { sig: songsForArtSig, arr: rows.map(r => r.song) };
    }
    const songsForArt = songsForArtRef.current.arr;
    const artMap = useListArt(songsForArt, showSongCovers);

    useEffect(() => {
        // songsForArt only ever holds the UPCOMING rows (priority + up
        // next) — currentTrack was never included, so playCounts[current
        // Track.id] was always undefined and the Now Playing row's count
        // could never show, no matter the setting or the song's actual
        // count. Fetching currentTrack alongside it here fixes that; the
        // early-return also used to bail whenever songsForArt was empty
        // (a queue with nothing but the currently-playing song), which
        // would've skipped fetching currentTrack's count too even after
        // adding it to the list below.
        if (!showPlayCount || (!songsForArt.length && !currentTrack)) return;
        const toFetch = currentTrack ? [currentTrack, ...songsForArt] : songsForArt;
        getPlayCounts(toFetch).then(setPlayCounts);
    }, [songsForArt, showPlayCount, currentTrack]);

    // ---- Moving rows (hold to pick up, drag, let go) ---------------------
    // Works like moving playlists: same hold times, the list scrolls by
    // itself when the finger nears the top or bottom edge, and the held row
    // follows the finger while the list scrolls under it.
    const [editMode, setEditMode] = useState(false);
    const [dragKey, setDragKey] = useState(null);     // the row being held
    const [dragTo, setDragTo] = useState(null);       // the slot it is over (index in `rows`)
    const editRef = useRef(false);
    const holdTimer = useRef(null);
    const armedKey = useRef(null);
    const suppressPress = useRef(false);
    const dragging = useRef(false);
    const startIdx = useRef(0);
    const toIdx = useRef(0);
    const dragY = useRef(new Animated.Value(0)).current;
    const rowsRef = useRef(rows);
    rowsRef.current = rows;
    const totalRowsRef = useRef(0);
    totalRowsRef.current = allRows.length;
    const visibleRef = useRef(0);
    visibleRef.current = visibleCount;
    const listRef = useRef(null);
    const boxRef = useRef(null);
    const scrollY = useRef(0);
    const viewH = useRef(0);
    const contentH = useRef(0);
    const listTop = useRef(0);
    const drag = useRef({ dy: 0, scroll0: 0, fingerY: -1 });
    const primaryTouch = useRef(null);   // the finger that picked the row up; any other finger is ignored
    // The identifier of the finger that held the row down (recorded on press
    // in, which is the only place a specific touch can be identified
    // reliably). Read at drag start so the drag can never pick up a second
    // finger that happens to be first in the event's touch array.
    const pressTouchId = useRef(null);
    // Throttle for the [QUEUE] autoscroll diagnostic line.
    const lastScrollLog = useRef(0);
    const scrollTimer = useRef(null);
    const rowListIdx = useRef([]);     // rows index -> index in the list data
    const finishRef = useRef(null);

    const stopAutoScroll = () => { clearInterval(scrollTimer.current); scrollTimer.current = null; };

    const layoutOfRow = (i) => cellLayouts[rowListIdx.current[i]];
    const refreshDrag = () => {
        const d = drag.current;
        const startL = layoutOfRow(startIdx.current);
        if (!startL) return;
        dragY.setValue(d.dy + (scrollY.current - d.scroll0));
        // Where the dragged row's own CENTRE is now, in list (content)
        // coordinates. Deliberately not the finger: the row is drawn with the
        // grab point preserved, so a row grabbed near its top or bottom edge
        // has its centre half a row away from the finger, and measuring the
        // slot from the finger dropped it half a row off, the reported "it
        // shifts up by one place".
        const h = startL.height || ROW_HEIGHT;
        const pos = startL.y + d.dy + (scrollY.current - d.scroll0) + h / 2;
        const list = rowsRef.current;
        let best = toIdx.current;
        const first = layoutOfRow(0), last = layoutOfRow(list.length - 1);
        if (first && pos < first.y + first.height / 2) best = 0;
        else if (last && pos > last.y + last.height / 2) best = list.length - 1;
        else {
            for (let j = 0; j < list.length; j++) {
                const l = layoutOfRow(j);
                if (l && pos >= l.y && pos < l.y + l.height) { best = j; break; }
            }
        }
        if (best !== toIdx.current) { toIdx.current = best; setDragTo(best); }
    };

    const exitEdit = useCallback(() => {
        clearTimeout(holdTimer.current);
        clearInterval(scrollTimer.current); scrollTimer.current = null;
        armedKey.current = null;
        dragging.current = false;
        editRef.current = false;
        draggedListIndex = -1;
        setEditMode(false); setDragKey(null); setDragTo(null);
        dragY.setValue(0);
    }, [dragY]);
    useEffect(() => { if (!visible) exitEdit(); }, [visible, exitEdit]);

    const arm = useCallback((key) => {
        const idx = rowsRef.current.findIndex(r => r.stableKey === key);
        if (idx < 0) return;
        armedKey.current = key;
        suppressPress.current = true;        // letting go after the hold must not play the song
        startIdx.current = idx; toIdx.current = idx;
        dragY.setValue(0);
        editRef.current = true;
        if (boxRef.current) boxRef.current.measureInWindow((x, y) => { listTop.current = y; });
        // More rows are built while a row is held, so there is always list
        // below to scroll into (rows are only ever appended, so the held
        // row and the slots measured so far keep their places).
        setVisibleCount(c => (c < totalRowsRef.current ? Math.min(totalRowsRef.current, c + MORE_ROWS) : c));
        setEditMode(true);
        setDragKey(key);
        setDragTo(idx);
    }, [dragY]);

    const pressIn = useCallback((key, touchId) => {
        clearTimeout(holdTimer.current);
        suppressPress.current = false;
        // The finger that starts the hold owns the drag from here on (see the
        // pan responder's move handler): recorded here because this is the one
        // place a specific touch can be identified, and because it is the hand
        // that is actually on the row. Any other finger is ignored.
        if (touchId !== undefined && touchId !== null) pressTouchId.current = touchId;
        // Same timing as moving playlists.
        holdTimer.current = setTimeout(() => arm(key), editRef.current ? EDIT_LIFT_MS : LIFT_MS);
    }, [arm]);
    const pressOut = useCallback(() => {
        clearTimeout(holdTimer.current);
        // Held and let go without dragging: the row is just put back down
        // (no separate "editing" state is left behind).
        if (armedKey.current && !dragging.current) {
            armedKey.current = null; editRef.current = false; draggedListIndex = -1;
            setDragKey(null); setDragTo(null); setEditMode(false);
        }
    }, []);

    const finishDrag = useCallback(async () => {
        stopAutoScroll();
        if (!dragging.current) return;
        dragging.current = false;
        const list = rowsRef.current;
        const from = startIdx.current, to = toIdx.current;
        armedKey.current = null;
        const fromL = layoutOfRow(from), toL = layoutOfRow(to);
        if (from !== to && list[from] && list[to] && fromL && toL) {
            // Settle the held row into its slot, then do the real move.
            Animated.timing(dragY, { toValue: toL.y - fromL.y, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
            const next = await moveInQueue(list[from].realIndex, list[to].realIndex);
            await refresh(next);
        }
        draggedListIndex = -1;
        setDragKey(null); setDragTo(null);
        dragY.setValue(0);
        // Moving a row is not a mode: once it is dropped everything is back to
        // normal (swiping and tapping work again, no Done button).
        editRef.current = false;
        setEditMode(false);
    }, [dragY, moveInQueue, refresh]);
    finishRef.current = finishDrag;

    const dragPan = useRef(PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        // Only once a row has been picked up, and the finger has moved a little.
        onMoveShouldSetPanResponderCapture: (_e, g) => armedKey.current != null && Math.abs(g.dy) > DRAG_SLOP,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
            dragging.current = true;
            const idx = rowsRef.current.findIndex(r => r.stableKey === armedKey.current);
            if (idx >= 0) { startIdx.current = idx; toIdx.current = idx; }
            drag.current = { dy: 0, scroll0: scrollY.current, fingerY: e.nativeEvent.pageY };
            const touches0 = e.nativeEvent.touches || [];
            primaryTouch.current = pressTouchId.current != null
                ? pressTouchId.current
                : (touches0.length ? touches0[0].identifier : null);
            console.log('[QUEUE] drag start: touch=' + primaryTouch.current + ' of ' + touches0.length
                + ' listTop=' + Math.round(listTop.current) + ' viewH=' + Math.round(viewH.current)
                + ' contentH=' + Math.round(contentH.current) + ' fingerY=' + Math.round(drag.current.fingerY));
            clearInterval(scrollTimer.current);
            let lastT = Date.now();
            scrollTimer.current = setInterval(() => {
                const now = Date.now();
                const dt = Math.min(64, now - lastT);   // ms since the last step
                lastT = now;
                if (!dragging.current) return;
                // Only the very edge of the list scrolls it, and gently:
                // speed grows with how far into the zone the finger is.
                const zone = Math.min(EDGE, viewH.current * 0.2);
                if (!(listTop.current > 0) || !(viewH.current > 0)) return;   // not measured yet: no scrolling on a guess
                const fy = drag.current.fingerY - listTop.current;
                let v = 0;
                // k is 0 at the inner border of the zone and 1 (never more) at the edge
                // or beyond it, so the speed can never exceed MAX_SCROLL_PX_S.
                if (fy < zone) { const k = Math.min(1, Math.max(0, (zone - fy) / zone)); v = -k * k * MAX_SCROLL_PX_S; }
                else if (fy > viewH.current - zone) { const k = Math.min(1, Math.max(0, (fy - (viewH.current - zone)) / zone)); v = k * k * MAX_SCROLL_PX_S; }
                if (!v) return;
                const step = (v * dt) / 1000;
                const maxY = Math.max(0, contentH.current - viewH.current);
                // [QUEUE] diagnostic: everything the touch-based auto-scroll
                // depends on, so a recording shows which part is wrong when it
                // doesn't move.
                if (now - lastScrollLog.current > 500) {
                    lastScrollLog.current = now;
                    console.log('[QUEUE] autoscroll v=' + Math.round(v) + ' fy=' + Math.round(fy)
                        + ' zone=' + Math.round(zone) + ' scrollY=' + Math.round(scrollY.current)
                        + '/' + Math.round(maxY) + ' rows=' + visibleRef.current + '/' + totalRowsRef.current);
                }
                if (step > 0 && scrollY.current > maxY - viewH.current * 1.5 && visibleRef.current < totalRowsRef.current) {
                    setVisibleCount(c => (c < totalRowsRef.current ? Math.min(totalRowsRef.current, c + MORE_ROWS) : c));
                }
                const ny = Math.max(0, Math.min(maxY, scrollY.current + step));
                if (ny === scrollY.current) return;
                scrollY.current = ny;
                if (listRef.current) listRef.current.scrollToOffset({ offset: ny, animated: false });
                refreshDrag();
            }, 16);
        },
        onPanResponderMove: (e, g) => {
            // Follow only the finger that picked the row up. g.dy and g.moveY
            // are the CENTROID of every finger on the glass, so falling back to
            // them (which this did whenever the identified finger wasn't found)
            // put the row straight back onto "the average of the two fingers".
            // If our finger isn't in this event the row is left where it is.
            const touches = e.nativeEvent.touches || [];
            const mine = primaryTouch.current != null ? touches.find(t => t.identifier === primaryTouch.current) : null;
            const use = mine || (touches.length === 1 ? touches[0] : null);
            if (use) {
                drag.current.fingerY = use.pageY;
                drag.current.dy = use.pageY - g.y0;
            }
            refreshDrag();
        },
        onPanResponderRelease: () => { finishRef.current(); },
        onPanResponderTerminate: () => { finishRef.current(); },
    })).current;
    useEffect(() => () => clearInterval(scrollTimer.current), []);

    const jump = async (realIndex) => {
        if (suppressPress.current || editRef.current) return;
        await jumpToQueueIndex(realIndex); await refresh();
    };
    const remove = async (realIndex, stableKey, qid) => {
        // Let the shrink play out first, then do the real removal + refresh
        // — see ShrinkOutRow above for why.
        setRemovingKeys(prev => new Set(prev).add(stableKey));
        await new Promise(r => setTimeout(r, REMOVE_ANIM_MS));
        const next = await removeFromQueue(realIndex, qid);
        await refresh(next);
        setRemovingKeys(prev => { const n = new Set(prev); n.delete(stableKey); return n; });
    };
    const promote = async (realIndex, qid) => {
        const { priority, insertedAt } = await promoteToQueue(realIndex, qid);
        await refresh(priority, insertedAt);
    };
    // Swipe right on a Priority row: another copy goes to the end of Priority.
    const addCopy = async (song) => {
        const priority = await addToQueue(song);
        const cur = await AudioEngine.getCurrentTrack();
        await refresh(priority, cur !== null && cur !== undefined ? cur + priority.length : undefined);
    };

    // Real cause of "queue screen laggy/choppy, inconsistent animations"
    // found here: this whole sheet was a plain ScrollView + .map over every
    // row — Now Playing, every Priority row, every Up Next row — all
    // mounted at once regardless of what's actually scrolled into view.
    // Each one carries its own SwipeableRow (its own pan gesture handler)
    // plus two nested Animated views for the grow/shrink transitions. A
    // queue of any real size (a 25-track playlist, let alone a big "All
    // Songs" shuffle) meant dozens of simultaneously-mounted gesture
    // handlers and animated nodes competing for the same JS thread as the
    // scroll/dismiss gesture itself — exactly what "inconsistent
    // animations" feels like under load. Switching to FlatList windows
    // this down to roughly what's actually on screen (plus a small
    // overscan buffer) at any moment, same as the other lists in this app
    // (AllSongsScreen, PlaylistDetailScreen) already do.
    //
    // The Now Playing row, the Priority/Up Next pills, and the divider
    // between them weren't part of `rows` before — they were separate JSX
    // interleaved with the two `.map(renderRow)` calls. FlatList needs a
    // single flat `data` array to virtualize correctly, so they're folded
    // into one list here with a `type` tag per entry, and renderItem below
    // switches on it. Content and behavior are unchanged — same rows, same
    // pills, same divider, same conditions for when each appears.
    const listData = useMemo(() => {
        const items = [];
        if (currentTrack) items.push({ type: 'nowplaying', key: 'now-playing' });
        // The last row of a section is being removed: its label (and the line
        // between the sections) close up together with it.
        const priGone = priorityRows.length > 0 && priorityRows.every(r => removingKeys.has(r.stableKey));
        const upGone = upNextRows.length > 0 && upNextRows.every(r => removingKeys.has(r.stableKey));
        if (priorityRows.length > 0) {
            items.push({ type: 'pill', key: 'pill-priority', label: 'Priority', isNew: newKeys.has(priorityRows[0].stableKey), collapsing: priGone });
            for (const r of priorityRows) items.push({ type: 'row', key: r.stableKey, row: r });
        }
        if (priorityRows.length > 0 && upNextRows.length > 0) items.push({ type: 'divider', key: 'divider', collapsing: priGone || upGone, isNew: newKeys.has(priorityRows[0].stableKey) });
        if (upNextRows.length > 0) {
            items.push({ type: 'pill', key: 'pill-upnext', label: 'Up Next', isNew: newKeys.has(upNextRows[0].stableKey), collapsing: upGone });
            for (const r of upNextRows) items.push({ type: 'row', key: r.stableKey, row: r });
        }
        return items;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, currentTrack, newKeys, removingKeys]);
    draggedListIndex = dragKey == null ? -1 : listData.findIndex(it => it.key === dragKey);
    {
        const byKey = new Map();
        listData.forEach((it, i) => { if (it.type === 'row') byKey.set(it.key, i); });
        rowListIdx.current = rows.map(r => byKey.get(r.stableKey));
    }

    // Stable handlers so memoized rows are not re-rendered just because the
    // parent re-rendered (every closure above is new on each render).
    const actionsRef = useRef({});
    actionsRef.current = { remove, promote, addCopy, jump, pressIn, pressOut };
    const rowActions = useRef({
        pressIn: (k, id) => actionsRef.current.pressIn(k, id),
        pressOut: () => actionsRef.current.pressOut(),
        remove: (i, k, q) => actionsRef.current.remove(i, k, q),
        promote: (i, q) => actionsRef.current.promote(i, q),
        addCopy: (song) => actionsRef.current.addCopy(song),
        jump: (i) => actionsRef.current.jump(i),
    }).current;

    // How far a row slides to make room for the held one (0 for rows that stay).
    const rowShift = (key) => {
        if (dragKey == null || dragTo == null) return 0;
        const i = rows.findIndex(r => r.stableKey === key);
        const f = startIdx.current;
        if (i < 0 || i === f) return 0;
        const h = layoutOfRow(f)?.height ?? ROW_HEIGHT;
        if (f < dragTo && i > f && i <= dragTo) return -h;
        if (f > dragTo && i >= dragTo && i < f) return h;
        return 0;
    };

    const renderRow = (row) => (
        <QueueRow
            key={row.stableKey}
            row={row}
            isNew={newKeys.has(row.stableKey)}
            removing={removingKeys.has(row.stableKey)}
            art={artMap[row.song.id]}
            playCount={playCounts[row.song.id]}
            showSongCovers={showSongCovers}
            showPlayCount={showPlayCount}
            coverShape={coverShape}
            artistSeparator={artistSeparator}
            artistDisplayJoin={artistDisplayJoin}
            theme={theme}
            base={base}
            actions={rowActions}
            editing={editMode}
            dragging={dragKey === row.stableKey}
            live={dragKey != null && dragTo != null}
            shift={rowShift(row.stableKey)}
            dragY={dragY}
        />
    );

    // Dispatches by the `type` tag listData built above. Content for each
    // branch is exactly what used to sit inline in the ScrollView below —
    // moved here only because FlatList needs one renderItem, not four
    // separate JSX blocks.
    const renderItem = ({ item }) => {
        if (item.type === 'nowplaying') {
            return (
                <>
                    <View style={[s.groupPill, { backgroundColor: base.surface }]}><Text style={[s.groupLabel, { color: base.textDim }]}>Now Playing</Text></View>
                    <SwipeableRow onSwipeRight={() => {
                        // Adding the playing song puts a row right under it;
                        // from the top, the list stays at the top.
                        const atTop = scrollY.current < 8;
                        (async () => {
                            const priority = await addToQueue(currentTrack);
                            const cur = await AudioEngine.getCurrentTrack();
                            await refresh(priority, cur !== null && cur !== undefined ? cur + priority.length : undefined);
                            if (atTop) {
                                listRef.current?.scrollToOffset({ offset: 0, animated: false });
                                setTimeout(() => listRef.current?.scrollToOffset({ offset: 0, animated: false }), 80);
                            }
                        })();
                    }} rightColor={theme.accent}>
                        <View style={[s.qRow, { backgroundColor: base.border }, pillPad(showSongCovers), songPillShadow && COVER_SHADOW]}>
                            {showSongCovers && (
                                <View style={[s.thumb, { backgroundColor: base.surface, borderRadius: squircle(PILL_COVER, coverShape) }]}>
                                    {currentTrack.artwork
                                        ? <Image source={{ uri: listArtUri(currentTrack.artwork) }} style={s.thumbImg} resizeMode="cover" />
                                        : null
                                    }
                                </View>
                            )}
                            <View style={{ flex: 1, marginRight: addedClearance(showPlayCount ? playCounts[currentTrack.id] : 0) }}>
                                <Text style={[s.qTitle, { color: base.text }]} numberOfLines={1}>{currentTrack.ourTitle ?? currentTrack.title}</Text>
                                <Text style={[s.qArtist, { color: base.textFaint }]} numberOfLines={1}>{formatArtists(currentTrack.ourArtist ?? currentTrack.artist, artistSeparator, artistDisplayJoin)}</Text>
                            </View>
                            {showPlayCount && playCounts[currentTrack.id] > 0 && (
                                <Text style={[s.qPlayCount, { color: base.textFaint }]}>{playCounts[currentTrack.id]}×</Text>
                            )}
                        </View>
                    </SwipeableRow>
                </>
            );
        }
        if (item.type === 'pill') {
            return <CollapseBlock collapsing={!!item.collapsing} growing={!!item.isNew} estH={41}><View style={[s.groupPill, { backgroundColor: base.surface }]}><Text style={[s.groupLabel, { color: base.textDim }]}>{item.label}</Text></View></CollapseBlock>;
        }
        if (item.type === 'divider') {
            return <CollapseBlock collapsing={!!item.collapsing} growing={!!item.isNew} estH={9}><View style={[s.divider, { backgroundColor: base.border }]} /></CollapseBlock>;
        }
        return renderRow(item.row);
    };

    return (
        <BottomSheet visible={visible} onClose={onClose} header={
            <View style={s.headerRow}>
                <Text style={[s.sheetTitle, { color: base.text }]}>Queue</Text>
            </View>
        }>
            {rows.length === 0 && hasLoadedOnce ? (
                <View style={{ flex: 1, justifyContent: 'center' }}>
                    <Text style={[s.empty, { color: base.textFaint }]}>Nothing up next</Text>
                </View>
            ) : rows.length === 0 ? (
                // Loaded-once hasn't landed yet (still inside refresh()'s
                // retry loop) — stay visually blank instead of claiming
                // "Nothing up next" for a state we don't actually know is
                // true yet. Sheet still opens instantly; this just stops it
                // from asserting something false for that first stretch.
                <View style={{ flex: 1 }} />
            ) : (
                <View ref={boxRef} style={{ flex: 1 }} onLayout={(e) => { viewH.current = e.nativeEvent.layout.height; if (boxRef.current) boxRef.current.measureInWindow((x, y) => { listTop.current = y; }); }} {...dragPan.panHandlers}>
                <FlatList
                    ref={listRef}
                    scrollEventThrottle={16}
                    onScroll={(e) => {
                        const y = e.nativeEvent.contentOffset.y;
                        scrollY.current = y;
                        const on = y > 8;
                        if (on !== anchorRef.current) { anchorRef.current = on; setAnchorOn(on); }
                    }}
                    onContentSizeChange={(w, h) => { contentH.current = h; }}
                    data={listData}
                    scrollEnabled={dragKey == null}
                    CellRendererComponent={Cell}
                    keyExtractor={item => item.key}
                    renderItem={renderItem}
                    showsVerticalScrollIndicator={false}
                    style={{ flex: 1 }}
                    // Same fix as before, FlatList supports the same prop —
                    // keeps whatever's currently on screen anchored in place
                    // when a promote/remove changes content above it,
                    // instead of the view visually jumping.
                    maintainVisibleContentPosition={anchorOn ? { minIndexForVisible: 0 } : undefined}
                    // renderItem above is a fresh closure every render (it
                    // closes over artMap/playCounts/newKeys/removingKeys,
                    // all of which live outside `listData`) — extraData
                    // tells FlatList's cells to actually re-render when any
                    // of those change, since none of them are part of the
                    // `data` items themselves. Without this, art/play-count/
                    // grow-shrink updates could land in state but not
                    // actually repaint an already-mounted, off-window-edge
                    // row.
                    extraData={{ artMap, playCounts, newKeys, removingKeys, editMode, dragKey, dragTo }}
                    // Row height is a known constant (see ROW_HEIGHT above)
                    // for ordinary rows — pill/divider/now-playing rows are
                    // shorter, so this is deliberately just an estimate
                    // (getItemLayout would need per-type-accurate heights to
                    // be exact), enough to help FlatList size its initial
                    // window reasonably without a measurement pass.
                    initialNumToRender={perf.on ? 6 : 10}
                    maxToRenderPerBatch={perf.on ? 4 : 8}
                    updateCellsBatchingPeriod={perf.on ? 100 : 60}
                    windowSize={perf.on ? 4 : 7}
                    onEndReachedThreshold={1.5}
                    onEndReached={() => setVisibleCount(c => (c < allRows.length ? Math.min(allRows.length, c + MORE_ROWS) : c))}
                />
                </View>
            )}
        </BottomSheet>
    );
}

const s = StyleSheet.create({
    // Matches SettingsScreen's "New EQ Preset" sheet title font — that was
    // the reference Eric pointed at (bigger/brighter, not the small dim
    // uppercase "eyebrow" style this used before).
    sheetTitle: { color: '#e5e5e5', fontSize: 16, fontWeight: '700', marginBottom: 4 },
    headerRow: { width: '100%', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24 },
    dragged: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.42, shadowRadius: 3, elevation: 6 },
    groupPill: { marginHorizontal: 24, marginTop: 14, marginBottom: 6, alignSelf: 'flex-start', backgroundColor: '#1a1a1a', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
    groupLabel: { color: '#999', fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
    divider: { height: 1, backgroundColor: '#1e1e1e', marginHorizontal: 24, marginTop: 8 },
    empty: { color: '#333', fontSize: 14, textAlign: 'center' },
    qRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 20, marginHorizontal: 14, marginVertical: 2, borderRadius: 12 },
    qTitle: { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
    qArtist: { color: '#555', fontSize: 12, marginTop: 3 },
    qPlayCount: { color: '#333', fontSize: 12, marginLeft: 8 },
    thumb: { width: 44, height: 44, marginRight: 12, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
    thumbImg: { width: '100%', height: '100%' },
    thumbNote: { fontSize: 18 },
});
