import TrackPlayer, { Event, State } from 'react-native-track-player';
import { getCrossfade, getSkipCrossfade, getAudioRamp, getRampOnPause } from '../utils/storage';
import { withTimeout } from '../utils/withTimeout';

// --- Fade ownership -----------------------------------------------------
// Exactly one fade transition is allowed to be "in control" at a time.
// Whichever claims the lock first runs to completion; any other trigger
// during that window is BLOCKED entirely (not run as a competing un-faded
// fallback) — that fallback was itself a source of glitches, since it could
// still race the in-flight fade's remaining volume-setting steps.
let fadeCounter = 0;
let activeFadeId = null;
let naturalEndFadeOwner = null;
let skipLock = false;
let rampLock = false;

const claimFade = () => { activeFadeId = ++fadeCounter; return activeFadeId; };
const isFadeOwner = (id) => activeFadeId === id;
const releaseFade = (id) => { if (activeFadeId === id) activeFadeId = null; };

// Claims the fade lock BEFORE the caller populates a fresh native queue
// (TrackPlayer.reset()+add()). That add() can itself fire a native
// PlaybackTrackChanged event — and the listener below has a fallback that
// forces volume to 1 immediately if no fade is claimed yet. Previously
// nothing claimed the lock until playWithRamp() actually started running,
// AFTER the queue was already primed, so that fallback could win the race:
// volume jumps to full the instant the queue populates, then playWithRamp's
// own ramp cuts it back to 0 and re-ramps up a moment later. That's the "ramp
// started high, then started low to high" bug. Pre-claiming here closes the
// gap — activeFadeId is already non-null by the time the queue populates.
export function preClaimFadeForFreshStart() {
    return claimFade();
}

// Exposed so the UI layer (song taps, queue taps, playlist Play/Shuffle) can
// ignore input for the brief window a fade/ramp is in flight, instead of
// racing it.
export function isTransitionLocked() {
    return activeFadeId !== null || skipLock || rampLock;
}

// Used right before starting a totally fresh playback session (new playlist,
// new song tap, session restore) to guarantee no leftover/stuck fade lock
// from a previous interaction can interfere with this one's ramp-in.
export function forceReleaseFade() {
    activeFadeId = null;
    naturalEndFadeOwner = null;
}

// Instead of silently dropping a play/pause/skip that arrives while a ramp
// is mid-flight, the LATEST one is remembered (overwriting whatever was
// queued before — never a combination, just the most recent request) and
// run automatically the moment the ramp finishes.
let pendingAction = null; // { run: () => void }

function queueAction(run) {
    pendingAction = { run };
}

function drainPending() {
    if (isTransitionLocked()) return;
    const action = pendingAction;
    if (!action) return;
    pendingAction = null;
    setTimeout(() => action.run(), 20);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fadeVol(from, to, sec, ownerId) {
    if (sec <= 0.05) { if (isFadeOwner(ownerId)) { TrackPlayer.setVolume(to).catch(() => { }); } return; }
    const STEPS = Math.max(10, Math.round(sec * 25));
    const totalMs = sec * 1000;
    const start = Date.now();
    for (let i = 1; i <= STEPS; i++) {
        if (!isFadeOwner(ownerId)) return;
        TrackPlayer.setVolume(Math.max(0, Math.min(1, from + (to - from) * (i / STEPS)))).catch(() => { });
        if (i < STEPS) {
            const targetElapsed = totalMs * (i / STEPS);
            const wait = Math.max(0, targetElapsed - (Date.now() - start));
            await sleep(wait);
        }
    }
}

async function waitForPlaying(timeoutMs = 2500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const state = await TrackPlayer.getState();
            if (state === State.Playing) return true;
            if (state === State.Paused || state === State.Stopped) return false;
        } catch { return false; }
        await sleep(40);
    }
    return false;
}

// --- End-of-track crossfade watcher -----------------------------------
let progressSub = null;
let fallbackTimer = null;

async function checkCrossfadeWindow(position, duration) {
    try {
        // Duration reported in the first couple seconds of a track can be a
        // provisional/incorrect value while metadata is still loading, which
        // was causing a false "we're near the end" trigger a few seconds
        // into a fresh song (heard as a sudden volume dip that "fixed
        // itself" once the real duration came through and cancelled it).
        if (position < 3) return;

        const cf = await getCrossfade();

        // If we currently own a natural end-of-track fade but a seek moved
        // playback back OUT of the window (e.g. rewound), cancel it instead
        // of letting it keep fading toward 0 and getting stuck silent —
        // this was the "song goes silent but keeps playing" bug.
        if (naturalEndFadeOwner !== null && activeFadeId === naturalEndFadeOwner) {
            const remaining = duration ? duration - position : Infinity;
            if (cf <= 0 || !duration || remaining > cf + 0.5) {
                const id = naturalEndFadeOwner;
                naturalEndFadeOwner = null;
                releaseFade(id);
                try { await TrackPlayer.setVolume(1); } catch { }
                drainPending();
            }
            return;
        }

        if (activeFadeId !== null) return; // something else owns a fade right now
        if (cf <= 0 || !duration || duration < 1) return;
        const remaining = duration - position;
        if (remaining > 0.15 && remaining <= cf) {
            const id = claimFade();
            naturalEndFadeOwner = id;
            // Wider safety margin so the fade reliably finishes BEFORE native
            // auto-advance fires, avoiding the race that cut songs short.
            await fadeVol(1, 0, Math.max(0.15, remaining - 0.35), id);
        }
    } catch { }
}

