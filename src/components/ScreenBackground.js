import React from 'react';
import { View, Image, StyleSheet } from 'react-native';
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
export default function ScreenBackground({ style, children }) {
    const { base } = useTheme();
    const { backgroundImageEnabled, backgroundImageUri } = usePreferences();
    const hasImage = backgroundImageEnabled && backgroundImageUri;

    return (
        <View style={[styles.flexFill, !hasImage && { backgroundColor: base.bg }]}>
            <View style={[styles.flexFill, style]}>{children}</View>
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
        <>
            <Image
                source={{ uri: backgroundImageUri }}
                style={StyleSheet.absoluteFillObject}
                resizeMode="cover"
                fadeDuration={0}
                // Was silent — a failed load (a stale path from before a
                // reinstall, a file that got evicted, whatever) just showed
                // nothing with no way to tell why. Logged for whoever's
                // debugging next, and auto-disabling rather than leaving
                // the toggle stuck "on" pointing at an image that will
                // never load — Settings will show "Choose Image" again
                // instead of silently claiming an image is active when it
                // isn't.
                onError={(e) => {
                    console.error('PersistentBackgroundImage failed to load:', backgroundImageUri, e.nativeEvent?.error);
                    setBackgroundImageEnabled(false);
                }}
            />
            {/* Scrim so existing text (styled assuming a plain dark
                 background) stays legible over an arbitrary photo —
                 explicitly asked not to harshly hurt legibility. */}
            <View style={[StyleSheet.absoluteFillObject, styles.scrim]} pointerEvents="none" />
        </>
    );
}

const styles = StyleSheet.create({
    flexFill: { flex: 1 },
    scrim: { backgroundColor: 'rgba(0,0,0,0.55)' },
});
