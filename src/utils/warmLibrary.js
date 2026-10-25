import { extractTags, getCachedTagsSync, preloadTagCache, tagReadFailed } from './tags';
import { waitForMemoryRelief } from './memoryPressure';

// Reads the tags (title / artist / album) of every song that has never been read, all at once,
// so a first launch or an import shows the real artists straight away instead of the single
// artist guessed from the file name.
//
// The background loader does the same work too, but only ~15 songs per 4 seconds, and the
// list was never rebuilt when it finished: that is why artists stayed wrong until a restart.
// This runs in front of a loading screen, with several files in flight at once.

const CONCURRENCY = 4;            // the JS thread is the limit; this keeps the file reads overlapped with it
const DEFAULT_BUDGET_MS = 25000;  // after this the rest is left to the background loader
const PROGRESS_EVERY_MS = 120;

// Songs whose tags were never read (the tag cache has no entry for them).
export async function listUnreadSongs(songs) {
    try { await preloadTagCache(); } catch { }
    const out = [];
    for (const s of songs || []) if (getCachedTagsSync(s) === undefined && !tagReadFailed(s)) out.push(s);
    return out;
}

// Resolves { done, total, finished }. `finished` is false when the time budget ran out or
// isCancelled() said stop; the songs not reached are simply picked up by the background loader.
export async function warmTags(songs, { onProgress, isCancelled, budgetMs = DEFAULT_BUDGET_MS } = {}) {
    const todo = await listUnreadSongs(songs);
    const total = todo.length;
    if (!total) return { done: 0, total: 0, finished: true };
    const started = Date.now();
    let next = 0, done = 0, lastReport = 0;
    const stop = () => (isCancelled?.() === true) || (Date.now() - started > budgetMs);
    const report = (force) => {
        const now = Date.now();
        if (!force && now - lastReport < PROGRESS_EVERY_MS) return;
        lastReport = now;
        try { onProgress?.(done, total); } catch { }
    };
    report(true);
    const worker = async () => {
        while (next < todo.length && !stop()) {
            await waitForMemoryRelief(stop);
            if (stop()) break;
            const song = todo[next++];
            try { await extractTags(song); } catch { }
            done++;
            report(false);
            // Let touches / drawing in between files (a no-op delay, not a throttle).
            if (done % 8 === 0) await new Promise(r => setTimeout(r, 0));
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
    report(true);
    return { done, total, finished: next >= todo.length };
}
