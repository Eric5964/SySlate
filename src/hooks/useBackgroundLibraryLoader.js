import { useEffect, useRef } from 'react';
import { AppState, InteractionManager } from 'react-native';
import { extractEmbeddedArt, getCachedArt, listLargeArtCandidates, extractLargeEmbeddedArt } from '../utils/embeddedArt';
import { waitForBackgroundClear } from '../utils/memoryPressure';
import { extractTags, getCachedTags, tagReadFailed } from '../utils/tags';

// Was two entirely separate hooks (useBackgroundArtLoader, then
// useBackgroundTagLoader added alongside it) — each independently scheduling
// its own InteractionManager wait, its own staggered burst loop, its own
// AppState listener. Running both concurrently roughly DOUBLED the sustained
// background CPU/file-I/O work versus what BATCH_SIZE/EXTRACTION_STAGGER_MS
// were actually tuned for (BATCH_SIZE was already brought down from 150 to
// 15 after a confirmed CPU-limit kill on art extraction ALONE) — almost
// certainly the real cause of the app generally feeling slower/choppier
// after tag reading was added: two competing background workers instead of
// one, right as list screens and gestures are also trying to use the same
// JS thread. Merged back into one worker so the total budget (BATCH_SIZE
// real extractions per burst, whether art, tags, or a mix of both) stays
// where it was already proven safe, whichever kinds of work are enabled.
const BATCH_SIZE = 15;
const EXTRACTION_STAGGER_MS = 75;
const BURST_PAUSE_MS = 4000;
const YIELD_EVERY = 20;

export function useBackgroundLibraryLoader(songs, { art = false, tags = false, onTagsRead = null } = {}) {
    const chainRef = useRef(Promise.resolve());   // runs go one after another; a cancelled one ends quickly
    const onTagsReadRef = useRef(onTagsRead);
    const tagsReadRef = useRef(0);   // tags read by runs that were cancelled before they could report them
    onTagsReadRef.current = onTagsRead;

    useEffect(() => {
        if ((!art && !tags) || !songs?.length) return;
        let cancelled = false;
        let appActive = AppState.currentState === 'active';
        const sub = AppState.addEventListener('change', (state) => { appActive = state === 'active'; });

        const run = async () => {
            try {
                let idx = 0;
                let checkedSinceYield = 0;
                while (!cancelled && idx < songs.length) {
                    if (!appActive) {
                        await new Promise(r => setTimeout(r, 2000));
                        continue;
                    }
                    await waitForBackgroundClear(() => cancelled);   // low on memory, rebuilding the lists, or a finger on the disc: wait
                    if (cancelled) break;
                    let doneInBurst = 0;
                    while (!cancelled && appActive && idx < songs.length && doneInBurst < BATCH_SIZE) {
                        if (!cancelled) await waitForBackgroundClear(() => cancelled);
                        if (cancelled) break;
                        const song = songs[idx++];
                        try {
                            if (art) {
                                const cachedArt = await getCachedArt(song);
                                if (cachedArt === undefined) {
                                    await extractEmbeddedArt(song);
                                    doneInBurst++;
                                    await new Promise(r => setTimeout(r, EXTRACTION_STAGGER_MS));
                                }
                            }
                            if (!cancelled && appActive && tags && doneInBurst < BATCH_SIZE) {
                                const cachedTags = await getCachedTags(song);
                                if (cachedTags === undefined && !tagReadFailed(song)) {
                                    await extractTags(song);
                                    if (!tagReadFailed(song)) tagsReadRef.current++;   // only reads that reached the cache count
                                    doneInBurst++;
                                    await new Promise(r => setTimeout(r, EXTRACTION_STAGGER_MS));
                                }
                            }
                        } catch { }
                        if (++checkedSinceYield >= YIELD_EVERY) {
                            checkedSinceYield = 0;
                            await new Promise(r => setTimeout(r, 0));
                        }
                    }
                    if (cancelled) break;
                    if (doneInBurst > 0) await new Promise(r => setTimeout(r, BURST_PAUSE_MS));
                }
                // Last: the covers too large for the normal pass (see extractLargeEmbeddedArt), one at a
                // time. Only once everything else has been looked at, and never while the app is in the
                // background or the system has said it is low on memory.
                if (!cancelled && art) {
                    const large = await listLargeArtCandidates(songs);
                    for (const song of large) {
                        if (cancelled) break;
                        while (!cancelled && !appActive) await new Promise(r => setTimeout(r, 2000));
                        await waitForBackgroundClear(() => cancelled);
                        if (cancelled) break;
                        try { await extractLargeEmbeddedArt(song); } catch { }
                        await new Promise(r => setTimeout(r, 120));
                    }
                }
                // The tags read here only reach the lists through a new scan (the scan is what
                // applies them), which used to happen only at the next launch.
                if (!cancelled && tagsReadRef.current > 0) { const n = tagsReadRef.current; tagsReadRef.current = 0; onTagsReadRef.current?.(n); }
            } catch { }
        };

        const task = InteractionManager.runAfterInteractions(() => {
            if (cancelled) return;
            // Before: a new list (rescan, Import Songs) or a settings change that arrived while a pass
            // was still running was dropped, so the new songs never got tags or covers until restart.
            chainRef.current = chainRef.current.then(() => (cancelled ? undefined : run()));
        });
        return () => { cancelled = true; sub.remove(); task.cancel(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [art, tags, songs]);
}
