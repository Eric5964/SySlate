import { useSyncExternalStore } from 'react';

// The song that was just tapped, known the moment it is tapped. The real "current song" only changes
// once the fade-out of the old song is over, so the visualizer used to start seconds after the tap.
// Display only: nothing here touches the queue or what is playing. It is cleared when the play action
// has finished (the real current song is then the same one), or after a few seconds whatever happens.
let pending = null;
let timer = null;
const subs = new Set();
const emit = () => subs.forEach((f) => f());

export const setVizPending = (song) => {
    if (timer) { clearTimeout(timer); timer = null; }
    pending = song ? { id: song.id, title: song.title, artist: song.artist, tagAlbum: song.tagAlbum, album: song.album, filename: song.filename } : null;
    if (pending) timer = setTimeout(() => { timer = null; pending = null; emit(); }, 10000);
    emit();
};
export const clearVizPending = () => { if (pending) setVizPending(null); };

const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
const snapshot = () => pending;
export const useVizPending = () => useSyncExternalStore(subscribe, snapshot, snapshot);
