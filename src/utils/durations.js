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
// A song whose length cannot be read (e.g. some opus/ogg files) is noted for 30 days and
// not tried again on every launch.
const RETRY_AFTER_MS = 30 * 24 * 3600 * 1000;
let running = false;
let rerunWith = null;   // songs offered while a run was busy (e.g. right after an import): handled when it ends
const listeners = new Set();
export const subscribeDurations = (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export async function fillSongDurations(songs) {
    if (!songs || !songs.length) return;
    if (running) { rerunWith = songs; return; }
    running = true;
    try {
        const withKeys = songs.filter(sg => sg && sg.url).map(sg => ({ sg, key: 'pdur:' + playCountKey(sg).slice(4) }));
        const rows = await AsyncStorage.multiGet(withKeys.map(x => x.key));
        const failRows = await AsyncStorage.multiGet(withKeys.map(x => 'pdurx:' + x.key.slice(5)));
        const now = Date.now();
        const todo = withKeys.filter((x, i) => {
            if (parseFloat(rows[i] && rows[i][1]) > 0) return false;
            const failedAt = parseFloat(failRows[i] && failRows[i][1]);
            return !(failedAt > 0 && now - failedAt < RETRY_AFTER_MS);
        });
        let found = 0;
        for (let i = 0; i < todo.length; i += BATCH) {
            const chunk = todo.slice(i, i + BATCH);
            let res = null;
            try { res = await AudioEngine.getDurations(chunk.map(x => x.sg.url)); } catch { res = null; }
            const pairs = [];
            chunk.forEach(x => {
                const d = res && res[x.sg.url];
                if (d > 1 && d < 14400) pairs.push([x.key, String(Math.round(d * 10) / 10)]);
                else if (res) pairs.push(['pdurx:' + x.key.slice(5), String(now)]);   // answered, but no readable length
            });
            if (pairs.length) { await AsyncStorage.multiSet(pairs); found += pairs.filter(p => p[0].startsWith('pdur:')).length; }
            await new Promise(r => setTimeout(r, 40));      // keep the app responsive
        }
        if (found) listeners.forEach(fn => { try { fn(); } catch { } });
    } catch { } finally {
        running = false;
        if (rerunWith) { const again = rerunWith; rerunWith = null; fillSongDurations(again); }
    }
}
