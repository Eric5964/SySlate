import AudioEngine, { Event, State } from '../native/AudioEngine';
import { getEndOfTrackRamp, getSkipRamp, getAudioRamp, getRampOnPause, getPrevButtonMode, getRestartThresholdSec, getCrossfadeEnabled, getCrossfadeDurationSkip, getCrossfadeDurationEndOfTrack } from '../utils/storage';
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
// Timestamp + expected duration for whatever skip transition currently
// holds skipLock — lets a SECOND skip tap that lands during it tell "we're
// barely into this transition" from "this transition is basically already
// on the next song" (see skipWithRamp's halfway-aware handling below).
let skipLockStartedAt = 0;
let skipLockExpectedDurationMs = 0;
let rampLock = false;
// True only for the duration of the natural end-of-track ramp's fade-IN half
// (the new/repeated track ramping 0->1 after the old one finished fading
// out) — used by skipWithRamp's halfway-aware handling to tell "barely into
// this transition" from "already committed to the incoming track".
let naturalFadeInActive = false;
// True only while playWithRamp's own fresh-start/resume ramp-in is running
// — mirrors naturalFadeInActive above, but for the OTHER kind of ramp-in.
let rampInActive = false;

// Direct feedback: toggling Crossfade mid-transition was making the
// CURRENT transition glitch — because "is this a crossfade" got re-read
// live from storage at multiple separate points spread across one single
// transition (checkRampWindow's lead-in decision, then again whenever the
// track-change listener's fallback ran, which can fire seconds later once
// a crossfade's own lead-in has been running). If the setting changed in
// that window, the two reads disagreed about the same transition — e.g.
// native genuinely ran a crossfade because the FIRST read saw it enabled,
// but the listener's SECOND, independent read then saw it freshly
// disabled and slammed volume to 1 on top of native's already-correct
// crossfaded level. This snapshots the decision exactly once, at whichever
// of the three call sites actually kicks a transition off, and every other
// site downstream of that same transition reads this instead of storage
// again — so a toggle flip can only ever change the NEXT transition, never
// reach back into one already in flight.
let currentTransitionCrossfading = false;

const claimFade = () => { activeFadeId = ++fadeCounter; return activeFadeId; };
const isFadeOwner = (id) => activeFadeId === id;
const releaseFade = (id) => { if (activeFadeId === id) activeFadeId = null; };

// Claims the fade lock BEFORE the caller populates a fresh native queue
// (AudioEngine.reset()+add()). That add() can itself fire a native
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
    // Belt-and-suspenders alongside native's own cancel-on-next-setVolume/
    // rampVolume behavior (see AudioEngine.swift): most callers of this
    // immediately follow up with their own setVolume/fadeVol, which already
    // supersedes whatever ramp was running — but not every caller does, and
    // this makes those cases correct too instead of relying on it being
    // incidental. Fire-and-forget; nothing here needs to await it.
    AudioEngine.cancelVolumeRamp().catch(() => { });
}

// Instead of silently dropping a play/pause/skip that arrives while a ramp
// is mid-flight, the LATEST one is remembered (overwriting whatever was
// queued before — never a combination, just the most recent request) and
// run automatically the moment the ramp finishes.
let pendingAction = null; // { run: () => void }

