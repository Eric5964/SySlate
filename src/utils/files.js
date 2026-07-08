import * as FileSystem from 'expo-file-system';

const AUDIO_EXT = new Set(['.flac', '.mp3', '.m4a', '.wav', '.aiff', '.aac', '.alac']);

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

async function scanFolder(folderPath, folderName) {
    let items = [];
    try {
        items = await FileSystem.readDirectoryAsync(folderPath);
    } catch (e) {
        console.warn('scanFolder error:', folderPath, e?.message);
        return [];
    }
    const tracks = [];
    for (const item of items) {
        if (item.startsWith('.')) continue;
        if (!AUDIO_EXT.has(ext(item))) continue;
        const url = folderPath.endsWith('/') ? folderPath + item : `${folderPath}/${item}`;
        tracks.push({
            id: url, url, filename: item,
            ...parseFilename(item, folderName),
        });
    }
    return tracks.sort((a, b) => a.title.localeCompare(b.title));
}

export async function ensureMusicFolder() {
    const base = FileSystem.documentDirectory;
    const musicDir = base + 'Music/';
    try {
        const info = await FileSystem.getInfoAsync(musicDir);
        if (!info.exists) {
            await FileSystem.makeDirectoryAsync(musicDir, { intermediates: true });
        }
    } catch (e) {
        console.warn('ensureMusicFolder error:', e?.message);
    }
}

export function getDocumentPath() {
    return FileSystem.documentDirectory ?? 'unknown';
}

export async function scanLibrary() {
    const base = FileSystem.documentDirectory;
    console.log('Scanning:', base);

    // Ensure the Music folder exists
    await ensureMusicFolder();

    let items = [];
    try {
        items = await FileSystem.readDirectoryAsync(base);
        console.log('Root items:', items);
    } catch (e) {
        console.error('scanLibrary root error:', e?.message);
        return { playlists: [], allSongs: [], scanPath: base };
    }

    const playlists = [];
    const allSongs = [];

    for (const item of items) {
        if (item.startsWith('.')) continue;
        const path = base.endsWith('/') ? base + item : `${base}/${item}`;

        let info;
        try {
            info = await FileSystem.getInfoAsync(path);
        } catch { continue; }

        if (info.isDirectory) {
            const songs = await scanFolder(path + '/', item);
            if (songs.length > 0) {
                playlists.push({ name: item, path: path + '/', songs });
                allSongs.push(...songs);
            }
        } else if (AUDIO_EXT.has(ext(item))) {
            allSongs.push({
                id: path, url: path, filename: item,
                ...parseFilename(item, 'Library'),
            });
        }
    }

    playlists.sort((a, b) => a.name.localeCompare(b.name));
    allSongs.sort((a, b) => a.title.localeCompare(b.title));

    console.log(`Found ${playlists.length} playlists, ${allSongs.length} songs`);
    return { playlists, allSongs, scanPath: base };
}