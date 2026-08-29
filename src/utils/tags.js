import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Reads real embedded metadata (title/artist/album/track number) directly
// from the file — the FLAC VORBIS_COMMENT block, MP4 'ilst' text atoms,
// ID3v2 text frames, and the Ogg Vorbis/Opus comment header — with the same
// hand-rolled binary parsing embeddedArt.js already uses for cover art, for
// the same reasons: no Buffer/stream polyfills, no new native dependency,
// small footprint. Where these fail or find nothing, files.js's existing
// filename-based parsing is still the fallback — this only overrides fields
// it actually found a real value for.
//
// LIMITATIONS (v1):
// - WAV, AIFF, WMA, and APE aren't handled — filename parsing only for
//   those, same as before this file existed.
// - ID3v2 "unsynchronisation" (flag bit in the tag header) isn't undone
//   before parsing frames. Rare in modern rips; if set, frame text can come
//   out with stray bytes. Worth revisiting if it turns out to matter.
// - Ogg Vorbis/Opus comment headers that spill across more than one Ogg
//   page (unusually large comment blocks) aren't reassembled — only the
//   contiguous bytes right after the comment marker are parsed. Fine for
//   ordinary tags, could miss/truncate on a file with e.g. embedded lyrics
//   crammed into a comment field.
// - UTF-16 ID3v2 frames are decoded assuming the BOM correctly signals
//   endianness; a frame with no BOM at all falls back to big-endian.

const CACHE_KEY = 'song_tags_cache_v1';
const FRONT_PREFIX_BYTES = 1 * 1024 * 1024; // tags live at the front for every format handled here

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
async function readBytes(uri, options) {
    const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64, ...options });
    return base64ToBytes(b64);
}

function readU32BE(bytes, o) { return ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0; }
function readU32LE(bytes, o) { return ((bytes[o + 3] << 24) | (bytes[o + 2] << 16) | (bytes[o + 1] << 8) | bytes[o]) >>> 0; }
function readU24BE(bytes, o) { return ((bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2]) >>> 0; }
function readSynchsafe32(bytes, o) { return ((bytes[o] & 0x7f) << 21) | ((bytes[o + 1] & 0x7f) << 14) | ((bytes[o + 2] & 0x7f) << 7) | (bytes[o + 3] & 0x7f); }

function utf8Decode(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); } catch { }
    // Fallback if TextDecoder isn't available in this JS engine — plain
    // decode, good enough for ASCII-range tag text.
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
}
function utf16Decode(bytes) {
    if (bytes.length < 2) return '';
    const be = !(bytes[0] === 0xFF && bytes[1] === 0xFE); // BOM FE FF = BE, FF FE = LE; default BE
    const start = (bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF) ? 2 : 0;
    let out = '';
    for (let i = start; i + 1 < bytes.length; i += 2) {
        const code = be ? (bytes[i] << 8) | bytes[i + 1] : (bytes[i + 1] << 8) | bytes[i];
        if (code === 0) break;
        out += String.fromCharCode(code);
    }
    return out;
}
function latin1Decode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) break;
        out += String.fromCharCode(bytes[i]);
    }
    return out;
}

// ID3v2.4 allows a single text frame to hold SEVERAL values separated by a
// null terminator (0x00, or the wide 0x00 0x00 for UTF-16) — this is how a
// multi-artist TPE1 frame is actually supposed to be tagged, rather than
// one value with a delimiter character baked in. Splits on that null
// separator first, then decodes each resulting segment. A frame with just
// one value (the common case) comes back as a single-element array, same
// as always.
function splitOnNulls(bytes, wide) {
    const parts = [];
    let start = 0;
    if (wide) {
        for (let i = 0; i + 1 < bytes.length; i += 2) {
            if (bytes[i] === 0 && bytes[i + 1] === 0) { parts.push(bytes.slice(start, i)); start = i + 2; }
        }
    } else {
        for (let i = 0; i < bytes.length; i++) {
            if (bytes[i] === 0) { parts.push(bytes.slice(start, i)); start = i + 1; }
        }
    }
    parts.push(bytes.slice(start));
    return parts.filter(p => p.length > 0);
}
function decodeId3TextMulti(bytes) {
    if (!bytes.length) return [];
    const enc = bytes[0];
    const body = bytes.slice(1);
    if (enc === 0) return splitOnNulls(body, false).map(latin1Decode);
    if (enc === 3) return splitOnNulls(body, false).map(utf8Decode);
    // UTF-16 (1 = with BOM, 2 = BE without BOM) — strip a leading BOM once,
    // then split/decode as wide chars.
    let b = body, be = enc === 2;
    if (enc === 1 && b.length >= 2) {
        if (b[0] === 0xFF && b[1] === 0xFE) { be = false; b = b.slice(2); }
        else if (b[0] === 0xFE && b[1] === 0xFF) { be = true; b = b.slice(2); }
    }
    return splitOnNulls(b, true).map(seg => {
        let out = '';
        for (let i = 0; i + 1 < seg.length; i += 2) {
            const code = be ? (seg[i] << 8) | seg[i + 1] : (seg[i + 1] << 8) | seg[i];
            out += String.fromCharCode(code);
        }
        return out;
    });
}

