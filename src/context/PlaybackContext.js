import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { AppState, Image } from 'react-native';
import AudioEngine, { Event, State } from '../native/AudioEngine';
import { getPresetById, clampEQBand } from '../utils/eq';
import { getCustomPresets, getEQOverrides } from '../utils/storage';
import { buildQueue, shuffleArray } from '../utils/shuffle';
import { playWithRamp, pauseWithRamp, isTransitionLocked, forceReleaseFade, preClaimFadeForFreshStart, fadeOutCurrentIfPlaying, queueAction } from '../services/PlaybackService';
import { withTimeout } from '../utils/withTimeout';
import {
    getShuffleMode, setShuffleMode, getShuffleOn as getShuffleOnStorage, setShuffleOn as setShuffleOnStorage,
    getEQPreset, setEQPreset,
    getSession, setSession, getLastSession, setLastSession, incrementPlayCount,
    getAudioRamp, getKeepPriorityOnPlaylistSwitch, getSkipRamp,
    getCrossfadeEnabled, getCrossfadeDurationSkip,
} from '../utils/storage';
import { extractEmbeddedArt, getCachedArt } from '../utils/embeddedArt';
import { getLyrics } from '../utils/lyrics';

const Ctx = createContext(null);

const setQueueLoop = async () => {
    try { const { RepeatMode } = require('react-native-track-player'); await AudioEngine.setRepeatMode(RepeatMode.Queue); } catch { }
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
// Exported so SettingsScreen can re-apply immediately after editing whatever
// preset is currently active, instead of the change only taking effect the
// next time a preset gets selected.
export async function applyEQPreset(id) {
    try {
        const [custom, overrides] = await Promise.all([getCustomPresets(), getEQOverrides()]);
        const preset = getPresetById(id, custom, overrides);
        // Clamped here — the one place EVERY band value actually reaches
        // the native EQ unit, regardless of where it came from (a built-in,
        // a custom preset, an override) — so a value saved back when the
        // range was ±12 can't hand the native side something outside what
        // it's now meant to support.
        await AudioEngine.setEQBands(preset.bands.map(clampEQBand));
    } catch { }
}
const stampQids = (tracks) => tracks.map(stampQid);

export function PlaybackProvider({ children }) {
    const [currentPlaylist, setCurrentPlaylist] = useState(null);
    const [currentTrack, setCurrentTrack] = useState(null);
    const [shuffleOn, setShuffleOn] = useState(false);
    const [shuffleMode, setShuffleModeState] = useState('full_cycle');
    const [eqPresetId, setEqPresetId] = useState('flat');

    // Lyrics were only ever fetched lazily by PlayerScreen itself, on
    // mount/track-change — meaning the very first time any given song's
    // lyrics were needed, there was nothing in cache yet and a real
    // fetch had to happen after first paint no matter what, showing the
    // cover for however long that took ("flash the cover first," still
    // reproducible for any song that hadn't already been looked up this
    // session). PlayerScreen's own cache-first logic already handles a
    // WARM cache correctly; this is what warms it. Firing this here,
    // centrally, means the cache is very likely already warm by the time
    // a track actually becomes current in normal use (skip, auto-advance,
    // Player already open) — leaving only the literal first song of a
    // cold app launch as a residual, genuinely-unavoidable case.
    useEffect(() => {
        if (!currentTrack?.id) return;
        getLyrics(currentTrack).catch(() => {});
    }, [currentTrack?.id]);
    const [singleLoop, setSingleLoop] = useState(false);
    const [priorityQueue, setPriorityQueue] = useState([]); // array of song ids, in insertion order

    const playlistRef = useRef(null);
    useEffect(() => { playlistRef.current = currentPlaylist; }, [currentPlaylist]);
    // Mirrors shuffleOn/shuffleMode for topUpQueueIfNeeded — that function
    // gets called from callbacks frozen with an empty dependency array
    // (e.g. jumpToQueueIndex), so reading the state values directly there
    // would close over whatever they were on the FIRST render forever, not
    // whatever the user's actually got set now. Refs sidestep that the same
    // way playlistRef already does above.
    const shuffleOnRef = useRef(false);
    useEffect(() => { shuffleOnRef.current = shuffleOn; }, [shuffleOn]);
    const shuffleModeRef = useRef('full_cycle');
    useEffect(() => { shuffleModeRef.current = shuffleMode; }, [shuffleMode]);
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
                const queue = await AudioEngine.getQueue();
                const idx = queue.findIndex(t => t.id === currentTrack.id);
                if (idx !== -1) await AudioEngine.updateMetadataForTrack(idx, { artwork: uri });
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
            // Same reasoning as PlaylistDetailScreen's cover fix: warm RN's
            // image cache before handing the Player screen (and anywhere
            // else reading currentTrack.artwork) a URI it hasn't decoded
            // yet — that gap was the "background image... flashes with a
            // placeholder" moment landing right as a song's art resolves,
            // on top of the same flash already fixed for playlist covers.
            Image.prefetch(uri).catch(() => { }).finally(() => {
                if (cancelled) return;
                setCurrentTrack(prev => (prev?.id === currentTrack.id ? { ...prev, artwork: uri } : prev));
            });
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
        const sub = AudioEngine.addEventListener(Event.PlaybackProgressUpdated, ({ position, duration }) => {
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
        const sub = AudioEngine.addEventListener(Event.PlaybackTrackChanged, async ({ nextTrack }) => {
            if (nextTrack === null || nextTrack === undefined) return;
            try {
                let track = await AudioEngine.getTrack(nextTrack);
                if (!track) {
                    await new Promise(r => setTimeout(r, 80));
                    track = await AudioEngine.getTrack(nextTrack);
                }
                if (!track) return;
                // Was comparing by song `id` alone — with priority-queuing
                // now confirmed to genuinely duplicate a song (same id,
                // different queue slot — see addToQueue/promoteToQueue),
                // transitioning from one occurrence of a song to ANOTHER
                // occurrence of the exact same song matched this guard and
                // silently skipped the update, which read as "doesn't
                // switch the song" for that specific case. `_qid` (stamped
                // per-slot on every native add) tells two genuine
                // occurrences of the same song apart; only falls back to
                // `id` for tracks that predate _qid tagging.
                const sameSlot = track._qid != null
                    ? track._qid === currentTrackRef.current?._qid
                    : track.id === currentTrackRef.current?.id;
                if (sameSlot) return; // same track re-fired — a fresh object here would wipe out artwork that already resolved
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
                    // Real bug found here: currentPlaylist never got
                    // touched by this whole listener — reasonable for a
                    // normal natural-advance (topUpQueueIfNeeded only ever
                    // pulls from the actual loaded playlist, so those
                    // tracks genuinely belong to it), but a manually
                    // queued song (addToQueue/promoteToQueue, from
                    // anywhere — a different playlist, All Songs, a
                    // search) can easily NOT be a member of whatever
                    // playlist you'd last loaded. Once that queued song
                    // becomes current, the player's top-bar breadcrumb
                    // kept showing that old, unrelated playlist name —
                    // "playing from complete" for a song complete doesn't
                    // even contain — since nothing ever cleared it. Only
                    // clearing when the incoming track genuinely isn't in
                    // the loaded playlist's own song list, so this never
                    // fires for the common case (queuing a song that
                    // happens to already be in the current playlist).
                    const pl = playlistRef.current;
                    if (pl?.songs && !pl.songs.some(s => s.id === track.id)) {
                        setCurrentPlaylist(null);
                    }
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
    // AudioEngine.add() independently, so a fast second swipe could read the
    // queue before the first swipe's add had landed and compute the same
    // insert position, effectively stepping on it. Chaining forces each add
    // to fully complete (including writing back to priorityRef) before the
    // next one starts reading.
    const addQueueLockRef = useRef(Promise.resolve());
    const addToQueue = useCallback((song) => {
        const run = async () => {
            try {
                const currentIndex = await AudioEngine.getCurrentTrack();
                if (currentIndex === null || currentIndex === undefined) return priorityRef.current;
                // Reverted the round-17 dedupe: explicit direction from
                // testing was to keep the original occurrence in Up Next —
                // "add to Priority" means play a copy sooner, not move the
                // song. The actual bug behind "showed several times" wasn't
                // this at all — it was SwipeableRow firing onSwipeRight
                // more than once for a single physical swipe (RNGH can
                // report the ACTIVE state twice when this pan competes with
                // an enclosing FlatList's scroll recognizer, which a queue
                // list always is) — fixed there with a per-gesture latch
                // instead.
                let priority = priorityRef.current;
                const insertAt = currentIndex + 1 + priority.length;
                await AudioEngine.add(stampQid(song), insertAt);
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
            const currentIndex = await AudioEngine.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return { priority: priorityRef.current, insertedAt: null };
            if (realIndex === null || realIndex === undefined || realIndex <= currentIndex) return { priority: priorityRef.current, insertedAt: null };
            // Real bug found via screen recording: this had no check for
            // realIndex already sitting inside the priority zone itself.
            // QueueModal's swipe-right ("+Next") affordance was wired
            // identically for Priority rows and Up Next rows, so swiping an
            // already-priority row called this anyway — and since the logic
            // above only ever knows how to ADD another copy (see the
            // comment below on why that's correct for genuine Up Next ->
            // Priority promotion), it inserted a second, genuinely
            // redundant copy of a song that was already in Priority. Both
            // then existed as separate queue slots, and removing one but
            // not the other read as "deleting one song deleted two" once a
            // subsequent removal changed the priority-zone boundary out
            // from under the surviving copy. Promoting something already in
            // Priority isn't a meaningful action, so this now no-ops
            // instead of duplicating.
            const priorityEnd = currentIndex + 1 + priorityRef.current.length;
            if (realIndex < priorityEnd) return { priority: priorityRef.current, insertedAt: null };
            const queue = await AudioEngine.getQueue();
            const track = queue[realIndex];
            if (!track) return { priority: priorityRef.current, insertedAt: null };
            const insertAt = currentIndex + 1 + priorityRef.current.length;
            await AudioEngine.add(stampQid(track), insertAt);
            const next = [...priorityRef.current, track.id];
            priorityRef.current = next;
            setPriorityQueue(next);
            // Reverted the round-17 dedupe here too — explicit direction
            // was to keep the original occurrence in Up Next (promoting
            // plays a copy sooner, doesn't move the song). See addToQueue's
            // matching comment above for what the real "showed several
            // times" bug actually was.
            return { priority: next, insertedAt: insertAt };
        } catch (e) { console.error('promoteToQueue:', e); return { priority: priorityRef.current, insertedAt: null }; }
    }, []);

    const removeFromQueue = useCallback(async (realIndex) => {
        try {
            const currentIndex = await AudioEngine.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return priorityRef.current;
            await AudioEngine.remove(realIndex);
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
            const currentIndex = await AudioEngine.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return;
            if (realIndex === currentIndex) return; // already playing this exact slot
            const priorityCount = priorityRef.current.length;
            const priorityStart = currentIndex + 1;
            const priorityEnd = priorityStart + priorityCount;

            // Real bug found here: tapping a song in the queue ALWAYS went
            // through fadeOutCurrentIfPlaying (a plain JS ramp) followed by
            // a fresh ramp-in — even with Crossfade on and something
            // already playing, this was never actually a crossfade, just a
            // fade-out-then-fade-in with a gap between them. Native's
            // skip(index) now crossfades itself when appropriate (see its
            // comment) by reusing the same startCrossfade() the natural
            // next-track transition uses — so when that applies, skip the
            // JS-side fade-out and the playWithRamp wrapper entirely and
            // hand off straight to native, which owns the whole transition
            // (both the outgoing fade and the incoming one) on its own.
            const wasPlaying = (await AudioEngine.getState()) === State.Playing;
            const crossfadeReady = wasPlaying
                && (await getCrossfadeEnabled())
                && (await getCrossfadeDurationSkip()) > 0.05;

            if (realIndex < priorityEnd) {
                // Jumping to a row inside the priority zone itself (tapping
                // the 2nd+ priority song in the Queue sheet, not just the
                // first). The priority entries at priorityStart..realIndex
                // (everything from the front of the priority list up to and
                // including the one being jumped to) are about to end up
                // BEHIND the new current index once this skip lands — they
                // were "skipped past," not played, but either way they're no
                // longer upcoming. Left untouched, priorityRef kept them
                // forever, which threw off priorityCount (and therefore
                // priorityEnd) for every add/promote/remove/jump after this.
                // Trim them here; the ones still genuinely ahead
                // (realIndex+1..priorityEnd-1) are untouched and stay
                // priority, same as a normal "Up Next" jump leaves the rest
                // of the queue untouched.
                const skippedCount = realIndex - priorityStart + 1;
                const next = priorityRef.current.slice(skippedCount);
                priorityRef.current = next;
                setPriorityQueue(next);
                if (crossfadeReady) {
                    await AudioEngine.skip(realIndex);
                } else {
                    await fadeOutCurrentIfPlaying(await getAudioRamp());
                    forceReleaseFade();
                    const preClaimedId = preClaimFadeForFreshStart();
                    await playWithRamp(preClaimedId, () => AudioEngine.skip(realIndex));
                }
                return;
            }

            const queue = await AudioEngine.getQueue();
            const priorityTracks = queue.slice(priorityStart, priorityEnd);
            for (let i = priorityEnd - 1; i >= priorityStart; i--) {
                await AudioEngine.remove(i);
            }
            const newTargetIndex = realIndex - priorityCount;
            if (priorityTracks.length) {
                await AudioEngine.add(priorityTracks, newTargetIndex + 1);
            }
            if (crossfadeReady) {
                await AudioEngine.skip(newTargetIndex);
            } else {
                await fadeOutCurrentIfPlaying(await getAudioRamp());
                forceReleaseFade();
                const preClaimedId = preClaimFadeForFreshStart();
                await playWithRamp(preClaimedId, () => AudioEngine.skip(newTargetIndex));
            }
            // topUpQueueIfNeeded only adds QUEUE_TOPUP_BATCH (4) songs per
            // call — enough for the steady-state "a song just finished,
            // drip-feed a few more" case it was actually designed for, but
            // jumping straight to a row well into "Up Next" can leave the
            // window far short of a full QUEUE_WINDOW_SIZE (25) in one
            // step; nothing here ever topped it back up afterward at all.
            // Calling it repeatedly (bounded, not truly unbounded) restores
            // a full window regardless of how big the jump was — each call
            // re-reads the current state, so it naturally stops early once
            // genuinely caught up or the logical queue itself runs out.
            for (let i = 0; i < Math.ceil(QUEUE_WINDOW_SIZE / QUEUE_TOPUP_BATCH); i++) {
                await topUpQueueIfNeeded();
            }
        } catch (e) { console.error('jumpToQueueIndex:', e); }
    }, []);

    // Loading an entire large playlist into TrackPlayer's native queue in one
    // AudioEngine.add() call was both the "queue takes a while to load" and
    // (very likely) the "queue ends up empty at the end" bug: that add() is
    // wrapped in a 6s withTimeout, and for a big enough playlist the native
    // add can still be in flight past that window, silently leaving the
    // tail never actually added. Paginating avoids both — only ~50 tracks
    // are ever pushed to the native queue at once, topped up as playback
    // gets close to the end of what's loaded. The FULL order still lives in
    // currentPlaylist.queue / session storage (unpaginated) since that's
    // what shuffle "memory" and resuming a session depend on — only what's
    // actually sitting in TrackPlayer's native queue is windowed.
    const QUEUE_WINDOW_SIZE = 25;
    const QUEUE_INITIAL_BATCH = 10;
    const QUEUE_TOPUP_BATCH = 4;
    // Triggers a top-up once the loaded NORMAL (non-priority) upcoming count
    // drops to 23, adding 4 back to reach 27 — keeps it oscillating in the
    // 23-27 range around a ~25 steady state. Priority is intentionally
    // excluded from this count entirely (see topUpQueueIfNeeded below) —
    // queuing or clearing priority tracks shouldn't grow or shrink the
    // normal window at all.
    const QUEUE_TOPUP_THRESHOLD = 23;
    const logicalQueueRef = useRef([]);
    const loadedThroughRef = useRef(0);

    // Resets TrackPlayer to a fresh window of `fullQueue` starting at logical
    // index `anchorIndex` — native index 0 IS anchorIndex, so there's no
    // separate "skip to index" step needed after this, unlike before.
    //
    // Only actually loads QUEUE_INITIAL_BATCH (10) up front now, not the
    // full 25 — AudioEngine.add() is a real native bridge call whose cost
    // scales with how many tracks are in it, so a smaller first batch means
    // less time between tapping something and it actually being ready to
    // play. The rest of the window (up to 25) gets topped up right after,
    // in the background, via the exact same path (topUpQueueIfNeeded) that
    // already handles keeping it filled as songs play — this is just an
    // extra call to it immediately rather than waiting for the threshold.
    const primeNativeQueue = async (fullQueue, anchorIndex = 0) => {
        logicalQueueRef.current = fullQueue;
        const batch = stampQids(fullQueue.slice(anchorIndex, anchorIndex + QUEUE_INITIAL_BATCH));
        await AudioEngine.reset();
        await withTimeout(AudioEngine.add(batch), 6000);
        loadedThroughRef.current = anchorIndex + batch.length;
        // Deliberately NOT calling fillRestOfWindow() here — callers that
        // also need to re-insert priority tracks (restorePriorityTracks) do
        // that FIRST and call fillRestOfWindow() themselves right after.
        // Firing it from in here would race that insert — both are
        // AudioEngine.add() calls, one inserting at a specific index and
        // one appending, and interleaving them is asking for a scrambled
        // queue order.
    };

    // Real bug found here (there wasn't a fix for it before — this function
    // didn't exist): loadPlaylist/playPlaylistOrdered/playPlaylistShuffled/
    // playSongFromPlaylist all went through primeNativeQueue above, which
    // ALWAYS calls AudioEngine.reset() first — reset() hard-stops the
    // currently-playing audio node immediately (see its native comment).
    // That's why NONE of those four could ever crossfade even with
    // Crossfade on and a song already playing: reset() kills the exact
    // audio a crossfade needs to fade OUT of before a crossfade could ever
    // get a chance to start. "Clicking songs / hitting Play/Shuffle still
    // doesn't crossfade — it's not a crossfade at all" was accurate.
    //
    // Fix reuses the crossfade AudioEngine.skip(index) already does for a
    // manual skip (see its own comment) instead of duplicating that logic:
    // insert the new queue right after the currently-playing track instead
    // of wiping the queue first, skip() to it (which crossfades under the
    // same conditions a Skip does), THEN remove everything else that was
    // in the old queue. The outgoing track's own audio node is never
    // touched by any of this — it's the same node startCrossfade() already
    // knows how to fade out on its own.
    //
    // Returns whether it actually crossfaded, so the caller knows whether
    // it still needs to run the ramp-in (preClaimFadeForFreshStart +
    // playWithRamp) itself — a crossfade owns its own fade-in natively, a
    // plain reset+ramp fresh-start doesn't.
    const primeQueueForTransition = async (fullQueue, rampDuration, anchorIndex = 0) => {
        const wasPlaying = (await AudioEngine.getState()) === State.Playing;
        const crossfadeReady = wasPlaying
            && (await getCrossfadeEnabled())
            && (await getCrossfadeDurationSkip()) > 0.05;

        if (!crossfadeReady) {
            await fadeOutCurrentIfPlaying(rampDuration);
            forceReleaseFade();
            const preClaimedId = preClaimFadeForFreshStart();
            await primeNativeQueue(fullQueue, anchorIndex);
            return { preClaimedId, crossfaded: false };
        }

        const oldQueue = await AudioEngine.getQueue();
        const curIdx = await AudioEngine.getCurrentTrack();
        logicalQueueRef.current = fullQueue;
        const batch = stampQids(fullQueue.slice(anchorIndex, anchorIndex + QUEUE_INITIAL_BATCH));
        const insertAt = curIdx + 1;
        await withTimeout(AudioEngine.add(batch, insertAt), 6000);
        loadedThroughRef.current = anchorIndex + batch.length;
        await AudioEngine.skip(insertAt);
        // Everything at or before curIdx kept its original position (the
        // insert above only affects insertAt and later); everything after
        // curIdx got pushed up by batch.length by that same insert. Remove
        // it all — including curIdx itself, now that we've already
        // skip()'d away from it — leaving only the freshly-inserted batch,
        // which then becomes indices 0..batch.length-1 exactly like a
        // normal primeNativeQueue result.
        const toRemove = [];
        for (let i = 0; i < oldQueue.length; i++) toRemove.push(i <= curIdx ? i : i + batch.length);
        if (toRemove.length) await AudioEngine.remove(toRemove);
        return { preClaimedId: null, crossfaded: true };
    };

    const fillRestOfWindow = async () => {
        try {
            const rest = stampQids(logicalQueueRef.current.slice(loadedThroughRef.current, loadedThroughRef.current + (QUEUE_WINDOW_SIZE - QUEUE_INITIAL_BATCH)));
            if (rest.length) {
                await withTimeout(AudioEngine.add(rest), 6000);
                loadedThroughRef.current += rest.length;
            }
        } catch (e) { console.error('fillRestOfWindow:', e); }
    };

    // Wrap around the ENTIRE body of loadPlaylist/playPlaylistOrdered/
    // playPlaylistShuffled/playSongFromPlaylist. The currently-RUNNING
    // action always finishes (an in-flight AudioEngine.reset/add can't be
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
            try {
                await fn();
            } catch (e) {
                // This chain has no other catch anywhere in it — an
                // uncaught error here previously just became a silently
                // swallowed rejection (Play/Shuffle doing visibly nothing,
                // no error, no crash). Logging at minimum makes a bug like
                // that show up somewhere instead of just looking like
                // nothing happened.
                console.error('runExclusivePlayAction:', e);
            }
        };
        const chained = playActionLockRef.current.then(run, run);
        playActionLockRef.current = chained;
        return chained;
    };

    const topUpQueueIfNeeded = async () => {
        try {
            if (loadedThroughRef.current >= logicalQueueRef.current.length) {
                // Reached the true end of the logical playlist, not just the
                // native window — previously this just returned here, so
                // playback would eventually run out and stop once you'd
                // actually played through everything, rather than looping
                // back to the start the way a "playlist" is generally
                // expected to. Extends the logical queue with a fresh pass
                // over the same playlist instead of stopping.
                //
                // Only actually loops for a real full-playlist playthrough:
                // this is the one place loadedThroughRef ever catches up to
                // logicalQueueRef's length, which only happens once every
                // song has actually been loaded through — a mid-playlist
                // skip/jump can't accidentally trigger it early.
                //
                // Reshuffles fresh for the new pass (current shuffle mode,
                // read live via the ref so a mode changed mid-playlist is
                // respected) rather than reusing the exact same shuffled
                // order the first pass used — the first pass's order stays
                // exactly what it was throughout, unaffected by this, since
                // logicalQueueRef only ever gets appended to here, never
                // rewritten from the start.
                const pl = playlistRef.current;
                if (!pl?.songs?.length) return;
                const nextPass = buildQueue(pl.songs, shuffleOnRef.current ? shuffleModeRef.current : 'off');
                logicalQueueRef.current = [...logicalQueueRef.current, ...nextPass];
            }
            const currentIndex = await AudioEngine.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return;
            const nativeLen = (await AudioEngine.getQueue()).length;
            // Priority tracks live in this same native queue, right after
            // the current track, so they'd otherwise count toward
            // "remaining" too — meaning queuing a few priority songs could
            // stave off a top-up that was actually needed, and clearing
            // them out could trigger one that wasn't. Subtracting them out
            // keeps this purely a normal-queue measurement, per "priority
            // is completely separate."
            const remaining = nativeLen - 1 - currentIndex - priorityRef.current.length;
            if (remaining < QUEUE_TOPUP_THRESHOLD) {
                const next = stampQids(logicalQueueRef.current.slice(loadedThroughRef.current, loadedThroughRef.current + QUEUE_TOPUP_BATCH));
                if (next.length) {
                    await AudioEngine.add(next);
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
            const currentIndex = await AudioEngine.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return [];
            const queue = await AudioEngine.getQueue();
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
            try { await AudioEngine.add(carried, 1); } catch { }
            const ids = carried.map(t => t.id);
            priorityRef.current = ids;
            setPriorityQueue(ids);
        } else {
            priorityRef.current = [];
            setPriorityQueue([]);
        }
    };

    const loadPlaylist = useCallback((playlist, forceIndex = null) => runExclusivePlayAction(async () => {
        // Previously just silently dropped the whole action if a transition
        // (most commonly someone else's natural end-of-track fade, which
        // isn't tied to runExclusivePlayAction's own lock at all) happened
        // to be in flight at this exact instant — nothing played, nothing
        // queued, no error, so tapping a playlist mid-transition looked
        // like it simply didn't work (or, from the Player screen, like it
        // was still showing the OLD playlist since nothing about the state
        // ever actually changed). Retrying once the lock clears, the same
        // way skipWithRamp already does, instead of dropping it.
        if (isTransitionLocked()) { queueAction(() => loadPlaylist(playlist, forceIndex)); return; }
        const session = await getSession(playlist.path);
        // This playlist's own remembered shuffle choice wins over the
        // global default, same as its remembered queue/index already do —
        // that's the whole point of per-playlist memory. Falls back to the
        // global default for a playlist that's never been played before
        // (no session yet, or an old session from before this existed).
        const mode = session?.shuffleMode ?? await getShuffleMode();
        const isOn = session?.shuffleOn ?? await getShuffleOnStorage();
        const eq = await getEQPreset(playlist.path);
        applyEQPreset(eq); // fire-and-forget — doesn't need to block the play action
        let queue = session?.queue ?? (isOn ? buildQueue(playlist.songs, mode) : [...playlist.songs]);
        let startIndex = forceIndex ?? session?.index ?? 0;
        if (startIndex >= queue.length) startIndex = 0;

        const keepPriority = await getKeepPriorityOnPlaylistSwitch();
        const carriedPriority = keepPriority ? await capturePriorityTracks() : [];

        const { preClaimedId, crossfaded } = await primeQueueForTransition(queue, await getAudioRamp(), startIndex);
        await restorePriorityTracks(carriedPriority);
        fillRestOfWindow();
        await setQueueLoop();
        if (!crossfaded) await playWithRamp(preClaimedId);

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
        await setSession(playlist.path, { queue, index: startIndex, shuffleOn: isOn, shuffleMode: mode });
    }), []);

    const playPlaylistOrdered = useCallback((playlist, orderedSongs) => runExclusivePlayAction(async () => {
        // See loadPlaylist above for why this retries instead of dropping.
        if (isTransitionLocked()) { queueAction(() => playPlaylistOrdered(playlist, orderedSongs)); return; }
        const eq = await getEQPreset(playlist.path);
        applyEQPreset(eq); // fire-and-forget — doesn't need to block the play action
        const queue = [...orderedSongs];
        const keepPriority = await getKeepPriorityOnPlaylistSwitch();
        const carriedPriority = keepPriority ? await capturePriorityTracks() : [];
        const { preClaimedId, crossfaded } = await primeQueueForTransition(queue, await getAudioRamp());
        await restorePriorityTracks(carriedPriority);
        fillRestOfWindow();
        await setQueueLoop();
        if (!crossfaded) await playWithRamp(preClaimedId);

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
        const existing = await getSession(playlist.path);
        await setSession(playlist.path, { ...existing, queue, index: 0 });
    }), []);

    const playPlaylistShuffled = useCallback((playlist) => runExclusivePlayAction(async () => {
        // See loadPlaylist above for why this retries instead of dropping.
        if (isTransitionLocked()) { queueAction(() => playPlaylistShuffled(playlist)); return; }
        const useMode = await getShuffleMode();
        const eq = await getEQPreset(playlist.path);
        applyEQPreset(eq); // fire-and-forget — doesn't need to block the play action
        const queue = buildQueue(playlist.songs, useMode);
        const keepPriority = await getKeepPriorityOnPlaylistSwitch();
        const carriedPriority = keepPriority ? await capturePriorityTracks() : [];
        const { preClaimedId, crossfaded } = await primeQueueForTransition(queue, await getAudioRamp());
        await restorePriorityTracks(carriedPriority);
        fillRestOfWindow();
        await setQueueLoop();
        if (!crossfaded) await playWithRamp(preClaimedId);

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
        await setSession(playlist.path, { queue, index: 0, shuffleOn: true, shuffleMode: useMode });
        await setShuffleMode(useMode);
        await setShuffleOnStorage(true);
    }), []);

    const playSongFromPlaylist = useCallback((playlist, songId) => runExclusivePlayAction(async () => {
        // See loadPlaylist above for why this retries instead of dropping —
        // this is the specific case from the report: tapping a song in a
        // different playlist while the current one's song is mid-fade
        // (natural end-of-track, or any other transition) used to just
        // silently do nothing.
        if (isTransitionLocked()) { queueAction(() => playSongFromPlaylist(playlist, songId)); return; }
        const songSession = await getSession(playlist.path);
        const mode = songSession?.shuffleMode ?? await getShuffleMode();
        const isOn = songSession?.shuffleOn ?? await getShuffleOnStorage();
        const eq = await getEQPreset(playlist.path);
        applyEQPreset(eq); // fire-and-forget — doesn't need to block the play action
        const song = playlist.songs.find(s => s.id === songId);
        if (!song) { console.warn('Song not found:', songId); return; }

        // Real bug found here: this used to return early — no-op — when
        // the tapped song was already the current song in the same
        // playlist. That silently ate exactly the case Eric flagged:
        // toggling shuffle (or anything else about how the rest of the
        // queue gets built) and then re-tapping the currently-playing song
        // to make it take effect — the guard treated "same song" as
        // "nothing to do" and the rest of the queue never actually
        // rebuilt. Tapping a song is a deliberate "start fresh from here"
        // action; it should always fade/rebuild, same song or not.

        // Previously only kept priority when tapping a song within the SAME
        // playlist already playing, and never actually checked "Keep
        // Priority Queue When Switching Playlists" at all — inconsistent
        // with loadPlaylist/playPlaylistOrdered/playPlaylistShuffled, which
        // all respect it, and it didn't work at all tapping from a
        // different playlist or All Songs regardless of what the setting
        // said. Tapping a song is really just "switch to this playlist,
        // starting here" — so it now goes through the exact same
        // capture/restore mechanism as those, for the same consistent
        // behavior everywhere.
        const keepPriority = await getKeepPriorityOnPlaylistSwitch();
        const carriedPriority = keepPriority ? await capturePriorityTracks() : [];
        const keepSet = new Set(carriedPriority.map(t => t.id));

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

        const queue = [song, ...rest];

        // Uses the Skip ramp duration here, not the general Audio
        // Ramp — tapping a song is conceptually closer to a skip (jump
        // straight to a specific song) than it is to a fresh "start
        // playback from nothing" moment.
        const { preClaimedId, crossfaded } = await primeQueueForTransition(queue, await getSkipRamp());
        await restorePriorityTracks(carriedPriority);
        fillRestOfWindow();
        await setQueueLoop();
        if (!crossfaded) await playWithRamp(preClaimedId);

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
        // priority tracking is now fully owned by restorePriorityTracks
        // above (it clears it when there's nothing carried over, same as
        // when the setting is off) — no separate reset needed here.
        await setSession(playlist.path, { queue, index: 0, shuffleOn: isOn, shuffleMode: mode });
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
            fillRestOfWindow();
            // Real bug found here (see AudioEngine.swift's new load()
            // method for the full story): nothing between here and the
            // seek block below ever actually set the native currentIndex,
            // so loadAndScheduleCurrentTrack's own guard silently no-op'd
            // every single time — a cold-launch restore never actually
            // loaded a file. primeNativeQueue's reset()+add() only
            // populates the native queue array; it was never the thing
            // that cues a specific index. Native index 0 IS last.index
            // (primeNativeQueue slices the full queue starting there), so
            // this loads it now, paused (autoPlay: false) — deliberately
            // unconditional (not just inside the `last.position > 2`
            // branch below), since even a track that's supposed to resume
            // near its own start still needs to actually be loaded at all.
            await AudioEngine.load(0, false);
            const restoredEqId = await getEQPreset(last.playlist?.path);
            // Real bug found here: this applied the restored preset's
            // bands to the audio engine but never told React about it —
            // eqPresetId's own useState defaults to 'flat' and nothing
            // here ever called setEqPresetId, so the EQ picker UI always
            // showed "Flat" as selected after a restore even when a
            // different preset's bands were actually the ones playing.
            // That mismatch is what "selected EQ preset doesn't save
            // between closing and reopening" was actually describing —
            // the underlying setting genuinely was being restored, just
            // not reflected anywhere the user could see it.
            setEqPresetId(restoredEqId);
            applyEQPreset(restoredEqId);
            if (last.position > 2) {
                // Seeking immediately after skip was silently getting ignored —
                // the native player hadn't finished preparing the track yet. A
                // fixed 300ms+150ms retry budget was tuned for that case (mid-
                // session, warm app) — cold app LAUNCH is the one moment
                // everything else (JS bundle parsing, audio session setup,
                // this exact restore) is ALSO competing for CPU/IO, and on a
                // sandboxed SideStore install specifically (see Settings'
                // Music Location section), file access is slower to begin
                // with. Poll for the track actually being ready instead of
                // guessing a fixed delay is enough — a populated duration is
                // a reasonable proxy, since native only reports a real one
                // once the file's genuinely loaded (see AudioEngine.swift's
                // currentDurationSeconds) — up to a longer ceiling, then seek
                // with the same retry as before as cheap extra insurance.
                const deadline = Date.now() + 4000;
                while (Date.now() < deadline) {
                    const p = await AudioEngine.getProgress().catch(() => null);
                    if (p && p.duration > 0) break;
                    await new Promise(r => setTimeout(r, 100));
                }
                try { await AudioEngine.seekTo(last.position); } catch { }
                await new Promise(r => setTimeout(r, 150));
                try { await AudioEngine.seekTo(last.position); } catch { } // retry once, cheap insurance
            }
            await setQueueLoop();

            setCurrentPlaylist({ ...last.playlist, queue });
            setCurrentTrack(queue[last.index] ?? null);
            setShuffleModeState(mode);
            setShuffleOn(on);
            const priorityCount = last.priorityCount ?? 0;
            const restoredPriority = priorityCount > 0
                ? queue.slice(last.index + 1, last.index + 1 + priorityCount).map(t => t.id)
                : [];
            setPriorityQueue(restoredPriority);
            priorityRef.current = restoredPriority;
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
            const currentIndex = await AudioEngine.getCurrentTrack();
            if (currentIndex === null || currentIndex === undefined) return;
            const queue = await AudioEngine.getQueue();
            const keepEnd = currentIndex + 1 + priorityRef.current.length;
            const priorityTracks = queue.slice(currentIndex + 1, keepEnd);
            const usedIds = new Set(queue.slice(0, keepEnd).map(t => t.id));
            let rest = pl.songs.filter(s => !usedIds.has(s.id));
            if (mode === 'off') {
                // Turning shuffle off used to just filter pl.songs down to
                // whatever's left, which — since filter() preserves original
                // order — meant "continue on in order" actually meant
                // "restart from the top of the playlist" any time the
                // current song wasn't already near the front. Same fix as
                // playSongFromPlaylist's off-mode branch: find where the
                // CURRENT track sits in the playlist's natural order and
                // wrap the upcoming list to start right after it.
                const curTrack = queue[currentIndex];
                const curIdx = curTrack ? pl.songs.findIndex(s => s.id === curTrack.id) : -1;
                if (curIdx !== -1) {
                    const wrapped = [...pl.songs.slice(curIdx + 1), ...pl.songs.slice(0, curIdx)];
                    rest = wrapped.filter(s => !usedIds.has(s.id));
                }
            } else {
                rest = buildQueue(rest, mode);
            }

            // One bulk removal instead of removing up to ~50 loaded tracks
            // one at a time (each its own native bridge round trip) — that
            // loop was very likely the real cause of the shuffle toggle
            // feeling like it takes about a second, since the button's own
            // color animation is fast but toggleShuffle awaits this whole
            // function before it's done. Priority-queued tracks get removed
            // by the bulk call too, so they're re-added right after.
            await withTimeout(AudioEngine.removeUpcomingTracks(), 4000);
            if (priorityTracks.length) await withTimeout(AudioEngine.add(priorityTracks), 4000);

            const batch = stampQids(rest.slice(0, QUEUE_WINDOW_SIZE));
            if (batch.length) await withTimeout(AudioEngine.add(batch), 6000);
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
        // Also remembered per-playlist (merged into that playlist's
        // existing session data alongside its queue/index) so switching
        // back to this playlist later restores its own last shuffle
        // choice, not just whatever's globally current.
        if (playlistRef.current?.path) {
            const existing = await getSession(playlistRef.current.path);
            await setSession(playlistRef.current.path, { ...existing, shuffleOn: newOn });
        }
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
        if (playlistRef.current?.path) {
            const existing = await getSession(playlistRef.current.path);
            await setSession(playlistRef.current.path, { ...existing, shuffleMode: mode });
        }
        if (shuffleOn) await reshuffleUpcoming(mode);
    }, [shuffleOn, reshuffleUpcoming]);

    const toggleSingleLoop = useCallback(async () => {
        const next = !singleLoop;
        setSingleLoop(next);
        try {
            const { RepeatMode } = require('react-native-track-player');
            await AudioEngine.setRepeatMode(next ? RepeatMode.Track : RepeatMode.Queue);
        } catch { }
    }, [singleLoop]);

    const changeEQPreset = useCallback(async (id, path) => {
        setEqPresetId(id);
        await setEQPreset(id, path);
        await applyEQPreset(id);
    }, []);

    const saveSession = useCallback(async () => {
        const pl = playlistRef.current;
        if (!pl?.path) return;
        try {
            // Was 3 sequential awaits (getCurrentTrack, then getQueue, then
            // getProgress) before ever writing anything — on a genuine
            // force-quit, the OS gives very little time between the app
            // going to background and the process actually dying, and
            // background/foreground AppState transitions plus a real
            // fade-out (native's willTerminate handler) are already
            // competing for that same brief window. Every extra bridge
            // round-trip in sequence here is time this save might not get.
            // Running them concurrently cuts that to roughly a third.
            const [index, queue, progress] = await Promise.all([
                AudioEngine.getCurrentTrack(),
                AudioEngine.getQueue(),
                AudioEngine.getProgress().catch(() => null),
            ]);
            if (index !== null) {
                const pos = progress?.position ?? 0;
                await setSession(pl.path, { queue, index });
                // priorityCount is enough to reconstruct which of the
                // tracks right after `index` were priority-queued on
                // restore — the queue array already preserves their actual
                // order/position, we just need to know how many of the
                // leading upcoming slots they occupy. Previously nothing
                // about priority was saved at all, so restoreSession always
                // reset it to empty — the priority tracks were still right
                // there in the restored queue, just no longer TRACKED as
                // priority, which is what "priority gets mushed together
                // with up next after closing and reopening" was describing.
                await setLastSession({ playlist: { ...pl, queue }, index, position: pos, priorityCount: priorityRef.current.length });
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
        // Was 15000ms — tightened per Eric's report that position still
        // isn't being remembered through a genuine force-quit. The
        // background/inactive-triggered save above SHOULD already cover a
        // clean quit (that event fires before the process actually dies),
        // but a force-quit's timing isn't fully in this app's control —
        // this periodic checkpoint is the backstop for whatever gap
        // remains, and a tighter interval just means whatever position
        // it last captured is closer to the truth if that specific save
        // never got to run to completion.
        const interval = setInterval(() => saveSessionRef.current?.(), 5000);
        return () => clearInterval(interval);
    }, []);

    // Real bug found here (same class as ThemeContext/LibraryContext — see
    // their comments): this was a fresh object literal every render of
    // PlaybackProvider, so every usePlayback() consumer app-wide re-
    // rendered whenever ANY of this provider's own state changed, even
    // state a given consumer doesn't use at all. Every function below was
    // already useCallback-wrapped (stable), so wrapping the object itself
    // in useMemo is enough to actually get the benefit — consumers now
    // only re-render when a value they actually read changes.
    const value = useMemo(() => ({
        currentPlaylist, currentTrack, shuffleOn, shuffleMode, eqPresetId, singleLoop, priorityQueue,
        loadPlaylist, playSongFromPlaylist, playPlaylistOrdered, playPlaylistShuffled, restoreSession,
        toggleShuffle, changeShuffleMode, toggleSingleLoop, changeEQPreset, saveSession,
        addToQueue, removeFromQueue, promoteToQueue, jumpToQueueIndex,
        sleepTimerEndAt, sleepAtTrackEnd, setSleepTimer, setSleepTimerAtTrackEnd, cancelSleepTimer,
    }), [
        currentPlaylist, currentTrack, shuffleOn, shuffleMode, eqPresetId, singleLoop, priorityQueue,
        loadPlaylist, playSongFromPlaylist, playPlaylistOrdered, playPlaylistShuffled, restoreSession,
        toggleShuffle, changeShuffleMode, toggleSingleLoop, changeEQPreset, saveSession,
        addToQueue, removeFromQueue, promoteToQueue, jumpToQueueIndex,
        sleepTimerEndAt, sleepAtTrackEnd, setSleepTimer, setSleepTimerAtTrackEnd, cancelSleepTimer,
    ]);

    return (
        <Ctx.Provider value={value}>
            {children}
        </Ctx.Provider>
    );
}

export const usePlayback = () => {
    const ctx = useContext(Ctx);
    if (!ctx) throw new Error('usePlayback outside PlaybackProvider');
    return ctx;
};
