import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import AudioEngine from '../native/AudioEngine';

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

// Small copies of covers for list rows. iOS throws away React Native's
// decoded-image cache whenever the app is backgrounded, so on return every
// row had to decode its full-size cover again (blank squares that fill in
// over a second). A 160px copy decodes almost instantly, so lists use these.
const THUMB_DIR = ART_DIR + 'thumbs/';
const THUMB_PX = 160;
// Mid-size copies (720px) for the big Player cover. The full-size art can be
// several thousand pixels wide; React Native does not keep decoded images
// that large in its cache, so the Player re-decoded it every time it was
// opened or the song changed. 720px stays small enough to be kept.
const MID_DIR = ART_DIR + 'mid/';
const MID_PX = 720;
const midNames = new Set();
const midQueued = new Set();
let midQueue = [];
let midRunning = false;
const thumbNames = new Set();
const thumbQueued = new Set();
let thumbQueue = [];
let thumbRunning = false;

function thumbNameFor(uri) {
    const file = uri.split('/').pop() || '';
    return file.replace(/\.[^.]+$/, '') + '.jpg';
}

async function loadThumbNames() {
    try {
        const names = await FileSystem.readDirectoryAsync(THUMB_DIR);
        names.forEach(n => thumbNames.add(n));
    } catch { }
    try {
        const names = await FileSystem.readDirectoryAsync(MID_DIR);
        names.forEach(n => midNames.add(n));
    } catch { }
}

async function runMidQueue() {
    if (midRunning) return;
    midRunning = true;
    while (midQueue.length) {
        const { uri, name } = midQueue.shift();
        try {
            const ok = await AudioEngine.makeThumbnail(uri, MID_DIR + name, MID_PX);
            if (ok) midNames.add(name);
        } catch { }
        await new Promise(r => setTimeout(r, 40));
    }
    midRunning = false;
}

// The URI the big Player cover should draw (720px copy once it exists).
export function playerArtUri(uri) {
    if (!uri || typeof uri !== 'string' || !uri.includes('.song-art/')) return uri;
    const name = thumbNameFor(uri);
    if (midNames.has(name)) return MID_DIR + name;
    if (!midQueued.has(name)) {
        midQueued.add(name);
        midQueue.push({ uri, name });
        runMidQueue();
    }
    return uri;
}

async function runThumbQueue() {
    if (thumbRunning) return;
    thumbRunning = true;
    while (thumbQueue.length) {
        const { uri, name } = thumbQueue.shift();
        try {
            const ok = await AudioEngine.makeThumbnail(uri, THUMB_DIR + name, THUMB_PX);
            if (ok) thumbNames.add(name);
        } catch { }
        await new Promise(r => setTimeout(r, 40));
    }
    thumbRunning = false;
}

async function makeListThumbNow(uri) {
    try {
        const name = thumbNameFor(uri);
        if (thumbNames.has(name)) return;
        thumbQueued.add(name);
        const ok = await AudioEngine.makeThumbnail(uri, THUMB_DIR + name, THUMB_PX);
        if (ok) thumbNames.add(name);
    } catch { }
}

