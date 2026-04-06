import React, { createContext, useContext, useState, useCallback } from 'react';
import TrackPlayer from 'react-native-track-player';
import { buildQueue, shuffleArray } from '../utils/shuffle';
import {
  getShuffleMode, setShuffleMode,
  getEQPreset,    setEQPreset,
  getSession,     setSession,
} from '../utils/storage';

const Ctx = createContext(null);

export function PlaybackProvider({ children }) {
  const [currentPlaylist, setCurrentPlaylist] = useState(null);
  const [shuffleMode,     setShuffleModeState] = useState('full_cycle');
  const [eqPresetId,      setEqPresetId]        = useState('flat');

  const loadPlaylist = useCallback(async (playlist, forceIndex = null) => {
    const mode    = await getShuffleMode();
    const eq      = await getEQPreset(playlist.path);
    const session = await getSession(playlist.path);

    let queue      = session?.queue ?? buildQueue(playlist.songs, mode);
    let startIndex = forceIndex ?? session?.index ?? 0;

    await TrackPlayer.reset();
    await TrackPlayer.add(queue);
    await TrackPlayer.skip(startIndex);
    await TrackPlayer.play();

    setCurrentPlaylist({ ...playlist, queue });
    setShuffleModeState(mode);
    setEqPresetId(eq);
    await setSession(playlist.path, { queue, index: startIndex });
  }, []);

  const playSongFromPlaylist = useCallback(async (playlist, songIndex) => {
    const mode = await getShuffleMode();
    const eq   = await getEQPreset(playlist.path);

    let queue;
    if (mode === 'off') {
      queue = [...playlist.songs];
    } else {
      const others = playlist.songs.filter((_, i) => i !== songIndex);
      queue = [playlist.songs[songIndex], ...shuffleArray(others)];
    }

    await TrackPlayer.reset();
    await TrackPlayer.add(queue);
    await TrackPlayer.skip(0);
    await TrackPlayer.play();

    setCurrentPlaylist({ ...playlist, queue });
    setShuffleModeState(mode);
    setEqPresetId(eq);
    await setSession(playlist.path, { queue, index: 0 });
  }, []);

  const changeEQPreset = useCallback(async (presetId, playlistPath) => {
    setEqPresetId(presetId);
    await setEQPreset(presetId, playlistPath);
    // AVAudioEngine wiring goes here in a later phase
  }, []);

  const changeShuffleMode = useCallback(async (mode) => {
    setShuffleModeState(mode);
    await setShuffleMode(mode);
  }, []);

  const saveSession = useCallback(async () => {
    if (!currentPlaylist?.path || !currentPlaylist?.queue) return;
    try {
      const index = await TrackPlayer.getCurrentTrack();
      if (index !== null) await setSession(currentPlaylist.path, { queue: currentPlaylist.queue, index });
    } catch {}
  }, [currentPlaylist]);

  return (
    <Ctx.Provider value={{
      currentPlaylist, shuffleMode, eqPresetId,
      loadPlaylist, playSongFromPlaylist,
      changeEQPreset, changeShuffleMode, saveSession,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export const usePlayback = () => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePlayback outside PlaybackProvider');
  return ctx;
};