import 'react-native-gesture-handler';
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, Dimensions, Image, AppState, Animated, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { autoBackupIfDue, listAutoBackups, restoreAutoBackup } from './utils/storage';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createStackNavigator, TransitionPresets } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { enableScreens } from 'react-native-screens';
import AudioEngine, { Capability, usePlaybackState, State } from './native/AudioEngine';
import { startDebugLogCapture } from './utils/debugLog';

// Started here, at true app entry, before anything else has a chance to
// log — see debugLog.js's own comment for why this exists at all (no
// Xcode/console on a sideloaded GH-Actions build).
startDebugLogCapture();

// Real cause of the background image (and, before it, any custom base
// color) never actually showing through: NavigationContainer was never
// given a `theme` prop, so it silently used React Navigation's own default
// LIGHT theme — whose background color (rgb(242,242,242), a light gray) the
// tab and stack navigators paint as an opaque layer of their own, completely
// independent of ScreenBackground.js or anything else this app controls.
// `cardStyle: { backgroundColor: 'transparent' }` on the Stack Navigator's
// screenOptions only ever addressed the STACK's own card layer — this
// deeper default was always still there underneath it, on every screen,
// tab or stack alike. Built from DarkTheme rather than a bare object so
// every other theme field (fonts, etc., which NavigationContainer's types
// require) stays sane — only background/card need overriding to transparent
// for this app's own per-screen backgrounds and PersistentBackgroundImage to
// ever be visible instead.
const NAV_THEME = { ...DarkTheme, colors: { ...DarkTheme.colors, background: 'transparent', card: 'transparent' } };

import { PlaybackProvider } from './context/PlaybackContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { PreferencesProvider, usePreferences } from './context/PreferencesContext';
import { LibraryContext } from './context/LibraryContext';
import { useBackgroundLibraryLoader } from './hooks/useBackgroundLibraryLoader';
import { useScreenAwake } from './hooks/useScreenAwake';
import ErrorBoundary from './ErrorBoundary';
import AllSongsScreen from './screens/AllSongsScreen';
import PlaylistsScreen from './screens/PlaylistsScreen';
import PlaylistDetailScreen from './screens/PlaylistDetailScreen';
import SettingsScreen from './screens/SettingsScreen';
import PlayerScreen from './screens/PlayerScreen';
import DebugLogScreen from './screens/DebugLogScreen';
import StatsScreen from './screens/StatsScreen';
import MiniPlayer from './components/MiniPlayer';
import { PersistentBackgroundImage } from './components/ScreenBackground';
import { preloadArtCache } from './utils/embeddedArt';
import { scanLibrary } from './utils/files';
import { getPlaylistCovers } from './utils/storage';
import { EDGE_SWIPE_WIDTH } from './utils/layout';

// Real cause of "background is a mixture of all screens" (torn/overlapping
// content from two different tabs painting at once, e.g. Playlists' grid
// showing through Settings' Export/Import rows with both titles stacked on
// top of each other): enableScreens(false) below meant react-native-screens
// was never actually doing anything — every tab AND stack screen this app
// has ever navigated to stays fully mounted in the view hierarchy forever,
// just repositioned, instead of being properly detached natively. That's
// normally "just" a performance cost (very likely also behind "transitions
// go slow after being out of the app a while" — more mounted screens
// accumulating the longer a session runs), but under some navigation
// timing (fast tab switches, this report's likely trigger) it's also what
// let two screens' content actually render simultaneously in the same
// space instead of one being cleanly hidden behind the other.
// No comment/history explained why this was ever disabled — package.json
// confirms react-native-screens is a real, installed dependency (3.31.0),
// so there's no reason it shouldn't be doing its job. Enabling it.
// Flagging the one real risk: if this was disabled in the first place to
// work around some specific crash (react-native-screens has historically
// had rough edges paired with react-native-gesture-handler, and this app
// leans heavily on custom gesture handlers — BottomSheet's handle,
// PlaylistDetail's swipe-back, the progress bar's own pan/tap handlers),
// turning it back on could resurface whatever that was. Test those
// gesture-heavy spots specifically after this build, not just the tearing
// itself.
enableScreens(true);

