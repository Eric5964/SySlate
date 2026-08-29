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
//   this cost is paid once per song, not on every play — but see the v6
//   fingerprint note below: "permanently" now means "until the file at
//   that path is actually replaced," not literally forever.

const ART_DIR = FileSystem.documentDirectory + '.song-art/';
// v6: cache entries now store a lightweight fingerprint (file size +
// modification time) alongside the resolved art URI/null, instead of just
// the bare value. The cache key is `song.id`, which is the file's PATH —
// replacing a file at that same path with a different one (different tags,
// possibly newly-embedded art) used to be invisible to this cache: the old
// path still matched, so whatever was cached for the OLD file kept getting
// served forever, most commonly a cached `null` masking real art on the
// replacement file. The fingerprint lets a lookup detect "the file here
// isn't the one this entry was computed from" and treat it as unprocessed
// instead of trusting a stale result. Bumped the key (not just the shape,
// in place) because v5 entries are bare values with no fingerprint to
// compare against — there's no meaningful way to validate them, so this is
// a clean cutover rather than special-casing two entry shapes in one map.
// Same precedent as the v5 bump above: a one-time full re-extraction pass
// on first run after this update, which is why FRONT_PREFIX_BYTES and the
// moov-scan sizing below matter — those are what keep that pass from being
// the kind of concurrent CPU load that caused the CPU-limit kill this file
// already documents having fixed once.
const CACHE_KEY = 'song_art_cache_v6';
const FRONT_PREFIX_BYTES = 3 * 1024 * 1024;

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

// Stat-only (no file content read) — cheap enough to use on every cache
// lookup, not just during real extraction. Returns null if the file can't
// be stat'd, which callers treat as "can't verify, trust the existing
// cache" rather than as a mismatch — a transient filesystem hiccup
// shouldn't be able to wipe out an otherwise-correct cached result.
async function getFingerprint(uri) {
    try {
        const info = await FileSystem.getInfoAsync(uri);
        if (!info.exists) return null;
        return { size: info.size, mtime: info.modificationTime };
    } catch {
        return null;
    }
}
function fingerprintsMatch(a, b) {
    return !!a && !!b && a.size === b.size && a.mtime === b.mtime;
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
        if (type === fourcc) return { dataStart: offset + headerSize, dataEnd: Math.min(offset + size, end), trueEnd: offset + size };
        offset += size;
    }
    return null;
}

function guessImageMime(bytes) {
    return (bytes[0] === 0xFF && bytes[1] === 0xD8) ? 'image/jpeg' : 'image/png';
}

function extractPictureFromMp4(bytes, baseOffset = 0) {
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
    // dataAtom.trueEnd is the atom's real declared end, unclamped — if that
    // runs past what we actually read (bytes.length), the picture is bigger
    // than our read window. Previously this just silently sliced to
    // whatever fit, writing a truncated image to disk that displays as a
    // half-scanned/corrupt cover forever (cached as "found", never retried).
    // Now it reports back exactly which absolute file range still needs to
    // be read, instead of guessing.
    if (dataAtom.trueEnd > bytes.length) {
        return { truncated: true, start: baseOffset + payloadStart, length: dataAtom.trueEnd - payloadStart };
    }
    const payload = bytes.slice(payloadStart, dataAtom.dataEnd);
    if (!payload.length) return null;
    return { mime: guessImageMime(payload), data: payload };
}

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(hash);
}

// Cache-only lookup — checks what we already know, plus one cheap stat call
// to confirm the file at this path is still the one the cached entry was
// computed from. Returns the cached URI, null (confirmed no art, and the
// file hasn't changed since), or undefined (never processed, OR the file
// has changed since it was — both mean "needs a real extraction pass").
// Slightly more than "no file I/O" now (a stat call was added to catch
// stale entries — see the v6 fingerprint note above), but still far
// cheaper than the real read+decode extraction does, so callers can keep
// using this to skip the artificial "don't compete with the ramp" delay
// for anything that resolves here.
export async function getCachedArt(song) {
    if (!song?.id) return undefined;
    const cache = await loadCacheMap();
    const entry = cache[song.id];
    if (entry === undefined) return undefined;
    const current = await getFingerprint(song.url);
    // current is null only when the stat itself failed (not when it
    // succeeded and simply didn't match) — treat that as "can't verify,
    // trust the cache" rather than as a mismatch.
    if (current && !fingerprintsMatch(entry.fp, current)) return undefined;
    return entry.uri ?? null;
}

