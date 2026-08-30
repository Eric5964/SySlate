import { getColors } from 'react-native-image-colors';
import { createBoundedCache } from './boundedCache';

// Extracts an approximate "average color" from a cover image, cached per URI
// so we only ever compute it once per image. Falls back silently to whatever
// the caller passes if extraction fails for any reason. Capped — was an
// unbounded plain object before, growing one entry per unique cover URI for
// the whole session (and the cache key is the file-fingerprinted URI, so a
// replaced file adds a new entry rather than overwriting the old one — see
// the cover-art cache-key fix). 500 covers the entire visible library for
// almost anyone; past that it's old scroll history that doesn't need to
// stay resident.
const cache = createBoundedCache(500);

export async function getAverageColor(uri, fallback) {
    if (!uri) return fallback;
    if (cache.has(uri)) return cache.get(uri);
    try {
        const result = await getColors(uri, { fallback, cache: true, key: uri });
        let color = fallback;
        if (result.platform === 'ios') color = result.background ?? fallback;
        else if (result.platform === 'android') color = result.dominant ?? result.average ?? fallback;
        cache.set(uri, color);
        return color;
    } catch {
        return fallback;
    }
}
