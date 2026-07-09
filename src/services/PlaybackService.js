import TrackPlayer, { Event } from 'react-native-track-player';
import { getCrossfade, getSkipCrossfade, getAudioRamp } from '../utils/storage';

let isFading = false;
let naturalEndFade = false;

async function fadeVol(from, to, durationSec) {
    if (durationSec <= 0) {
        try { await TrackPlayer.setVolume(Math.max(0, Math.min(1, to))); } catch { }
        return;
    }
    const STEPS = Math.max(8, Math.ceil(durationSec * 25));
    const stepTime = (durationSec * 1000) / STEPS;
    for (let i = 1; i <= STEPS; i++) {
        const v = from + (to - from) * (i / STEPS);
        try { await TrackPlayer.setVolume(Math.max(0, Math.min(1, v))); } catch { return; }
        await new Promise(r => setTimeout(r, stepTime));
    }
}

export async function playWithRamp() {
    const ramp = await getAudioRamp();
    if (ramp > 0) {
        try { await TrackPlayer.setVolume(0); } catch { }
        try { await TrackPlayer.play(); } catch { }
        await fadeVol(0, 1, ramp);
    } else {
        try { await TrackPlayer.setVolume(1); } catch { }
        try { await TrackPlayer.play(); } catch { }
    }
}

export async function skipWithCrossfade(direction = 'next') {
    isFading = false;
    naturalEndFade = false;
    const dur = await getSkipCrossfade();
    try { await TrackPlayer.setVolume(1); } catch { }
    if (dur > 0) await fadeVol(1, 0, dur);
    try {
        if (direction === 'next') await TrackPlayer.skipToNext();
        else await TrackPlayer.skipToPrevious();
        await new Promise(r => setTimeout(r, 120));
    } catch {
        try { await TrackPlayer.setVolume(1); } catch { }
        return;
    }
    await playWithRamp();
}

export async function PlaybackService() {
    TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
    TrackPlayer.addEventListener(Event.RemotePlay, () => playWithRamp());
    TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());
    TrackPlayer.addEventListener(Event.RemoteNext, () => skipWithCrossfade('next'));
    TrackPlayer.addEventListener(Event.RemotePrevious, () => skipWithCrossfade('prev'));

    TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, async ({ position, duration }) => {
        if (!duration || isFading) return;
        const cf = await getCrossfade();
        if (cf <= 0) return;
        const remaining = duration - position;
        // Start fade when within the crossfade window but not too close to end
        if (remaining > 0.15 && remaining <= cf) {
            isFading = true;
            naturalEndFade = true;
            await fadeVol(1, 0, remaining - 0.1);
        }
    });

    TrackPlayer.addEventListener(Event.PlaybackTrackChanged, async ({ nextTrack }) => {
        if (nextTrack === null || nextTrack === undefined) {
            isFading = false; naturalEndFade = false;
            return;
        }
        if (naturalEndFade) {
            naturalEndFade = false;
            const cf = await getCrossfade();
            if (cf > 0) {
                try { await TrackPlayer.setVolume(0); } catch { }
                await fadeVol(0, 1, Math.min(cf * 0.7, 1.5));
            } else {
                try { await TrackPlayer.setVolume(1); } catch { }
            }
        } else if (!isFading) {
            try { await TrackPlayer.setVolume(1); } catch { }
        }
        isFading = false;
    });
}