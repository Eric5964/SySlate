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
    title:  parts.length >= 2 ? parts.slice(1).join(' - ').trim() : base,
    artist: parts.length >= 2 ? parts[0].trim() : 'Unknown Artist',
    album,
  };
}

async function scanFolder(folderPath, folderName) {
  let items = [];
  try { items = await FileSystem.readDirectoryAsync(folderPath); } catch { return []; }
  const tracks = [];
  for (const item of items) {
    if (item.startsWith('.')) continue;
    if (!AUDIO_EXT.has(ext(item))) continue;
    const url = folderPath.endsWith('/') ? folderPath + item : `${folderPath}/${item}`;
    tracks.push({ id: url, url, filename: item, ...parseFilename(item, folderName) });
  }
  return tracks.sort((a, b) => a.title.localeCompare(b.title));
}

export async function scanLibrary() {
  const base = FileSystem.documentDirectory;
  let items = [];
  try { items = await FileSystem.readDirectoryAsync(base); }
  catch (e) { console.error('scanLibrary:', e); return { playlists: [], allSongs: [] }; }

  const playlists = [];
  const allSongs = [];

  for (const item of items) {
    if (item.startsWith('.')) continue;
    const path = base + item;
    let info;
    try { info = await FileSystem.getInfoAsync(path); } catch { continue; }

    if (info.isDirectory) {
      const songs = await scanFolder(path, item);
      if (songs.length > 0) {
        playlists.push({ name: item, path, songs });
        allSongs.push(...songs);
      }
    } else if (AUDIO_EXT.has(ext(item))) {
      const url = path;
      allSongs.push({ id: url, url, filename: item, ...parseFilename(item, 'Library') });
    }
  }

  playlists.sort((a, b) => a.name.localeCompare(b.name));
  allSongs.sort((a, b) => a.title.localeCompare(b.title));
  return { playlists, allSongs };
}