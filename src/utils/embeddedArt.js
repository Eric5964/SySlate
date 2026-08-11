import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Extracts embedded cover art (the PICTURE block in FLAC, the 'covr' atom in
// MP4/ALAC) directly, with hand-rolled binary parsers instead of a metadata
// library like music-metadata. That avoids the Buffer/stream/process
// polyfills such libraries need in React Native (no Node core modules here),
// which means: no metro/babel config changes, no new native dependency, and
// a much smaller code footprint — this file has zero new package.json deps.
//
// LIMITATIONS (v1, worth knowing before relying on this everywhere):
// - FLAC: metadata blocks are always at the front of the file per spec, so a
//   bounded prefix read is reliable. Only fails if a single embedded image
//   is larger than FRONT_PREFIX_BYTES, which would be an unusually large
//   cover file.
// - MP4/ALAC: tries the front of the file first (works for "fast start"
//   files, which is most iTunes-style rips), then falls back to reading the
//   tail if that fails (covers files where the 'moov' atom sits at the end).
//   Extended 64-bit atom sizes aren't handled (rare in practice for these
//   particular atoms).
// - MP3/ID3 and other formats aren't handled yet — not the primary format
//   for this app, but the same approach extends to ID3v2 APIC frames if
//   ever needed.
// - Results (including "no art found") are cached permanently per song, so
//   this cost is paid once per song, not on every play.

const ART_DIR = FileSystem.documentDirectory + '.song-art/';
// v2: bumped because a lot of songs were likely permanently cached as "no
// art found" by earlier parsing logic (before the ID3v2-prefix and 64-bit-
// atom-size fixes) — that negative result is cached forever, so without a
// version bump those songs would never get retried under the fixed parser.
const CACHE_KEY = 'song_art_cache_v2';
const FRONT_PREFIX_BYTES = 3 * 1024 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;

let cacheMapPromise = null;
async function loadCacheMap() {
    if (!cacheMapPromise) {
        cacheMapPromise = AsyncStorage.getItem(CACHE_KEY).then(v => v ? JSON.parse(v) : {}).catch(() => ({}));
    }
    return cacheMapPromise;
}
async function saveCacheEntry(songId, value) {
    const map = await loadCacheMap();
    map[songId] = value;
    cacheMapPromise = Promise.resolve(map);
    AsyncStorage.setItem(CACHE_KEY, JSON.stringify(map)).catch(() => { });
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
    const t = new Uint8Array(256);
    for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i;
    return t;
})();

function base64ToBytes(b64) {
    const clean = b64.replace(/=+$/, '');
    const outLen = Math.floor(clean.length * 3 / 4);
    const out = new Uint8Array(outLen);
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const b0 = B64_LOOKUP[clean.charCodeAt(i)];
        const b1 = B64_LOOKUP[clean.charCodeAt(i + 1)];
        const b2 = i + 2 < clean.length ? B64_LOOKUP[clean.charCodeAt(i + 2)] : 0;
        const b3 = i + 3 < clean.length ? B64_LOOKUP[clean.charCodeAt(i + 3)] : 0;
        if (o < outLen) out[o++] = (b0 << 2) | (b1 >> 4);
        if (o < outLen) out[o++] = ((b1 & 0xf) << 4) | (b2 >> 2);
        if (o < outLen) out[o++] = ((b2 & 0x3) << 6) | b3;
    }
    return out;
}

// Same decode as above, but yields back to the event loop every ~250K input
// characters instead of running as one long uninterrupted synchronous loop.
// For a 6MB read (~8M base64 characters) the plain version could occupy the
// JS thread for a real stretch — and this runs right at track-change time,
// which is exactly when the audio ramp's setTimeout-driven fade steps also
// need to fire. A blocked JS thread there delays those timers, which is
// what turns a smooth ~40ms-stepped fade into visible flat-then-jump
// plateaus. Used for the two large "front" reads; the small tail read isn't
// worth chunking.
const B64_YIELD_CHUNK_CHARS = 250000;
async function base64ToBytesChunked(b64) {
    const clean = b64.replace(/=+$/, '');
    const outLen = Math.floor(clean.length * 3 / 4);
    const out = new Uint8Array(outLen);
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const b0 = B64_LOOKUP[clean.charCodeAt(i)];
        const b1 = B64_LOOKUP[clean.charCodeAt(i + 1)];
        const b2 = i + 2 < clean.length ? B64_LOOKUP[clean.charCodeAt(i + 2)] : 0;
        const b3 = i + 3 < clean.length ? B64_LOOKUP[clean.charCodeAt(i + 3)] : 0;
        if (o < outLen) out[o++] = (b0 << 2) | (b1 >> 4);
        if (o < outLen) out[o++] = ((b1 & 0xf) << 4) | (b2 >> 2);
        if (o < outLen) out[o++] = ((b2 & 0x3) << 6) | b3;
        if (i % B64_YIELD_CHUNK_CHARS === 0 && i > 0) {
            await new Promise(r => setTimeout(r, 0));
        }
    }
    return out;
}

function bytesToBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
        out += B64_CHARS[b0 >> 2];
        out += B64_CHARS[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
        out += b1 === undefined ? '=' : B64_CHARS[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
        out += b2 === undefined ? '=' : B64_CHARS[b2 & 63];
    }
    return out;
}

async function readBytes(uri, options) {
    const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64, ...options });
    return base64ToBytesChunked(b64);
}

function readU32BE(bytes, o) { return ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0; }
function readU24BE(bytes, o) { return ((bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2]) >>> 0; }

