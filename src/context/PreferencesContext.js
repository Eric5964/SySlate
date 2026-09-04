import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import AudioEngine from '../native/AudioEngine';
import {
    getShowPlayCount, setShowPlayCount as persistShowPlayCount,
    getShowSongCovers, setShowSongCovers as persistShowSongCovers,
    getArtistSeparator, setArtistSeparator as persistArtistSeparator,
    getLyricsMode, setLyricsMode as persistLyricsMode,
    getLyricsResyncSec, setLyricsResyncSec as persistLyricsResyncSec,
    getLyricsOffsetSec, setLyricsOffsetSec as persistLyricsOffsetSec,
    getKeepScreenAwake, setKeepScreenAwake as persistKeepScreenAwake,
    getCoverShape, setCoverShape as persistCoverShape,
    getHidePlayerCover, setHidePlayerCover as persistHidePlayerCover,
    getBackgroundImageEnabled, setBackgroundImageEnabled as persistBgImageEnabled,
    getBackgroundImageUri, setBackgroundImageUri as persistBgImageUri,
    getCrossfadeEnabled, setCrossfadeEnabled as persistCrossfadeEnabled,
    getCrossfadeDuration, setCrossfadeDuration as persistCrossfadeDuration,
    getVolNorm, setVolNorm as persistVolNorm,
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
    lyricsResyncSec: 4, setLyricsResyncSec: () => { },
    lyricsOffsetSec: 0, setLyricsOffsetSec: () => { },
    keepScreenAwake: false, setKeepScreenAwake: () => { },
    coverShape: 'rounded', setCoverShape: () => { },
    hidePlayerCover: false, setHidePlayerCover: () => { },
    backgroundImageEnabled: false, setBackgroundImageEnabled: () => { },
    backgroundImageUri: null, setBackgroundImageUri: () => { },
    crossfadeEnabled: false, setCrossfadeEnabled: () => { },
    crossfadeDuration: 4, setCrossfadeDuration: () => { },
    normalizationEnabled: true, setNormalizationEnabled: () => { },
});

