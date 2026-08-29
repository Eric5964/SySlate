import TrackPlayer, { Event, State } from 'react-native-track-player';
import { getEndOfTrackRamp, getSkipRamp, getAudioRamp, getRampOnPause, getPrevButtonMode, getRestartThresholdSec } from '../utils/storage';
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
// True only for the duration of the natural end-of-track ramp's fade-IN half (the
// new/repeated track ramping 0->1 after the old one finished fading out) —
// see pauseWithRamp, which checks this to interrupt that ramp immediately
// instead of waiting for it to finish, unlike the fade-OUT half which is
// left alone to complete on its own.
let naturalFadeInActive = false;
// True only while playWithRamp's own fresh-start/resume ramp-in is
// running — mirrors naturalFadeInActive above, but for the OTHER kind of
// ramp-in. Both get the same treatment in pauseWithRamp: see the comment
// there for why.
let rampInActive = false;

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

// --- End-of-track ramp watcher -----------------------------------
let progressSub = null;
let fallbackTimer = null;

async function checkRampWindow(position, duration) {
    try {
        const ramp = await getEndOfTrackRamp();

        // If we currently own a natural end-of-track fade but a seek moved
        // playback back OUT of the window (e.g. rewound), cancel it instead
        // of letting it keep fading toward 0 and getting stuck silent —
        // this was the "song goes silent but keeps playing" bug. This is
        // ALSO what actually runs every time single-track repeat
        // (RepeatMode.Track) loops the same song back to its own start:
        // position resetting to ~0 mid-fade looks identical to a rewind
        // from here, and RNTP doesn't fire PlaybackTrackChanged for a
        // same-track repeat (the queue index never actually changes), so
        // the real ramp-in logic further down — entirely gated behind that
        // event — never runs for a loop repeat. This path was the ONLY
        // thing restoring volume after a loop, and it did it with a flat
        // setVolume(1) — a hard jump, not a ramp, which is exactly "the
        // ramping doesn't work going into the start." Fading back in here
        // instead covers both cases: a genuine rewind recovers smoothly
        // instead of snapping, and a loop repeat now gets the same ramp-in
        // a real track change would have given it.
        //
        // Deliberately checked BEFORE the position<3 guard further down —
        // that guard exists to stop a fresh track's still-loading duration
        // metadata from falsely LOOKING like "near the end" and starting an
        // unwanted fade-out (see below). It has nothing to do with THIS
        // block, which only ever runs while recovering an existing fade —
        // but it used to sit above this whole function and return early
        // regardless, which meant this recovery code plain didn't run at
        // all for the first 3 seconds after a loop restart (position is
        // naturally under 3 there). That's 3 real seconds of silence before
        // any ramp-in even started, which is exactly why the ramp itself
        // then read as "too short" — it was never short, it just started 3
        // seconds later than it should have.
        if (naturalEndFadeOwner !== null && activeFadeId === naturalEndFadeOwner) {
            const remaining = duration ? duration - position : Infinity;
            if (ramp <= 0 || !duration || remaining > ramp + 0.5) {
                const id = naturalEndFadeOwner;
                naturalEndFadeOwner = null;
                releaseFade(id);
                const newId = claimFade();
                // Always restarts from silence rather than trusting
                // TrackPlayer.getVolume() to report where the fade-out left
                // off — the native repeat/seek-to-0 that causes this whole
                // path to run in the first place may itself reset volume as
                // a side effect (same class of thing as TrackPlayer.reset()
                // doing it elsewhere), so a "current volume" read here isn't
                // reliable. Forcing 0 first guarantees the full configured
                // duration actually covers the full silence-to-full
                // distance, instead of occasionally starting partway up and
                // making the audible ramp feel rushed. Also no longer capped
                // at 2.5s — respects the real configured duration, matching
                // what a genuine track-to-track transition gets.
                if (ramp > 0.05) {
                    naturalFadeInActive = true;
                    try {
                        try { await TrackPlayer.setVolume(0); } catch { }
                        await fadeVol(0, 1, ramp, newId);
                    } finally {
                        // finally, not just a line after — fadeVol/setVolume
                        // are already exception-safe internally so this
                        // shouldn't be reachable via a throw in practice, but
                        // a flag stuck at true here would silently break
                        // every pause after it (see pauseWithRamp), so it's
                        // worth the extra safety net regardless.
                        naturalFadeInActive = false;
                    }
                } else {
                    try { await TrackPlayer.setVolume(1); } catch { }
                }
                releaseFade(newId);
                drainPending();
            }
            return;
        }

        // Duration reported in the first couple seconds of a track can be a
        // provisional/incorrect value while metadata is still loading, which
        // was causing a false "we're near the end" trigger a few seconds
        // into a fresh song (heard as a sudden volume dip that "fixed
        // itself" once the real duration came through and cancelled it).
        // Only guards the "should a NEW fade-out start" check below —
        // deliberately doesn't gate the recovery block above (see its own
        // comment for why).
        if (position < 3) return;

        if (activeFadeId !== null) return; // something else owns a fade right now
        if (ramp <= 0 || !duration || duration < 1) return;
        const remaining = duration - position;
        if (remaining > 0.15 && remaining <= ramp) {
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
            checkRampWindow(position, duration);
        });
    }
    if (!fallbackTimer) {
        fallbackTimer = setInterval(async () => {
            try {
                const state = await TrackPlayer.getState();
                if (state !== State.Playing) return;
                const p = await TrackPlayer.getProgress();
                await checkRampWindow(p.position, p.duration);
            } catch { }
        }, 400);
    }
}

