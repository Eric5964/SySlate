import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import TrackPlayer, { Event } from 'react-native-track-player';
import { buildQueue, shuffleArray } from '../utils/shuffle';
import { playWithRamp, isTransitionLocked } from '../services/PlaybackService';
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
    // Songs added via swipe-to-queue, or promoted from up-next. Always sit
    // immediately after the currently playing track, ahead of the rest.
    const [priorityQueue, setPriorityQueue] = useState([]); // array of song ids, in insertion order

    const playlistRef = useRef(null);
    useEffect(() => { playlistRef.current = currentPlaylist; }, [currentPlaylist]);

    const priorityRef = useRef([]);
    useEffect(() => { priorityRef.current = priorityQueue; }, [priorityQueue]);

    // Remembers the last non-off shuffle mode so turning shuffle off and back
    // on restores what you had, instead of always resetting to Full Cycle.
    const lastActiveModeRef = useRef('full_cycle');
    useEffect(() => { if (shuffleMode !== 'off') lastActiveModeRef.current = shuffleMode; }, [shuffleMode]);

    // Without this, shuffleMode/shuffleOn sit at their hardcoded defaults
    // until the user actually starts playback, so re-opening the app and
    // checking Settings (or toggling shuffle) before playing anything showed
    // the wrong persisted mode.
    useEffect(() => {
        getShuffleMode().then(mode => {
            setShuffleModeState(mode);
            setShuffleOn(mode !== 'off');
        });
    }, []);

    // Now-playing always comes from the REAL native queue (TrackPlayer.getTrack),
    // never from a JS-side cached copy — a cached copy goes stale the moment
    // addToQueue/removeFromQueue/jumpToQueueIndex mutate the real queue, which
    // was the cause of the wrong song sometimes showing as "playing."
    useEffect(() => {
        const sub = TrackPlayer.addEventListener(Event.PlaybackTrackChanged, async ({ nextTrack }) => {
            if (nextTrack === null || nextTrack === undefined) return;
            try {
                let track = await TrackPlayer.getTrack(nextTrack);
                if (!track) {
                    await new Promise(r => setTimeout(r, 80));
                    track = await TrackPlayer.getTrack(nextTrack);
                }
                if (!track) return;
                setCurrentTrack(track);
                await incrementPlayCount(track.id);
                if (priorityRef.current.includes(track.id)) {
                    const next = priorityRef.current.filter(id => id !== track.id);
                    priorityRef.current = next;
                    setPriorityQueue(next);
                }
            } catch { }
        });
        return () => sub.remove();
    }, []);

    // Insert a song right after the current track, after any songs already
    // priority-queued. If this exact song already exists later in the queue,
    // that occurrence is removed first so "play next" doesn't create a
    // duplicate entry.
    const addToQueue = useCallback(async (song) => {
        try {
            const currentIndex = await TrackPlayer.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return;
            const queue = await TrackPlayer.getQueue();
            const dupeIdx = queue.findIndex((t, i) => t.id === song.id && i > currentIndex);
            let priority = priorityRef.current;
            if (dupeIdx !== -1) {
                await TrackPlayer.remove(dupeIdx);
                priority = priority.filter(id => id !== song.id);
            }
            const insertAt = currentIndex + 1 + priority.length;
            await TrackPlayer.add({ ...song }, insertAt);
            priority = [...priority, song.id];
            priorityRef.current = priority;
            setPriorityQueue(priority);
        } catch (e) { console.error('addToQueue:', e); }
    }, []);

    // Promote an existing up-next song to the priority section (swipe-right
    // on a non-priority row inside the queue view).
    const promoteToQueue = useCallback(async (songId) => {
        try {
            const currentIndex = await TrackPlayer.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return;
            const queue = await TrackPlayer.getQueue();
            const idx = queue.findIndex(t => t.id === songId);
            if (idx === -1 || idx <= currentIndex) return;
            const track = queue[idx];
            await TrackPlayer.remove(idx);
            const insertAt = currentIndex + 1 + priorityRef.current.length;
            await TrackPlayer.add(track, insertAt);
            const next = [...priorityRef.current, songId];
            priorityRef.current = next;
            setPriorityQueue(next);
        } catch (e) { console.error('promoteToQueue:', e); }
    }, []);

    // Remove a song from wherever it currently sits in the real queue —
    // looked up by id at call time rather than trusting a numeric index that
    // may have gone stale between render and tap. Does not touch any files.
    const removeFromQueue = useCallback(async (songId) => {
        try {
            const queue = await TrackPlayer.getQueue();
            const idx = queue.findIndex(t => t.id === songId);
            if (idx === -1) return;
            await TrackPlayer.remove(idx);
            const next = priorityRef.current.filter(id => id !== songId);
            priorityRef.current = next;
            setPriorityQueue(next);
        } catch (e) { console.error('removeFromQueue:', e); }
    }, []);

    // Jump playback directly to a song elsewhere in the queue (tap in the
    // queue list). Any priority-queued songs sitting between "now" and the
    // tapped song are relocated to right after the tapped song instead of
    // being skipped over and stranded until the next full loop.
    const jumpToQueueIndex = useCallback(async (realIndex) => {
        if (isTransitionLocked()) return;
        try {
            const currentIndex = await TrackPlayer.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return;
            const priorityCount = priorityRef.current.length;
            const priorityStart = currentIndex + 1;
            const priorityEnd = priorityStart + priorityCount;

            if (realIndex < priorityEnd) {
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
        if (isTransitionLocked()) return;
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
        priorityRef.current = [];
        await setSession(playlist.path, { queue, index: startIndex });
    }, []);

    // Always builds a fresh queue in the given order and starts at index 0 —
    // bypasses any cached session so "Play" reliably starts at the top of
    // the currently-applied sort, instead of sometimes resuming a stale
    // shuffled session from a previous visit.
    const playPlaylistOrdered = useCallback(async (playlist, orderedSongs) => {
        if (isTransitionLocked()) return;
        const eq = await getEQPreset(playlist.path);
        const queue = [...orderedSongs];
        await TrackPlayer.reset();
        await TrackPlayer.add(queue);
        await setQueueLoop();
        await playWithRamp();

        const pl = { ...playlist, queue };
        setCurrentPlaylist(pl);
        setCurrentTrack(queue[0] ?? null);
        setShuffleModeState('off');
        setShuffleOn(false);
        setEqPresetId(eq);
        setSingleLoop(false);
        setPriorityQueue([]);
        priorityRef.current = [];
        await setSession(playlist.path, { queue, index: 0 });
    }, []);

    // Always builds a fresh shuffled queue and starts at index 0 (which, since
    // the queue itself is shuffled, is effectively "a random song") — also
    // bypasses any cached session.
    const playPlaylistShuffled = useCallback(async (playlist) => {
        if (isTransitionLocked()) return;
        const mode = await getShuffleMode();
        const eq = await getEQPreset(playlist.path);
        const useMode = mode === 'off' ? (lastActiveModeRef.current === 'off' ? 'full_cycle' : lastActiveModeRef.current) : mode;
        const queue = buildQueue(playlist.songs, useMode);
        await TrackPlayer.reset();
        await TrackPlayer.add(queue);
        await setQueueLoop();
        await playWithRamp();

        const pl = { ...playlist, queue };
        setCurrentPlaylist(pl);
        setCurrentTrack(queue[0] ?? null);
        setShuffleModeState(useMode);
        setShuffleOn(true);
        setEqPresetId(eq);
        setSingleLoop(false);
        setPriorityQueue([]);
        priorityRef.current = [];
        await setSession(playlist.path, { queue, index: 0 });
        await setShuffleMode(useMode);
    }, []);

    const playSongFromPlaylist = useCallback(async (playlist, songId) => {
        if (isTransitionLocked()) return;
        const mode = await getShuffleMode();
        const eq = await getEQPreset(playlist.path);
        const isOn = mode !== 'off';
        const song = playlist.songs.find(s => s.id === songId);
        if (!song) { console.warn('Song not found:', songId); return; }

        // Switching to a different song WITHIN the same already-loaded playlist
        // preserves the existing priority queue (splicing it back in right
        // after the new starting song) instead of wiping it out. Switching to
        // a genuinely different playlist still starts clean.
        const isSamePlaylist = currentPlaylist?.path === playlist.path;
        const keepIds = isSamePlaylist ? priorityRef.current : [];
        const keepSet = new Set(keepIds);
        const prioritySongs = keepIds
            .map(id => playlist.songs.find(s => s.id === id))
            .filter(Boolean);

        let rest = playlist.songs.filter(s => s.id !== songId && !keepSet.has(s.id));
        if (isOn) rest = shuffleArray(rest);

        const queue = [song, ...prioritySongs, ...rest];

        await TrackPlayer.reset();
        await TrackPlayer.add(queue);
        await setQueueLoop();
        await playWithRamp();

        const pl = { ...playlist, queue };
        setCurrentPlaylist(pl);
        setCurrentTrack(song);
        setShuffleModeState(mode);
        setShuffleOn(isOn);
        setEqPresetId(eq);
        setSingleLoop(false);
        if (!isSamePlaylist) {
            setPriorityQueue([]);
            priorityRef.current = [];
        }
        await setSession(playlist.path, { queue, index: 0 });
    }, [currentPlaylist]);

    const toggleShuffle = useCallback(async () => {
        const newOn = !shuffleOn;
        setShuffleOn(newOn);
        const mode = newOn ? (lastActiveModeRef.current === 'off' ? 'full_cycle' : lastActiveModeRef.current) : 'off';
        setShuffleModeState(mode);
        await setShuffleMode(mode);
    }, [shuffleOn]);

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
        if (!pl?.path) return;
        try {
            const index = await TrackPlayer.getCurrentTrack();
            if (index !== null) {
                const queue = await TrackPlayer.getQueue();
                let pos = 0;
                try { const p = await TrackPlayer.getProgress(); pos = p?.position ?? 0; } catch { }
                await setSession(pl.path, { queue, index });
                await setLastSession({ playlist: { ...pl, queue }, index, position: pos });
            }
        } catch { }
    }, []);

    return (
        <Ctx.Provider value={{
            currentPlaylist, currentTrack, shuffleOn, shuffleMode, eqPresetId, singleLoop, priorityQueue,
            loadPlaylist, playSongFromPlaylist, playPlaylistOrdered, playPlaylistShuffled,
            toggleShuffle, changeShuffleMode, toggleSingleLoop, changeEQPreset, saveSession,
            addToQueue, removeFromQueue, promoteToQueue, jumpToQueueIndex,
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
