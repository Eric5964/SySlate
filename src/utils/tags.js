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

// v3: bumped from v1 after two rounds of real bugs in the extraction logic
// itself (FLAC/ID3 multi-artist fields were being collapsed to just the
// first artist, then the same class of bug found in the M4A reader too) —
// the cache is keyed by file fingerprint, so an unchanged file keeps
// serving its old (bad) cached result forever regardless of how many times
// the parsing code gets fixed. Bumping the key is what actually forces a
// clean re-extraction; fixing the parser alone does nothing for a song
// that was already scanned once. Bump again any time the extraction logic
// itself changes in a way that should apply to already-scanned libraries.
// v6: M4A files whose tag box ('moov') sits at the END of the file (normal for
// files not made "fast start", e.g. many downloads/conversions) used to come
// back with no tags at all, because only the first 1 MB was ever read; the
// song then showed the artist/title guessed from its file name. They are read
// properly now, and this bump makes already-scanned libraries redo it.
const CACHE_KEY = 'song_tags_cache_v6';
const FRONT_PREFIX_BYTES = 1 * 1024 * 1024; // tags live at the front for every format handled here

let cacheMapPromise = null;
async function loadCacheMap() {
    if (!cacheMapPromise) {
        cacheMapPromise = AsyncStorage.getItem(CACHE_KEY).then(v => v ? JSON.parse(v) : {}).catch(() => ({}));
    }
    return cacheMapPromise;
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
    cacheMapPromise = Promise.resolve(map);
    schedulePersist(() => map);
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
    // Hermes (React Native's JS engine) has no TextDecoder, so decode by hand.
    // The old fallback treated every byte as its own character, which turned
    // emoji and accented letters into garbage symbols.
    let out = '';
    const n = bytes.length;
    let i = 0;
    while (i < n) {
        const b = bytes[i];
        let cp = 0xFFFD, len = 1;
        if (b < 0x80) { cp = b; }
        else if (b >= 0xC2 && b < 0xE0 && i + 1 < n && (bytes[i + 1] & 0xC0) === 0x80) {
            cp = ((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F); len = 2;
        } else if (b >= 0xE0 && b < 0xF0 && i + 2 < n && (bytes[i + 1] & 0xC0) === 0x80 && (bytes[i + 2] & 0xC0) === 0x80) {
            cp = ((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F); len = 3;
        } else if (b >= 0xF0 && b < 0xF5 && i + 3 < n && (bytes[i + 1] & 0xC0) === 0x80 && (bytes[i + 2] & 0xC0) === 0x80 && (bytes[i + 3] & 0xC0) === 0x80) {
            cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F); len = 4;
        }
        if (cp > 0x10FFFF) cp = 0xFFFD;
        if (cp >= 0x10000) { cp -= 0x10000; out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); }
        else out += String.fromCharCode(cp);
        i += len;
    }
    return out;
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
        else if (key === 'REPLAYGAIN_TRACK_GAIN' && out.rgDb === undefined) { const g = parseFloat(val); if (isFinite(g)) out.rgDb = g; }
        else if (key === 'REPLAYGAIN_TRACK_PEAK' && out.rgPeak === undefined) { const g = parseFloat(val); if (isFinite(g) && g > 0) out.rgPeak = g; }
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
        else if (id === 'TXXX') {
            // User text frame: description, then value (ReplayGain lives here).
            const vals = decodeId3TextMulti(bytes.slice(frameStart, frameStart + size));
            if (vals.length >= 2) {
                const key = String(vals[0]).toUpperCase();
                const g = parseFloat(vals[1]);
                if (key === 'REPLAYGAIN_TRACK_GAIN' && out.rgDb === undefined && isFinite(g)) out.rgDb = g;
                else if (key === 'REPLAYGAIN_TRACK_PEAK' && out.rgPeak === undefined && isFinite(g) && g > 0) out.rgPeak = g;
            }
        }
        p = frameStart + size;
    }
    return Object.keys(out).length ? out : null;
}

// Finds the 'moov' box of an MP4/M4A anywhere in the file by hopping from
// box to box (each hop reads only a 16-byte header), then reads that box.
// Returns the bytes starting at the moov header, or null.
async function readMp4MoovBytes(url) {
    let pos = 0;
    for (let i = 0; i < 40; i++) {
        const head = await readBytes(url, { position: pos, length: 16 });
        if (!head || head.length < 8) return null;
        let size = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
        const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
        let hdr = 8;
        if (size === 1) {
            if (head.length < 16) return null;
            const hi = ((head[8] << 24) | (head[9] << 16) | (head[10] << 8) | head[11]) >>> 0;
            const lo = ((head[12] << 24) | (head[13] << 16) | (head[14] << 8) | head[15]) >>> 0;
            size = hi * 4294967296 + lo;
            hdr = 16;
        }
        if (type === 'moov') {
            const len = size === 0 ? 8 * 1024 * 1024 : Math.min(size, 8 * 1024 * 1024);
            return await readBytes(url, { position: pos, length: len });
        }
        if (size < hdr) return null;   // a box that runs to the end of the file, or a broken size
        pos += size;
    }
    return null;
}

