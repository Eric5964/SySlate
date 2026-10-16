import React, { useContext, useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
    View, Text, FlatList, TouchableOpacity, Image,
    TextInput, StyleSheet, StatusBar, Keyboard, TouchableWithoutFeedback,
} from 'react-native';
import { useNavigation, useScrollToTop, useFocusEffect } from '@react-navigation/native';
import { LibraryContext } from '../context/LibraryContext';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { usePreferences } from '../context/PreferencesContext';
import { formatArtists, artistMatches } from '../utils/artists';
import SwipeableRow from '../components/SwipeableRow';
import EQModal from '../components/EQModal';
import QueueModal from '../components/QueueModal';
import { MenuBarsIcon } from '../components/Icons';
import { getPlayCounts, getPlaylistSort, setPlaylistSort } from '../utils/storage';
import { useListArt } from '../hooks/useListArt';
import { squircle } from '../utils/squircle';
import { COVER_SHADOW } from '../utils/shadow';
import { pillPad, PILL_COVER, TOP_PAD, TOP_FADE, addedClearance, OVERLAY_HEADER, useMeasuredHeight } from '../utils/layout';
import TopBarBack from '../components/TopBarFade';
import ScreenBackground from '../components/ScreenBackground';
import { titleKey, compareKeys } from '../utils/sortKey';

// Reuses the exact same 4 sorts as the playlist screen, for the same reason
// they're offered there — this list is functionally "the All Songs
// playlist," so the same sorting makes sense here too.
const SORTS = [
    { id: 'alpha', label: 'A–Z' },
    { id: 'alpha_r', label: 'Z–A' },
    { id: 'plays', label: 'Most Played' },
    { id: 'plays_r', label: 'Least Played' },
];

// Storage key for the persisted sort choice — reuses getPlaylistSort/
// setPlaylistSort (keyed by playlist path) rather than adding a parallel
// storage function, with '__all__' as the key since that's already the
// path this screen's pseudo-playlist object uses everywhere else (see
// `play` below).
const ALL_SONGS_KEY = '__all__';

