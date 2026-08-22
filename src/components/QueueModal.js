import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, Image, ScrollView, StyleSheet, InteractionManager, Animated } from 'react-native';
import TrackPlayer, { Event } from 'react-native-track-player';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import SwipeableRow from './SwipeableRow';
import BottomSheet from './BottomSheet';
import { useListArt } from '../hooks/useListArt';
import { usePreferences } from '../context/PreferencesContext';
import { getPlayCounts } from '../utils/storage';

// Fixed estimate of a row's rendered height (thumb + padding + margins) —
// used instead of measuring each row via onLayout, which would need an
// extra render pass before the animation could even start (and risks a
// one-frame flash at full size while waiting on that measurement). Queue
// rows are a consistent height regardless of content (thumb is fixed size,
// title/artist are single-line truncated), so a constant is close enough
// that the couple of px of slop is not visible.
const ROW_HEIGHT = 74;

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

// Mirrors GrowInRow — shrinks a row's height AND content out before it's
// actually removed from the list, instead of it just vanishing the instant
// the data updates (which is what "the space doesn't close naturally" was
// describing — the content faded/scaled away already, but the space it sat
// in didn't shrink until the row was actually removed, so it just snapped
// shut at the end). The row stays in `rows` (and keeps its layout slot) for
// the duration of this animation and is only actually removed once it's
// finished.
const REMOVE_ANIM_MS = 220;
function ShrinkOutRow({ removing, children }) {
    const opacityScale = useRef(new Animated.Value(1)).current;
    const heightAnim = useRef(new Animated.Value(1)).current;
    useEffect(() => {
        if (!removing) return;
        // Both on the JS driver — see the comment in GrowInRow above for
        // why: mixing drivers here is what caused the "empty gap sitting
        // there" glitch (content already gone, space not yet collapsed)
        // under the JS-thread load a removal itself causes.
        Animated.parallel([
            Animated.timing(opacityScale, { toValue: 0, duration: REMOVE_ANIM_MS, useNativeDriver: false }),
            Animated.timing(heightAnim, { toValue: 0, duration: REMOVE_ANIM_MS, useNativeDriver: false }),
        ]).start();
    }, [removing]);
    return (
        <Animated.View style={{ height: heightAnim.interpolate({ inputRange: [0, 1], outputRange: [0, ROW_HEIGHT] }), overflow: 'hidden' }}>
            <Animated.View style={{ opacity: opacityScale, transform: [{ scaleY: opacityScale }] }}>
                {children}
            </Animated.View>
        </Animated.View>
    );
}

// Grows/shrinks the "Priority" label + its divider in and out, SEQUENCED
// after the row-level animations above rather than snapping in sync with
// raw data changes: growing waits for the newly-added row's own 220ms
// grow-in to finish before starting (see the setTimeout in the effect that
// drives `shown`, below in QueueModal), and shrinking starts the moment the
// last row is actually gone from `rows` — which, since ShrinkOutRow's own
// animation always finishes BEFORE remove() ever touches `rows` (remove()
// awaits REMOVE_ANIM_MS first, see below), is already after that row has
// visually finished collapsing rather than racing it. `instant` is used
// exactly once per direction, for whatever the section's real state is the
// first time the sheet loads real data — that's a sync, not something the
// user did, so it shouldn't animate any more than existing (non-new) rows
// do on that same initial load.
function AnimatedSection({ shown, instant, targetHeight, children }) {
    const heightAnim = useRef(new Animated.Value(shown ? 1 : 0)).current;
    const opacityAnim = useRef(new Animated.Value(shown ? 1 : 0)).current;
    const [rendered, setRendered] = useState(shown);
    useEffect(() => {
        if (instant) {
            heightAnim.setValue(shown ? 1 : 0);
            opacityAnim.setValue(shown ? 1 : 0);
            setRendered(shown);
            return;
        }
        if (shown) {
            setRendered(true);
            // Both JS-driven, same reasoning as GrowInRow/ShrinkOutRow above
            // — this used to run opacity on the native driver, which could
            // desync from the (necessarily JS-driven) height under load and
            // produce the same kind of gap.
            Animated.parallel([
                Animated.timing(heightAnim, { toValue: 1, duration: 220, useNativeDriver: false }),
                Animated.timing(opacityAnim, { toValue: 1, duration: 220, useNativeDriver: false }),
            ]).start();
        } else {
            Animated.parallel([
                Animated.timing(heightAnim, { toValue: 0, duration: 220, useNativeDriver: false }),
                Animated.timing(opacityAnim, { toValue: 0, duration: 220, useNativeDriver: false }),
            ]).start(() => setRendered(false));
        }
    }, [shown, instant]);
    if (!rendered) return null;
    return (
        <Animated.View style={{ height: heightAnim.interpolate({ inputRange: [0, 1], outputRange: [0, targetHeight] }), overflow: 'hidden' }}>
            <Animated.View style={{ opacity: opacityAnim }}>
                {children}
            </Animated.View>
        </Animated.View>
    );
}
// Rough rendered heights of the pill (marginTop 14 + paddingVertical 4*2 +
// label line height + marginBottom 6) and the divider (marginTop 8 + its
// own 1px) — same "close enough, not visibly off" reasoning as ROW_HEIGHT.
const SECTION_PILL_HEIGHT = 56;
const SECTION_DIVIDER_HEIGHT = 9;