// The URI a list row should draw: the small copy if it exists, otherwise the
// full one (and the small one is made in the background for next time).
export function listArtUri(uri) {
    if (!uri || typeof uri !== 'string' || !uri.includes('.song-art/')) return uri;
    const name = thumbNameFor(uri);
    if (thumbNames.has(name)) return THUMB_DIR + name;
    if (!thumbQueued.has(name)) {
        thumbQueued.add(name);
        thumbQueue.push({ uri, name });
        runThumbQueue();
    }
    return uri;
}
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
// The same map, held directly once loaded, so a list can read every cover it
// already knows about in one synchronous pass instead of awaiting per song.
let cacheMapSync = null;
async function loadCacheMap() {
    if (!cacheMapPromise) {
        cacheMapPromise = AsyncStorage.getItem(CACHE_KEY).then(v => v ? JSON.parse(v) : {}).catch(() => ({}))
            .then(m => { cacheMapSync = m; return m; });
    }
    return cacheMapPromise;
}
// Call once at app start so the map is already in memory by the time the
// first list mounts.
export function preloadArtCache() { return Promise.all([loadCacheMap(), loadThumbNames()]); }
// Synchronous, no file or storage access. Returns { [song.id]: uri | null }
// for every given song the cache already has an answer for (null means
// "checked, no embedded art"). Empty until the map has loaded.
export function peekCachedArtBulk(songs) {
    const out = {};
    if (!cacheMapSync || !songs) return out;
    for (const song of songs) {
        const entry = song?.id ? cacheMapSync[song.id] : undefined;
        if (entry !== undefined) out[song.id] = listArtUri(entry.uri ?? null);
    }
    return out;
}
// Writing the whole cache after every single song made the first pass over a big library
// re-save (and re-serialize) the entire map thousands of times. Now one save per ~1.5 s.
let persistTimer = null;
function schedulePersist(getMap) {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        try { AsyncStorage.setItem(CACHE_KEY, JSON.stringify(getMap())).catch(() => { }); } catch { }
    }, 1500);
}
async function saveCacheEntry(songId, value) {
    const map = await loadCacheMap();
    map[songId] = value;
    cacheMapSync = map;
    cacheMapPromise = Promise.resolve(map);
    schedulePersist(() => map);
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

// Base64 decode that yields back to the event loop every ~250K input
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
            if (mimeLen > 64) return null; // not a real mime type: damaged block
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

// Two independent 32-bit hashes (djb2-xor and FNV-1a) written as fixed-width
// hex, instead of one plain 31-multiplier hash. This is used to build the art
// file's name, and a name collision here isn't a harmless cache miss: two songs
// would share one file, so one of them shows the other's cover, and the
// "delete the previous fingerprint's file" cleanup below can delete it out from
// under the other. A single 32-bit value collides somewhere around 65k files
// (birthday bound); 64 bits makes it practically impossible.
function hashKey(str) {
    let djb = 5381, fnv = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        djb = ((djb * 33) ^ c) >>> 0;
        fnv = Math.imul(fnv ^ c, 0x01000193) >>> 0;   // exact 32-bit multiply (a plain * loses low bits past 2^53)
    }
    return djb.toString(16).padStart(8, '0') + fnv.toString(16).padStart(8, '0');
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

// No stat call — pure in-memory/AsyncStorage-map read, for interactive
// paths (useListArt's cache-only pass, run every time a list screen opens).
// The stat above is real native-bridge I/O; multiplied across every song in
// a playlist every time it's opened, that's exactly the ~1s-before-covers-
// show delay. Freshness checking for a replaced file is left entirely to
// the background loader (which still uses getCachedArt above, stat
// included) — it runs continuously regardless of which screens get opened,
// so a replaced file's cover still gets caught, just not necessarily the
// instant you happen to open that playlist.
export async function getCachedArtFast(song) {
    if (!song?.id) return undefined;
    const cache = await loadCacheMap();
    const entry = cache[song.id];
    return entry === undefined ? undefined : (entry.uri ?? null);
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
// At most two real extractions at once, whoever asks (the background loader, a list that just
// opened, the playing song): they used to pile up, each holding megabytes of file data.
const MAX_CONCURRENT_EXTRACTIONS = 2;
let activeExtractions = 0;
const extractionWaiters = [];
async function runGated(fn) {
    if (activeExtractions >= MAX_CONCURRENT_EXTRACTIONS) await new Promise(r => extractionWaiters.push(r));
    activeExtractions++;
    try { return await fn(); }
    finally {
        activeExtractions--;
        const next = extractionWaiters.shift();
        if (next) next();
    }
}
export async function extractEmbeddedArt(song) {
    if (!song?.id || !song?.url) return null;
    if (inFlightExtractions.has(song.id)) return inFlightExtractions.get(song.id);
    const promise = runGated(() => extractEmbeddedArtUncached(song)).finally(() => {
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

// ---- Locating a cover without reading or decoding the file's first megabytes ----------------
// The readers above fetch up to 3 MB, decode it byte by byte in JS, copy the picture out and
// encode it back to base64 in JS to write it. For an M4A with no cover (or a moov at the front) the
// tail search then read and decoded up to 6 MB and 24 MB more. Done for every song during a first
// load, that was tens of MB of short-lived strings and arrays at a time, which is the most likely
// reason loading could end in a memory kill.
//
// These work out where the picture is from a few small reads of the box/block headers, and the
// picture itself is then copied as the base64 the system already produces (no JS decoding or
// encoding at all). The file written is byte-for-byte the one the readers above produce; any
// file these are not sure about returns null and falls back to those readers.
function makeWindowReader(uri, windowSize) {
    let wPos = -1, wBuf = null;
    return async (pos, len) => {
        if (wBuf && pos >= wPos && pos + len <= wPos + wBuf.length) return wBuf.subarray(pos - wPos, pos - wPos + len);
        const b = await readBytes(uri, { position: pos, length: Math.max(len, windowSize) });
        wPos = pos; wBuf = b;
        return b.subarray(0, Math.min(len, b.length));
    };
}
function b64ByteLength(b64) {
    const pad = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
    return Math.floor(b64.length * 3 / 4) - pad;
}
async function readRangeAsBase64(uri, position, length) {
    const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64, position, length });
    return b64ByteLength(b64) === length ? b64 : null;
}

// FLAC: walk the metadata block headers to the first PICTURE block. Same limits as
// extractPictureFromFlac (nothing past the first FRONT_PREFIX_BYTES counts).
// Returns { found: false } (no usable picture), { found: true, mime, start, length }, or null (unsure).
async function locateFlacPicture(uri, fileSize, noLimit = false) {
    // `noLimit` (the end-of-loading pass for large covers) looks through the whole file; the normal pass keeps the old 3 MB window.
    const limit = noLimit ? (fileSize > 0 ? fileSize : FRONT_PREFIX_BYTES) : (fileSize > 0 ? Math.min(FRONT_PREFIX_BYTES, fileSize) : FRONT_PREFIX_BYTES);
    const get = makeWindowReader(uri, 4096);
    let start = 0;
    const head = await get(0, 10);
    if (limit > 10 && head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
        start = 10 + (((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f));
    }
    if (limit < start + 4) return { found: false, limited: limit < fileSize };
    const magic = await get(start, 4);
    if (magic.length < 4 || magic[0] !== 0x66 || magic[1] !== 0x4C || magic[2] !== 0x61 || magic[3] !== 0x43) return { found: false };
    let offset = start + 4;
    for (let n = 0; n < 4096 && offset + 4 <= limit; n++) {
        const h = await get(offset, 4);
        if (h.length < 4) return { found: false };
        const isLast = (h[0] & 0x80) !== 0;
        const blockType = h[0] & 0x7f;
        const blockLen = readU24BE(h, 1);
        const blockStart = offset + 4;
        if (blockType === 6) {
            if (blockStart + blockLen > limit) return { found: false, limited: limit < fileSize };
            const hb = await get(blockStart, Math.min(blockLen, 2048));
            let p = 4;
            if (p + 4 > hb.length) return null;
            const mimeLen = readU32BE(hb, p); p += 4;
            if (mimeLen > 64) return { found: false };
            if (p + mimeLen + 4 > hb.length) return null;
            const mime = String.fromCharCode(...hb.slice(p, p + mimeLen)); p += mimeLen;
            const descLen = readU32BE(hb, p); p += 4 + descLen;
            p += 16;
            if (p + 4 > hb.length) return null;
            const dataLen = readU32BE(hb, p); p += 4;
            if (dataLen <= 0) return { found: false };
            if (blockStart + p + dataLen > limit) return { found: false, limited: limit < fileSize };
            return { found: true, mime, start: blockStart + p, length: dataLen };
        }
        offset = blockStart + blockLen;
        if (isLast) return { found: false };   // walked every block: there is no picture
    }
    // Ran out of the window before the last block: a picture could be further on.
    return { found: false, limited: limit < fileSize };
}

// M4A/MP4: hop moov -> udta -> meta -> ilst -> covr -> data. The moov can be anywhere in the
// file (front, or after the audio), the picture is not read at all while looking for it.
// Same result as extractPictureFromMp4 / the tail search together, found in a few reads.
async function locateMp4Picture(uri, fileSize, maxLen = 20 * 1024 * 1024) {
    if (!(fileSize > 0)) return null;
    const get = makeWindowReader(uri, 16384);
    const BAD = { bad: true };
    const header = async (pos, end) => {
        const h = await get(pos, 16);
        if (h.length < 8) return BAD;
        let size = readU32BE(h, 0), hdr = 8;
        const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
        if (size === 1) {
            if (h.length < 16 || pos + 16 > end) return BAD;
            size = readU32BE(h, 12); hdr = 16;
        }
        if (size < hdr) return { type, zero: size === 0 };
        return { type, start: pos, hdr, size, dataStart: pos + hdr, dataEnd: Math.min(pos + size, end), trueEnd: pos + size };
    };
    // 'absent' = the range ended with no such box; null = anything odd (let the full reader decide).
    const find = async (start, end, type, top) => {
        let p = start;
        for (let i = 0; i < 400; i++) {
            if (p + 8 > end) return 'absent';
            const b = await header(p, end);
            if (b === BAD) return null;
            if (b.size === undefined) return (top && b.zero && b.type !== type) ? 'absent' : null;
            if (b.type === type) return b;
            p += b.size;
        }
        return null;
    };
    const moov = await find(0, fileSize, 'moov', true); if (moov === null) return null; if (moov === 'absent') return { found: false };
    const udta = await find(moov.dataStart, moov.dataEnd, 'udta'); if (udta === null) return null; if (udta === 'absent') return { found: false };
    const meta = await find(udta.dataStart, udta.dataEnd, 'meta'); if (meta === null) return null; if (meta === 'absent') return { found: false };
    const ilst = await find(meta.dataStart + 4, meta.dataEnd, 'ilst'); if (ilst === null) return null; if (ilst === 'absent') return { found: false };
    const covr = await find(ilst.dataStart, ilst.dataEnd, 'covr'); if (covr === null) return null; if (covr === 'absent') return { found: false };
    const data = await find(covr.dataStart, covr.dataEnd, 'data'); if (data === null) return null; if (data === 'absent') return { found: false };
    if (data.trueEnd !== data.dataEnd) return null;
    const payloadStart = data.dataStart + 8;
    const length = data.dataEnd - payloadStart;
    if (length <= 0) return { found: false };
    if (length > maxLen) return { found: false, limited: true };
    const first = await get(payloadStart, 2);
    if (first.length < 2) return null;
    return { found: true, mime: (first[0] === 0xFF && first[1] === 0xD8) ? 'image/jpeg' : 'image/png', start: payloadStart, length };
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

        // Fast path first (see "Locating a cover" above). `located` null = not sure: the original
        // readers below then run exactly as before.
        let located = null;
        if (ext === 'flac') located = await locateFlacPicture(song.url, fp?.size);
        else if (ext === 'm4a' || ext === 'mp4' || ext === 'alac') located = await locateMp4Picture(song.url, fp?.size);
        if (located?.found) {
            const b64 = await readRangeAsBase64(song.url, located.start, located.length);
            if (b64) picture = { mime: located.mime, b64, length: located.length };
            else located = null;   // the file did not give back what its headers promised: use the full readers
        }
        if (located) {
            // nothing more to do: no picture, or already read above
        } else if (ext === 'flac') {
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

        if (!(picture?.b64 ? picture.length > 0 : picture?.data?.length)) {
            // `bc`: the file was looked through completely (no size limit was hit), so the
            // end-of-loading pass for large covers has nothing to re-check here.
            await saveCacheEntry(song.id, located && located.found === false && !located.limited ? { uri: null, fp, bc: 1 } : { uri: null, fp });
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
        const dest = `${ART_DIR}${hashKey(song.id)}_${hashKey(fpTag)}.${fileExt}`;
        await FileSystem.writeAsStringAsync(dest, picture.b64 ?? bytesToBase64(picture.data), { encoding: FileSystem.EncodingType.Base64 });
        // The small list copy is made right away: a row that shows this cover for the first time used to be
        // handed the full-size picture (often thousands of pixels wide, tens of MB once decoded) and only got
        // the small one later. Many such rows at once while a library loads is a memory spike.
        await makeListThumbNow(dest);
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


// ---- Large covers, looked at last --------------------------------------------------------------
// The normal pass skips pictures that start or end past the first 3 MB (FLAC) or are over 20 MB (M4A),
// to keep memory low while the whole library loads. Once everything else is done, this goes back
// for them one at a time: the picture is copied file-to-file by the system in small pieces (it never
// goes through a JS string), then the small list copy is made from it.
const MAX_LARGE_PICTURE_BYTES = 80 * 1024 * 1024;
const artListeners = new Set();
// cb(songId, listUri, fullUri) is called when a cover turns up later than the lists first asked for it.
export function subscribeArtUpdates(cb) { artListeners.add(cb); return () => artListeners.delete(cb); }

const extOfSong = (song) => (song.filename || song.id || '').split('.').pop().toLowerCase();
const LARGE_ART_EXT = new Set(['flac', 'm4a', 'mp4', 'alac']);

// Songs checked with no cover whose file has not yet been looked through completely.
export async function listLargeArtCandidates(songs) {
    const cache = await loadCacheMap();
    const out = [];
    for (const song of songs || []) {
        if (!song?.id || !LARGE_ART_EXT.has(extOfSong(song))) continue;
        const entry = cache[song.id];
        if (entry !== undefined && (entry.uri ?? null) === null && !entry.bc) out.push(song);
    }
    return out;
}

export async function extractLargeEmbeddedArt(song) {
    try {
        const cache = await loadCacheMap();
        const entry = cache[song.id];
        if (!entry || (entry.uri ?? null) !== null || entry.bc) return entry?.uri ?? null;
        const fp = await getFingerprint(song.url);
        if (entry.fp && fp && !fingerprintsMatch(entry.fp, fp)) return null;   // the file changed: the normal pass will redo it
        const ext = extOfSong(song);
        const located = ext === 'flac'
            ? await locateFlacPicture(song.url, fp?.size, true)
            : await locateMp4Picture(song.url, fp?.size, MAX_LARGE_PICTURE_BYTES);
        if (located === null) return null;   // unsure: leave it unmarked, nothing is lost
        if (!located.found || located.length > MAX_LARGE_PICTURE_BYTES) {
            await saveCacheEntry(song.id, { uri: null, fp, bc: 1 });
            return null;
        }
        await FileSystem.makeDirectoryAsync(ART_DIR, { intermediates: true }).catch(() => { });
        const fileExt = located.mime?.includes('png') ? 'png' : 'jpg';
        const fpTag = fp ? `${fp.size}_${fp.mtime}` : 'nofp';
        const dest = `${ART_DIR}${hashKey(song.id)}_${hashKey(fpTag)}.${fileExt}`;
        const ok = await AudioEngine.copyFileRange(song.url, located.start, located.length, dest);
        if (!ok) return null;   // could not copy (or an older build without the copy call): try again next time
        await makeListThumbNow(dest);
        await saveCacheEntry(song.id, { uri: dest, fp, bc: 1 });
        const shown = listArtUri(dest);
        for (const cb of artListeners) { try { cb(song.id, shown, dest); } catch { } }
        return dest;
    } catch (e) {
        console.error('extractLargeEmbeddedArt:', e);
        return null;
    }
}
