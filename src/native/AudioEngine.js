// Thin wrapper around the native AudioEngine module (see
// ios/AudioEngine.swift), shaped to mirror react-native-track-player's
// surface as closely as reasonable so PlaybackService.js/
// PlaybackContext.js can eventually swap their `import TrackPlayer, {
// Event, State, RepeatMode } from 'react-native-track-player'` for
// `import AudioEngine, { Event, State, RepeatMode } from
// '../native/AudioEngine'` with minimal call-site changes.
//
// Not wired into PlaybackService.js/PlaybackContext.js yet on purpose —
// those files are shared with the other in-progress chat, per the
// original handoff doc's boundary note. This file exists standalone
// until you're ready to do that swap deliberately.

import { NativeModules, NativeEventEmitter } from 'react-native';
import { useEffect, useRef, useState } from 'react';

const { AudioEngine: NativeAudioEngine } = NativeModules;
const emitter = new NativeEventEmitter(NativeAudioEngine);

export const Event = {
    PlaybackState: 'PlaybackState',
    PlaybackTrackChanged: 'PlaybackTrackChanged',
    PlaybackProgressUpdated: 'PlaybackProgressUpdated',
    RemotePlay: 'RemotePlay',
    RemotePause: 'RemotePause',
    RemoteStop: 'RemoteStop',
    RemoteNext: 'RemoteNext',
    RemotePrevious: 'RemotePrevious',
    // New vs. RNTP — see decision #2 in the spec doc. JS's existing
    // pause-with-ramp function should be called from these, same as it's
    // called on a manual pause tap, so interruptions fade out instead of
    // cutting or (worse) doing nothing until the interruption clears.
    AudioInterruptionBegan: 'AudioInterruptionBegan',
    AudioInterruptionEnded: 'AudioInterruptionEnded',
};

export const State = {
    None: 'none',
    Ready: 'ready',
    Playing: 'playing',
    Paused: 'paused',
    Stopped: 'stopped',
    Buffering: 'buffering',
    Ended: 'ended',
};

export const RepeatMode = {
    Off: 0,
    Track: 1,
    Queue: 2,
};

// Capability is accepted by updateOptions for call-site compatibility but
// not yet selectively enforced — see the comment in
// AudioEngine.swift's updateOptions. Kept here so existing call sites
// (`capabilities: [Capability.Play, ...]`) don't need to change at all
// when the import is swapped.
export const Capability = {
    Play: 'play',
    Pause: 'pause',
    Stop: 'stop',
    SkipToNext: 'skipToNext',
    SkipToPrevious: 'skipToPrevious',
};

function addEventListener(event, handler) {
    return emitter.addListener(event, handler);
}

