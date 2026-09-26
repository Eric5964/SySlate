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

import { NativeEventEmitter, NativeModules } from 'react-native';

const MAX_LINES = 1500;
let lines = [];
let listeners = new Set();
let started = false;

const notify = () => { for (const l of listeners) l(); };

const push = (line) => {
    lines.push({ t: Date.now(), line });
    if (lines.length > MAX_LINES) lines = lines.slice(lines.length - MAX_LINES);
    notify();
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

export function getDebugLogLines() {
    return lines;
}

export function clearDebugLog() {
    lines = [];
    notify();
}

export function subscribeDebugLog(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
