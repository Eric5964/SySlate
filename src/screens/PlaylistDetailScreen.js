import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
    View, Text, FlatList, TouchableOpacity,
    StyleSheet, TextInput, StatusBar, Image, Alert, Animated,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useNavigation, useRoute } from '@react-navigation/native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { usePreferences } from '../context/PreferencesContext';
import { formatArtists, artistMatches } from '../utils/artists';
import { subscribeDurations } from '../utils/durations';
import useLivePlayCounts from '../hooks/useLivePlayCounts';
import { getCustomPresets, getEQOverrides, toStablePath, getSongsTotalLength, subscribePlayCount, getPlaylistCovers, setPlaylistCover, persistCoverImage, getPlaylistSort, setPlaylistSort } from '../utils/storage';
import { squircle, cardRadius } from '../utils/squircle';
import { PlayIcon, ShuffleIcon, MenuBarsIcon } from '../components/Icons';
import SwipeableRow from '../components/SwipeableRow';
import DimPressable from '../components/DimPressable';
import SongVisualizer from '../components/SongVisualizer';
import BackSwipeZone from '../components/BackSwipeZone';
import SwipeQueueButton from '../components/SwipeQueueButton';
import EQModal from '../components/EQModal';
import { getPresetById } from '../utils/eq';
import QueueModal from '../components/QueueModal';
import ScreenBackground from '../components/ScreenBackground';
import { EDGE_SWIPE_WIDTH, pillPad, PILL_COVER, TOP_PAD, TOP_FADE, addedClearance, OVERLAY_HEADER, useMeasuredHeight } from '../utils/layout';
import { COVER_SHADOW } from '../utils/shadow';
import TopBarBack from '../components/TopBarFade';
import { useListArt, setVisibleArtIds } from '../hooks/useListArt';
import { titleKey, compareKeys } from '../utils/sortKey';
import { vizRowId } from '../utils/vizMatch';
import { useVizPending } from '../utils/vizPending';

const SORTS = [
    { id: 'alpha', label: 'A–Z' },
    { id: 'alpha_r', label: 'Z–A' },
    { id: 'plays', label: 'Most Played' },
    { id: 'plays_r', label: 'Least Played' },
];

// What this screen falls back to when it's opened without a playlist param
// (a restored navigation state, a deep link, a fast refresh in development):
// route.params is undefined in those cases, and destructuring it used to throw
// before anything rendered at all. An empty playlist instead renders the
// screen's normal "no tracks" state.
const NO_PLAYLIST = { path: '', name: '', songs: [] };

