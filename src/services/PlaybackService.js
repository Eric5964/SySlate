import TrackPlayer, { Event, State } from 'react-native-track-player';
import { getCrossfade, getSkipCrossfade, getAudioRamp, getRampOnPause } from '../utils/storage';

let isFading = false;
let naturalEndFade = false;
let abortFade = false;
let skipLock = false;
let rampLock = false;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fadeVol(from, to, sec) {
    if (sec <= 0.05) { try { await TrackPlayer.setVolume(to); } catch { } return; }
    const STEPS = Math.max(8, Math.round(sec * 20));
    const dt = (sec * 1000) / STEPS;
    for (let i = 1; i <= STEPS; i++) {
        if (abortFade) return;
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
// Two layers, deliberately redundant, because relying on a single native
// event turned out to miss the window sometimes (natural crossfade would
// silently never fire): a tight event-driven listener for the common case,
// plus a coarser interval-based safety net that double-checks independently.
let progressSub = null;
let fallbackTimer = null;

async function checkCrossfadeWindow(position, duration) {
    if (isFading) return;
    try {
        const cf = await getCrossfade();
        if (cf <= 0 || !duration || duration < 1) return;
        const remaining = duration - position;
        if (remaining > 0.15 && remaining <= cf) {
            isFading = true; naturalEndFade = true; abortFade = false;
            await fadeVol(1, 0, Math.max(0.15, remaining - 0.1));
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
        if (ramp > 0.05) {
            try { await TrackPlayer.setVolume(0); } catch { }
            try { await TrackPlayer.play(); } catch { }
            await waitForPlaying();
            abortFade = false;
            await fadeVol(0, 1, ramp);
        } else {
            try { await TrackPlayer.setVolume(1); } catch { }
            try { await TrackPlayer.play(); } catch { }
        }
        startWatcher(); // belt-and-suspenders: don't rely solely on the PlaybackState event
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
        if (useFade && ramp > 0.05) {
            abortFade = false;
            await fadeVol(1, 0, ramp * 0.5);
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

// Skip with crossfade — one duration setting now governs BOTH the fade-out
// of the outgoing track and the fade-in of the incoming one (previously the
// fade-in silently used the separate "Audio Ramp" setting instead, which is
// why the start of a skipped-to song often didn't fade at all). Waits for
// the new track to actually be playing before fading in, and a short lock
// ignores rapid repeated taps so spamming skip can't stack overlapping fades.
export async function skipWithCrossfade(direction = 'next') {
    if (skipLock) return;
    skipLock = true;
    abortFade = true;
    isFading = false;
    naturalEndFade = false;
    try {
        const dur = await getSkipCrossfade();
        try { await TrackPlayer.setVolume(1); } catch { }
        if (dur > 0.05) {
            abortFade = false;
            await fadeVol(1, 0, dur);
        }
        try {
            if (direction === 'next') await TrackPlayer.skipToNext();
            else await TrackPlayer.skipToPrevious();
        } catch {
            try { await TrackPlayer.setVolume(1); } catch { }
            abortFade = false;
            return;
        }
        await waitForPlaying();
        abortFade = false;
        if (dur > 0.05) {
            try { await TrackPlayer.setVolume(0); } catch { }
            try { await TrackPlayer.play(); } catch { }
            await fadeVol(0, 1, dur);
        } else {
            try { await TrackPlayer.setVolume(1); } catch { }
            try { await TrackPlayer.play(); } catch { }
        }
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
            isFading = false; naturalEndFade = false; abortFade = false;
            try { await TrackPlayer.setVolume(1); } catch { }
            return;
        }
        if (naturalEndFade && !abortFade) {
            naturalEndFade = false; isFading = false;
            try { await TrackPlayer.setVolume(0); } catch { }
            const cf = await getCrossfade();
            abortFade = false;
            if (cf > 0.05) {
                await waitForPlaying(800);
                await fadeVol(0, 1, Math.min(cf, 2.5));
            } else {
                try { await TrackPlayer.setVolume(1); } catch { }
            }
        } else if (!isFading) {
            naturalEndFade = false;
            try { await TrackPlayer.setVolume(1); } catch { }
        }
        isFading = false; abortFade = false;
        startWatcher();
    });
}
