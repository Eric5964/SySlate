import React, { useContext, useState, useMemo, useRef, useEffect } from 'react';
import {
    View, Text, FlatList, TouchableOpacity,
    TextInput, StyleSheet, StatusBar,
} from 'react-native';
import { useNavigation, useScrollToTop } from '@react-navigation/native';
import { LibraryContext } from '../context/LibraryContext';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import SwipeableRow from '../components/SwipeableRow';
import EQModal from '../components/EQModal';
import QueueModal from '../components/QueueModal';
import { MenuBarsIcon } from '../components/Icons';

export default function AllSongsScreen() {
    const { allSongs } = useContext(LibraryContext);
    const { playSongFromPlaylist, addToQueue } = usePlayback();
    const { theme, base } = useTheme();
    const navigation = useNavigation();
    const [search, setSearch] = useState('');
    const [showEQ, setShowEQ] = useState(false);
    const [showQueue, setShowQueue] = useState(false);

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

    const filtered = useMemo(() => {
        if (!search.trim()) return allSongs;
        const q = search.toLowerCase();
        return allSongs.filter(s =>
            s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q)
        );
    }, [allSongs, search]);

    const play = async (song) => {
        const playlist = { name: 'All Songs', path: '__all__', songs: allSongs };
        await playSongFromPlaylist(playlist, song.id);
    };

    return (
        <View style={[s.container, { backgroundColor: base.bg }]}>
            <StatusBar barStyle="light-content" />

            {/* Same top-bar layout as the playlist screen: title, then a row
                with centered search (+ clear button), EQ tag, queue icon. */}
            <View style={s.topBar}>
                <Text style={s.title}>All Songs</Text>
                <View style={s.searchRow}>
                    <View style={{ flex: 1, justifyContent: 'center' }}>
                        <TextInput
                            style={[s.searchBar, { backgroundColor: base.surface }]}
                            value={search} onChangeText={setSearch}
                            placeholder="Search songs, artists..."
                            placeholderTextColor="#444"
                        />
                        {search.length > 0 && (
                            <TouchableOpacity style={s.clearBtn} onPress={() => setSearch('')} hitSlop={HIT}>
                                <Text style={s.clearBtnText}>✕</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                    <TouchableOpacity onPress={() => setShowEQ(true)} hitSlop={HIT} style={s.topBtn}>
                        <Text style={[s.eqTag, { color: theme.accent }]}>EQ</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setShowQueue(true)} hitSlop={HIT} style={s.topBtn}>
                        <MenuBarsIcon size={20} color={theme.accent} />
                    </TouchableOpacity>
                </View>
            </View>

            {allSongs.length === 0 ? (
                <View style={s.empty}>
                    <Text style={s.emptyTitle}>No songs found</Text>
                    <Text style={s.emptyText}>Add music folders or files to{'\n'}Files → On My iPhone → SySlate</Text>
                </View>
            ) : (
                <FlatList
                    ref={listRef}
                    data={filtered}
                    keyExtractor={item => item.id}
                    contentContainerStyle={{ paddingBottom: 150 }}
                    renderItem={({ item }) => (
                        <SwipeableRow onSwipeRight={() => addToQueue(item)} rightColor={theme.accent}>
                            <TouchableOpacity style={[s.row, { backgroundColor: base.surface }]} onPress={() => play(item)} activeOpacity={0.7}>
                                <Text style={s.rowTitle} numberOfLines={1}>{item.title}</Text>
                                <Text style={s.rowSub} numberOfLines={1}>{item.artist}</Text>
                            </TouchableOpacity>
                        </SwipeableRow>
                    )}
                />
            )}

            <EQModal visible={showEQ} onClose={() => setShowEQ(false)} />
            <QueueModal visible={showQueue} onClose={() => setShowQueue(false)} />
        </View>
    );
}

const HIT = { top: 12, bottom: 12, left: 12, right: 12 };

const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0a0a0a' },
    topBar: { paddingTop: 56, paddingHorizontal: 20, paddingBottom: 10 },
    title: { color: '#e5e5e5', fontSize: 22, fontWeight: '700', marginBottom: 10 },
    searchRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    searchBar: { borderRadius: 10, paddingVertical: 9, paddingHorizontal: 14, paddingRight: 32, color: '#e5e5e5', fontSize: 14 },
    clearBtn: { position: 'absolute', right: 8, top: 0, bottom: 0, width: 24, justifyContent: 'center', alignItems: 'center' },
    clearBtnText: { color: '#555', fontSize: 14, fontWeight: '700' },
    topBtn: { width: 36, height: 36, justifyContent: 'center', alignItems: 'center' },
    eqTag: { fontSize: 14, fontWeight: '700' },
    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 40 },
    emptyTitle: { color: '#e5e5e5', fontSize: 18, fontWeight: '600', marginBottom: 12 },
    emptyText: { color: '#555', fontSize: 14, textAlign: 'center', lineHeight: 22 },
    row: { paddingVertical: 14, paddingHorizontal: 20, marginHorizontal: 14, marginVertical: 2, borderRadius: 12, backgroundColor: '#0d0d0d' },
    rowTitle: { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
    rowSub: { color: '#555', fontSize: 12, marginTop: 3 },
});
