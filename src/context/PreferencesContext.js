import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Image, AppState } from 'react-native';
import AudioEngine from '../native/AudioEngine';
import { setPerf } from '../utils/perf';
import {
    getShowPlayCount, setShowPlayCount as persistShowPlayCount,
    getShowSongCovers, setShowSongCovers as persistShowSongCovers,
    getArtistSeparator, setArtistSeparator as persistArtistSeparator,
    getLyricsMode, setLyricsMode as persistLyricsMode,
    getDjDisc, setDjDisc as persistDjDisc,
    getAutoShow, setAutoShow as persistAutoShow,
    getVizMode, setVizMode as persistVizMode,
    getDjDiscSpin, setDjDiscSpin as persistDjDiscSpin,
    getDjDiscTouch, setDjDiscTouch as persistDjDiscTouch,
    getMiniPlayerShadow, setMiniPlayerShadow as persistMiniPlayerShadow,
    getPerformanceMode, setPerformanceMode as persistPerformanceMode,
    getUseVolumeTags, setUseVolumeTags as persistUseVolumeTags,
    getDjDiscRpm, setDjDiscRpm as persistDjDiscRpm, DISC_RPMS,
    getDjDiscType, setDjDiscType as persistDjDiscType,
    getDjDiscAssist, setDjDiscAssist as persistDjDiscAssist,
    getPlayerOutline, setPlayerOutline as persistPlayerOutline,
    getDetailOutline, setDetailOutline as persistDetailOutline,
    getSongPillShadow, setSongPillShadow as persistSongPillShadow,
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
    getSpatialWidth, setSpatialWidth as persistSpatialWidth, getSpatialBalance, setSpatialBalance as persistSpatialBalance,
    getBetweenTrackNorm, setBetweenTrackNorm as persistBetweenTrackNorm,
    getSilenceTrim, setSilenceTrim as persistSilenceTrim,
    getShowPlaylistTrackCount, setShowPlaylistTrackCount as persistShowPlaylistTrackCount,
    getShowPlaylistTitles, setShowPlaylistTitles as persistShowPlaylistTitles,
    getLyricsScrollLocked, setLyricsScrollLocked as persistLyricsScrollLocked,
    getArtistDisplayJoin, setArtistDisplayJoin as persistArtistDisplayJoin,
    getTopBarColor, setTopBarColor as persistTopBarColor,
    getBottomBarColor, setBottomBarColor as persistBottomBarColor,
    getPlaylistCoverShape, setPlaylistCoverShape as persistPlaylistCoverShape,
    getPlaylistCoverShadow, setPlaylistCoverShadow as persistPlaylistCoverShadow,
    getPlaylistCards, setPlaylistCards as persistPlaylistCards,
    getPlaylistArrow, setPlaylistArrow as persistPlaylistArrow,
    getUiToggle, setUiToggle, UI_TOGGLE_NAMES,
} from '../utils/storage';