// Sampled directly from src/assets/app-icon.jpg's own background — an icon
// designed against one specific color looks off composited over a
// different one, even briefly.

const Tab = createBottomTabNavigator();
const Root = createStackNavigator();
const PlaylistsStack = createStackNavigator();

// Nesting these two inside their own stack (instead of PlaylistDetail living
// at the top-level Root stack) keeps the tab bar visible while viewing a
// playlist, since the tab bar chrome lives outside this nested navigator.
function PlaylistsStackScreen() {
    return (
        <PlaylistsStack.Navigator screenOptions={{ headerShown: false, cardStyle: { backgroundColor: 'transparent' } }}>
            <PlaylistsStack.Screen name="PlaylistsList" component={PlaylistsScreen} />
            <PlaylistsStack.Screen
                name="PlaylistDetail"
                component={PlaylistDetailScreen}
                options={{
                    ...TransitionPresets.SlideFromRightIOS,
                    gestureEnabled: true,
                    gestureDirection: 'horizontal',
                    // A bit higher than the 0.3 default so a quick flick
                    // carries the swipe-to-dismiss through more readily,
                    // instead of needing to cross most of the screen width.
                    gestureVelocityImpact: 0.5,
                    // Narrow on purpose — SwipeableRow's swipe-to-queue gesture
                    // on song rows uses the rest of the row's width, so this
                    // back-gesture only claims a thin strip at the very edge
                    // (matching iOS's own edge-swipe convention) to leave room
                    // for both to coexist. SwipeableRow's own edgeExclude prop
                    // (see PlaylistDetailScreen) carves out this same width
                    // from ITS side too, so the edge zone belongs to this
                    // back-gesture outright instead of the two arbitrating.
                    gestureResponseDistance: EDGE_SWIPE_WIDTH,
                }}
            />
        </PlaylistsStack.Navigator>
    );
}

function Tabs() {
    const { theme, base } = useTheme();
    const { bottomBarColor } = usePreferences();
    return (
        <Tab.Navigator
            initialRouteName="Playlists"
            screenOptions={{
                headerShown: false,
                // Colored: the bar uses the base color. Off: transparent like the top bars, with lists passing behind it.
                tabBarStyle: bottomBarColor
                    ? { backgroundColor: base.surface, borderTopColor: base.border, borderTopWidth: 1 }
                    : { position: 'absolute', backgroundColor: 'transparent', borderTopWidth: 0, elevation: 0, shadowOpacity: 0 },
                tabBarActiveTintColor: theme.accent,
                tabBarInactiveTintColor: '#444',
                tabBarLabelStyle: { fontSize: 11, fontWeight: '600', marginBottom: 2 },
                // Real cause of "background image doesn't load/appear
                // anymore" after enableScreens(true): Tab.Navigator (from
                // @react-navigation/bottom-tabs) doesn't use cardStyle —
                // it's sceneContainerStyle. This was never set, so each
                // tab's content area had no explicit background at all.
                // Under enableScreens(false) that was harmless (a plain RN
                // View defaults to transparent, so PersistentBackgroundImage
                // behind the whole navigator showed through by accident).
                // Under enableScreens(true), each tab is now a native
                // screen container, which paints its own default —
                // opaque — background unless told otherwise, sitting
                // directly on top of PersistentBackgroundImage and hiding
                // it completely. This is exactly the same class of issue
                // as react-navigation/react-navigation#4759 (cardStyle
                // transparent doesn't survive native screens without being
                // explicit about it).
                sceneContainerStyle: { backgroundColor: 'transparent' },
                // @react-navigation/bottom-tabs is v7 here (package.json),
                // where sceneContainerStyle no longer exists — the v7 name
                // is sceneStyle, inside screenOptions. The line above is
                // silently ignored on v7; this is the one that counts.
                sceneStyle: { backgroundColor: 'transparent' },
                // The loading screen is meant to hide first-mount cost for
                // ALL THREE tabs, not just whichever one happens to be
                // initialRouteName — Tab.Navigator's default (lazy: true)
                // only mounts a tab the first time it's actually visited,
                // so All Songs and Settings were never actually part of
                // what the loading screen was covering; they'd still mount
                // (and pay their own first-render cost) the first time the
                // user tapped over to them, loading screen or not. lazy:
                // false mounts all three together, while AppInner's overlay
                // still fully covers this — see its own comment.
                lazy: false,
            }}
        >
            <Tab.Screen
                name="All Songs"
                component={AllSongsScreen}
                options={{ tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 22 }}>♪</Text> }}
            />
            <Tab.Screen
                name="Playlists"
                component={PlaylistsStackScreen}
                options={{ tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 22 }}>▶</Text> }}
            />
            <Tab.Screen
                name="Settings"
                component={SettingsScreen}
                options={{ tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18, letterSpacing: 1 }}>···</Text> }}
            />
        </Tab.Navigator>
    );
}

