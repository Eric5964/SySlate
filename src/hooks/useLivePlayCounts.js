import { useState, useEffect, useCallback, useRef } from 'react';
import { getPlayCounts, playCountKey, playCountKeyN, subscribePlayCount } from '../utils/storage';

// Play counts for a list of songs, split in two on purpose:
//  - sortCounts: a snapshot read from storage. Lists sort by THIS, so a list in
//    "Most Played" order does not reshuffle while a song is playing.
//  - live: counts that changed since the snapshot. Rows SHOW these, so a number goes
//    up the moment the play is counted.
// The snapshot is only replaced (and the live ones folded into it) by refreshSort({ force: true }):
// when the sort is changed or the songs of the list change. Opening the list again reuses the snapshot
// it had (the order stays as it was first shown, the numbers shown are current) unless another playlist
// was played in between (see refreshSort).
const snapshots = new Map();   // list key -> { counts, source, sig }
const sigOf = (list) => `${list.length}:${list[0]?.id ?? ''}:${list[list.length - 1]?.id ?? ''}`;

export default function useLivePlayCounts(songs) {
    const [sortCounts, setSortCounts] = useState({});
    const [live, setLive] = useState({});
    const songsRef = useRef(songs);
    songsRef.current = songs;
    const tokenRef = useRef(0);
    // opts.cacheKey: names this list (its path). opts.source: what is playing now (the playing playlist).
    // opts.force: read a new snapshot whatever the cache holds.
    // The cached snapshot is kept when it was taken for the same songs and either the same thing is playing
    // as then, or this very list is what is playing (the song was started from it). Playing another
    // playlist in between makes the next opening read a new order.
    const refreshSort = useCallback((opts = {}) => {
        const my = ++tokenRef.current;
        const list = songsRef.current || [];
        getPlayCounts(list).then(c => {
            if (my !== tokenRef.current) return;
            const key = opts.cacheKey;
            const cached = key ? snapshots.get(key) : null;
            const reuse = !opts.force && cached && cached.sig === sigOf(list)
                && (cached.source === (opts.source ?? null) || (opts.source != null && opts.source === key));
            if (reuse) {
                setSortCounts(cached.counts);
                const diff = {};
                list.forEach(sg => {
                    const now = c[sg.id] ?? 0;
                    if (now !== (cached.counts[sg.id] ?? 0)) { diff[playCountKey(sg)] = now; diff[playCountKeyN(sg)] = now; }
                });
                setLive(diff);
            } else {
                setSortCounts(c);
                setLive({});
                if (key) snapshots.set(key, { counts: c, source: opts.source ?? null, sig: sigOf(list) });
            }
        });
    }, []);
    useEffect(() => subscribePlayCount(({ key, n }) => setLive(prev => ({ ...prev, [key]: n }))), []);
    const countFor = useCallback((song) => {
        if (!song) return 0;
        const l = live[playCountKey(song)] ?? live[playCountKeyN(song)];
        return l !== undefined ? l : sortCounts[song.id];
    }, [live, sortCounts]);
    return { sortCounts, live, refreshSort, countFor };
}
