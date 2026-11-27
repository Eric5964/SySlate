// In-app debug log viewer. Real gap this closes: every [RAMP-DEBUG]/
// [SEEK-DEBUG] line added across several rounds only ever went to
// console.log (JS side) or NSLog (native side) — both invisible on a
// sideloaded, GitHub-Actions-built app with no Xcode attached. This is a
// simple in-memory ring buffer, capped so it can't grow unbounded across a
// long session, that:
//   1. Wraps console.log/warn/error so anything already logged that way
//      (all the existing [RAMP-DEBUG] lines in PlaybackService.js/
//      PlaybackContext.js, [SEEK-DEBUG] in PlayerScreen.js, etc.) gets
//      captured automatically — nothing else needed to change to start
//      showing up here.
//   2. Subscribes to native's new DebugLog event (see AudioEngine.swift's
//      debugLog()) so the native-side [RAMP-DEBUG]/[SEEK-DEBUG] NSLog
//      calls show up in the SAME buffer, same timeline, instead of a
//      separate Xcode-only stream.
// DebugLogScreen.js is the viewer — Settings has a way in.
//
// Deliberately NOT persisted to disk — this is meant for "reproduce it,
// then immediately copy the log out," not a long-term history. Session-only
// keeps this simple and keeps AsyncStorage out of a debug tool that's
// itself trying to stay low-risk to add.

import { NativeEventEmitter, NativeModules, AppState } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { perf } from './perf';

const MAX_LINES = 1500;
let lines = [];
let listeners = new Set();
let started = false;

const notify = () => { for (const l of listeners) l(); };
// Lines arrive in bursts (a song change can log several at once). Notifying on
// every single one made the viewer re-read and re-render the whole buffer for
// each line; the UI now hears about them at most four times a second.
const NOTIFY_MS = 250;
let notifyTimer = null;
const notifySoon = () => {
    if (!listeners.size || notifyTimer) return;
    notifyTimer = setTimeout(() => { notifyTimer = null; notify(); }, NOTIFY_MS);
};

// The log of the session that came BEFORE this one is kept on disk too: when the app is closed by iOS (or crashes)
// the in-memory log is gone, and the next launch only showed the new session. A copy of the last lines is written
// every few seconds (and when the app goes to the background or iOS warns about memory); at the next launch it
// becomes "previous session", viewable in the Debug Log screen. A session that lasted only a moment does not
// replace an earlier one, so quick relaunches in a row do not wipe the log of the session that went wrong.
const DIR = FileSystem.documentDirectory || '';
const LAST_PATH = DIR + '.syslate_lastlog.json';
const PREV_PATH = DIR + '.syslate_prevlog.json';
const SAVE_LINES = 700;
let previousSession = null;   // { savedAt, appState, lines }
let saveTimer = null;
let saveDirty = false;
// Writing the file is the only disk work and it happens here, off the
// per-line path: push() just marks the buffer dirty. 8 s instead of 4 s keeps
// the same safety (a background transition still saves at once) with half the
// JSON.stringify + write churn on the JS thread.
const SAVE_MS = 8000;
const saveNow = () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!DIR || !saveDirty || !lines.length) return;
    saveDirty = false;
    try {
        FileSystem.writeAsStringAsync(LAST_PATH, JSON.stringify({ savedAt: Date.now(), appState: AppState.currentState, lines: lines.slice(-SAVE_LINES) }))
            .catch(() => { saveDirty = true; });   // try again on the next push/timer
    } catch { saveDirty = true; /* logging must never throw */ }
};
const scheduleSave = () => {
    saveDirty = true;
    if (!saveTimer) saveTimer = setTimeout(saveNow, SAVE_MS);
};
const loadPrevious = async () => {
    if (!DIR) return;
    try {
        let last = null;
        try { last = JSON.parse(await FileSystem.readAsStringAsync(LAST_PATH)); } catch { }
        if (last && Array.isArray(last.lines) && last.lines.length >= 40) {
            // A real session: it becomes the previous one.
            await FileSystem.writeAsStringAsync(PREV_PATH, JSON.stringify(last)).catch(() => { });
            previousSession = last;
        } else {
            try { previousSession = JSON.parse(await FileSystem.readAsStringAsync(PREV_PATH)); } catch { previousSession = last; }
        }
        notify();
    } catch { /* nothing kept */ }
};

const push = (line) => {
    if (perf.on) return;   // Performance mode: no log capture
    lines.push({ t: Date.now(), line });
    scheduleSave();
    // Trim in steps of 250 lines, not a fresh copy of the whole array on every line past the cap
    // (a busy log, e.g. during a scratch, made that thousands of 1500-entry copies a second).
    if (lines.length > MAX_LINES + 250) lines = lines.slice(lines.length - MAX_LINES);
    notifySoon();
};

// Only wraps the three console methods, and only ever ADDS the ring-buffer
// push on top of calling straight through to the original — this must
// never change what already gets logged or how, just also capture it.
const wrapConsole = () => {
    const methods = ['log', 'warn', 'error'];
    for (const m of methods) {
        const orig = console[m];
        console[m] = (...args) => {
            orig(...args);
            try {
                const text = args.map(a => {
                    if (typeof a === 'string') return a;
                    try { return JSON.stringify(a); } catch { return String(a); }
                }).join(' ');
                push(`[JS:${m}] ${text}`);
            } catch { /* logging itself must never throw */ }
        };
    }
};

export function startDebugLogCapture() {
    if (started) return;
    started = true;
    wrapConsole();
    loadPrevious();
    // What iOS did to the app is part of the story: moving to the background, and memory warnings (the usual
    // reason iOS closes an app that is playing in the background).
    try {
        push(`[APP] launched, app state ${AppState.currentState}`);
        AppState.addEventListener('change', (st) => { push(`[APP] app state -> ${st}`); if (st !== 'active') saveNow(); });
        AppState.addEventListener('memoryWarning', () => { push('[MEM] iOS memory warning'); saveNow(); });
    } catch { }
    try {
        const { AudioEngine: NativeAudioEngine } = NativeModules;
        if (NativeAudioEngine) {
            const emitter = new NativeEventEmitter(NativeAudioEngine);
            emitter.addListener('DebugLog', ({ message }) => push(`[native] ${message}`));
        }
    } catch (e) {
        push(`[debugLog] failed to subscribe to native DebugLog: ${String(e)}`);
    }
}

export function getPreviousSession() {
    return previousSession;
}

export function getDebugLogLines() {
    return lines;
}

export function clearDebugLog() {
    lines = [];
    if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null; }
    notify();
}

export function subscribeDebugLog(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
