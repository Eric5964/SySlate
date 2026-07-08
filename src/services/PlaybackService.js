import TrackPlayer, { Event } from 'react-native-track-player';
import { getCrossfade, getSkipCrossfade } from '../utils/storage';

let isFading = false;

async function fadeVol(from, to, durationSec) {
    const STEPS = 15;
    const stepTime = Math.max(16, (durationSec * 1000) / STEPS);
    for (let i = 0; i <= STEPS; i++) {
        const v = from + (to - from) * (i / STEPS);
        try { await TrackPlayer.setVolume(Math.max(0, Math.min(1, v))); } catch { }
        await new Promise(r => setTimeout(r, stepTime));
    }
}

export async function skipWithCrossfade(direction = 'next') {
    const dur = await getSkipCrossfade();
    if (dur > 0) await fadeVol(1, 0, dur);
    try {
        if (direction === 'next') await TrackPlayer.skipToNext();
        else await TrackPlayer.skipToPrevious();
    } catch (e) {
        console.warn('Skip error:', e?.message);
        try { await TrackPlayer.setVolume(1); } catch { }
        return;
    }
    if (dur > 0) await fadeVol(0, 1, dur);
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
            await fadeVol(1, 0, remaining);
        }
    });

    TrackPlayer.addEventListener(Event.PlaybackTrackChanged, async ({ nextTrack }) => {
        isFading = false;
        if (nextTrack === null || nextTrack === undefined) return;
        const cf = await getCrossfade();
        if (cf > 0) await fadeVol(0, 1, Math.min(cf, 1.5));
        else try { await TrackPlayer.setVolume(1); } catch { }
    });
}