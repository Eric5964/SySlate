import { useEffect, useRef, useState } from 'react';
import { InteractionManager } from 'react-native';
import { extractEmbeddedArt, getCachedArt } from '../utils/embeddedArt';

// Returns { songId: uri | null } for whichever songs have resolved so far.
//
// Genuinely new (uncached) extractions are capped per run — a large library
// with this setting on could otherwise background-process thousands of
// songs unboundedly in one sweep, which is real sustained memory/IO
// pressure. Cached lookups don't count against the cap.
const MAX_NEW_EXTRACTIONS_PER_RUN = 150;
const FLUSH_BATCH_SIZE = 20;

export function useListArt(songs, enabled) {
    const [artMap, setArtMap] = useState({});
    const runIdRef = useRef(0);

    useEffect(() => {
        if (!enabled || !songs?.length) return;
        const runId = ++runIdRef.current;
        let cancelled = false;
        let newExtractions = 0;
        let pending = {};
        let pendingCount = 0;

        const flush = () => {
            if (pendingCount === 0) return;
            const batch = pending;
            pending = {};
            pendingCount = 0;
            setArtMap(prev => ({ ...prev, ...batch }));
        };

        const run = async () => {
            for (const song of songs) {
                if (cancelled || runIdRef.current !== runId) break;
                if (song.id in artMap || song.id in pending) continue;
                let didRealWork = false;
                try {
                    const cached = await getCachedArt(song);
                    if (cancelled || runIdRef.current !== runId) break;
                    if (cached !== undefined) {
                        // A cache hit is cheap (one AsyncStorage lookup, no
                        // file I/O) — no artificial delay needed. This was
                        // the real cause of "takes forever / unusable" for
                        // All Songs specifically: hundreds of already-cached
                        // songs each triggering their own setState AND an
                        // unconditional 30ms delay, even though there was
                        // almost no real work happening.
                        pending[song.id] = cached;
                        pendingCount++;
                    } else if (newExtractions < MAX_NEW_EXTRACTIONS_PER_RUN) {
                        newExtractions++;
                        didRealWork = true;
                        const uri = await extractEmbeddedArt(song);
                        if (cancelled || runIdRef.current !== runId) break;
                        pending[song.id] = uri;
                        pendingCount++;
                    }
                } catch { }
                // Batched instead of one setState (and one re-render) per
                // song. Only genuinely new extractions are throttled — the
                // heavy file read + decode is what needed protecting the JS
                // thread from, not cheap cache hits.
                if (pendingCount >= FLUSH_BATCH_SIZE) flush();
                if (didRealWork) await new Promise(r => setTimeout(r, 30));
            }
            flush();
        };

        // Previously this fired the instant the screen mounted — which is
        // exactly when a navigation push/transition is also trying to
        // animate on the JS thread (this app uses @react-navigation/stack,
        // not native-stack, so transitions run in JS). Competing with that
        // for the thread is a very plausible cause of both "delay before
        // anything happens after tapping" and "choppy transitions."
        // InteractionManager defers until animations/interactions have
        // settled; the extra 300ms is a safety margin on top of that, since
        // JS-driven navigation transitions don't always register themselves
        // as an "interaction" the same way RN's own Animated calls do.
        const cancelRef = { current: null };
        const handle = InteractionManager.runAfterInteractions(() => {
            const t = setTimeout(run, 300);
            cancelRef.current = () => clearTimeout(t);
        });
        cancelRef.current = () => handle.cancel();

        return () => { cancelled = true; cancelRef.current?.(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, songs]);

    return artMap;
}
