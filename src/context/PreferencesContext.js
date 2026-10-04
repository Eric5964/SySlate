import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Image, AppState } from 'react-native';
import AudioEngine from '../native/AudioEngine';
import {
    getShowPlayCount, setShowPlayCount as persistShowPlayCount,
    getShowSongCovers, setShowSongCovers as persistShowSongCovers,
    getArtistSeparator, setArtistSeparator as persistArtistSeparator,
    getLyricsMode, setLyricsMode as persistLyricsMode,
    getDjDisc, setDjDisc as persistDjDisc,
    getDjDiscAuto, setDjDiscAuto as persistDjDiscAuto,
    getPlayerBtn, setPlayerBtn,
    getLyricsResyncSec, setLyricsResyncSec as persistLyricsResyncSec,
    getLyricsOffsetSec, setLyricsOffsetSec as persistLyricsOffsetSec,
    getKeepScreenAwake, setKeepScreenAwake as persistKeepScreenAwake,
    getCoverShape, setCoverShape as persistCoverShape,
    getShowPlayerCover, setShowPlayerCover as persistShowPlayerCover,
    getCoverShadow, setCoverShadow as persistCoverShadow,
    getBackgroundImageEnabled, setBackgroundImageEnabled as persistBgImageEnabled,
    getBackgroundImageUri, setBackgroundImageUri as persistBgImageUri,
    getCrossfadeEnabled, setCrossfadeEnabled as persistCrossfadeEnabled,
    getCrossfadeDurationSkip, setCrossfadeDurationSkip as persistCrossfadeDurationSkip,
    getCrossfadeDurationEndOfTrack, setCrossfadeDurationEndOfTrack as persistCrossfadeDurationEndOfTrack,
    getWithinTrackNorm, setWithinTrackNorm as persistWithinTrackNorm,
    getPreAmp, setPreAmp as persistPreAmp,
    getBetweenTrackNorm, setBetweenTrackNorm as persistBetweenTrackNorm,
    getSilenceTrim, setSilenceTrim as persistSilenceTrim,
    getShowPlaylistTrackCount, setShowPlaylistTrackCount as persistShowPlaylistTrackCount,
    getShowPlaylistTitles, setShowPlaylistTitles as persistShowPlaylistTitles,
    getLyricsScrollLocked, setLyricsScrollLocked as persistLyricsScrollLocked,
    getArtistDisplayJoin, setArtistDisplayJoin as persistArtistDisplayJoin,
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
    artistSeparator: [';'], setArtistSeparator: () => { },
    lyricsMode: 'off', setLyricsMode: () => { },
    djDisc: false, setDjDisc: () => { },
    djDiscAuto: false, setDjDiscAuto: () => { },
    playerBtns: { sleep: true, speed: true, eq: true, queue: true, label: true, back: true }, setPlayerBtnShown: () => { },
    lyricsResyncSec: 4, setLyricsResyncSec: () => { },
    lyricsOffsetSec: 0, setLyricsOffsetSec: () => { },
    keepScreenAwake: false, setKeepScreenAwake: () => { },
    coverShape: 'rounded', setCoverShape: () => { },
    showPlayerCover: true, setShowPlayerCover: () => { },
    coverShadow: false, setCoverShadow: () => { },
    backgroundImageEnabled: false, setBackgroundImageEnabled: () => { },
    backgroundImageUri: null, setBackgroundImageUri: () => { },
    crossfadeEnabled: false, setCrossfadeEnabled: () => { },
    preAmp: 0, setPreAmp: () => { },
    // Renamed in meaning, not in name: this is now specifically the "on
    // skip" crossfade duration (see AudioEngine.swift's advance()) — kept
    // as `crossfadeDuration`/`setCrossfadeDuration` rather than adding yet
    // another differently-named field, since every existing call site
    // (SettingsScreen's slider, the native setter, the AsyncStorage key)
    // already lines up with "the skip one" once End of Track gets its own
    // field below.
    crossfadeDuration: 4, setCrossfadeDuration: () => { },
    crossfadeDurationEndOfTrack: 4, setCrossfadeDurationEndOfTrack: () => { },
    withinTrackNorm: true, setWithinTrackNorm: () => { },
    betweenTrackNorm: false, setBetweenTrackNorm: () => { },
    silenceTrim: false, setSilenceTrim: () => { },
    showPlaylistTrackCount: true, setShowPlaylistTrackCount: () => { },
    showPlaylistTitles: true, setShowPlaylistTitles: () => { },
    lyricsScrollLocked: false, setLyricsScrollLocked: () => { },
    artistDisplayJoin: 'comma', setArtistDisplayJoin: () => { },
});

