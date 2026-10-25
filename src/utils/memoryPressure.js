import { AppState } from 'react-native';

// iOS tells a running app when the system is running low on memory and is about to start
// closing apps ("memory warning"). Background jobs (reading tags/covers for the whole library)
// are the part of the app that can wait, so they pause for a while after one instead of
// carrying on and being the thing that gets the app closed.
const PAUSE_MS = 30000;
let calmAt = 0;
try {
    AppState.addEventListener('memoryWarning', () => { calmAt = Date.now() + PAUSE_MS; });
} catch { }

// Short-lived "please stay out of the way" holds: the library being rebuilt, an import, a finger on the
// disc. Background tag/cover work waits for them (the up-front reading itself does not). A hold
// expires on its own, so a missed release can never stop the background work for good.
const holds = new Map();
let holdId = 0;
export function holdBackground(maxMs = 30000) {
    const id = ++holdId;
    holds.set(id, Date.now() + maxMs);
    return () => { holds.delete(id); };
}
export function backgroundHeld() {
    const now = Date.now();
    let any = false;
    for (const [id, t] of holds) { if (t < now) holds.delete(id); else any = true; }
    return any;
}
export async function waitForBackgroundClear(stop) {
    while ((underMemoryPressure() || backgroundHeld()) && !(stop && stop())) await new Promise(r => setTimeout(r, 500));
}
export function underMemoryPressure() { return Date.now() < calmAt; }
// Resolves once the pause is over (immediately if there is none). `stop()` lets the caller leave early.
export async function waitForMemoryRelief(stop) {
    while (underMemoryPressure() && !(stop && stop())) await new Promise(r => setTimeout(r, 1000));
}
