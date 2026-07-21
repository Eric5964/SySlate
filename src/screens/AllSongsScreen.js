import React, { useContext, useState, useMemo } from 'react';
import {
    View, Text, FlatList, TouchableOpacity,
    TextInput, StyleSheet, StatusBar,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { LibraryContext } from '../context/LibraryContext';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import SwipeableRow from '../components/SwipeableRow';

export default function AllSongsScreen() {
    const { allSongs } = useContext(LibraryContext);
    const { playSongFromPlaylist, addToQueue } = usePlayback();
    const { theme, base } = useTheme();
    const navigation = useNavigation();
    const [search, setSearch] = useState('');
    const [showSearch, setShowSearch] = useState(false);

    const filtered = useMemo(() => {
        if (!search.trim()) return allSongs;
        const q = search.toLowerCase();
        return allSongs.filter(s =>
            s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q)
        );
    }, [allSongs, search]);

    const play = async (song) => {
        // Deduplicated allSongs already sorted by title
        const playlist = { name: 'All Songs', path: '__all__', songs: allSongs };
        await playSongFromPlaylist(playlist, song.id);
        // No auto-navigate to the full player — the mini player appearing is
        // enough; tap it if you want the full screen.
    };

    return (
        <View style={[s.container, { backgroundColor: base.bg }]}>
            <StatusBar barStyle="light-content" />
            <View style={s.header}>
                <Text style={s.title}>All Songs</Text>
                <TouchableOpacity onPress={() => { setShowSearch(v => !v); setSearch(''); }} style={s.btn} hitSlop={HIT}>
                    <Text style={[s.btnText, { color: theme.accent }]}>⌕</Text>
                </TouchableOpacity>
            </View>
            {showSearch && (
                <TextInput
                    style={[s.search, { backgroundColor: base.surface, borderColor: theme.accentDim }]}
                    value={search} onChangeText={setSearch}
                    placeholder="Search songs, artists..."
                    placeholderTextColor="#444"
                    autoFocus
                />
            )}
            {allSongs.length === 0 ? (
                <View style={s.empty}>
                    <Text style={s.emptyTitle}>No songs found</Text>
                    <Text style={s.emptyText}>Add music folders or files to{'\n'}Files → On My iPhone → SySlate</Text>
                </View>
            ) : (
                <FlatList
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
        </View>
    );
}

const HIT = { top: 12, bottom: 12, left: 12, right: 12 };

const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0a0a0a' },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 60, paddingHorizontal: 24, paddingBottom: 16 },
    title: { color: '#e5e5e5', fontSize: 28, fontWeight: '700' },
    btn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
    btnText: { fontSize: 24 },
    search: { marginHorizontal: 20, marginBottom: 12, backgroundColor: '#141414', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, color: '#e5e5e5', fontSize: 15, borderWidth: 1 },
    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 40 },
    emptyTitle: { color: '#e5e5e5', fontSize: 18, fontWeight: '600', marginBottom: 12 },
    emptyText: { color: '#555', fontSize: 14, textAlign: 'center', lineHeight: 22 },
    row: { paddingVertical: 14, paddingHorizontal: 20, marginHorizontal: 14, marginVertical: 2, borderRadius: 12, backgroundColor: '#0d0d0d' },
    rowTitle: { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
    rowSub: { color: '#555', fontSize: 12, marginTop: 3 },
});