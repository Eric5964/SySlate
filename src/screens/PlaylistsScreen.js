import React, { useContext, useState, useEffect } from 'react';
import {
    View, Text, FlatList, TouchableOpacity, StyleSheet, StatusBar,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { LibraryContext } from '../context/LibraryContext';
import { useTheme } from '../context/ThemeContext';
import { getPlaylistViewFormat, setPlaylistViewFormat } from '../utils/storage';

const FORMATS = [
    { id: 'list', label: '☰', cols: 1 },
    { id: 'list_art', label: '⊟', cols: 1 },
    { id: 'grid2', label: '⊞', cols: 2 },
    { id: 'grid3', label: '⋮⋮', cols: 3 },
];

// Deterministic color per playlist name
const PALETTE = ['#7c3aed', '#2563eb', '#16a34a', '#dc2626', '#ea580c', '#f0047f', '#0891b2', '#d97706', '#4338ca'];
function playlistColor(name) {
    let h = 5381;
    for (let i = 0; i < name.length; i++) h = ((h << 5) + h) ^ name.charCodeAt(i);
    return PALETTE[Math.abs(h) % PALETTE.length];
}

export default function PlaylistsScreen() {
    const { playlists, reload } = useContext(LibraryContext);
    const { theme } = useTheme();
    const navigation = useNavigation();
    const [format, setFormat] = useState('list');

    useEffect(() => { getPlaylistViewFormat().then(f => f && setFormat(f)); }, []);

    const cycleFormat = async () => {
        const idx = FORMATS.findIndex(f => f.id === format);
        const next = FORMATS[(idx + 1) % FORMATS.length];
        setFormat(next.id);
        await setPlaylistViewFormat(next.id);
    };

    const isGrid = format.startsWith('grid');
    const numCols = FORMATS.find(f => f.id === format)?.cols ?? 1;
    const fmtIcon = FORMATS.find(f => f.id === format)?.label ?? '☰';
    const color = (name) => playlistColor(name);

    const openPlaylist = (item) => navigation.navigate('PlaylistDetail', { playlist: item });

    const renderItem = ({ item }) => {
        if (isGrid) {
            const bg = color(item.name);
            return (
                <TouchableOpacity
                    style={[s.gridItem, numCols === 3 ? s.gi3 : s.gi2]}
                    onPress={() => openPlaylist(item)}
                    activeOpacity={0.75}
                >
                    <View style={[s.gridArt, { backgroundColor: bg }]}>
                        <Text style={{ fontSize: numCols === 3 ? 28 : 40, color: 'rgba(255,255,255,0.4)' }}>♪</Text>
                    </View>
                    <Text style={s.gridName} numberOfLines={2}>{item.name}</Text>
                    <Text style={s.gridCount}>{item.songs.length} tracks</Text>
                </TouchableOpacity>
            );
        }
        return (
            <TouchableOpacity style={s.row} onPress={() => openPlaylist(item)} activeOpacity={0.75}>
                {format === 'list_art' && (
                    <View style={[s.listArt, { backgroundColor: color(item.name) }]}>
                        <Text style={{ fontSize: 22, color: 'rgba(255,255,255,0.5)' }}>♪</Text>
                    </View>
                )}
                <View style={{ flex: 1 }}>
                    <Text style={s.rowName}>{item.name}</Text>
                    <Text style={s.rowCount}>{item.songs.length} tracks</Text>
                </View>
                <Text style={s.arrow}>›</Text>
            </TouchableOpacity>
        );
    };

    return (
        <View style={s.container}>
            <StatusBar barStyle="light-content" />
            <View style={s.header}>
                <Text style={s.title}>Playlists</Text>
                <View style={{ flexDirection: 'row' }}>
                    <TouchableOpacity onPress={cycleFormat} style={s.btn} hitSlop={HIT}>
                        <Text style={[s.btnText, { color: theme.accent }]}>{fmtIcon}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={reload} style={s.btn} hitSlop={HIT}>
                        <Text style={[s.btnText, { color: theme.accent }]}>↻</Text>
                    </TouchableOpacity>
                </View>
            </View>
            {playlists.length === 0 ? (
                <View style={s.empty}>
                    <Text style={s.emptyTitle}>No playlists yet</Text>
                    <Text style={s.emptyText}>Add folders to{'\n'}Files → On My iPhone → SySlate</Text>
                </View>
            ) : (
                <FlatList
                    key={numCols}
                    data={playlists}
                    keyExtractor={item => item.path}
                    numColumns={numCols}
                    contentContainerStyle={{ paddingBottom: 150, paddingHorizontal: isGrid ? 8 : 0, paddingTop: isGrid ? 8 : 0 }}
                    renderItem={renderItem}
                />
            )}
        </View>
    );
}

const HIT = { top: 14, bottom: 14, left: 14, right: 14 };

const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0a0a0a' },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 60, paddingHorizontal: 24, paddingBottom: 16 },
    title: { color: '#e5e5e5', fontSize: 28, fontWeight: '700' },
    btn: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
    btnText: { fontSize: 24 },
    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 40 },
    emptyTitle: { color: '#e5e5e5', fontSize: 18, fontWeight: '600', marginBottom: 12 },
    emptyText: { color: '#555', fontSize: 14, textAlign: 'center', lineHeight: 22 },
    row: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 14, marginVertical: 3, paddingVertical: 16, paddingHorizontal: 16, backgroundColor: '#0f0f0f', borderRadius: 14, minHeight: 68 },
    listArt: { width: 50, height: 50, borderRadius: 10, marginRight: 14, justifyContent: 'center', alignItems: 'center' },
    rowName: { color: '#e5e5e5', fontSize: 16, fontWeight: '500' },
    rowCount: { color: '#555', fontSize: 12, marginTop: 3 },
    arrow: { color: '#333', fontSize: 22 },
    gridItem: { flex: 1, margin: 5, borderRadius: 14, backgroundColor: '#0f0f0f', padding: 8, alignItems: 'center' },
    gi2: { maxWidth: '48%' },
    gi3: { maxWidth: '31%' },
    gridArt: { width: '100%', aspectRatio: 1, borderRadius: 10, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
    gridName: { color: '#e5e5e5', fontSize: 13, fontWeight: '600', textAlign: 'center' },
    gridCount: { color: '#555', fontSize: 11, marginTop: 3 },
});