// --- FLAC: VORBIS_COMMENT metadata block (type 4) ----------------------
// Same little-endian-length comment format as Ogg Vorbis/Opus below — FLAC
// embeds the identical structure directly as a metadata block instead of
// wrapping it in Ogg page framing.
function parseVorbisCommentBlock(bytes, offset, end) {
    let p = offset;
    if (p + 4 > end) return null;
    const vendorLen = readU32LE(bytes, p); p += 4 + vendorLen;
    if (p + 4 > end) return null;
    const count = readU32LE(bytes, p); p += 4;
    const out = {};
    const artists = [];
    for (let i = 0; i < count && p + 4 <= end; i++) {
        const len = readU32LE(bytes, p); p += 4;
        if (p + len > end) break;
        const entry = utf8Decode(bytes.slice(p, p + len));
        p += len;
        const eq = entry.indexOf('=');
        if (eq === -1) continue;
        const key = entry.slice(0, eq).toUpperCase();
        const val = entry.slice(eq + 1);
        if (key === 'TITLE' && !out.title) out.title = val;
        // Vorbis comments represent multiple artists as several REPEATED
        // ARTIST= fields (the standard convention — MusicBrainz Picard and
        // most FLAC-focused taggers write it this way), not one field with
        // a delimiter baked in. Collecting every occurrence here instead of
        // keeping only the first is what actually makes multi-artist
        // splitting work for FLAC/Opus/OGG — previously this silently
        // dropped every artist past the first.
        else if (key === 'ARTIST' && val) artists.push(val);
        else if (key === 'ALBUM' && !out.album) out.album = val;
        else if (key === 'TRACKNUMBER' && !out.track) out.track = val;
    }
    if (artists.length === 1) out.artist = artists[0];
    else if (artists.length > 1) out.artists = artists;
    return out;
}

function extractTagsFromFlac(bytes) {
    let start = 0;
    if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
        start = 10 + readSynchsafe32(bytes, 6);
    }
    if (bytes.length < start + 4 || bytes[start] !== 0x66 || bytes[start + 1] !== 0x4C || bytes[start + 2] !== 0x61 || bytes[start + 3] !== 0x43) return null;
    let offset = start + 4;
    while (offset + 4 <= bytes.length) {
        const header = bytes[offset];
        const isLast = (header & 0x80) !== 0;
        const blockType = header & 0x7f;
        const blockLen = readU24BE(bytes, offset + 1);
        const blockStart = offset + 4;
        if (blockType === 4) { // VORBIS_COMMENT
            const blockEnd = Math.min(blockStart + blockLen, bytes.length);
            return parseVorbisCommentBlock(bytes, blockStart, blockEnd);
        }
        offset = blockStart + blockLen;
        if (isLast) break;
    }
    return null;
}

// --- Ogg Vorbis / Opus: comment header ----------------------------------
// Scans for the comment packet's marker directly rather than walking real
// Ogg page framing (segment tables etc.) — see the file-level limitations
// note for what that trades away.
function extractTagsFromOgg(bytes) {
    const markers = [
        { bytes: [0x4F, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], len: 8 }, // "OpusTags"
        { bytes: [0x03, 0x76, 0x6F, 0x72, 0x62, 0x69, 0x73], len: 7 },       // \x03 "vorbis"
    ];
    for (const m of markers) {
        for (let i = 0; i + m.len < bytes.length; i++) {
            let match = true;
            for (let j = 0; j < m.len; j++) if (bytes[i + j] !== m.bytes[j]) { match = false; break; }
            if (match) {
                const result = parseVorbisCommentBlock(bytes, i + m.len, bytes.length);
                if (result) return result;
            }
        }
    }
    return null;
}

