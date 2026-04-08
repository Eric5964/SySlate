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
          <View style={s.sheetHandle} />
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
          <View style={s.sheetHandle} />
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
  topBar:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, marginBottom: 32 },
  topBtn:        { padding: 8 },
  topIcon:       { color: '#7c3aed', fontSize: 22 },
  topTag:        { color: '#7c3aed', fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },
  topLabel:      { color: '#444', fontSize: 13, flex: 1, textAlign: 'center', letterSpacing: 0.3 },
  topRight:      { flexDirection: 'row', gap: 4 },

  artWrap:       { alignItems: 'center', marginBottom: 36 },
  art:           {
    width: width - 64, height: width - 64,
    backgroundColor: '#0f0f0f',
    borderRadius: 20,
    borderWidth: 1, borderColor: '#1e1535',
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#7c3aed', shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18, shadowRadius: 24,
  },
  artNote:       { fontSize: 80, color: '#1e1535' },

  info:          { paddingHorizontal: 28, marginBottom: 24 },
  trackTitle:    { color: '#f0f0f0', fontSize: 22, fontWeight: '700', marginBottom: 4, letterSpacing: -0.3 },
  trackArtist:   { color: '#7c3aed', fontSize: 14, fontWeight: '500', letterSpacing: 0.2 },

  progressSection: { paddingHorizontal: 28, marginBottom: 32 },
  progressTouch: { height: 28, justifyContent: 'center' },
  progressTrack: { height: 3, backgroundColor: '#1a1a1a', borderRadius: 2 },
  progressFill:  { height: 3, backgroundColor: '#7c3aed', borderRadius: 2 },
  times:         { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  time:          { color: '#3a3a3a', fontSize: 11, letterSpacing: 0.5 },

  controls:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 28 },
  sideBtn:       { width: 52, alignItems: 'center' },
  sideTxt:       { color: '#333', fontSize: 10, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  sideTxtActive: { color: '#7c3aed' },
  skipBtn:       { padding: 10 },
  skipIcon:      { color: '#ccc', fontSize: 26 },
  playBtn:       {
    width: 68, height: 68, borderRadius: 34,
    backgroundColor: '#7c3aed',
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#7c3aed', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4, shadowRadius: 14,
  },
  playIcon:      { color: '#fff', fontSize: 26 },

  overlay:       { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet:         {
    backgroundColor: '#0f0f0f',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 24, paddingTop: 12, paddingBottom: 48,
  },
  sheetHandle:   { width: 36, height: 4, backgroundColor: '#222', borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
  sheetTitle:    { color: '#666', fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 16 },
  presetRow:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 16 },
  presetName:    { color: '#555', fontSize: 16 },
  presetActive:  { color: '#f0f0f0', fontWeight: '600' },
  check:         { color: '#7c3aed', fontSize: 18 },
  queueEmpty:    { color: '#333', fontSize: 14, textAlign: 'center', paddingVertical: 24 },
  qRow:          { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  qNum:          { color: '#2a2a2a', fontSize: 13, width: 28 },
  qTitle:        { color: '#d0d0d0', fontSize: 14, fontWeight: '500' },
  qArtist:       { color: '#444', fontSize: 12, marginTop: 2 },
});