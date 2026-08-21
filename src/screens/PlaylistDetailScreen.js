import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
    View, Text, FlatList, TouchableOpacity,
    StyleSheet, TextInput, StatusBar, Image, Alert, Animated,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useNavigation, useRoute } from '@react-navigation/native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { usePreferences } from '../context/PreferencesContext';
import { getPlayCounts, getPlaylistCovers, setPlaylistCover, persistCoverImage, getPlaylistSort, setPlaylistSort } from '../utils/storage';
import { playlistColor } from '../utils/color';
import { squircle } from '../utils/squircle';
import { PlayIcon, ShuffleIcon, MenuBarsIcon } from '../components/Icons';
import SwipeableRow from '../components/SwipeableRow';
import DraggableRow from '../components/DraggableRow';
// import EQModal from '../components/EQModal'; // EQ hidden — not supported by react-native-track-player
import QueueModal from '../components/QueueModal';
import { EDGE_SWIPE_WIDTH } from '../utils/layout';
import { useListArt } from '../hooks/useListArt';

// Mirrors QueueModal's own ROW_HEIGHT — these rows are deliberately the same
// shape/size (see the comment on QueueModal's row rendering), so drag
// threshold math here matches the same way it does there.
const ROW_HEIGHT = 74;

const SORTS = [
    { id: 'alpha', label: 'A–Z' },
    { id: 'alpha_r', label: 'Z–A' },
    { id: 'plays', label: 'Most Played' },
    { id: 'plays_r', label: 'Least Played' },
];

