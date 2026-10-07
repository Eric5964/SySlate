import { Dimensions } from 'react-native';

// Shared between App.js (the PlaylistDetail back-gesture's
// gestureResponseDistance) and SwipeableRow's edgeExclude prop, so the two
// always agree on exactly where the boundary is instead of two separate
// magic numbers drifting apart. ~10% of screen width, per request.
export const EDGE_SWIPE_WIDTH = Math.round(Dimensions.get('window').width * 0.1);

// Pill-style rows everywhere (Playlists list layouts, All Songs, Playlist
// songs, Queue) share one height and one cover size, taken from the mini
// player (68 tall, 44 cover) and made a little shorter. The cover keeps the
// mini player's size and sits evenly spaced from the top, bottom and left.
export const PILL_H = 64;
export const PILL_COVER = 44;
export const PILL_COVER_PAD = (PILL_H - PILL_COVER) / 2;

// Top bars (Playlists, All Songs, Settings, and the same row on the Playlist
// and Player screens): the bar's solid part ends TOP_FADE above its old
// bottom edge, with a soft shadow under it. The
// bar's contents moved up by the same amount, so nothing below shifts.
export const TOP_FADE = 6;
export const TOP_PAD = 56 - TOP_FADE;

// Padding for a song/playlist pill row. With a cover the cover sits the same
// distance from the left, top and bottom edges; without one the text gets
// the same pill height with ordinary side padding.
export const pillPad = (hasCover) => ({
    minHeight: PILL_H,
    paddingVertical: hasCover ? PILL_COVER_PAD : 12,
    paddingLeft: hasCover ? PILL_COVER_PAD : 16,
    paddingRight: 16,
});
