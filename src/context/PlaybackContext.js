import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import TrackPlayer, { Event } from 'react-native-track-player';
import { buildQueue, shuffleArray } from '../utils/shuffle';
import { playWithRamp, isTransitionLocked, forceReleaseFade } from '../services/PlaybackService';
import { withTimeout } from '../utils/withTimeout';
import {
    getShuffleMode, setShuffleMode, getEQPreset, setEQPreset,
    getSession, setSession, getLastSession, setLastSession, incrementPlayCount,
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
    const [priorityQueue, setPriorityQueue] = useState([]); // array of song ids, in insertion order

    const playlistRef = useRef(null);
    useEffect(() => { playlistRef.current = currentPlaylist; }, [currentPlaylist]);

    const priorityRef = useRef([]);
    useEffect(() => { priorityRef.current = priorityQueue; }, [priorityQueue]);

    const lastActiveModeRef = useRef('full_cycle');
    useEffect(() => { if (shuffleMode !== 'off') lastActiveModeRef.current = shuffleMode; }, [shuffleMode]);

    useEffect(() => {
        getShuffleMode().then(mode => {
            setShuffleModeState(mode);
            setShuffleOn(mode !== 'off');
        });
    }, []);

    const saveSessionRef = useRef(() => {});

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
                // Session save now lives HERE (always active) instead of in a
                // listener inside PlayerScreen — that one only ran while the
                // full player happened to be mounted, so most listening (via
                // the mini player) never updated the saved session at all,
                // which is why closing the app resumed a stale song/queue.
                saveSessionRef.current?.();
            } catch { }
        });
        return () => sub.remove();
    }, []);

    // Insert a song right after the current track, after any songs already
    // priority-queued. If this exact song already exists later in the queue,
    // that occurrence is removed first so "play next" doesn't create a
    // duplicate entry. Returns the updated priority list so callers (like
    // QueueModal) can refresh immediately without racing this state update.
    const addToQueue = useCallback(async (song) => {
        try {
            const currentIndex = await TrackPlayer.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return priorityRef.current;
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
            return priority;
        } catch (e) { console.error('addToQueue:', e); return priorityRef.current; }
    }, []);

    // Promote an existing up-next song to the priority section (swipe-right
    // on a non-priority row inside the queue view). Returns the updated
    // priority list for the same reason as addToQueue above — the caller
    // was showing the promoted song still under "Up Next" because it was
    // reading the pre-update priority list before this component's state
    // had actually re-rendered.
    const promoteToQueue = useCallback(async (songId) => {
        try {
            const currentIndex = await TrackPlayer.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return priorityRef.current;
            const queue = await TrackPlayer.getQueue();
            const idx = queue.findIndex(t => t.id === songId);
            if (idx === -1 || idx <= currentIndex) return priorityRef.current;
            const track = queue[idx];
            await TrackPlayer.remove(idx);
            const insertAt = currentIndex + 1 + priorityRef.current.length;
            await TrackPlayer.add(track, insertAt);
            const next = [...priorityRef.current, songId];
            priorityRef.current = next;
            setPriorityQueue(next);
            return next;
        } catch (e) { console.error('promoteToQueue:', e); return priorityRef.current; }
    }, []);

    const removeFromQueue = useCallback(async (songId) => {
        try {
            const queue = await TrackPlayer.getQueue();
            const idx = queue.findIndex(t => t.id === songId);
            if (idx === -1) return priorityRef.current;
            await TrackPlayer.remove(idx);
            const next = priorityRef.current.filter(id => id !== songId);
            priorityRef.current = next;
            setPriorityQueue(next);
            return next;
        } catch (e) { console.error('removeFromQueue:', e); return priorityRef.current; }
    }, []);

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
        await withTimeout(TrackPlayer.add(queue), 6000);
        if (startIndex > 0) await TrackPlayer.skip(startIndex);
        await setQueueLoop();
        forceReleaseFade();
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

    const playPlaylistOrdered = useCallback(async (playlist, orderedSongs) => {
        if (isTransitionLocked()) return;
        const eq = await getEQPreset(playlist.path);
        const queue = [...orderedSongs];
        await TrackPlayer.reset();
        await withTimeout(TrackPlayer.add(queue), 6000);
        await setQueueLoop();
        forceReleaseFade();
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

    const playPlaylistShuffled = useCallback(async (playlist) => {
        if (isTransitionLocked()) return;
        const mode = await getShuffleMode();
        const eq = await getEQPreset(playlist.path);
        const useMode = mode === 'off' ? (lastActiveModeRef.current === 'off' ? 'full_cycle' : lastActiveModeRef.current) : mode;
        const queue = buildQueue(playlist.songs, useMode);
        await TrackPlayer.reset();
        await withTimeout(TrackPlayer.add(queue), 6000);
        await setQueueLoop();
        forceReleaseFade();
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

        const isSamePlaylist = currentPlaylist?.path === playlist.path;
        const keepIds = isSamePlaylist ? priorityRef.current : [];
        const keepSet = new Set(keepIds);
        const prioritySongs = keepIds
            .map(id => playlist.songs.find(s => s.id === id))
            .filter(Boolean);

        let rest;
        if (isOn) {
            rest = shuffleArray(playlist.songs.filter(s => s.id !== songId && !keepSet.has(s.id)));
        } else {
            // Continue through the list in order starting right AFTER the
            // tapped song, wrapping back around — not just "everything else
            // in whatever order it happened to be in," which read as
            // "always restarts from the top of the playlist."
            const idx = playlist.songs.findIndex(s => s.id === songId);
            const wrapped = idx === -1 ? playlist.songs : [...playlist.songs.slice(idx + 1), ...playlist.songs.slice(0, idx)];
            rest = wrapped.filter(s => !keepSet.has(s.id));
        }

        const queue = [song, ...prioritySongs, ...rest];

        await TrackPlayer.reset();
        await withTimeout(TrackPlayer.add(queue), 6000);
        await setQueueLoop();
        forceReleaseFade();
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

    // Restores playback after a cold app launch. Uses the actual last-playing
    // queue (last.playlist.queue) rather than the playlist's original scan
    // order (last.playlist.songs) — using .songs was the cause of "up next
    // saves, but not the queue I actually had." This also now runs through
    // PlaybackContext properly (called from a component inside the provider),
    // so currentPlaylist/shuffleMode end up correctly populated after a
    // restore instead of the app restoring TrackPlayer directly and leaving
    // this context none the wiser.
    const restoreSession = useCallback(async (last) => {
        try {
            const queue = last?.playlist?.queue;
            if (!queue?.length || last.index === undefined) return;
            const mode = await getShuffleMode();
            await TrackPlayer.reset();
            await withTimeout(TrackPlayer.add(queue), 6000);
            if (last.index > 0) await withTimeout(TrackPlayer.skip(last.index), 4000);
            if (last.position > 2) {
                // Seeking immediately after skip was silently getting ignored —
                // the native player hadn't finished preparing the track yet.
                await new Promise(r => setTimeout(r, 300));
                try { await TrackPlayer.seekTo(last.position); } catch { }
                await new Promise(r => setTimeout(r, 150));
                try { await TrackPlayer.seekTo(last.position); } catch { } // retry once, cheap insurance
            }
            await setQueueLoop();

            setCurrentPlaylist({ ...last.playlist, queue });
            setCurrentTrack(queue[last.index] ?? null);
            setShuffleModeState(mode);
            setShuffleOn(mode !== 'off');
            setPriorityQueue([]);
            priorityRef.current = [];
        } catch (e) { console.error('restoreSession:', e); }
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const last = await getLastSession();
                await restoreSession(last);
            } catch { }
        })();
    }, [restoreSession]);

    // Rebuilds everything AFTER the current track + priority queue using the
    // new mode, leaving what's already playing/priority-queued untouched.
    // Without this, changing shuffle mode only ever affected the NEXT
    // playlist you loaded — the queue you were already listening to just
    // kept its original order, which read as "shuffle doesn't do anything."
    const reshuffleUpcoming = useCallback(async (mode) => {
        const pl = playlistRef.current;
        if (!pl?.songs?.length) return;
        try {
            const currentIndex = await TrackPlayer.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return;
            const queue = await TrackPlayer.getQueue();
            const keepEnd = currentIndex + 1 + priorityRef.current.length;
            const usedIds = new Set(queue.slice(0, keepEnd).map(t => t.id));
            let rest = pl.songs.filter(s => !usedIds.has(s.id));
            rest = mode === 'off' ? rest : buildQueue(rest, mode);
            for (let i = queue.length - 1; i >= keepEnd; i--) {
                await TrackPlayer.remove(i);
            }
            if (rest.length) await withTimeout(TrackPlayer.add(rest), 6000);
            const newQueue = [...queue.slice(0, keepEnd), ...rest];
            setCurrentPlaylist({ ...pl, queue: newQueue });
        } catch (e) { console.error('reshuffleUpcoming:', e); }
    }, []);

    const toggleShuffle = useCallback(async () => {
        const newOn = !shuffleOn;
        setShuffleOn(newOn);
        const mode = newOn ? (lastActiveModeRef.current === 'off' ? 'full_cycle' : lastActiveModeRef.current) : 'off';
        setShuffleModeState(mode);
        await setShuffleMode(mode);
        await reshuffleUpcoming(mode);
    }, [shuffleOn, reshuffleUpcoming]);

    const changeShuffleMode = useCallback(async (mode) => {
        setShuffleModeState(mode);
        setShuffleOn(mode !== 'off');
        await setShuffleMode(mode);
        await reshuffleUpcoming(mode);
    }, [reshuffleUpcoming]);

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

    useEffect(() => { saveSessionRef.current = saveSession; });

    return (
        <Ctx.Provider value={{
            currentPlaylist, currentTrack, shuffleOn, shuffleMode, eqPresetId, singleLoop, priorityQueue,
            loadPlaylist, playSongFromPlaylist, playPlaylistOrdered, playPlaylistShuffled, restoreSession,
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
