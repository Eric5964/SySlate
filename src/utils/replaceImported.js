import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { scanLibrary, applyTags } from './files';
import { extractTags, getCachedTags } from './tags';
import { getAlbumFromFolder, getArtistSeparator, playCountKey, baseCountKey } from './storage';

// After an import: a song that was just added replaces an OLDER copy of the same song in the same
// playlist. "Same song" is the one rule used everywhere in the app (play counts, All Songs):
// the same title + artist, whatever the file format, length or size. The old file is deleted.
// When both files have the same extension the new file takes the old file's name and place, so the
// song keeps its identity (queue slot, lyrics, per-file data).
//
// `added`: paths under Documents of the audio files the import just copied in.
// `hooks`: { hold(oldIds), swap(pairs) } from the Playback context. hold() ramps the playing song
// out when it is one of the old ones; swap() points the queue at the new files.
// Resolves { replaced } (number of old files replaced).
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const extOf = (n) => { const i = (n || '').lastIndexOf('.'); return i >= 0 ? n.slice(i).toLowerCase() : ''; };
const nfc = (x) => (x && x.normalize) ? x.normalize('NFC') : x;

export async function replaceImportedDuplicates(added, hooks) {
    if (!added?.length) return { replaced: 0 };
    const base = FileSystem.documentDirectory;
    if (!base) return { replaced: 0 };
    const lib = await scanLibrary();
    const songs = lib?.allSongs || [];
    const relOf = (id) => (typeof id === 'string' && id.startsWith(base)) ? nfc(id.slice(base.length)) : null;
    const groupOf = (rel) => { const i = rel.indexOf('/'); return i < 0 ? '' : rel.slice(0, i); };

    const addedSet = new Set(added.map(nfc));
    const newSongs = songs.filter(sg => { const r = relOf(sg.id); return r !== null && addedSet.has(r); });
    if (!newSongs.length) return { replaced: 0 };
    const newIds = new Set(newSongs.map(sg => sg.id));
    const groups = new Set(newSongs.map(sg => groupOf(relOf(sg.id))));

    const albumFromFolder = await getAlbumFromFolder();
    const artistSeparator = await getArtistSeparator();
    // The song as the library will see it once its tags are read, so the key is exactly the play count key.
    const keyOf = async (song) => {
        try { if ((await getCachedTags(song)) === undefined) { await extractTags(song); await sleep(15); } } catch { }
        const resolved = await applyTags(song, albumFromFolder, artistSeparator);
        const key = playCountKey(resolved);
        return { key, resolved, empty: baseCountKey(resolved) === 'pcn:::' };
    };

    // The newest copy wins when several new files share one song.
    const newByGroupKey = new Map();   // `${group}\u0000${key}` -> { song, resolved }
    for (const sg of newSongs) {
        const k = await keyOf(sg);
        if (!k.empty) newByGroupKey.set(`${groupOf(relOf(sg.id))}\u0000${k.key}`, { song: sg, resolved: k.resolved });
    }
    if (!newByGroupKey.size) return { replaced: 0 };

    const found = [];   // { old, neu, key }
    for (const sg of songs) {
        if (newIds.has(sg.id)) continue;
        const rel = relOf(sg.id);
        if (rel === null) continue;
        const g = groupOf(rel);
        if (!groups.has(g)) continue;
        const k = await keyOf(sg);
        if (k.empty) continue;
        const hit = newByGroupKey.get(`${g}\u0000${k.key}`);
        if (hit && hit.song.id !== sg.id) found.push({ old: sg, neu: hit, key: k.key });
    }
    if (!found.length) return { replaced: 0 };

    try { await hooks?.hold?.(found.map(f => f.old.id)); } catch { }

    // One old file per new file gives it its name (the first, by path); other old copies of the same
    // song are just deleted and point at the same final file.
    const finalByNew = new Map();   // new song id -> the song as it ends up
    const pairs = [];
    let replaced = 0;
    found.sort((a, b) => (a.old.id < b.old.id ? -1 : 1));
    for (const f of found) {
        try {
            await FileSystem.deleteAsync(f.old.url, { idempotent: true });
            const still = await FileSystem.getInfoAsync(f.old.url).catch(() => ({ exists: false }));
            if (still.exists) continue;   // could not delete: leave everything as it is
            replaced++;
            let finalSong = finalByNew.get(f.neu.song.id);
            if (!finalSong) {
                finalSong = f.neu.resolved;
                if (extOf(f.old.filename) === extOf(f.neu.song.filename)) {
                    try {
                        await FileSystem.moveAsync({ from: f.neu.song.url, to: f.old.url });
                        finalSong = { ...f.neu.resolved, id: f.old.id, url: f.old.url, filename: f.old.filename };
                        try { await extractTags(finalSong); } catch { }   // the file at that path changed: read its tags again now
                    } catch { /* keep the new file where it is */ }
                }
                finalByNew.set(f.neu.song.id, finalSong);
            }
            // The remembered length belonged to the old file.
            try { await AsyncStorage.multiRemove(['pdur:' + f.key.slice(4), 'pdurx:' + f.key.slice(4)]); } catch { }
            pairs.push({ oldId: f.old.id, newSong: finalSong });
        } catch (e) { console.error('replaceImportedDuplicates:', e); }
    }
    try { if (pairs.length) await hooks?.swap?.(pairs); } catch { }
    return { replaced };
}