// Previously each screen (Settings, All Songs, Playlist Detail, Queue) kept
// its own local copy of these, loaded once on mount (or on focus). Toggling
// in Settings didn't reach an already-mounted screen until it re-fetched —
// even with a focus-based refetch, that's still a round trip through
// AsyncStorage before anything visually updates, not instant. A shared
// context means every consumer re-renders the moment the value changes,
// with no read required.
// Every value here is a fallback for a consumer that renders OUTSIDE the
// provider (never intended: the provider wraps the whole app, so these are only
// ever seen if that breaks). They must still match the real defaults the
// storage getters return, or such a consumer would disagree with the rest of
// the app. Several had drifted (showSongCovers, lyricsResyncSec, coverShadow,
// crossfadeEnabled, withinTrackNorm) — corrected to what storage.js actually
// defaults to, which is also what the provider's own useState seeds.
const Ctx = createContext({
    showPlayCount: true, setShowPlayCount: () => { },
    showSongCovers: true, setShowSongCovers: () => { },
    artistSeparator: [';'], setArtistSeparator: () => { },
    lyricsMode: 'manual', lyricsOn: true, setLyricsOn: () => { },
    djDisc: false, setDjDisc: () => { },
    autoShow: 'cover', setAutoShow: () => { },
    vizMode: 'off', setVizMode: () => { },
    djDiscSpin: true, setDjDiscSpin: () => { },
    djDiscTouch: true, setDjDiscTouch: () => { },
    autoShowLyrics: false, autoShowDisc: false,
    miniPlayerShadow: true, setMiniPlayerShadow: () => { },
    performanceMode: false, setPerformanceMode: () => { },
    useVolumeTags: true, setUseVolumeTags: () => { },
    shadowsRaw: { coverShadow: true, playlistCoverShadow: true, songPillShadow: false, miniPlayerShadow: true },
    djDiscRpm: '33', setDjDiscRpm: () => { }, discRpmValue: 100 / 3,
    djDiscType: 'vinyl', setDjDiscType: () => { },
    djDiscAssist: true, setDjDiscAssist: () => { },
    playerOutline: false, setPlayerOutline: () => { },
    detailOutline: false, setDetailOutline: () => { },
    songPillShadow: false, setSongPillShadow: () => { },
    playerBtns: { sleep: true, speed: true, eq: true, queue: true, label: true, back: true }, setPlayerBtnShown: () => { },
    lyricsResyncSec: 2, setLyricsResyncSec: () => { },
    lyricsOffsetSec: 0, setLyricsOffsetSec: () => { },
    keepScreenAwake: false, setKeepScreenAwake: () => { },
    coverShape: 'rounded', setCoverShape: () => { },
    showPlayerCover: true, setShowPlayerCover: () => { },
    coverShadow: true, setCoverShadow: () => { },
    backgroundImageEnabled: false, setBackgroundImageEnabled: () => { },
    backgroundImageUri: null, setBackgroundImageUri: () => { },
    crossfadeEnabled: true, setCrossfadeEnabled: () => { },
    preAmp: 0, setPreAmp: () => { },
    spatialWidth: 100, setSpatialWidth: () => { }, spatialBalance: 0, setSpatialBalance: () => { },
    // Renamed in meaning, not in name: this is now specifically the "on
    // skip" crossfade duration (see AudioEngine.swift's advance()) — kept
    // as `crossfadeDuration`/`setCrossfadeDuration` rather than adding yet
    // another differently-named field, since every existing call site
    // (SettingsScreen's slider, the native setter, the AsyncStorage key)
    // already lines up with "the skip one" once End of Track gets its own
    // field below.
    crossfadeDuration: 4, setCrossfadeDuration: () => { },
    crossfadeDurationEndOfTrack: 4, setCrossfadeDurationEndOfTrack: () => { },
    withinTrackNorm: false, setWithinTrackNorm: () => { },
    betweenTrackNorm: false, setBetweenTrackNorm: () => { },
    silenceTrim: false, setSilenceTrim: () => { },
    showPlaylistTrackCount: true, setShowPlaylistTrackCount: () => { },
    showPlaylistTitles: true, setShowPlaylistTitles: () => { },
    lyricsScrollLocked: false, setLyricsScrollLocked: () => { },
    artistDisplayJoin: 'comma', setArtistDisplayJoin: () => { },
    topBarColor: true, setTopBarColor: () => { },
    bottomBarColor: true, setBottomBarColor: () => { },
    playlistCoverShape: 'rounded', setPlaylistCoverShape: () => { },
    playlistCoverShadow: true, setPlaylistCoverShadow: () => { },
    playlistCards: true, setPlaylistCards: () => { },
    playlistArrow: true, setPlaylistArrow: () => { },
    ui: {}, setUiShown: () => { },
});

