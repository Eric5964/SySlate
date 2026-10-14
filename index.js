import 'react-native-gesture-handler';
import './polyfill';
import { registerRootComponent } from 'expo';
import App from './src/App';
import { PlaybackService } from './src/services/PlaybackService';

registerRootComponent(App);
// Starts the playback service (remote-control / lock-screen listeners) once, right after launch.
// This is what react-native-track-player's registerPlaybackService used to do on iOS
// (it simply ran the service on the next tick); that package is no longer used.
setImmediate(() => { Promise.resolve(PlaybackService()).catch(() => { }); });
