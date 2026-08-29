import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
    getShowPlayCount, setShowPlayCount as persistShowPlayCount,
    getShowSongCovers, setShowSongCovers as persistShowSongCovers,
    getArtistSeparator, setArtistSeparator as persistArtistSeparator,
    getLyricsMode, setLyricsMode as persistLyricsMode,
} from '../utils/storage';

// Previously each screen (Settings, All Songs, Playlist Detail, Queue) kept
// its own local copy of these, loaded once on mount (or on focus). Toggling
// in Settings didn't reach an already-mounted screen until it re-fetched —
// even with a focus-based refetch, that's still a round trip through
// AsyncStorage before anything visually updates, not instant. A shared
// context means every consumer re-renders the moment the value changes,
// with no read required.
const Ctx = createContext({
    showPlayCount: true, setShowPlayCount: () => { },
    showSongCovers: false, setShowSongCovers: () => { },
    artistSeparator: ';', setArtistSeparator: () => { },
    lyricsMode: 'off', setLyricsMode: () => { },
});

export function PreferencesProvider({ children }) {
    const [showPlayCount, setShowPlayCountState] = useState(true);
    const [showSongCovers, setShowSongCoversState] = useState(false);
    const [artistSeparator, setArtistSeparatorState] = useState(';');
    const [lyricsMode, setLyricsModeState] = useState('off');

    useEffect(() => {
        getShowPlayCount().then(setShowPlayCountState);
        getShowSongCovers().then(setShowSongCoversState);
        getArtistSeparator().then(setArtistSeparatorState);
        getLyricsMode().then(setLyricsModeState);
    }, []);

    // Updates local state immediately (every consumer re-renders right
    // away) and persists in the background — the persist doesn't need to
    // finish before the UI reflects the change.
    const setShowPlayCount = useCallback((v) => {
        setShowPlayCountState(v);
        persistShowPlayCount(v);
    }, []);
    const setShowSongCovers = useCallback((v) => {
        setShowSongCoversState(v);
        persistShowSongCovers(v);
    }, []);
    const setArtistSeparator = useCallback((v) => {
        setArtistSeparatorState(v);
        persistArtistSeparator(v);
    }, []);
    const setLyricsMode = useCallback((v) => {
        setLyricsModeState(v);
        persistLyricsMode(v);
    }, []);

    return (
        <Ctx.Provider value={{
            showPlayCount, setShowPlayCount,
            showSongCovers, setShowSongCovers,
            artistSeparator, setArtistSeparator,
            lyricsMode, setLyricsMode,
        }}>
            {children}
        </Ctx.Provider>
    );
}

export const usePreferences = () => useContext(Ctx);