function startWatcher() {
    if (!progressSub) {
        progressSub = TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, ({ position, duration }) => {
            checkCrossfadeWindow(position, duration);
        });
    }
    if (!fallbackTimer) {
        fallbackTimer = setInterval(async () => {
            try {
                const state = await TrackPlayer.getState();
                if (state !== State.Playing) return;
                const p = await TrackPlayer.getProgress();
                await checkCrossfadeWindow(p.position, p.duration);
            } catch { }
        }, 400);
    }
}

function stopWatcher() {
    if (progressSub) { progressSub.remove(); progressSub = null; }
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
}

// Fades out whatever's currently audible (if anything is), using the same
// duration as skipWithCrossfade's fade-out. Used right before any "start
// something new" action (tapping a song, tapping Play on a playlist,
// jumping to a queue row) so the previous audio doesn't just cut — those
// actions previously only ever faded the NEW track in, never faded the OLD
// one out, so switching mid-song sounded like an abrupt stop followed by a
// fade-in, not a real transition. Leaves the fade lock claimed by the id it
// used; callers are expected to immediately call forceReleaseFade() +
// preClaimFadeForFreshStart() afterward for their own fade-in, which safely
// takes over ownership.
// Fades out whatever's currently audible (if anything is). Takes the
// duration to use rather than deciding internally — this used to always use
// the Skip duration, even for actions that aren't a skip at all (tapping a
// song, tapping Play on a playlist, jumping to a queue row). If someone had
// a real Skip duration but a near-zero/0 "On Play" duration, that mismatch
// meant those actions faded OUT audibly (skip's duration) but snapped IN
// instantly (play's duration, used separately by playWithRamp right after)
// — sounded like a genuine bug even though each half was individually
// working as configured. Callers now pass whichever duration setting
// actually matches the fade-IN they're about to do immediately after, so
// both halves of the transition always agree.
export async function fadeOutCurrentIfPlaying(dur) {
    try {
        const wasPlaying = (await TrackPlayer.getState()) === State.Playing;
        if (!wasPlaying) return;
        const id = claimFade();
        if (dur > 0.05) {
            try { await TrackPlayer.setVolume(1); } catch { }
            await fadeVol(1, 0, dur, id);
        }
    } catch { }
}

export async function playWithRamp(preClaimedId, startAction = () => TrackPlayer.play()) {
    if (!preClaimedId && isTransitionLocked()) { queueAction(() => playWithRamp()); return; }
    rampLock = true;
    try {
        const ramp = await getAudioRamp();
        // "Ramp on Pause" only controls the pause fade-out (below in
        // pauseWithRamp) — it does not gate this function. Resuming/playing
        // always follows the Audio Ramp duration on its own, same as a
        // fresh song start. A previous version gated this on the pause
        // toggle too, which meant turning "Ramp on Pause" off silently also
        // killed ramping on resume, skip-while-paused, and effectively the
        // whole ramp-in side — that was wrong scope, not intended.
        if (ramp > 0.05 && (preClaimedId || activeFadeId === null)) {
            const id = preClaimedId ?? claimFade();
            try { await TrackPlayer.setVolume(0); } catch { }
            try { await startAction(); } catch { }
            const reallyPlaying = await waitForPlaying();
            // If we never actually confirmed real playback within the
            // timeout, ramping anyway means the volume climbs to full
            // during what might still be silence/buffering — audio then
            // starts late, already at full volume, sounding exactly like no
            // fade happened at all even though the ramp genuinely ran. Skip
            // stright to full rather than guess at timing we don't have.
            if (!reallyPlaying) {
                try { await TrackPlayer.setVolume(1); } catch { }
                releaseFade(id);
            } else {
                // Longer settle margin than before (50ms) — State.Playing
                // can fire slightly ahead of audio actually reaching the
                // speaker, especially right after a queue reset, which is
                // exactly when this runs. Too short a margin meant the ramp
                // could start, and sometimes nearly finish, before there
                // was anything audible for it to apply to.
                await sleep(180);
                await fadeVol(0, 1, ramp, id);
                releaseFade(id);
            }
        } else {
            if (preClaimedId) releaseFade(preClaimedId);
            try { await TrackPlayer.setVolume(1); } catch { }
            try { await startAction(); } catch { }
        }
        startWatcher();
    } finally {
        await sleep(60);
        rampLock = false;
        drainPending();
    }
}