export function PreferencesProvider({ children }) {
    const [showPlayCount, setShowPlayCountState] = useState(true);
    const [showSongCovers, setShowSongCoversState] = useState(true);
    const [artistSeparator, setArtistSeparatorState] = useState([';']);
    const [lyricsMode, setLyricsModeState] = useState('manual');
    const [djDisc, setDjDiscState] = useState(false);
    const [djDiscAuto, setDjDiscAutoState] = useState(false);
    const [playerBtns, setPlayerBtns] = useState({ sleep: true, speed: true, eq: true, queue: true, label: true, back: true });
    const setPlayerBtnShown = useCallback((name, v) => {
        setPlayerBtns(prev => ({ ...prev, [name]: v }));
        setPlayerBtn(name, v);
    }, []);
    const [lyricsResyncSec, setLyricsResyncSecState] = useState(2);
    const [lyricsOffsetSec, setLyricsOffsetSecState] = useState(0);
    const [keepScreenAwake, setKeepScreenAwakeState] = useState(false);
    const [coverShape, setCoverShapeState] = useState('rounded');
    const [showPlayerCover, setShowPlayerCoverState] = useState(true);
    const [coverShadow, setCoverShadowState] = useState(true);
    const [backgroundImageEnabled, setBackgroundImageEnabledState] = useState(false);
    const [backgroundImageUri, setBackgroundImageUriState] = useState(null);
    const [crossfadeEnabled, setCrossfadeEnabledState] = useState(true);
    const [crossfadeDuration, setCrossfadeDurationState] = useState(2);
    const [crossfadeDurationEndOfTrack, setCrossfadeDurationEndOfTrackState] = useState(4);
    const [withinTrackNorm, setWithinTrackNormState] = useState(false);
    const [preAmp, setPreAmpState] = useState(0);
    const [betweenTrackNorm, setBetweenTrackNormState] = useState(false);
    const [silenceTrim, setSilenceTrimState] = useState(false);
    const [showPlaylistTrackCount, setShowPlaylistTrackCountState] = useState(true);
    const [showPlaylistTitles, setShowPlaylistTitlesState] = useState(true);
    const [lyricsScrollLocked, setLyricsScrollLockedState] = useState(false);
    const [artistDisplayJoin, setArtistDisplayJoinState] = useState('comma');

    // Kept in sync so the AppState listener below (set up once, in the
    // mount-only effect right after this) always re-prefetches whatever
    // URI is CURRENT, not whatever it was at the moment that effect first
    // ran.
    const backgroundImageUriRef = useRef(backgroundImageUri);
    useEffect(() => { backgroundImageUriRef.current = backgroundImageUri; }, [backgroundImageUri]);

    useEffect(() => {
        getShowPlayCount().then(setShowPlayCountState);
        getShowSongCovers().then(setShowSongCoversState);
        getArtistSeparator().then(setArtistSeparatorState);
        getLyricsMode().then(setLyricsModeState);
        getDjDisc().then(setDjDiscState);
        getDjDiscAuto().then(setDjDiscAutoState);
        ['sleep', 'speed', 'eq', 'queue', 'label', 'back'].forEach(n => getPlayerBtn(n).then(v => setPlayerBtns(prev => ({ ...prev, [n]: v }))));
        getLyricsResyncSec().then(setLyricsResyncSecState);
        getLyricsOffsetSec().then(setLyricsOffsetSecState);
        getKeepScreenAwake().then(setKeepScreenAwakeState);
        getCoverShape().then(setCoverShapeState);
        getShowPlayerCover().then(setShowPlayerCoverState);
        getCoverShadow().then(setCoverShadowState);
        getBackgroundImageEnabled().then(setBackgroundImageEnabledState);
        // "Flicker each time" — every screen mounts its own ScreenBackground
        // <Image> for the same local file:// URI, and with no request-level
        // cache warmed yet, each one decodes it fresh from disk, which is
        // slow enough to show a blank frame first. Image.prefetch is core
        // React Native (no new native dependency — the last attempt at
        // fixing this added one and broke gesture handling app-wide, see
        // ScreenBackground.js) and populates the native image loader's own
        // cache, so warming it once here, right at cold start before any
        // screen has even mounted, means every subsequent <Image> for this
        // exact uri hits that cache instead of decoding from disk again.
        getBackgroundImageUri().then(uri => {
            setBackgroundImageUriState(uri);
            if (uri) Image.prefetch(uri).catch(() => { });
        });
        // Real gap found here: this cold-start prefetch only ever ran
        // once, at launch. "The background image should be in permanent
        // cache until replaced... right now it seems to be reset based on
        // time" — that's consistent with the underlying native image
        // cache getting evicted under memory pressure or after the app's
        // been backgrounded a while (normal iOS behavior, not something a
        // one-time prefetch at launch can prevent on its own). Re-warming
        // it every time the app comes back to the foreground means any
        // eviction that happened while backgrounded gets fixed BEFORE the
        // next screen mount, instead of showing the flash and only then
        // reloading.
        const appStateSub = AppState.addEventListener('change', (next) => {
            if (next === 'active' && backgroundImageUriRef.current) {
                Image.prefetch(backgroundImageUriRef.current).catch(() => { });
            }
        });
        // These also need to reach the native engine on cold start, not
        // just local state — App.js's own setup effect races this one, so
        // it also independently pushes these same values to native once it
        // knows setupPlayer has actually finished; harmless to set twice,
        // but must not be ONLY set here in case this runs first.
        getCrossfadeEnabled().then((v) => { setCrossfadeEnabledState(v); AudioEngine.setCrossfadeEnabled(v).catch(() => { }); });
        // Was getCrossfadeDuration() — that key is now only read as the
        // migration fallback INSIDE getCrossfadeDurationSkip (see
        // storage.js), not directly here, now that On Skip and End of
        // Track are tracked separately.
        getCrossfadeDurationSkip().then((v) => { setCrossfadeDurationState(v); AudioEngine.setCrossfadeDuration(v).catch(() => { }); });
        getCrossfadeDurationEndOfTrack().then((v) => { setCrossfadeDurationEndOfTrackState(v); AudioEngine.setCrossfadeDurationEndOfTrack(v).catch(() => { }); });
        getWithinTrackNorm().then((v) => { setWithinTrackNormState(v); AudioEngine.setWithinTrackNormEnabled(v).catch(() => { }); });
        getPreAmp().then((v) => { setPreAmpState(v); AudioEngine.setPreAmp(v).catch(() => { }); });
        getBetweenTrackNorm().then((v) => { setBetweenTrackNormState(v); AudioEngine.setBetweenTrackNormEnabled(v).catch(() => { }); });
        getSilenceTrim().then((v) => { setSilenceTrimState(v); AudioEngine.setSilenceTrimEnabled(v).catch(() => { }); });
        getShowPlaylistTrackCount().then(setShowPlaylistTrackCountState);
        getShowPlaylistTitles().then(setShowPlaylistTitlesState);
        getLyricsScrollLocked().then(setLyricsScrollLockedState);
        getArtistDisplayJoin().then(setArtistDisplayJoinState);
        return () => appStateSub.remove();
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
    // Auto Lyrics and Auto Disc can never both be on: each setter turns the
    // other one off. (Auto Disc also needs the disc itself enabled.)
    const setDjDiscAuto = useCallback((v) => {
        setDjDiscAutoState(v);
        persistDjDiscAuto(v);
        if (v) {
            setLyricsModeState(m => {
                if (m !== 'auto') return m;
                persistLyricsMode('manual');
                return 'manual';
            });
        }
    }, []);
    const setDjDisc = useCallback((v) => {
        setDjDiscState(v);
        persistDjDisc(v);
        if (!v) { setDjDiscAutoState(false); persistDjDiscAuto(false); }
    }, []);
    const setLyricsMode = useCallback((v) => {
        setLyricsModeState(v);
        persistLyricsMode(v);
        if (v === 'auto') { setDjDiscAutoState(false); persistDjDiscAuto(false); }
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
    const setShowPlayerCover = useCallback((v) => {
        setShowPlayerCoverState(v);
        persistShowPlayerCover(v);
    }, []);
    const setCoverShadow = useCallback((v) => {
        setCoverShadowState(v);
        persistCoverShadow(v);
    }, []);
    const setBackgroundImageEnabled = useCallback((v) => {
        setBackgroundImageEnabledState(v);
        persistBgImageEnabled(v);
    }, []);
    const setBackgroundImageUri = useCallback((v) => {
        setBackgroundImageUriState(v);
        persistBgImageUri(v);
        if (v) Image.prefetch(v).catch(() => { });
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
        persistCrossfadeDurationSkip(v);
        AudioEngine.setCrossfadeDuration(v).catch(() => { });
    }, []);
    const setCrossfadeDurationEndOfTrack = useCallback((v) => {
        setCrossfadeDurationEndOfTrackState(v);
        persistCrossfadeDurationEndOfTrack(v);
        AudioEngine.setCrossfadeDurationEndOfTrack(v).catch(() => { });
    }, []);
    const setWithinTrackNorm = useCallback((v) => {
        setWithinTrackNormState(v);
        persistWithinTrackNorm(v);
        AudioEngine.setWithinTrackNormEnabled(v).catch(() => { });
    }, []);
    const setPreAmp = useCallback((v) => {
        setPreAmpState(v);
        persistPreAmp(v);
        AudioEngine.setPreAmp(v).catch(() => { });
    }, []);
    const setBetweenTrackNorm = useCallback((v) => {
        setBetweenTrackNormState(v);
        persistBetweenTrackNorm(v);
        AudioEngine.setBetweenTrackNormEnabled(v).catch(() => { });
    }, []);
    const setSilenceTrim = useCallback((v) => {
        setSilenceTrimState(v);
        persistSilenceTrim(v);
        AudioEngine.setSilenceTrimEnabled(v).catch(() => { });
    }, []);
    const setShowPlaylistTrackCount = useCallback((v) => {
        setShowPlaylistTrackCountState(v);
        persistShowPlaylistTrackCount(v);
    }, []);
    const setShowPlaylistTitles = useCallback((v) => {
        setShowPlaylistTitlesState(v);
        persistShowPlaylistTitles(v);
    }, []);
    const setLyricsScrollLocked = useCallback((v) => {
        setLyricsScrollLockedState(v);
        persistLyricsScrollLocked(v);
    }, []);
    const setArtistDisplayJoin = useCallback((v) => {
        setArtistDisplayJoinState(v);
        persistArtistDisplayJoin(v);
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
        djDisc, setDjDisc, djDiscAuto, setDjDiscAuto,
        playerBtns, setPlayerBtnShown,
        lyricsResyncSec, setLyricsResyncSec,
        lyricsOffsetSec, setLyricsOffsetSec,
        keepScreenAwake, setKeepScreenAwake,
        coverShape, setCoverShape,
        showPlayerCover, setShowPlayerCover,
        coverShadow, setCoverShadow,
        backgroundImageEnabled, setBackgroundImageEnabled,
        backgroundImageUri, setBackgroundImageUri,
        crossfadeEnabled, setCrossfadeEnabled,
        crossfadeDuration, setCrossfadeDuration,
        crossfadeDurationEndOfTrack, setCrossfadeDurationEndOfTrack,
        withinTrackNorm, setWithinTrackNorm,
        preAmp, setPreAmp,
        betweenTrackNorm, setBetweenTrackNorm,
        silenceTrim, setSilenceTrim,
        showPlaylistTrackCount, setShowPlaylistTrackCount,
        showPlaylistTitles, setShowPlaylistTitles,
        lyricsScrollLocked, setLyricsScrollLocked,
        artistDisplayJoin, setArtistDisplayJoin,
    }), [
        showPlayCount, showSongCovers, artistSeparator, lyricsMode, djDisc, djDiscAuto, playerBtns,
        lyricsResyncSec, lyricsOffsetSec, keepScreenAwake, coverShape, showPlayerCover, coverShadow,
        backgroundImageEnabled, backgroundImageUri,
        crossfadeEnabled, crossfadeDuration, crossfadeDurationEndOfTrack, withinTrackNorm, preAmp, betweenTrackNorm, silenceTrim,
        showPlaylistTrackCount, showPlaylistTitles, lyricsScrollLocked, artistDisplayJoin,
    ]);

    return (
        <Ctx.Provider value={value}>
            {children}
        </Ctx.Provider>
    );
}

export const usePreferences = () => useContext(Ctx);
