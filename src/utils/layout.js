import { Dimensions } from 'react-native';

// Shared between App.js (the PlaylistDetail back-gesture's
// gestureResponseDistance) and SwipeableRow's edgeExclude prop, so the two
// always agree on exactly where the boundary is instead of two separate
// magic numbers drifting apart. ~10% of screen width, per request.
export const EDGE_SWIPE_WIDTH = Math.round(Dimensions.get('window').width * 0.1);