export async function pauseWithRamp() {
    if (isTransitionLocked()) { queueAction(() => pauseWithRamp()); return; }
    rampLock = true;
    try {
        const useFade = await getRampOnPause();
        const ramp = await getAudioRamp();
        if (useFade && ramp > 0.05 && activeFadeId === null) {
            const id = claimFade();
            await fadeVol(1, 0, ramp, id);
            releaseFade(id);
            try { await TrackPlayer.pause(); } catch { }
            try { await TrackPlayer.setVolume(1); } catch { }
        } else {
            try { await TrackPlayer.pause(); } catch { }
        }
    } finally {
        await sleep(60);
        rampLock = false;
        drainPending();
    }
}

// Skip. Two special cases beyond the normal fade-out/skip/fade-in:
// - If a fade is already in flight (natural crossfade, or another skip),
//   this call is ignored entirely rather than racing it.
// - If playback is currently PAUSED, there's nothing to fade out — this now
//   behaves like loading the new song and starting it with the Play ramp,
//   not the Skip ramp (skipping while paused isn't really "crossfading"
//   between two playing songs).
export async function skipWithCrossfade(direction = 'next') {
    if (isTransitionLocked()) { queueAction(() => skipWithCrossfade(direction)); return; }
    skipLock = true;
    try {
        const wasPlaying = (await TrackPlayer.getState()) === State.Playing;

        if (!wasPlaying) {
            try {
                if (direction === 'next') await withTimeout(TrackPlayer.skipToNext(), 5000);
                else await withTimeout(TrackPlayer.skipToPrevious(), 5000);
            } catch { return; }
            await playWithRamp();
            return;
        }

        const id = claimFade();
        const dur = await getSkipCrossfade();
        try { await TrackPlayer.setVolume(1); } catch { }
        if (dur > 0.05) await fadeVol(1, 0, dur, id);
        if (!isFadeOwner(id)) return;

        try {
            if (direction === 'next') await withTimeout(TrackPlayer.skipToNext(), 5000);
            else await withTimeout(TrackPlayer.skipToPrevious(), 5000);
        } catch {
            try { await TrackPlayer.setVolume(1); } catch { }
            releaseFade(id);
            return;
        }

        await waitForPlaying();
        if (!isFadeOwner(id)) return;

        if (dur > 0.05) {
            try { await TrackPlayer.setVolume(0); } catch { }
            try { await TrackPlayer.play(); } catch { }
            await fadeVol(0, 1, dur, id);
        } else {
            try { await TrackPlayer.setVolume(1); } catch { }
            try { await TrackPlayer.play(); } catch { }
        }
        releaseFade(id);
    } finally {
        await sleep(80);
        skipLock = false;
        drainPending();
    }
}

export async function PlaybackService() {
    TrackPlayer.addEventListener(Event.RemotePause, () => pauseWithRamp());
    TrackPlayer.addEventListener(Event.RemotePlay, () => playWithRamp());
    TrackPlayer.addEventListener(Event.RemoteStop, () => { stopWatcher(); TrackPlayer.stop(); });
    TrackPlayer.addEventListener(Event.RemoteNext, () => skipWithCrossfade('next'));
    TrackPlayer.addEventListener(Event.RemotePrevious, () => skipWithCrossfade('prev'));

    TrackPlayer.addEventListener(Event.PlaybackState, ({ state }) => {
        if (state === State.Playing) startWatcher();
        else if (state === State.Paused || state === State.Stopped) stopWatcher();
    });

    TrackPlayer.addEventListener(Event.PlaybackTrackChanged, async ({ nextTrack }) => {
        if (nextTrack === null || nextTrack === undefined) {
            if (naturalEndFadeOwner !== null) { releaseFade(naturalEndFadeOwner); naturalEndFadeOwner = null; }
            try { await TrackPlayer.setVolume(1); } catch { }
            return;
        }
        if (naturalEndFadeOwner !== null && isFadeOwner(naturalEndFadeOwner)) {
            const id = naturalEndFadeOwner;
            naturalEndFadeOwner = null;
            try { await TrackPlayer.setVolume(0); } catch { }
            const cf = await getCrossfade();
            if (cf > 0.05) {
                // Same issue as playWithRamp had: waitForPlaying's result
                // was never checked, so if it timed out (audio not
                // confirmed playing within 800ms — plausible right after a
                // natural track change, loading the next file), the ramp
                // still started anyway. It fading partway against
                // silence/buffering, then something else (the very next
                // event, or this same handler firing again) setting volume
                // outright, is exactly what "starts quiet then jumps" would
                // sound like — a real ramp that got cut short, not a
                // missing one.
                const reallyPlaying = await waitForPlaying(800);
                if (!reallyPlaying) {
                    try { await TrackPlayer.setVolume(1); } catch { }
                } else if (isFadeOwner(id)) {
                    await fadeVol(0, 1, Math.min(cf, 2.5), id);
                }
            } else {
                try { await TrackPlayer.setVolume(1); } catch { }
            }
            releaseFade(id);
        } else if (activeFadeId === null) {
            try { await TrackPlayer.setVolume(1); } catch { }
        }
        startWatcher();
        drainPending();
    });
}
