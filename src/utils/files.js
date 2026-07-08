import * as FileSystem from 'expo-file-system';

const AUDIO_EXT = new Set(['.flac', '.mp3', '.m4a', '.wav', '.aiff', '.aac', '.alac', '.opus']);

function ext(name) {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function parseFilename(filename, album) {
    const base = filename.slice(0, filename.lastIndexOf('.'));
    const parts = base.split(' - ');
    return {
        title: parts.length >= 2 ? parts.slice(1).join(' - ').trim() : base,
        artist: parts.length >= 2 ? parts[0].trim() : 'Unknown Artist',
        album,
    };
}

function normPath(p) {
    return p.endsWith('/') ? p : p + '/';
}

async function scanFolder(folderPath, folderName) {
    let items = [];
    try { items = await FileSystem.readDirectoryAsync(folderPath); }
    catch (e) { console.warn('scanFolder error:', folderPath, e?.message); return []; }

    const tracks = [];
    for (const item of items) {
        if (item.startsWith('.')) continue;
        const fullPath = normPath(folderPath) + item;

        if (AUDIO_EXT.has(ext(item))) {
            tracks.push({ id: fullPath, url: fullPath, filename: item, ...parseFilename(item, folderName) });
        } else {
            // Go one level deeper (handle album subfolders)
            try {
                const info = await FileSystem.getInfoAsync(fullPath);
                if (info.isDirectory) {
                    const subItems = await FileSystem.readDirectoryAsync(fullPath);
                    for (const sub of subItems) {
                        if (sub.startsWith('.') || !AUDIO_EXT.has(ext(sub))) continue;
                        const subPath = normPath(fullPath) + sub;
                        tracks.push({ id: subPath, url: subPath, filename: sub, ...parseFilename(sub, item) });
                    }
                }
            } catch { }
        }
    }
    return tracks.sort((a, b) => a.title.localeCompare(b.title));
}

export async function ensureMusicFolder() {
    try {
        const path = FileSystem.documentDirectory + 'Music/';
        const info = await FileSystem.getInfoAsync(path);
        if (!info.exists) await FileSystem.makeDirectoryAsync(path, { intermediates: true });
    } catch (e) { console.warn('ensureMusicFolder:', e?.message); }
}

export function getDocumentPath() {
    return FileSystem.documentDirectory ?? 'unknown';
}

export async function scanLibrary() {
    const base = FileSystem.documentDirectory;
    await ensureMusicFolder();

    let items = [];
    try { items = await FileSystem.readDirectoryAsync(base); }
    catch (e) { return { playlists: [], allSongs: [], scanPath: base }; }

    const playlists = [];
    const allSongs = [];

    for (const item of items) {
        if (item.startsWith('.')) continue;
        const path = normPath(base) + item;
        let info;
        try { info = await FileSystem.getInfoAsync(path); } catch { continue; }

        if (info.isDirectory) {
            const songs = await scanFolder(path, item);
            if (songs.length > 0) {
                playlists.push({ name: item, path: normPath(path), songs });
                allSongs.push(...songs);
            }
        } else if (AUDIO_EXT.has(ext(item))) {
            allSongs.push({ id: path, url: path, filename: item, ...parseFilename(item, 'Library') });
        }
    }

    playlists.sort((a, b) => a.name.localeCompare(b.name));
    allSongs.sort((a, b) => a.title.localeCompare(b.title));
    return { playlists, allSongs, scanPath: base };
}