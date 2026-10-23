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

import { NativeModules, NativeEventEmitter, AppState } from 'react-native';
import { useEffect, useState } from 'react';

const { AudioEngine: NativeAudioEngine } = NativeModules;
const emitter = new NativeEventEmitter(NativeAudioEngine);
let useVolumeTags = true;

export const Event = {
    PlaybackState: 'PlaybackState',
    PlaybackTrackChanged: 'PlaybackTrackChanged',
    PlaybackProgressUpdated: 'PlaybackProgressUpdated',
    RemotePlay: 'RemotePlay',
    RemotePause: 'RemotePause',
    RemoteStop: 'RemoteStop',
    RemoteNext: 'RemoteNext',
    RemotePrevious: 'RemotePrevious',
    // Lock screen / Control Center scrubber drag — see
    // AudioEngine.swift's changePlaybackPositionCommand.
    RemoteSeek: 'RemoteSeek',
    // New vs. RNTP — see decision #2 in the spec doc. JS's existing
    // pause-with-ramp function should be called from these, same as it's
    // called on a manual pause tap, so interruptions fade out instead of
    // cutting or (worse) doing nothing until the interruption clears.
    AudioInterruptionBegan: 'AudioInterruptionBegan',
    AudioInterruptionEnded: 'AudioInterruptionEnded',
    // In-app debug log viewer — see utils/debugLog.js. Native's own
    // NSLog(...) calls (tagged [RAMP-DEBUG]/[SEEK-DEBUG] etc.) now also
    // fire this event, since NSLog alone is invisible without Xcode.
    DebugLog: 'DebugLog',
    // Eight loudness readings for the song-list visualizer, only sent while it is on.
    VizLevels: 'VizLevels',
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

    // "Use Volume Tags" (Settings): when off, the tag gain is not sent, so
    // Match Volume falls back to its own estimate.
    setUseVolumeTags: (on) => { useVolumeTags = !!on; },
    add: (tracks, insertBeforeIndex = null) => NativeAudioEngine.add((Array.isArray(tracks) ? tracks : [tracks]).map(t => (t && t.replayGainDb !== undefined && !useVolumeTags ? { ...t, replayGainDb: undefined } : t)), insertBeforeIndex),
    // index-based (a single index, or an array of them), matching RNTP —
    // NOT ids. See AudioEngine.swift's comment on remove() for why: every
    // existing PlaybackContext.js call site already passes an index, and
    // id-based matching breaks for a song genuinely queued more than once.
    remove: (indexes) => NativeAudioEngine.remove(Array.isArray(indexes) ? indexes : [indexes]),
    removeUpcomingTracks: () => NativeAudioEngine.removeUpcomingTracks(),
    skip: (index) => NativeAudioEngine.skip(index),
    // Directly triggers a crossfade, bypassing skip()'s own precondition
    // re-check (crossfadeEnabled/state/index-mismatch) against whatever
    // native's current state happens to be by the time the call lands —
    // see this method's comment in AudioEngine.swift for the race that
    // re-check opened up. Only for callers (primeQueueForTransition) that
    // have already confirmed a crossfade should apply themselves.
    crossfadeToIndex: (index, duration) => NativeAudioEngine.crossfadeToIndex(index, duration),
    setSuppressNextCrossfade: (v) => NativeAudioEngine.setSuppressNextCrossfade(v),
    // Loads a specific queue index without forcing playback — unlike
    // skip(), which always autoplays (see AudioEngine.swift's load() for
    // why this needed to be its own method). Used by restoreSession for a
    // cold-launch restore that shouldn't blast audio the instant the app
    // opens.
    load: (index, autoPlay) => NativeAudioEngine.load(index, autoPlay),
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
    // DJ disc: begin resolves true once scratch audio is ready.
    setPlaybackRate: (rate) => NativeAudioEngine.setPlaybackRate(rate),
    scratchBegin: () => NativeAudioEngine.scratchBegin(),
    scratchSetRate: (rate) => NativeAudioEngine.scratchSetRate(rate),
    scratchResumePlay: () => { try { NativeAudioEngine.scratchResumePlay(); } catch (e) { } },
    // Stereo width (0 to 2, 1 = as recorded) and balance (-1 left to 1 right, 0 = centre).
    setSpatial: (width, balance) => { try { NativeAudioEngine.setSpatial(width, balance); } catch (e) { } },
    setVisualizerEnabled: (on) => { try { NativeAudioEngine.setVisualizerEnabled(!!on); } catch (e) { } },
    scratchPrefetch: (on) => { try { NativeAudioEngine.scratchPrefetch(!!on); } catch (e) { } },
    scratchEnd: () => NativeAudioEngine.scratchEnd(),
    setVolume: (volume) => NativeAudioEngine.setVolume(volume),
    // Updates only the lock screen/Control Center's displayed play/pause
    // state — doesn't touch actual playback. Used to make the lock screen
    // say "paused" immediately when a ramp-out-on-pause starts, instead of
    // only once the real pause() lands seconds later once the fade
    // finishes (see AudioEngine.swift's setNowPlayingPaused for the full
    // story).
    setNowPlayingPaused: (paused) => NativeAudioEngine.setNowPlayingPaused(paused),
    makeThumbnail: (src, dest, maxPixel) => NativeAudioEngine.makeThumbnail(src, dest, maxPixel),
    getDurations: (urls) => NativeAudioEngine.getDurations(urls),
    importFolder: () => NativeAudioEngine.importFolder(),
    // Swaps queue entries for a newer copy of the same song (see AudioEngine.swift's replaceTracks).
    replaceTracks: (pairs) => NativeAudioEngine.replaceTracks(pairs),
    getSavedSnapshot: () => NativeAudioEngine.getSavedSnapshot(),
    getVolume: () => NativeAudioEngine.getVolume(),
    // Runs the whole from->to fade natively over one bridge call instead of
    // PlaybackService.js looping setVolume() ~25x/sec itself — see
    // AudioEngine.swift's rampVolume for why (bridge jitter under load was
    // reading as "cuts up and down"/delays in the ramp).
    rampVolume: (from, to, seconds) => NativeAudioEngine.rampVolume(from, to, seconds),
    cancelVolumeRamp: () => NativeAudioEngine.cancelVolumeRamp(),
    getProgress: () => NativeAudioEngine.getProgress(),
    getState: () => NativeAudioEngine.getState(),
    setRepeatMode: (mode) => NativeAudioEngine.setRepeatMode(mode),
    setEQBands: (bands) => NativeAudioEngine.setEQBands(bands),
    setPreAmp: (db) => NativeAudioEngine.setPreAmp(db),
    // Split from one "Volume Normalization" toggle into two distinct
    // features: setWithinTrackNormEnabled is the original per-track
    // dynamics compressor; setBetweenTrackNormEnabled is the new sampled
    // loudness-matching gain across tracks. setSilenceTrimEnabled is also
    // new — leading/trailing silence trim on a track's natural start/end.
    setWithinTrackNormEnabled: (enabled) => NativeAudioEngine.setWithinTrackNormEnabled(enabled),
    setBetweenTrackNormEnabled: (enabled) => NativeAudioEngine.setBetweenTrackNormEnabled(enabled),
    setSilenceTrimEnabled: (enabled) => NativeAudioEngine.setSilenceTrimEnabled(enabled),
    setCrossfadeEnabled: (enabled) => NativeAudioEngine.setCrossfadeEnabled(enabled),
    // Kept name — this is now specifically the "on skip" duration (see
    // AudioEngine.swift), the JS-facing name stays the same for backward
    // compatibility with the AsyncStorage key it's paired with.
    setCrossfadeDuration: (seconds) => NativeAudioEngine.setCrossfadeDuration(seconds),
    setCrossfadeDurationEndOfTrack: (seconds) => NativeAudioEngine.setCrossfadeDurationEndOfTrack(seconds),

    addEventListener,
};