export default function QueueModal({ visible, onClose }) {
    const { theme, base } = useTheme();
    const { priorityQueue, jumpToQueueIndex, removeFromQueue, promoteToQueue, currentTrack, addToQueue } = usePlayback();
    const { showSongCovers, showPlayCount } = usePreferences();
    const [rows, setRows] = useState([]); // [{ realIndex, song, isPriority, stableKey }]
    const [newKeys, setNewKeys] = useState(() => new Set());
    const [removingKeys, setRemovingKeys] = useState(() => new Set());
    const [playCounts, setPlayCounts] = useState({});
    // Distinguishes "still working through the retry loop above" from
    // "genuinely nothing queued" — without this, both looked identical
    // (rows.length === 0) and the sheet showed "Nothing up next" during
    // that first loading window too, which read as the queue being empty
    // rather than just not loaded yet.
    const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

    // Drives AnimatedSection above. prioritySyncedOnceRef/prevHasPriorityRef
    // track state across renders without needing them in refresh()'s own
    // dependency array (refresh must stay stable — see the note on
    // priorityQueueRef just below). instant starts true so the very first
    // real load — which might already have priority items sitting in it
    // from a restored session — reflects reality immediately with no
    // animation, same as how existing rows skip GrowInRow's animation on
    // that same initial load. It flips to false the first time a genuine
    // add/remove happens, and stays false from then on.
    const [prioritySectionShown, setPrioritySectionShown] = useState(false);
    const [prioritySectionInstant, setPrioritySectionInstant] = useState(true);
    const prioritySyncedOnceRef = useRef(false);
    const prevHasPriorityRef = useRef(false);

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
                [queue, currentIndex] = await Promise.all([TrackPlayer.getQueue(), TrackPlayer.getCurrentTrack()]);
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
            if (!prioritySyncedOnceRef.current) {
                // First real data this sheet-lifetime has seen — sync the
                // section's visibility to match instantly (AnimatedSection's
                // `instant` prop, still true at this point, makes sure this
                // doesn't animate), then hand off to the effect below for
                // every genuine change after this one.
                prioritySyncedOnceRef.current = true;
                const anyPriority = upcoming.some(r => r.isPriority);
                prevHasPriorityRef.current = anyPriority;
                setPrioritySectionShown(anyPriority);
            }
        } catch { setRows([]); } finally { setHasLoadedOnce(true); }
    }, []);

    useEffect(() => {
        if (!prioritySyncedOnceRef.current) return; // first sync above hasn't happened yet
        const has = rows.some(r => r.isPriority);
        if (has === prevHasPriorityRef.current) return;
        prevHasPriorityRef.current = has;
        setPrioritySectionInstant(false); // every transition from here is a real one — animate it
        if (has) {
            // Wait for the newly-added row's own 220ms grow-in (see
            // GrowInRow) to finish before the header starts growing in
            // too, so the two don't visually compete.
            const t = setTimeout(() => setPrioritySectionShown(true), 220);
            return () => clearTimeout(t);
        }
        // Shrinking needs no equivalent delay: by the time a row is
        // actually gone from `rows`, ShrinkOutRow's own 220ms shrink has
        // already fully played out (remove() awaits that BEFORE it ever
        // touches `rows` — see remove() below), so this is already
        // starting after the row has visually finished collapsing.
        setPrioritySectionShown(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows]);

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
        refresh();
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
        const sub = TrackPlayer.addEventListener(Event.PlaybackTrackChanged, () => refresh());
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
    // time. `rows` is real state that only changes on an actual refresh, so
    // memoizing on it keeps the array reference stable across the
    // unrelated re-renders that were re-triggering this.
    const songsForArt = useMemo(() => rows.map(r => r.song), [rows]);
    const artMap = useListArt(songsForArt, showSongCovers);

    useEffect(() => {
        if (!showPlayCount || !songsForArt.length) return;
        getPlayCounts(songsForArt).then(setPlayCounts);
    }, [songsForArt, showPlayCount]);

    const jump = async (realIndex) => { await jumpToQueueIndex(realIndex); await refresh(); };
    const remove = async (realIndex, stableKey) => {
        // Let the shrink play out first, then do the real removal + refresh
        // — see ShrinkOutRow above for why.
        setRemovingKeys(prev => new Set(prev).add(stableKey));
        await new Promise(r => setTimeout(r, REMOVE_ANIM_MS));
        const next = await removeFromQueue(realIndex);
        await refresh(next);
        setRemovingKeys(prev => { const n = new Set(prev); n.delete(stableKey); return n; });
    };
    const promote = async (realIndex) => {
        const { priority, insertedAt } = await promoteToQueue(realIndex);
        await refresh(priority, insertedAt);
    };

    const renderRow = ({ song, realIndex, isPriority, stableKey }) => (
        <GrowInRow key={stableKey} isNew={newKeys.has(stableKey)}>
            <ShrinkOutRow removing={removingKeys.has(stableKey)}>
                <SwipeableRow
                    onSwipeLeft={() => remove(realIndex, stableKey)}
                    onSwipeRight={() => promote(realIndex)}
                    rightColor={theme.accent}
                    leftColor="#dc2626"
                >
                    {/* Same shape as the All Songs / Playlist rows (rounded card,
                        same padding/margins) — border tier instead of surface, since
                        the sheet itself is already surface (using the same color for
                        both left rows with no visible shape against their own
                        container). Interaction (swipe feedback, glow, etc.) stays
                        specific to the queue context. */}
                    <TouchableOpacity style={[s.qRow, { backgroundColor: base.border }]} onPress={() => jump(realIndex)} activeOpacity={0.7}>
                        {showSongCovers && (
                            <View style={[s.thumb, { backgroundColor: base.bg }]}>
                                {artMap[song.id]
                                    ? <Image source={{ uri: artMap[song.id] }} style={s.thumbImg} resizeMode="cover" />
                                    : <Text style={[s.thumbNote, { color: theme.accentDim }]}>♪</Text>
                                }
                            </View>
                        )}
                        <View style={{ flex: 1 }}>
                            <Text style={s.qTitle} numberOfLines={1}>{song.ourTitle ?? song.title}</Text>
                            <Text style={s.qArtist} numberOfLines={1}>{song.ourArtist ?? song.artist}</Text>
                        </View>
                        {showPlayCount && playCounts[song.id] > 0 && (
                            <Text style={s.qPlayCount}>{playCounts[song.id]}×</Text>
                        )}
                    </TouchableOpacity>
                </SwipeableRow>
            </ShrinkOutRow>
        </GrowInRow>
    );


    return (
        <BottomSheet visible={visible} onClose={onClose} header={<Text style={s.sheetTitle}>Queue</Text>}>
            <>
                {/* Not wrapped in the ScrollView below (sits pinned above it
                    instead) so it's always visible regardless of whether
                    anything's actually queued up — including the "Nothing up
                    next" empty state, since there's still a currently playing
                    song even when nothing follows it. Not tappable (plain
                    View, not TouchableOpacity) — there's nothing meaningful
                    to "jump to" on the song already playing. Swipe-right only
                    (no onSwipeLeft prop at all — SwipeableRow disables the
                    left-swipe reveal entirely when that's omitted, rather
                    than showing a Remove affordance that would do nothing) so
                    you can re-queue the current song to play again later,
                    but there's nothing to remove it FROM here. */}
                {currentTrack && (
                    <View>
                        <View style={s.groupPill}><Text style={s.groupLabel}>Now Playing</Text></View>
                        <SwipeableRow onSwipeRight={() => addToQueue(currentTrack)} rightColor={theme.accent}>
                            <View style={[s.qRow, { backgroundColor: base.border }]}>
                                {showSongCovers && (
                                    <View style={[s.thumb, { backgroundColor: base.bg }]}>
                                        {currentTrack.artwork
                                            ? <Image source={{ uri: currentTrack.artwork }} style={s.thumbImg} resizeMode="cover" />
                                            : <Text style={[s.thumbNote, { color: theme.accentDim }]}>♪</Text>
                                        }
                                    </View>
                                )}
                                <View style={{ flex: 1 }}>
                                    <Text style={s.qTitle} numberOfLines={1}>{currentTrack.ourTitle ?? currentTrack.title}</Text>
                                    <Text style={s.qArtist} numberOfLines={1}>{currentTrack.ourArtist ?? currentTrack.artist}</Text>
                                </View>
                            </View>
                        </SwipeableRow>
                    </View>
                )}
                {rows.length === 0 && hasLoadedOnce ? (
                    <View style={{ flex: 1, justifyContent: 'center' }}>
                        <Text style={s.empty}>Nothing up next</Text>
                    </View>
                ) : rows.length === 0 ? (
                    // Loaded-once hasn't landed yet (still inside refresh()'s
                    // retry loop) — stay visually blank instead of claiming
                    // "Nothing up next" for a state we don't actually know is
                    // true yet. Sheet still opens instantly; this just stops it
                    // from asserting something false for that first stretch.
                    <View style={{ flex: 1 }} />
                ) : (
                    <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
                        <AnimatedSection shown={prioritySectionShown} instant={prioritySectionInstant} targetHeight={SECTION_PILL_HEIGHT}>
                            <View style={s.groupPill}><Text style={s.groupLabel}>Priority</Text></View>
                        </AnimatedSection>
                        {priorityRows.length > 0 && priorityRows.map(renderRow)}
                        <AnimatedSection shown={prioritySectionShown && upNextRows.length > 0} instant={prioritySectionInstant} targetHeight={SECTION_DIVIDER_HEIGHT}>
                            <View style={s.divider} />
                        </AnimatedSection>
                        {upNextRows.length > 0 && (
                            <>
                                <View style={s.groupPill}><Text style={s.groupLabel}>Up Next</Text></View>
                                {upNextRows.map(renderRow)}
                            </>
                        )}
                    </ScrollView>
                )}
            </>
        </BottomSheet>
    );
}

const s = StyleSheet.create({
    // Matches SettingsScreen's "New EQ Preset" sheet title font — that was
    // the reference Eric pointed at (bigger/brighter, not the small dim
    // uppercase "eyebrow" style this used before).
    sheetTitle: { color: '#e5e5e5', fontSize: 16, fontWeight: '700', marginBottom: 4, paddingHorizontal: 24 },
    groupPill: { marginHorizontal: 24, marginTop: 14, marginBottom: 6, alignSelf: 'flex-start', backgroundColor: '#1a1a1a', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
    groupLabel: { color: '#999', fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
    divider: { height: 1, backgroundColor: '#1e1e1e', marginHorizontal: 24, marginTop: 8 },
    empty: { color: '#333', fontSize: 14, textAlign: 'center' },
    qRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 20, marginHorizontal: 14, marginVertical: 2, borderRadius: 12 },
    qTitle: { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
    qArtist: { color: '#555', fontSize: 12, marginTop: 3 },
    qPlayCount: { color: '#333', fontSize: 12, marginLeft: 8 },
    thumb: { width: 42, height: 42, borderRadius: 8, marginRight: 12, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
    thumbImg: { width: '100%', height: '100%' },
    thumbNote: { fontSize: 18 },
});
