import TrackPlayer, { Event, State } from 'react-native-track-player';
import { getCrossfade, getSkipCrossfade, getAudioRamp, getRampOnPause } from '../utils/storage';

// --- Fade ownership -----------------------------------------------------
// Exactly one fade transition (natural end-of-track, or a manual skip) is
// allowed to be "in control" at a time. Whichever claims the lock first runs
// to completion untouched; anything else that would have started a
// competing fade during that window backs off instead of fighting it —
// that fighting (two things calling setVolume/state at once) was the source
// of the glitchy/cut-short audio when skipping right as a natural crossfade
// was starting, or seeking into the crossfade window.
let fadeCounter = 0;
let activeFadeId = null;
let naturalEndFadeOwner = null;
let skipLock = false;
let rampLock = false;

const claimFade = () => { activeFadeId = ++fadeCounter; return activeFadeId; };
const isFadeOwner = (id) => activeFadeId === id;
const releaseFade = (id) => { if (activeFadeId === id) activeFadeId = null; };

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fadeVol(from, to, sec, ownerId) {
    if (sec <= 0.05) { if (isFadeOwner(ownerId)) { try { await TrackPlayer.setVolume(to); } catch { } } return; }
    const STEPS = Math.max(8, Math.round(sec * 20));
    const dt = (sec * 1000) / STEPS;
    for (let i = 1; i <= STEPS; i++) {
        if (!isFadeOwner(ownerId)) return; // invalidated — someone else owns the transition now
        try { await TrackPlayer.setVolume(Math.max(0, Math.min(1, from + (to - from) * (i / STEPS)))); } catch { return; }
        if (i < STEPS) await sleep(dt);
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
    if (activeFadeId !== null) return; // something already owns a fade transition
    try {
        const cf = await getCrossfade();
        if (cf <= 0 || !duration || duration < 1) return;
        const remaining = duration - position;
        if (remaining > 0.15 && remaining <= cf) {
            const id = claimFade();
            naturalEndFadeOwner = id;
            // Wider safety margin (was 0.1s) so our fade reliably finishes
            // BEFORE native auto-advance fires — too tight a margin was the
            // cause of the fade racing the actual track end and cutting the
            // song short, especially right after a seek landed inside the
            // crossfade window.
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

export async function playWithRamp() {
    if (rampLock) return;
    rampLock = true;
    try {
        const ramp = await getAudioRamp();
        if (ramp > 0.05 && activeFadeId === null) {
            const id = claimFade();
            try { await TrackPlayer.setVolume(0); } catch { }
            try { await TrackPlayer.play(); } catch { }
            await waitForPlaying();
            await fadeVol(0, 1, ramp, id);
            releaseFade(id);
        } else {
            try { await TrackPlayer.setVolume(1); } catch { }
            try { await TrackPlayer.play(); } catch { }
        }
        startWatcher();
    } finally {
        await sleep(60);
        rampLock = false;
    }
}

export async function pauseWithRamp() {
    if (rampLock) return;
    rampLock = true;
    try {
        const useFade = await getRampOnPause();
        const ramp = await getAudioRamp();
        if (useFade && ramp > 0.05 && activeFadeId === null) {
            const id = claimFade();
            await fadeVol(1, 0, ramp * 0.5, id);
            releaseFade(id);
            try { await TrackPlayer.pause(); } catch { }
            try { await TrackPlayer.setVolume(1); } catch { }
        } else {
            try { await TrackPlayer.pause(); } catch { }
        }
    } finally {
        await sleep(60);
        rampLock = false;
    }
}

// Skip with crossfade. If a natural crossfade is already in flight when you
// hit skip, we deliberately don't fight it — the skip goes through as a
// plain, un-faded skip and lets the already-running fade own the transition,
// since it claimed the lock first.
export async function skipWithCrossfade(direction = 'next') {
    if (skipLock) return;
    skipLock = true;
    try {
        if (activeFadeId !== null) {
            try {
                if (direction === 'next') await TrackPlayer.skipToNext();
                else await TrackPlayer.skipToPrevious();
            } catch { }
            return;
        }

        const id = claimFade();
        const dur = await getSkipCrossfade();
        try { await TrackPlayer.setVolume(1); } catch { }
        if (dur > 0.05) await fadeVol(1, 0, dur, id);
        if (!isFadeOwner(id)) return;

        try {
            if (direction === 'next') await TrackPlayer.skipToNext();
            else await TrackPlayer.skipToPrevious();
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
                await waitForPlaying(800);
                if (isFadeOwner(id)) await fadeVol(0, 1, Math.min(cf, 2.5), id);
            } else {
                try { await TrackPlayer.setVolume(1); } catch { }
            }
            releaseFade(id);
        } else if (activeFadeId === null) {
            try { await TrackPlayer.setVolume(1); } catch { }
        }
        startWatcher();
    });
}
