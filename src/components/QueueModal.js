import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, Image, ScrollView, StyleSheet, InteractionManager, Animated } from 'react-native';
import TrackPlayer from 'react-native-track-player';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import SwipeableRow from './SwipeableRow';
import BottomSheet from './BottomSheet';
import { useListArt } from '../hooks/useListArt';
import { usePreferences } from '../context/PreferencesContext';

// Grows a newly-added row in from nothing instead of it just abruptly
// appearing in the list (same idea as Spotify's queue-add animation).
// Existing rows render at full size immediately — only ones QueueModal
// marks as newly added (via `isNew`) animate. transform/opacity only, so
// this stays on the native driver like the rest of this screen's animations.
function GrowInRow({ isNew, children }) {
    const anim = useRef(new Animated.Value(isNew ? 0 : 1)).current;
    useEffect(() => {
        if (!isNew) return;
        Animated.spring(anim, { toValue: 1, useNativeDriver: true, friction: 8, tension: 60 }).start();
        // Intentionally mount-only — this is a one-time "arrival" animation,
        // not something that should replay if isNew's identity ever changed.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <Animated.View style={{ opacity: anim, transform: [{ scaleY: anim }] }}>{children}</Animated.View>;
}

// Mirrors GrowInRow — shrinks a row out before it's actually removed from
// the list, instead of it just vanishing the instant the data updates. The
// row stays in `rows` (and keeps its reserved layout space) for the short
// duration of this animation and is only actually removed once it's
// finished, so what would otherwise be a visible row disappearing abruptly
// becomes a brief collapse of now-empty space instead.
const REMOVE_ANIM_MS = 180;
function ShrinkOutRow({ removing, children }) {
    const anim = useRef(new Animated.Value(1)).current;
    useEffect(() => {
        if (!removing) return;
        // Non-native here (unlike GrowInRow) specifically to also animate
        // marginVertical down to 0 alongside the scale/fade — the row's own
        // small vertical margin was staying put even as its content shrank
        // to nothing, leaving a thin leftover gap that then snapped shut
        // the instant the row was actually removed. One extra non-native
        // property on a single ~180ms one-off animation isn't the kind of
        // thing that competes with anything performance-sensitive.
        Animated.timing(anim, { toValue: 0, duration: REMOVE_ANIM_MS, useNativeDriver: false }).start();
    }, [removing]);
    return (
        <Animated.View style={{
            opacity: anim,
            transform: [{ scaleY: anim }],
            marginVertical: anim.interpolate({ inputRange: [0, 1], outputRange: [0, 2] }),
        }}>
            {children}
        </Animated.View>
    );
}

export default function QueueModal({ visible, onClose }) {
    const { theme, base } = useTheme();
    const { priorityQueue, jumpToQueueIndex, removeFromQueue, promoteToQueue } = usePlayback();
    const { showSongCovers } = usePreferences();
    const [rows, setRows] = useState([]); // [{ realIndex, song, isPriority, stableKey }]
    const [newKeys, setNewKeys] = useState(() => new Set());
    const [removingKeys, setRemovingKeys] = useState(() => new Set());

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
                queue = await TrackPlayer.getQueue();
                currentIndex = await TrackPlayer.getCurrentTrack();
                if (currentIndex !== null && currentIndex !== undefined && queue.length > 0) break;
                if (attempt < 4) await new Promise(r => setTimeout(r, 120));
            }
            if (currentIndex === null || currentIndex === undefined) { setRows([]); return; }
            const activePriority = priorityOverride ?? priorityQueue;
            // stableKey is song.id + which occurrence of that id this is,
            // NOT realIndex. Keying by realIndex meant every row after a
            // removed/added item got a brand-new key on each refresh (since
            // their queue position shifted), so React treated them as
            // entirely new components and remounted the whole tail of the
            // list — that remount-flash was the actual "flash" on add/remove,
            // separate from the swipe feedback glow. Occurrence-based keys
            // only change for a row when a duplicate of ITS OWN song is
            // added/removed earlier in the list, which is rare.
            const idOccurrence = {};
            const priorityEnd = currentIndex + 1 + activePriority.length;
            let justAddedKey = null;
            const upcoming = queue.slice(currentIndex + 1).map((song, i) => {
                const n = (idOccurrence[song.id] = (idOccurrence[song.id] || 0) + 1);
                const realIndex = currentIndex + 1 + i;
                const stableKey = `${song.id}#${n}`;
                // Inserting a new copy earlier in the queue shifts the
                // occurrence numbers of any LATER copies of that same song
                // (the one that was "#1" can become "#2", etc.) — diffing
                // stableKeys against a previous snapshot to guess "what's
                // new" was catching that renumbered EXISTING row as new
                // instead of the actual new one, since its key changed too.
                // Being told exactly which realIndex was just inserted at
                // (from the action that caused this refresh) sidesteps that
                // entirely — no guessing from key identity needed.
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
        } catch { setRows([]); }
    }, [priorityQueue]);

    useEffect(() => {
        // Deferred until the sheet's own open animation has settled, rather
        // than firing the instant `visible` flips true. refresh() does real
        // native-bridge round trips (getQueue/getCurrentTrack) and then
        // triggers the art-loading pass on top of that — racing all of that
        // against the slide-up animation is very likely why opening the
        // queue felt drastically slower than the other sheets (EQ, sleep
        // timer), which have no such data-fetch on open. Letting the
        // animation finish untouched first, then populating content right
        // after, should make the open itself feel identical to the others.
        if (!visible) return;
        const task = InteractionManager.runAfterInteractions(() => refresh());
        return () => task.cancel();
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
                    </TouchableOpacity>
                </SwipeableRow>
            </ShrinkOutRow>
        </GrowInRow>
    );

    return (
        <BottomSheet visible={visible} onClose={onClose} header={<Text style={s.sheetTitle}>Queue</Text>}>
            {rows.length === 0 ? (
                <View style={{ flex: 1, justifyContent: 'center' }}>
                    <Text style={s.empty}>Nothing up next</Text>
                </View>
            ) : (
                <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
                    {priorityRows.length > 0 && (
                        <>
                            <View style={s.groupPill}><Text style={s.groupLabel}>Priority</Text></View>
                            {priorityRows.map(renderRow)}
                        </>
                    )}
                    {priorityRows.length > 0 && upNextRows.length > 0 && <View style={s.divider} />}
                    {upNextRows.length > 0 && (
                        <>
                            <View style={s.groupPill}><Text style={s.groupLabel}>Up Next</Text></View>
                            {upNextRows.map(renderRow)}
                        </>
                    )}
                </ScrollView>
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
    divider: { height: 1, backgroundColor: '#1e1e1e', marginHorizontal: 24, marginTop: 8 },
    empty: { color: '#333', fontSize: 14, textAlign: 'center' },
    qRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 20, marginHorizontal: 14, marginVertical: 2, borderRadius: 12 },
    qTitle: { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
    qArtist: { color: '#555', fontSize: 12, marginTop: 3 },
    thumb: { width: 42, height: 42, borderRadius: 8, marginRight: 12, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
    thumbImg: { width: '100%', height: '100%' },
    thumbNote: { fontSize: 18 },
});
