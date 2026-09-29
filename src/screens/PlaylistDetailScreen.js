import React, { useState, useEffect, useMemo } from 'react';
import {
    View, Text, FlatList, TouchableOpacity,
    StyleSheet, TextInput, StatusBar, Image, Alert,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useNavigation, useRoute } from '@react-navigation/native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { usePreferences } from '../context/PreferencesContext';
import { formatArtists, artistMatches } from '../utils/artists';
import { getPlayCounts, getPlaylistCovers, setPlaylistCover, persistCoverImage, getPlaylistSort, setPlaylistSort } from '../utils/storage';
import { playlistColor } from '../utils/color';
import { squircle } from '../utils/squircle';
import { PlayIcon, ShuffleIcon, MenuBarsIcon } from '../components/Icons';
import SwipeableRow from '../components/SwipeableRow';
import EQModal from '../components/EQModal';
import QueueModal from '../components/QueueModal';
import ScreenBackground from '../components/ScreenBackground';
import { EDGE_SWIPE_WIDTH } from '../utils/layout';
import { useListArt } from '../hooks/useListArt';

const SORTS = [
    { id: 'alpha', label: 'A–Z' },
    { id: 'alpha_r', label: 'Z–A' },
    { id: 'plays', label: 'Most Played' },
    { id: 'plays_r', label: 'Least Played' },
];

