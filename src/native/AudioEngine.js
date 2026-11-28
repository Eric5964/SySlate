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
import { getProgressSeed, setProgressSeed } from '../utils/progressSeed';

const { AudioEngine: NativeAudioEngine } = NativeModules;
const emitter = new NativeEventEmitter(NativeAudioEngine);
let useVolumeTags = true;
let lastPlaybackRate = 1;
let lastSeekAt = 0;

export const Event = {
    PlaybackState: 'PlaybackState',
    PlaybackTrackChanged: 'PlaybackTrackChanged',
    PlaybackProgressUpdated: 'PlaybackProgressUpdated',
    EndFadeStarted: 'EndFadeStarted',
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
    seekTo: (seconds) => { lastSeekAt = Date.now(); return NativeAudioEngine.seekTo(seconds); },
    // When JS last asked for a seek: listening time is not counted across one (the position jumped, it was not played).
    getLastSeekAt: () => lastSeekAt,
    // DJ disc: begin resolves true once scratch audio is ready.
    // The last speed JS asked for. The fade code needs it: track positions are in song seconds, fades run in real seconds.
    setPlaybackRate: (rate) => { const r = Number(rate); if (Number.isFinite(r) && r > 0) lastPlaybackRate = r; return NativeAudioEngine.setPlaybackRate(rate); },
    getLastPlaybackRate: () => lastPlaybackRate,
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
    // Copies `length` bytes of a file, from `offset`, into a new file, in small pieces (resolves false on any problem).
    copyFileRange: async (src, offset, length, dest) => { try { return !!(await NativeAudioEngine.copyFileRange(src, offset, length, dest)); } catch (e) { return false; } },
    getDurations: (urls) => NativeAudioEngine.getDurations(urls),
    importFolder: () => NativeAudioEngine.importFolder(),
    pickImportFolder: () => NativeAudioEngine.pickImportFolder(),
    copyPickedFolder: () => NativeAudioEngine.copyPickedFolder(),
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
    // True only during the first half of a crossfade (see AudioEngine.swift's isCrossfadeFirstHalf).
    getCrossfadeFirstHalf: () => NativeAudioEngine.getCrossfadeFirstHalf(),
    setRepeatMode: (mode) => NativeAudioEngine.setRepeatMode(mode),
    setEQBands: (bands) => NativeAudioEngine.setEQBands(bands),
    // The end-of-song fade-out is timed natively (on the audio clock). hasNativeEndFade() is false on an older build.
    setEndFade: (sec) => (NativeAudioEngine.setEndFade ? NativeAudioEngine.setEndFade(sec) : Promise.resolve()),
    hasNativeEndFade: () => !!NativeAudioEngine.setEndFade,
    // Custom parametric EQ. A build without the native method just ignores it.
    setEQParametric: (freqs, gains, bws, types) => (NativeAudioEngine.setEQParametric ? NativeAudioEngine.setEQParametric(freqs, gains, bws, types) : Promise.resolve()),
    setPreAmp: (db) => NativeAudioEngine.setPreAmp(db),
    // Split from one "Volume Normalization" toggle into two distinct
    // features: setWithinTrackNormEnabled is the original per-track
    // dynamics compressor; setBetweenTrackNormEnabled is the new sampled
    // loudness-matching gain across tracks. setSilenceTrimEnabled is also
    // new — leading/trailing silence trim on a track's natural start/end.
    setWithinTrackNormEnabled: (enabled) => NativeAudioEngine.setWithinTrackNormEnabled(enabled),
    setBetweenTrackNormEnabled: (enabled) => NativeAudioEngine.setBetweenTrackNormEnabled(enabled),
    setSilenceTrimEnabled: (enabled) => NativeAudioEngine.setSilenceTrimEnabled(enabled),
    // Output devices seen so far, each { name, blocked }; blocked = its automatic Play on connect is ignored.
    getAutoplayDevices: async () => { try { return (await NativeAudioEngine.getAutoplayDevices()) || []; } catch (e) { return []; } },
    setAutoplayBlocked: async (name, blocked) => { try { await NativeAudioEngine.setAutoplayBlocked(name, blocked); } catch (e) {} },
    setCrossfadeEnabled: (enabled) => { xfEstimate.on = !!enabled; return NativeAudioEngine.setCrossfadeEnabled(enabled); },
    // Kept name — this is now specifically the "on skip" duration (see
    // AudioEngine.swift), the JS-facing name stays the same for backward
    // compatibility with the AsyncStorage key it's paired with.
    setCrossfadeDuration: (seconds) => { xfEstimate.sec = Number(seconds) || 0; return NativeAudioEngine.setCrossfadeDuration(seconds); },
    setCrossfadeDurationEndOfTrack: (seconds) => NativeAudioEngine.setCrossfadeDurationEndOfTrack(seconds),

    addEventListener,
};