// Returns a local file:// URI for the song's embedded cover art, or null if
// none was found/the format isn't supported. Safe to call repeatedly — the
// result (including a miss) is cached, so only the first call per song does
// real work.
//
// In-flight dedup: several call sites can ask for the same song's art at
// nearly the same moment — PlaybackContext's own "currently playing" effect,
// its upcoming-track prefetch, and a list screen's useListArt scan can all
// legitimately want the same song around a track change. Without this, each
// of those would independently kick off its own full file read + base64
// decode (several MB apiece) for the identical song at the identical time.
// This makes concurrent callers share one in-flight extraction instead.
const inFlightExtractions = new Map();
export async function extractEmbeddedArt(song) {
    if (!song?.id || !song?.url) return null;
    if (inFlightExtractions.has(song.id)) return inFlightExtractions.get(song.id);
    const promise = extractEmbeddedArtUncached(song).finally(() => {
        inFlightExtractions.delete(song.id);
    });
    inFlightExtractions.set(song.id, promise);
    return promise;
}

// For "moov at end" files (common for ALAC when the encoder doesn't put
// metadata up front for streaming), a fixed-size tail read can't just
// assume its first byte is the start of the 'moov' box — there's no way to
// know that without knowing exactly where 'moov' begins, and moov's own
// declared size includes any embedded cover art inside it, so it can
// legitimately run several MB. This scans for the "moov" marker itself and
// validates it against the known file size (moov is virtually always the
// last top-level box, so its declared end should land exactly on EOF).
function findMoovNearEnd(bytes, tailStart, fileSize) {
    for (let i = bytes.length - 4; i >= 4; i--) {
        if (bytes[i] === 0x6D && bytes[i + 1] === 0x6F && bytes[i + 2] === 0x6F && bytes[i + 3] === 0x76) { // "moov"
            const sizeFieldOffset = i - 4;
            const size = readU32BE(bytes, sizeFieldOffset);
            if (size === 1) continue; // 64-bit extended size — vanishingly rare for moov, skip
            const absStart = tailStart + sizeFieldOffset;
            if (absStart + size === fileSize) return { absStart, size };
        }
    }
    return null;
}

const MOOV_SCAN_SIZES = [6 * 1024 * 1024, 24 * 1024 * 1024];
const MAX_MOOV_BYTES = MOOV_SCAN_SIZES[MOOV_SCAN_SIZES.length - 1];

// Tries a small number of fixed, non-redundant window sizes rather than
// doubling from a small start — each attempt was a brand new read+decode of
// the WHOLE window from scratch, so doubling meant re-decoding bytes already
// covered by the previous attempt for no reason. Base64-decoding is real
// CPU work, and this runs once per song across a whole library on first
// scan — the previous version of this was almost certainly the main driver
// behind a CPU-limit kill (confirmed via crash log: memory stayed flat,
// only CPU time was the problem). Starting at a size that comfortably
// covers the vast majority of real embedded covers means most songs never
// need the second, larger attempt at all.
async function locateMoovNearEnd(song, fileSize) {
    for (const size of MOOV_SCAN_SIZES) {
        const scanLen = Math.min(size, fileSize);
        const scanStart = fileSize - scanLen;
        const scanBytes = await readBytes(song.url, { position: scanStart, length: scanLen });
        const moov = findMoovNearEnd(scanBytes, scanStart, fileSize);
        if (moov) return { moov, scanBytes, scanStart };
        if (scanLen >= fileSize) return null;
    }
    return null;
}

const MAX_MP4_PICTURE_BYTES = 20 * 1024 * 1024;

