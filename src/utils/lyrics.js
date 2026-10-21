import * as FileSystem from 'expo-file-system';
import { createBoundedCache } from './boundedCache';

// Standard LRC timestamp tag: [mm:ss.xx] or [mm:ss:xx], fraction 1-3
// digits (spaces inside the brackets and 3-digit minutes are tolerated). A single
// line can carry more than one timestamp (repeated chorus lines commonly do) —
// each becomes its own entry pointing at the same text.
const TIME_TAG = /\[\s*(\d{1,3}):(\d{1,2})(?:[.:,](\d{1,3}))?\s*\]/g;
// Per-word times of "enhanced" LRC, e.g. <00:12.34>: not shown, only removed.
const WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:,]\d{1,3})?>/g;
// [offset:+250] shifts every line by that many milliseconds (positive = sooner).
const OFFSET_TAG = /^\s*\[\s*offset\s*:\s*([+-]?\d+)\s*\]/i;

function parseLRC(text) {
    const lines = text.split(/\r\n|\r|\n/);
    const entries = [];
    let offsetSec = 0;
    for (const line of lines) {
        const om = line.replace(/^\uFEFF/, '').match(OFFSET_TAG);
        if (om) { offsetSec = parseInt(om[1], 10) / 1000; continue; }
        const matches = [...line.matchAll(TIME_TAG)];
        if (!matches.length) continue; // metadata tag ([ar:...], [ti:...]) or blank — skip
        const content = line.replace(TIME_TAG, '').replace(WORD_TAG, '').trim();
        for (const m of matches) {
            const min = parseInt(m[1], 10);
            const sec = parseInt(m[2], 10);
            // Fraction can be 1-3 digits (.3, .34, .345) — pad to
            // milliseconds so e.g. ".3" means 300ms, not 3ms.
            const frac = parseInt((m[3] || '0').padEnd(3, '0'), 10) / 1000;
            entries.push({ time: min * 60 + sec + frac, text: content });
            // (offset applied below once the whole file has been read)
        }
    }
    if (offsetSec) for (const e of entries) e.time = Math.max(0, e.time - offsetSec);
    entries.sort((a, b) => a.time - b.time);
    return entries;
}

// In-memory only, not persisted — .lrc files are tiny text, re-parsing one
// is cheap. This just avoids re-reading the same file repeatedly while
// flipping between a few songs in one session. Keyed by song.id. Capped so a
// long session spent playing through a big library doesn't hold every
// synced-lyrics array (some can be a few hundred timed lines) in memory for
// the rest of the app's life — 40 is generous for "the songs you've had
// open recently."
const memCache = createBoundedCache(40);

// Synchronous cache check, no file I/O — lets a caller (PlayerScreen, on
// mount/track-change) know the answer immediately if this song's lyrics
// were already resolved earlier this session, instead of always waiting a
// tick on getLyrics()'s promise even for a pure cache hit. Returns
// undefined if unknown (never checked, or evicted), so the caller can tell
// "no lyrics" (null) apart from "haven't looked yet".
export function peekLyrics(songId) {
    if (!songId || !memCache.has(songId)) return undefined;
    return memCache.get(songId);
}

// Returns a sorted array of { time (seconds), text } entries, or null if
// there's no matching .lrc file (or it has no parseable timed lines).
// Looks for a sibling file with the same name, .lrc extension, next to the
// audio file — song.url already has whatever URI-encoding the audio file
// itself needed (see files.js's encodeFileUrl), so deriving from it rather
// than song.id keeps that encoding intact instead of needing to redo it.
export async function getLyrics(song) {
    if (!song?.id || !song?.url) return null;
    if (memCache.has(song.id)) return memCache.get(song.id);
    try {
        const lrcUrl = song.url.replace(/\.[a-zA-Z0-9]+$/, '.lrc');
        const info = await FileSystem.getInfoAsync(lrcUrl);
        if (!info.exists) {
            memCache.set(song.id, null);
            return null;
        }
        const text = await FileSystem.readAsStringAsync(lrcUrl, { encoding: FileSystem.EncodingType.UTF8 });
        const entries = parseLRC(text);
        const result = entries.length ? entries : null;
        memCache.set(song.id, result);
        return result;
    } catch {
        // A read that failed is not "this song has no lyrics". Caching null
        // here made a transient error (or opening the song before its .lrc
        // had finished appearing) permanent for the rest of the session, so
        // the same file was never looked at again. Only the confirmed-absent
        // path above caches null.
        return null;
    }
}

// Index of the current line for a given playback position — the last
// entry whose timestamp has passed, or -1 before the first timed line.
// Entries are already sorted, and LRC files are small (tens to a couple
// hundred lines), so a plain scan is plenty fast — no need for a binary
// search here.
export function activeLyricIndex(entries, positionSec) {
    if (!entries?.length) return -1;
    let idx = -1;
    for (let i = 0; i < entries.length; i++) {
        if (entries[i].time <= positionSec) idx = i;
        else break;
    }
    return idx;
}