export default function PlaylistDetailScreen() {
    const navigation = useNavigation();
    const route = useRoute();
    const { playlist } = route.params;
    const {
        playSongFromPlaylist, playPlaylistOrdered, playPlaylistShuffled, addToQueue,
    } = usePlayback();
    const { theme, base } = useTheme();

    const [search, setSearch] = useState('');
    const [sortId, setSortId] = useState('alpha');
    const [playCounts, setPlayCounts] = useState({});
    const [showSort, setShowSort] = useState(false);
    // const [showEQ, setShowEQ] = useState(false); // EQ hidden
    const [showQueue, setShowQueue] = useState(false);
    const [cover, setCover] = useState(null);
    const { showPlayCount, showSongCovers } = usePreferences();

    // Drag-to-reorder needs its OWN order — the list is normally always
    // driven by whichever of the 4 fixed sorts is active (alpha/plays/etc,
    // recomputed from playlist.songs below), so a manually dragged order
    // would just get silently overwritten by that recompute on the very
    // next render otherwise. Dragging a row switches sortId to this
    // internal 'custom' sort — not one of the tappable chips, only ever
    // reached by actually dragging something — which the sort logic below
    // uses instead of recomputing. Session-only, same as reorderPlaylists'
    // own playlist reordering (App.js) already is — nothing here persists
    // across an app restart either.
    const [customOrder, setCustomOrder] = useState(null); // array of song ids, or null
    const customOrderRef = useRef(null);
    const liveOrderRef = useRef(null); // live during an active drag only
    const [liveOrder, setLiveOrder] = useState(null);
    const dragKeyRef = useRef(null);
    const dragStartIndexRef = useRef(0);
    const dragCurrentIndexRef = useRef(0);
    const dragTranslateY = useRef(new Animated.Value(0)).current;
    const listRef = useRef(null);
    const listWrapRef = useRef(null);
    const listYRef = useRef(0);
    const scrollOffsetRef = useRef(0);
    const dragAbsoluteYRef = useRef(0);
    const autoScrollRAF = useRef(null);
    const [dragging, setDragging] = useState(false);

    useEffect(() => {
        getPlayCounts(playlist.songs).then(setPlayCounts);
        getPlaylistCovers().then(covers => setCover(covers[playlist.path] ?? null));
        getPlaylistSort(playlist.path).then(setSortId);
    }, []);

    // Stops the edge auto-scroll RAF loop if this screen unmounts mid-drag
    // (navigating away, e.g. via the back gesture, while still holding a
    // row) — same reasoning as QueueModal's own mid-drag safety effect.
    useEffect(() => () => stopAutoScroll(), []);

    const sorted = useMemo(() => {
        if (sortId === 'custom' && customOrder) {
            const byId = new Map(playlist.songs.map(s => [s.id, s]));
            const ordered = customOrder.map(id => byId.get(id)).filter(Boolean);
            // Anything not in customOrder (e.g. the playlist changed on disk
            // since the drag) just falls in at the end, in whatever order
            // playlist.songs already has it — better than silently dropping
            // a song than the list.
            const seen = new Set(customOrder);
            const extra = playlist.songs.filter(s => !seen.has(s.id));
            return [...ordered, ...extra];
        }
        let songs = [...playlist.songs];
        switch (sortId) {
            case 'alpha': songs.sort((a, b) => (a.ourTitle ?? a.title).localeCompare(b.ourTitle ?? b.title)); break;
            case 'alpha_r': songs.sort((a, b) => (b.ourTitle ?? b.title).localeCompare(a.ourTitle ?? a.title)); break;
            case 'plays': songs.sort((a, b) => (playCounts[b.id] ?? 0) - (playCounts[a.id] ?? 0)); break;
            case 'plays_r': songs.sort((a, b) => (playCounts[a.id] ?? 0) - (playCounts[b.id] ?? 0)); break;
        }
        return songs;
    }, [playlist.songs, sortId, playCounts, customOrder]);

    // Rendered instead of `sorted` while a drag is actually in progress —
    // see the same pattern in QueueModal (displayedPriorityRows/
    // displayedUpNextRows) for why this stays separate from the committed
    // order until the drag actually ends.
    const displayedSongs = dragging && liveOrder
        ? liveOrder.map(id => sorted.find(s => s.id === id)).filter(Boolean)
        : sorted;

    const stopAutoScroll = () => {
        if (autoScrollRAF.current) { cancelAnimationFrame(autoScrollRAF.current); autoScrollRAF.current = null; }
    };
    const startAutoScroll = () => {
        if (autoScrollRAF.current) return;
        const EDGE = 60, SPEED = 8;
        const tick = () => {
            const touchYInView = dragAbsoluteYRef.current - listYRef.current;
            let delta = 0;
            const viewH = 640; // rough visible-area guess, same reasoning as QueueModal's
            if (touchYInView < EDGE) delta = -SPEED;
            else if (touchYInView > viewH - EDGE) delta = SPEED;
            if (delta !== 0) {
                scrollOffsetRef.current = Math.max(0, scrollOffsetRef.current + delta);
                listRef.current?.scrollToOffset?.({ offset: scrollOffsetRef.current, animated: false });
            }
            autoScrollRAF.current = requestAnimationFrame(tick);
        };
        autoScrollRAF.current = requestAnimationFrame(tick);
    };

    const startDrag = (key) => {
        const order = sorted.map(s => s.id);
        const idx = order.indexOf(key);
        if (idx === -1) return;
        dragKeyRef.current = key;
        dragStartIndexRef.current = idx;
        dragCurrentIndexRef.current = idx;
        dragTranslateY.setValue(0);
        liveOrderRef.current = order;
        setLiveOrder(order);
        setDragging(true);
        startAutoScroll();
    };

    const moveDrag = (translationY, absoluteY) => {
        dragAbsoluteYRef.current = absoluteY;
        dragTranslateY.setValue(translationY);
        const order = liveOrderRef.current;
        if (!order) return;
        const shift = Math.round(translationY / ROW_HEIGHT);
        const target = Math.min(Math.max(dragStartIndexRef.current + shift, 0), order.length - 1);
        if (target !== dragCurrentIndexRef.current) {
            const newOrder = order.slice();
            const [item] = newOrder.splice(dragCurrentIndexRef.current, 1);
            newOrder.splice(target, 0, item);
            dragCurrentIndexRef.current = target;
            liveOrderRef.current = newOrder;
            setLiveOrder(newOrder);
        }
    };

    const endDrag = () => {
        stopAutoScroll();
        const order = liveOrderRef.current;
        Animated.timing(dragTranslateY, { toValue: 0, duration: 150, useNativeDriver: true }).start();
        setDragging(false);
        setLiveOrder(null);
        liveOrderRef.current = null;
        if (!order) return;
        customOrderRef.current = order;
        setCustomOrder(order);
        setSortId('custom');
    };

    const filtered = useMemo(() => {
        if (!search.trim()) return displayedSongs;
        const q = search.toLowerCase();
        return displayedSongs.filter(s =>
            (s.ourTitle ?? s.title ?? '').toLowerCase().includes(q) ||
            (s.ourArtist ?? s.artist ?? '').toLowerCase().includes(q)
        );
    }, [displayedSongs, search]);

    const artMap = useListArt(filtered, showSongCovers);

    // Tapping a song no longer force-opens the full player — the mini player
    // appearing at the bottom is the signal that something started playing.
    const play = async (song) => {
        await playSongFromPlaylist({ ...playlist, songs: sorted }, song.id);
    };

    const handlePlay = async () => {
        // Always starts in order — shuffle is something you turn ON, not a
        // state Play inherits from wherever shuffle was last left.
        await playPlaylistOrdered(playlist, sorted);
    };

    const handleShuffle = async () => {
        // Simple and direct: starts this playlist shuffled, every time you
        // tap it — not a live toggle. The Player screen's own shuffle icon
        // already covers "toggle shuffle on what's currently playing
        // without restarting it," so this doesn't need to duplicate that.
        await playPlaylistShuffled(playlist);
    };

    const changeCover = async () => {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
            Alert.alert('Permission needed', 'Allow Photos access in Settings to set a playlist cover.');
            return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.8,
        });
        if (result.canceled || !result.assets?.[0]?.uri) return;
        const permanentUri = await persistCoverImage(result.assets[0].uri);
        await setPlaylistCover(playlist.path, permanentUri);
        setCover(permanentUri);
    };

    const bg = playlistColor(playlist.name);
    // 'custom' is reachable only by dragging (see endDrag above) — it's
    // deliberately not one of the tappable SORTS chips, but still needs its
    // own label here so the button doesn't just show "Sort" once active.
    const sortLabel = sortId === 'custom' ? 'Custom' : (SORTS.find(s => s.id === sortId)?.label ?? 'Sort');

    return (
        <View style={[s.container, { backgroundColor: base.bg }]}>
            <StatusBar barStyle="light-content" />

            {/* Top bar: back, centered search, EQ + queue */}
            <View style={s.topBar}>
                <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={HIT} style={s.topBtn}>
                    <Text style={[s.backIcon, { color: theme.accent }]}>←</Text>
                </TouchableOpacity>
                <View style={{ flex: 1, marginHorizontal: 4, justifyContent: 'center' }}>
                    <TextInput
                        style={[s.searchBar, { backgroundColor: base.surface, marginHorizontal: 0 }]}
                        value={search}
                        onChangeText={setSearch}
                        placeholder="Search this playlist"
                        placeholderTextColor="#444"
                        textAlign="center"
                    />
                    {search.length > 0 && (
                        <TouchableOpacity style={s.clearBtn} onPress={() => setSearch('')} hitSlop={HIT}>
                            <Text style={s.clearBtnText}>✕</Text>
                        </TouchableOpacity>
                    )}
                </View>
                {/* EQ hidden — not supported by react-native-track-player */}
                {/* <TouchableOpacity onPress={() => setShowEQ(true)} hitSlop={HIT} style={s.topBtn}>
                    <Text style={[s.eqTag, { color: theme.accent }]}>EQ</Text>
                </TouchableOpacity> */}
                <TouchableOpacity onPress={() => setShowQueue(true)} hitSlop={HIT} style={s.topBtn}>
                    <MenuBarsIcon size={20} color={theme.accent} />
                </TouchableOpacity>
            </View>

            <View
                style={{ flex: 1 }}
                onLayout={() => {
                    // Same reasoning as QueueModal's own onLayout measure —
                    // needed by the edge auto-scroll loop to know where the
                    // visible area actually starts on screen. Measuring this
                    // wrapping View rather than the FlatList ref directly,
                    // since FlatList doesn't reliably expose measureInWindow
                    // itself across RN versions.
                    listWrapRef.current?.measureInWindow?.((x, y) => { listYRef.current = y; });
                }}
                ref={listWrapRef}
            >
                <FlatList
                    ref={listRef}
                    data={filtered}
                    keyExtractor={item => item.id}
                    contentContainerStyle={{ paddingBottom: 160 }}
                    scrollEventThrottle={16}
                    onScroll={(e) => { scrollOffsetRef.current = e.nativeEvent.contentOffset.y; }}
                    ListHeaderComponent={
                    <View>
                        <View style={s.coverWrap}>
                            <TouchableOpacity
                                style={[s.cover, { backgroundColor: bg, overflow: 'hidden', borderRadius: squircle(180) }]}
                                onLongPress={changeCover}
                                delayLongPress={200}
                                activeOpacity={0.85}
                            >
                                {cover
                                    ? <Image source={{ uri: cover }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                                    : <Text style={s.coverNote}>♪</Text>
                                }
                            </TouchableOpacity>
                        </View>

                        <View style={s.actionRow}>
                            <TouchableOpacity style={[s.playBtn, { backgroundColor: theme.accent }]} onPress={handlePlay}>
                                <PlayIcon size={16} color={theme.onAccent} />
                                <Text style={[s.playBtnText, { color: theme.onAccent }]}>Play</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={[s.shuffleBtn, { borderColor: theme.accentDim }]} onPress={handleShuffle}>
                                <ShuffleIcon size={16} color={theme.accent} />
                                <Text style={[s.shuffleBtnText, { color: theme.accent }]}>Shuffle</Text>
                            </TouchableOpacity>
                        </View>

                        <View style={s.titleRow}>
                            <View style={{ flex: 1 }}>
                                <Text style={s.title} numberOfLines={1}>{playlist.name}</Text>
                                <Text style={s.subtitle}>{playlist.songs.length} tracks</Text>
                            </View>
                            <TouchableOpacity style={s.sortBtn} onPress={() => setShowSort(v => !v)}>
                                <Text style={[s.sortBtnText, { color: theme.accent }]}>{sortLabel} ⌄</Text>
                            </TouchableOpacity>
                        </View>

                        {showSort && (
                            <View style={s.sortRow}>
                                {SORTS.map(opt => (
                                    <TouchableOpacity
                                        key={opt.id}
                                        style={[s.sortChip, sortId === opt.id && { backgroundColor: theme.accent }]}
                                        onPress={() => { setSortId(opt.id); setPlaylistSort(playlist.path, opt.id); setShowSort(false); }}
                                    >
                                        <Text style={[s.sortChipText, sortId === opt.id && { color: theme.onAccent }]}>
                                            {opt.label}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        )}
                    </View>
                }
                renderItem={({ item }) => {
                    const isDraggingThis = dragging && dragKeyRef.current === item.id;
                    return (
                        <DraggableRow
                            dragKey={item.id}
                            disabled={!!search.trim() || (dragging && !isDraggingThis)}
                            onDragStart={startDrag}
                            onDragMove={moveDrag}
                            onDragEnd={endDrag}
                        >
                            <Animated.View style={isDraggingThis ? {
                                transform: [{ translateY: dragTranslateY }, { scale: 1.03 }],
                                shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
                                elevation: 8, zIndex: 10,
                            } : null}>
                                <SwipeableRow onSwipeRight={() => addToQueue(item)} rightColor={theme.accent} edgeExclude={EDGE_SWIPE_WIDTH} disabled={dragging}>
                                    <TouchableOpacity
                                        style={[s.row, { backgroundColor: base.surface }]}
                                        onPress={() => { if (!dragging) play(item); }}
                                        activeOpacity={0.7}
                                    >
                                        {showSongCovers && (
                                            <View style={[s.thumb, { backgroundColor: base.bg }]}>
                                                {artMap[item.id]
                                                    ? <Image source={{ uri: artMap[item.id] }} style={s.thumbImg} resizeMode="cover" />
                                                    : <Text style={[s.thumbNote, { color: theme.accentDim }]}>♪</Text>
                                                }
                                            </View>
                                        )}
                                        <View style={{ flex: 1 }}>
                                            <Text style={s.rowTitle} numberOfLines={1}>{item.ourTitle ?? item.title}</Text>
                                            <Text style={s.rowSub} numberOfLines={1}>{item.ourArtist ?? item.artist}</Text>
                                        </View>
                                        {showPlayCount && playCounts[item.id] > 0 && (
                                            <Text style={s.playCount}>{playCounts[item.id]}×</Text>
                                        )}
                                    </TouchableOpacity>
                                </SwipeableRow>
                            </Animated.View>
                        </DraggableRow>
                    );
                }}
                />
            </View>

            {/* <EQModal visible={showEQ} onClose={() => setShowEQ(false)} playlistPath={playlist.path} /> */}
            <QueueModal visible={showQueue} onClose={() => setShowQueue(false)} />
        </View>
    );
}

const HIT = { top: 16, bottom: 16, left: 16, right: 16 };

const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0a0a0a' },
    topBar: { flexDirection: 'row', alignItems: 'center', paddingTop: 56, paddingHorizontal: 8, paddingBottom: 8 },
    topBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
    backIcon: { fontSize: 24 },
    eqTag: { fontSize: 14, fontWeight: '700' },
    searchBar: { flex: 1, marginHorizontal: 4, backgroundColor: '#141414', borderRadius: 10, paddingVertical: 9, paddingRight: 28, color: '#e5e5e5', fontSize: 14 },
    clearBtn: { position: 'absolute', right: 6, top: 0, bottom: 0, width: 24, justifyContent: 'center', alignItems: 'center' },
    clearBtnText: { color: '#555', fontSize: 14, fontWeight: '700' },
    coverWrap: { alignItems: 'center', marginTop: 8, marginBottom: 18 },
    cover: { width: 180, height: 180, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
    coverNote: { fontSize: 60, color: 'rgba(255,255,255,0.4)' },
    actionRow: { flexDirection: 'row', justifyContent: 'center', gap: 12, marginBottom: 22 },
    playBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24 },
    playBtnText: { fontSize: 15, fontWeight: '700' },
    shuffleBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 24, borderWidth: 1.5 },
    shuffleBtnText: { fontSize: 15, fontWeight: '700' },
    titleRow: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 20, marginBottom: 10 },
    title: { color: '#f0f0f0', fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
    subtitle: { color: '#555', fontSize: 13, marginTop: 4 },
    sortBtn: { paddingHorizontal: 12, paddingVertical: 8 },
    sortBtnText: { fontSize: 13, fontWeight: '600' },
    sortRow: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 20, paddingBottom: 10, gap: 8 },
    sortChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#1a1a1a' },
    sortChipText: { color: '#888', fontSize: 13, fontWeight: '600' },
    row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 20, marginHorizontal: 14, marginVertical: 2, borderRadius: 12, backgroundColor: '#0d0d0d' },
    rowTitle: { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
    rowSub: { color: '#555', fontSize: 12, marginTop: 3 },
    playCount: { color: '#333', fontSize: 12, marginLeft: 8 },
    thumb: { width: 42, height: 42, borderRadius: 8, marginRight: 12, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
    thumbImg: { width: '100%', height: '100%' },
    thumbNote: { fontSize: 18 },
});
