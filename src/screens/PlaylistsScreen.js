import React, { useContext } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, StatusBar } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { LibraryContext } from '../context/LibraryContext';

export default function PlaylistsScreen() {
  const { playlists, reload, allSongs, scanPath } = useContext(LibraryContext);
  const navigation = useNavigation();

  return (
    <View style={s.container}>
      <StatusBar barStyle="light-content" />
      <View style={s.header}>
        <Text style={s.title}>Playlists</Text>
        <TouchableOpacity onPress={reload} style={s.btn}>
          <Text style={s.btnText}>↻</Text>
        </TouchableOpacity>
      </View>
    {playlists.length === 0 ? (
        <View style={s.empty}>
            <Text style={s.emptyTitle}>No playlists yet</Text>
            <Text style={s.emptyText}>
                Add music folders to Files → On My iPhone → SySlate → Music
            </Text>
        </View>
    ) : (
        <FlatList
          data={playlists}
          keyExtractor={item => item.path}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={s.row}
              onPress={() => navigation.navigate('Player', { playlist: item })}
            >
              <View style={{ flex: 1 }}>
                <Text style={s.rowName}>{item.name}</Text>
                <Text style={s.rowCount}>{item.songs.length} tracks</Text>
              </View>
              <Text style={s.arrow}>›</Text>
            </TouchableOpacity>
          )}
          contentContainerStyle={{ paddingBottom: 140 }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container:  { flex: 1, backgroundColor: '#0a0a0a' },
  header:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 60, paddingHorizontal: 24, paddingBottom: 20 },
  title:      { color: '#e5e5e5', fontSize: 28, fontWeight: '700' },
  btn:        { padding: 8 },
  btnText:    { color: '#7c3aed', fontSize: 24 },
  empty:      { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 40 },
  emptyTitle: { color: '#e5e5e5', fontSize: 18, fontWeight: '600', marginBottom: 12 },
  emptyText:  { color: '#555', fontSize: 14, textAlign: 'center', lineHeight: 22 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 16, marginVertical: 4,
    paddingVertical: 16, paddingHorizontal: 20,
    backgroundColor: '#0f0f0f',
    borderRadius: 14,
    borderWidth: 1, borderColor: '#141414',
  },  
  rowName:    { color: '#e5e5e5', fontSize: 16, fontWeight: '500' },
  rowCount:   { color: '#555', fontSize: 12, marginTop: 3 },
  arrow:      { color: '#333', fontSize: 20 },
});