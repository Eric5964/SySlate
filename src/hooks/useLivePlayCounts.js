import { useState, useEffect, useCallback, useRef } from 'react';
import { getPlayCounts, playCountKey, playCountKeyN, subscribePlayCount } from '../utils/storage';

// Play counts for a list of songs, split in two on purpose:
//  - sortCounts: a snapshot read from storage. Lists sort by THIS, so a list in
//    "Most Played" order does not reshuffle while a song is playing.
//  - live: counts that changed since the snapshot. Rows SHOW these, so a number goes
//    up the moment the play is counted.
// The snapshot is read again (and the live ones folded into it) only when refreshSort()
// is called: when the songs change, the sort is changed, or a different queue is played.
export default function useLivePlayCounts(songs) {
    const [sortCounts, setSortCounts] = useState({});
    const [live, setLive] = useState({});
    const songsRef = useRef(songs);
    songsRef.current = songs;
    const tokenRef = useRef(0);
    const refreshSort = useCallback(() => {
        const my = ++tokenRef.current;
        getPlayCounts(songsRef.current || []).then(c => {
            if (my !== tokenRef.current) return;
            setSortCounts(c);
            setLive({});
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