export function PreferencesProvider({ children }) {
    const [showPlayCount, setShowPlayCountState] = useState(true);
    const [showSongCovers, setShowSongCoversState] = useState(true);
    const [artistSeparator, setArtistSeparatorState] = useState([';']);
    const [lyricsOn, setLyricsOnState] = useState(true);
    const [autoShow, setAutoShowState] = useState('cover');
    const [vizMode, setVizModeState] = useState('off');
    const setVizMode = useCallback((v) => { setVizModeState(v); persistVizMode(v); }, []);
    const [djDiscSpin, setDjDiscSpinState] = useState(true);
    const [djDiscTouch, setDjDiscTouchState] = useState(true);
    const [djDisc, setDjDiscState] = useState(false);
    const [miniPlayerShadow, setMiniPlayerShadowState] = useState(true);
    const [performanceMode, setPerformanceModeState] = useState(false);
    const [useVolumeTags, setUseVolumeTagsState] = useState(true);
    // Auto-show lyrics and Auto Disc can never both be on.
    // The Player opens on ONE thing (autoShow); a view that is switched off
    // can't be it. lyricsMode is kept for the Player's own checks.
    const autoShowLyrics = lyricsOn && autoShow === 'lyrics';
    const autoShowDisc = djDisc && autoShow === 'disc';
    const lyricsMode = lyricsOn ? (autoShowLyrics ? 'auto' : 'manual') : 'off';
    const [djDiscRpm, setDjDiscRpmState] = useState('33');
    const [djDiscType, setDjDiscTypeState] = useState('vinyl');
    const [djDiscAssist, setDjDiscAssistState] = useState(true);
    const [playerOutline, setPlayerOutlineState] = useState(false);
    const [detailOutline, setDetailOutlineState] = useState(false);
    const [songPillShadow, setSongPillShadowState] = useState(false);
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
    const [spatialWidth, setSpatialWidthState] = useState(100);
    const [spatialBalance, setSpatialBalanceState] = useState(0);
    const spatialRef = useRef({ width: 100, balance: 0 });
    const [betweenTrackNorm, setBetweenTrackNormState] = useState(false);
    const [silenceTrim, setSilenceTrimState] = useState(false);
    const [showPlaylistTrackCount, setShowPlaylistTrackCountState] = useState(true);
    const [showPlaylistTitles, setShowPlaylistTitlesState] = useState(true);
    const [lyricsScrollLocked, setLyricsScrollLockedState] = useState(false);
    const [artistDisplayJoin, setArtistDisplayJoinState] = useState('comma');
    const [topBarColor, setTopBarColorState] = useState(true);
    const [bottomBarColor, setBottomBarColorState] = useState(true);
    const [playlistCoverShape, setPlaylistCoverShapeState] = useState('rounded');
    const [playlistCoverShadow, setPlaylistCoverShadowState] = useState(true);
    const [playlistCards, setPlaylistCardsState] = useState(true);
    const [playlistArrow, setPlaylistArrowState] = useState(true);
    // Show/hide switches for items on the Playlists, All Songs and Playlist
    // screens. A missing name counts as shown.
    const [ui, setUi] = useState({});
    const setUiShown = useCallback((name, v) => {
        setUi(prev => ({ ...prev, [name]: v }));
        setUiToggle(name, v);
    }, []);

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
        getLyricsMode().then(m => setLyricsOnState(m !== 'off'));
        getAutoShow().then(setAutoShowState);
        getVizMode().then(setVizModeState);
        getDjDiscSpin().then(setDjDiscSpinState);
        getDjDiscTouch().then(setDjDiscTouchState);
        getDjDisc().then(setDjDiscState);
        getMiniPlayerShadow().then(setMiniPlayerShadowState);
        getPerformanceMode().then(v => { setPerf(v); setPerformanceModeState(v); });
        getUseVolumeTags().then(v => { AudioEngine.setUseVolumeTags(v); setUseVolumeTagsState(v); });
        getDjDiscRpm().then(setDjDiscRpmState);
        getDjDiscType().then(setDjDiscTypeState);
        getDjDiscAssist().then(setDjDiscAssistState);
        getPlayerOutline().then(setPlayerOutlineState);
        getDetailOutline().then(setDetailOutlineState);
        getSongPillShadow().then(setSongPillShadowState);
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
        Promise.all([getSpatialWidth(), getSpatialBalance()]).then(([w, b]) => {
            setSpatialWidthState(w); setSpatialBalanceState(b);
            spatialRef.current = { width: w, balance: b };
            AudioEngine.setSpatial(w / 100, b / 100);
        });
        getBetweenTrackNorm().then((v) => { setBetweenTrackNormState(v); AudioEngine.setBetweenTrackNormEnabled(v).catch(() => { }); });
        getSilenceTrim().then((v) => { setSilenceTrimState(v); AudioEngine.setSilenceTrimEnabled(v).catch(() => { }); });
        getShowPlaylistTrackCount().then(setShowPlaylistTrackCountState);
        getShowPlaylistTitles().then(setShowPlaylistTitlesState);
        getLyricsScrollLocked().then(setLyricsScrollLockedState);
        getArtistDisplayJoin().then(setArtistDisplayJoinState);
        getTopBarColor().then(setTopBarColorState);
        getBottomBarColor().then(setBottomBarColorState);
        getPlaylistCoverShape().then(setPlaylistCoverShapeState);
        getPlaylistCoverShadow().then(setPlaylistCoverShadowState);
        getPlaylistCards().then(setPlaylistCardsState);
        getPlaylistArrow().then(setPlaylistArrowState);
        UI_TOGGLE_NAMES.forEach(n => getUiToggle(n).then(v => setUi(prev => ({ ...prev, [n]: v }))));
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
    // Auto Show picks what the Player opens on (cover, lyrics or disc). The
    // three views can each be switched on or off. Picking a view that is off
    // switches it on; switching off the picked view falls back to the cover.
    const autoShowRef = useRef('cover');
    useEffect(() => { autoShowRef.current = autoShow; }, [autoShow]);
    const setAutoShow = useCallback((v) => {
        setAutoShowState(v); persistAutoShow(v);
        if (v === 'lyrics') { setLyricsOnState(true); persistLyricsMode('manual'); }
        if (v === 'disc') { setDjDiscState(true); persistDjDisc(true); }
    }, []);
    const setLyricsOn = useCallback((v) => {
        setLyricsOnState(v); persistLyricsMode(v ? 'manual' : 'off');
        if (!v && autoShowRef.current === 'lyrics') { setAutoShowState('cover'); persistAutoShow('cover'); }
    }, []);
    const setDjDisc = useCallback((v) => {
        setDjDiscState(v); persistDjDisc(v);
        if (!v && autoShowRef.current === 'disc') { setAutoShowState('cover'); persistAutoShow('cover'); }
    }, []);
    const setDjDiscSpin = useCallback((v) => { setDjDiscSpinState(v); persistDjDiscSpin(v); }, []);
    const setDjDiscTouch = useCallback((v) => { setDjDiscTouchState(v); persistDjDiscTouch(v); }, []);
    const setDjDiscType = useCallback((v) => { setDjDiscTypeState(v); persistDjDiscType(v); }, []);
    const setDjDiscAssist = useCallback((v) => { setDjDiscAssistState(v); persistDjDiscAssist(v); }, []);
    const setPerformanceMode = useCallback((v) => { setPerf(v); setPerformanceModeState(v); persistPerformanceMode(v); }, []);
    const setUseVolumeTags = useCallback((v) => { AudioEngine.setUseVolumeTags(v); setUseVolumeTagsState(v); persistUseVolumeTags(v); }, []);
    const setMiniPlayerShadow = useCallback((v) => { setMiniPlayerShadowState(v); persistMiniPlayerShadow(v); }, []);
    const setDjDiscRpm = useCallback((v) => { setDjDiscRpmState(v); persistDjDiscRpm(v); }, []);
    const setPlayerOutline = useCallback((v) => { setPlayerOutlineState(v); persistPlayerOutline(v); }, []);
    const setDetailOutline = useCallback((v) => { setDetailOutlineState(v); persistDetailOutline(v); }, []);
    const setSongPillShadow = useCallback((v) => { setSongPillShadowState(v); persistSongPillShadow(v); }, []);
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
    const setSpatialWidth = useCallback((v) => {
        setSpatialWidthState(v); persistSpatialWidth(v);
        spatialRef.current.width = v;
        AudioEngine.setSpatial(v / 100, spatialRef.current.balance / 100);
    }, []);
    const setSpatialBalance = useCallback((v) => {
        setSpatialBalanceState(v); persistSpatialBalance(v);
        spatialRef.current.balance = v;
        AudioEngine.setSpatial(spatialRef.current.width / 100, v / 100);
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

    const setTopBarColor = useCallback((v) => { setTopBarColorState(v); persistTopBarColor(v); }, []);
    const setBottomBarColor = useCallback((v) => { setBottomBarColorState(v); persistBottomBarColor(v); }, []);
    const setPlaylistCoverShape = useCallback((v) => { setPlaylistCoverShapeState(v); persistPlaylistCoverShape(v); }, []);
    const setPlaylistCoverShadow = useCallback((v) => { setPlaylistCoverShadowState(v); persistPlaylistCoverShadow(v); }, []);
    const setPlaylistCards = useCallback((v) => { setPlaylistCardsState(v); persistPlaylistCards(v); }, []);
    const setPlaylistArrow = useCallback((v) => { setPlaylistArrowState(v); persistPlaylistArrow(v); }, []);

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
        lyricsMode, lyricsOn, setLyricsOn, djDisc, setDjDisc, autoShow, setAutoShow, vizMode, setVizMode, djDiscSpin, setDjDiscSpin, djDiscTouch, setDjDiscTouch, autoShowLyrics, autoShowDisc,
        miniPlayerShadow: performanceMode ? false : miniPlayerShadow, setMiniPlayerShadow,
        performanceMode, setPerformanceMode, useVolumeTags, setUseVolumeTags,
        shadowsRaw: { coverShadow, playlistCoverShadow, songPillShadow, miniPlayerShadow },
        djDiscType, setDjDiscType, djDiscAssist, setDjDiscAssist,
        djDiscRpm, setDjDiscRpm, discRpmValue: DISC_RPMS[djDiscRpm] || 100 / 3,
        playerOutline, setPlayerOutline, detailOutline, setDetailOutline, songPillShadow: performanceMode ? false : songPillShadow, setSongPillShadow,
        playerBtns, setPlayerBtnShown,
        lyricsResyncSec, setLyricsResyncSec,
        lyricsOffsetSec, setLyricsOffsetSec,
        keepScreenAwake, setKeepScreenAwake,
        coverShape, setCoverShape,
        showPlayerCover, setShowPlayerCover,
        coverShadow: performanceMode ? false : coverShadow, setCoverShadow,
        backgroundImageEnabled, setBackgroundImageEnabled,
        backgroundImageUri, setBackgroundImageUri,
        crossfadeEnabled, setCrossfadeEnabled,
        crossfadeDuration, setCrossfadeDuration,
        crossfadeDurationEndOfTrack, setCrossfadeDurationEndOfTrack,
        withinTrackNorm, setWithinTrackNorm,
        preAmp, setPreAmp,
        spatialWidth, setSpatialWidth, spatialBalance, setSpatialBalance,
        betweenTrackNorm, setBetweenTrackNorm,
        silenceTrim, setSilenceTrim,
        showPlaylistTrackCount, setShowPlaylistTrackCount,
        showPlaylistTitles, setShowPlaylistTitles,
        lyricsScrollLocked, setLyricsScrollLocked,
        artistDisplayJoin, setArtistDisplayJoin,
        topBarColor, setTopBarColor,
        bottomBarColor, setBottomBarColor,
        playlistCoverShape, setPlaylistCoverShape,
        playlistCoverShadow: performanceMode ? false : playlistCoverShadow, setPlaylistCoverShadow,
        playlistCards, setPlaylistCards,
        playlistArrow, setPlaylistArrow,
        ui, setUiShown,
    }), [
        showPlayCount, showSongCovers, artistSeparator, lyricsMode, lyricsOn, djDisc, autoShow, vizMode, djDiscSpin, djDiscTouch, autoShowLyrics, autoShowDisc, miniPlayerShadow, performanceMode, useVolumeTags, djDiscType, djDiscAssist, djDiscRpm, playerOutline, detailOutline, songPillShadow, playerBtns,
        lyricsResyncSec, lyricsOffsetSec, keepScreenAwake, coverShape, showPlayerCover, coverShadow,
        backgroundImageEnabled, backgroundImageUri,
        crossfadeEnabled, crossfadeDuration, crossfadeDurationEndOfTrack, withinTrackNorm, preAmp, spatialWidth, spatialBalance, betweenTrackNorm, silenceTrim,
        showPlaylistTrackCount, showPlaylistTitles, lyricsScrollLocked, artistDisplayJoin,
        topBarColor, bottomBarColor, playlistCoverShape, playlistCoverShadow, playlistCards, playlistArrow, ui,
    ]);

    return (
        <Ctx.Provider value={value}>
            {children}
        </Ctx.Provider>
    );
}

export const usePreferences = () => useContext(Ctx);
