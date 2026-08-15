import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { extractEmbeddedArt, getCachedArt } from '../utils/embeddedArt';

// Genuinely new extractions per burst, and how long to rest between bursts.
// Deliberately smaller/slower than a single screen's own loading (useListArt
// uses 60 per run with a 60ms stagger) because this runs continuously in the
// background on top of whatever a visible screen is already doing — the two
// can and do overlap (screen taps into the same shared disk cache, so no
// duplicate work happens for the same song), so this side needs to stay
// light on its own to keep the combined total reasonable. This exists
// because a confirmed CPU-limit kill happened earlier from extraction work
// alone; the goal here is coverage over time, not speed.
const BATCH_SIZE = 15;
const EXTRACTION_STAGGER_MS = 75;
const BURST_PAUSE_MS = 4000;
const YIELD_EVERY = 40;

// Walks the whole library once per app session (once per stable `songs`
// reference — a fresh library reload produces a new one, so a relaunch or
// rescan naturally retries anything that failed last time), warming the
// shared on-disk art cache so covers are ready by the time any screen goes
// looking for them, rather than only ever loading for whatever's currently
// on screen. Doesn't hold or return results itself — every screen already
// reads the same shared cache independently.
export function useBackgroundArtLoader(songs, enabled) {
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
                        // Don't do any work while backgrounded — this is
                        // exactly the kind of sustained work iOS's CPU
                        // watchdog was killing the app over before, and
                        // there's no user-visible benefit to racing to
                        // finish while nobody can see a cover anyway.
                        await new Promise(r => setTimeout(r, 2000));
                        continue;
                    }
                    let doneInBurst = 0;
                    while (!cancelled && appActive && idx < songs.length && doneInBurst < BATCH_SIZE) {
                        const song = songs[idx++];
                        try {
                            const cached = await getCachedArt(song);
                            if (cached === undefined) {
                                await extractEmbeddedArt(song);
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

        run();
        return () => { cancelled = true; sub.remove(); };
    }, [enabled, songs]);
}
