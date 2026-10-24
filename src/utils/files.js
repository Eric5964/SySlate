import * as FileSystem from 'expo-file-system';
import { getPlaylistOrder, getAlbumFromFolder, getArtistSeparator } from './storage';
import { getCachedTagsFast } from './tags';
import { compareTitles } from './sortKey';

const AUDIO_EXT = new Set(['.flac', '.mp3', '.m4a', '.wav', '.aiff', '.aac', '.alac', '.opus', '.ogg', '.mp4', '.wma', '.ape', '.caf', '.m4b']);

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
// When the tag format stored multiple discrete artists (FLAC/Opus/OGG's
// repeated ARTIST= fields, or an ID3v2.4 null-separated TPE1) rather than
// one delimited string, they're joined here using the SAME separator the
// Multiple Artists setting is configured with — that's what makes
// splitArtists/formatArtists correctly re-split them later regardless of
// which separator the user's actually chosen; joining with anything else
// would only look right for whoever happens to have that exact separator
// selected.
//
// Uses getCachedTagsFast (pure cache read, no stat, no file I/O) rather
// than a real extraction — scanning the library must stay fast regardless
// of library size, so the real read only ever happens in the background
// tag loader. A song whose tags haven't been warmed into the cache yet
// just keeps its filename-based guess until the next scan after the
// background loader reaches it.
export async function applyTags(track, albumFromFolder, artistSeparator) {
    const tags = await getCachedTagsFast(track);
    if (!tags) return track;
    // artistSeparator is now an array (Multiple Artists supports selecting
    // more than one separator at once) — joining genuinely discrete
    // tag-sourced artists still only makes sense with ONE character between
    // them, so this uses the first real (non-'none') one configured, same
    // ';' fallback as before if the array is empty or 'none'-only.
    const seps = (Array.isArray(artistSeparator) ? artistSeparator : [artistSeparator]).filter(sep => sep && sep !== 'none');
    const joinSep = seps[0] || ';';
    const artist = tags.artists?.length ? tags.artists.join(joinSep) : tags.artist;
    return {
        ...track,
        title: tags.title || track.title,
        ourTitle: tags.title || track.ourTitle,
        artist: artist !== undefined && artist !== '' ? artist : track.artist,
        ourArtist: artist !== undefined && artist !== '' ? artist : track.ourArtist,
        album: (!albumFromFolder && tags.album) || track.album,
        // The album as written in the tags, whatever "Album from folder" shows. Part of what makes a
        // song the same song (play counts, All Songs, import replacing).
        tagAlbum: typeof tags.album === 'string' ? tags.album : '',
        // Volume tag (ReplayGain track gain), limited so the boost can never
        // push the song's tagged peak past full scale.
        replayGainDb: typeof tags.rgDb === 'number'
            ? (tags.rgPeak ? Math.min(tags.rgDb, -20 * Math.log10(tags.rgPeak)) : tags.rgDb)
            : undefined,
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

// How many folder levels below a playlist folder are searched. Songs found in nested folders
// (e.g. Music/Artist/Album/song.flac) all belong to the top folder's playlist; each song's
// album name is the folder it sits in. Used to stop at ONE level, so deeper songs were
// silently missed.
const MAX_DEPTH = 5;

// The path as the file functions want it: the base stays as it was given (already a valid
// URI) and only the item name is percent-encoded, so names containing "#", "%" or "?" can
// still be listed and opened. (The readable path without encoding stays the song's id.)
function childFs(dirFs, item) { return normPath(dirFs) + encodeURIComponent(item); }

async function listDir(dirFs, dirId) {
    try { return await FileSystem.readDirectoryAsync(dirFs); } catch { }
    if (dirId && dirId !== dirFs) { try { return await FileSystem.readDirectoryAsync(dirId); } catch { } }
    return [];
}

async function walkFolder(dirId, dirFs, albumName, depth, albumFromFolder, artistSeparator, out, skipped) {
    const items = await listDir(dirFs, dirId);
    for (const item of items) {
        if (item.startsWith('.')) continue;
        const id = normPath(dirId) + item;
        const e = ext(item);
        if (AUDIO_EXT.has(e)) {
            out.push(await applyTags({ id, url: encodeFileUrl(id), filename: item, ...parseFilename(item, albumName) }, albumFromFolder, artistSeparator));
        } else if (depth < MAX_DEPTH) {
            try {
                const fs = childFs(dirFs, item);
                const info = await FileSystem.getInfoAsync(fs);
                if (info.isDirectory) await walkFolder(id, fs, item, depth + 1, albumFromFolder, artistSeparator, out, skipped);
                else if (skipped) skipped[e || '(no extension)'] = (skipped[e || '(no extension)'] || 0) + 1;
            } catch { }
        }
    }
}

async function scanFolder(folderPath, folderFs, folderName, albumFromFolder, artistSeparator, skipped) {
    const tracks = [];
    await walkFolder(folderPath, folderFs, folderName, 0, albumFromFolder, artistSeparator, tracks, skipped);
    return tracks.sort((a, b) => compareTitles(a.ourTitle, b.ourTitle));
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
    const artistSeparator = await getArtistSeparator();
    const skipped = {};   // file types that were seen but are not audio (for the diagnostic message)
    let unreadable = 0;   // entries that could not be looked at

    for (const item of items) {
        if (item.startsWith('.') || SKIP.has(item)) continue;
        const path = normPath(base) + item;
        const fsPath = childFs(base, item);
        let info;
        try { info = await FileSystem.getInfoAsync(fsPath); } catch { unreadable++; continue; }
        if (info.isDirectory) {
            const songs = await scanFolder(path, fsPath, item, albumFromFolder, artistSeparator, skipped);
            if (songs.length > 0) {
                playlists.push({ name: item, path: normPath(path), songs });
                songs.forEach(s => seenIds.add(s.id));
            }
        } else if (AUDIO_EXT.has(ext(item)) && !seenIds.has(path)) {
            rootSongs.push(await applyTags({ id: path, url: encodeFileUrl(path), filename: item, ...parseFilename(item, 'Library') }, albumFromFolder, artistSeparator));
            seenIds.add(path);
        } else if (!info.isDirectory) {
            const e = ext(item) || '(no extension)';
            skipped[e] = (skipped[e] || 0) + 1;
        }
    }

    playlists.sort((a, b) => compareTitles(a.name, b.name));
    const order = await getPlaylistOrder();
    if (order.length) {
        const pos = new Map(order.map((p, i) => [p, i]));
        playlists.sort((a, b) => {
            const ai = pos.has(a.path) ? pos.get(a.path) : Infinity;
            const bi = pos.has(b.path) ? pos.get(b.path) : Infinity;
            if (ai !== bi) return ai - bi;
            return compareTitles(a.name, b.name); // new/unordered playlists fall back to alpha, appended after ordered ones
        });
    }
    const seen2 = new Set();
    const allSongs = [];
    for (const p of playlists) for (const s of p.songs) if (!seen2.has(s.id)) { allSongs.push(s); seen2.add(s.id); }
    for (const s of rootSongs) if (!seen2.has(s.id)) { allSongs.push(s); seen2.add(s.id); }
    allSongs.sort((a, b) => compareTitles(a.ourTitle, b.ourTitle));
    const scanError = (playlists.length === 0 && allSongs.length === 0)
        ? `Found ${items.length} item(s) in Documents (${items.slice(0, 5).join(', ')}${items.length > 5 ? '...' : ''}), but none were recognized as audio files or folders containing audio files.`
            + (Object.keys(skipped).length ? ` File types seen but not audio: ${Object.entries(skipped).slice(0, 6).map(([k, n]) => `${k} x${n}`).join(', ')}.` : '')
            + (unreadable ? ` ${unreadable} item(s) could not be opened.` : '')
        : null;
    return { playlists, allSongs, scanPath: base, scanError };
}