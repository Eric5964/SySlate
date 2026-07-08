import React, { useEffect, useState } from 'react';
import ErrorBoundary from './ErrorBoundary';

import { View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import TrackPlayer, { Capability } from 'react-native-track-player';

import { PlaybackProvider } from './context/PlaybackContext';
import AllSongsScreen  from './screens/AllSongsScreen';
import PlaylistsScreen from './screens/PlaylistsScreen';
import SettingsScreen  from './screens/SettingsScreen';
import PlayerScreen    from './screens/PlayerScreen';
import MiniPlayer      from './components/MiniPlayer';
import { scanLibrary } from './utils/files';
import { LibraryContext } from './context/LibraryContext';

import { enableScreens } from 'react-native-screens';
enableScreens(false);

const Tab  = createBottomTabNavigator();
const Root = createStackNavigator();

function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#0d0d0d',
          borderTopColor: '#1c1c1c',
          borderTopWidth: 1,
        },
        tabBarActiveTintColor:   '#7c3aed',
        tabBarInactiveTintColor: '#444',
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
        tabBarShowIcon: false,
      }}
    >
      <Tab.Screen name="All Songs"  component={AllSongsScreen}  />
      <Tab.Screen name="Playlists"  component={PlaylistsScreen} />
      <Tab.Screen name="Settings"   component={SettingsScreen}  />
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

export default function App() {
    const [library, setLibrary] = useState({ playlists: [], allSongs: [], scanPath: '' });

  const reload = async () => {
    try {
      const lib = await scanLibrary();
        setLibrary({ playlists: lib.playlists, allSongs: lib.allSongs, scanPath: lib.scanPath });
    } catch (e) {
      console.error('reload error:', e);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        await TrackPlayer.setupPlayer({ minBuffer: 5, maxBuffer: 50 });
        await TrackPlayer.updateOptions({
          capabilities: [
            Capability.Play, Capability.Pause,
            Capability.SkipToNext, Capability.SkipToPrevious, Capability.Stop,
          ],
          compactCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext],
          progressUpdateEventThrottle: 1000,
        });
      } catch {
        // Already initialized on hot reload — ignore
      }
      reload();
    })();
  }, []);

    return (
        <ErrorBoundary>
            <SafeAreaProvider>
                <LibraryContext.Provider value={{ ...library, reload }}>
        <PlaybackProvider>
          <NavigationContainer>
            <Root.Navigator screenOptions={{ headerShown: false }}>
              <Root.Screen name="Main" component={MainLayout} />
              <Root.Screen
                name="Player"
                component={PlayerScreen}
                options={{ presentation: 'modal' }}
              />
            </Root.Navigator>
          </NavigationContainer>
        </PlaybackProvider>
      </LibraryContext.Provider>
            </SafeAreaProvider>
        </ErrorBoundary>
    );
}