export default AudioEngine;

// What the engine last said, kept at module level so a screen that mounts
// later (the Player opening) starts from the real state at once instead of
// from "nothing yet" for the first few frames. That empty start was why the
// DJ disc and the progress bar were late to start when the Player opened.
// Crossfade setting as last sent to the engine: the new song is announced halfway through a crossfade, so the
// clock estimate below starts half a crossfade in, not at 0.
const xfEstimate = { on: false, sec: 0 };
let lastPlaybackState = State.None;
let lastProgress = null;   // { position, duration, buffered, id, qid, at }
let lastGoodReading = null;   // newest reading with a real duration, any song
const zeroHolds = new Map();  // song key -> first unconfirmed 0:00 reading
// A 0:00 that already sat through its hold (in smoothReading) is real: matchProgress must not hold it a second time.
const zeroAccepted = new Map();  // song key -> time the hold ended
const markZeroAccepted = (p, now) => { if (p.qid) zeroAccepted.set(`q:${p.qid}`, now); if (p.id) zeroAccepted.set(`i:${p.id}`, now); };
const zeroRecentlyAccepted = (p, now) => ((p.qid && now - (zeroAccepted.get(`q:${p.qid}`) || 0) < 4000) || (p.id && now - (zeroAccepted.get(`i:${p.id}`) || 0) < 4000));
const ZERO_HOLD_MS = 1500;

const sameSong = (a, b) => {
    if (!a || !b) return false;
    if (a.id && b.id) return a.id === b.id && (!a.qid || !b.qid || a.qid === b.qid);   // a new slot of the same song is a restart, not a hiccup
    if (a.qid && b.qid) return a.qid === b.qid;
    return false;
};

// Native can answer 0/0 while a file is still loading, and can briefly answer 0/real-duration at a crossfade's handoff
// (the newly active node has no render time for a frame). Neither means the song jumped back to its start. Carry the
// last real position across short gaps like that; a genuine restart at 0 is still accepted immediately when it follows
// the end of a song (repeat) or a seek (in-app or lock screen), and a 0 that persists is accepted after the hold.
const smoothReading = (p, nowMs = Date.now()) => {
    if (!p || !(p.duration > 0)) return p;
    const prev = lastGoodReading;
    const seed = getProgressSeed();
    const fromSeed = !!(seed && seed.duration > 0 && seed.id && sameSong(seed, p) && seed.position > 1.5 && p.position <= 0.05);
    const suspicious = nowMs - lastSeekAt > 1500 && (
        (fromSeed && (!prev || !sameSong(prev, p))) ||
        (prev && sameSong(prev, p) && prev.position > 1.5 && prev.duration > 0 && p.position <= 0.05 &&
            prev.position < prev.duration - 1.5 && Math.abs(p.duration - prev.duration) < 2)
    );
    const key = p.qid ? `q:${p.qid}` : (p.id ? `i:${p.id}` : '');
    if (!suspicious) {
        if (p.position > 0.05) zeroHolds.delete(key);
        lastGoodReading = { ...p, at: nowMs };
        return p;
    }
    let hold = zeroHolds.get(key);
    if (!hold || nowMs - hold.at > 4000) { hold = { at: nowMs }; zeroHolds.set(key, hold); }
    if (nowMs - hold.at >= ZERO_HOLD_MS) {
        zeroHolds.delete(key);
        markZeroAccepted(p, nowMs);
        lastGoodReading = { ...p, at: nowMs };
        return p;
    }
    const base = fromSeed && (!prev || !sameSong(prev, p)) ? seed : prev;
    const duration = p.duration || base.duration || 0;
    let position = base.position || 0;
    if (lastPlaybackState === State.Playing) {
        position += Math.min(3, Math.max(0, (nowMs - (base.at || nowMs)) / 1000)) * (lastPlaybackRate || 1);
    }
    if (duration > 0) position = Math.min(duration, position);
    return { ...p, position: Math.max(0, position), duration, buffered: duration, held: true, stale: true };
};

