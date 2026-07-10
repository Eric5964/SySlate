import TrackPlayer, { Event, State } from 'react-native-track-player';
import { getCrossfade, getSkipCrossfade, getAudioRamp, getRampOnPause } from '../utils/storage';

let isFading = false;
let naturalEndFade = false;
let abortFade = false;
let checker = null;

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

function startChecker() {
    if (checker) return;
    checker = setInterval(async () => {
        if (isFading) return;
        try {
            const cf = await getCrossfade();
            if (cf <= 0) return;
            const { position, duration } = await TrackPlayer.getProgress();
            if (!duration || duration < 1) return;
            const remaining = duration - position;
            if (remaining > 0.2 && remaining <= cf) {
                isFading = true; naturalEndFade = true; abortFade = false;
                await fadeVol(1, 0, Math.max(0.2, remaining - 0.15));
            }
        } catch { }
    }, 250);
}

function stopChecker() {
    if (checker) { clearInterval(checker); checker = null; }
}

export async function playWithRamp() {
    const ramp = await getAudioRamp();
    if (ramp > 0.05) {
        try { await TrackPlayer.setVolume(0); } catch { }
        try { await TrackPlayer.play(); } catch { }
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

export async function skipWithCrossfade(direction = 'next') {
    abortFade = true;
    isFading = false;
    naturalEndFade = false;
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
    // Wait briefly for new track to buffer before ramping in
    await sleep(250);
    abortFade = false;
    await playWithRamp();
}

export async function PlaybackService() {
    TrackPlayer.addEventListener(Event.RemotePause, () => pauseWithRamp());
    TrackPlayer.addEventListener(Event.RemotePlay, () => playWithRamp());
    TrackPlayer.addEventListener(Event.RemoteStop, () => { stopChecker(); TrackPlayer.stop(); });
    TrackPlayer.addEventListener(Event.RemoteNext, () => skipWithCrossfade('next'));
    TrackPlayer.addEventListener(Event.RemotePrevious, () => skipWithCrossfade('prev'));

    TrackPlayer.addEventListener(Event.PlaybackState, ({ state }) => {
        if (state === State.Playing) startChecker();
        else if (state === State.Paused || state === State.Stopped) stopChecker();
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
            await sleep(60);
            const cf = await getCrossfade();
            abortFade = false;
            if (cf > 0.05) await fadeVol(0, 1, Math.min(cf * 0.6, 1.4));
            else try { await TrackPlayer.setVolume(1); } catch { }
        } else if (!isFading) {
            naturalEndFade = false;
            try { await TrackPlayer.setVolume(1); } catch { }
        }
        isFading = false; abortFade = false;
    });
}