export default function AllSongsScreen() {
    const { allSongs } = useContext(LibraryContext);
    const { playSongFromPlaylist, addToQueue } = usePlayback();
    const { theme, base } = useTheme();
    const navigation = useNavigation();
    const [search, setSearch] = useState('');
    const [showEQ, setShowEQ] = useState(false);
    const [showQueue, setShowQueue] = useState(false);
    const [playCounts, setPlayCounts] = useState({});
    const [sortId, setSortId] = useState('alpha');
    const [showSort, setShowSort] = useState(false);
    const { showPlayCount, showSongCovers, artistSeparator, coverShape, artistDisplayJoin, topBarColor, performanceMode, ui } = usePreferences();
    const [hdrH, onHdrLayout] = useMeasuredHeight(TOP_PAD + 48 + TOP_FADE + 52);

    const listRef = useRef(null);
    useScrollToTop(listRef); // tapping the All Songs tab again while already on it scrolls to top

    // Tapping the All Songs tab again while already on it also clears the
    // search, same idea as tapping Playlists again backing out of a
    // playlist — "return to the top-level state of this tab."
    useEffect(() => {
        const sub = navigation.addListener('tabPress', () => {
            if (navigation.isFocused()) setSearch('');
        });
        return sub;
    }, [navigation]);

    // "Combine songs... with the same name & artist" — same song sitting in
    // multiple playlists showed up as multiple rows here. First occurrence
    // wins (order doesn't matter per Eric). Deduping HERE (not just visually)
    // means the queue built for playback also only ever has one entry per
    // song, so skip/shuffle naturally never lands on a duplicate — playlist
    // associations are dropped entirely, as confirmed not to matter.
    const dedupedSongs = useMemo(() => {
        const seen = new Set();
        const out = [];
        for (const s of allSongs) {
            const key = `${(s.title || '').trim().toLowerCase()}::${(s.artist || '').trim().toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(s);
        }
        return out;
    }, [allSongs]);

    // Read again every time the tab is shown: this screen stays mounted, so counts (and the
    // Most Played order) used to stay as they were when the library last loaded.
    useFocusEffect(useCallback(() => {
        let cancelled = false;
        getPlayCounts(dedupedSongs).then(c => { if (!cancelled) setPlayCounts(c); });
        return () => { cancelled = true; };
    }, [dedupedSongs]));
    useEffect(() => { getPlaylistSort(ALL_SONGS_KEY).then(setSortId); }, []);

    // Precomputed once per song instead of inside the sort comparator —
    // .sort() calls its comparator O(n log n) times, and recomputing
    // .toLowerCase() on the same strings that many times over adds up on a
    // real library. Also switched from .localeCompare() to plain string
    // comparison (< / >): localeCompare does real locale-aware Unicode work
    // under the hood and is well known to be substantially slower than a
    // plain comparison in JS engines (including Hermes, which RN normally
    // uses) — for a couple thousand songs, that difference across tens of
    // thousands of comparisons is exactly what "sorting is slow" was.
    const titleKeyMap = useMemo(() => {
        const m = new Map();
        for (const s of dedupedSongs) m.set(s.id, titleKey(s.title || ''));
        return m;
    }, [dedupedSongs]);

    const sorted = useMemo(() => {
        let songs = [...dedupedSongs];
        switch (sortId) {
            case 'alpha': songs.sort((a, b) => compareKeys(titleKeyMap.get(a.id), titleKeyMap.get(b.id))); break;
            case 'alpha_r': songs.sort((a, b) => compareKeys(titleKeyMap.get(b.id), titleKeyMap.get(a.id))); break;
            case 'plays': songs.sort((a, b) => ((playCounts[b.id] ?? 0) - (playCounts[a.id] ?? 0)) || compareKeys(titleKeyMap.get(a.id), titleKeyMap.get(b.id))); break;
            case 'plays_r': songs.sort((a, b) => ((playCounts[a.id] ?? 0) - (playCounts[b.id] ?? 0)) || compareKeys(titleKeyMap.get(a.id), titleKeyMap.get(b.id))); break;
        }
        return songs;
    }, [dedupedSongs, sortId, playCounts, titleKeyMap]);

    const filtered = useMemo(() => {
        if (!search.trim()) return sorted;
        const q = search.toLowerCase();
        return sorted.filter(s =>
            (s.title || '').toLowerCase().includes(q) || artistMatches(s.artist, artistSeparator, q)
        );
    }, [sorted, search, artistSeparator]);

    const artMap = useListArt(filtered, showSongCovers);

    const play = async (song) => {
        const playlist = { name: 'All Songs', path: ALL_SONGS_KEY, songs: sorted };
        await playSongFromPlaylist(playlist, song.id);
    };

    // Stable wrappers: `play` and `addToQueue` are new functions on every
    // render, which would defeat the memoized SongRow. These keep the same
    // identity and always call the latest version.
    const playRef = useRef(play);
    playRef.current = play;
    const addToQueueRef = useRef(addToQueue);
    addToQueueRef.current = addToQueue;
    const stablePlay = useCallback((song) => playRef.current(song), []);
    const stableAddToQueue = useCallback((song) => addToQueueRef.current(song, 'All Songs'), []);

    const sortLabel = SORTS.find(o => o.id === sortId)?.label ?? 'Sort';

    return (
        <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
        <ScreenBackground style={s.container}>
            <StatusBar barStyle="light-content" />

            {/* Same top row as the playlist screen and the player: EQ and
                queue sit in the exact same top-right spot on every screen.
                Title on the left where the back arrow would be. */}
            {/* Title row + search/sort together: with a transparent top bar this
                whole block floats over the list (which scrolls behind it). */}
            <View style={[{ zIndex: 5 }, !topBarColor && OVERLAY_HEADER]} pointerEvents={topBarColor ? 'auto' : 'box-none'} onLayout={onHdrLayout}>
            <View style={s.topRow}>
                {topBarColor && <TopBarBack color={base.surface} />}
                <Text style={[s.title, { color: base.text, flex: 1, marginLeft: 16 }]}>All Songs</Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                    {ui.as_eq !== false && (
                        <TouchableOpacity onPress={() => setShowEQ(true)} hitSlop={HIT} style={s.topBtn}>
                            <Text style={[s.eqTag, { color: theme.accent }]}>EQ</Text>
                        </TouchableOpacity>
                    )}
                    {ui.as_queue !== false && (
                        <TouchableOpacity onPress={() => setShowQueue(true)} hitSlop={HIT} style={s.topBtn}>
                            <MenuBarsIcon size={20} color={theme.accent} />
                        </TouchableOpacity>
                    )}
                </View>
            </View>

            {/* Search with Sort right beside it; the sort choices open
                underneath the search bar. */}
            {true && (
            <View style={s.searchBlock}>
                <View style={s.searchRow}>
                    {true ? (
                    <View style={{ flex: 1, justifyContent: 'center' }}>
                        <TextInput
                            style={[s.searchBar, { backgroundColor: base.surface, color: base.text }]}
                            value={search} onChangeText={setSearch}
                            placeholder="Search songs, artists..."
                            placeholderTextColor="#444"
                        />
                        {search.length > 0 && (
                            <TouchableOpacity style={s.clearBtn} onPress={() => { setSearch(''); Keyboard.dismiss(); }} hitSlop={HIT}>
                                <Text style={[s.clearBtnText, { color: base.textFaint }]}>✕</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                    ) : <View style={{ flex: 1 }} />}
                    <TouchableOpacity style={s.sortBtn} onPress={() => setShowSort(v => !v)} hitSlop={HIT}>
                        <Text style={[s.sortBtnText, { color: theme.accent }]} numberOfLines={1}>{sortLabel}</Text>
                    </TouchableOpacity>
                </View>
                {showSort && (
                    <View style={s.sortRow}>
                        {SORTS.map(opt => (
                            <TouchableOpacity
                                key={opt.id}
                                style={[s.sortChip, { backgroundColor: base.border }, sortId === opt.id && { backgroundColor: theme.accent }]}
                                onPress={() => { setSortId(opt.id); setPlaylistSort(ALL_SONGS_KEY, opt.id); setShowSort(false); }}
                            >
                                <Text style={[s.sortChipText, { color: base.textDim }, sortId === opt.id && { color: theme.onAccent }]}>
                                    {opt.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                )}
            </View>
            )}
            </View>

            {allSongs.length === 0 ? (
                <View style={s.empty}>
                    <Text style={[s.emptyTitle, { color: base.text }]}>No songs found</Text>
                    <Text style={[s.emptyText, { color: base.textFaint }]}>Add music folders or files to your music folder{'\n'}(Settings → Music & Library shows where),{'\n'}or use Import Songs</Text>
                </View>
            ) : (
                <FlatList
                    ref={listRef}
                    data={filtered}
                    keyExtractor={item => item.id}
                    contentContainerStyle={{ paddingTop: topBarColor ? 0 : hdrH, paddingBottom: 150 }}
                    scrollIndicatorInsets={topBarColor ? undefined : { top: hdrH }}
                    // Keep more rows mounted so covers already on screen stay decoded
                    // while scrolling back, instead of reloading each time.
                    initialNumToRender={performanceMode ? 8 : 14}
                    windowSize={performanceMode ? 5 : 15}
                    maxToRenderPerBatch={performanceMode ? 4 : 10}
                    updateCellsBatchingPeriod={performanceMode ? 90 : 50}
                    onScrollBeginDrag={Keyboard.dismiss}
                    renderItem={({ item }) => (
                    <SongRow
                        item={item}
                        art={artMap[item.id]}
                        count={playCounts[item.id]}
                        showSongCovers={showSongCovers}
                        showPlayCount={showPlayCount}
                        coverShape={coverShape}
                        artistSeparator={artistSeparator}
                        artistDisplayJoin={artistDisplayJoin}
                        theme={theme}
                        base={base}
                        onPlay={stablePlay}
                        onQueue={stableAddToQueue}
                    />
                )}
                />
            )}

            <EQModal visible={showEQ} onClose={() => setShowEQ(false)} />
            <QueueModal visible={showQueue} onClose={() => setShowQueue(false)} />
        </ScreenBackground>
        </TouchableWithoutFeedback>
    );
}

const HIT = { top: 12, bottom: 12, left: 12, right: 12 };

// One song row. Memoized so that unrelated state changes on this screen
// (opening the queue or EQ sheet, a cover finishing loading for another
// row, the play counts arriving) do not re-render every visible row, which
// is what made the sheets stutter when they opened and closed.
const SongRow = React.memo(function SongRow({ item, art, count, showSongCovers, showPlayCount, coverShape, artistSeparator, artistDisplayJoin, theme, base, onPlay, onQueue }) {
    const { songPillShadow } = usePreferences();
    return (
        <SwipeableRow onSwipeRight={() => onQueue(item)} rightColor={theme.accent}>
            <TouchableOpacity style={[s.row, { backgroundColor: base.surface, flexDirection: 'row', alignItems: 'center' }, pillPad(showSongCovers), songPillShadow && COVER_SHADOW]} onPress={() => onPlay(item)} activeOpacity={0.7}>
                {showSongCovers && (
                    <View style={[s.thumb, { backgroundColor: base.surface, borderRadius: squircle(PILL_COVER, coverShape) }]}>
                        {art
                            ? <Image source={{ uri: art }} style={s.thumbImg} resizeMode="cover" />
                            : null
                        }
                    </View>
                )}
                <View style={{ flex: 1, marginRight: addedClearance(showPlayCount ? count : 0) }}>
                    <Text style={[s.rowTitle, { color: base.text }]} numberOfLines={1}>{item.title}</Text>
                    <Text style={[s.rowSub, { color: base.textFaint }]} numberOfLines={1}>{formatArtists(item.artist, artistSeparator, artistDisplayJoin)}</Text>
                </View>
                {showPlayCount && count > 0 && (
                    <Text style={[s.playCount, { color: base.textFaint }]}>{count}×</Text>
                )}
            </TouchableOpacity>
        </SwipeableRow>
    );
});

const s = StyleSheet.create({
    container: { flex: 1 },
    topRow: { flexDirection: 'row', alignItems: 'center', paddingTop: TOP_PAD, paddingHorizontal: 8, paddingBottom: 8 + TOP_FADE, zIndex: 5 },
    searchBlock: { paddingHorizontal: 16, paddingBottom: 10 },
    // Was 'flex-end' — with paddingTop:60 identical to Playlists' own
    // header, this was the actual cause of "All Songs title sits lower
    // than Playlists" — flex-end bottom-aligns the title against the
    // sortBtn next to it instead of top-aligning it like Playlists' header
    // (flex-start) does.
    title: { color: '#e5e5e5', fontSize: 28, fontWeight: '700' },
    sortBtn: { paddingHorizontal: 12, paddingVertical: 8 },
    sortBtnText: { fontSize: 13, fontWeight: '600' },
    sortRow: { flexDirection: 'row', flexWrap: 'wrap', paddingTop: 10, gap: 8 },
    sortChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#1a1a1a' },
    sortChipText: { color: '#888', fontSize: 13, fontWeight: '600' },
    searchRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    searchBar: { borderRadius: 10, paddingVertical: 9, paddingHorizontal: 14, paddingRight: 32, color: '#e5e5e5', fontSize: 14 },
    clearBtn: { position: 'absolute', right: 8, top: 0, bottom: 0, width: 24, justifyContent: 'center', alignItems: 'center' },
    clearBtnText: { color: '#555', fontSize: 14, fontWeight: '700' },
    topBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
    eqTag: { fontSize: 16, fontWeight: "700" },
    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 40 },
    emptyTitle: { color: '#e5e5e5', fontSize: 18, fontWeight: '600', marginBottom: 12 },
    emptyText: { color: '#555', fontSize: 14, textAlign: 'center', lineHeight: 22 },
    row: { paddingVertical: 14, paddingHorizontal: 20, marginHorizontal: 14, marginVertical: 2, borderRadius: 12, backgroundColor: '#0d0d0d' },
    rowTitle: { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
    rowSub: { color: '#555', fontSize: 12, marginTop: 3 },
    playCount: { color: '#333', fontSize: 12, marginLeft: 8 },
    thumb: { width: 44, height: 44, marginRight: 12, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
    thumbImg: { width: '100%', height: '100%' },
    thumbNote: { fontSize: 18 },
});
