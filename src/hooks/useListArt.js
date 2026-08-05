import { useEffect, useRef, useState } from 'react';
import { extractEmbeddedArt } from '../utils/embeddedArt';

// Returns { songId: uri | null } for whichever songs have resolved so far.
// Processes sequentially in the background (not in parallel) — this is
// meaningfully heavier than the single "currently playing song" extraction,
// since it's the whole visible list, so it's throttled with a small delay
// between each song rather than firing everything at once and risking the
// same kind of JS-thread contention that caused the audio ramp stutter
// earlier. extractEmbeddedArt's own cache means this is only real work the
// first time a given song is seen; after that it resolves near-instantly.
export function useListArt(songs, enabled) {
    const [artMap, setArtMap] = useState({});
    const runIdRef = useRef(0);

    useEffect(() => {
        if (!enabled || !songs?.length) return;
        const runId = ++runIdRef.current;
        let cancelled = false;

        (async () => {
            for (const song of songs) {
                if (cancelled || runIdRef.current !== runId) return;
                if (song.id in artMap) continue; // already resolved (or resolving) this run
                try {
                    const uri = await extractEmbeddedArt(song);
                    if (cancelled || runIdRef.current !== runId) return;
                    setArtMap(prev => (song.id in prev ? prev : { ...prev, [song.id]: uri }));
                } catch { }
                // Small yield between songs so this never occupies the JS
                // thread for one long uninterrupted stretch across a big
                // library.
                await new Promise(r => setTimeout(r, 30));
            }
        })();

        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, songs]);

    return artMap;
}
