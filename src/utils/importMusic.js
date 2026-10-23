import * as FileSystem from 'expo-file-system';

// Brings songs into the app's own Documents folder from the Files app, for installs where
// that folder can't be reached from Files (SideStore / LiveContainer). The system file
// picker runs outside the app, so it needs no special permission.
const AUDIO_EXT = new Set(['flac', 'mp3', 'm4a', 'wav', 'aiff', 'aac', 'alac', 'opus', 'ogg', 'mp4', 'wma', 'ape', 'caf', 'm4b']);
const extOf = (name) => { const i = name.lastIndexOf('.'); return i >= 0 ? name.slice(i + 1).toLowerCase() : ''; };
const cleanName = (n) => String(n || '').replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();

// folderName: playlist folder to put the songs in ('' = Documents itself, shows in All Songs only).
// Resolves { copied, skipped, failed, added } or null if the picker was cancelled / unavailable.
export async function importSongs(folderName) {
    let DocumentPicker;
    try { DocumentPicker = require('expo-document-picker'); } catch { throw new Error('The file picker is not part of this build.'); }
    const res = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.length) return null;

    const folder = cleanName(folderName);
    const dir = FileSystem.documentDirectory + (folder ? encodeURIComponent(folder) + '/' : '');
    if (folder) await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => { });

    let copied = 0, skipped = 0, failed = 0;
    const added = [];   // songs added, as paths under Documents (the app then replaces older copies of the same song)
    for (const a of res.assets) {
        const name = cleanName(a.name || a.uri.split('/').pop());
        if (!name || !AUDIO_EXT.has(extOf(name))) { skipped++; FileSystem.deleteAsync(a.uri, { idempotent: true }).catch(() => { }); continue; }
        // Never overwrite a song that is already there: "name (2).ext", "name (3).ext", ...
        const dot = name.lastIndexOf('.');
        const stem = name.slice(0, dot), ext = name.slice(dot);
        let finalName = name;
        let target = dir + encodeURIComponent(name);
        for (let n = 2; n < 100; n++) {
            const info = await FileSystem.getInfoAsync(target).catch(() => ({ exists: false }));
            if (!info.exists) break;
            finalName = `${stem} (${n})${ext}`;
            target = dir + encodeURIComponent(finalName);
        }
        try {
            await FileSystem.moveAsync({ from: a.uri, to: target });
            copied++; added.push((folder ? folder + '/' : '') + finalName);
        } catch {
            try { await FileSystem.copyAsync({ from: a.uri, to: target }); await FileSystem.deleteAsync(a.uri, { idempotent: true }); copied++; added.push((folder ? folder + '/' : '') + finalName); }
            catch { failed++; }
        }
    }
    return { copied, skipped, failed, added };
}