try {
    emitter.addListener(Event.PlaybackState, ({ state }) => { lastPlaybackState = state; });
    emitter.addListener(Event.PlaybackProgressUpdated, (p) => {
        if (!p) return;
        const s = smoothReading(p);
        if (s && s.duration > 0) lastProgress = { ...s, at: Date.now() };
    });
    NativeAudioEngine.getState().then(state => { if (lastPlaybackState === State.None) lastPlaybackState = state; }).catch(() => { });
} catch { }

// The newest position reading the engine pushed (about every quarter second), with the time it arrived. The progress bar
// uses it to start a new song's bar at its real spot at once (a crossfade flips the song halfway through).
export function peekLastProgress() { return lastProgress; }

const CROSSFADE_ESTIMATE_MAX_MS = 6000;
// Per-showing state, keyed by song id: two consumers (Player, mini player, lyrics) call matchProgress for the same
// song, and an old consumer can briefly still name the previous song. One shared object used to be reset backwards by
// whichever call came last, which restarted the crossfade estimate and the stale-confirmation window.
const displaySince = new Map();   // id -> { at, startAt }
const lastGoodByKey = new Map();  // slot/id key -> last real reading for that song
const foreignByKey = new Map();   // slot/id key -> { key, since } for readings naming another song
const songKey = (id, qid) => qid ? `q:${qid}` : (id ? `i:${id}` : '');
const displayFor = (id, now) => {
    let d = displaySince.get(id);
    if (!d) {
        d = { at: now, startAt: null };
        displaySince.set(id, d);
        if (displaySince.size > 16) displaySince.delete(displaySince.keys().next().value);
    }
    return d;
};

// A song shown the moment it is tapped (Play, Shuffle, a tap in a list) is on screen from the START of the crossfade, so
// its position is simply the time since then. A song a crossfade announces by itself is shown HALFWAY through it.
// Without telling them apart, a tapped song's estimate ran half a crossfade ahead of the sound and jumped backwards.
export function peekDisplayFlip(id) {
    if (!id) return null;
    const d = displaySince.get(id);
    if (d && d.startAt === 0 && Date.now() - d.at < 3000) return { at: d.at };
    return null;
}
export function noteDisplayFlipNow(id) {
    if (!id) return;
    const nowMs = Date.now();
    const d = displaySince.get(id);
    if (d && d.startAt === 0 && nowMs - d.at < 1000) return;   // already noted (the state update can run twice)
    displaySince.set(id, { at: nowMs, startAt: 0 });
}

// Never return a bare 0:00 for a song whose real position we already know. Extrapolate from the last real reading for
// at most 3 s (enough to cover a handoff/wake hiccup, never enough to run away if the app was suspended for minutes).
const heldReading = (prev, p, fallbackDuration, nowMs) => {
    const duration = (p && p.duration > 0) ? p.duration : (fallbackDuration > 0 ? fallbackDuration : (prev.duration || 0));
    let position = prev.position || 0;
    if (lastPlaybackState === State.Playing) {
        position += Math.min(3, Math.max(0, (nowMs - (prev.at || nowMs)) / 1000)) * (lastPlaybackRate || 1);
    }
    if (duration > 0) position = Math.min(duration, position);
    return {
        position: Math.max(0, position), duration, buffered: duration,
        id: p?.id ?? prev.id, qid: p?.qid ?? prev.qid,
        stale: true, estimated: lastPlaybackState === State.Playing, held: true,
    };
};

