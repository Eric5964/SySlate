import 'react-native-gesture-handler';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, Text, Dimensions, Image, AppState, Easing } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createStackNavigator, TransitionPresets } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { enableScreens } from 'react-native-screens';
import AudioEngine, { Capability, usePlaybackState, State } from './native/AudioEngine';

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
import MiniPlayer from './components/MiniPlayer';
import { PersistentBackgroundImage } from './components/ScreenBackground';
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

const Tab = createBottomTabNavigator();
const Root = createStackNavigator();
const PlaylistsStack = createStackNavigator();

// Nesting these two inside their own stack (instead of PlaylistDetail living
// at the top-level Root stack) keeps the tab bar visible while viewing a
// playlist, since the tab bar chrome lives outside this nested navigator.
function PlaylistsStackScreen() {
    const { base } = useTheme();
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
    return (
        <Tab.Navigator
            initialRouteName="Playlists"
            screenOptions={{
                headerShown: false,
                tabBarStyle: { backgroundColor: base.surface, borderTopColor: base.border, borderTopWidth: 1 },
                tabBarActiveTintColor: theme.accent,
                tabBarInactiveTintColor: '#444',
                tabBarLabelStyle: { fontSize: 11, fontWeight: '600', marginBottom: 2 },
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
    return (
        <View style={{ flex: 1, backgroundColor: base.bg }}>
            <Tabs />
            <MiniPlayer />
        </View>
    );
}

function AppInner() {
    const [library, setLibrary] = useState({ playlists: [], allSongs: [], scanPath: '', scanError: null, covers: {} });
    const [playerReady, setPlayerReady] = useState(false);
    const { ready: themeReady, base, theme } = useTheme();
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
            await Promise.all(
                Object.values(covers).filter(Boolean).map(uri => Image.prefetch(uri).catch(() => { }))
            );
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

    const reload = useCallback(async () => {
        try {
            const lib = await scanLibrary();
            // Actually WAIT for these instead of firing-and-forgetting —
            // the whole point is the UI doesn't render until images are
            // already in RN's cache, otherwise this preload step does
            // nothing to prevent the first-render flash it's meant to fix.
            const covers = await prefetchPlaylistCovers();
            setLibrary({ playlists: lib.playlists, allSongs: lib.allSongs, scanPath: lib.scanPath ?? '', scanError: lib.scanError ?? null, covers: covers ?? {} });
        } catch (e) { console.error('reload:', e); }
    }, [prefetchPlaylistCovers]);

    useEffect(() => {
        (async () => {
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
            await reload();
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

    // Loading screen. Requested: app icon + base color, hides launch-time
    // rough edges (the pop, lyrics not positioned yet, etc.) while
    // everything preloads, capped around 0.5s.
    //
    // This is the SAME gate that already existed here (playerReady &&
    // themeReady) — it already only shows for as long as real preload
    // actually takes, so it was never going to hang open longer than
    // necessary; nothing changed about WHEN it clears. What's new is what
    // it shows while it's up: base color + a centered icon slot instead of
    // a bare color rectangle.
    //
    // No icon file yet — placeholder is a plain rounded accent-color
    // square standing in for it. Once you send the icon: drop it at
    // src/assets/app-icon.png, then replace the placeholderIcon View below
    // with:
    //   <Image source={require('./assets/app-icon.png')} style={{ width: 96, height: 96, borderRadius: 22 }} resizeMode="contain" />
    // — everything else here (centering, background, the gate itself)
    // already doesn't need to change.
    if (!playerReady || !themeReady) {
        return (
            <View style={{ flex: 1, backgroundColor: base.bg, alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: 96, height: 96, borderRadius: 22, backgroundColor: theme.accent }} />
            </View>
        );
    }

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
                                    // "Down arrow closes too fast vs. opening
                                    // it" — couldn't verify from here whether
                                    // ModalSlideFromBottomIOS's own open/close
                                    // transitionSpec is actually symmetric by
                                    // default (no node_modules in this zip to
                                    // check against, and the down-arrow button
                                    // is a plain navigation.goBack(), not the
                                    // gesture path gestureVelocityImpact above
                                    // affects — so that wasn't the cause
                                    // either way). Pinning both directions to
                                    // the exact same explicit timing removes
                                    // the guesswork regardless of what the
                                    // preset's actual default was.
                                    transitionSpec: {
                                        open: { animation: 'timing', config: { duration: 350, easing: Easing.out(Easing.poly(4)) } },
                                        close: { animation: 'timing', config: { duration: 350, easing: Easing.in(Easing.poly(4)) } },
                                    },
                                }}
                            />
                        </Root.Navigator>
                    </NavigationContainer>
                </PlaybackProvider>
            </LibraryContext.Provider>
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