export default AudioEngine;

// What the engine last said, kept at module level so a screen that mounts
// later (the Player opening) starts from the real state at once instead of
// from "nothing yet" for the first few frames. That empty start was why the
// DJ disc and the progress bar were late to start when the Player opened.
let lastPlaybackState = State.None;
let lastProgress = null;   // { position, duration, buffered, id, qid, at }
try {
    emitter.addListener(Event.PlaybackState, ({ state }) => { lastPlaybackState = state; });
    emitter.addListener(Event.PlaybackProgressUpdated, (p) => { if (p) lastProgress = { ...p, at: Date.now() }; });
    NativeAudioEngine.getState().then(state => { if (lastPlaybackState === State.None) lastPlaybackState = state; }).catch(() => { });
} catch { }

// A reading only counts for the song it describes. A reading that was taken
// just before a skip can arrive just after it (or just before the app has
// heard about a crossfade's halfway song change); native tags every reading
// with the song it belongs to. A reading for another song comes back flagged
// `stale: true` (position 0), and the progress bars IGNORE it instead of
// following it: following it made the bar drop to zero and back around every
// crossfade.
// Songs are compared by `id` (the file); the per-play `_qid` is only used when
// an id is missing. And "another song" has to be a passing thing: if native
// keeps naming the same other song for 2.5 s running, it is the app's idea of
// the current song that is out of date (e.g. after the app was restored), so
// the readings are accepted. (Before, a restored app could ignore every reading
// for good: the time stayed at 0:00 and the bar did not move.)
let otherSong = { key: '', since: 0 };
export function matchProgress(p, expectQid, fallbackDuration = 0, expectId) {
    if (!p) return { position: 0, duration: fallbackDuration || 0, buffered: 0 };
    let stale = false;
    if (p.id && expectId) stale = p.id !== expectId;
    else if (expectQid && p.qid) stale = p.qid !== expectQid;
    if (stale) {
        const key = `${p.id || ''}|${p.qid || ''}`;
        const now = Date.now();
        if (otherSong.key !== key) otherSong = { key, since: now };
        else if (now - otherSong.since > 2500) stale = false;
    } else {
        otherSong.key = '';
    }
    if (stale) return { position: 0, duration: fallbackDuration || 0, buffered: 0, stale: true };
    return p;
}

