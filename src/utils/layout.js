import { useState, useCallback } from 'react';
import { Dimensions } from 'react-native';

// Shared between App.js (the PlaylistDetail back-gesture's
// gestureResponseDistance) and SwipeableRow's edgeExclude prop, so the two
// always agree on exactly where the boundary is instead of two separate
// magic numbers drifting apart. ~18% of screen width, per request. Also used by the Stats and Debug Log back-swipes.
export const EDGE_SWIPE_WIDTH = Math.round(Dimensions.get('window').width * 0.18);

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

// The "Added" badge shows near the right end of a swiped row. The title block used to reserve room for it
// (cutting long titles off early, on every row, all the time). It no longer does: titles use the whole row,
// and while "Added" shows, SwipeableRow dims the text under and near the badge instead (see its dimColor).
// Kept as a function so every row that calls it stays as it is.
export const addedClearance = () => 0;

// Transparent top bar: the header floats over the screen (so a list can scroll
// behind it) and the list starts lower by the header's own height, so at the
// top of the list everything sits exactly where it does with a colored bar.
// useMeasuredHeight gives that height (an estimate until the header has been
// laid out) and the onLayout to put on the header.
export const OVERLAY_HEADER = { position: 'absolute', top: 0, left: 0, right: 0 };
export function useMeasuredHeight(estimate) {
    const [h, setH] = useState(estimate);
    const onLayout = useCallback((e) => {
        const v = Math.round(e.nativeEvent.layout.height);
        if (v > 0) setH((p) => (Math.abs(p - v) > 0.5 ? v : p));
    }, []);
    return [h, onLayout];
}
