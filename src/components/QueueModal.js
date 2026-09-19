import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, Image, FlatList, StyleSheet, InteractionManager, Animated } from 'react-native';
import AudioEngine, { Event } from '../native/AudioEngine';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { squircle } from '../utils/squircle';
import SwipeableRow from './SwipeableRow';
import BottomSheet from './BottomSheet';
import { useListArt } from '../hooks/useListArt';
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

// The "Priority" and "Up Next" pills get a fade-in (FadePill above) tied to
// the exact same isNew flag as their own first row — see FadePill's comment
// for why an independent timer was the actual bug in an earlier attempt at
// animating these. Removal is still a plain unrender, not a fade-out: doing
// that properly would mean tracking a lingering "ghost pill" the same way
// removingKeys does for rows (a pill whose rows just emptied out has no row
// of its own left to key its fade-out off of), which is a bigger, riskier
// change than this pass — the appearing half was the specific complaint.

export default function QueueModal({ visible, onClose }) {
    const { theme, base } = useTheme();
    const { priorityQueue, jumpToQueueIndex, removeFromQueue, promoteToQueue, currentTrack, addToQueue } = usePlayback();
    const { showSongCovers, showPlayCount, artistSeparator, coverShape } = usePreferences();
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
        if (priorityRows.length > 0) {
            items.push({ type: 'pill', key: 'pill-priority', label: 'Priority', isNew: newKeys.has(priorityRows[0].stableKey) });
            for (const r of priorityRows) items.push({ type: 'row', key: r.stableKey, row: r });
        }
        if (priorityRows.length > 0 && upNextRows.length > 0) items.push({ type: 'divider', key: 'divider' });
        if (upNextRows.length > 0) {
            items.push({ type: 'pill', key: 'pill-upnext', label: 'Up Next', isNew: newKeys.has(upNextRows[0].stableKey) });
            for (const r of upNextRows) items.push({ type: 'row', key: r.stableKey, row: r });
        }
        return items;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, currentTrack, newKeys]);

    const renderRow = ({ song, realIndex, isPriority, stableKey }) => (
        <GrowInRow key={stableKey} isNew={newKeys.has(stableKey)}>
            <ShrinkOutRow removing={removingKeys.has(stableKey)}>
                <SwipeableRow
                    onSwipeLeft={() => remove(realIndex, stableKey)}
                    // Only meaningful for Up Next rows — "promote to
                    // Priority" doesn't mean anything for a row that's
                    // already in Priority (see promoteToQueue's guard for
                    // the duplicate-queue-entry bug this used to cause).
                    // Omitting the prop entirely disables the swipe-right
                    // reveal for these rows, same as Now Playing's row
                    // below omits onSwipeLeft.
                    onSwipeRight={isPriority ? undefined : () => promote(realIndex)}
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
                            <View style={[s.thumb, { backgroundColor: base.bg, borderRadius: squircle(42, coverShape) }]}>
                                {artMap[song.id]
                                    ? <Image source={{ uri: artMap[song.id] }} style={s.thumbImg} resizeMode="cover" />
                                    : <Text style={[s.thumbNote, { color: theme.accentDim }]}>♪</Text>
                                }
                            </View>
                        )}
                        <View style={{ flex: 1 }}>
                            <Text style={[s.qTitle, { color: base.text }]} numberOfLines={1}>{song.ourTitle ?? song.title}</Text>
                            <Text style={[s.qArtist, { color: base.textFaint }]} numberOfLines={1}>{formatArtists(song.ourArtist ?? song.artist, artistSeparator)}</Text>
                        </View>
                        {showPlayCount && playCounts[song.id] > 0 && (
                            <Text style={[s.qPlayCount, { color: base.textFaint }]}>{playCounts[song.id]}×</Text>
                        )}
                    </TouchableOpacity>
                </SwipeableRow>
            </ShrinkOutRow>
        </GrowInRow>
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
                    <SwipeableRow onSwipeRight={() => addToQueue(currentTrack).then(() => refresh())} rightColor={theme.accent}>
                        <View style={[s.qRow, { backgroundColor: base.border }]}>
                            {showSongCovers && (
                                <View style={[s.thumb, { backgroundColor: base.bg, borderRadius: squircle(42, coverShape) }]}>
                                    {currentTrack.artwork
                                        ? <Image source={{ uri: currentTrack.artwork }} style={s.thumbImg} resizeMode="cover" />
                                        : <Text style={[s.thumbNote, { color: theme.accentDim }]}>♪</Text>
                                    }
                                </View>
                            )}
                            <View style={{ flex: 1 }}>
                                <Text style={[s.qTitle, { color: base.text }]} numberOfLines={1}>{currentTrack.ourTitle ?? currentTrack.title}</Text>
                                <Text style={[s.qArtist, { color: base.textFaint }]} numberOfLines={1}>{formatArtists(currentTrack.ourArtist ?? currentTrack.artist, artistSeparator)}</Text>
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
            return <FadePill isNew={item.isNew}><View style={[s.groupPill, { backgroundColor: base.surface }]}><Text style={[s.groupLabel, { color: base.textDim }]}>{item.label}</Text></View></FadePill>;
        }
        if (item.type === 'divider') {
            return <View style={[s.divider, { backgroundColor: base.border }]} />;
        }
        return renderRow(item.row);
    };

    return (
        <BottomSheet visible={visible} onClose={onClose} header={<Text style={[s.sheetTitle, { color: base.text }]}>Queue</Text>}>
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
                <FlatList
                    data={listData}
                    keyExtractor={item => item.key}
                    renderItem={renderItem}
                    showsVerticalScrollIndicator={false}
                    style={{ flex: 1 }}
                    // Same fix as before, FlatList supports the same prop —
                    // keeps whatever's currently on screen anchored in place
                    // when a promote/remove changes content above it,
                    // instead of the view visually jumping.
                    maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
                    // renderItem above is a fresh closure every render (it
                    // closes over artMap/playCounts/newKeys/removingKeys,
                    // all of which live outside `listData`) — extraData
                    // tells FlatList's cells to actually re-render when any
                    // of those change, since none of them are part of the
                    // `data` items themselves. Without this, art/play-count/
                    // grow-shrink updates could land in state but not
                    // actually repaint an already-mounted, off-window-edge
                    // row.
                    extraData={{ artMap, playCounts, newKeys, removingKeys }}
                    // Row height is a known constant (see ROW_HEIGHT above)
                    // for ordinary rows — pill/divider/now-playing rows are
                    // shorter, so this is deliberately just an estimate
                    // (getItemLayout would need per-type-accurate heights to
                    // be exact), enough to help FlatList size its initial
                    // window reasonably without a measurement pass.
                    initialNumToRender={12}
                    windowSize={7}
                />
            )}
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
    emptyPriorityHint: { color: '#555', fontSize: 13, paddingHorizontal: 24, paddingBottom: 10 },
    divider: { height: 1, backgroundColor: '#1e1e1e', marginHorizontal: 24, marginTop: 8 },
    empty: { color: '#333', fontSize: 14, textAlign: 'center' },
    qRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 20, marginHorizontal: 14, marginVertical: 2, borderRadius: 12 },
    qTitle: { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
    qArtist: { color: '#555', fontSize: 12, marginTop: 3 },
    qPlayCount: { color: '#333', fontSize: 12, marginLeft: 8 },
    thumb: { width: 42, height: 42, marginRight: 12, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
    thumbImg: { width: '100%', height: '100%' },
    thumbNote: { fontSize: 18 },
});
