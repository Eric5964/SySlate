import * as FileSystem from 'expo-file-system';

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

async function scanFolder(folderPath, folderName) {
    let items = [];
    try { items = await FileSystem.readDirectoryAsync(folderPath); } catch { return []; }
    const tracks = [];
    for (const item of items) {
        if (item.startsWith('.')) continue;
        const fullPath = normPath(folderPath) + item;
        if (AUDIO_EXT.has(ext(item))) {
            tracks.push({ id: fullPath, url: fullPath, filename: item, ...parseFilename(item, folderName) });
        } else {
            try {
                const info = await FileSystem.getInfoAsync(fullPath);
                if (info.isDirectory) {
                    const subs = await FileSystem.readDirectoryAsync(fullPath);
                    for (const sub of subs) {
                        if (sub.startsWith('.') || !AUDIO_EXT.has(ext(sub))) continue;
                        const sp = normPath(fullPath) + sub;
                        tracks.push({ id: sp, url: sp, filename: sub, ...parseFilename(sub, item) });
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
    if (!base) return { playlists: [], allSongs: [], scanPath: '' };
    let items = [];
    try { items = await FileSystem.readDirectoryAsync(base); } catch { return { playlists: [], allSongs: [], scanPath: base }; }

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
            rootSongs.push({ id: path, url: path, filename: item, ...parseFilename(item, 'Library') });
            seenIds.add(path);
        }
    }

    playlists.sort((a, b) => a.name.localeCompare(b.name));
    const seen2 = new Set();
    const allSongs = [];
    for (const p of playlists) for (const s of p.songs) if (!seen2.has(s.id)) { allSongs.push(s); seen2.add(s.id); }
    for (const s of rootSongs) if (!seen2.has(s.id)) { allSongs.push(s); seen2.add(s.id); }
    allSongs.sort((a, b) => a.ourTitle.localeCompare(b.ourTitle));
    return { playlists, allSongs, scanPath: base };
}