async function resolveMp4Picture(song, bytes, baseOffset) {
    const picture = extractPictureFromMp4(bytes, baseOffset);
    if (!picture?.truncated) return picture;
    if (picture.length > MAX_MP4_PICTURE_BYTES || picture.length <= 0) return null;
    // Read exactly the remaining bytes of the real image, using the exact
    // absolute file position we now know it's at.
    const rest = await readBytes(song.url, { position: picture.start, length: picture.length });
    return { mime: guessImageMime(rest), data: rest };
}

async function extractEmbeddedArtUncached(song) {
    if (!song?.id || !song?.url) return null;
    try {
        const cache = await loadCacheMap();
        // Computed once here and reused for both the "is the existing entry
        // still valid" check below and the save at the end — no reason to
        // stat the same file twice in one pass.
        const fp = await getFingerprint(song.url);
        const existing = cache[song.id];
        if (existing !== undefined && fingerprintsMatch(existing?.fp, fp)) {
            return existing.uri ?? null;
        }

        const ext = (song.filename || song.id || '').split('.').pop().toLowerCase();
        let picture = null;

        if (ext === 'flac') {
            const bytes = await readBytes(song.url, { position: 0, length: FRONT_PREFIX_BYTES });
            picture = extractPictureFromFlac(bytes);
        } else if (ext === 'm4a' || ext === 'mp4' || ext === 'alac') {
            const front = await readBytes(song.url, { position: 0, length: FRONT_PREFIX_BYTES });
            picture = await resolveMp4Picture(song, front, 0);
            if (!picture) {
                const info = await FileSystem.getInfoAsync(song.url);
                if (info.exists) {
                    const located = await locateMoovNearEnd(song, info.size);
                    if (located) {
                        const { moov, scanBytes, scanStart } = located;
                        let moovBytes = null, moovBase = 0;
                        if (moov.absStart >= scanStart) {
                            // Whole moov box, cover art included, was already in what we scanned.
                            moovBytes = scanBytes.slice(moov.absStart - scanStart);
                            moovBase = moov.absStart;
                        } else if (moov.size <= MAX_MOOV_BYTES) {
                            // moov starts earlier than our scan reached — go get the whole box directly.
                            moovBytes = await readBytes(song.url, { position: moov.absStart, length: moov.size });
                            moovBase = moov.absStart;
                        }
                        if (moovBytes) picture = await resolveMp4Picture(song, moovBytes, moovBase);
                    }
                }
            }
        }

        if (!picture?.data?.length) {
            await saveCacheEntry(song.id, { uri: null, fp });
            return null;
        }

        await FileSystem.makeDirectoryAsync(ART_DIR, { intermediates: true }).catch(() => { });
        const fileExt = picture.mime?.includes('png') ? 'png' : 'jpg';
        // Filename includes the fingerprint, not just song.id — the fp check
        // above already tells getCachedArt/extractEmbeddedArtUncached that a
        // replaced file needs re-extracting, but writing the new art out to
        // the SAME uri every time (as this used to, keyed on song.id alone)
        // means the actual displayed URI string never changes even though
        // the file content behind it does. If the OS or Image component
        // caches by URI (common on iOS), a genuinely re-extracted new cover
        // could still render the old one, which would look exactly like
        // this whole fix not having worked. Baking the fingerprint into the
        // filename means a replaced file always resolves to a brand new
        // path, so there's nothing for a URI-keyed cache to serve stale.
        const fpTag = fp ? `${fp.size}_${fp.mtime}` : 'nofp';
        const dest = `${ART_DIR}${hashCode(song.id)}_${hashCode(fpTag)}.${fileExt}`;
        await FileSystem.writeAsStringAsync(dest, bytesToBase64(picture.data), { encoding: FileSystem.EncodingType.Base64 });
        // Clean up the previous fingerprint's file for this song, if any,
        // now that it's no longer reachable from the cache entry — avoids
        // orphaned art files quietly accumulating in ART_DIR every time a
        // song gets replaced.
        if (existing?.uri && existing.uri !== dest) {
            await FileSystem.deleteAsync(existing.uri, { idempotent: true }).catch(() => { });
        }
        await saveCacheEntry(song.id, { uri: dest, fp });
        return dest;
    } catch (e) {
        console.error('extractEmbeddedArt:', e);
        return null;
    }
}
