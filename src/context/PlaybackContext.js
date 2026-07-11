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
    // Songs added via swipe-to-queue. These are always inserted immediately
    // after the currently playing track, ahead of the regular up-next order.
    const [priorityQueue, setPriorityQueue] = useState([]); // array of song ids, in insertion order

    // Keep playlist ref so event listeners can access it without stale closures
    const playlistRef = useRef(null);
    useEffect(() => { playlistRef.current = currentPlaylist; }, [currentPlaylist]);

    const priorityRef = useRef([]);
    useEffect(() => { priorityRef.current = priorityQueue; }, [priorityQueue]);

    useEffect(() => {
        const sub = TrackPlayer.addEventListener(Event.PlaybackTrackChanged, async ({ nextTrack }) => {
            if (nextTrack === null || nextTrack === undefined) return;
            const playlist = playlistRef.current;
            if (playlist?.queue?.[nextTrack]) {
                const song = playlist.queue[nextTrack];
                setCurrentTrack(song);
                await incrementPlayCount(song.id);
                // Once a priority song becomes the one actually playing, it's no
                // longer "queued" — drop it from the priority list.
                if (priorityRef.current.includes(song.id)) {
                    setPriorityQueue(pq => pq.filter(id => id !== song.id));
                }
            }
        });
        return () => sub.remove();
    }, []);

    // Insert a song right after the current track, after any songs already
    // priority-queued (so multiple swipe-adds stack in the order added).
    const addToQueue = useCallback(async (song) => {
        try {
            const currentIndex = await TrackPlayer.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return;
            const insertAt = currentIndex + 1 + priorityRef.current.length;
            await TrackPlayer.add({ ...song }, insertAt);
            setPriorityQueue(pq => [...pq, song.id]);
        } catch (e) { console.error('addToQueue:', e); }
    }, []);

    // Remove an arbitrary item from the queue by its real (absolute) index —
    // used for swipe-to-delete inside the queue view. Does not touch files.
    const removeFromQueue = useCallback(async (realIndex) => {
        try {
            const queue = await TrackPlayer.getQueue();
            const track = queue[realIndex];
            await TrackPlayer.remove(realIndex);
            if (track && priorityRef.current.includes(track.id)) {
                setPriorityQueue(pq => pq.filter(id => id !== track.id));
            }
        } catch (e) { console.error('removeFromQueue:', e); }
    }, []);

    // Jump playback directly to a song elsewhere in the queue (tap in the
    // queue list). Any priority-queued songs sitting between "now" and the
    // tapped song are relocated to right after the tapped song instead of
    // being skipped over and stranded until the next full loop.
    const jumpToQueueIndex = useCallback(async (realIndex) => {
        try {
            const currentIndex = await TrackPlayer.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return;
            const priorityCount = priorityRef.current.length;
            const priorityStart = currentIndex + 1;
            const priorityEnd = priorityStart + priorityCount;

            if (realIndex < priorityEnd) {
                // Tapped a song within the priority section (or current) — nothing to relocate
                await TrackPlayer.skip(realIndex);
                return;
            }

            const queue = await TrackPlayer.getQueue();
            const priorityTracks = queue.slice(priorityStart, priorityEnd);
            for (let i = priorityEnd - 1; i >= priorityStart; i--) {
                await TrackPlayer.remove(i);
            }
            const newTargetIndex = realIndex - priorityCount;
            if (priorityTracks.length) {
                await TrackPlayer.add(priorityTracks, newTargetIndex + 1);
            }
            await TrackPlayer.skip(newTargetIndex);
        } catch (e) { console.error('jumpToQueueIndex:', e); }
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
        setPriorityQueue([]);
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
        setPriorityQueue([]);
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
            currentPlaylist, currentTrack, shuffleOn, shuffleMode, eqPresetId, singleLoop, priorityQueue,
            loadPlaylist, playSongFromPlaylist, toggleShuffle, changeShuffleMode,
            toggleSingleLoop, changeEQPreset, saveSession,
            addToQueue, removeFromQueue, jumpToQueueIndex,
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