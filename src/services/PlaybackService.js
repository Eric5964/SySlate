import TrackPlayer, { Event } from 'react-native-track-player';
import { getCrossfade, getSkipCrossfade } from '../utils/storage';

let fadeTimer = null;
let isFadingOut = false;

function clearFade() {
  if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
  isFadingOut = false;
}

function fadeVolume(from, to, durationSec) {
  const STEPS = 20;
  const interval = (durationSec * 1000) / STEPS;
  let step = 0;
  return new Promise(resolve => {
    fadeTimer = setInterval(async () => {
      step++;
      const vol = Math.max(0, Math.min(1, from + (to - from) * (step / STEPS)));
      try { await TrackPlayer.setVolume(vol); } catch {}
      if (step >= STEPS) { clearInterval(fadeTimer); fadeTimer = null; resolve(); }
    }, interval);
  });
}

export async function skipWithCrossfade(direction = 'next') {
  clearFade();
  const dur = await getSkipCrossfade();
  if (dur > 0) await fadeVolume(1, 0, dur);
  try {
    if (direction === 'next') await TrackPlayer.skipToNext();
    else await TrackPlayer.skipToPrevious();
  } catch {}
  if (dur > 0) { await TrackPlayer.setVolume(0); fadeVolume(0, 1, dur); }
}

export async function PlaybackService() {
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemotePlay,  () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemoteStop,  () => TrackPlayer.stop());
  TrackPlayer.addEventListener(Event.RemoteNext,     () => skipWithCrossfade('next'));
  TrackPlayer.addEventListener(Event.RemotePrevious, () => skipWithCrossfade('prev'));

  TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, async ({ position, duration }) => {
    if (!duration || isFadingOut) return;
    const cf = await getCrossfade();
    if (cf <= 0) return;
    const remaining = duration - position;
    if (remaining > 0 && remaining <= cf) {
      isFadingOut = true;
      clearFade();
      await fadeVolume(1, 0, remaining);
    }
  });

  TrackPlayer.addEventListener(Event.PlaybackTrackChanged, async ({ nextTrack }) => {
    clearFade();
    if (nextTrack === null || nextTrack === undefined) return;
    const cf = await getCrossfade();
    if (cf > 0) { await TrackPlayer.setVolume(0); fadeVolume(0, 1, cf); }
    else { await TrackPlayer.setVolume(1); }
  });
}