import { Animated } from 'react-native';

// How far (in points, 0 .. screen width) a playlist screen has been slid to the right by a back swipe that started
// off the screen's edge. The playlist screen moves itself by it, and the Playlists screen underneath reads it to bring
// its own parallax shift back to rest at the same pace, exactly as the stack's edge swipe does.
export const playlistBackX = new Animated.Value(0);