export default function PlaylistDetailScreen() {
    const navigation = useNavigation();
    const route = useRoute();
    const { playlist = NO_PLAYLIST, initialCover } = route.params ?? {};
    const {
        playSongFromPlaylist, playPlaylistOrdered, playPlaylistShuffled, addToQueue, queuePlaylistNext, queueEpoch,
        currentTrack, currentPlaylist, songEQMap, assignSongEQ, eqLayer,
    } = usePlayback();
    const { theme, base } = useTheme();

    const [search, setSearch] = useState('');
    const [sortId, setSortId] = useState('alpha');
    const { sortCounts: playCounts, live: liveCounts, refreshSort, countFor } = useLivePlayCounts(playlist.songs);
    // Total length of the playlist ("3:12", hours:minutes; "~" while some songs have not been
    // played yet, since their length is not known until then).
    const [totalLenText, setTotalLenText] = useState('');
    useEffect(() => {
        let alive = true;
        const calc = () => getSongsTotalLength(playlist.songs).then(r => {
            if (!alive) return;
            if (r.none || !(r.seconds > 0)) { setTotalLenText(''); return; }
            const mins = Math.round(r.seconds / 60);
            const h = Math.floor(mins / 60), m = mins % 60;
            setTotalLenText((r.estimated ? '~' : '') + `${h}:${String(m).padStart(2, '0')}`);
        });
        calc();
        const off = subscribePlayCount(calc);   // a newly learned song length improves the total
        const off2 = subscribeDurations(calc);
        return () => { alive = false; off(); off2(); };
    }, [playlist.songs]);
    // Shown counts go up at once; the order only follows the snapshot, which is read
    // again when the screen opens, the sort is changed, or a different queue is played.
    // Starting a song from this list changes the queue, which used to read a new order and make the list
    // jump. Now the order stays put while the screen is open (numbers still go up), and opening the list
    // again keeps the order it had, unless another playlist was played in between.
    const playingSrc = currentPlaylist?.path ?? currentPlaylist?.name ?? null;
    const playingSrcRef = useRef(playingSrc);
    playingSrcRef.current = playingSrc;
    useEffect(() => { refreshSort({ cacheKey: playlist.path, source: playingSrcRef.current }); }, [playlist.songs, refreshSort]);
    const [showSort, setShowSort] = useState(false);
    const [showEQ, setShowEQ] = useState(false);
    // Assigning an EQ to songs: pick the EQ, tick the songs (a check on the cover), apply.
    const [pickEQ, setPickEQ] = useState(false);
    const [assign, setAssign] = useState(null);   // null, or { presetId, name, selected: { [songId]: true } }
    // Name of the EQ assigned to each song here, shown after the artist.
    const [eqNameList, setEqNameList] = useState({ cp: [], ov: {} });
    useEffect(() => { Promise.all([getCustomPresets(), getEQOverrides()]).then(([cp, ov]) => setEqNameList({ cp, ov })); }, [assign, showEQ, pickEQ]);
    const songEQNames = useMemo(() => {
        const out = {};
        if (!eqLayer) return out;   // assignments are ignored while "EQ per playlist and song" is off
        for (const sg of playlist.songs || []) {
            const id = songEQMap[toStablePath(sg.id)];
            if (id) out[sg.id] = getPresetById(id, eqNameList.cp, eqNameList.ov).name;
        }
        return out;
    }, [songEQMap, playlist.songs, eqNameList, eqLayer]);
    const toggleAssign = useCallback((song) => {
        setAssign(a => { if (!a) return a; const sel = { ...a.selected }; if (sel[song.id]) delete sel[song.id]; else sel[song.id] = true; return { ...a, selected: sel }; });
    }, []);
    const [showQueue, setShowQueue] = useState(false);
    // Starts from whatever the Playlists grid already had in memory for
    // this playlist (passed through as a nav param — see openPlaylist's own
    // comment) instead of always null. When it's available, the real cover
    // is already on screen on the very first frame — no fetch, no
    // prefetch, no gap at all — rather than just no longer flashing blank
    // while it loads.
    const [cover, setCover] = useState(initialCover ?? null);
    const { showPlayCount, showSongCovers, artistSeparator, coverShape, showPlaylistTrackCount, showPlaylistTitles, artistDisplayJoin, detailOutline, playlistCoverShadow, performanceMode, topBarColor, ui, vizMode } = usePreferences();
    // The visualizer shows on the playing song wherever it is listed here, also when the
    // sound is coming from another playlist or the queue (display only, nothing is re-queued).
    const vizPendingSong = useVizPending();
    const vizId = useMemo(
        () => (vizMode !== 'off' && !performanceMode) ? vizRowId(playlist.songs, vizPendingSong || currentTrack) : null,
        [vizMode, performanceMode, playlist.songs, currentTrack, vizPendingSong]
    );
    const vizExtra = useMemo(() => ({ liveCounts, vizId }), [liveCounts, vizId]);
    const [hdrH, onHdrLayout] = useMeasuredHeight(TOP_PAD + 48 + TOP_FADE);

    useEffect(() => {
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
        for (const s of playlist.songs) m.set(s.id, titleKey(s.ourTitle ?? s.title ?? ''));
        return m;
    }, [playlist.songs]);

    const sorted = useMemo(() => {
        let songs = [...playlist.songs];
        switch (sortId) {
            case 'alpha': songs.sort((a, b) => compareKeys(titleKeyMap.get(a.id), titleKeyMap.get(b.id))); break;
            case 'alpha_r': songs.sort((a, b) => compareKeys(titleKeyMap.get(b.id), titleKeyMap.get(a.id))); break;
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
    const onViewable = useRef(({ viewableItems }) => setVisibleArtIds(viewableItems.map(v => v.item?.id).filter(Boolean))).current;
    const viewCfg = useRef({ itemVisiblePercentThreshold: 10 }).current;

    // Tapping a song no longer force-opens the full player — the mini player
    // appearing at the bottom is the signal that something started playing.
    const play = async (song) => {
        await playSongFromPlaylist({ ...playlist, songs: sorted }, song.id);
    };

    // Stable wrappers: `play` and `addToQueue` are new functions on every
    // render, which would defeat the memoized SongRow. These keep the same
    // identity and always call the latest version.
    const playRef = useRef(play);
    playRef.current = play;
    const addToQueueRef = useRef(addToQueue);
    addToQueueRef.current = addToQueue;
    const stablePlay = useCallback((song) => playRef.current(song), []);
    const stableAddToQueue = useCallback((song) => addToQueueRef.current(song, playlist?.name), [playlist?.name]);

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

    // Swiping a button right queues this playlist to take over after the
    // current song (Play = in order, Shuffle = shuffled); the button shows a
    // quick "Added". With nothing playing there is nothing to wait for, so it
    // just starts.
    const swipeQueue = async (shuffled) => {
        const r = await queuePlaylistNext(playlist, shuffled, shuffled ? undefined : sorted);
        if (!r.ok && r.reason === 'nothing-playing') { if (shuffled) handleShuffle(); else handlePlay(); }
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
        const permanentUri = await persistCoverImage(result.assets[0].uri, 600);
        await setPlaylistCover(playlist.path, permanentUri);
        setCover(permanentUri);
    };

    const bg = base.surface; // neutral placeholder, see PlaylistsScreen's matching comment
    const sortLabel = SORTS.find(s => s.id === sortId)?.label ?? 'Sort';
    const backX = useRef(new Animated.Value(0)).current;   // the whole screen slides with a back swipe that starts off the edge

    return (
        <Animated.View style={{ flex: 1, transform: [{ translateX: backX.interpolate({ inputRange: [0, 10000], outputRange: [0, 10000], extrapolate: 'clamp' }) }] }}>
        <ScreenBackground ownImage style={s.container}>
            <StatusBar barStyle="light-content" />

            {/* Top bar: back, centered search, EQ + queue */}
            <BackSwipeZone navigation={navigation} dragX={backX} onBack={() => navigation.goBack()} style={[s.topBar, OVERLAY_HEADER, { zIndex: 5 }]} pointerEvents={topBarColor ? 'auto' : 'box-none'} onLayout={onHdrLayout}>
                {topBarColor && <TopBarBack color={base.surface} />}
                {ui.pd_back !== false ? (
                    <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={HIT} style={s.topBtn}>
                        <Text style={[s.backIcon, { color: theme.accent }]}>←</Text>
                    </TouchableOpacity>
                ) : <View style={s.topBtn} />}
                {ui.pd_search !== false ? (
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
                ) : <View style={{ flex: 1 }} />}
                {/* Wrapped with the same gap:6 PlayerScreen/AllSongsScreen use
                    between EQ and queue — this row had no gap at all before,
                    so the two 40x40 buttons sat flush against each other with
                    their 12px hitSlop zones actually overlapping. */}
                <View style={{ flexDirection: 'row', gap: 6 }}>
                    {ui.pd_eq !== false ? (
                    <TouchableOpacity onPress={() => setShowEQ(true)} hitSlop={HIT} style={s.topBtn}>
                        <Text style={[s.eqTag, { color: theme.accent }]}>EQ</Text>
                    </TouchableOpacity>
                    ) : <View style={s.topBtn} />}
                    {ui.pd_queue !== false ? (
                    <TouchableOpacity onPress={() => setShowQueue(true)} hitSlop={HIT} style={s.topBtn}>
                        <MenuBarsIcon size={20} color={theme.accent} />
                    </TouchableOpacity>
                    ) : <View style={s.topBtn} />}
                </View>
            </BackSwipeZone>

            <FlatList
                data={filtered}
                onViewableItemsChanged={onViewable}
                viewabilityConfig={viewCfg}
                extraData={vizExtra}
                keyExtractor={item => item.id}
                // Colored bar: the list runs up under the bar's soft fade (as on
                // Playlists and Settings) instead of starting below it, which
                // used to cut the rows off with a band of plain background.
                // The bar floats over the list (always above it, so its buttons
                // can be tapped); rows start under the bar's fade.
                contentContainerStyle={{ flexGrow: 1 }}
                scrollIndicatorInsets={topBarColor ? undefined : { top: hdrH }}
                // Keep more rows mounted so covers already on screen stay decoded
                // while scrolling back, instead of reloading each time.
                initialNumToRender={performanceMode ? 8 : 14}
                windowSize={performanceMode ? 5 : 15}
                maxToRenderPerBatch={performanceMode ? 4 : 10}
                updateCellsBatchingPeriod={performanceMode ? 90 : 50}
                ListFooterComponent={<BackSwipeZone navigation={navigation} dragX={backX} onBack={() => navigation.goBack()} style={{ flexGrow: 1, minHeight: 160, marginTop: 8 }} />}
                ListHeaderComponent={
                    <View>
                        {/* The space under the top bar. It used to be padding on the
                            list; as a real view a right swipe on it can go back. */}
                        <BackSwipeZone navigation={navigation} dragX={backX} onBack={() => navigation.goBack()} style={{ height: topBarColor ? Math.max(0, hdrH - TOP_FADE) : hdrH }} />
                        {ui.pd_cover !== false && (
                        <BackSwipeZone navigation={navigation} dragX={backX} onBack={() => navigation.goBack()} style={s.coverWrap}>
                            {/* Card-style outline, same look as the cards on the Playlists screen. */}
                            {detailOutline && (
                                <View pointerEvents="none" style={[{ position: 'absolute', width: 186, height: 186, top: -3, borderRadius: cardRadius(180, 3, coverShape), backgroundColor: base.surface }, playlistCoverShadow && COVER_SHADOW]} />
                            )}
                            <TouchableOpacity
                                style={[s.cover, { backgroundColor: bg, overflow: 'hidden', borderRadius: squircle(180, coverShape) }]}
                                onLongPress={changeCover}
                                delayLongPress={200}
                                activeOpacity={0.85}
                            >
                                {cover
                                    ? <Image source={{ uri: cover }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                                    : null
                                }
                            </TouchableOpacity>
                        </BackSwipeZone>
                        )}

                        <View style={s.actionRow}>
                            {ui.pd_play !== false && (
                            <SwipeQueueButton onSwipe={() => swipeQueue(false)}>
                            {(added) => (
                            <TouchableOpacity style={[s.playBtn, { backgroundColor: theme.accent }]} onPress={handlePlay}>
                                {/* The label swaps for "Added" inside the same pill: same size, same colours. */}
                                <Animated.View style={[s.btnInner, { opacity: added.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}>
                                    <PlayIcon size={16} color={theme.onAccent} />
                                    <Text style={[s.playBtnText, { color: theme.onAccent }]}>Play</Text>
                                </Animated.View>
                                <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, s.btnAdded, { opacity: added }]}>
                                    <Text style={[s.playBtnText, { color: theme.onAccent }]}>Added</Text>
                                </Animated.View>
                            </TouchableOpacity>
                            )}
                            </SwipeQueueButton>
                            )}
                            {ui.pd_shuffle !== false && (
                            <SwipeQueueButton onSwipe={() => swipeQueue(true)}>
                            {(added) => (
                            <TouchableOpacity style={[s.shuffleBtn, { borderColor: theme.accentDim }]} onPress={handleShuffle}>
                                <Animated.View style={[s.btnInner, { opacity: added.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}>
                                    <ShuffleIcon size={24} color={theme.accent} style={{ marginVertical: -4 }} />
                                    <Text style={[s.shuffleBtnText, { color: theme.accent }]}>Shuffle</Text>
                                </Animated.View>
                                <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, s.btnAdded, { opacity: added }]}>
                                    <Text style={[s.shuffleBtnText, { color: theme.accent }]}>Added</Text>
                                </Animated.View>
                            </TouchableOpacity>
                            )}
                            </SwipeQueueButton>
                            )}
                        </View>

                        <View style={s.titleRow}>
                            <BackSwipeZone navigation={navigation} dragX={backX} onBack={() => navigation.goBack()} style={{ flex: 1 }}>
                                <Text style={[s.title, { color: showPlaylistTitles !== false ? base.text : 'transparent' }]} numberOfLines={1}>{showPlaylistTitles !== false ? playlist.name : ' '}</Text>
                                {(showPlaylistTrackCount !== false || (ui.pd_hours !== false && totalLenText)) && <Text style={[s.subtitle, { color: base.textFaint }]}>{[showPlaylistTrackCount !== false ? `${playlist.songs.length} ${playlist.songs.length === 1 ? 'track' : 'tracks'}` : null, ui.pd_hours !== false ? totalLenText : null].filter(Boolean).join(' · ')}</Text>}
                            </BackSwipeZone>
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
                                        onPress={() => { setSortId(opt.id); if (playlist.path) setPlaylistSort(playlist.path, opt.id); refreshSort({ cacheKey: playlist.path, source: playingSrcRef.current, force: true }); setShowSort(false); }}
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
                extraData={assign}
                renderItem={({ item }) => (
                    <SongRow
                        assigning={!!assign}
                        checked={!!assign?.selected[item.id]}
                        onToggle={toggleAssign}
                        eqName={songEQNames[item.id]}
                        item={item}
                        art={artMap[item.id]}
                        count={countFor(item)}
                        showSongCovers={showSongCovers}
                        showPlayCount={showPlayCount}
                        coverShape={coverShape}
                        artistSeparator={artistSeparator}
                        artistDisplayJoin={artistDisplayJoin}
                        theme={theme}
                        base={base}
                        onPlay={stablePlay}
                        onQueue={stableAddToQueue}
                        viz={vizId && item.id === vizId ? vizMode : 'off'}
                    />
                )}
            />

            <EQModal visible={showEQ} onClose={() => setShowEQ(false)} playlistPath={playlist.path} onAssign={() => { setShowEQ(false); setTimeout(() => setPickEQ(true), 280); }} />
            <EQModal visible={pickEQ} pickMode onClose={() => setPickEQ(false)} onPick={async (id) => {
                const [cp, ov] = await Promise.all([getCustomPresets(), getEQOverrides()]);
                setAssign({ presetId: id, name: getPresetById(id, cp, ov).name, selected: {} });
            }} />
            {assign ? (
                <View pointerEvents="box-none" style={s.assignBar}>
                    <View style={[s.assignCard, { backgroundColor: base.surface, borderColor: base.border }]}>
                        <Text style={{ color: base.text, fontSize: 13, fontWeight: '700', marginBottom: 8 }} numberOfLines={1}>
                            {Object.keys(assign.selected).length === 0 ? `Tap songs to give them ${assign.name}` : `${assign.name} for ${Object.keys(assign.selected).length} song${Object.keys(assign.selected).length === 1 ? '' : 's'}`}
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 8 }}>
                            <TouchableOpacity style={[s.assignPill, { backgroundColor: theme.accent, opacity: Object.keys(assign.selected).length ? 1 : 0.4 }]} disabled={!Object.keys(assign.selected).length}
                                onPress={async () => { await assignSongEQ((playlist.songs || []).filter(x => assign.selected[x.id]), assign.presetId); setAssign(null); }}>
                                <Text style={[s.assignPillText, { color: theme.onAccent }]}>Apply</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={[s.assignPill, { borderWidth: 1, borderColor: base.border, opacity: Object.keys(assign.selected).length ? 1 : 0.4 }]} disabled={!Object.keys(assign.selected).length}
                                onPress={async () => { await assignSongEQ((playlist.songs || []).filter(x => assign.selected[x.id]), null); setAssign(null); }}>
                                <Text style={[s.assignPillText, { color: base.textFaint }]}>Remove EQ</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={[s.assignPill, { borderWidth: 1, borderColor: base.border }]} onPress={() => setAssign(null)}>
                                <Text style={[s.assignPillText, { color: base.textFaint }]}>Cancel</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            ) : null}
            <QueueModal visible={showQueue} onClose={() => setShowQueue(false)} />
        </ScreenBackground>
        </Animated.View>
    );
}

const HIT = { top: 16, bottom: 16, left: 16, right: 16 };

// One song row. Memoized so that unrelated state changes on this screen
// (opening the queue or EQ sheet, a cover finishing loading for another
// row, the play counts arriving) do not re-render every visible row, which
// is what made the sheets stutter when they opened and closed.
const SongRow = React.memo(function SongRow({ assigning, checked, onToggle, eqName, item, art, count, showSongCovers, showPlayCount, coverShape, artistSeparator, artistDisplayJoin, theme, base, onPlay, onQueue, viz }) {
    const { songPillShadow } = usePreferences();
    return (
        <SwipeableRow onSwipeRight={() => onQueue(item)} rightColor={theme.accent} edgeExclude={EDGE_SWIPE_WIDTH} dimColor={base.surface}>
            <DimPressable style={[s.row, { backgroundColor: base.surface }, pillPad(showSongCovers), songPillShadow && COVER_SHADOW, checked && { borderWidth: 1.5, borderColor: theme.accent }]} onPress={() => (assigning ? onToggle(item) : onPlay(item))}>
                {viz === 'pill' ? <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: 12, overflow: 'hidden' }}><SongVisualizer color={theme.accent} mode="pill" radius={12} /></View> : null}
                {showSongCovers && (
                    <View style={[s.thumb, { backgroundColor: base.surface, borderRadius: squircle(PILL_COVER, coverShape) }]}>
                        {art
                            ? <Image source={{ uri: art }} style={s.thumbImg} resizeMode="cover" />
                            : null
                        }
                        {viz === 'cover' ? <SongVisualizer color={theme.accent} mode="cover" radius={squircle(PILL_COVER, coverShape)} /> : null}
                        {checked ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, s.checkOverlay]}><Text style={{ color: theme.onAccent, fontSize: 22, fontWeight: '800' }}>{'\u2713'}</Text></View> : null}
                    </View>
                )}
                <View style={{ flex: 1, marginRight: addedClearance(showPlayCount ? count : 0) }}>
                    <Text style={[s.rowTitle, { color: base.text }]} numberOfLines={1}>{item.ourTitle ?? item.title}</Text>
                    <Text style={[s.rowSub, { color: base.textFaint }]} numberOfLines={1}>{formatArtists(item.ourArtist ?? item.artist, artistSeparator, artistDisplayJoin)}{eqName ? `  \u00B7  EQ: ${eqName}` : ''}</Text>
                </View>
                {showPlayCount && count > 0 && (
                    <Text style={[s.playCount, { color: base.textFaint }]}>{count}×</Text>
                )}
            </DimPressable>
        </SwipeableRow>
    );
});

