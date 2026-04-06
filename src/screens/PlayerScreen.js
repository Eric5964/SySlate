import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Dimensions, Modal, FlatList,
} from 'react-native';
import TrackPlayer, { useProgress, usePlaybackState, State, Event } from 'react-native-track-player';
import { useNavigation, useRoute } from '@react-navigation/native';
import { usePlayback } from '../context/PlaybackContext';
import { EQ_PRESETS } from '../utils/eq';
import { skipWithCrossfade } from '../services/PlaybackService';

const { width } = Dimensions.get('window');

function fmt(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const SHUFFLE_CYCLE = ['off', 'full_cycle', 'true_random', 'smart'];
const SHUFFLE_LABEL = { off: 'Off', full_cycle: 'Cycle', true_random: 'Random', smart: 'Smart' };

export default function PlayerScreen() {
  const navigation = useNavigation();
  const route      = useRoute();
  const { playlist } = route.params ?? {};

  const {
    currentPlaylist, eqPresetId, shuffleMode,
    loadPlaylist, changeEQPreset, changeShuffleMode, saveSession,
  } = usePlayback();

  const progress      = useProgress();
  const playbackState = usePlaybackState();
  const isPlaying     = playbackState.state === State.Playing;

  const [track,       setTrack]      = useState(null);
  const [showEQ,      setShowEQ]     = useState(false);
  const [showQueue,   setShowQueue]  = useState(false);
  const [queue,       setQueue]      = useState([]);

  // Load playlist if arriving fresh from the playlists screen
  useEffect(() => {
    if (playlist) loadPlaylist(playlist);
  }, []);

  // Track current song
  useEffect(() => {
    const refresh = async () => {
      const idx = await TrackPlayer.getCurrentTrack();
      if (idx !== null) { setTrack(await TrackPlayer.getTrack(idx)); saveSession(); }
    };
    refresh();
    const sub = TrackPlayer.addEventListener(Event.PlaybackTrackChanged, refresh);
    return () => sub.remove();
  }, []);

  const openQueue = async () => {
    const q   = await TrackPlayer.getQueue();
    const idx = await TrackPlayer.getCurrentTrack();
    setQueue(q.slice(idx !== null ? idx + 1 : 0));
    setShowQueue(true);
  };

  const seek = (px) => {
    const ratio = Math.max(0, Math.min(1, px / (width - 48)));
    TrackPlayer.seekTo(ratio * progress.duration);
  };

  const cycleShuffleMode = () => {
    const next = SHUFFLE_CYCLE[(SHUFFLE_CYCLE.indexOf(shuffleMode) + 1) % SHUFFLE_CYCLE.length];
    changeShuffleMode(next);
  };

  const playlistPath = currentPlaylist?.path;

  return (
    <View style={s.container}>
      {/* Top bar */}
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.topBtn}>
          <Text style={s.topIcon}>↓</Text>
        </TouchableOpacity>
        <Text style={s.topLabel} numberOfLines={1}>
          {currentPlaylist?.name ?? 'Now Playing'}
        </Text>
        <View style={s.topRight}>
          <TouchableOpacity onPress={() => setShowEQ(true)} style={s.topBtn}>
            <Text style={s.topTag}>EQ</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={openQueue} style={s.topBtn}>
            <Text style={s.topTag}>≡</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Art */}
      <View style={s.artWrap}>
        <View style={s.art}>
          <Text style={s.artNote}>♪</Text>
        </View>
      </View>

      {/* Info */}
      <View style={s.info}>
        <Text style={s.trackTitle}  numberOfLines={2}>{track?.title  ?? '—'}</Text>
        <Text style={s.trackArtist} numberOfLines={1}>{track?.artist ?? '—'}</Text>
      </View>

      {/* Progress bar */}
      <View style={s.progressSection}>
        <TouchableOpacity
          style={s.progressTouch}
          onPress={e => seek(e.nativeEvent.locationX)}
          activeOpacity={1}
        >
          <View style={s.progressTrack}>
            <View style={[s.progressFill, {
              width: `${progress.duration > 0 ? (progress.position / progress.duration) * 100 : 0}%`
            }]} />
          </View>
        </TouchableOpacity>
        <View style={s.times}>
          <Text style={s.time}>{fmt(progress.position)}</Text>
          <Text style={s.time}>{fmt(progress.duration)}</Text>
        </View>
      </View>

      {/* Controls */}
      <View style={s.controls}>
        <TouchableOpacity onPress={cycleShuffleMode} style={s.sideBtn}>
          <Text style={[s.sideTxt, shuffleMode !== 'off' && s.sideTxtActive]}>
            {SHUFFLE_LABEL[shuffleMode]}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => skipWithCrossfade('prev')} style={s.skipBtn}>
          <Text style={s.skipIcon}>⏮</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => isPlaying ? TrackPlayer.pause() : TrackPlayer.play()} style={s.playBtn}>
          <Text style={s.playIcon}>{isPlaying ? '⏸' : '▶'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => skipWithCrossfade('next')} style={s.skipBtn}>
          <Text style={s.skipIcon}>⏭</Text>
        </TouchableOpacity>
        <View style={s.sideBtn} />
      </View>

      {/* EQ modal */}
      <Modal visible={showEQ} transparent animationType="slide" onRequestClose={() => setShowEQ(false)}>
        <TouchableOpacity style={s.overlay} onPress={() => setShowEQ(false)} />
        <View style={s.sheet}>
          <Text style={s.sheetTitle}>EQ Preset</Text>
          {EQ_PRESETS.map(p => (
            <TouchableOpacity
              key={p.id}
              style={s.presetRow}
              onPress={() => { changeEQPreset(p.id, playlistPath); setShowEQ(false); }}
            >
              <Text style={[s.presetName, eqPresetId === p.id && s.presetActive]}>{p.name}</Text>
              {eqPresetId === p.id && <Text style={s.check}>✓</Text>}
            </TouchableOpacity>
          ))}
        </View>
      </Modal>

      {/* Queue modal */}
      <Modal visible={showQueue} transparent animationType="slide" onRequestClose={() => setShowQueue(false)}>
        <TouchableOpacity style={s.overlay} onPress={() => setShowQueue(false)} />
        <View style={s.sheet}>
          <Text style={s.sheetTitle}>Up Next</Text>
          {queue.length === 0
            ? <Text style={s.queueEmpty}>Nothing queued</Text>
            : <FlatList
                data={queue}
                keyExtractor={(item, i) => item.id + i}
                style={{ maxHeight: 320 }}
                renderItem={({ item, index }) => (
                  <View style={s.qRow}>
                    <Text style={s.qNum}>{index + 1}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={s.qTitle}  numberOfLines={1}>{item.title}</Text>
                      <Text style={s.qArtist} numberOfLines={1}>{item.artist}</Text>
                    </View>
                  </View>
                )}
              />
          }
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container:     { flex: 1, backgroundColor: '#0a0a0a', paddingTop: 56 },
  topBar:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, marginBottom: 24 },
  topBtn:        { padding: 8 },
  topIcon:       { color: '#7c3aed', fontSize: 22 },
  topTag:        { color: '#7c3aed', fontSize: 13, fontWeight: '700' },
  topLabel:      { color: '#555', fontSize: 13, fontWeight: '500', flex: 1, textAlign: 'center' },
  topRight:      { flexDirection: 'row' },
  artWrap:       { alignItems: 'center', marginBottom: 28 },
  art:           { width: width - 80, height: width - 80, backgroundColor: '#111', borderRadius: 14, borderWidth: 1, borderColor: '#2a1f3d', justifyContent: 'center', alignItems: 'center' },
  artNote:       { fontSize: 72, color: '#2a1f3d' },
  info:          { paddingHorizontal: 24, marginBottom: 20 },
  trackTitle:    { color: '#e5e5e5', fontSize: 20, fontWeight: '700', marginBottom: 6 },
  trackArtist:   { color: '#7c3aed', fontSize: 14, fontWeight: '500' },
  progressSection: { paddingHorizontal: 24, marginBottom: 28 },
  progressTouch: { height: 24, justifyContent: 'center' },
  progressTrack: { height: 3, backgroundColor: '#1e1e1e', borderRadius: 2 },
  progressFill:  { height: 3, backgroundColor: '#7c3aed', borderRadius: 2 },
  times:         { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  time:          { color: '#444', fontSize: 12 },
  controls:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24 },
  sideBtn:       { width: 56, alignItems: 'center' },
  sideTxt:       { color: '#444', fontSize: 11, fontWeight: '700' },
  sideTxtActive: { color: '#7c3aed' },
  skipBtn:       { padding: 12 },
  skipIcon:      { color: '#e5e5e5', fontSize: 28 },
  playBtn:       { width: 72, height: 72, borderRadius: 36, backgroundColor: '#7c3aed', justifyContent: 'center', alignItems: 'center' },
  playIcon:      { color: '#fff', fontSize: 28 },
  overlay:       { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet:         { backgroundColor: '#111', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: 44 },
  sheetTitle:    { color: '#e5e5e5', fontSize: 16, fontWeight: '700', marginBottom: 16 },
  presetRow:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  presetName:    { color: '#888', fontSize: 15 },
  presetActive:  { color: '#e5e5e5', fontWeight: '600' },
  check:         { color: '#7c3aed', fontSize: 16 },
  queueEmpty:    { color: '#555', fontSize: 14, textAlign: 'center', paddingVertical: 20 },
  qRow:          { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  qNum:          { color: '#444', fontSize: 13, width: 28 },
  qTitle:        { color: '#e5e5e5', fontSize: 14, fontWeight: '500' },
  qArtist:       { color: '#555', fontSize: 12, marginTop: 2 },
});