function stopWatcher() {
    if (progressSub) { progressSub.remove(); progressSub = null; }
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
}

// Fades out whatever's currently audible (if anything is), using the same
// duration as skipWithRamp's fade-out. Used right before any "start
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
                rampInActive = true;
                try {
                    await fadeVol(0, 1, ramp, id);
                } finally {
                    rampInActive = false;
                }
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
    if (naturalFadeInActive || rampInActive) {
        // An active ramp-IN — either the natural end-of-track transition's
        // fade-in, or a fresh start/resume's own ramp-in from playWithRamp —
        // is running when pause is requested. This used to let the ramp
        // finish climbing all the way to full volume (or, for the natural
        // case, cut it short) and then hard-pause with no ramp-out at all
        // either way. Since the audio was already visibly "in motion" via
        // an active fade right before that cut, a sudden hard stop reads as
        // broken in a way an ordinary steady-state hard pause doesn't.
        // Redirects into a real ramp-OUT instead, starting from wherever
        // the interrupted ramp-in actually left the volume (read directly
        // rather than assumed, since an interrupted ramp-in could be
        // anywhere between 0 and 1) — quick, using the Skip Ramp duration
        // rather than the full End of Track/Audio Ramp length, since this
        // is fundamentally an urgent "stop now" request, not a leisurely
        // transition.
        naturalFadeInActive = false;
        rampInActive = false;
        forceReleaseFade();
        rampLock = true;
        try {
            let current = 1;
            try { current = await TrackPlayer.getVolume(); } catch { }
            const outDur = await getSkipRamp();
            if (outDur > 0.05 && current > 0.02) {
                const id = claimFade();
                await fadeVol(current, 0, outDur, id);
                releaseFade(id);
            }
            try { await TrackPlayer.pause(); } catch { }
            try { await TrackPlayer.setVolume(1); } catch { }
        } finally {
            await sleep(60);
            rampLock = false;
            drainPending();
        }
        return;
    }
    if (isTransitionLocked()) {
        // Whatever's currently ramping — a fresh start's ramp-in, a manual
        // ramp-out already in flight, the natural end-of-track ramp,
        // another skip — gets left to finish on its own; pause doesn't
        // interrupt it. This used to queue pauseWithRamp itself here, which
        // meant once that finished, IT would kick off its OWN full
        // ramp-down before actually pausing — so what landed was [current
        // ramp] [a whole SECOND ramp] [finally paused], noticeably later
        // than the tap. Now it's [current ramp] [paused immediately, no
        // ramp] — the pause lands the moment it safely can, without adding
        // a second ramp cycle on top of whatever was already happening.
        queueAction(() => pauseImmediate());
        return;
    }
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

// See the natural-end-fade branch in pauseWithRamp above — pauses right
// away with no ramp at all, regardless of the Ramp on Pause setting,
// instead of running pauseWithRamp's normal fade-out logic.
async function pauseImmediate() {
    rampLock = true;
    try {
        try { await TrackPlayer.pause(); } catch { }
        try { await TrackPlayer.setVolume(1); } catch { }
    } finally {
        await sleep(60);
        rampLock = false;
        drainPending();
    }
}

