import React, { useContext, useState, useEffect } from 'react';
import {
    View, Text, FlatList, TouchableOpacity,
    StyleSheet, StatusBar,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { LibraryContext } from '../context/LibraryContext';
import { useTheme } from '../context/ThemeContext';
import { getPlaylistViewFormat, setPlaylistViewFormat } from '../utils/storage';

const FORMATS = [
    { id: 'list', label: '☰' },
    { id: 'list_art', label: '⊟' },
    { id: 'grid2', label: '⊞' },
    { id: 'grid3', label: '⊟³' },
];

export default function PlaylistsScreen() {
    const { playlists, reload } = useContext(LibraryContext);
    const { theme } = useTheme();
    const navigation = useNavigation();
    const [format, setFormat] = useState('list');

    useEffect(() => {
        getPlaylistViewFormat().then(f => setFormat(f));
    }, []);

    const changeFormat = async () => {
        const idx = FORMATS.findIndex(f => f.id === format);
        const next = FORMATS[(idx + 1) % FORMATS.length].id;
        setFormat(next);
        await setPlaylistViewFormat(next);
    };

    const numCols = format === 'grid3' ? 3 : format === 'grid2' ? 2 : 1;
    const isGrid = format.startsWith('grid');

    const renderItem = ({ item }) => {
        if (isGrid) {
            return (
                <TouchableOpacity
                    style={[s.gridItem, format === 'grid3' ? s.gridItem3 : s.gridItem2, { borderColor: theme.accentDim }]}
                    onPress={() => navigation.navigate('Player', { playlist: item })}
                    activeOpacity={0.75}
                >
                    <View style={[s.gridArt, { backgroundColor: theme.accentDim }]}>
                        <Text style={s.gridArtNote}>♪</Text>
                    </View>
                    <Text style={s.gridName} numberOfLines={2}>{item.name}</Text>
                    <Text style={s.gridCount}>{item.songs.length} tracks</Text>
                </TouchableOpacity>
            );
        }
        return (
            <TouchableOpacity
                style={s.row}
                onPress={() => navigation.navigate('Player', { playlist: item })}
                activeOpacity={0.75}
            >
                {format === 'list_art' && (
                    <View style={[s.listArt, { backgroundColor: theme.accentDim }]}>
                        <Text style={{ color: '#0a0a0a', fontSize: 18 }}>♪</Text>
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
                    <TouchableOpacity onPress={changeFormat} style={s.btn} hitSlop={HIT}>
                        <Text style={[s.btnText, { color: theme.accent }]}>{FORMATS.find(f => f.id === format)?.label}</Text>
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
                    contentContainerStyle={{ paddingBottom: 150, paddingHorizontal: isGrid ? 10 : 0 }}
                    renderItem={renderItem}
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
    btnText: { fontSize: 22 },
    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 40 },
    emptyTitle: { color: '#e5e5e5', fontSize: 18, fontWeight: '600', marginBottom: 12 },
    emptyText: { color: '#555', fontSize: 14, textAlign: 'center', lineHeight: 22 },
    row: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 14, marginVertical: 3, paddingVertical: 14, paddingHorizontal: 16, backgroundColor: '#0f0f0f', borderRadius: 14 },
    listArt: { width: 46, height: 46, borderRadius: 10, marginRight: 14, justifyContent: 'center', alignItems: 'center' },
    rowName: { color: '#e5e5e5', fontSize: 16, fontWeight: '500' },
    rowCount: { color: '#555', fontSize: 12, marginTop: 3 },
    arrow: { color: '#333', fontSize: 20 },
    gridItem: { margin: 6, borderRadius: 14, backgroundColor: '#0f0f0f', borderWidth: 1, padding: 10, alignItems: 'center' },
    gridItem2: { flex: 1, maxWidth: '48%' },
    gridItem3: { flex: 1, maxWidth: '31%' },
    gridArt: { width: '100%', aspectRatio: 1, borderRadius: 10, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
    gridArtNote: { fontSize: 32, color: '#0a0a0a' },
    gridName: { color: '#e5e5e5', fontSize: 13, fontWeight: '600', textAlign: 'center' },
    gridCount: { color: '#555', fontSize: 11, marginTop: 3 },
});