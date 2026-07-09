import TrackPlayer, { Event } from 'react-native-track-player';
import { getCrossfade, getSkipCrossfade } from '../utils/storage';

let isFading = false;
let naturalCrossfadeDone = false;

async function fadeVol(from, to, durationSec) {
    const STEPS = 20;
    const stepTime = Math.max(20, (durationSec * 1000) / STEPS);
    for (let i = 0; i <= STEPS; i++) {
        const v = from + (to - from) * (i / STEPS);
        try { await TrackPlayer.setVolume(Math.max(0, Math.min(1, v))); } catch { return; }
        if (i < STEPS) await new Promise(r => setTimeout(r, stepTime));
    }
}

export async function skipWithCrossfade(direction = 'next') {
    isFading = false;
    const dur = await getSkipCrossfade();
    try { await TrackPlayer.setVolume(1); } catch { }
    if (dur > 0) await fadeVol(1, 0, dur);
    try {
        if (direction === 'next') await TrackPlayer.skipToNext();
        else await TrackPlayer.skipToPrevious();
        await new Promise(r => setTimeout(r, 80));
    } catch {
        try { await TrackPlayer.setVolume(1); } catch { }
        return;
    }
    if (dur > 0) await fadeVol(0, 1, Math.min(dur, 0.8));
    else try { await TrackPlayer.setVolume(1); } catch { }
}

export async function PlaybackService() {
    TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
    TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
    TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());
    TrackPlayer.addEventListener(Event.RemoteNext, () => skipWithCrossfade('next'));
    TrackPlayer.addEventListener(Event.RemotePrevious, () => skipWithCrossfade('prev'));

    TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, async ({ position, duration }) => {
        if (!duration || isFading) return;
        const cf = await getCrossfade();
        if (cf <= 0) return;
        const remaining = duration - position;
        if (remaining > 0 && remaining <= cf) {
            isFading = true;
            naturalCrossfadeDone = true;
            await fadeVol(1, 0, remaining);
        }
    });

    TrackPlayer.addEventListener(Event.PlaybackTrackChanged, async ({ nextTrack }) => {
        isFading = false;
        if (nextTrack === null || nextTrack === undefined) return;

        if (naturalCrossfadeDone) {
            // Natural end crossfade — fade in new track
            naturalCrossfadeDone = false;
            const cf = await getCrossfade();
            if (cf > 0) {
                await fadeVol(0, 1, Math.min(cf, 1.2));
                return;
            }
        }
        // Manual skip or first play — restore volume immediately
        try { await TrackPlayer.setVolume(1); } catch { }
    });
}