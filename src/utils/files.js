import * as FileSystem from 'expo-file-system';

const MUSIC_DIR = FileSystem.documentDirectory;

export async function getPlaylists() {
  try {
    const items = await FileSystem.readDirectoryAsync(MUSIC_DIR);
    const playlists = [];
    for (const item of items) {
      const info = await FileSystem.getInfoAsync(MUSIC_DIR + item);
      if (info.isDirectory) {
        playlists.push({ name: item, path: MUSIC_DIR + item + '/' });
      }
    }
    return playlists.sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    console.error('Error reading playlists:', e);
    return [];
  }
}

export async function getTracksInPlaylist(playlistPath) {
  try {
    const items = await FileSystem.readDirectoryAsync(playlistPath);
    const tracks = items
      .filter(item =>
        item.toLowerCase().endsWith('.flac') ||
        item.toLowerCase().endsWith('.mp3') ||
        item.toLowerCase().endsWith('.m4a') ||
        item.toLowerCase().endsWith('.wav')
      )
      .map(item => ({
        id: playlistPath + item,
        url: playlistPath + item,
        title: item.replace(/\.[^/.]+$/, '').replace(/^\d+[\s.\-]+/, ''),
        artist: 'Unknown',
        album: 'Unknown',
      }));
    return tracks;
  } catch (e) {
    console.error('Error reading tracks:', e);
    return [];
  }
}