import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
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
// Uses expo-image instead of React Native's built-in ImageBackground —
// plain RN Image/ImageBackground has no guaranteed decode cache across
// mounts, so the SAME background image was being redecoded from disk every
// single time any screen using this component mounted (which is every
// screen in the app). That's what was behind both "background images
// flash when loaded" and "switching colors & images take far too long" —
// every navigation was paying a fresh decode. expo-image caches decoded
// images in memory (and on disk) keyed by URI, so after the first paint
// it's instant everywhere this same URI is used.
export default function ScreenBackground({ style, children }) {
    const { base } = useTheme();
    const { backgroundImageEnabled, backgroundImageUri } = usePreferences();
    const hasImage = backgroundImageEnabled && backgroundImageUri;

    // Real bug found here: the two branches used to return different
    // element types at the root (Image-wrapping vs plain View) with
    // `children` sitting at a different nesting depth in each — so the
    // moment backgroundImageEnabled flipped (e.g. right after picking an
    // image for the first time), React saw the children subtree as
    // structurally different and remounted the whole thing, including
    // whatever ScrollView/scroll position was live on the screen using it.
    // That's what was behind "the settings screen jumps when applying a
    // background image" — it wasn't really about the image at all, it was
    // this component forcing a remount of the entire screen underneath it.
    // Now both cases render the identical tree shape (same outer View, same
    // inner wrapper for children at the same position) — only the
    // image/scrim as extra siblings mount or unmount, which doesn't touch
    // children's identity.
    return (
        <View style={[styles.flexFill, !hasImage && { backgroundColor: base.bg }]}>
            {hasImage && (
                <>
                    <Image
                        source={{ uri: backgroundImageUri }}
                        style={StyleSheet.absoluteFillObject}
                        contentFit="cover"
                        cachePolicy="memory-disk"
                        transition={0}
                    />
                    {/* Scrim so existing text (styled assuming a plain dark
                         background) stays legible over an arbitrary photo —
                         explicitly asked not to harshly hurt legibility. */}
                    <View style={[StyleSheet.absoluteFillObject, styles.scrim]} pointerEvents="none" />
                </>
            )}
            <View style={[styles.flexFill, style]}>{children}</View>
        </View>
    );
}

const styles = StyleSheet.create({
    flexFill: { flex: 1 },
    scrim: { backgroundColor: 'rgba(0,0,0,0.55)' },
});