// Matches RNTP's real useProgress(updateInterval): plain JS polling of
// getProgress() on the given interval (ms), independent of any native
// event — same behavior the app was already built around (see
// PlayerScreen.js's own note about "useProgress hasn't ticked yet since
// mount/track-change" — that's this polling, not push-based).
export function useProgress(updateInterval = 1000) {
    const [progress, setProgress] = useState(() => {
        // Start from the last reading (moved on by the time since, if it was
        // playing) rather than from 0:00.
        const lp = lastProgress;
        if (lp && Date.now() - lp.at < 3000 && lp.duration > 0) {
            const adv = lastPlaybackState === State.Playing ? (Date.now() - lp.at) / 1000 : 0;
            return { position: Math.min(lp.duration, lp.position + adv), duration: lp.duration, buffered: lp.duration, id: lp.id, qid: lp.qid };
        }
        return { position: 0, duration: 0, buffered: 0 };
    });
    useEffect(() => {
        let cancelled = false;
        const tick = () => {
            NativeAudioEngine.getProgress().then(p => { if (!cancelled) setProgress(p); }).catch(() => { });
        };
        tick();
        const id = setInterval(tick, updateInterval);
        // Re-fetch immediately on foreground instead of waiting for the next
        // interval tick (up to `updateInterval` late) — mainly matters
        // alongside usePlaybackState's own foreground re-sync below: after
        // a route-change/interruption that happened while backgrounded
        // (e.g. a Bluetooth disconnect), this gets the real position back
        // in front of the user as soon as the app is looked at again rather
        // than leaving a stale reading on screen for up to a second.
        // Asked again a moment later too: right after the app wakes, native can
        // still be settling (a Bluetooth connection or route change that
        // happened while the app was away), and the first answer can be the
        // pre-change one.
        let wakeTimers = [];
        const appSub = AppState.addEventListener('change', (state) => {
            if (state === 'active') {
                tick();
                wakeTimers.forEach(clearTimeout);
                wakeTimers = [setTimeout(tick, 350), setTimeout(tick, 1200)];
            }
        });
        return () => { cancelled = true; clearInterval(id); appSub.remove(); wakeTimers.forEach(clearTimeout); };
    }, [updateInterval]);
    return progress;
}

// Matches RNTP's real usePlaybackState(): initial value from getState(),
// live-updated via the PlaybackState event. getState() resolves the bare
// state string; the event body is already { state } (see AudioEngine.swift's
// setState), so both paths are normalized to the same { state } shape here.
export function usePlaybackState() {
    const [playbackState, setPlaybackState] = useState(() => ({ state: lastPlaybackState }));
    useEffect(() => {
        let cancelled = false;
        NativeAudioEngine.getState().then(state => { if (!cancelled) setPlaybackState({ state }); }).catch(() => { });
        const sub = addEventListener(Event.PlaybackState, ({ state }) => setPlaybackState({ state }));
        // Real gap found here: this only ever fetched the true state once,
        // on mount — after that it trusted the PlaybackState event stream
        // exclusively, for the lifetime of the app. That's a problem
        // specifically around backgrounding: a native state change that
        // happens while the app is backgrounded/suspended (e.g. handleRouteChange's
        // pauseInternal() call on a Bluetooth disconnect — see
        // AudioEngine.swift) sends its event through the same RN bridge
        // that a backgrounded/suspended app isn't guaranteed to be pumping
        // at that moment. If that specific event never lands, this hook's
        // belief silently goes stale — "playing" forever, matching exactly
        // "shows the song as playing but has no audio" after a disconnect.
        // Re-fetching the real state directly (not waiting on an event)
        // every time the app comes back to the foreground makes this
        // self-correcting regardless of whether the event made it through.
        const appSub = AppState.addEventListener('change', (nextState) => {
            if (nextState === 'active') {
                const resync = () => NativeAudioEngine.getState().then(state => { if (!cancelled) setPlaybackState({ state }); }).catch(() => { });
                resync();
                setTimeout(resync, 350);   // native may still be settling right after waking
            }
        });
        return () => { cancelled = true; sub.remove(); appSub.remove(); };
    }, []);
    return playbackState;
}