// Skip. Two special cases beyond the normal fade-out/skip/fade-in:
// - If a fade is already in flight (natural end-of-track ramp, or another skip),
//   this call is ignored entirely rather than racing it.
// - If playback is currently PAUSED, there's nothing to fade out — this now
//   behaves like loading the new song and starting it with the Play ramp,
//   not the Skip ramp (skipping while paused isn't really "crossfading"
//   between two playing songs).
export async function skipWithRamp(direction = 'next') {
    // A skip that arrives while the NATURAL end-of-track ramp is
    // running (naturalEndFadeOwner) is dropped entirely, not queued — that
    // fade is already about to move to the next song on its own, so
    // queueing a skip on top of it used to skip PAST that song to the one
    // after, which read as the skip firing on a song you never actually
    // saw. A skip during any OTHER lock (the ramp-in at the start of a
    // track, a manual pause fade, another skip already in flight) still
    // queues as before — that's a real tap that should still land once
    // that transition clears, just not this one specific case.
    if (isTransitionLocked()) {
        if (naturalEndFadeOwner !== null && isFadeOwner(naturalEndFadeOwner)) return;
        queueAction(() => skipWithRamp(direction));
        return;
    }
    skipLock = true;
    try {
        // For 'prev' specifically, decide up front — before any fade delay
        // below eats real time — whether this press should actually go to
        // the previous track or just restart the current one. Reading
        // position now, at the moment the button was actually pressed,
        // keeps the threshold check honest to when the tap happened rather
        // than to whatever position playback has drifted to after a
        // multi-hundred-ms fade-out.
        let restartCurrent = false;
        if (direction === 'prev') {
            const mode = await getPrevButtonMode();
            if (mode === 'restart_or_previous') {
                const threshold = await getRestartThresholdSec();
                try {
                    const { position } = await TrackPlayer.getProgress();
                    restartCurrent = position > threshold;
                } catch { }
            }
        }
        const doNativeSkip = () => {
            if (direction === 'next') return TrackPlayer.skipToNext();
            if (restartCurrent) return TrackPlayer.seekTo(0);
            return TrackPlayer.skipToPrevious();
        };

        const wasPlaying = (await TrackPlayer.getState()) === State.Playing;

        if (!wasPlaying) {
            try {
                await withTimeout(doNativeSkip(), 5000);
            } catch { return; }
            await playWithRamp();
            return;
        }

        const id = claimFade();
        const dur = await getSkipRamp();
        try { await TrackPlayer.setVolume(1); } catch { }
        if (dur > 0.05) await fadeVol(1, 0, dur, id);
        if (!isFadeOwner(id)) return;

        try {
            await withTimeout(doNativeSkip(), 5000);
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
    TrackPlayer.addEventListener(Event.RemoteNext, () => skipWithRamp('next'));
    TrackPlayer.addEventListener(Event.RemotePrevious, () => skipWithRamp('prev'));

    TrackPlayer.addEventListener(Event.PlaybackState, ({ state }) => {
        if (state === State.Playing) startWatcher();
        else if (state === State.Paused || state === State.Stopped) stopWatcher();
    });

    TrackPlayer.addEventListener(Event.PlaybackTrackChanged, async ({ nextTrack }) => {
        if (nextTrack === null || nextTrack === undefined) {
            if (naturalEndFadeOwner !== null) { releaseFade(naturalEndFadeOwner); naturalEndFadeOwner = null; }
            // TrackPlayer.reset() (the first half of primeNativeQueue, used
            // any time playback is interrupted rather than left to end
            // naturally) fires THIS event with nextTrack null, since the
            // queue is briefly empty between reset() and the following
            // add(). Forcing volume back to 1 here unconditionally — with
            // no activeFadeId check — undoes preClaimFadeForFreshStart's
            // whole purpose: activeFadeId is already claimed by that point,
            // but this branch ignored it and slammed volume to 1 anyway.
            // playWithRamp's own setVolume(0) a moment later mostly papers
            // over it, but not before that forced 1 has already reached the
            // native audio session — which is the "starts super high, then
            // starts the ramp" bug, and exactly why it only ever happened
            // interrupting a playing song (which goes through reset()) and
            // never on a natural track-end (which doesn't). The sibling
            // branch below already guards this same fallback correctly with
            // `activeFadeId === null` — this one just never got the same
            // guard when reset()'s null-nextTrack case was added.
            if (activeFadeId === null) {
                try { await TrackPlayer.setVolume(1); } catch { }
            }
            return;
        }
        if (naturalEndFadeOwner !== null && isFadeOwner(naturalEndFadeOwner)) {
            const id = naturalEndFadeOwner;
            naturalEndFadeOwner = null;
            try { await TrackPlayer.setVolume(0); } catch { }
            const ramp = await getEndOfTrackRamp();
            if (ramp > 0.05) {
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
                    naturalFadeInActive = true;
                    try {
                        // Previously capped at Math.min(ramp, 2.5) — a
                        // leftover hidden cap that never got removed here
                        // when the equivalent cap was removed from the
                        // loop-repeat recovery path above in checkRampWindow.
                        // That meant a real track-to-track ramp-in silently
                        // maxed out at 2.5s even if the configured "Audio
                        // Ramp — End of Track" duration was set higher, while
                        // a loop-repeat (going through the other path) used
                        // the full configured value. Now both agree.
                        await fadeVol(0, 1, ramp, id);
                    } finally {
                        naturalFadeInActive = false;
                    }
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
