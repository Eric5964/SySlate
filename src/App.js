import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import TrackPlayer, { Capability } from 'react-native-track-player';
import PlaylistsScreen from './screens/PlaylistsScreen';
import PlayerScreen from './screens/PlayerScreen';

const Stack = createNativeStackNavigator();

export default function App() {
  useEffect(() => {
    async function setup() {
      await TrackPlayer.setupPlayer({ minBuffer: 5, maxBuffer: 50 });
      await TrackPlayer.updateOptions({
        capabilities: [
          Capability.Play, Capability.Pause,
          Capability.SkipToNext, Capability.SkipToPrevious, Capability.Stop,
        ],
        compactCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext],
      });
    }
    setup().catch(console.error);
  }, []);

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0a0a0a' } }}>
        <Stack.Screen name="Playlists" component={PlaylistsScreen} />
        <Stack.Screen name="Player" component={PlayerScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}