function extractPictureFromFlac(bytes) {
    let start = 0;
    // ID3v2 tag prepended before the FLAC stream — the tag's size is a
    // "synchsafe" 28-bit integer (high bit of each of 4 bytes is always 0).
    if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
        const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
        start = 10 + size;
    }
    if (bytes.length < start + 4 || bytes[start] !== 0x66 || bytes[start + 1] !== 0x4C || bytes[start + 2] !== 0x61 || bytes[start + 3] !== 0x43) return null; // "fLaC"
    let offset = start + 4;
    while (offset + 4 <= bytes.length) {
        const header = bytes[offset];
        const isLast = (header & 0x80) !== 0;
        const blockType = header & 0x7f;
        const blockLen = readU24BE(bytes, offset + 1);
        const blockStart = offset + 4;
        if (blockType === 6) { // PICTURE
            if (blockStart + blockLen > bytes.length) return null; // truncated by our prefix read
            let p = blockStart + 4; // skip picture type
            const mimeLen = readU32BE(bytes, p); p += 4;
            const mime = String.fromCharCode(...bytes.slice(p, p + mimeLen)); p += mimeLen;
            const descLen = readU32BE(bytes, p); p += 4 + descLen;
            p += 16; // width, height, depth, colors-used (4 bytes each)
            const dataLen = readU32BE(bytes, p); p += 4;
            if (p + dataLen > bytes.length) return null;
            return { mime, data: bytes.slice(p, p + dataLen) };
        }
        offset = blockStart + blockLen;
        if (isLast) break;
    }
    return null;
}

function findAtom(bytes, start, end, fourcc) {
    let offset = start;
    while (offset + 8 <= end) {
        let size = readU32BE(bytes, offset);
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        let headerSize = 8;
        if (size === 1) {
            // 64-bit extended size — the real size is a big-endian uint64
            // in the next 8 bytes. JS numbers only give us 53 safe integer
            // bits, but no real atom in this chain is anywhere near that
            // large, so the low 32 bits (offset+12..+16) are enough.
            if (offset + 16 > end) return null;
            size = readU32BE(bytes, offset + 12);
            headerSize = 16;
        }
        if (size < headerSize) return null; // malformed
        if (type === fourcc) return { dataStart: offset + headerSize, dataEnd: Math.min(offset + size, end) };
        offset += size;
    }
    return null;
}

function extractPictureFromMp4(bytes) {
    const moov = findAtom(bytes, 0, bytes.length, 'moov');
    if (!moov) return null;
    const udta = findAtom(bytes, moov.dataStart, moov.dataEnd, 'udta');
    if (!udta) return null;
    const meta = findAtom(bytes, udta.dataStart, udta.dataEnd, 'meta');
    if (!meta) return null;
    // 'meta' is a "full box" — 4 bytes of version/flags before its children
    const ilst = findAtom(bytes, meta.dataStart + 4, meta.dataEnd, 'ilst');
    if (!ilst) return null;
    const covr = findAtom(bytes, ilst.dataStart, ilst.dataEnd, 'covr');
    if (!covr) return null;
    const dataAtom = findAtom(bytes, covr.dataStart, covr.dataEnd, 'data');
    if (!dataAtom) return null;
    const payloadStart = dataAtom.dataStart + 8; // 4-byte type indicator + 4-byte locale
    const payload = bytes.slice(payloadStart, dataAtom.dataEnd);
    if (!payload.length) return null;
    const mime = (payload[0] === 0xFF && payload[1] === 0xD8) ? 'image/jpeg' : 'image/png';
    return { mime, data: payload };
}

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(hash);
}

// Cache-only lookup — no file I/O, just checks what we already know. Returns
// the cached URI, null (confirmed no art), or undefined (never processed).
// Safe to call immediately with no delay, since there's no heavy work here —
// callers use this to skip the artificial "don't compete with the ramp"
// delay entirely for songs that are already cached.
export async function getCachedArt(song) {
    if (!song?.id) return undefined;
    const cache = await loadCacheMap();
    return song.id in cache ? (cache[song.id] || null) : undefined;
}

// Returns a local file:// URI for the song's embedded cover art, or null if
// none was found/the format isn't supported. Safe to call repeatedly — the
// result (including a miss) is cached, so only the first call per song does
// real work.
export async function extractEmbeddedArt(song) {
    if (!song?.id || !song?.url) return null;
    try {
        const cache = await loadCacheMap();
        if (song.id in cache) return cache[song.id] || null;

        const ext = (song.filename || song.id || '').split('.').pop().toLowerCase();
        let picture = null;

        if (ext === 'flac') {
            const bytes = await readBytes(song.url, { position: 0, length: FRONT_PREFIX_BYTES });
            picture = extractPictureFromFlac(bytes);
        } else if (ext === 'm4a' || ext === 'mp4' || ext === 'alac') {
            const front = await readBytes(song.url, { position: 0, length: FRONT_PREFIX_BYTES });
            picture = extractPictureFromMp4(front);
            if (!picture) {
                const info = await FileSystem.getInfoAsync(song.url);
                if (info.exists && info.size > TAIL_BYTES) {
                    const tail = await readBytes(song.url, { position: info.size - TAIL_BYTES, length: TAIL_BYTES });
                    picture = extractPictureFromMp4(tail);
                }
            }
        }

        if (!picture?.data?.length) {
            await saveCacheEntry(song.id, null);
            return null;
        }

        await FileSystem.makeDirectoryAsync(ART_DIR, { intermediates: true }).catch(() => { });
        const fileExt = picture.mime?.includes('png') ? 'png' : 'jpg';
        const dest = `${ART_DIR}${hashCode(song.id)}.${fileExt}`;
        await FileSystem.writeAsStringAsync(dest, bytesToBase64(picture.data), { encoding: FileSystem.EncodingType.Base64 });
        await saveCacheEntry(song.id, dest);
        return dest;
    } catch (e) {
        console.error('extractEmbeddedArt:', e);
        return null;
    }
}
