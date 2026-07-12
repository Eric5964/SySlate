import React, { useContext, useState, useEffect, useMemo, memo } from 'react';
import {
    View, Text, FlatList, TouchableOpacity, StyleSheet, StatusBar, Image, Alert, Dimensions,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useNavigation } from '@react-navigation/native';
import { LibraryContext } from '../context/LibraryContext';
import { useTheme } from '../context/ThemeContext';
import { playlistColor } from '../utils/color';
import { squircle } from '../utils/squircle';
import {
    getPlaylistViewFormat, setPlaylistViewFormat,
    getPlaylistOrder, setPlaylistOrder,
    getPlaylistCovers, setPlaylistCover,
} from '../utils/storage';

const SCREEN_W = Dimensions.get('window').width;
const GRID_PADDING = 8;
const CELL_MARGIN = 5;

// Fixed pixel math instead of percentage/aspectRatio-based sizing — that
// combination was behaving unpredictably (only ever showing part of a grid),
// so every sized element in this screen now computes its exact pixel size
// up front from the screen width.
function cellSize(cols) {
    const usable = SCREEN_W - GRID_PADDING * 2 - CELL_MARGIN * 2 * cols;
    return Math.floor(usable / cols);
}
const CELL_SIZES = { 2: cellSize(2), 3: cellSize(3) };

const FORMATS = [
    { id: 'list', label: '☰', cols: 1 },
    { id: 'list_art', label: '⊟', cols: 1 },
    { id: 'grid2', label: '⊞', cols: 2 },
    { id: 'grid3', label: '⋮⋮', cols: 3 },
];

