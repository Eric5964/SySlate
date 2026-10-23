// A Map that evicts its oldest entry once it grows past `maxSize`, instead
// of growing for the lifetime of the app session. Used for small
// process-lifetime memoization caches (lyrics, cover color) that were
// previously plain objects/Maps with no cap — fine for a short session, but
// a genuine slow leak over a long one spent browsing/playing through a big
// library, since nothing ever removed old entries.
//
// Map preserves insertion order, and `.get()` doesn't change that order, so
// this is "oldest inserted" eviction (FIFO), not true LRU (recently-read
// entries aren't bumped back to the front). That's a fine tradeoff here:
// these caches exist to avoid re-parsing/re-reading a file while flipping
// between a handful of nearby songs, not to keep a "most used" long tail
// warm.
export function createBoundedCache(maxSize) {
    const map = new Map();
    return {
        has: (key) => map.has(key),
        clear: () => map.clear(),
        get: (key) => map.get(key),
        set(key, value) {
            if (!map.has(key) && map.size >= maxSize) {
                const oldestKey = map.keys().next().value;
                map.delete(oldestKey);
            }
            map.set(key, value);
        },
    };
}
