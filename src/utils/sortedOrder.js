import { getPlaylistSort, getPlayCounts } from './storage';
import { titleKey, compareKeys } from './sortKey';

// The order each list screen is showing right now (its chosen sort), kept so playback can continue "straight down the
// list" in that order when shuffle is turned off, instead of the playlist's raw order.
const orders = new Map();
export const ALL_SONGS_KEY = '__all__';

export const registerSortedOrder = (path, songs) => {
    if (!path || !Array.isArray(songs) || !songs.length) return;
    orders.set(path, songs);
};

// `songs` is the playlist's own song list. Returns it in the registered order (songs the screen does not know about
// are kept at the end), or unchanged when no order is registered. Duplicate ids are handled by occurrence, not by a
// Map: a playlist can genuinely hold the same song twice, and neither copy may be collapsed into the other.
export const applySortedOrder = (path, songs) => {
    const reg = path ? orders.get(path) : null;
    if (!reg || !songs?.length) return songs;
    const byId = new Map();
    songs.forEach((s, i) => {
        const list = byId.get(s.id);
        if (list) list.push(i); else byId.set(s.id, [i]);
    });
    const used = new Set();
    const out = [];
    for (const s of reg) {
        const list = byId.get(s.id);
        if (!list) continue;
        while (list.length && used.has(list[0])) list.shift();
        if (!list.length) continue;
        const i = list.shift();
        used.add(i);
        out.push(songs[i]);
    }
    songs.forEach((s, i) => { if (!used.has(i)) out.push(s); });
    return out;
};

const sortSongs = (path, songs, sortId, counts) => {
    const all = path === ALL_SONGS_KEY;
    const keyOf = all ? (s) => titleKey(s.title || '') : (s) => titleKey(s.ourTitle ?? s.title ?? '');
    const keys = new Map(songs.map(s => [s.id, keyOf(s)]));
    const cmp = (a, b) => compareKeys(keys.get(a.id), keys.get(b.id));
    const out = [...songs];
    switch (sortId) {
        case 'alpha': out.sort(cmp); break;
        case 'alpha_r': out.sort((a, b) => cmp(b, a)); break;
        // All Songs breaks ties by title (see AllSongsScreen); a playlist keeps its stored order for equal counts
        // (see PlaylistDetailScreen's stable sort).
        case 'plays': out.sort((a, b) => ((counts[b.id] ?? 0) - (counts[a.id] ?? 0)) || (all ? cmp(a, b) : 0)); break;
        case 'plays_r': out.sort((a, b) => ((counts[a.id] ?? 0) - (counts[b.id] ?? 0)) || (all ? cmp(a, b) : 0)); break;
        default: break;
    }
    return out;
};

// A list screen being mounted is the ideal source of "the sort shown right now" (registerSortedOrder above). When
// none is open — shuffle toggled from the Player, a loop pass, a cold restore — derive the same order from the
// persisted sort choice and the saved play counts instead of silently falling back to the playlist's raw scan order.
export const getSortedOrder = async (path, songs) => {
    if (!path || !songs?.length) return songs;
    const reg = orders.get(path);
    if (reg) return applySortedOrder(path, songs);
    try {
        const [sortId, counts] = await Promise.all([getPlaylistSort(path), getPlayCounts(songs)]);
        return sortSongs(path, songs, sortId, counts || {});
    } catch {
        return songs;
    }
};
