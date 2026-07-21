import * as FileSystem from 'expo-file-system';
import { getPlaylistOrder } from './storage';

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

async function scanFolder(folderPath, folderName) {
    let items = [];
    try { items = await FileSystem.readDirectoryAsync(folderPath); } catch { return []; }
    const tracks = [];
    for (const item of items) {
        if (item.startsWith('.')) continue;
        const fullPath = normPath(folderPath) + item;
        if (AUDIO_EXT.has(ext(item))) {
            tracks.push({ id: fullPath, url: encodeFileUrl(fullPath), filename: item, ...parseFilename(item, folderName) });
        } else {
            try {
                const info = await FileSystem.getInfoAsync(fullPath);
                if (info.isDirectory) {
                    const subs = await FileSystem.readDirectoryAsync(fullPath);
                    for (const sub of subs) {
                        if (sub.startsWith('.') || !AUDIO_EXT.has(ext(sub))) continue;
                        const sp = normPath(fullPath) + sub;
                        tracks.push({ id: sp, url: encodeFileUrl(sp), filename: sub, ...parseFilename(sub, item) });
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

    for (const item of items) {
        if (item.startsWith('.') || SKIP.has(item)) continue;
        const path = normPath(base) + item;
        let info;
        try { info = await FileSystem.getInfoAsync(path); } catch { continue; }
        if (info.isDirectory) {
            const songs = await scanFolder(path, item);
            if (songs.length > 0) {
                playlists.push({ name: item, path: normPath(path), songs });
                songs.forEach(s => seenIds.add(s.id));
            }
        } else if (AUDIO_EXT.has(ext(item)) && !seenIds.has(path)) {
            rootSongs.push({ id: path, url: encodeFileUrl(path), filename: item, ...parseFilename(item, 'Library') });
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