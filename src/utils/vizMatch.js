import { playCountKey, playCountKeyN, baseCountKey } from './storage';

// Which row of a list is "the song that is playing right now", for the song-list
// visualizer. The exact same file wins; otherwise the same song (the key play counts
// use) in this list, even when the sound is coming from another playlist or the queue.
// Display only: it never touches the queue or the playing playlist.
export function vizRowId(songs, track) {
    if (!track || !songs || !songs.length) return null;
    for (const s of songs) if (s.id === track.id) return s.id;
    const k = playCountKey(track);
    for (const s of songs) if (playCountKey(s) === k) return s.id;
    const kn = playCountKeyN(track);
    for (const s of songs) if (playCountKeyN(s) === kn) return s.id;
    // A track without album info is matched on title + artist alone.
    if (!(typeof track.tagAlbum === 'string' && track.tagAlbum.trim())) {
        const kb = baseCountKey(track);
        for (const s of songs) if (baseCountKey(s) === kb) return s.id;
    }
    return null;
}
