import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import TrackPlayer, { Event } from 'react-native-track-player';
import { buildQueue, shuffleArray } from '../utils/shuffle';
import { playWithRamp } from '../services/PlaybackService';
import {
    getShuffleMode, setShuffleMode, getEQPreset, setEQPreset,
    getSession, setSession, setLastSession, incrementPlayCount,
} from '../utils/storage';

const Ctx = createContext(null);

const setQueueLoop = async () => {
    try { const { RepeatMode } = require('react-native-track-player'); await TrackPlayer.setRepeatMode(RepeatMode.Queue); } catch { }
};

export function PlaybackProvider({ children }) {
    const [currentPlaylist, setCurrentPlaylist] = useState(null);
    const [currentTrack, setCurrentTrack] = useState(null);
    const [shuffleOn, setShuffleOn] = useState(false);
    const [shuffleMode, setShuffleModeState] = useState('full_cycle');
    const [eqPresetId, setEqPresetId] = useState('flat');
    const [singleLoop, setSingleLoop] = useState(false);

    // Keep playlist ref so event listeners can access it without stale closures
    const playlistRef = useRef(null);
    useEffect(() => { playlistRef.current = currentPlaylist; }, [currentPlaylist]);

    useEffect(() => {
        const sub = TrackPlayer.addEventListener(Event.PlaybackTrackChanged, async ({ nextTrack }) => {
            if (nextTrack === null || nextTrack === undefined) return;
            const playlist = playlistRef.current;
            if (playlist?.queue?.[nextTrack]) {
                const song = playlist.queue[nextTrack];
                setCurrentTrack(song);
                await incrementPlayCount(song.id);
            }
        });
        return () => sub.remove();
    }, []);

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
        await setQueueLoop();
        await playWithRamp();

        const pl = { ...playlist, queue };
        setCurrentPlaylist(pl);
        setCurrentTrack(queue[startIndex] ?? null);
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
        let startIdx = 0;
        if (!isOn) {
            queue = [...playlist.songs];
            startIdx = queue.findIndex(s => s.id === songId);
        } else {
            queue = [song, ...shuffleArray(playlist.songs.filter(s => s.id !== songId))];
        }

        await TrackPlayer.reset();
        await TrackPlayer.add(queue);
        if (startIdx > 0) await TrackPlayer.skip(startIdx);
        await setQueueLoop();
        await playWithRamp();

        const pl = { ...playlist, queue };
        setCurrentPlaylist(pl);
        setCurrentTrack(queue[startIdx] ?? null);
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
        const next = !singleLoop;
        setSingleLoop(next);
        try {
            const { RepeatMode } = require('react-native-track-player');
            await TrackPlayer.setRepeatMode(next ? RepeatMode.Track : RepeatMode.Queue);
        } catch { }
    }, [singleLoop]);

    const changeEQPreset = useCallback(async (id, path) => {
        setEqPresetId(id);
        await setEQPreset(id, path);
    }, []);

    const saveSession = useCallback(async () => {
        const pl = playlistRef.current;
        if (!pl?.path || !pl?.queue) return;
        try {
            const index = await TrackPlayer.getCurrentTrack();
            if (index !== null) {
                let pos = 0;
                try { const p = await TrackPlayer.getProgress(); pos = p?.position ?? 0; } catch { }
                await setSession(pl.path, { queue: pl.queue, index });
                await setLastSession({ playlist: pl, index, position: pos });
            }
        } catch { }
    }, []);

    return (
        <Ctx.Provider value={{
            currentPlaylist, currentTrack, shuffleOn, shuffleMode, eqPresetId, singleLoop,
            loadPlaylist, playSongFromPlaylist, toggleShuffle, changeShuffleMode,
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