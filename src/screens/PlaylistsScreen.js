import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity,
  StyleSheet, StatusBar, ActivityIndicator
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getPlaylists } from '../utils/files';

export default function PlaylistsScreen({ navigation }) {
  const [playlists, setPlaylists] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setPlaylists(await getPlaylists());
    setLoading(false);
  };

  useFocusEffect(useCallback(() => { load(); }, []));

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <Text style={styles.title}>Library</Text>
        <TouchableOpacity onPress={load} style={styles.refreshBtn}>
          <Text style={styles.refreshText}>↻</Text>
        </TouchableOpacity>
      </View>
      {loading ? (
        <ActivityIndicator color="#7c3aed" style={{ marginTop: 40 }} />
      ) : playlists.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No playlists found</Text>
          <Text style={styles.emptyText}>
            Add folders with music files to{'\n'}Files → On My iPhone → MusePlayer
          </Text>
        </View>
      ) : (
        <FlatList
          data={playlists}
          keyExtractor={item => item.path}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.item}
              onPress={() => navigation.navigate('Player', { playlist: item })}
            >
              <Text style={styles.itemName}>{item.name}</Text>
              <Text style={styles.arrow}>›</Text>
            </TouchableOpacity>
          )}
          contentContainerStyle={{ paddingBottom: 40 }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 60, paddingHorizontal: 24, paddingBottom: 20,
  },
  title: { color: '#fff', fontSize: 32, fontWeight: '700', letterSpacing: -0.5 },
  refreshBtn: { padding: 8 },
  refreshText: { color: '#7c3aed', fontSize: 26 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 40 },
  emptyTitle: { color: '#fff', fontSize: 18, fontWeight: '600', marginBottom: 12 },
  emptyText: { color: '#555', fontSize: 14, textAlign: 'center', lineHeight: 22 },
  item: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 18, paddingHorizontal: 24,
    borderBottomWidth: 1, borderBottomColor: '#141414',
  },
  itemName: { color: '#e5e5e5', fontSize: 16, fontWeight: '500', flex: 1 },
  arrow: { color: '#444', fontSize: 20 },
});