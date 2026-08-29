import { useEffect, useRef } from 'react';
import { AppState, InteractionManager } from 'react-native';
import { extractTags, getCachedTags } from '../utils/tags';

// Identical throttling to useBackgroundArtLoader, deliberately — same class
// of work (a file read + parse per song, run continuously in the
// background), same reason to stay slow and yield often: extraction work
// alone has already caused a real CPU-limit kill once in this app. This
// exists purely to warm the shared tag cache over time so real titles show
// up on the NEXT scan after this one, not to get through the library fast.
const BATCH_SIZE = 15;
const EXTRACTION_STAGGER_MS = 75;
const BURST_PAUSE_MS = 4000;
const YIELD_EVERY = 20;

export function useBackgroundTagLoader(songs, enabled) {
    const runningRef = useRef(false);

    useEffect(() => {
        if (!enabled || !songs?.length) return;
        if (runningRef.current) return;
        let cancelled = false;
        let appActive = AppState.currentState === 'active';
        const sub = AppState.addEventListener('change', (state) => { appActive = state === 'active'; });

        const run = async () => {
            runningRef.current = true;
            try {
                let idx = 0;
                let checkedSinceYield = 0;
                while (!cancelled && idx < songs.length) {
                    if (!appActive) {
                        await new Promise(r => setTimeout(r, 2000));
                        continue;
                    }
                    let doneInBurst = 0;
                    while (!cancelled && appActive && idx < songs.length && doneInBurst < BATCH_SIZE) {
                        const song = songs[idx++];
                        try {
                            const cached = await getCachedTags(song);
                            if (cached === undefined) {
                                await extractTags(song);
                                doneInBurst++;
                                await new Promise(r => setTimeout(r, EXTRACTION_STAGGER_MS));
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
            } finally {
                runningRef.current = false;
            }
        };

        const task = InteractionManager.runAfterInteractions(() => { if (!cancelled) run(); });
        return () => { cancelled = true; sub.remove(); task.cancel(); };
    }, [enabled, songs]);
}
