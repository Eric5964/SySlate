import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  StatusBar, ActivityIndicator
} from 'react-native';
import TrackPlayer, {
  usePlaybackState, useProgress, useActiveTrack, State
} from 'react-native-track-player';
import { getTracksInPlaylist } from '../utils/files';
import { shuffleTracks } from '../utils/shuffle';

const CROSSFADE_SECS = 5;

export default function PlayerScreen({ navigation, route }) {
  const { playlist } = route.params;
  const [tracks, setTracks] = useState([]);
  const [isShuffled, setIsShuffled] = useState(false);
  const [loading, setLoading] = useState(true);
  const playbackState = usePlaybackState();
  const progress = useProgress(500);
  const activeTrack = useActiveTrack();
  const isCrossfading = useRef(false);
  const fadeInterval = useRef(null);

  useEffect(() => {
    loadAndPlay();
    return () => { if (fadeInterval.current) clearInterval(fadeInterval.current); };
  }, []);

  // Crossfade: fade volume out as track approaches end
  useEffect(() => {
    if (!progress.duration || progress.duration === 0) return;
    const remaining = progress.duration - progress.position;

    if (remaining <= CROSSFADE_SECS && remaining > 0 && !isCrossfading.current) {
      isCrossfading.current = true;
      const steps = 30;
      const intervalMs = (CROSSFADE_SECS * 1000) / steps;
      let step = 0;
      fadeInterval.current = setInterval(async () => {
        step++;
        const vol = Math.max(0, 1 - step / steps);
        await TrackPlayer.setVolume(vol);
        if (step >= steps) {
          clearInterval(fadeInterval.current);
        }
      }, intervalMs);
    }

    if (remaining > CROSSFADE_SECS) {
      isCrossfading.current = false;
    }
  }, [progress.position]);

  // Reset volume on new track
  useEffect(() => {
    if (fadeInterval.current) clearInterval(fadeInterval.current);
    isCrossfading.current = false;
    TrackPlayer.setVolume(1);
  }, [activeTrack?.id]);

  async function loadAndPlay() {
    setLoading(true);
    const loaded = await getTracksInPlaylist(playlist.path);
    setTracks(loaded);
    await TrackPlayer.reset();
    await TrackPlayer.add(loaded);
    await TrackPlayer.play();
    setLoading(false);
  }

  async function toggleShuffle() {
    const next = !isShuffled;
    setIsShuffled(next);
    const newQueue = next ? shuffleTracks(tracks) : [...tracks];
    await TrackPlayer.reset();
    await TrackPlayer.add(newQueue);
    await TrackPlayer.play();
  }

  const fmt = (secs) => {
    if (!secs || isNaN(secs)) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const isPlaying = playbackState.state === State.Playing;
  const progressPct = progress.duration > 0
    ? `${(progress.position / progress.duration) * 100}%`
    : '0%';

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.back}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.playlistLabel} numberOfLines={1}>{playlist.name}</Text>
        <View style={{ width: 32 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color="#7c3aed" size="large" />
        </View>
      ) : (
        <>
          {/* Art placeholder */}
          <View style={styles.artWrap}>
            <View style={styles.art}>
              <Text style={styles.artIcon}>♪</Text>
            </View>
          </View>

          {/* Track info */}
          <View style={styles.info}>
            <Text style={styles.trackTitle} numberOfLines={2}>
              {activeTrack?.title || '—'}
            </Text>
            <Text style={styles.trackArtist}>{activeTrack?.artist || '—'}</Text>
          </View>

          {/* Progress */}
          <View style={styles.progressWrap}>
            <View style={styles.track}>
              <View style={[styles.fill, { width: progressPct }]} />
            </View>
            <View style={styles.times}>
              <Text style={styles.time}>{fmt(progress.position)}</Text>
              <Text style={styles.time}>{fmt(progress.duration)}</Text>
            </View>
          </View>

          {/* Controls */}
          <View style={styles.controls}>
            <TouchableOpacity onPress={() => TrackPlayer.skipToPrevious()}>
              <Text style={styles.skip}>⏮</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.playBtn}
              onPress={() => isPlaying ? TrackPlayer.pause() : TrackPlayer.play()}
            >
              <Text style={styles.playIcon}>{isPlaying ? '⏸' : '▶'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => TrackPlayer.skipToNext()}>
              <Text style={styles.skip}>⏭</Text>
            </TouchableOpacity>
          </View>

          {/* Shuffle */}
          <View style={styles.extras}>
            <TouchableOpacity onPress={toggleShuffle}>
              <Text style={[styles.extraBtn, isShuffled && styles.extraOn]}>⇄  Shuffle</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 56, paddingHorizontal: 20, paddingBottom: 16,
  },
  back: { color: '#7c3aed', fontSize: 34, lineHeight: 38, width: 32 },
  playlistLabel: { color: '#555', fontSize: 13, fontWeight: '500', flex: 1, textAlign: 'center' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  artWrap: { alignItems: 'center', marginTop: 16, marginBottom: 36 },
  art: {
    width: 250, height: 250, backgroundColor: '#111', borderRadius: 16,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: '#2a1f3d',
  },
  artIcon: { fontSize: 72, opacity: 0.2 },
  info: { paddingHorizontal: 32, marginBottom: 28 },
  trackTitle: { color: '#fff', fontSize: 21, fontWeight: '700', letterSpacing: -0.3, marginBottom: 6 },
  trackArtist: { color: '#555', fontSize: 14 },
  progressWrap: { paddingHorizontal: 32, marginBottom: 36 },
  track: { height: 3, backgroundColor: '#1e1e1e', borderRadius: 2, marginBottom: 8 },
  fill: { height: '100%', backgroundColor: '#7c3aed', borderRadius: 2 },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  time: { color: '#444', fontSize: 11 },
  controls: {
    flexDirection: 'row', justifyContent: 'center',
    alignItems: 'center', gap: 36, marginBottom: 36,
  },
  skip: { fontSize: 26, color: '#bbb' },
  playBtn: {
    width: 70, height: 70, borderRadius: 35,
    backgroundColor: '#7c3aed', justifyContent: 'center', alignItems: 'center',
  },
  playIcon: { fontSize: 26, color: '#fff' },
  extras: { flexDirection: 'row', justifyContent: 'center' },
  extraBtn: { color: '#444', fontSize: 14, fontWeight: '500' },
  extraOn: { color: '#7c3aed' },
});