const s = StyleSheet.create({
    container: { flex: 1 },
    topBar: { flexDirection: 'row', alignItems: 'center', paddingTop: TOP_PAD, paddingHorizontal: 8, paddingBottom: 8 + TOP_FADE },
    topBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
    backIcon: { fontSize: 24 },
    eqTag: { fontSize: 16, fontWeight: "700" },
    searchBar: { flex: 1, marginHorizontal: 4, backgroundColor: '#141414', borderRadius: 10, paddingVertical: 9, paddingRight: 28, color: '#e5e5e5', fontSize: 14 },
    clearBtn: { position: 'absolute', right: 6, top: 0, bottom: 0, width: 24, justifyContent: 'center', alignItems: 'center' },
    clearBtnText: { color: '#555', fontSize: 14, fontWeight: '700' },
    coverWrap: { alignItems: 'center', marginTop: 8, marginBottom: 18 },
    cover: { width: 180, height: 180, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
    coverNote: { fontSize: 60, color: 'rgba(255,255,255,0.4)' },
    actionRow: { flexDirection: 'row', justifyContent: 'center', gap: 12, marginBottom: 22 },
    playBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24 },
    assignBar: { position: 'absolute', left: 12, right: 12, bottom: 150 },
    assignCard: { borderWidth: 1, borderRadius: 16, padding: 12 },
    assignPill: { flex: 1, borderRadius: 12, paddingVertical: 11, alignItems: 'center' },
    assignPillText: { fontSize: 14, fontWeight: '700' },
    checkOverlay: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)' },
    btnInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    btnAdded: { alignItems: 'center', justifyContent: 'center' },
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
    thumb: { width: 44, height: 44, marginRight: 12, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
    thumbImg: { width: '100%', height: '100%' },
    thumbNote: { fontSize: 18 },
});