export function PreferencesProvider({ children }) {
    const [showPlayCount, setShowPlayCountState] = useState(true);
    const [showSongCovers, setShowSongCoversState] = useState(false);
    const [artistSeparator, setArtistSeparatorState] = useState(';');
    const [lyricsMode, setLyricsModeState] = useState('off');
    const [lyricsResyncSec, setLyricsResyncSecState] = useState(4);
    const [lyricsOffsetSec, setLyricsOffsetSecState] = useState(0);
    const [keepScreenAwake, setKeepScreenAwakeState] = useState(false);
    const [coverShape, setCoverShapeState] = useState('rounded');
    const [hidePlayerCover, setHidePlayerCoverState] = useState(false);
    const [backgroundImageEnabled, setBackgroundImageEnabledState] = useState(false);
    const [backgroundImageUri, setBackgroundImageUriState] = useState(null);
    const [crossfadeEnabled, setCrossfadeEnabledState] = useState(false);
    const [crossfadeDuration, setCrossfadeDurationState] = useState(4);
    const [normalizationEnabled, setNormalizationEnabledState] = useState(true);

    useEffect(() => {
        getShowPlayCount().then(setShowPlayCountState);
        getShowSongCovers().then(setShowSongCoversState);
        getArtistSeparator().then(setArtistSeparatorState);
        getLyricsMode().then(setLyricsModeState);
        getLyricsResyncSec().then(setLyricsResyncSecState);
        getLyricsOffsetSec().then(setLyricsOffsetSecState);
        getKeepScreenAwake().then(setKeepScreenAwakeState);
        getCoverShape().then(setCoverShapeState);
        getHidePlayerCover().then(setHidePlayerCoverState);
        getBackgroundImageEnabled().then(setBackgroundImageEnabledState);
        getBackgroundImageUri().then(setBackgroundImageUriState);
        // These three also need to reach the native engine on cold start,
        // not just local state — App.js's own setup effect races this one,
        // so it also independently pushes these same three to native once
        // it knows setupPlayer has actually finished; harmless to set
        // twice, but must not be ONLY set here in case this runs first.
        getCrossfadeEnabled().then((v) => { setCrossfadeEnabledState(v); AudioEngine.setCrossfadeEnabled(v).catch(() => { }); });
        getCrossfadeDuration().then((v) => { setCrossfadeDurationState(v); AudioEngine.setCrossfadeDuration(v).catch(() => { }); });
        getVolNorm().then((v) => { setNormalizationEnabledState(v); AudioEngine.setNormalizationEnabled(v).catch(() => { }); });
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
    const setLyricsResyncSec = useCallback((v) => {
        setLyricsResyncSecState(v);
        persistLyricsResyncSec(v);
    }, []);
    const setLyricsOffsetSec = useCallback((v) => {
        setLyricsOffsetSecState(v);
        persistLyricsOffsetSec(v);
    }, []);
    const setCoverShape = useCallback((v) => {
        setCoverShapeState(v);
        persistCoverShape(v);
    }, []);
    const setHidePlayerCover = useCallback((v) => {
        setHidePlayerCoverState(v);
        persistHidePlayerCover(v);
    }, []);
    const setBackgroundImageEnabled = useCallback((v) => {
        setBackgroundImageEnabledState(v);
        persistBgImageEnabled(v);
    }, []);
    const setBackgroundImageUri = useCallback((v) => {
        setBackgroundImageUriState(v);
        persistBgImageUri(v);
    }, []);
    const setKeepScreenAwake = useCallback((v) => {
        setKeepScreenAwakeState(v);
        persistKeepScreenAwake(v);
    }, []);
    const setCrossfadeEnabled = useCallback((v) => {
        setCrossfadeEnabledState(v);
        persistCrossfadeEnabled(v);
        AudioEngine.setCrossfadeEnabled(v).catch(() => { });
    }, []);
    const setCrossfadeDuration = useCallback((v) => {
        setCrossfadeDurationState(v);
        persistCrossfadeDuration(v);
        AudioEngine.setCrossfadeDuration(v).catch(() => { });
    }, []);
    const setNormalizationEnabled = useCallback((v) => {
        setNormalizationEnabledState(v);
        persistVolNorm(v);
        AudioEngine.setNormalizationEnabled(v).catch(() => { });
    }, []);

    // This context now has more consumers than just SettingsScreen (art
    // rendering across MiniPlayer, playlists, queue, etc. all read
    // coverShape) — without this useMemo, every one of those re-renders on
    // ANY single preference change, not just the one it actually reads,
    // since the value object below was otherwise a brand new reference
    // every render regardless of whether anything inside it changed.
    const value = useMemo(() => ({
        showPlayCount, setShowPlayCount,
        showSongCovers, setShowSongCovers,
        artistSeparator, setArtistSeparator,
        lyricsMode, setLyricsMode,
        lyricsResyncSec, setLyricsResyncSec,
        lyricsOffsetSec, setLyricsOffsetSec,
        keepScreenAwake, setKeepScreenAwake,
        coverShape, setCoverShape,
        hidePlayerCover, setHidePlayerCover,
        backgroundImageEnabled, setBackgroundImageEnabled,
        backgroundImageUri, setBackgroundImageUri,
        crossfadeEnabled, setCrossfadeEnabled,
        crossfadeDuration, setCrossfadeDuration,
        normalizationEnabled, setNormalizationEnabled,
    }), [
        showPlayCount, showSongCovers, artistSeparator, lyricsMode,
        lyricsResyncSec, lyricsOffsetSec, keepScreenAwake, coverShape, hidePlayerCover,
        backgroundImageEnabled, backgroundImageUri,
        crossfadeEnabled, crossfadeDuration, normalizationEnabled,
    ]);

    return (
        <Ctx.Provider value={value}>
            {children}
        </Ctx.Provider>
    );
}

export const usePreferences = () => useContext(Ctx);
