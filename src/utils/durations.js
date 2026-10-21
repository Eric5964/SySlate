import AsyncStorage from '@react-native-async-storage/async-storage';
import AudioEngine from '../native/AudioEngine';
import { playCountKey } from './storage';

// Song lengths are read from the files themselves (natively, in small batches in the
// background a few seconds after the library has loaded) and remembered, so playlist
// totals and listening hours are exact instead of estimated. A song is only ever read
// once; after that only newly added songs cost anything. Reading one header takes a
// few milliseconds, so a few hundred songs finish well within a minute and nothing
// waits for it.
const BATCH = 25;
let running = false;
const listeners = new Set();
export const subscribeDurations = (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export async function fillSongDurations(songs) {
    if (running || !songs || !songs.length) return;
    running = true;
    try {
        const withKeys = songs.filter(sg => sg && sg.url).map(sg => ({ sg, key: 'pdur:' + playCountKey(sg).slice(4) }));
        const rows = await AsyncStorage.multiGet(withKeys.map(x => x.key));
        const todo = withKeys.filter((x, i) => !(parseFloat(rows[i] && rows[i][1]) > 0));
        let found = 0;
        for (let i = 0; i < todo.length; i += BATCH) {
            const chunk = todo.slice(i, i + BATCH);
            let res = null;
            try { res = await AudioEngine.getDurations(chunk.map(x => x.sg.url)); } catch { res = null; }
            const pairs = [];
            chunk.forEach(x => {
                const d = res && res[x.sg.url];
                if (d > 1 && d < 14400) pairs.push([x.key, String(Math.round(d * 10) / 10)]);
            });
            if (pairs.length) { await AsyncStorage.multiSet(pairs); found += pairs.length; }
            await new Promise(r => setTimeout(r, 40));      // keep the app responsive
        }
        if (found) listeners.forEach(fn => { try { fn(); } catch { } });
    } catch { } finally { running = false; }
}