// Memoized so opening/closing the long-press menu (state lives in the parent)
// doesn't force every visible row to re-render — that re-render of the whole
// list was what made the long-press feel choppy.
const PlaylistRow = memo(function PlaylistRow({ item, format, numCols, cover, onOpen, onLongPress }) {
    const bg = playlistColor(item.name);

    const renderArt = (size, fontSize) => cover
        ? <Image source={{ uri: cover }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        : <Text style={{ fontSize, color: 'rgba(255,255,255,0.4)' }}>♪</Text>;

    if (format.startsWith('grid')) {
        const size = CELL_SIZES[numCols];
        return (
            <TouchableOpacity
                style={[s.gridItem, { width: size, margin: CELL_MARGIN }]}
                onPress={onOpen} onLongPress={onLongPress} activeOpacity={0.75}
            >
                <View style={[s.gridArt, { width: size, height: size, backgroundColor: bg, borderRadius: squircle(size) }]}>
                    {renderArt(numCols === 3 ? 28 : 40, numCols === 3 ? 28 : 40)}
                </View>
                <Text style={s.gridName} numberOfLines={2}>{item.name}</Text>
                <Text style={s.gridCount}>{item.songs.length} tracks</Text>
            </TouchableOpacity>
        );
    }
    return (
        <TouchableOpacity style={s.row} onPress={onOpen} onLongPress={onLongPress} activeOpacity={0.75}>
            {format === 'list_art' && (
                <View style={[s.listArt, { backgroundColor: bg, overflow: 'hidden', borderRadius: squircle(50) }]}>
                    {renderArt(22, 22)}
                </View>
            )}
            <View style={{ flex: 1 }}>
                <Text style={s.rowName}>{item.name}</Text>
                <Text style={s.rowCount}>{item.songs.length} tracks</Text>
            </View>
            <Text style={s.arrow}>›</Text>
        </TouchableOpacity>
    );
});

export default function PlaylistsScreen() {
    const { playlists, reload } = useContext(LibraryContext);
    const { theme } = useTheme();
    const navigation = useNavigation();
    const [format, setFormat] = useState('list');
    const [covers, setCovers] = useState({});
    const [menuFor, setMenuFor] = useState(null);

    useEffect(() => { getPlaylistViewFormat().then(f => f && setFormat(f)); }, []);
    useEffect(() => { getPlaylistCovers().then(setCovers); }, [playlists]);

    const cycleFormat = async () => {
        const idx = FORMATS.findIndex(f => f.id === format);
        const next = FORMATS[(idx + 1) % FORMATS.length];
        setFormat(next.id);
        await setPlaylistViewFormat(next.id);
    };

    const isGrid = format.startsWith('grid');
    const numCols = FORMATS.find(f => f.id === format)?.cols ?? 1;
    const fmtIcon = FORMATS.find(f => f.id === format)?.label ?? '☰';

    const openPlaylist = (item) => navigation.navigate('PlaylistDetail', { playlist: item });

    const persistOrder = async (newList) => {
        await setPlaylistOrder(newList.map(p => p.path));
        await reload();
    };

    const moveItem = async (item, action) => {
        const list = [...playlists];
        const idx = list.findIndex(p => p.path === item.path);
        if (idx === -1) return;
        list.splice(idx, 1);
        let target;
        if (action === 'top') target = 0;
        else if (action === 'bottom') target = list.length;
        else if (action === 'up') target = Math.max(0, idx - 1);
        else if (action === 'down') target = Math.min(list.length, idx + 1);
        list.splice(target, 0, item);
        setMenuFor(null);
        await persistOrder(list);
    };

    const changeCover = async (item) => {
        setMenuFor(null);
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
        const next = await setPlaylistCover(item.path, result.assets[0].uri);
        setCovers(next);
    };

    const removeCover = async (item) => {
        setMenuFor(null);
        const next = await setPlaylistCover(item.path, null);
        setCovers(next);
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
                    contentContainerStyle={{ paddingBottom: 150, paddingHorizontal: isGrid ? GRID_PADDING : 0, paddingTop: isGrid ? 8 : 0 }}
                    renderItem={({ item }) => (
                        <PlaylistRow
                            item={item}
                            format={format}
                            numCols={numCols}
                            cover={covers[item.path]}
                            onOpen={() => openPlaylist(item)}
                            onLongPress={() => setMenuFor(item)}
                        />
                    )}
                />
            )}

            {menuFor && (
                <View style={s.menuOverlay}>
                    <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setMenuFor(null)} />
                    <View style={s.menuSheet}>
                        <View style={s.menuHandle} />
                        <Text style={s.menuTitle} numberOfLines={1}>{menuFor.name}</Text>
                        <MenuRow label="Change Cover Image" onPress={() => changeCover(menuFor)} />
                        {covers[menuFor.path] && <MenuRow label="Remove Cover Image" onPress={() => removeCover(menuFor)} />}
                        <MenuRow label="Move to Top" onPress={() => moveItem(menuFor, 'top')} />
                        <MenuRow label="Move Up" onPress={() => moveItem(menuFor, 'up')} />
                        <MenuRow label="Move Down" onPress={() => moveItem(menuFor, 'down')} />
                        <MenuRow label="Move to Bottom" onPress={() => moveItem(menuFor, 'bottom')} />
                        <MenuRow label="Cancel" onPress={() => setMenuFor(null)} muted />
                    </View>
                </View>
            )}
        </View>
    );
}

function MenuRow({ label, onPress, muted }) {
    return (
        <TouchableOpacity style={s.menuRow} onPress={onPress}>
            <Text style={[s.menuRowText, muted && { color: '#555' }]}>{label}</Text>
        </TouchableOpacity>
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
    listArt: { width: 50, height: 50, marginRight: 14, justifyContent: 'center', alignItems: 'center' },
    rowName: { color: '#e5e5e5', fontSize: 16, fontWeight: '500' },
    rowCount: { color: '#555', fontSize: 12, marginTop: 3 },
    arrow: { color: '#333', fontSize: 22 },
    gridItem: { borderRadius: 14, backgroundColor: '#0f0f0f', padding: 8, alignItems: 'center' },
    gridArt: { justifyContent: 'center', alignItems: 'center', marginBottom: 8, overflow: 'hidden' },
    gridName: { color: '#e5e5e5', fontSize: 13, fontWeight: '600', textAlign: 'center' },
    gridCount: { color: '#555', fontSize: 11, marginTop: 3 },
    menuOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
    menuSheet: { backgroundColor: '#0f0f0f', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },
    menuHandle: { width: 36, height: 4, backgroundColor: '#222', borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
    menuTitle: { color: '#555', fontSize: 13, fontWeight: '600', textAlign: 'center', marginBottom: 8 },
    menuRow: { paddingVertical: 16, borderTopWidth: 1, borderTopColor: '#1a1a1a' },
    menuRowText: { color: '#e5e5e5', fontSize: 16, textAlign: 'center' },
});