// Only readings for the song being shown count. A late reading from before a skip, or the outgoing song's position
// during a crossfade's first half, must not drag the bar somewhere else — but it must not turn the bar into 0:00
// either: hold the last real position for this song until a matching reading arrives (or the app follows native to
// the song that really is playing, see PlaybackContext's AppState/progress-time follow).
export function matchProgress(p, expectQid, fallbackDuration = 0, expectId) {
    const nowMs = Date.now();
    const key = songKey(expectId, expectQid);
    const disp = expectId ? displayFor(expectId, nowMs) : null;
    const good = key ? lastGoodByKey.get(key) : null;
    if (!p) {
        if (good) return heldReading(good, null, fallbackDuration, nowMs);
        return { position: 0, duration: fallbackDuration || 0, buffered: 0, stale: true };
    }
    let stale = false;
    if (p.id && expectId) stale = p.id !== expectId;
    else if (expectQid && p.qid) stale = p.qid !== expectQid;

    let foreignAccepted = false;
    if (stale) {
        const readingKey = `${p.id || ''}|${p.qid || ''}`;
        let f = foreignByKey.get(key) || { key: '', since: nowMs };
        if (f.key !== readingKey) { f = { key: readingKey, since: nowMs }; foreignByKey.set(key, f); }
        // A crossfade explains another song's readings for at most ~6 s. If the shown song has been up longer, native
        // is simply ahead; with no known position for this song, accept the reading as a last resort instead of
        // parking the bar at 0:00 forever. When there IS a known position, holding it is both safer and smoother.
        const onScreenMs = disp ? nowMs - disp.at : 0;
        const limit = onScreenMs >= CROSSFADE_ESTIMATE_MAX_MS ? 400 : CROSSFADE_ESTIMATE_MAX_MS + 500;
        // Once the shown song is past any crossfade (6 s) a foreign reading that persists 2 s means native is genuinely
        // somewhere else; during a crossfade window keep holding up to 8 s. Holding forever would be as wrong as 0:00.
        const foreignLimit = onScreenMs >= CROSSFADE_ESTIMATE_MAX_MS ? 2000 : 8000;
        if (nowMs - f.since > foreignLimit || (!good && nowMs - f.since > limit)) { stale = false; foreignAccepted = true; }
    } else {
        foreignByKey.delete(key);
    }
    if (stale) {
        if (good) return heldReading(good, p, fallbackDuration, nowMs);
        const el = disp ? nowMs - disp.at : 0;
        if (expectId && fallbackDuration > 0 && lastPlaybackState === State.Playing && el >= 0 && el < CROSSFADE_ESTIMATE_MAX_MS) {
            const startAt = disp.startAt != null ? disp.startAt : (xfEstimate.on ? xfEstimate.sec / 2 : 0);
            return { position: Math.min(fallbackDuration, el / 1000 + startAt), duration: fallbackDuration, buffered: fallbackDuration, stale: true, estimated: true };
        }
        return { position: 0, duration: fallbackDuration || 0, buffered: 0, stale: true };
    }
    const duration = p.duration > 0 ? p.duration : (fallbackDuration || 0);
    if (foreignAccepted) return { ...p, duration, buffered: duration, stale: false, foreign: true };

    // A single implausible 0:00 from native (crossfade handoff, engine still settling after unlock) is not a seek.
    const holdKey = key || `${p.id || ''}|${p.qid || ''}`;
    const suspiciousZero = !p.held && !zeroRecentlyAccepted(p, nowMs) && p.duration > 0 && p.position <= 0.05 && good && good.position > 1.5 &&
        good.duration > 0 && good.position < good.duration - 1.5 && Math.abs(p.duration - good.duration) < 2 &&
        nowMs - lastSeekAt > 1500;
    if (suspiciousZero) {
        let z = zeroHolds.get(holdKey);
        if (!z || nowMs - z.at > 4000) { z = { at: nowMs }; zeroHolds.set(holdKey, z); }
        if (nowMs - z.at < ZERO_HOLD_MS) return heldReading(good, p, fallbackDuration, nowMs);
        zeroHolds.delete(holdKey);
        markZeroAccepted(p, nowMs);
    } else if (p.position > 0.05) zeroHolds.delete(holdKey);

    const result = duration !== p.duration ? { ...p, duration, buffered: duration } : p;
    if (key && duration > 0) {
        lastGoodByKey.set(key, { position: result.position, duration, at: nowMs, id: result.id || expectId, qid: result.qid || expectQid });
    }
    return result;
}

