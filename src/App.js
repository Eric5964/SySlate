import 'react-native-gesture-handler';
import React, { useEffect, useState } from 'react';
import { View, Text, Dimensions, Image } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator, TransitionPresets } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { enableScreens } from 'react-native-screens';
import AudioEngine, { Capability, usePlaybackState, State } from './native/AudioEngine';

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
import { scanLibrary } from './utils/files';
import { getPlaylistCovers } from './utils/storage';
import { EDGE_SWIPE_WIDTH } from './utils/layout';

enableScreens(false);

const Tab = createBottomTabNavigator();
const Root = createStackNavigator();
const PlaylistsStack = createStackNavigator();

// Nesting these two inside their own stack (instead of PlaylistDetail living
// at the top-level Root stack) keeps the tab bar visible while viewing a
// playlist, since the tab bar chrome lives outside this nested navigator.
function PlaylistsStackScreen() {
    const { base } = useTheme();
    return (
        <PlaylistsStack.Navigator screenOptions={{ headerShown: false, cardStyle: { backgroundColor: base.bg } }}>
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
    const [library, setLibrary] = useState({ playlists: [], allSongs: [], scanPath: '', scanError: null });
    const [playerReady, setPlayerReady] = useState(false);
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

    const reorderPlaylists = (newPlaylists) => {
        setLibrary(prev => ({ ...prev, playlists: newPlaylists }));
    };

    // Same reasoning as the playlist-cover prefetch in reload() below —
    // the background image previously had no prefetch at all, so its very
    // first paint each app launch always flashed in.
    useEffect(() => {
        if (backgroundImageEnabled && backgroundImageUri) {
            Image.prefetch(backgroundImageUri).catch(() => { });
        }
    }, [backgroundImageEnabled, backgroundImageUri]);

    const reload = async () => {
        try {
            const lib = await scanLibrary();
            setLibrary({ playlists: lib.playlists, allSongs: lib.allSongs, scanPath: lib.scanPath ?? '', scanError: lib.scanError ?? null });
            try {
                const covers = await getPlaylistCovers();
                // Actually WAIT for these instead of firing-and-forgetting —
                // the whole point is the UI doesn't render until images are
                // already in RN's cache, otherwise this preload step does
                // nothing to prevent the first-render flash it's meant to fix.
                await Promise.all(
                    Object.values(covers).filter(Boolean).map(uri => Image.prefetch(uri).catch(() => { }))
                );
            } catch { }
        } catch (e) { console.error('reload:', e); }
    };

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

    // Wait on theme too, not just the player — otherwise the real
    // NavigationContainer/screens can mount for a frame or two using
    // ThemeContext's purple/black placeholders before AsyncStorage resolves
    // the user's actual pick.
    if (!playerReady || !themeReady) {
        return <View style={{ flex: 1, backgroundColor: base.bg }} />;
    }

    return (
        <LibraryContext.Provider value={{ ...library, reload, reorderPlaylists }}>
            <PlaybackProvider>
                <NavigationContainer>
                    <Root.Navigator screenOptions={{ headerShown: false, cardStyle: { backgroundColor: base.bg } }}>
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
                            }}
                        />
                    </Root.Navigator>
                </NavigationContainer>
            </PlaybackProvider>
        </LibraryContext.Provider>
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