function MainLayout() {
    const { base } = useTheme();
    const { backgroundImageEnabled, backgroundImageUri } = usePreferences();
    // Real cause of "custom background only shows on the Player, not on
    // Settings/Playlists/All Songs" (confirmed from a screen recording:
    // toggle ON, image visible on Player, plain black everywhere else):
    // this wrapper was ALWAYS solid base.bg, sitting directly on top of
    // PersistentBackgroundImage (rendered behind the whole navigator) and
    // hiding it for every tab. Player only looked fine because Main is
    // detached while Player covers it. Transparent when an image is
    // active, solid otherwise — same rule ScreenBackground already uses.
    const hasImage = !!(backgroundImageEnabled && backgroundImageUri);
    return (
        <View style={{ flex: 1, backgroundColor: hasImage ? 'transparent' : base.bg }}>
            <Tabs />
            <MiniPlayer />
        </View>
    );
}

function AppInner() {
    const [library, setLibrary] = useState({ playlists: [], allSongs: [], scanPath: '', scanError: null, covers: {} });
    const [playerReady, setPlayerReady] = useState(false);
    // Daily automatic copy of the settings. If the app's own storage was wiped
    // (it has never opened before, but a backup copy exists in Documents), ask
    // once whether to restore it.
    useEffect(() => {
        if (!playerReady) return;
        (async () => {
            try {
                const launched = await AsyncStorage.getItem('app_launched_before');
                await AsyncStorage.setItem('app_launched_before', '1');
                if (!launched) {
                    const list = await listAutoBackups();
                    if (list.length) {
                        const when = list[0].time ? new Date(list[0].time).toLocaleDateString() : 'earlier';
                        Alert.alert('Restore your settings?', `Your settings look like they were reset. A backup from ${when} is available.`, [
                            { text: 'Not now', style: 'cancel' },
                            { text: 'Restore', onPress: async () => { try { await restoreAutoBackup(list[0].n); Alert.alert('Restored', 'Close and reopen SySlate to apply.'); } catch { Alert.alert('Could not restore', 'That backup could not be read.'); } } },
                        ]);
                        return;
                    }
                }
                autoBackupIfDue();
            } catch { }
        })();
    }, [playerReady]);
    const { ready: themeReady, base } = useTheme();
    const { showSongCovers, keepScreenAwake, backgroundImageEnabled, backgroundImageUri } = usePreferences();
    const playbackState = usePlaybackState();

    // Only while actively playing (not paused, not just "app is open") —
    // see useScreenAwake for why.
    useScreenAwake(playerReady && keepScreenAwake && playbackState.state === State.Playing);

    // One shared background worker instead of two competing ones — see
    // useBackgroundLibraryLoader for why that matters. Tags aren't gated on
    // showSongCovers like art is (title/artist/album feed sorting and
    // search everywhere, not just an optional visual), so the two run under
    // independent conditions even though they share one loop/budget.
    useBackgroundLibraryLoader(library.allSongs, { art: playerReady && showSongCovers, tags: playerReady });

    // Real bug found here (contributes to overall app sluggishness): a
    // plain function, recreated every AppInner render — combined with the
    // Provider value below being a fresh object every render too, every
    // LibraryContext consumer (Playlists, All Songs, Playlist Detail,
    // Settings) re-rendered on every single AppInner render, not just when
    // playlists actually changed.
    const reorderPlaylists = useCallback((newPlaylists) => {
        setLibrary(prev => ({ ...prev, playlists: newPlaylists }));
    }, []);

    // Same reasoning as the playlist-cover prefetch in reload() below —
    // the background image previously had no prefetch at all, so its very
    // first paint each app launch always flashed in.
    useEffect(() => {
        if (backgroundImageEnabled && backgroundImageUri) {
            Image.prefetch(backgroundImageUri).catch(() => { });
        }
    }, [backgroundImageEnabled, backgroundImageUri]);

    // Extracted out of reload() so it can also run on its own on app
    // resume below — reload() does a full library rescan too, which isn't
    // needed (and isn't cheap) just to refresh an image cache. Same
    // reasoning as PreferencesContext's background-image resume prefetch:
    // "playlist covers... flash a color before loading" — the underlying
    // native image cache isn't necessarily still warm after the app's been
    // backgrounded a while, and this had previously only ever run once, at
    // whatever moment reload() happened to be called.
    //
    // Real remaining gap found here: this warmed the image BYTES into RN's
    // cache, but PlaylistsScreen's own `covers` state (the playlist→cover
    // URI map itself, not the image data) was always fetched completely
    // independently, from scratch, on that screen's own mount — with no
    // way to know this had already just resolved the exact same data a
    // moment earlier. So even on a cold launch where every cover image was
    // already decoded and cached by the time the screen painted, the grid
    // still didn't know WHICH uri to hand each row's Image until its own
    // fetch resolved a beat later — showing the colored placeholder in the
    // meantime regardless of the image cache being ready. Now returns the
    // map so it can be stored once, here, and handed to the screen as an
    // already-known starting value — same fix already applied for the
    // grid→detail navigation case (see openPlaylist's comment in
    // PlaylistsScreen.js), just extended to cover this direction too.
    const prefetchPlaylistCovers = useCallback(async () => {
        try {
            const covers = await getPlaylistCovers();
            // Warm what we can, but never hold the splash screen more than
            // ~0.6s for it. Anything not warm by then just loads as it shows.
            await Promise.race([
                Promise.all(Object.values(covers).filter(Boolean).map(uri => Image.prefetch(uri).catch(() => { }))),
                new Promise(r => setTimeout(r, 600)),
            ]);
            return covers;
        } catch { return null; }
    }, []);

    useEffect(() => {
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active') {
                prefetchPlaylistCovers().then(covers => {
                    if (covers) setLibrary(prev => ({ ...prev, covers }));
                });
                if (backgroundImageEnabled && backgroundImageUri) {
                    Image.prefetch(backgroundImageUri).catch(() => { });
                }
            }
        });
        return () => sub.remove();
    }, [backgroundImageEnabled, backgroundImageUri, prefetchPlaylistCovers]);

    const reloadSeq = useRef(0);
    const reload = useCallback(async () => {
        const seq = ++reloadSeq.current;
        try {
            const lib = await scanLibrary();
            // Actually WAIT for these instead of firing-and-forgetting —
            // the whole point is the UI doesn't render until images are
            // already in RN's cache, otherwise this preload step does
            // nothing to prevent the first-render flash it's meant to fix.
            const covers = await prefetchPlaylistCovers();
            if (seq !== reloadSeq.current) return;   // a newer scan was started: its result wins
            setLibrary({ playlists: lib.playlists, allSongs: lib.allSongs, scanPath: lib.scanPath ?? '', scanError: lib.scanError ?? null, covers: covers ?? {} });
        } catch (e) { console.error('reload:', e); }
    }, [prefetchPlaylistCovers]);

    useEffect(() => {
        (async () => {
            // Library scan runs alongside player setup instead of after it.
            preloadArtCache().catch(() => { });
            const libraryLoad = reload();
            try {
                await AudioEngine.setupPlayer({ minBuffer: 5, maxBuffer: 50 });
                await AudioEngine.setVolume(1);
                await AudioEngine.updateOptions({
                    capabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext, Capability.SkipToPrevious, Capability.Stop],
                    compactCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext],
                    // Was `progressUpdateEventThrottle: 150` — not a real
                    // react-native-track-player option (that name doesn't
                    // exist in its API), so it was silently ignored. The
                    // real option is progressUpdateEventInterval, in
                    // seconds, and without it set, Event.PlaybackProgressUpdated
                    // never fires at all — which is exactly what play-count
                    // crediting in PlaybackContext depends on entirely to
                    // know when a song crosses 50% played. The visible
                    // progress bar elsewhere never looked broken because it
                    // polls position on its own and was never affected by
                    // this — only the count, which had no other path to
                    // being incremented, silently never moved.
                    progressUpdateEventInterval: 1,
                });
            } catch { }
            await libraryLoad;
            // Deliberately gate rendering on this instead of restoring inside
            // PlaybackProvider's own mount effect — child effects fire BEFORE
            // parent effects on initial mount, so a restore effect living
            // inside PlaybackProvider (a child of AppInner) would have run
            // before AudioEngine.setupPlayer() above ever finished.
            setPlayerReady(true);
        })();
    }, []);

    // Real bug found here (contributes to overall app sluggishness,
    // possibly part of "settings feels slow" too): this was a fresh object
    // literal every single AppInner render (spreading `library` plus two
    // functions) — meaning every LibraryContext consumer (Playlists, All
    // Songs, Playlist Detail, Settings) re-rendered on every AppInner
    // render for ANY reason (the AppState listener firing, a preferences
    // change bubbling through, etc.), not just when the library itself
    // actually changed. reload/reorderPlaylists are stable now (useCallback
    // above), so this only actually produces a new object when `library`
    // itself changes.
    //
    // Must run before the playerReady/themeReady early return below —
    // every hook has to run on every render regardless of that branch, or
    // the hook count changes between the "not ready" render and the first
    // "ready" render (this was the "Rendered more hooks than during the
    // previous render" crash on launch).
    const libraryContextValue = useMemo(() => ({ ...library, reload, reorderPlaylists }), [library, reload, reorderPlaylists]);

    // Loading screen — icon + its own background color, hides launch-time
    // rough edges (the pop, lyrics not positioned yet, etc.) while
    // everything preloads.
    //
    // This used to be a plain early-return gate: nothing below it (the
    // whole NavigationContainer, all three tabs) even started mounting
    // until playerReady/themeReady flipped true, then everything mounted
    // for the first time AFTER the loading screen was already gone — so it
    // was never actually hiding any real mounting cost, just showing a
    // color for a bit beforehand. Restructured so the real app mounts
    // UNDERNEATH this overlay instead (see the return below): everything
    // (all three tabs now, too — see Tabs' lazy:false) mounts while this is
    // still fully covering it, then fades out once actually ready, so what
    // gets revealed is already warm rather than mounting live in front of
    // the user.
    const overlayOpacity = useRef(new Animated.Value(1)).current;
    const [showOverlay, setShowOverlay] = useState(true);
    useEffect(() => {
        if (!playerReady || !themeReady) return;
        // Per request: no more icon, no more 500ms floor — just the base
        // color as a bridge over the real black frame before anything is
        // ready, gone as soon as it can be. No artificial floor (that was
        // only ever there to give the icon a moment to actually be seen);
        // the moment playerReady/themeReady flip true, a quick 250ms fade
        // starts immediately.
        Animated.timing(overlayOpacity, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => {
            setShowOverlay(false);
        });
    }, [playerReady, themeReady]);

    return (
        <View style={{ flex: 1 }}>
            {/* Rendered once, here, for the life of the app session — see
                ScreenBackground.js's big comment for why this moved out of
                every individual screen (each of which still controls
                whether IT shows solid or transparent via ScreenBackground,
                so this shows through exactly where it used to). */}
            <PersistentBackgroundImage />
            <LibraryContext.Provider value={libraryContextValue}>
                <PlaybackProvider>
                    <NavigationContainer theme={NAV_THEME}>
                        {/* transparent, not base.bg — a stack screen's card
                            is an opaque layer by default, which would sit
                            on top of and completely hide the persistent
                            background Image now rendered once behind the
                            whole navigator (see PersistentBackgroundImage
                            above). Each screen's own ScreenBackground
                            already decides solid-vs-transparent per screen
                            (based on whether a background image is
                            actually active), so the card itself just needs
                            to get out of the way and let that show through;
                            same reasoning for PlaylistsStackScreen's
                            Navigator above. */}
                        <Root.Navigator screenOptions={{ headerShown: false, cardStyle: { backgroundColor: 'transparent' } }}>
                            <Root.Screen name="Main" component={MainLayout} />
                            {/* Plain default push/slide transition — this is a
                                utility screen, not part of the app's designed
                                navigation feel, so it deliberately doesn't get
                                any of the custom transition tuning below. */}
                            <Root.Screen name="DebugLog" component={DebugLogScreen} />
                            <Root.Screen name="Stats" component={StatsScreen} />
                            <Root.Screen
                                name="Player"
                                component={PlayerScreen}
                                options={{
                                    ...TransitionPresets.ModalSlideFromBottomIOS,
                                    gestureEnabled: true,
                                    gestureResponseDistance: Dimensions.get('window').height,
                                    // Same tuning as the playlist swipe-out — a
                                    // quick flick carries the dismiss through
                                    // more readily instead of needing to cross
                                    // most of the screen height.
                                    gestureVelocityImpact: 0.5,
                                    // Round 47 added a custom `timing`-based
                                    // transitionSpec here to try to make the
                                    // down-arrow's close match the open
                                    // speed — wrong fix, reverted. A `timing`
                                    // animation computes its curve from a
                                    // fresh start every time; it doesn't know
                                    // or care where a gesture-driven dismiss
                                    // was released, so handing off from a
                                    // partial swipe to that timing curve
                                    // produced exactly the reported
                                    // "restarts the animation at the spot you
                                    // stopped swiping" glitch. ModalSlide-
                                    // FromBottomIOS's own default is `spring`
                                    // based (TransitionIOSSpec), which is
                                    // already symmetric between open/close
                                    // AND naturally continues from a gesture's
                                    // current position/velocity instead of
                                    // restarting — removing the override
                                    // fixes the gesture case. Whatever
                                    // actually caused the original "close
                                    // feels faster than open" report is still
                                    // unconfirmed — this was a guess that
                                    // turned out wrong, not a diagnosed fix.
                                }}
                            />
                        </Root.Navigator>
                    </NavigationContainer>
                </PlaybackProvider>
            </LibraryContext.Provider>
            {showOverlay && (
                // Per request: just the base color, same as what's already
                // showing underneath the instant it's ready — no icon, no
                // separate "designed" moment, just a fast bridge over the
                // real black frame before anything mounts. Fades out over
                // ~0.25s (see the effect above) instead of sitting on
                // screen first.
                <Animated.View
                    pointerEvents="none"
                    style={{
                        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                        backgroundColor: base.bg,
                        opacity: overlayOpacity,
                    }}
                />
            )}
        </View>
    );
}

export default function App() {
    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <ErrorBoundary>
                <ThemeProvider>
                    <PreferencesProvider>
                        <SafeAreaProvider>
                            <AppInner />
                        </SafeAreaProvider>
                    </PreferencesProvider>
                </ThemeProvider>
            </ErrorBoundary>
        </GestureHandlerRootView>
    );
}