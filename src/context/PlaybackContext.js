import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { AppState } from 'react-native';
import TrackPlayer, { Event } from 'react-native-track-player';
import { buildQueue, shuffleArray } from '../utils/shuffle';
import { playWithRamp, isTransitionLocked, forceReleaseFade, preClaimFadeForFreshStart } from '../services/PlaybackService';
import { withTimeout } from '../utils/withTimeout';
import {
    getShuffleMode, setShuffleMode, getShuffleOn as getShuffleOnStorage, setShuffleOn as setShuffleOnStorage,
    getEQPreset, setEQPreset,
    getSession, setSession, getLastSession, setLastSession, incrementPlayCount,
} from '../utils/storage';
import { extractEmbeddedArt } from '../utils/embeddedArt';

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

    const currentTrackRef = useRef(null);
    useEffect(() => { currentTrackRef.current = currentTrack; }, [currentTrack]);

    // Extracts embedded FLAC/ALAC cover art for whatever's currently playing
    // and merges it into currentTrack once ready. Centralized here (rather
    // than duplicated at each of the several places that call
    // setCurrentTrack) so every screen reading currentTrack.artwork picks it
    // up automatically. Non-blocking — playback already started by the time
    // this resolves, this only fills in art a moment later if found.
    useEffect(() => {
        if (!currentTrack?.id || currentTrack.artwork) return;
        let cancelled = false;
        // Delayed rather than immediate — this used to fire the instant a
        // track changed, which is also exactly when the audio ramp's
        // setTimeout-driven fade steps need to run on time. The extraction
        // read + decode is heavy enough to have been stalling those timers
        // (measured via an actual waveform: two ~300-400ms "stuck" plateaus
        // in the fade-in instead of a smooth climb). Album art appearing a
        // moment later is unnoticeable; audio stutter isn't. Default ramp is
        // 3s, so this waits past that.
        const t = setTimeout(() => {
            if (cancelled) return;
            extractEmbeddedArt(currentTrack).then(async uri => {
                if (cancelled || !uri) return;
                setCurrentTrack(prev => (prev?.id === currentTrack.id ? { ...prev, artwork: uri } : prev));
                // Also push into TrackPlayer's own native queue item — the
                // system now-playing UI (lock screen, Control Center) reads
                // artwork from there, not from this app's React state, so it
                // never picked up extracted art before this.
                try {
                    const queue = await TrackPlayer.getQueue();
                    const idx = queue.findIndex(t => t.id === currentTrack.id);
                    if (idx !== -1) await TrackPlayer.updateMetadataForTrack(idx, { artwork: uri });
                    // Warm the cache for what's coming up next — fire and
                    // forget, no state to update since these aren't playing
                    // yet. By the time playback naturally reaches them,
                    // extraction is often already done.
                    const upcoming = queue.slice(idx + 1, idx + 3);
                    for (const t of upcoming) extractEmbeddedArt(t).catch(() => { });
                } catch { }
            });
        }, 4000);
        return () => { cancelled = true; clearTimeout(t); };
    }, [currentTrack?.id]);

    // "Only count a play after playing half of the song continuously without
    // skipping" — credited the moment real playback position crosses 50% of
    // duration, not on track start. Skipping away before that point means it
    // never crosses the threshold, so it's simply never credited; skipping
    // away AFTER crossing it still counts, same as most players' semantics.
    // Driven by real progress updates (not wall-clock time) so pausing
    // doesn't disqualify a track and seeking backward can't un-qualify one
    // that already crossed the mark. `credited` guards against double-firing
    // if position hovers right at the boundary or the user seeks back and
    // forth across it.
    const playCreditedRef = useRef({ trackId: null, credited: false });
    useEffect(() => {
        const sub = TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, ({ position, duration }) => {
            const track = currentTrackRef.current;
            if (!track?.id || !duration) return;
            if (playCreditedRef.current.trackId !== track.id) {
                playCreditedRef.current = { trackId: track.id, credited: false };
            }
            if (!playCreditedRef.current.credited && position / duration >= 0.5) {
                playCreditedRef.current.credited = true;
                incrementPlayCount(track);
            }
        });
        return () => sub.remove();
    }, []);

    useEffect(() => {
        (async () => {
            const [mode, on] = await Promise.all([getShuffleMode(), getShuffleOnStorage()]);
            setShuffleModeState(mode);
            setShuffleOn(on);
        })();
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
                topUpQueueIfNeeded();
            } catch { }
        });
        return () => sub.remove();
    }, []);

    // Insert a song right after the current track, after any songs already
    // priority-queued. If this exact song already exists later in the queue,
    // that occurrence is removed first so "play next" doesn't create a
    // duplicate entry. Returns the updated priority list so callers (like
    // QueueModal) can refresh immediately without racing this state update.
    //
    // Chained through addQueueLockRef so overlapping calls (swiping several
    // songs onto the queue in quick succession) can't race each other —
    // each add previously read currentIndex/priority and issued its native
    // TrackPlayer.add() independently, so a fast second swipe could read the
    // queue before the first swipe's add had landed and compute the same
    // insert position, effectively stepping on it. Chaining forces each add
    // to fully complete (including writing back to priorityRef) before the
    // next one starts reading.
    const addQueueLockRef = useRef(Promise.resolve());
    const addToQueue = useCallback((song) => {
        const run = async () => {
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
        };
        const next = addQueueLockRef.current.then(run, run);
        addQueueLockRef.current = next;
        return next;
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

    // Loading an entire large playlist into TrackPlayer's native queue in one
    // TrackPlayer.add() call was both the "queue takes a while to load" and
    // (very likely) the "queue ends up empty at the end" bug: that add() is
    // wrapped in a 6s withTimeout, and for a big enough playlist the native
    // add can still be in flight past that window, silently leaving the
    // tail never actually added. Paginating avoids both — only ~50 tracks
    // are ever pushed to the native queue at once, topped up as playback
    // gets close to the end of what's loaded. The FULL order still lives in
    // currentPlaylist.queue / session storage (unpaginated) since that's
    // what shuffle "memory" and resuming a session depend on — only what's
    // actually sitting in TrackPlayer's native queue is windowed.
    const QUEUE_BATCH_SIZE = 50;
    const QUEUE_TOPUP_THRESHOLD = 15;
    const logicalQueueRef = useRef([]);
    const loadedThroughRef = useRef(0);

    // Resets TrackPlayer to a fresh window of `fullQueue` starting at logical
    // index `anchorIndex` — native index 0 IS anchorIndex, so there's no
    // separate "skip to index" step needed after this, unlike before.
    const primeNativeQueue = async (fullQueue, anchorIndex = 0) => {
        logicalQueueRef.current = fullQueue;
        const batch = fullQueue.slice(anchorIndex, anchorIndex + QUEUE_BATCH_SIZE);
        await TrackPlayer.reset();
        await withTimeout(TrackPlayer.add(batch), 6000);
        loadedThroughRef.current = anchorIndex + batch.length;
    };

    const topUpQueueIfNeeded = async () => {
        try {
            if (loadedThroughRef.current >= logicalQueueRef.current.length) return; // already fully loaded
            const currentIndex = await TrackPlayer.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return;
            const nativeLen = (await TrackPlayer.getQueue()).length;
            const remaining = nativeLen - 1 - currentIndex;
            if (remaining < QUEUE_TOPUP_THRESHOLD) {
                const next = logicalQueueRef.current.slice(loadedThroughRef.current, loadedThroughRef.current + QUEUE_BATCH_SIZE);
                if (next.length) {
                    await TrackPlayer.add(next);
                    loadedThroughRef.current += next.length;
                }
            }
        } catch (e) { console.error('topUpQueue:', e); }
    };

    const loadPlaylist = useCallback(async (playlist, forceIndex = null) => {
        if (isTransitionLocked()) return;
        const mode = await getShuffleMode();
        const isOn = await getShuffleOnStorage();
        const eq = await getEQPreset(playlist.path);
        const session = await getSession(playlist.path);
        let queue = session?.queue ?? (isOn ? buildQueue(playlist.songs, mode) : [...playlist.songs]);
        let startIndex = forceIndex ?? session?.index ?? 0;
        if (startIndex >= queue.length) startIndex = 0;

        forceReleaseFade();
        const preClaimedId = preClaimFadeForFreshStart();
        await primeNativeQueue(queue, startIndex);
        await setQueueLoop();
        await playWithRamp(preClaimedId);

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
        forceReleaseFade();
        const preClaimedId = preClaimFadeForFreshStart();
        await primeNativeQueue(queue, 0);
        await setQueueLoop();
        await playWithRamp(preClaimedId);

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
        const useMode = await getShuffleMode();
        const eq = await getEQPreset(playlist.path);
        const queue = buildQueue(playlist.songs, useMode);
        forceReleaseFade();
        const preClaimedId = preClaimFadeForFreshStart();
        await primeNativeQueue(queue, 0);
        await setQueueLoop();
        await playWithRamp(preClaimedId);

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
        await setShuffleOnStorage(true);
    }, []);

    const playSongFromPlaylist = useCallback(async (playlist, songId) => {
        if (isTransitionLocked()) return;
        const mode = await getShuffleMode();
        const isOn = await getShuffleOnStorage();
        const eq = await getEQPreset(playlist.path);
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

        forceReleaseFade();
        const preClaimedId = preClaimFadeForFreshStart();
        await primeNativeQueue(queue, 0);
        await setQueueLoop();
        await playWithRamp(preClaimedId);

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
            const on = await getShuffleOnStorage();
            await primeNativeQueue(queue, last.index);
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
            setShuffleOn(on);
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
            const priorityTracks = queue.slice(currentIndex + 1, keepEnd);
            const usedIds = new Set(queue.slice(0, keepEnd).map(t => t.id));
            let rest = pl.songs.filter(s => !usedIds.has(s.id));
            rest = mode === 'off' ? rest : buildQueue(rest, mode);

            // One bulk removal instead of removing up to ~50 loaded tracks
            // one at a time (each its own native bridge round trip) — that
            // loop was very likely the real cause of the shuffle toggle
            // feeling like it takes about a second, since the button's own
            // color animation is fast but toggleShuffle awaits this whole
            // function before it's done. Priority-queued tracks get removed
            // by the bulk call too, so they're re-added right after.
            await withTimeout(TrackPlayer.removeUpcomingTracks(), 4000);
            if (priorityTracks.length) await withTimeout(TrackPlayer.add(priorityTracks), 4000);

            const batch = rest.slice(0, QUEUE_BATCH_SIZE);
            if (batch.length) await withTimeout(TrackPlayer.add(batch), 6000);
            const newQueue = [...queue.slice(0, keepEnd), ...rest];
            logicalQueueRef.current = newQueue;
            loadedThroughRef.current = keepEnd + batch.length;
            setCurrentPlaylist({ ...pl, queue: newQueue });
        } catch (e) { console.error('reshuffleUpcoming:', e); }
    }, []);

    // Only flips on/off. The algorithm (shuffleMode) is left exactly as it
    // was — it's persisted independently now, so there's no more "which mode
    // do we restore to" question when re-enabling.
    const toggleShuffle = useCallback(async () => {
        const newOn = !shuffleOn;
        setShuffleOn(newOn);
        await setShuffleOnStorage(newOn);
        await reshuffleUpcoming(newOn ? shuffleMode : 'off');
    }, [shuffleOn, shuffleMode, reshuffleUpcoming]);

    // Only changes the algorithm preference. Does NOT touch shuffleOn — this
    // used to force shuffle on any time a mode was picked in Settings, which
    // wasn't the ask ("allow the shuffle MODE to be changed without the
    // shuffle needing to be on. don't make it enable shuffle either"). If
    // shuffle happens to already be on, the upcoming queue is rebuilt with
    // the new mode; if it's off, this just remembers the preference for next
    // time shuffle gets turned on.
    const changeShuffleMode = useCallback(async (mode) => {
        setShuffleModeState(mode);
        await setShuffleMode(mode);
        if (shuffleOn) await reshuffleUpcoming(mode);
    }, [shuffleOn, reshuffleUpcoming]);

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

    // Position wasn't being saved between app opens/closes — saveSession was
    // only ever called on track-change events, so closing mid-song (not at a
    // track boundary, the common case) lost the real position and resumed
    // from wherever the current song had last started instead.
    useEffect(() => {
        const sub = AppState.addEventListener('change', (state) => {
            if (state === 'background' || state === 'inactive') saveSessionRef.current?.();
        });
        return () => sub.remove();
    }, []);
    useEffect(() => {
        const interval = setInterval(() => saveSessionRef.current?.(), 15000);
        return () => clearInterval(interval);
    }, []);

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