// --- MP4/M4A/ALAC: iTunes-style 'ilst' atoms ----------------------------
function findAtom(bytes, start, end, fourcc) {
    let offset = start;
    while (offset + 8 <= end) {
        let size = readU32BE(bytes, offset);
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        let headerSize = 8;
        if (size === 1) {
            if (offset + 16 > end) return null;
            size = readU32BE(bytes, offset + 12);
            headerSize = 16;
        }
        if (size < headerSize) return null;
        if (type === fourcc) return { dataStart: offset + headerSize, dataEnd: Math.min(offset + size, end) };
        offset += size;
    }
    return null;
}
// Same walk as findAtom, but collects every sibling match instead of
// stopping at the first — needed for multi-artist M4A files. There's no
// single agreed-upon iTunes convention for representing several artists in
// one file (unlike Vorbis comments' clearly-standard repeated ARTIST=
// fields): some taggers write several 'data' children inside one '©ART'
// atom, others write several sibling '©ART' atoms outright. Handles both by
// collecting at both levels — see extractTagsFromMp4.
function findAllAtoms(bytes, start, end, fourcc) {
    const out = [];
    let offset = start;
    while (offset + 8 <= end) {
        let size = readU32BE(bytes, offset);
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        let headerSize = 8;
        if (size === 1) {
            if (offset + 16 > end) break;
            size = readU32BE(bytes, offset + 12);
            headerSize = 16;
        }
        if (size < headerSize) break;
        if (type === fourcc) out.push({ dataStart: offset + headerSize, dataEnd: Math.min(offset + size, end) });
        offset += size;
    }
    return out;
}
function readIlstTextAtom(bytes, ilst, fourcc) {
    const atom = findAtom(bytes, ilst.dataStart, ilst.dataEnd, fourcc);
    if (!atom) return null;
    const dataAtom = findAtom(bytes, atom.dataStart, atom.dataEnd, 'data');
    if (!dataAtom) return null;
    const payloadStart = dataAtom.dataStart + 8; // 4-byte type indicator + 4-byte locale
    if (payloadStart >= dataAtom.dataEnd) return null;
    return utf8Decode(bytes.slice(payloadStart, dataAtom.dataEnd));
}
// Collects text from every 'data' child of every matching parent atom —
// see findAllAtoms above for why both levels matter here specifically.
function readIlstTextAtomMulti(bytes, ilst, fourcc) {
    const out = [];
    for (const atom of findAllAtoms(bytes, ilst.dataStart, ilst.dataEnd, fourcc)) {
        for (const dataAtom of findAllAtoms(bytes, atom.dataStart, atom.dataEnd, 'data')) {
            const payloadStart = dataAtom.dataStart + 8;
            if (payloadStart >= dataAtom.dataEnd) continue;
            const text = utf8Decode(bytes.slice(payloadStart, dataAtom.dataEnd));
            if (text) out.push(text);
        }
    }
    return out;
}
function extractTagsFromMp4(bytes) {
    const moov = findAtom(bytes, 0, bytes.length, 'moov');
    if (!moov) return null;
    const udta = findAtom(bytes, moov.dataStart, moov.dataEnd, 'udta');
    if (!udta) return null;
    const meta = findAtom(bytes, udta.dataStart, udta.dataEnd, 'meta');
    if (!meta) return null;
    const ilst = findAtom(bytes, meta.dataStart + 4, meta.dataEnd, 'ilst');
    if (!ilst) return null;
    const out = {};
    const title = readIlstTextAtom(bytes, ilst, '\u00A9nam'); if (title) out.title = title;
    const artists = readIlstTextAtomMulti(bytes, ilst, '\u00A9ART');
    if (artists.length === 1) out.artist = artists[0];
    else if (artists.length > 1) out.artists = artists;
    const album = readIlstTextAtom(bytes, ilst, '\u00A9alb'); if (album) out.album = album;
    return Object.keys(out).length ? out : null;
}

