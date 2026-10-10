// A tiny publish/subscribe channel: PlaybackService announces the moment a
// play fade-in or pause fade-out begins (and how long it lasts), and the DJ
// disc listens so its spin speeds up and winds down in step with the audio
// ramp instead of reacting only once the engine's state flips.
const listeners = new Set();

export function emitTransportRamp(type, seconds) {
    listeners.forEach(fn => { try { fn({ type, seconds }); } catch { } });
}

export function subscribeTransportRamp(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// Announces the moment a skip / song change is requested (before the sound
// has changed), so the DJ disc can dim and stop taking touches at once
// instead of waiting for the new song to arrive.
const skipListeners = new Set();

export function emitSkipPress() {
    skipListeners.forEach(fn => { try { fn(); } catch { } });
}

export function subscribeSkipPress(fn) {
    skipListeners.add(fn);
    return () => skipListeners.delete(fn);
}