// A big cover picture stored BEFORE the text tags pushes them past the first 1 MB, so the quick read
// finds nothing. These two walk the file header by header with small reads, skip the big blocks,
// and read only the few text frames that matter.
async function readFlacTagsBySeeking(url) {
    let pos = 0;
    const id3 = await readBytes(url, { position: 0, length: 10 });
    if (id3.length >= 10 && id3[0] === 0x49 && id3[1] === 0x44 && id3[2] === 0x33) pos = 10 + readSynchsafe32(id3, 6);
    const magic = await readBytes(url, { position: pos, length: 4 });
    if (magic.length < 4 || magic[0] !== 0x66 || magic[1] !== 0x4C || magic[2] !== 0x61 || magic[3] !== 0x43) return null;
    pos += 4;
    for (let i = 0; i < 64; i++) {
        const h = await readBytes(url, { position: pos, length: 4 });
        if (h.length < 4) return null;
        const isLast = (h[0] & 0x80) !== 0;
        const type = h[0] & 0x7f;
        const len = readU24BE(h, 1);
        if (type === 4) {
            if (len > 4 * 1024 * 1024) return null;
            const body = await readBytes(url, { position: pos + 4, length: len });
            return parseVorbisCommentBlock(body, 0, body.length);
        }
        if (isLast) return null;
        pos += 4 + len;
    }
    return null;
}
async function readId3TagsBySeeking(url) {
    const head = await readBytes(url, { position: 0, length: 10 });
    if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null;
    const major = head[3];
    const tagEnd = 10 + readSynchsafe32(head, 6);
    let pos = 10;
    if (head[5] & 0x40) {   // extended header: skip it
        const ext = await readBytes(url, { position: pos, length: 4 });
        if (ext.length < 4) return null;
        const extSize = major >= 4 ? readSynchsafe32(ext, 0) : readU32BE(ext, 0);
        pos += extSize > 0 ? extSize : 4;
    }
    const wanted = new Set(['TIT2', 'TPE1', 'TALB', 'TRCK', 'TXXX']);
    const parts = [];
    let total = 0;
    for (let i = 0; i < 300 && pos + 10 <= tagEnd; i++) {
        const h = await readBytes(url, { position: pos, length: 10 });
        if (h.length < 10) break;
        const id = String.fromCharCode(h[0], h[1], h[2], h[3]);
        if (id === '\0\0\0\0') break;
        const size = major >= 4 ? readSynchsafe32(h, 4) : readU32BE(h, 4);
        if (size <= 0 || pos + 10 + size > tagEnd) break;
        if (wanted.has(id) && size <= 65536) {
            const body = await readBytes(url, { position: pos + 10, length: size });
            parts.push(h, body);
            total += 10 + size;
        }
        pos += 10 + size;
    }
    if (!parts.length) return null;
    const out = new Uint8Array(10 + total);
    out.set([0x49, 0x44, 0x33, major, 0, 0, (total >> 21) & 0x7f, (total >> 14) & 0x7f, (total >> 7) & 0x7f, total & 0x7f], 0);
    let o = 10;
    for (const part of parts) { out.set(part, o); o += part.length; }
    return extractTagsFromId3(out);
}
async function extractTagsUncached(song) {
    if (!song?.id || !song?.url) return null;
    try {
        const ext = (song.filename || song.id || '').split('.').pop().toLowerCase();
        const bytes = await readBytes(song.url, { position: 0, length: FRONT_PREFIX_BYTES });
        if (ext === 'flac') return extractTagsFromFlac(bytes) || await readFlacTagsBySeeking(song.url);
        if (ext === 'm4a' || ext === 'mp4' || ext === 'alac') {
            const front = extractTagsFromMp4(bytes);
            if (front) return front;
            // Not in the first 1 MB: the tag box may be at the end of the file.
            const moov = await readMp4MoovBytes(song.url);
            return moov ? extractTagsFromMp4(moov) : null;
        }
        if (ext === 'mp3') {
            const quick = extractTagsFromId3(bytes);
            if (quick?.title) return quick;
            const hasId3 = bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
            if (!hasId3 || 10 + readSynchsafe32(bytes, 6) <= bytes.length) return quick;   // the whole tag was already in view
            return (await readId3TagsBySeeking(song.url)) || quick;
        }
        if (ext === 'opus' || ext === 'ogg') return extractTagsFromOgg(bytes);
        return null; // wav / aiff / aac / wma / ape — not handled yet, see file header
    } catch (e) {
        // Not swallowed here: a file that could not be READ must not be cached as
        // "has no tags" (extractTags below skips the cache write on a throw).
        console.error('extractTags:', song?.filename, e);
        throw e;
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
        if (fp) await saveCacheEntry(song.id, { tags, fp });   // no fingerprint = file unreadable right now: try again next scan
        return tags;
    } catch (e) {
        console.error('extractTags:', song?.filename, e);
        return null;
    }
}