// --- MP3: ID3v2 text frames ----------------------------------------------
function decodeId3Text(bytes) {
    if (!bytes.length) return '';
    const enc = bytes[0];
    const body = bytes.slice(1);
    if (enc === 0) return latin1Decode(body);
    if (enc === 1 || enc === 2) return utf16Decode(body);
    return utf8Decode(body).replace(/\0+$/, '');
}
function extractTagsFromId3(bytes) {
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null; // "ID3"
    const majorVersion = bytes[3];
    const flags = bytes[5];
    const tagSize = readSynchsafe32(bytes, 6);
    let p = 10;
    const tagEnd = Math.min(10 + tagSize, bytes.length);
    if (flags & 0x40) { // extended header present
        const extSize = majorVersion >= 4 ? readSynchsafe32(bytes, p) : readU32BE(bytes, p);
        p += extSize > 0 ? extSize : 4;
    }
    const out = {};
    while (p + 10 <= tagEnd) {
        const id = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
        if (id === '\0\0\0\0') break; // padding reached
        const size = majorVersion >= 4 ? readSynchsafe32(bytes, p + 4) : readU32BE(bytes, p + 4);
        const frameStart = p + 10;
        if (size <= 0 || frameStart + size > tagEnd) break;
        if (id === 'TIT2' && !out.title) out.title = decodeId3Text(bytes.slice(frameStart, frameStart + size));
        else if (id === 'TPE1' && !out.artist && !out.artists) {
            const vals = decodeId3TextMulti(bytes.slice(frameStart, frameStart + size));
            if (vals.length === 1) out.artist = vals[0];
            else if (vals.length > 1) out.artists = vals;
        }
        else if (id === 'TALB' && !out.album) out.album = decodeId3Text(bytes.slice(frameStart, frameStart + size));
        else if (id === 'TRCK' && !out.track) out.track = decodeId3Text(bytes.slice(frameStart, frameStart + size));
        p = frameStart + size;
    }
    return Object.keys(out).length ? out : null;
}

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(hash);
}

async function extractTagsUncached(song) {
    if (!song?.id || !song?.url) return null;
    try {
        const ext = (song.filename || song.id || '').split('.').pop().toLowerCase();
        const bytes = await readBytes(song.url, { position: 0, length: FRONT_PREFIX_BYTES });
        if (ext === 'flac') return extractTagsFromFlac(bytes);
        if (ext === 'm4a' || ext === 'mp4' || ext === 'alac') return extractTagsFromMp4(bytes);
        if (ext === 'mp3') return extractTagsFromId3(bytes);
        if (ext === 'opus' || ext === 'ogg') return extractTagsFromOgg(bytes);
        return null; // wav / aiff / aac / wma / ape — not handled yet, see file header
    } catch (e) {
        console.error('extractTags:', song?.filename, e);
        return null;
    }
}

// Cache-only lookup, mirroring embeddedArt.js's getCachedArt — no file read,
// just an AsyncStorage lookup plus one cheap stat call to confirm the file
// hasn't been replaced since. Returns the cached tags object, null
// (confirmed no readable tags, file unchanged since), or undefined (never
// processed, or the file changed — either way, needs a real extraction
// pass). Used by the background loader, where the stat cost is fine — it's
// not on any interactive path.
export async function getCachedTags(song) {
    if (!song?.id || !song?.url) return undefined;
    try {
        const cache = await loadCacheMap();
        const entry = cache[song.id];
        if (entry === undefined) return undefined;
        const fp = await getFingerprint(song.url);
        if (!fingerprintsMatch(entry.fp, fp)) return undefined;
        return entry.tags ?? null;
    } catch {
        return undefined;
    }
}

// No stat call at all — pure in-memory/AsyncStorage-map read. For anything
// on an interactive or scan-blocking path (library scan, list screens):
// those don't need to be the ones catching a replaced file, since the
// background loader (using getCachedTags above, which DOES stat) already
// does that continuously regardless of which screens get opened. A replaced
// file's tags show the old cached value until the background loader
// reaches it and re-extracts — same tradeoff already made for the scan
// itself, just applied consistently to the read side too.
export async function getCachedTagsFast(song) {
    if (!song?.id) return undefined;
    try {
        const cache = await loadCacheMap();
        const entry = cache[song.id];
        return entry === undefined ? undefined : (entry.tags ?? null);
    } catch {
        return undefined;
    }
}

// The real, expensive read+parse+cache-write. Only ever called from the
// background loader (or directly, if a caller genuinely needs a fresh
// result right now) — never from the scan path.
export async function extractTags(song) {
    if (!song?.id || !song?.url) return null;
    try {
        const fp = await getFingerprint(song.url);
        const tags = await extractTagsUncached(song);
        await saveCacheEntry(song.id, { tags, fp });
        return tags;
    } catch (e) {
        console.error('extractTags:', song?.filename, e);
        return null;
    }
}