export default function PlaylistDetailScreen() {
    const navigation = useNavigation();
    const route = useRoute();
    const { playlist, initialCover } = route.params;
    const {
        playSongFromPlaylist, playPlaylistOrdered, playPlaylistShuffled, addToQueue,
    } = usePlayback();
    const { theme, base } = useTheme();

    const [search, setSearch] = useState('');
    const [sortId, setSortId] = useState('alpha');
    const [playCounts, setPlayCounts] = useState({});
    const [showSort, setShowSort] = useState(false);
    const [showEQ, setShowEQ] = useState(false);
    const [showQueue, setShowQueue] = useState(false);
    // Starts from whatever the Playlists grid already had in memory for
    // this playlist (passed through as a nav param — see openPlaylist's own
    // comment) instead of always null. When it's available, the real cover
    // is already on screen on the very first frame — no fetch, no
    // prefetch, no gap at all — rather than just no longer flashing blank
    // while it loads.
    const [cover, setCover] = useState(initialCover ?? null);
    const { showPlayCount, showSongCovers, artistSeparator, coverShape, showPlaylistTrackCount, artistDisplayJoin } = usePreferences();

    useEffect(() => {
        getPlayCounts(playlist.songs).then(setPlayCounts);
        // Real bug found here (this is the "background image flashes...
        // always when opening a playlist" report): setCover(uri) handed
        // the Image component a URI it hadn't decoded yet, so the very
        // first frame after this resolved rendered the empty/fallback
        // state while decode-from-disk caught up — a real, if brief,
        // black flash every single time, not just on a slow first load.
        // Image.prefetch() warms RN's own image cache for that URI BEFORE
        // cover ever gets set, so by the time the Image component
        // actually mounts with a real uri, it's already decoded and
        // renders on the very first frame instead of a blank one.
        getPlaylistCovers().then(covers => {
            const uri = covers[playlist.path] ?? null;
            if (!uri) { setCover(null); return; }
            Image.prefetch(uri).catch(() => { }).finally(() => setCover(uri));
        });
        getPlaylistSort(playlist.path).then(setSortId);
    }, []);

    // Same precompute-once-avoid-localeCompare reasoning as All Songs'
    // identical sort (see there for the full explanation) — playlists are
    // usually small enough that this isn't very noticeable, but there's no
    // reason for the same sort to be implemented two different ways, one
    // fast and one not, between the two screens.
    const titleKeyMap = useMemo(() => {
        const m = new Map();
        for (const s of playlist.songs) m.set(s.id, (s.ourTitle ?? s.title ?? '').toLowerCase());
        return m;
    }, [playlist.songs]);

    const sorted = useMemo(() => {
        let songs = [...playlist.songs];
        switch (sortId) {
            case 'alpha': songs.sort((a, b) => {
                const ta = titleKeyMap.get(a.id), tb = titleKeyMap.get(b.id);
                return ta < tb ? -1 : ta > tb ? 1 : 0;
            }); break;
            case 'alpha_r': songs.sort((a, b) => {
                const ta = titleKeyMap.get(a.id), tb = titleKeyMap.get(b.id);
                return ta > tb ? -1 : ta < tb ? 1 : 0;
            }); break;
            case 'plays': songs.sort((a, b) => (playCounts[b.id] ?? 0) - (playCounts[a.id] ?? 0)); break;
            case 'plays_r': songs.sort((a, b) => (playCounts[a.id] ?? 0) - (playCounts[b.id] ?? 0)); break;
        }
        return songs;
    }, [playlist.songs, sortId, playCounts, titleKeyMap]);

    const filtered = useMemo(() => {
        if (!search.trim()) return sorted;
        const q = search.toLowerCase();
        return sorted.filter(s =>
            (s.ourTitle ?? s.title ?? '').toLowerCase().includes(q) ||
            artistMatches(s.ourArtist ?? s.artist, artistSeparator, q)
        );
    }, [sorted, search, artistSeparator]);

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
            // Was 0.8 — these are grid thumbnails (~150px), not full-screen
            // images, so there's no real visual cost to compressing harder,
            // and a smaller file is faster to read off disk and decode on
            // every render. Doesn't reduce the actual pixel dimensions
            // (the native crop can still hand back a multi-megapixel
            // image — a real fix for that needs an image-resize library
            // this project doesn't have yet), but should meaningfully help
            // the flash/reload feel regardless.
            quality: 0.4,
        });
        if (result.canceled || !result.assets?.[0]?.uri) return;
        const permanentUri = await persistCoverImage(result.assets[0].uri);
        await setPlaylistCover(playlist.path, permanentUri);
        setCover(permanentUri);
    };

    const bg = base.surface; // neutral placeholder, see PlaylistsScreen's matching comment
    const sortLabel = SORTS.find(s => s.id === sortId)?.label ?? 'Sort';

    return (
        <ScreenBackground ownImage style={s.container}>
            <StatusBar barStyle="light-content" />

            {/* Top bar: back, centered search, EQ + queue */}
            <View style={s.topBar}>
                <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={HIT} style={s.topBtn}>
                    <Text style={[s.backIcon, { color: theme.accent }]}>←</Text>
                </TouchableOpacity>
                <View style={{ flex: 1, marginHorizontal: 4, justifyContent: 'center' }}>
                    <TextInput
                        style={[s.searchBar, { backgroundColor: base.surface, marginHorizontal: 0, color: base.text }]}
                        value={search}
                        onChangeText={setSearch}
                        placeholder="Search this playlist"
                        placeholderTextColor="#444"
                        textAlign="center"
                    />
                    {search.length > 0 && (
                        <TouchableOpacity style={s.clearBtn} onPress={() => setSearch('')} hitSlop={HIT}>
                            <Text style={[s.clearBtnText, { color: base.textFaint }]}>✕</Text>
                        </TouchableOpacity>
                    )}
                </View>
                {/* Wrapped with the same gap:6 PlayerScreen/AllSongsScreen use
                    between EQ and queue — this row had no gap at all before,
                    so the two 40x40 buttons sat flush against each other with
                    their 12px hitSlop zones actually overlapping. */}
                <View style={{ flexDirection: 'row', gap: 6 }}>
                    <TouchableOpacity onPress={() => setShowEQ(true)} hitSlop={HIT} style={s.topBtn}>
                        <Text style={[s.eqTag, { color: theme.accent }]}>EQ</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setShowQueue(true)} hitSlop={HIT} style={s.topBtn}>
                        <MenuBarsIcon size={20} color={theme.accent} />
                    </TouchableOpacity>
                </View>
            </View>

            <FlatList
                data={filtered}
                keyExtractor={item => item.id}
                contentContainerStyle={{ paddingBottom: 160 }}
                // Keep more rows mounted so covers already on screen stay decoded
                // while scrolling back, instead of reloading each time.
                initialNumToRender={14}
                windowSize={15}
                maxToRenderPerBatch={10}
                ListHeaderComponent={
                    <View>
                        <View style={s.coverWrap}>
                            <TouchableOpacity
                                style={[s.cover, { backgroundColor: bg, overflow: 'hidden', borderRadius: squircle(180, coverShape) }]}
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
                                <Text style={[s.title, { color: base.text }]} numberOfLines={1}>{playlist.name}</Text>
                                {showPlaylistTrackCount !== false && <Text style={[s.subtitle, { color: base.textFaint }]}>{playlist.songs.length} tracks</Text>}
                            </View>
                            <TouchableOpacity style={s.sortBtn} onPress={() => setShowSort(v => !v)}>
                                <Text style={[s.sortBtnText, { color: theme.accent }]}>{sortLabel}</Text>
                            </TouchableOpacity>
                        </View>

                        {showSort && (
                            <View style={s.sortRow}>
                                {SORTS.map(opt => (
                                    <TouchableOpacity
                                        key={opt.id}
                                        style={[s.sortChip, { backgroundColor: base.border }, sortId === opt.id && { backgroundColor: theme.accent }]}
                                        onPress={() => { setSortId(opt.id); setPlaylistSort(playlist.path, opt.id); setShowSort(false); }}
                                    >
                                        <Text style={[s.sortChipText, { color: base.textDim }, sortId === opt.id && { color: theme.onAccent }]}>
                                            {opt.label}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        )}
                    </View>
                }
                renderItem={({ item }) => (
                    <SwipeableRow onSwipeRight={() => addToQueue(item)} rightColor={theme.accent} edgeExclude={EDGE_SWIPE_WIDTH}>
                        <TouchableOpacity style={[s.row, { backgroundColor: base.surface }]} onPress={() => play(item)} activeOpacity={0.7}>
                            {showSongCovers && (
                                <View style={[s.thumb, { backgroundColor: base.bg, borderRadius: squircle(42, coverShape) }]}>
                                    {artMap[item.id]
                                        ? <Image source={{ uri: artMap[item.id] }} style={s.thumbImg} resizeMode="cover" />
                                        : <Text style={[s.thumbNote, { color: theme.accentDim }]}>♪</Text>
                                    }
                                </View>
                            )}
                            <View style={{ flex: 1 }}>
                                <Text style={[s.rowTitle, { color: base.text }]} numberOfLines={1}>{item.ourTitle ?? item.title}</Text>
                                <Text style={[s.rowSub, { color: base.textFaint }]} numberOfLines={1}>{formatArtists(item.ourArtist ?? item.artist, artistSeparator, artistDisplayJoin)}</Text>
                            </View>
                            {showPlayCount && playCounts[item.id] > 0 && (
                                <Text style={[s.playCount, { color: base.textFaint }]}>{playCounts[item.id]}×</Text>
                            )}
                        </TouchableOpacity>
                    </SwipeableRow>
                )}
            />

            <EQModal visible={showEQ} onClose={() => setShowEQ(false)} playlistPath={playlist.path} />
            <QueueModal visible={showQueue} onClose={() => setShowQueue(false)} />
        </ScreenBackground>
    );
}

const HIT = { top: 16, bottom: 16, left: 16, right: 16 };

const s = StyleSheet.create({
    container: { flex: 1 },
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
    thumb: { width: 42, height: 42, marginRight: 12, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
    thumbImg: { width: '100%', height: '100%' },
    thumbNote: { fontSize: 18 },
});