const AudioEngine = {
    setupPlayer: (options = {}) => NativeAudioEngine.setupPlayer(options),
    updateOptions: (options = {}) => NativeAudioEngine.updateOptions(options),

    add: (tracks, insertBeforeIndex = null) => NativeAudioEngine.add(Array.isArray(tracks) ? tracks : [tracks], insertBeforeIndex),
    // index-based (a single index, or an array of them), matching RNTP —
    // NOT ids. See AudioEngine.swift's comment on remove() for why: every
    // existing PlaybackContext.js call site already passes an index, and
    // id-based matching breaks for a song genuinely queued more than once.
    remove: (indexes) => NativeAudioEngine.remove(Array.isArray(indexes) ? indexes : [indexes]),
    removeUpcomingTracks: () => NativeAudioEngine.removeUpcomingTracks(),
    skip: (index) => NativeAudioEngine.skip(index),
    skipToNext: () => NativeAudioEngine.skipToNext(),
    skipToPrevious: () => NativeAudioEngine.skipToPrevious(),
    getQueue: () => NativeAudioEngine.getQueue(),
    // Returns the queue INDEX, matching RNTP's real getCurrentTrack() —
    // not the track's id. PlaybackContext.js does arithmetic on this value
    // directly everywhere, so this has to stay a number.
    getCurrentTrack: () => NativeAudioEngine.getCurrentTrack(),
    // No dedicated native method — the native side only has getQueue(),
    // so this derives a single track from it. Matches RNTP's real
    // getTrack(index) contract: PlaybackContext.js's PlaybackTrackChanged
    // listener calls this with the index the event just gave it and
    // treats a missing/undefined result as "not loaded yet, retry
    // shortly" (see its 80ms-retry block) — an out-of-range index here
    // correctly resolves to undefined for that same reason, not an error.
    getTrack: async (index) => {
        const queue = await NativeAudioEngine.getQueue();
        return queue[index];
    },
    reset: () => NativeAudioEngine.reset(),
    // index-based, matching RNTP's real updateMetadataForTrack(index, ...)
    updateMetadataForTrack: (index, metadata) => NativeAudioEngine.updateMetadataForTrack(index, metadata),

    play: () => NativeAudioEngine.play(),
    pause: () => NativeAudioEngine.pause(),
    stop: () => NativeAudioEngine.stop(),
    seekTo: (seconds) => NativeAudioEngine.seekTo(seconds),
    setVolume: (volume) => NativeAudioEngine.setVolume(volume),
    getVolume: () => NativeAudioEngine.getVolume(),
    getProgress: () => NativeAudioEngine.getProgress(),
    getState: () => NativeAudioEngine.getState(),
    setRepeatMode: (mode) => NativeAudioEngine.setRepeatMode(mode),
    setEQBands: (bands) => NativeAudioEngine.setEQBands(bands),
    // Split from one "Volume Normalization" toggle into two distinct
    // features: setWithinTrackNormEnabled is the original per-track
    // dynamics compressor; setBetweenTrackNormEnabled is the new sampled
    // loudness-matching gain across tracks. setSilenceTrimEnabled is also
    // new — leading/trailing silence trim on a track's natural start/end.
    setWithinTrackNormEnabled: (enabled) => NativeAudioEngine.setWithinTrackNormEnabled(enabled),
    setBetweenTrackNormEnabled: (enabled) => NativeAudioEngine.setBetweenTrackNormEnabled(enabled),
    setSilenceTrimEnabled: (enabled) => NativeAudioEngine.setSilenceTrimEnabled(enabled),
    setCrossfadeEnabled: (enabled) => NativeAudioEngine.setCrossfadeEnabled(enabled),
    setCrossfadeDuration: (seconds) => NativeAudioEngine.setCrossfadeDuration(seconds),

    addEventListener,
};

export default AudioEngine;

// Matches RNTP's real useProgress(updateInterval): plain JS polling of
// getProgress() on the given interval (ms), independent of any native
// event — same behavior the app was already built around (see
// PlayerScreen.js's own note about "useProgress hasn't ticked yet since
// mount/track-change" — that's this polling, not push-based).
export function useProgress(updateInterval = 1000) {
    const [progress, setProgress] = useState({ position: 0, duration: 0, buffered: 0 });
    useEffect(() => {
        let cancelled = false;
        const tick = () => {
            NativeAudioEngine.getProgress().then(p => { if (!cancelled) setProgress(p); }).catch(() => { });
        };
        tick();
        const id = setInterval(tick, updateInterval);
        return () => { cancelled = true; clearInterval(id); };
    }, [updateInterval]);
    return progress;
}

// Matches RNTP's real usePlaybackState(): initial value from getState(),
// live-updated via the PlaybackState event. getState() resolves the bare
// state string; the event body is already { state } (see AudioEngine.swift's
// setState), so both paths are normalized to the same { state } shape here.
export function usePlaybackState() {
    const [playbackState, setPlaybackState] = useState({ state: State.None });
    useEffect(() => {
        let cancelled = false;
        NativeAudioEngine.getState().then(state => { if (!cancelled) setPlaybackState({ state }); }).catch(() => { });
        const sub = addEventListener(Event.PlaybackState, ({ state }) => setPlaybackState({ state }));
        return () => { cancelled = true; sub.remove(); };
    }, []);
    return playbackState;
}