// Matches RNTP's real useProgress(updateInterval): plain JS polling of
// getProgress() on the given interval (ms), independent of any native
// event — same behavior the app was already built around (see
// PlayerScreen.js's own note about "useProgress hasn't ticked yet since
// mount/track-change" — that's this polling, not push-based).
export function useProgress(updateInterval = 1000) {
    const [progress, setProgress] = useState(() => {
        // Start from the last reading rather than from 0:00. A paused song's
        // position does not move, so an old reading is still exactly right
        // (the consumers' own current-song check filters a reading that
        // belongs to another song). Playing advances by the time since the
        // reading, for up to a minute; anything older falls through to the
        // restored session seed.
        const lp = lastProgress;
        if (lp && lp.duration > 0) {
            const ageMs = Math.max(0, Date.now() - lp.at);
            const playing = lastPlaybackState === State.Playing;
            if (!playing || ageMs <= 60000) {
                const adv = playing ? ageMs / 1000 : 0;
                return { position: Math.min(lp.duration, lp.position + adv), duration: lp.duration, buffered: lp.duration, id: lp.id, qid: lp.qid };
            }
        }
        // A restored paused session already knows where it was, long before
        // the engine has loaded the song and can report anything.
        const seed = getProgressSeed();
        if (seed && seed.duration > 0) {
            return { position: Math.min(seed.duration, Math.max(0, seed.position || 0)), duration: seed.duration, buffered: seed.duration, id: seed.id, qid: seed.qid };
        }
        return { position: 0, duration: 0, buffered: 0 };
    });
    useEffect(() => {
        let cancelled = false;
        const tick = () => {
            NativeAudioEngine.getProgress().then(p => {
                if (cancelled || !p) return;
                const now = Date.now();
                // A real poll is as good as a pushed event: remember it so a
                // screen that mounts later starts from it, not from 0:00. Never cache an unconfirmed 0:00.
                const s = smoothReading(p, now);
                if (s && s.duration > 0) lastProgress = { ...s, at: now };
                // While the restored song is still loading the engine can
                // answer 0/0. Do not replace a known position and duration
                // for the same song with that; the quick follow-up ticks pick
                // up the real reading as soon as it is ready.
                setProgress(prev => {
                    if (!s) return prev;
                    if (!(s.duration > 0) && prev.duration > 0 && (!s.id || !prev.id || s.id === prev.id)) return prev;
                    return s;
                });
                // A real reading for the restored song is what the seed was standing in for: retire it now.
                // Do not retire it on a held 0:00 — that is the restored position being carried across a loading gap.
                const seed = getProgressSeed();
                if (seed && s && s.duration > 0 && s.id && !s.stale && !s.held) setProgressSeed(null);
            }).catch(() => { });
        };
        tick();
        const id = setInterval(tick, updateInterval);
        // A screen that mounts right after a song was tapped starts from the OLD song's reading (or none) and used to
        // wait for the first interval tick (up to updateInterval) before the bar and time left 0:00. A few quick extra
        // readings right after mount pick up the new song as soon as native has it.
        const earlyTimers = [100, 250, 400].map(ms => setTimeout(tick, ms));
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
        return () => { cancelled = true; clearInterval(id); appSub.remove(); wakeTimers.forEach(clearTimeout); earlyTimers.forEach(clearTimeout); };
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
