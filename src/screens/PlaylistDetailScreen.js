import React, { useState, useEffect, useMemo } from 'react';
import {
    View, Text, FlatList, TouchableOpacity,
    StyleSheet, TextInput, StatusBar,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { getPlayCounts } from '../utils/storage';

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
    const { playSongFromPlaylist } = usePlayback();
    const { theme } = useTheme();

    const [search, setSearch] = useState('');
    const [showSearch, setShowSearch] = useState(false);
    const [sortId, setSortId] = useState('alpha');
    const [playCounts, setPlayCounts] = useState({});
    const [showSort, setShowSort] = useState(false);

    useEffect(() => {
        getPlayCounts(playlist.songs.map(s => s.id)).then(setPlayCounts);
    }, []);

    const sorted = useMemo(() => {
        let songs = [...playlist.songs];
        switch (sortId) {
            case 'alpha': songs.sort((a, b) => (a.ourTitle ?? a.title).localeCompare(b.ourTitle ?? b.title)); break;
            case 'alpha_r': songs.sort((a, b) => (b.ourTitle ?? b.title).localeCompare(a.ourTitle ?? a.title)); break;
            case 'plays': songs.sort((a, b) => (playCounts[b.id] ?? 0) - (playCounts[a.id] ?? 0)); break;
            case 'plays_r': songs.sort((a, b) => (playCounts[a.id] ?? 0) - (playCounts[b.id] ?? 0)); break;
        }
        return songs;
    }, [playlist.songs, sortId, playCounts]);

    const filtered = useMemo(() => {
        if (!search.trim()) return sorted;
        const q = search.toLowerCase();
        return sorted.filter(s =>
            (s.ourTitle ?? s.title ?? '').toLowerCase().includes(q) ||
            (s.ourArtist ?? s.artist ?? '').toLowerCase().includes(q)
        );
    }, [sorted, search]);

    const play = async (song) => {
        await playSongFromPlaylist(playlist, song.id);
        navigation.navigate('Player', {});
    };

    return (
        <View style={s.container}>
            <StatusBar barStyle="light-content" />

            {/* Header */}
            <View style={s.header}>
                <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={HIT} style={s.backBtn}>
                    <Text style={[s.backIcon, { color: theme.accent }]}>←</Text>
                </TouchableOpacity>
                <View style={s.headerCenter}>
                    <Text style={s.title} numberOfLines={1}>{playlist.name}</Text>
                    <Text style={s.subtitle}>{playlist.songs.length} tracks</Text>
                </View>
                <View style={{ flexDirection: 'row' }}>
                    <TouchableOpacity onPress={() => { setShowSearch(v => !v); setSearch(''); }} style={s.topBtn} hitSlop={HIT}>
                        <Text style={[s.topBtnText, { color: theme.accent }]}>⌕</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setShowSort(v => !v)} style={s.topBtn} hitSlop={HIT}>
                        <Text style={[s.topBtnText, { color: theme.accent }]}>⇅</Text>
                    </TouchableOpacity>
                </View>
            </View>

            {/* Sort picker */}
            {showSort && (
                <View style={s.sortRow}>
                    {SORTS.map(opt => (
                        <TouchableOpacity
                            key={opt.id}
                            style={[s.sortChip, sortId === opt.id && { backgroundColor: theme.accent }]}
                            onPress={() => { setSortId(opt.id); setShowSort(false); }}
                        >
                            <Text style={[s.sortChipText, sortId === opt.id && { color: theme.onAccent }]}>
                                {opt.label}
                            </Text>
                        </TouchableOpacity>
                    ))}
                </View>
            )}

            {/* Search */}
            {showSearch && (
                <TextInput
                    style={[s.search, { borderColor: theme.accentDim }]}
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Search songs, artists..."
                    placeholderTextColor="#444"
                    autoFocus
                />
            )}

            {/* Songs */}
            <FlatList
                data={filtered}
                keyExtractor={item => item.id}
                contentContainerStyle={{ paddingBottom: 150 }}
                renderItem={({ item }) => (
                    <TouchableOpacity style={s.row} onPress={() => play(item)} activeOpacity={0.7}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.rowTitle} numberOfLines={1}>{item.ourTitle ?? item.title}</Text>
                            <Text style={s.rowSub} numberOfLines={1}>{item.ourArtist ?? item.artist}</Text>
                        </View>
                        {playCounts[item.id] > 0 && (
                            <Text style={s.playCount}>{playCounts[item.id]}×</Text>
                        )}
                    </TouchableOpacity>
                )}
            />
        </View>
    );
}

const HIT = { top: 16, bottom: 16, left: 16, right: 16 };

const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0a0a0a' },
    header: { flexDirection: 'row', alignItems: 'center', paddingTop: 60, paddingHorizontal: 16, paddingBottom: 12 },
    backBtn: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
    backIcon: { fontSize: 26 },
    headerCenter: { flex: 1, paddingHorizontal: 8 },
    title: { color: '#e5e5e5', fontSize: 20, fontWeight: '700' },
    subtitle: { color: '#555', fontSize: 13, marginTop: 2 },
    topBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
    topBtnText: { fontSize: 22 },
    sortRow: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, paddingBottom: 10, gap: 8 },
    sortChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#1a1a1a' },
    sortChipText: { color: '#888', fontSize: 13, fontWeight: '600' },
    search: { marginHorizontal: 16, marginBottom: 8, backgroundColor: '#141414', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, color: '#e5e5e5', fontSize: 15, borderWidth: 1 },
    row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 20, marginHorizontal: 14, marginVertical: 2, borderRadius: 12, backgroundColor: '#0d0d0d' },
    rowTitle: { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
    rowSub: { color: '#555', fontSize: 12, marginTop: 3 },
    playCount: { color: '#333', fontSize: 12, marginLeft: 8 },
});