import { Image } from 'react-native';

// One place for warming cover images. The same URI is requested from several
// places at once — the two prefetch effects in PlaybackContext (they overlap
// on the next songs), and StableArt itself when a cover is mounted — and each
// call used to write a "[COVER] prefetch start/end" pair to the debug log. A
// song change could produce a dozen identical lines.
//
// Now a URI warmed within RECENT_MS is skipped silently, and only a real
// failure is logged. The timestamp is recorded before the request starts so a
// burst of calls for the same cover collapses into one.
const RECENT_MS = 30000;
const recent = new Map();   // uri -> Date.now()

export function prefetchCover(uri) {
    if (!uri) return Promise.resolve(false);
    const now = Date.now();
    const last = recent.get(uri);
    if (last && now - last < RECENT_MS) return Promise.resolve(true);
    // Keep the map bounded on long sessions: drop entries that are old enough
    // to be re-prefetched anyway.
    if (recent.size > 200) {
        for (const [key, at] of recent) {
            if (now - at >= RECENT_MS) recent.delete(key);
        }
    }
    recent.set(uri, now);
    return Image.prefetch(uri).then(
        (ok) => {
            if (!ok) { recent.delete(uri); console.log('[COVER] prefetch failed ' + uri); }
            return ok;
        },
        () => {
            recent.delete(uri);
            console.log('[COVER] prefetch failed ' + uri);
            return false;
        }
    );
}
