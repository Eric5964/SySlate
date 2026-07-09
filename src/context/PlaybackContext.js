import React, { createContext, useContext, useState, useCallback } from 'react';
import TrackPlayer from 'react-native-track-player';
import { buildQueue, shuffleArray } from '../utils/shuffle';
import { playWithRamp } from '../services/PlaybackService';
import {
    getShuffleMode, setShuffleMode,
    getEQPreset, setEQPreset,
    getSession, setSession,
    setLastSession,
} from '../utils/storage';

const Ctx = createContext(null);

const setQueueRepeat = async () => {
    try {
        const { RepeatMode } = require('react-native-track-player');
        await TrackPlayer.setRepeatMode(RepeatMode.Queue);
    } catch { }
};

export function PlaybackProvider({ children }) {
    const [currentPlaylist, setCurrentPlaylist] = useState(null);
    const [shuffleOn, setShuffleOn] = useState(false);
    const [shuffleMode, setShuffleModeState] = useState('full_cycle');
    const [eqPresetId, setEqPresetId] = useState('flat');
    const [singleLoop, setSingleLoop] = useState(false);

    const loadPlaylist = useCallback(async (playlist, forceIndex = null) => {
        const mode = await getShuffleMode();
        const eq = await getEQPreset(playlist.path);
        const session = await getSession(playlist.path);
        const isOn = mode !== 'off';

        let queue = session?.queue ?? (isOn ? buildQueue(playlist.songs, mode) : [...playlist.songs]);
        let startIndex = forceIndex ?? session?.index ?? 0;
        if (startIndex >= queue.length) startIndex = 0;

        await TrackPlayer.reset();
        await TrackPlayer.add(queue);
        if (startIndex > 0) await TrackPlayer.skip(startIndex);
        await setQueueRepeat();
        await playWithRamp();

        setCurrentPlaylist({ ...playlist, queue });
        setShuffleModeState(mode);
        setShuffleOn(isOn);
        setEqPresetId(eq);
        setSingleLoop(false);
        await setSession(playlist.path, { queue, index: startIndex });
    }, []);

    const playSongFromPlaylist = useCallback(async (playlist, songId) => {
        const mode = await getShuffleMode();
        const eq = await getEQPreset(playlist.path);
        const isOn = mode !== 'off';
        const song = playlist.songs.find(s => s.id === songId);
        if (!song) { console.warn('Song not found:', songId); return; }

        let queue;
        if (!isOn) {
            queue = [...playlist.songs];
            const idx = queue.findIndex(s => s.id === songId);
            await TrackPlayer.reset();
            await TrackPlayer.add(queue);
            if (idx > 0) await TrackPlayer.skip(idx);
        } else {
            const others = playlist.songs.filter(s => s.id !== songId);
            queue = [song, ...shuffleArray(others)];
            await TrackPlayer.reset();
            await TrackPlayer.add(queue);
        }

        await setQueueRepeat();
        await playWithRamp();

        setCurrentPlaylist({ ...playlist, queue });
        setShuffleModeState(mode);
        setShuffleOn(isOn);
        setEqPresetId(eq);
        setSingleLoop(false);
        await setSession(playlist.path, { queue, index: 0 });
    }, []);

    const toggleShuffle = useCallback(async () => {
        const newOn = !shuffleOn;
        setShuffleOn(newOn);
        const mode = newOn ? (shuffleMode === 'off' ? 'full_cycle' : shuffleMode) : 'off';
        setShuffleModeState(mode);
        await setShuffleMode(mode);
    }, [shuffleOn, shuffleMode]);

    const changeShuffleMode = useCallback(async (mode) => {
        setShuffleModeState(mode);
        setShuffleOn(mode !== 'off');
        await setShuffleMode(mode);
    }, []);

    const toggleSingleLoop = useCallback(async () => {
        const newVal = !singleLoop;
        setSingleLoop(newVal);
        try {
            const { RepeatMode } = require('react-native-track-player');
            await TrackPlayer.setRepeatMode(newVal ? RepeatMode.Track : RepeatMode.Queue);
        } catch { }
    }, [singleLoop]);

    const changeEQPreset = useCallback(async (presetId, playlistPath) => {
        setEqPresetId(presetId);
        await setEQPreset(presetId, playlistPath);
    }, []);

    const saveSession = useCallback(async () => {
        if (!currentPlaylist?.path || !currentPlaylist?.queue) return;
        try {
            const index = await TrackPlayer.getCurrentTrack();
            if (index !== null) {
                let position = 0;
                try { const p = await TrackPlayer.getProgress(); position = p?.position ?? 0; } catch { }
                await setSession(currentPlaylist.path, { queue: currentPlaylist.queue, index });
                await setLastSession({ playlist: currentPlaylist, index, position });
            }
        } catch { }
    }, [currentPlaylist]);

    return (
        <Ctx.Provider value={{
            currentPlaylist, shuffleOn, shuffleMode, eqPresetId, singleLoop,
            loadPlaylist, playSongFromPlaylist,
            toggleShuffle, changeShuffleMode,
            toggleSingleLoop, changeEQPreset, saveSession,
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