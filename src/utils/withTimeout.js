// Wraps a native TrackPlayer call so a hung native promise (which does
// happen — AVFoundation can occasionally hang loading metadata for a
// problem file) can't freeze the whole app waiting on it forever. Resolves
// with `fallback` instead of rejecting so callers don't need extra
// try/catch just for the timeout case.
export function withTimeout(promise, ms = 4000, fallback = undefined) {
    return Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
    ]);
}
