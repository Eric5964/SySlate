import React, { useContext, useState, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity,
  TextInput, StyleSheet, StatusBar,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { LibraryContext } from '../App';
import { usePlayback } from '../context/PlaybackContext';

export default function AllSongsScreen() {
  const { allSongs }            = useContext(LibraryContext);
  const { playSongFromPlaylist } = usePlayback();
  const navigation              = useNavigation();
  const [search, setSearch]     = useState('');
  const [showSearch, setShowSearch] = useState(false);

  const filtered = useMemo(() => {
    if (!search.trim()) return allSongs;
    const q = search.toLowerCase();
    return allSongs.filter(s =>
      s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q)
    );
  }, [allSongs, search]);

  const play = async (song) => {
    const playlist = { name: 'All Songs', path: '__all__', songs: allSongs };
    const idx = allSongs.findIndex(s => s.id === song.id);
    await playSongFromPlaylist(playlist, idx);
    navigation.navigate('Player', { playlist });
  };

  return (
    <View style={s.container}>
      <StatusBar barStyle="light-content" />
      <View style={s.header}>
        <Text style={s.title}>All Songs</Text>
        <TouchableOpacity onPress={() => { setShowSearch(v => !v); setSearch(''); }} style={s.btn}>
          <Text style={s.btnText}>⌕</Text>
        </TouchableOpacity>
      </View>
      {showSearch && (
        <TextInput
          style={s.search}
          value={search}
          onChangeText={setSearch}
          placeholder="Search songs, artists..."
          placeholderTextColor="#444"
          autoFocus
        />
      )}
      {allSongs.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyTitle}>No songs found</Text>
          <Text style={s.emptyText}>Add folders to Files → On My iPhone → SySlate</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => item.id}
          renderItem={({ item }) => (
            <TouchableOpacity style={s.row} onPress={() => play(item)}>
              <Text style={s.rowTitle} numberOfLines={1}>{item.title}</Text>
              <Text style={s.rowSub}   numberOfLines={1}>{item.artist}</Text>
            </TouchableOpacity>
          )}
          contentContainerStyle={{ paddingBottom: 140 }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  header:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 60, paddingHorizontal: 24, paddingBottom: 16 },
  title:     { color: '#e5e5e5', fontSize: 28, fontWeight: '700' },
  btn:       { padding: 8 },
  btnText:   { color: '#7c3aed', fontSize: 22 },
  search:    { marginHorizontal: 24, marginBottom: 12, backgroundColor: '#141414', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10, color: '#e5e5e5', fontSize: 15 },
  empty:     { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 40 },
  emptyTitle:{ color: '#e5e5e5', fontSize: 18, fontWeight: '600', marginBottom: 12 },
  emptyText: { color: '#555', fontSize: 14, textAlign: 'center' },
  row:       { paddingVertical: 14, paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: '#111' },
  rowTitle:  { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
  rowSub:    { color: '#555', fontSize: 12, marginTop: 2 },
});