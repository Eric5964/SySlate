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
        let pending = {};
        let pendingCount = 0;
        const resolved = new Set();

        const flush = () => {
            if (pendingCount === 0) return;
            const batch = pending;
            pending = {};
            pendingCount = 0;
            setArtMap(prev => ({ ...prev, ...batch }));
        };

        const isStale = () => cancelled || runIdRef.current !== runId;

        // Phase 1: restore anything already cached, immediately, with no
        // delay. This used to be gated behind the same InteractionManager
        // + 300ms guard as the heavy extraction pass below, which meant
        // covers already found would still vanish and take ~300ms+ to
        // reappear every time this screen remounted (e.g. leaving and
        // re-entering a playlist). A cache hit is cheap — one AsyncStorage
        // lookup, no file I/O — so there's no reason to delay it.
        const runCacheOnly = async () => {
            for (const song of songs) {
                if (isStale()) return;
                if (resolved.has(song.id)) continue;
                try {
                    const cached = await getCachedArt(song);
                    if (isStale()) return;
                    if (cached !== undefined) {
                        resolved.add(song.id);
                        pending[song.id] = cached;
                        pendingCount++;
                        if (pendingCount >= FLUSH_BATCH_SIZE) flush();
                    }
                } catch { }
            }
            flush();
        };

        // Phase 2: genuinely new extractions — real file I/O — stay behind
        // the interaction/settle delay so they don't compete with
        // navigation transitions on the JS thread.
        const runNewExtractions = async () => {
            let newExtractions = 0;
            for (const song of songs) {
                if (isStale()) break;
                if (resolved.has(song.id)) continue;
                if (newExtractions >= MAX_NEW_EXTRACTIONS_PER_RUN) break;
                newExtractions++;
                try {
                    const uri = await extractEmbeddedArt(song);
                    if (isStale()) break;
                    resolved.add(song.id);
                    pending[song.id] = uri;
                    pendingCount++;
                } catch { }
                if (pendingCount >= FLUSH_BATCH_SIZE) flush();
                await new Promise(r => setTimeout(r, 30));
            }
            flush();
        };

        runCacheOnly();

        const cancelRef = { current: null };
        const handle = InteractionManager.runAfterInteractions(() => {
            const t = setTimeout(runNewExtractions, 300);
            cancelRef.current = () => clearTimeout(t);
        });
        cancelRef.current = () => handle.cancel();

        return () => { cancelled = true; cancelRef.current?.(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, songs]);

    return artMap;
}
