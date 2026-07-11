import TrackPlayer, { Event, State } from 'react-native-track-player';
import { getCrossfade, getSkipCrossfade, getAudioRamp, getRampOnPause } from '../utils/storage';

let isFading = false;
let naturalEndFade = false;
let abortFade = false;
let skipLock = false;

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

// Wait for the player to actually be buffered and playing (instead of a fixed
// sleep) before we start ramping volume in. This is what was causing the
// "wavy"/stuttering start after a skip — the fade was running against a
// track that hadn't finished buffering yet.
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

// Event-driven end-of-track watcher — replaces the old setInterval + getProgress()
// polling loop, which drifted enough near the end of a track to sometimes miss
// the crossfade window entirely.
let progressSub = null;
function startWatcher() {
    if (progressSub) return;
    progressSub = TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, async ({ position, duration }) => {
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
    });
}

function stopWatcher() {
    if (progressSub) { progressSub.remove(); progressSub = null; }
}

export async function playWithRamp() {
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
}

export async function pauseWithRamp() {
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
}

// Skip with crossfade — fades the outgoing track out, waits for the new
// track to actually be playing (not a fixed delay), then fades it in. A
// short lock ignores rapid repeated taps so spamming skip can't stack
// overlapping fade loops and glitch the audio.
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
        await playWithRamp();
    } finally {
        // small cooldown after the transition settles, not the whole fade duration
        await sleep(180);
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
            // Both directions of the crossfade now happen back-to-back with no
            // artificial gap: volume is already at (or heading to) 0 from the
            // outgoing track's fade, so the incoming track's fade-in starts
            // the instant this event fires.
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
    });
}