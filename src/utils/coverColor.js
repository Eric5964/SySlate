import { getColors } from 'react-native-image-colors';

// Extracts an approximate "average color" from a cover image, cached per URI
// so we only ever compute it once per image. Falls back silently to whatever
// the caller passes if extraction fails for any reason.
const cache = {};

export async function getAverageColor(uri, fallback) {
    if (!uri) return fallback;
    if (cache[uri]) return cache[uri];
    try {
        const result = await getColors(uri, { fallback, cache: true, key: uri });
        let color = fallback;
        if (result.platform === 'ios') color = result.background ?? fallback;
        else if (result.platform === 'android') color = result.dominant ?? result.average ?? fallback;
        cache[uri] = color;
        return color;
    } catch {
        return fallback;
    }
}
