import * as FileSystem from 'expo-file-system';

// Brings songs into the app's own Documents folder from the Files app, for installs where
// that folder can't be reached from Files (SideStore / LiveContainer). The system file
// picker runs outside the app, so it needs no special permission.
const AUDIO_EXT = new Set(['flac', 'mp3', 'm4a', 'wav', 'aiff', 'aac', 'alac', 'opus', 'ogg', 'mp4', 'wma', 'ape', 'caf', 'm4b']);
const extOf = (name) => { const i = name.lastIndexOf('.'); return i >= 0 ? name.slice(i + 1).toLowerCase() : ''; };
// Lyrics and cover pictures travel with the songs (the folder import already copies them; this one used to drop them).
const EXTRA_EXT = new Set(['lrc', 'jpg', 'jpeg', 'png', 'webp']);
// Folder names the library scan ignores (see files.js): a playlist with one of these names would be invisible.
const HIDDEN_FOLDERS = new Set(['Application Support', 'Caches', 'Cookies', 'Preferences', 'Saved Application State', 'SystemData', 'tmp', 'Library']);
const cleanName = (n) => String(n || '').replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();

// folderName: playlist folder to put the songs in ('' = Documents itself, shows in All Songs only).
// Resolves { copied, skipped, failed, added } or null if the picker was cancelled / unavailable.
export async function importSongs(folderName, onPicked) {
    let DocumentPicker;
    try { DocumentPicker = require('expo-document-picker'); } catch { throw new Error('The file picker is not part of this build.'); }
    const res = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.length) return null;
    try { onPicked?.(); } catch { }   // the picker is closed: the loading card can show now

    let folder = cleanName(folderName);
    if (HIDDEN_FOLDERS.has(folder)) folder = `${folder} (imported)`;
    const dir = FileSystem.documentDirectory + (folder ? encodeURIComponent(folder) + '/' : '');
    if (folder) await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => { });

    let copied = 0, skipped = 0, failed = 0;
    const added = [];   // songs added, as paths under Documents (the app then replaces older copies of the same song)
    const dropSource = (a) => FileSystem.deleteAsync(a.uri, { idempotent: true }).catch(() => { });
    for (const a of res.assets) {
        const name = cleanName(a.name || a.uri.split('/').pop());
        const e = extOf(name);
        const isAudio = AUDIO_EXT.has(e);
        if (!name || !(isAudio || EXTRA_EXT.has(e))) { skipped++; dropSource(a); continue; }
        const dot = name.lastIndexOf('.');
        const stem = name.slice(0, dot), ext = name.slice(dot);
        let finalName = name;
        let target = dir + encodeURIComponent(name);
        let identical = false;
        // Same rules as the folder import: a file that is already there with the same size is
        // skipped (picking the same song twice used to add "name (2)", which the replace step
        // then had to clean up); a lyrics file or picture with the same name but another size
        // replaces the old one (they are found by the song's name, so a "(2)" copy would never be
        // used); a song with the same name but another size is never overwritten: "name (2).ext", ...
        const existing = await FileSystem.getInfoAsync(target, { size: true }).catch(() => ({ exists: false }));
        if (existing.exists) {
            let size = a.size;
            if (!(size >= 0)) { const si = await FileSystem.getInfoAsync(a.uri, { size: true }).catch(() => null); size = si?.size; }
            if (size >= 0 && existing.size === size) identical = true;
            else if (!isAudio) await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => { });
            else {
                for (let n = 2; n < 100; n++) {
                    finalName = `${stem} (${n})${ext}`;
                    target = dir + encodeURIComponent(finalName);
                    const info = await FileSystem.getInfoAsync(target).catch(() => ({ exists: false }));
                    if (!info.exists) break;
                }
            }
        }
        if (identical) { skipped++; dropSource(a); continue; }
        try {
            await FileSystem.moveAsync({ from: a.uri, to: target });
            if (isAudio) { copied++; added.push((folder ? folder + '/' : '') + finalName); }
        } catch {
            try {
                await FileSystem.copyAsync({ from: a.uri, to: target });
                dropSource(a);
                if (isAudio) { copied++; added.push((folder ? folder + '/' : '') + finalName); }
            } catch { failed++; dropSource(a); }   // the picker's temporary copy is no use to anyone now
        }
    }
    return { copied, skipped, failed, added };
}
