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

export default function QueueModal({ visible, onClose }) {
    const { theme, base } = useTheme();
    const { priorityQueue, jumpToQueueIndex, removeFromQueue, promoteToQueue } = usePlayback();
    const { showSongCovers } = usePreferences();
    const [rows, setRows] = useState([]); // [{ realIndex, song, isPriority, stableKey }]
    // null until the first refresh after opening — that first population is
    // the baseline "already there" state and shouldn't animate in. Reset to
    // null again on close so reopening doesn't retroactively grow-in
    // anything that changed while the sheet was shut.
    const knownKeysRef = useRef(null);
    const [newKeys, setNewKeys] = useState(() => new Set());

    const refresh = useCallback(async (priorityOverride) => {
        try {
            const queue = await TrackPlayer.getQueue();
            const currentIndex = await TrackPlayer.getCurrentTrack();
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
            const upcoming = queue.slice(currentIndex + 1).map((song, i) => {
                const n = (idOccurrence[song.id] = (idOccurrence[song.id] || 0) + 1);
                const realIndex = currentIndex + 1 + i;
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
                    stableKey: `${song.id}#${n}`,
                };
            });
            const currentKeys = new Set(upcoming.map(r => r.stableKey));
            if (knownKeysRef.current === null) {
                setNewKeys(new Set());
            } else {
                const added = new Set();
                for (const k of currentKeys) if (!knownKeysRef.current.has(k)) added.add(k);
                setNewKeys(added);
            }
            knownKeysRef.current = currentKeys;
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
        if (!visible) {
            knownKeysRef.current = null;
            return;
        }
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
    const remove = async (realIndex) => { const next = await removeFromQueue(realIndex); await refresh(next); };
    const promote = async (realIndex) => { const next = await promoteToQueue(realIndex); await refresh(next); };

    const renderRow = ({ song, realIndex, isPriority, stableKey }) => (
        <GrowInRow key={stableKey} isNew={newKeys.has(stableKey)}>
            <SwipeableRow
                onSwipeLeft={() => remove(realIndex)}
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
