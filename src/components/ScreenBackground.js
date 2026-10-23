import React, { useEffect, useState } from 'react';
import { View, Image, StyleSheet } from 'react-native';
import * as FileSystem from 'expo-file-system';
import AudioEngine from '../native/AudioEngine';
import { usePreferences } from '../context/PreferencesContext';
import { useTheme } from '../context/ThemeContext';

// Drop-in replacement for `<View style={[s.container, { backgroundColor:
// base.bg }]}>` on a screen's root — every screen that used that exact
// pattern (All Songs, Playlists, Playlist Detail, Settings, Player) swaps
// to this instead. Only the screen-level base background is ever replaced
// by the custom image — nothing else (row backgrounds, chips, the lyrics
// panel's own fill, etc. all still read base.bg directly and stay solid
// colors), per an explicit "don't affect different colors, just the base
// background color" request.
//
// Real cause of "always shows a black screen temporarily before loading
// fully when opening screens... it's the same picture??" found here: this
// used to render its OWN <Image> — meaning every screen (All Songs,
// Playlists, Playlist Detail, Settings, Player) mounted a completely
// separate Image element pointing at the same file:// URI, every single
// time you navigated to it. App.js's Image.prefetch() calls (still there,
// still worth keeping for the actual network-image case) are a React
// Native API documented and built around remote http(s) images — for a
// local file:// URI like a device-picked background photo, prefetch
// doesn't reliably warm anything an already-mounted local Image wouldn't
// already have, so each screen's fresh Image still had to hit disk and
// decode again from nothing, every time, regardless of how aggressively
// the app tried to pre-warm it.
//
// Fixed structurally instead of by caching harder: the actual <Image> now
// lives ONCE, permanently mounted at the App root (App.js's
// PersistentBackgroundImage, rendered behind the whole navigator, never
// unmounted for the life of the app session) — decoded exactly once, ever,
// then just sitting there for every screen to show through. This
// component is now just a transparent-or-solid passthrough: when an image
// is active it gets out of the way (transparent) so the one persistent
// Image underneath shows through; otherwise it's the plain solid
// background, same as before. Screens keep calling this exactly the same
// way — no call-site changes needed.
//
// Uses plain React Native Image at the root (not expo-image) — a prior
// round switched to expo-image for cross-mount decode caching, but its
// native module very likely never actually got linked into the compiled
// app given how this project's iOS project is maintained (manually-
// registered pbxproj entries, no automatic `expo prebuild`/pod install
// step). Now moot anyway: with only one Image instance that never
// remounts, plain Image only ever pays the decode cost once per session.
// A 240px copy of the background, shown instantly underneath the full one.
// The full-size image is too big for React Native to keep decoded, so each
// time a screen mounts it (or the app returns from the background) it is
// read and decoded again, and for a few frames that showed black. The tiny
// copy is always cached and paints on the first frame; the sharp one fades
// in on top of it. Files are made when the background is chosen; an older
// background without one gets it made here once.
const loReady = new Set();
function loUriFor(uri) {
    return uri && /_screen\.jpg$/.test(uri) ? uri.replace(/_screen\.jpg$/, '_lo.jpg') : null;
}
function useLowResBackground(uri) {
    const lo = loUriFor(uri);
    const [ready, setReady] = useState(() => !!lo && loReady.has(lo));
    useEffect(() => {
        if (!lo) { setReady(false); return; }
        if (loReady.has(lo)) { setReady(true); return; }
        let cancelled = false;
        (async () => {
            try {
                const info = await FileSystem.getInfoAsync(lo);
                if (!info.exists) {
                    const ok = await AudioEngine.makeThumbnail(uri, lo, 240);
                    if (!ok) return;
                }
                loReady.add(lo);
                if (!cancelled) setReady(true);
            } catch { }
        })();
        return () => { cancelled = true; };
    }, [lo, uri]);
    return ready ? lo : null;
}

// The two stacked images (tiny first, full on top) plus the dark scrim.
function BackgroundLayers({ uri, onError }) {
    const lo = useLowResBackground(uri);
    return (
        <>
            {lo && <Image source={{ uri: lo }} style={StyleSheet.absoluteFillObject} resizeMode="cover" fadeDuration={0} />}
            <Image source={{ uri }} style={StyleSheet.absoluteFillObject} resizeMode="cover" fadeDuration={0} onError={onError} />
            <View style={[StyleSheet.absoluteFillObject, styles.scrim]} pointerEvents="none" />
        </>
    );
}

export default function ScreenBackground({ style, children, ownImage, viewProps }) {
    const { base } = useTheme();
    const { backgroundImageEnabled, backgroundImageUri } = usePreferences();
    const hasImage = backgroundImageEnabled && backgroundImageUri;

    // ownImage: for a screen that slides over other content (the Player,
    // dragged down to dismiss). Every other screen deliberately goes
    // transparent and lets the ONE persistent image behind the navigator
    // show through — but a sliding card that's transparent shows whatever
    // screen is underneath it mid-drag (Playlists/queue/miniplayer visible
    // through the Player — confirmed in a screen recording). This draws its
    // own copy of the image + scrim so the card stays solid while it moves.
    // Same file:// URI as the persistent one, so RN's image cache serves it
    // without a second disk decode in practice.
    if (hasImage && ownImage) {
        return (
            <View style={[styles.flexFill, { backgroundColor: base.bg }]}>
                <BackgroundLayers uri={backgroundImageUri} />
                <View style={[styles.flexFill, style]} {...viewProps}>{children}</View>
            </View>
        );
    }

    return (
        <View style={[styles.flexFill, !hasImage && { backgroundColor: base.bg }]}>
            <View style={[styles.flexFill, style]} {...viewProps}>{children}</View>
        </View>
    );
}

// Rendered exactly once, at the App root, behind the navigator — see the
// big comment above for why this moved out of every individual screen.
export function PersistentBackgroundImage() {
    const { backgroundImageEnabled, backgroundImageUri, setBackgroundImageEnabled } = usePreferences();
    const hasImage = backgroundImageEnabled && backgroundImageUri;
    if (!hasImage) return null;
    return (
        <BackgroundLayers
            uri={backgroundImageUri}
            // A failed load (stale path, file evicted) used to show nothing
            // with no way to tell why. Logged, and the toggle is switched
            // off instead of staying "on" for an image that never loads.
            onError={(e) => {
                console.error('PersistentBackgroundImage failed to load:', backgroundImageUri, e.nativeEvent?.error);
                setBackgroundImageEnabled(false);
            }}
        />
    );
}

const styles = StyleSheet.create({
    flexFill: { flex: 1 },
    scrim: { backgroundColor: 'rgba(0,0,0,0.55)' },
});