export function queueAction(run) {
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

// "Minimum is double the longest crossfade/ramp duration" — for the plain
// (non-crossfade) ramp paths below. A ramp that's a meaningful fraction of
// the whole track's length doesn't really "ramp in then play normally,"
// it's most of the track — e.g. a 3s clip with a 2s ramp is ramping for
// 2/3 of its length. Checked against whatever's actually loaded right now
// via getProgress() rather than something passed in, so this covers every
// call site (resume, skip, natural end) from one place. A duration of 0
// (not yet known) doesn't block — better to ramp than to silently guess
// wrong before the real duration has even loaded.
async function isTooShortToRamp(rampSeconds) {
    try {
        const { duration } = await AudioEngine.getProgress();
        return duration > 0 && duration < rampSeconds * 2;
    } catch { return false; }
}

// Used to run the ENTIRE ramp as one native call (see AudioEngine.swift's
// rampVolume) instead of this function looping ~25 setVolume() bridge calls
// a second itself. That loop was the likely cause of "the ramp glitches,
// sounds like cuts up and down, or delays ramping up" — every single step
// was its own async round-trip, so if the bridge fell behind (any JS-thread
// load, easy to hit mid-skip/mid-transition, which is exactly when this
// runs), steps bunched up or landed late instead of at their scheduled
// time. Running the curve natively makes it immune to that. Same
// raised-cosine ("S-curve") easing as before — see the native side's own
// comment for why cosine over plain linear.
//
// Ownership (isFadeOwner) is still checked once, right before handing off
// to native — if this fade was already superseded before it even started,
// skip calling rampVolume at all rather than briefly hijacking the audio
// with a fade nothing wants anymore. Once the native call is in flight, its
// own supersede-on-next-setVolume/rampVolume behavior (see
// cancelActiveRampLocked in AudioEngine.swift) is what protects it from
// then on — not a per-step JS check anymore, since there are no more
// per-step round trips to check between.
async function fadeVol(from, to, sec, ownerId) {
    if (!isFadeOwner(ownerId)) return;
    try {
        await AudioEngine.rampVolume(from, to, Math.max(0, sec));
    } catch { }
}

async function waitForPlaying(timeoutMs = 4000) {
    // Real improvement here: this used to poll getState() every 40ms —
    // each poll is its own bridge round-trip, so detection could lag up to
    // ~40ms+ behind the actual moment state flips, on top of round-trip
    // latency itself, on every single poll. setState(.playing) already
    // fires a PlaybackState event the INSTANT it happens natively (see
    // AudioEngine.swift's setState) — listening for it directly is both
    // faster and exact instead of guessing based on a polling interval.
    // Given how persistent the ramp-in-doesn't-happen reports have been
    // even after widening timeouts/margins, tightening the actual
    // detection mechanism seemed more likely to help than yet another
    // bigger number.
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            sub.remove();
            clearTimeout(timer);
            resolve(result);
        };
        // Covers the race where state already settled and its event
        // already fired BEFORE this listener got attached — startAction()
        // above is awaited, so there's a real window for that.
        AudioEngine.getState().then((state) => {
            if (state === State.Playing) finish(true);
            else if (state === State.Paused || state === State.Stopped) finish(false);
        }).catch(() => { });
        const sub = AudioEngine.addEventListener(Event.PlaybackState, ({ state }) => {
            if (state === State.Playing) finish(true);
            else if (state === State.Paused || state === State.Stopped) finish(false);
        });
        const timer = setTimeout(() => finish(false), timeoutMs);
    });
}

// --- End-of-track ramp watcher -----------------------------------
let progressSub = null;
let fallbackTimer = null;

