import { useEffect, useRef, useState } from 'react';
import { InteractionManager } from 'react-native';
import { extractEmbeddedArt, getCachedArtFast, peekCachedArtBulk, listArtUri } from '../utils/embeddedArt';

// Returns { songId: uri | null } for whichever songs have resolved so far.
//
// Genuinely new (uncached) extractions are capped per run — a large library
// with this setting on could otherwise background-process thousands of
// songs unboundedly in one sweep, which is real sustained CPU pressure.
// Lowered from 150 after a confirmed CPU-limit kill (crash log showed flat
// memory, pure CPU-time violation) — a big library doing this many
// extractions back to back, even staggered, was too much sustained work in
// one run. Cached lookups don't count against the cap.
const MAX_NEW_EXTRACTIONS_PER_RUN = 60;
const FLUSH_BATCH_SIZE = 20;
const YIELD_EVERY = 20;

// Real cause of "covers still need to load often" / flashing placeholders:
// artMap lived only in each hook instance's own useState, so every screen
// or list that mounted (opening a playlist, switching tabs, opening the
// queue) started from an EMPTY map and had to re-resolve every row before
// showing a single cover, even though the same songs had already been
// resolved moments earlier by a different instance. Resolved results now
// also live in this module-level map for the whole app session, and every
// new instance starts from it, so a cover that's been found once shows on
// first render everywhere after.
const SESSION_ART = {};

export function useListArt(songs, enabled) {
    // Starts from everything already known (this session's results plus the
    // on-disk cover cache, read synchronously), so a list's first paint
    // already has its covers instead of filling in over the next second.
    const [artMap, setArtMap] = useState(() => (enabled ? { ...peekCachedArtBulk(songs), ...SESSION_ART } : {}));
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
            for (const id of Object.keys(batch)) batch[id] = listArtUri(batch[id]);
            Object.assign(SESSION_ART, batch);
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
            // Fast pass: everything the in-memory cache already knows, in one
            // go and one state update.
            const bulk = peekCachedArtBulk(songs);
            for (const id of Object.keys(bulk)) {
                if (resolved.has(id)) continue;
                resolved.add(id);
                pending[id] = bulk[id];
                pendingCount++;
            }
            flush();
            let checked = 0;
            for (const song of songs) {
                if (isStale()) return;
                if (resolved.has(song.id)) continue;
                try {
                    const cached = await getCachedArtFast(song);
                    if (isStale()) return;
                    if (cached !== undefined) {
                        resolved.add(song.id);
                        pending[song.id] = cached;
                        pendingCount++;
                        if (pendingCount >= FLUSH_BATCH_SIZE) flush();
                    }
                } catch { }
                // A long uninterrupted loop of hundreds of these back to
                // back can still add up to a real blocking stretch on the
                // JS thread even though each individual check is cheap —
                // this yields periodically so it can't be the thing making
                // a gesture/animation stutter elsewhere in the app.
                if (++checked % YIELD_EVERY === 0) await new Promise(r => setTimeout(r, 0));
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
                await new Promise(r => setTimeout(r, 60));
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

        // While this screen stays mounted, periodically re-check for
        // anything that got resolved by someone ELSE — mainly the
        // currently-playing track's own prefetch-ahead in PlaybackContext,
        // which writes into the same shared disk cache but has no way to
        // tell an already-open list screen "hey, I found one." Without
        // this, art that appeared in the background only ever showed up
        // the next time the screen remounted (leaving and re-entering the
        // playlist), which is what made it look like it only refreshed on
        // exit/re-entry, and left coverage looking arbitrarily scattered
        // depending on exactly when you happened to leave and come back.
        // Cheap — every check here is a plain object lookup against the
        // cache already held in memory, no file I/O. Stops on its own once
        // nothing's left to resolve.
        const sweepInterval = setInterval(() => {
            if (isStale()) { clearInterval(sweepInterval); return; }
            if (resolved.size >= songs.length) { clearInterval(sweepInterval); return; }
            runCacheOnly();
        }, 6000);

        return () => { cancelled = true; cancelRef.current?.(); clearInterval(sweepInterval); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, songs]);

    return artMap;
}
