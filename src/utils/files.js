import * as FileSystem from 'expo-file-system';
import { getPlaylistOrder, getAlbumFromFolder } from './storage';
import { getCachedTags } from './tags';

const AUDIO_EXT = new Set(['.flac', '.mp3', '.m4a', '.wav', '.aiff', '.aac', '.alac', '.opus', '.ogg', '.mp4', '.wma', '.ape']);

function ext(name) { const i = name.lastIndexOf('.'); return i >= 0 ? name.slice(i).toLowerCase() : ''; }

function parseFilename(filename, album) {
    const base = filename.slice(0, filename.lastIndexOf('.'));
    const parts = base.split(' - ');
    // Filename format: "Title - Artist" or just "Title"
    const title = parts[0].trim();
    const artist = parts.length >= 2 ? parts.slice(1).join(' - ').trim() : '';
    return { title, artist, album, ourTitle: title, ourArtist: artist };
}

function normPath(p) { return p.endsWith('/') ? p : p + '/'; }

// Real embedded tags override the filename-parsed guess for whichever
// fields tags.js actually found — title/artist always win if present,
// since they're the fields filename-parsing is guessing at in the first
// place. Album only overrides the folder-name guess when albumFromFolder
// is false (the "Album From Folder Name" setting) — when true, the folder
// name wins outright and a real ALBUM tag is ignored entirely for this
// field, same as before tag reading existed.
//
// Deliberately uses getCachedTags (cache-only, no file read) rather than a
// real extraction — scanning the library must stay fast regardless of
// library size, so the real read only ever happens in the background tag
// loader (see hooks/useBackgroundTagLoader.js). A song whose tags haven't
// been warmed into the cache yet just keeps its filename-based guess until
// the next scan after the background loader reaches it.
async function applyTags(track, albumFromFolder) {
    const tags = await getCachedTags(track);
    if (!tags) return track;
    return {
        ...track,
        title: tags.title || track.title,
        ourTitle: tags.title || track.ourTitle,
        artist: tags.artist !== undefined && tags.artist !== '' ? tags.artist : track.artist,
        ourArtist: tags.artist !== undefined && tags.artist !== '' ? tags.artist : track.ourArtist,
        album: (!albumFromFolder && tags.album) || track.album,
    };
}

// The 'id' field stays as the raw filesystem path (readable, stable, used
// for our own matching). The 'url' field — what TrackPlayer actually loads —
// needs proper URI encoding, since a literal '#', '%', '?', or space in a
// filename gets misinterpreted (a '#' in particular is read as a URL
// fragment, silently truncating the path and breaking that one file).
function encodeFileUrl(path) {
    const m = path.match(/^(file:\/\/)(.*)$/);
    const scheme = m ? m[1] : '';
    const rest = m ? m[2] : path;
    return scheme + rest.split('/').map(encodeURIComponent).join('/');
}

async function scanFolder(folderPath, folderName, albumFromFolder) {
    let items = [];
    try { items = await FileSystem.readDirectoryAsync(folderPath); } catch { return []; }
    const tracks = [];
    for (const item of items) {
        if (item.startsWith('.')) continue;
        const fullPath = normPath(folderPath) + item;
        if (AUDIO_EXT.has(ext(item))) {
            tracks.push(await applyTags({ id: fullPath, url: encodeFileUrl(fullPath), filename: item, ...parseFilename(item, folderName) }, albumFromFolder));
        } else {
            try {
                const info = await FileSystem.getInfoAsync(fullPath);
                if (info.isDirectory) {
                    const subs = await FileSystem.readDirectoryAsync(fullPath);
                    for (const sub of subs) {
                        if (sub.startsWith('.') || !AUDIO_EXT.has(ext(sub))) continue;
                        const sp = normPath(fullPath) + sub;
                        tracks.push(await applyTags({ id: sp, url: encodeFileUrl(sp), filename: sub, ...parseFilename(sub, item) }, albumFromFolder));
                    }
                }
            } catch { }
        }
    }
    return tracks.sort((a, b) => a.ourTitle.localeCompare(b.ourTitle));
}

const SKIP = new Set(['Application Support', 'Caches', 'Cookies', 'Preferences', 'Saved Application State', 'SystemData', 'tmp', 'Library']);

export async function scanLibrary() {
    const base = FileSystem.documentDirectory;
    if (!base) return { playlists: [], allSongs: [], scanPath: '', scanError: 'FileSystem.documentDirectory was empty/undefined.' };
    let items = [];
    try {
        items = await FileSystem.readDirectoryAsync(base);
    } catch (e) {
        return { playlists: [], allSongs: [], scanPath: base, scanError: `readDirectoryAsync failed: ${e?.message ?? e}` };
    }
    if (items.length === 0) {
        return { playlists: [], allSongs: [], scanPath: base, scanError: 'Documents folder is readable but empty — no files/folders found there at all.' };
    }

    const playlists = [];
    const seenIds = new Set();
    const rootSongs = [];
    const albumFromFolder = await getAlbumFromFolder();

    for (const item of items) {
        if (item.startsWith('.') || SKIP.has(item)) continue;
        const path = normPath(base) + item;
        let info;
        try { info = await FileSystem.getInfoAsync(path); } catch { continue; }
        if (info.isDirectory) {
            const songs = await scanFolder(path, item, albumFromFolder);
            if (songs.length > 0) {
                playlists.push({ name: item, path: normPath(path), songs });
                songs.forEach(s => seenIds.add(s.id));
            }
        } else if (AUDIO_EXT.has(ext(item)) && !seenIds.has(path)) {
            rootSongs.push(await applyTags({ id: path, url: encodeFileUrl(path), filename: item, ...parseFilename(item, 'Library') }, albumFromFolder));
            seenIds.add(path);
        }
    }

    playlists.sort((a, b) => a.name.localeCompare(b.name));
    const order = await getPlaylistOrder();
    if (order.length) {
        const pos = new Map(order.map((p, i) => [p, i]));
        playlists.sort((a, b) => {
            const ai = pos.has(a.path) ? pos.get(a.path) : Infinity;
            const bi = pos.has(b.path) ? pos.get(b.path) : Infinity;
            if (ai !== bi) return ai - bi;
            return a.name.localeCompare(b.name); // new/unordered playlists fall back to alpha, appended after ordered ones
        });
    }
    const seen2 = new Set();
    const allSongs = [];
    for (const p of playlists) for (const s of p.songs) if (!seen2.has(s.id)) { allSongs.push(s); seen2.add(s.id); }
    for (const s of rootSongs) if (!seen2.has(s.id)) { allSongs.push(s); seen2.add(s.id); }
    allSongs.sort((a, b) => a.ourTitle.localeCompare(b.ourTitle));
    const scanError = (playlists.length === 0 && allSongs.length === 0)
        ? `Found ${items.length} item(s) in Documents (${items.slice(0, 5).join(', ')}${items.length > 5 ? '...' : ''}), but none were recognized as audio files or folders containing audio files.`
        : null;
    return { playlists, allSongs, scanPath: base, scanError };
}