async function checkRampWindow(position, duration) {
    try {
        const ramp = await getEndOfTrackRamp();
        // When crossfade is on, the native side handles the ENTIRE
        // transition itself (both tracks' volumes, in lockstep, on the
        // actual overlapping audio) for a genuine track-to-track advance —
        // this JS fade-out must NOT also run for that case, or by the time
        // native's crossfade starts the outgoing track is already silent
        // and there's nothing left to audibly overlap with the incoming
        // one, defeating the entire point. Does NOT gate the recovery
        // block below, which is specifically for single-track repeat —
        // native crossfade only ever applies to a genuine index change
        // (see AudioEngine.swift's advance()), never a same-track loop, so
        // JS still owns fading a repeat regardless of this setting.
        //
        // Real bug found while splitting Crossfade Duration into On Skip /
        // End of Track: this used to read the single old
        // getCrossfadeDuration(), which no longer tracks what the Settings
        // screen actually writes. This check only ever runs near a
        // NATURAL end of track, so it needs the End of Track duration
        // specifically — reading the wrong one here would mean this JS
        // fade-out either double-fires alongside native's own crossfade or
        // fails to back off for it.
        const crossfading = (await getCrossfadeEnabled()) && (await getCrossfadeDurationEndOfTrack()) > 0.05;
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
                // AudioEngine.getVolume() to report where the fade-out left
                // off — the native repeat/seek-to-0 that causes this whole
                // path to run in the first place may itself reset volume as
                // a side effect (same class of thing as AudioEngine.reset()
                // doing it elsewhere), so a "current volume" read here isn't
                // reliable. Forcing 0 first guarantees the full configured
                // duration actually covers the full silence-to-full
                // distance, instead of occasionally starting partway up and
                // making the audible ramp feel rushed. Also no longer capped
                // at 2.5s — respects the real configured duration, matching
                // what a genuine track-to-track transition gets.
                if (ramp > 0.05 && !(await isTooShortToRamp(ramp))) {
                    naturalFadeInActive = true;
                    try {
                        try { await AudioEngine.setVolume(0); } catch { }
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
                    try { await AudioEngine.setVolume(1); } catch { }
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
        // Snapshot right here, at the actual decision point for THIS
        // transition — see currentTransitionCrossfading's comment up top.
        currentTransitionCrossfading = crossfading;
        if (crossfading) return; // native crossfade owns this transition instead
        if (ramp <= 0 || !duration || duration < 1) return;
        const remaining = duration - position;
        if (remaining > 0.15 && remaining <= ramp) {
            const id = claimFade();
            naturalEndFadeOwner = id;
            // Real bug found here (direct feedback: "songs sometimes cut
            // off early with audio ramping... ramp out too early"): this
            // subtracted a flat 0.35s off the fade's own length, on top of
            // the fade already starting right at the ramp window boundary
            // — meaning EVERY track with End of Track ramping on spent its
            // last 0.35s sitting at pure silence before the track's real
            // (already Silence-Trim-adjusted, if that's on too) end,
            // rather than fading smoothly through to it. That's not an
            // edge case, that's every single track, by design. Cut to
            // 0.15s, same as the floor right below it — still enough of a
            // margin to finish before native auto-advance fires (the race
            // this was originally added for), just not enough to eat over
            // a third of a second of silence at the end of every track on
            // its own.
            await fadeVol(1, 0, Math.max(0.15, remaining - 0.15), id);
        }
    } catch { }
}

function startWatcher() {
    // Real bug found here — a real contributor to "the app lags to an
    // insane extent... likely an issue with crossfade too": these two
    // watchers were both always running, completely independently of each
    // other. The native PlaybackProgressUpdated event now fires every
    // 0.25s (bumped from 1s in an earlier round specifically to catch
    // short ramp windows accurately — see AudioEngine.swift's
    // startProgressTimer), and this fallback interval ALSO independently
    // polls every 400ms regardless, on top of that — meaning
    // checkRampWindow, which does 3 separate AsyncStorage round-trips
    // every time it runs, was firing roughly 4-5x/sec continuously, the
    // entire time anything was playing, not just near a transition. The
    // fallback was clearly meant as a safety net for if the event stream
    // ever stops, not a second full-time poller — now it only actually
    // does anything if a real event tick hasn't landed recently, so during
    // normal playback (the overwhelming majority of the time) it's an
    // idle no-op check instead of 3 more AsyncStorage reads every 400ms.
    let lastEventTickAt = 0;
    if (!progressSub) {
        progressSub = AudioEngine.addEventListener(Event.PlaybackProgressUpdated, ({ position, duration }) => {
            lastEventTickAt = Date.now();
            checkRampWindow(position, duration);
        });
    }
    if (!fallbackTimer) {
        fallbackTimer = setInterval(async () => {
            if (Date.now() - lastEventTickAt < 1200) return; // events are flowing normally, nothing to do
            try {
                const state = await AudioEngine.getState();
                if (state !== State.Playing) return;
                const p = await AudioEngine.getProgress();
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
        const wasPlaying = (await AudioEngine.getState()) === State.Playing;
        if (!wasPlaying) return;
        const id = claimFade();
        try {
            if (dur > 0.05 && !(await isTooShortToRamp(dur))) {
                try { await AudioEngine.setVolume(1); } catch { }
                await fadeVol(1, 0, dur, id);
            }
        } finally {
            releaseFade(id);
        }
    } catch { }
}

export async function playWithRamp(preClaimedId, startAction = () => AudioEngine.play()) {
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
        // Was `ramp > 0.05 && (preClaimedId || activeFadeId === null)` — real
        // bug, and very likely the actual mechanism behind "lock screen
        // play doesn't ramp, just jumps the position" plus the standing
        // "ramping stops working after a long session/idle" reports.
        // claimFade() always safely supersedes whatever fade is currently
        // active (see its own definition — it's designed to be called
        // unconditionally), so requiring activeFadeId === null here wasn't
        // preventing a race, it was just refusing to ramp at all whenever
        // ANY fade — including a stale one left over from an interrupted
        // pause/background transition that never got around to releasing
        // itself — happened to still be marked active. A genuinely new
        // play action should always claim its own fade fresh, not defer to
        // whatever's already there.
        if (ramp > 0.05 && !(await isTooShortToRamp(ramp))) {
            const id = preClaimedId ?? claimFade();
            // Still set from here rather than just around fadeVol below —
            // no longer for pauseWithRamp's benefit (pause just queues
            // behind isTransitionLocked() uniformly now, see its comment),
            // but skipWithRamp's halfway-aware second-skip handling reads
            // this flag too, and needs it true for the full duration this
            // ramp-in is actually committed, not just once fadeVol starts.
            rampInActive = true;
            // Temporary diagnostic logging — tagged [RAMP-DEBUG], not a
            // fix. Four investigation passes on "ramp doesn't engage for
            // silence-trimmed tracks" haven't found a root cause by reading
            // code alone; this is the actual timing of every step in this
            // sequence, so the next time it happens, the console output
            // (Xcode, or Metro if reproducible on a dev build) shows
            // exactly where the gap is instead of more guessing. Safe to
            // strip once this is diagnosed — or leave in, it's cheap.
            const rampDebugT0 = Date.now();
            console.log(`[RAMP-DEBUG] t+0ms: starting ramp-in, configured duration=${ramp}s`);
            try {
                try { await AudioEngine.setVolume(0); } catch { }
                console.log(`[RAMP-DEBUG] t+${Date.now() - rampDebugT0}ms: setVolume(0) done, calling startAction`);
                try { await startAction(); } catch { }
                console.log(`[RAMP-DEBUG] t+${Date.now() - rampDebugT0}ms: startAction resolved, waiting for playing`);
                const reallyPlaying = await waitForPlaying();
                console.log(`[RAMP-DEBUG] t+${Date.now() - rampDebugT0}ms: waitForPlaying resolved, reallyPlaying=${reallyPlaying}`);
                // Widened timeout (was 2500ms) plus this changed from an
                // instant setVolume(1) to a short catch-up fade — on a
                // sideloaded/LiveContainer build especially, the timeout
                // itself firing doesn't necessarily mean playback never
                // started; getState() polling is itself bridge round-trips
                // that can be slow to catch up under load, so audio may
                // well have started moments before the timeout gave up on
                // it. Snapping straight to full volume right at that
                // moment is audibly identical to "ramp didn't happen at
                // all" even on the runs where it basically did — a quick
                // fade here is a safe middle ground either way (still
                // clearly not the FULL configured ramp if this really was
                // a genuine failure, but not a jarring cut either).
                if (!reallyPlaying) {
                    console.log(`[RAMP-DEBUG] t+${Date.now() - rampDebugT0}ms: took the !reallyPlaying branch (timed out) — quick catch-up fade only, not the full configured ramp`);
                    await fadeVol(0, 1, Math.min(0.4, ramp), id);
                    try { await AudioEngine.setVolume(1); } catch { }
                    releaseFade(id);
                } else {
                    // Longer settle margin than before (50ms, then 180ms).
                    // State.Playing can fire slightly ahead of audio
                    // actually reaching the speaker, especially right
                    // after a queue reset. Widened again: the native file
                    // load this is waiting on now happens on a background
                    // thread (moved off the main thread to fix a separate
                    // "gap between songs" issue) before hopping back to
                    // main to call playerNode.play()/setState(.playing) —
                    // real, variable thread-hop + scheduling latency on
                    // top of the original concern this margin already
                    // covered, not just disk I/O time. Too short a margin
                    // means the ramp can start, and sometimes nearly
                    // finish, before there's anything audible for it to
                    // apply to — sounding exactly like no ramp happened.
                    await sleep(320);
                    console.log(`[RAMP-DEBUG] t+${Date.now() - rampDebugT0}ms: 320ms settle done, calling fadeVol(0,1,${ramp})`);
                    await fadeVol(0, 1, ramp, id);
                    console.log(`[RAMP-DEBUG] t+${Date.now() - rampDebugT0}ms: fadeVol resolved — ramp should be fully audible now`);
                    releaseFade(id);
                }
            } finally {
                rampInActive = false;
            }
        } else {
            if (preClaimedId) releaseFade(preClaimedId);
            try { await AudioEngine.setVolume(1); } catch { }
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
    // Per direct feedback (reversing an earlier round's deliberate change):
    // pause should behave identically whether it lands during a crossfade,
    // a natural end-of-track transition, a fresh ramp-in, or a skip's own
    // fade-out — let whichever transition currently owns the fade lock run
    // all the way to its finished state (arriving cleanly on the next
    // song), THEN ramp out and pause from there. This used to special-case
    // three of those four situations into an immediate interrupt-and-ramp-
    // out instead — this pass removes that special-casing entirely rather
    // than trying to keep it in sync with the queued path below, so there's
    // exactly one pause behavior instead of two that need to agree. This
    // also makes pauseWithRamp consistent with this file's own general
    // rule stated at the top: whichever fade claims the lock first runs to
    // completion; it was previously the one exception to that rule.
    if (isTransitionLocked()) {
        // Whatever's currently ramping — a fresh start's ramp-in, a manual
        // ramp-out already in flight, the natural end-of-track ramp,
        // another skip, or (most commonly reaching this specific branch)
        // a crossfade in progress natively — gets left to finish on its
        // own; pause doesn't interrupt it.
        //
        // Queues pauseWithRamp() itself, not pauseImmediate() — was
        // pauseImmediate() briefly, to stop a redundant/duplicate pause
        // tap (nothing transitioning, already paused) from running a
        // whole pointless second ramp-down on top of whatever was already
        // happening. But that swap broke a real, legitimate case: pause
        // requested WHILE a crossfade is running should let the crossfade
        // finish and THEN ramp out properly before pausing — "it finishes
        // the crossfade but pauses without a ramp out. it should ramp out
        // after the crossfade." pauseImmediate() skipped that ramp-out
        // entirely. pauseWithRamp() now has its own guard right below
        // (state !== Playing → no-op) that catches the original
        // already-paused/redundant case just as well, so queuing it back
        // here fixes the crossfade case without reopening that one.
        queueAction(() => pauseWithRamp());
        return;
    }
    // Real bug found here: nothing below checked whether playback was
    // already paused before running the full fade-out sequence. Control
    // Center's play/pause is a single toggle button whose icon is driven
    // by MPNowPlayingInfoPropertyPlaybackRate — right around any state
    // change there's a brief window where a stray/duplicate tap sends
    // ANOTHER pause command for a song that's already paused and silent.
    // Without this guard, that redundant command still ran the entire
    // fade-out (from volume 1, since setVolume(1) resets it after every
    // pause) on a node that wasn't even producing audio, holding rampLock
    // for the full ramp duration — which is exactly "doesn't recognize
    // the end of ramps as a full pause, making it difficult to play the
    // song": the very next real Play tap got queued behind this pointless
    // multi-second no-op instead of running immediately.
    if ((await AudioEngine.getState()) !== State.Playing) return;
    rampLock = true;
    try {
        const useFade = await getRampOnPause();
        const ramp = await getAudioRamp();
        // Same real bug as playWithRamp's own activeFadeId === null guard
        // above (see its comment) — claimFade() already safely supersedes
        // whatever's active, so this was just refusing to ramp out at all
        // whenever a stale fade claim was still sitting there, hard-cutting
        // straight to silence instead. Matches "ramping cuts early" /
        // "doesn't go all the way to 0" reports — the else branch below is
        // an instant AudioEngine.pause() with no fade whatsoever.
        if (useFade && ramp > 0.05 && !(await isTooShortToRamp(ramp))) {
            const id = claimFade();
            try { await AudioEngine.setNowPlayingPaused(true); } catch { }
            await fadeVol(1, 0, ramp, id);
            releaseFade(id);
            try { await AudioEngine.pause(); } catch { }
            try { await AudioEngine.setVolume(1); } catch { }
        } else {
            try { await AudioEngine.pause(); } catch { }
        }
    } finally {
        await sleep(60);
        rampLock = false;
        drainPending();
    }
}

// Currently unused — pauseWithRamp() no longer has a branch that calls
// this (see its comment: pause always ramps out through the normal path
// below, never a hard instant cut). Left in case a genuinely urgent
// no-fade pause is ever needed again.
async function pauseImmediate() {
    rampLock = true;
    try {
        try { await AudioEngine.pause(); } catch { }
        try { await AudioEngine.setVolume(1); } catch { }
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
        // Refined per direct feedback: dropping every second tap
        // unconditionally was too broad. "Not entirely — hitting skip
        // while the 2nd (ramped/crossfaded into) song is playing more than
        // the outgoing one (over halfway through the transition), or a
        // fresh ramp-in is just starting, should let the current fade
        // finish, then fade OUT to start the skip. Never cut instant."
        // So: barely into the transition (well under halfway) → the first
        // skip still represents the freshest intent, drop the second tap.
        // Past halfway (or the transition is itself a ramp-in, which by
        // definition means we're already committed to the incoming track)
        // → honor it, but defer until the current one settles rather than
        // interrupting it, and let it run through its OWN normal
        // fade-out/skip/fade-in — never an instant cut.
        if (skipLock) {
            const elapsed = Date.now() - skipLockStartedAt;
            const pastHalfway = rampInActive || (skipLockExpectedDurationMs > 0 && elapsed >= skipLockExpectedDurationMs / 2);
            if (!pastHalfway) return;
            queueAction(() => skipWithRamp(direction));
            return;
        }
        queueAction(() => skipWithRamp(direction));
        return;
    }
    skipLock = true;
    skipLockStartedAt = Date.now();
    skipLockExpectedDurationMs = 0; // set below once the actual duration for this specific transition is known
    try {
        if (direction === 'next') {
            // Manual skip — this one specifically needs the On Skip
            // duration (same bug/fix as checkRampWindow's End of Track
            // one above — was reading the now-stale combined
            // getCrossfadeDuration() here too).
            const crossfadeDur = await getCrossfadeDurationSkip();
            const crossfading = (await getCrossfadeEnabled()) && crossfadeDur > 0.05;
            // Same snapshot as checkRampWindow — see
            // currentTransitionCrossfading's comment up top.
            currentTransitionCrossfading = crossfading;
            if (crossfading) {
                skipLockExpectedDurationMs = crossfadeDur * 1000;
                try { await withTimeout(AudioEngine.skipToNext(), 5000); } catch { }
                // Real bug found here: AudioEngine.skipToNext()'s promise
                // resolves almost instantly (see AudioEngine.swift's
                // skipToNext — resolve(nil) fires right after KICKING OFF
                // the skip, not once the crossfade animation itself
                // finishes several seconds later). skipLock used to
                // release right after that resolve (via the shared
                // `finally` below, ~80ms later) — meaning the whole
                // "protect against a second tap during a fade" mechanism
                // above didn't apply to crossfade skips for anything past
                // that first ~100ms. A second tap landing any time during
                // the REAL multi-second crossfade fired a completely
                // unprotected second skip, cutting the first crossfade
                // short — exactly "it glitches & just cuts off the fade
                // early, then skips." Holding the lock here for the
                // crossfade's actual configured duration is what makes the
                // halfway-aware logic above actually apply to this case.
                await sleep(crossfadeDur * 1000);
                return;
            }
        }
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
                    const { position } = await AudioEngine.getProgress();
                    restartCurrent = position > threshold;
                } catch { }
            }
        }
        const doNativeSkip = async () => {
            // This entire function only runs once JS has already decided
            // NOT to crossfade (the crossfade branch above returns early
            // instead) — see suppressNextCrossfade's Swift comment for why
            // skipToNext still needs telling that explicitly rather than
            // trusting it to independently reach the same conclusion.
            // Harmless to set for skipToPrevious/seekTo too even though
            // neither can ever natively crossfade anyway (advance()
            // requires direction==1) — one flag, always cleared by native
            // the moment any advance() call reads it, so it can't leak.
            await AudioEngine.setSuppressNextCrossfade(true).catch(() => { });
            if (direction === 'next') return AudioEngine.skipToNext();
            if (restartCurrent) return AudioEngine.seekTo(0);
            return AudioEngine.skipToPrevious();
        };

        const wasPlaying = (await AudioEngine.getState()) === State.Playing;

        if (!wasPlaying) {
            // Real bug found here: this called doNativeSkip() directly, then
            // playWithRamp() as a completely separate step afterward — unlike
            // every OTHER fresh-start call site (see PlaybackContext.js's
            // song-tap/playlist-Play/Shuffle paths), which pre-claim the fade
            // and pass their native call in AS playWithRamp's startAction, so
            // playWithRamp's own setVolume(0) always lands BEFORE native
            // starts playing. Two real problems from skipping that pattern
            // here: (1) native's finishLoadingTrack sets
            // activeNode.volume = volume * gainCorrection and autoplays
            // immediately — `volume` is whatever was last set, which is 1
            // right after any pause (pauseWithRamp/pauseImmediate both
            // restore it to 1 post-pause) — so the new track started
            // audibly at FULL volume, unramped; (2) skipLock was already
            // true at this point (set above), so the plain playWithRamp()
            // call immediately hit its own isTransitionLocked() guard and
            // got queued rather than run — it only actually executed ~100ms
            // later, in drainPending(), once skipLock cleared. Net effect:
            // skip-while-paused briefly played the new song at full volume,
            // then snapped to 0 and ramped up from there — not a ramp-in at
            // all for that ~100ms+ window. Fixed by adopting the same
            // pre-claim pattern as every other fresh-start path.
            forceReleaseFade();
            const preClaimedId = preClaimFadeForFreshStart();
            await playWithRamp(preClaimedId, () => withTimeout(doNativeSkip(), 5000));
            return;
        }

        const id = claimFade();
        const dur = await getSkipRamp();
        // For the plain (non-crossfade) skip fade-out phase — the
        // crossfade branch above sets its own expected duration and
        // returns before ever reaching here.
        skipLockExpectedDurationMs = dur * 1000;
        try { await AudioEngine.setVolume(1); } catch { }
        if (dur > 0.05 && !(await isTooShortToRamp(dur))) {
            await fadeVol(1, 0, dur, id);
        }
        // isFadeOwner can go false here if something else stole the fade
        // lock mid-fade-out (another skip, a fresh-start reset) — abort
        // silently rather than continuing on with a fade that's no longer
        // this call's to finish. Pause no longer does this (see
        // pauseWithRamp's comment) — it queues behind skipLock instead, so
        // it can't land here anymore.
        if (!isFadeOwner(id)) return;

        try {
            await withTimeout(doNativeSkip(), 5000);
        } catch {
            try { await AudioEngine.setVolume(1); } catch { }
            releaseFade(id);
            return;
        }

        // Real bug found here: this called waitForPlaying() but never
        // looked at what it returned, then unconditionally ran the full
        // ramp-in regardless. playWithRamp (above) already had to fix this
        // exact class of bug for its own ramp-in — waitForPlaying can
        // legitimately time out (audio not CONFIRMED playing yet, plausible
        // right after a skip while the next file is still loading) without
        // meaning playback never started; it often starts a moment later.
        // Running the full ramp-in regardless means it can finish climbing
        // to full volume BEFORE there's anything audible for it to apply
        // to — so the instant sound actually starts, it's already at full
        // volume. That reads exactly like "skip just jumps straight to the
        // full-volume song," not like a ramp that happened too fast to
        // notice — because audibly, no ramp happened at all. This mirrors
        // playWithRamp's fix: check the result, and if it timed out, do a
        // short catch-up fade instead of the full configured duration
        // rather than either a hard cut or an unramped full-length wait.
        const reallyPlaying = await waitForPlaying();
        if (!isFadeOwner(id)) return;

        if (dur > 0.05 && !(await isTooShortToRamp(dur))) {
            // Sets rampInActive same as playWithRamp's own ramp-in does —
            // no longer for pauseWithRamp's benefit (see its comment), but
            // this is also what skipWithRamp's own halfway-aware
            // second-skip check (above, near skipLock) reads to tell
            // "already committed to the incoming track" from "barely
            // started".
            rampInActive = true;
            try {
                if (!reallyPlaying) {
                    await fadeVol(0, 1, Math.min(0.4, dur), id);
                    try { await AudioEngine.setVolume(1); } catch { }
                } else {
                    try { await AudioEngine.setVolume(0); } catch { }
                    try { await AudioEngine.play(); } catch { }
                    // Same settle margin as playWithRamp's ramp-in, and for
                    // the same reason — see its comment. State.Playing (what
                    // waitForPlaying just confirmed) can fire slightly ahead
                    // of audio actually reaching the speaker.
                    await sleep(320);
                    await fadeVol(0, 1, dur, id);
                }
            } finally {
                rampInActive = false;
            }
        } else {
            try { await AudioEngine.setVolume(1); } catch { }
            try { await AudioEngine.play(); } catch { }
        }
        releaseFade(id);
    } finally {
        await sleep(80);
        skipLock = false;
        drainPending();
    }
}

export async function PlaybackService() {
    AudioEngine.addEventListener(Event.RemotePause, () => pauseWithRamp());
    AudioEngine.addEventListener(Event.RemotePlay, () => playWithRamp());
    AudioEngine.addEventListener(Event.RemoteStop, () => { stopWatcher(); AudioEngine.stop(); });
    AudioEngine.addEventListener(Event.RemoteNext, () => skipWithRamp('next'));
    AudioEngine.addEventListener(Event.RemotePrevious, () => skipWithRamp('prev'));
    // Lock screen / Control Center scrubber — see AudioEngine.swift's
    // changePlaybackPositionCommand comment for why this was silently
    // inert before (the command was never registered natively, not a JS
    // issue). Routes through the same seekTo() the in-app progress bar
    // already uses rather than a separate remote-seek code path.
    AudioEngine.addEventListener(Event.RemoteSeek, ({ position }) => {
        AudioEngine.seekTo(position).catch(() => { });
    });

    // Not an RNTP event — this module's own addition (see AudioEngine.js's
    // comment on it). A real interruption (call, Siri, another app) should
    // duck out the same way a manual pause tap does, not cut dead — so
    // this reuses the exact same ramp path rather than a hard pause.
    AudioEngine.addEventListener(Event.AudioInterruptionBegan, () => pauseWithRamp());

    AudioEngine.addEventListener(Event.PlaybackState, ({ state }) => {
        if (state === State.Playing) startWatcher();
        else if (state === State.Paused || state === State.Stopped) stopWatcher();
    });

    AudioEngine.addEventListener(Event.PlaybackTrackChanged, async ({ nextTrack }) => {
        if (nextTrack === null || nextTrack === undefined) {
            if (naturalEndFadeOwner !== null) { releaseFade(naturalEndFadeOwner); naturalEndFadeOwner = null; }
            // AudioEngine.reset() (the first half of primeNativeQueue, used
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
                try { await AudioEngine.setVolume(1); } catch { }
            }
            return;
        }
        if (naturalEndFadeOwner !== null && isFadeOwner(naturalEndFadeOwner)) {
            const id = naturalEndFadeOwner;
            naturalEndFadeOwner = null;
            try { await AudioEngine.setVolume(0); } catch { }
            const ramp = await getEndOfTrackRamp();
            if (ramp > 0.05 && !(await isTooShortToRamp(ramp))) {
                // Same issue as playWithRamp had: waitForPlaying's result
                // was never checked, so if it timed out (audio not
                // confirmed playing within the timeout — plausible right
                // after a natural track change, loading the next file), the
                // ramp still started anyway. It fading partway against
                // silence/buffering, then something else (the very next
                // event, or this same handler firing again) setting volume
                // outright, is exactly what "starts quiet then jumps" would
                // sound like — a real ramp that got cut short, not a
                // missing one. The timeout itself was 800ms, notably
                // tighter than playWithRamp's 2500ms default for what's
                // fundamentally the same "confirm real playback before
                // ramping" check — under any load, that's tight enough to
                // false-negative into skipping the ramp (and the audio
                // actually starting a moment later, unramped) more than
                // occasionally, which reads exactly like "sometimes doesn't
                // ramp in" plus a small silent gap right before it.
                const reallyPlaying = await waitForPlaying(1800);
                if (!reallyPlaying) {
                    try { await AudioEngine.setVolume(1); } catch { }
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
                try { await AudioEngine.setVolume(1); } catch { }
            }
            releaseFade(id);
        } else if (activeFadeId === null) {
            // Real bug found here: this used to unconditionally force
            // volume to 1 on every track change with no active JS fade —
            // which includes every crossfade completion, since crossfade is
            // entirely native-side and was never something this JS branch
            // knew to check for. Native had already ramped the incoming
            // track's volume to the correct target smoothly, over the
            // whole crossfade duration; this then immediately snapped it to
            // flat 1 the instant the completion event arrived — audible as
            // a real ramp cut off by an abrupt jump, not a smooth
            // continuation, even on the rare occasion "1" happened to
            // already be the right target. Crossfade owns this transition's
            // volume start to finish; JS has no business touching it here.
            //
            // This listener can't tell WHICH trigger caused the track
            // change (manual skip vs. the native lead-in timer firing for
            // a natural end — see AudioEngine.swift's
            // scheduleCrossfadeLeadIn), so it used to independently
            // re-check both durations itself rather than know which one
            // applied. Reads the shared snapshot instead now (see
            // currentTransitionCrossfading's comment up top) — the same
            // decision whichever of checkRampWindow/skipWithRamp actually
            // kicked this transition off already made, not a fresh
            // independent read that could disagree with it if the setting
            // changed in the meantime.
            if (!currentTransitionCrossfading) {
                try { await AudioEngine.setVolume(1); } catch { }
            }
        }
        startWatcher();
        drainPending();
    });
}
