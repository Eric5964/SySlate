import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TrackPlayer, { usePlaybackState, State, Event } from 'react-native-track-player';
import { useNavigation } from '@react-navigation/native';
import { usePlayback } from '../context/PlaybackContext';
import { skipWithCrossfade } from '../services/PlaybackService';

const TAB_BAR_HEIGHT = 49; // React Navigation default, safe area is added separately

export default function MiniPlayer() {
  const navigation   = useNavigation();
  const { currentPlaylist } = usePlayback();
  const playbackState = usePlaybackState();
  const isPlaying     = playbackState.state === State.Playing;
  const insets        = useSafeAreaInsets();
  const [track, setTrack] = useState(null);

  useEffect(() => {
    const refresh = async () => {
      const idx = await TrackPlayer.getCurrentTrack();
      if (idx !== null) setTrack(await TrackPlayer.getTrack(idx));
    };
    refresh();
    const sub = TrackPlayer.addEventListener(Event.PlaybackTrackChanged, refresh);
    return () => sub.remove();
  }, []);

  if (!track) return null;

  const bottom = TAB_BAR_HEIGHT + insets.bottom;

  return (
    <TouchableOpacity
      style={[styles.container, { bottom }]}
      onPress={() => navigation.navigate('Player', { playlist: currentPlaylist })}
      activeOpacity={0.9}
    >
      <View style={styles.art}>
        <Text style={styles.artIcon}>♪</Text>
      </View>
      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={1}>{track.title}</Text>
        <Text style={styles.artist} numberOfLines={1}>{track.artist}</Text>
      </View>
      <TouchableOpacity onPress={() => skipWithCrossfade('prev')} style={styles.btn} hitSlop={HIT}>
        <Text style={styles.btnText}>⏮</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={async () => isPlaying ? TrackPlayer.pause() : TrackPlayer.play()}
        style={styles.btn} hitSlop={HIT}
      >
        <Text style={styles.btnText}>{isPlaying ? '⏸' : '▶'}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => skipWithCrossfade('next')} style={styles.btn} hitSlop={HIT}>
        <Text style={styles.btnText}>⏭</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

const HIT = { top: 10, bottom: 10, left: 10, right: 10 };

const styles = StyleSheet.create({
  container: {
    position: 'absolute', left: 0, right: 0, height: 62,
    backgroundColor: '#111', borderTopWidth: 1, borderTopColor: '#1c1c1c',
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
  },
  art: {
    width: 38, height: 38, borderRadius: 6, marginRight: 12,
    backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#2a1f3d',
    justifyContent: 'center', alignItems: 'center',
  },
  artIcon:  { fontSize: 16, color: '#2a1f3d' },
  info:     { flex: 1, marginRight: 8 },
  title:    { color: '#e5e5e5', fontSize: 14, fontWeight: '600' },
  artist:   { color: '#555', fontSize: 12, marginTop: 2 },
  btn:      { padding: 8 },
  btnText:  { color: '#e5e5e5', fontSize: 18 },
});