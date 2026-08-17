import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { AppState } from 'react-native';
import TrackPlayer, { Event } from 'react-native-track-player';
import { buildQueue, shuffleArray } from '../utils/shuffle';
import { playWithRamp, pauseWithRamp, isTransitionLocked, forceReleaseFade, preClaimFadeForFreshStart, fadeOutCurrentIfPlaying } from '../services/PlaybackService';
import { withTimeout } from '../utils/withTimeout';
import {
    getShuffleMode, setShuffleMode, getShuffleOn as getShuffleOnStorage, setShuffleOn as setShuffleOnStorage,
    getEQPreset, setEQPreset,
    getSession, setSession, getLastSession, setLastSession, incrementPlayCount,
    getAudioRamp,
} from '../utils/storage';
import { extractEmbeddedArt, getCachedArt } from '../utils/embeddedArt';

const Ctx = createContext(null);

const setQueueLoop = async () => {
    try { const { RepeatMode } = require('react-native-track-player'); await TrackPlayer.setRepeatMode(RepeatMode.Queue); } catch { }
};

// Every track that ever gets added to the native queue gets a unique _qid
// stamped on at the moment it's added — not derived from song id or queue
// position, so it can never collide with (or be reassigned by) another
// track, including a genuine second copy of the same song sitting
// elsewhere in the queue. The queue view uses this as its row key instead
// of computing one from position/occurrence, which is what let promoting or
// removing one copy of a duplicated song visually affect a DIFFERENT copy —
// occurrence numbers shift when a duplicate gets added or removed earlier
// in the queue; this never does, because it isn't derived from anything
// that changes.
let qidCounter = 0;
const stampQid = (track) => ({ ...track, _qid: `q${++qidCounter}` });
const stampQids = (tracks) => tracks.map(stampQid);

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
        let timer = null;

        const pushMetadataAndPrefetch = async (uri) => {
            try {
                const queue = await TrackPlayer.getQueue();
                const idx = queue.findIndex(t => t.id === currentTrack.id);
                if (idx !== -1) await TrackPlayer.updateMetadataForTrack(idx, { artwork: uri });
                // Warm the cache for what's coming up next. Sequential with a
                // small stagger (not fired concurrently) — this used to be a
                // fire-and-forget loop that kicked off both reads at once,
                // which meant every track change could briefly hold 2-3 full
                // multi-MB file reads + base64 decodes in memory at the same
                // time (this track's own extraction, plus both upcoming
                // ones). Deduped against other callers via extractEmbeddedArt's
                // in-flight map, but that only helps when the SAME song is
                // requested twice — it doesn't help two DIFFERENT upcoming
                // songs racing each other, which is what this fixes.
                const upcoming = queue.slice(idx + 1, idx + 3);
                for (const t of upcoming) {
                    if (cancelled) return;
                    await extractEmbeddedArt(t).catch(() => { });
                    await new Promise(r => setTimeout(r, 200));
                }
            } catch { }
        };

        const applyArt = (uri) => {
            if (cancelled || !uri) return;
            setCurrentTrack(prev => (prev?.id === currentTrack.id ? { ...prev, artwork: uri } : prev));
            pushMetadataAndPrefetch(uri);
        };

        getCachedArt(currentTrack).then(cached => {
            if (cancelled) return;
            if (cached !== undefined) {
                // Already known (found or confirmed not found) — no reason
                // to wait, there's no heavy work happening here.
                if (cached) applyArt(cached);
                return;
            }
            // Genuinely new song — delay past the ramp's typical window
            // (default 3s) before doing the real extraction, since that
            // read + decode is heavy enough to have stalled the ramp's
            // timing-sensitive fade steps (measured via an actual waveform).
            timer = setTimeout(() => {
                if (cancelled) return;
                extractEmbeddedArt(currentTrack).then(applyArt);
            }, 4000);
        });

        return () => { cancelled = true; if (timer) clearTimeout(timer); };
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

    // Sleep timer — pauses playback (via the same smooth pauseWithRamp used
    // elsewhere) either after a set duration or once the current track ends.
    // sleepTimerEndAt is a real epoch timestamp (not "minutes remaining")
    // so the UI can compute a live countdown itself without this context
    // needing to tick every second.
    const [sleepTimerEndAt, setSleepTimerEndAt] = useState(null);
    const [sleepAtTrackEnd, setSleepAtTrackEnd] = useState(false);
    const sleepAtTrackEndRef = useRef(false);
    useEffect(() => { sleepAtTrackEndRef.current = sleepAtTrackEnd; }, [sleepAtTrackEnd]);
    const sleepTimerTimeoutRef = useRef(null);

    const cancelSleepTimer = useCallback(() => {
        clearTimeout(sleepTimerTimeoutRef.current);
        sleepTimerTimeoutRef.current = null;
        setSleepTimerEndAt(null);
        setSleepAtTrackEnd(false);
    }, []);

    const setSleepTimer = useCallback((minutes) => {
        clearTimeout(sleepTimerTimeoutRef.current);
        setSleepAtTrackEnd(false);
        const endAt = Date.now() + minutes * 60000;
        setSleepTimerEndAt(endAt);
        sleepTimerTimeoutRef.current = setTimeout(() => {
            pauseWithRamp();
            setSleepTimerEndAt(null);
        }, minutes * 60000);
    }, []);

    const setSleepTimerAtTrackEnd = useCallback(() => {
        clearTimeout(sleepTimerTimeoutRef.current);
        sleepTimerTimeoutRef.current = null;
        setSleepTimerEndAt(null);
        setSleepAtTrackEnd(true);
    }, []);

    useEffect(() => () => clearTimeout(sleepTimerTimeoutRef.current), []);


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
                if (track.id === currentTrackRef.current?.id) return; // same track re-fired — a fresh object here would wipe out artwork that already resolved
                setCurrentTrack(track);
                // Priority items are always inserted at the tail of the
                // contiguous priority block (currentIndex+1+length), so the
                // tracked array's order matches the priority zone's actual
                // queue order — the item becoming current should always be
                // priorityRef.current[0]. Checking that specific slot and
                // dropping just it (instead of filtering every entry whose id
                // matches) is what actually handles the same song being
                // promoted to priority more than once — a filter would have
                // dropped ALL of its tracked copies the moment just one of
                // them started playing, losing track of the other(s) even
                // though they're still genuinely queued.
                if (priorityRef.current[0] === track.id) {
                    const next = priorityRef.current.slice(1);
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
                if (sleepAtTrackEndRef.current) {
                    sleepAtTrackEndRef.current = false;
                    setSleepAtTrackEnd(false);
                    pauseWithRamp();
                }
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
                await TrackPlayer.add(stampQid(song), insertAt);
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
    //
    // Takes realIndex (the exact queue slot), not songId — it used to take
    // songId and resolve it with queue.findIndex(t => t.id === songId),
    // which always resolves to the FIRST matching slot. That's wrong the
    // moment a song appears more than once in the queue, which includes the
    // currently-playing song appearing again later as a genuine upcoming
    // repeat: findIndex matched the currently-playing slot itself (the
    // first occurrence), tripped the idx <= currentIndex guard, and silently
    // did nothing — while the swipe's own success animation played anyway,
    // and the very next refresh (reading a fresh, correct currentIndex)
    // stopped showing that row under "Up Next" at all, since it never
    // belonged there in the first place. Looked exactly like "the song got
    // removed instead of added." Taking realIndex directly removes the
    // ambiguity entirely — there's no lookup to get wrong.
    const promoteToQueue = useCallback(async (realIndex) => {
        try {
            const currentIndex = await TrackPlayer.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return { priority: priorityRef.current, insertedAt: null };
            if (realIndex === null || realIndex === undefined || realIndex <= currentIndex) return { priority: priorityRef.current, insertedAt: null };
            const queue = await TrackPlayer.getQueue();
            const track = queue[realIndex];
            if (!track) return { priority: priorityRef.current, insertedAt: null };
            // Keeps the original occurrence in place instead of moving it —
            // the song plays sooner via this new priority copy, but still
            // plays again later at its natural spot too.
            const insertAt = currentIndex + 1 + priorityRef.current.length;
            await TrackPlayer.add(stampQid(track), insertAt);
            const next = [...priorityRef.current, track.id];
            priorityRef.current = next;
            setPriorityQueue(next);
            return { priority: next, insertedAt: insertAt };
        } catch (e) { console.error('promoteToQueue:', e); return { priority: priorityRef.current, insertedAt: null }; }
    }, []);

    const removeFromQueue = useCallback(async (realIndex) => {
        try {
            const currentIndex = await TrackPlayer.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return priorityRef.current;
            await TrackPlayer.remove(realIndex);
            const priorityCount = priorityRef.current.length;
            const priorityEnd = currentIndex + 1 + priorityCount;
            let next = priorityRef.current;
            if (realIndex < priorityEnd) {
                // Removed slot was within the priority window — drop the
                // exact tracked entry at that position, not just whichever
                // happens to be last. The priority array is laid out in the
                // same order as the priority zone itself (index 0 =
                // currentIndex+1, index 1 = currentIndex+2, ...), so a
                // slot's offset within that zone is also its index in the
                // tracked array. Always dropping the last entry was wrong
                // the moment there was more than one priority item and you
                // removed anything other than the last of them — it kept
                // the removed song's id tracked and untracked a completely
                // different, still-queued song instead. That's very likely
                // what was behind priority items getting miscounted as
                // "Up Next" after enough removals — the tracked array's
                // LENGTH stayed numerically right (so the boundary math
                // mostly still worked), but its CONTENTS silently drifted
                // from what was actually in the priority zone.
                const priorityIdx = realIndex - (currentIndex + 1);
                next = [...next.slice(0, priorityIdx), ...next.slice(priorityIdx + 1)];
            }
            priorityRef.current = next;
            setPriorityQueue(next);
            // Removing a song shrinks the loaded window the same way a song
            // finishing does — top up here too instead of only checking on
            // natural track advance, so removing several in a row can't
            // drain the window down without anything topping it back up
            // until the next real track change happens to come along.
            topUpQueueIfNeeded();
            return next;
        } catch (e) { console.error('removeFromQueue:', e); return priorityRef.current; }
    }, []);

    const jumpToQueueIndex = useCallback(async (realIndex) => {
        if (isTransitionLocked()) return;
        try {
            const currentIndex = await TrackPlayer.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return;
            if (realIndex === currentIndex) return; // already playing this exact slot
            const priorityCount = priorityRef.current.length;
            const priorityStart = currentIndex + 1;
            const priorityEnd = priorityStart + priorityCount;

            await fadeOutCurrentIfPlaying(await getAudioRamp());
            forceReleaseFade();
            const preClaimedId = preClaimFadeForFreshStart();

            if (realIndex < priorityEnd) {
                await playWithRamp(preClaimedId, () => TrackPlayer.skip(realIndex));
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
            await playWithRamp(preClaimedId, () => TrackPlayer.skip(newTargetIndex));
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
    const QUEUE_WINDOW_SIZE = 50;
    const QUEUE_TOPUP_BATCH = 5;
    // Triggers a top-up as soon as what's left loaded drops to 45, adding
    // 5 more to bring it back to 50 — keeps the loaded window oscillating
    // in the 45-50 range rather than being allowed to drain a long way
    // down (old threshold was 15) before refilling all the way back to 50
    // in one large jump.
    const QUEUE_TOPUP_THRESHOLD = 45;
    const logicalQueueRef = useRef([]);
    const loadedThroughRef = useRef(0);

    // Resets TrackPlayer to a fresh window of `fullQueue` starting at logical
    // index `anchorIndex` — native index 0 IS anchorIndex, so there's no
    // separate "skip to index" step needed after this, unlike before.
    const primeNativeQueue = async (fullQueue, anchorIndex = 0) => {
        logicalQueueRef.current = fullQueue;
        const batch = stampQids(fullQueue.slice(anchorIndex, anchorIndex + QUEUE_WINDOW_SIZE));
        await TrackPlayer.reset();
        await withTimeout(TrackPlayer.add(batch), 6000);
        loadedThroughRef.current = anchorIndex + batch.length;
    };

    // Wrap around the ENTIRE body of loadPlaylist/playPlaylistOrdered/
    // playPlaylistShuffled/playSongFromPlaylist. The currently-RUNNING
    // action always finishes (an in-flight TrackPlayer.reset/add can't be
    // safely interrupted), but a NEW tap arriving while a previous one is
    // still just QUEUED (not yet started) replaces it entirely instead of
    // both running one after another. Without this, rapid taps queued up
    // strictly FIFO and every single one played out in full — tapping
    // through several songs felt like each tap got added to a playback
    // queue instead of the latest tap just taking over.
    const playActionLockRef = useRef(Promise.resolve());
    const latestPendingRef = useRef(null);
    const runExclusivePlayAction = (fn) => {
        const entry = {};
        latestPendingRef.current = entry;
        const run = async () => {
            if (latestPendingRef.current !== entry) return; // superseded before it got a turn
            latestPendingRef.current = null;
            await fn();
        };
        const chained = playActionLockRef.current.then(run, run);
        playActionLockRef.current = chained;
        return chained;
    };

    const topUpQueueIfNeeded = async () => {
        try {
            if (loadedThroughRef.current >= logicalQueueRef.current.length) return; // already fully loaded
            const currentIndex = await TrackPlayer.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return;
            const nativeLen = (await TrackPlayer.getQueue()).length;
            const remaining = nativeLen - 1 - currentIndex;
            if (remaining < QUEUE_TOPUP_THRESHOLD) {
                const next = stampQids(logicalQueueRef.current.slice(loadedThroughRef.current, loadedThroughRef.current + QUEUE_TOPUP_BATCH));
                if (next.length) {
                    await TrackPlayer.add(next);
                    loadedThroughRef.current += next.length;
                }
            }
        } catch (e) { console.error('topUpQueue:', e); }
    };

    // Captures whatever's currently in the priority zone before a playlist
    // switch wipes the native queue — used when "Keep Priority Queue When
    // Switching Playlists" is on. Existing objects (with their real _qid
    // already stamped on) are returned as-is so re-adding them after the
    // switch doesn't need to treat them as new inserts.
    const capturePriorityTracks = async () => {
        try {
            if (!priorityRef.current.length) return [];
            const currentIndex = await TrackPlayer.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return [];
            const queue = await TrackPlayer.getQueue();
            return queue.slice(currentIndex + 1, currentIndex + 1 + priorityRef.current.length);
        } catch { return []; }
    };

    // Re-adds carried-over priority tracks right after the new current
    // track (which is always native index 0 immediately after
    // primeNativeQueue) and restores tracking for them. Falls back to
    // actually clearing priority when there's nothing to carry over, or the
    // setting is off.
    const restorePriorityTracks = async (carried) => {
        if (carried.length) {
            try { await TrackPlayer.add(carried, 1); } catch { }
            const ids = carried.map(t => t.id);
            priorityRef.current = ids;
            setPriorityQueue(ids);
        } else {
            priorityRef.current = [];
            setPriorityQueue([]);
        }
    };

    const loadPlaylist = useCallback((playlist, forceIndex = null) => runExclusivePlayAction(async () => {
        if (isTransitionLocked()) return;
        const mode = await getShuffleMode();
        const isOn = await getShuffleOnStorage();
        const eq = await getEQPreset(playlist.path);
        const session = await getSession(playlist.path);
        let queue = session?.queue ?? (isOn ? buildQueue(playlist.songs, mode) : [...playlist.songs]);
        let startIndex = forceIndex ?? session?.index ?? 0;
        if (startIndex >= queue.length) startIndex = 0;

        const keepPriority = await getKeepPriorityOnPlaylistSwitch();
        const carriedPriority = keepPriority ? await capturePriorityTracks() : [];

        await fadeOutCurrentIfPlaying(await getAudioRamp());
        forceReleaseFade();
        const preClaimedId = preClaimFadeForFreshStart();
        await primeNativeQueue(queue, startIndex);
        await restorePriorityTracks(carriedPriority);
        await setQueueLoop();
        await playWithRamp(preClaimedId);

        const pl = { ...playlist, queue };
        setCurrentPlaylist(pl);
        // Same reasoning as playSongFromPlaylist — don't wipe already-known
        // art for a song that turns out to be the one still playing.
        setCurrentTrack(prev => {
            const next = queue[startIndex] ?? null;
            return (prev?.id === next?.id && prev?.artwork) ? { ...next, artwork: prev.artwork } : next;
        });
        setShuffleModeState(mode);
        setShuffleOn(isOn);
        setEqPresetId(eq);
        setSingleLoop(false);
        await setSession(playlist.path, { queue, index: startIndex });
    }), []);

    const playPlaylistOrdered = useCallback((playlist, orderedSongs) => runExclusivePlayAction(async () => {
        if (isTransitionLocked()) return;
        const eq = await getEQPreset(playlist.path);
        const queue = [...orderedSongs];
        const keepPriority = await getKeepPriorityOnPlaylistSwitch();
        const carriedPriority = keepPriority ? await capturePriorityTracks() : [];
        await fadeOutCurrentIfPlaying(await getAudioRamp());
        forceReleaseFade();
        const preClaimedId = preClaimFadeForFreshStart();
        await primeNativeQueue(queue, 0);
        await restorePriorityTracks(carriedPriority);
        await setQueueLoop();
        await playWithRamp(preClaimedId);

        const pl = { ...playlist, queue };
        setCurrentPlaylist(pl);
        setCurrentTrack(prev => {
            const next = queue[0] ?? null;
            return (prev?.id === next?.id && prev?.artwork) ? { ...next, artwork: prev.artwork } : next;
        });
        setShuffleModeState('off');
        setShuffleOn(false);
        setEqPresetId(eq);
        setSingleLoop(false);
        await setSession(playlist.path, { queue, index: 0 });
    }), []);

    const playPlaylistShuffled = useCallback((playlist) => runExclusivePlayAction(async () => {
        if (isTransitionLocked()) return;
        const useMode = await getShuffleMode();
        const eq = await getEQPreset(playlist.path);
        const queue = buildQueue(playlist.songs, useMode);
        const keepPriority = await getKeepPriorityOnPlaylistSwitch();
        const carriedPriority = keepPriority ? await capturePriorityTracks() : [];
        await fadeOutCurrentIfPlaying(await getAudioRamp());
        forceReleaseFade();
        const preClaimedId = preClaimFadeForFreshStart();
        await primeNativeQueue(queue, 0);
        await restorePriorityTracks(carriedPriority);
        await setQueueLoop();
        await playWithRamp(preClaimedId);

        const pl = { ...playlist, queue };
        setCurrentPlaylist(pl);
        setCurrentTrack(prev => {
            const next = queue[0] ?? null;
            return (prev?.id === next?.id && prev?.artwork) ? { ...next, artwork: prev.artwork } : next;
        });
        setShuffleModeState(useMode);
        setShuffleOn(true);
        setEqPresetId(eq);
        setSingleLoop(false);
        await setSession(playlist.path, { queue, index: 0 });
        await setShuffleMode(useMode);
        await setShuffleOnStorage(true);
    }), []);

    const playSongFromPlaylist = useCallback((playlist, songId) => runExclusivePlayAction(async () => {
        if (isTransitionLocked()) return;
        const mode = await getShuffleMode();
        const isOn = await getShuffleOnStorage();
        const eq = await getEQPreset(playlist.path);
        const song = playlist.songs.find(s => s.id === songId);
        if (!song) { console.warn('Song not found:', songId); return; }

        const isSamePlaylist = currentPlaylist?.path === playlist.path;
        if (isSamePlaylist && currentTrack?.id === songId) return; // already playing this exact song here
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

        await fadeOutCurrentIfPlaying(await getAudioRamp());
        forceReleaseFade();
        const preClaimedId = preClaimFadeForFreshStart();
        await primeNativeQueue(queue, 0);
        await setQueueLoop();
        await playWithRamp(preClaimedId);

        const pl = { ...playlist, queue };
        setCurrentPlaylist(pl);
        // If this is the same song that was already playing (just reached
        // through a different playlist that also contains it, or the same
        // playlist replayed), keep whatever art was already resolved for it
        // instead of handing the screen a bare track object with none. The
        // audio itself doesn't actually restart in that case (see
        // primeNativeQueue), so the art shouldn't visually reset either —
        // previously it did, and nothing re-fetched it afterward since nothing
        // about the track's id had changed to re-trigger that.
        setCurrentTrack(prev => (prev?.id === song.id && prev.artwork ? { ...song, artwork: prev.artwork } : song));
        setShuffleModeState(mode);
        setShuffleOn(isOn);
        setEqPresetId(eq);
        setSingleLoop(false);
        if (!isSamePlaylist) {
            setPriorityQueue([]);
            priorityRef.current = [];
        }
        await setSession(playlist.path, { queue, index: 0 });
    }), [currentPlaylist]);

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

            const batch = stampQids(rest.slice(0, QUEUE_WINDOW_SIZE));
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
            sleepTimerEndAt, sleepAtTrackEnd, setSleepTimer, setSleepTimerAtTrackEnd, cancelSleepTimer,
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
