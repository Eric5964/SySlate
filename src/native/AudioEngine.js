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

    add: (tracks, insertBeforeIndex = null) => NativeAudioEngine.add(tracks, insertBeforeIndex),
    remove: (ids) => NativeAudioEngine.remove(ids),
    removeUpcomingTracks: () => NativeAudioEngine.removeUpcomingTracks(),
    skip: (id) => NativeAudioEngine.skip(id),
    skipToNext: () => NativeAudioEngine.skipToNext(),
    skipToPrevious: () => NativeAudioEngine.skipToPrevious(),
    getQueue: () => NativeAudioEngine.getQueue(),
    getCurrentTrack: () => NativeAudioEngine.getCurrentTrack(),
    reset: () => NativeAudioEngine.reset(),
    updateMetadataForTrack: (id, metadata) => NativeAudioEngine.updateMetadataForTrack(id, metadata),

    play: () => NativeAudioEngine.play(),
    pause: () => NativeAudioEngine.pause(),
    stop: () => NativeAudioEngine.stop(),
    seekTo: (seconds) => NativeAudioEngine.seekTo(seconds),
    setVolume: (volume) => NativeAudioEngine.setVolume(volume),
    getVolume: () => NativeAudioEngine.getVolume(),
    getProgress: () => NativeAudioEngine.getProgress(),
    getState: () => NativeAudioEngine.getState(),
    setRepeatMode: (mode) => NativeAudioEngine.setRepeatMode(mode),

    addEventListener,
};

export default AudioEngine;
