import 'react-native-gesture-handler';
import React, { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { enableScreens } from 'react-native-screens';
import TrackPlayer, { Capability } from 'react-native-track-player';

import { PlaybackProvider } from './context/PlaybackContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { LibraryContext } from './context/LibraryContext';
import ErrorBoundary from './ErrorBoundary';
import AllSongsScreen from './screens/AllSongsScreen';
import PlaylistsScreen from './screens/PlaylistsScreen';
import SettingsScreen from './screens/SettingsScreen';
import PlayerScreen from './screens/PlayerScreen';
import MiniPlayer from './components/MiniPlayer';
import { scanLibrary } from './utils/files';
import { getLastSession } from './utils/storage';

enableScreens(false);

const Tab = createBottomTabNavigator();
const Root = createStackNavigator();

function TabIcon({ symbol, color }) {
    return <Text style={{ color, fontSize: 22, lineHeight: 26 }}>{symbol}</Text>;
}

function Tabs() {
    const { theme } = useTheme();
    return (
        <Tab.Navigator
            screenOptions={{
                headerShown: false,
                tabBarStyle: { backgroundColor: '#0d0d0d', borderTopColor: '#1c1c1c', borderTopWidth: 1 },
                tabBarActiveTintColor: theme.accent,
                tabBarInactiveTintColor: '#444',
                tabBarLabelStyle: { fontSize: 11, fontWeight: '600', marginBottom: 2 },
            }}
        >
            <Tab.Screen
                name="All Songs"
                component={AllSongsScreen}
                options={{ tabBarIcon: ({ color }) => <TabIcon symbol="♪" color={color} /> }}
            />
            <Tab.Screen
                name="Playlists"
                component={PlaylistsScreen}
                options={{ tabBarIcon: ({ color }) => <TabIcon symbol="▶" color={color} /> }}
            />
            <Tab.Screen
                name="Settings"
                component={SettingsScreen}
                options={{ tabBarIcon: ({ color }) => <TabIcon symbol="⚙" color={color} /> }}
            />
        </Tab.Navigator>
    );
}

function MainLayout() {
    return (
        <View style={{ flex: 1, backgroundColor: '#0a0a0a' }}>
            <Tabs />
            <MiniPlayer />
        </View>
    );
}

function AppInner() {
    const [library, setLibrary] = useState({ playlists: [], allSongs: [], scanPath: '' });

    const reload = async () => {
        try {
            const lib = await scanLibrary();
            setLibrary({ playlists: lib.playlists, allSongs: lib.allSongs, scanPath: lib.scanPath ?? '' });
        } catch (e) { console.error('reload error:', e); }
    };

    useEffect(() => {
        (async () => {
            try {
                const last = await getLastSession();
                if (last?.playlist && last?.index !== undefined) {
                    await TrackPlayer.reset();
                    await TrackPlayer.add(last.playlist.songs ?? []);
                    if (last.index > 0) await TrackPlayer.skip(last.index);
                    if (last.position > 0) await TrackPlayer.seekTo(last.position);
                }
            } catch { }
            reload();
        })();
    }, []);

    return (
        <LibraryContext.Provider value={{ ...library, reload }}>
            <PlaybackProvider>
                <NavigationContainer>
                    <Root.Navigator screenOptions={{ headerShown: false, cardStyle: { backgroundColor: '#0a0a0a' } }}>
                        <Root.Screen name="Main" component={MainLayout} />
                        <Root.Screen name="Player" component={PlayerScreen} options={{ presentation: 'modal' }} />
                    </Root.Navigator>
                </NavigationContainer>
            </PlaybackProvider>
        </LibraryContext.Provider>
    );
}

export default function App() {
    return (
        <ErrorBoundary>
            <ThemeProvider>
                <SafeAreaProvider>
                    <AppInner />
                </SafeAreaProvider>
            </ThemeProvider>
        </ErrorBoundary>
    );
}