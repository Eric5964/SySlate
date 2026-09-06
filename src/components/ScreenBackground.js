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
// Uses plain React Native Image, not expo-image — a prior round switched
// this to expo-image for cross-mount decode caching (to fix flashing/slow
// switching), but that added a new native dependency, and its native
// module very likely never actually got linked into the compiled app given
// how this project's iOS project is maintained (manually-registered
// pbxproj entries, no automatic `expo prebuild`/pod install step — see the
// AudioEngine.swift/.m registration history). That's the far more likely
// explanation for the wave of app-wide regressions afterward (progress bar
// gestures, swipe-to-close, queue swipe rows all going choppy/unresponsive)
// than any of those being independent bugs — adding a native dependency
// without a full pod install can destabilize gesture-handler and other
// already-working native modules, not just the new one. Reverted back to
// plain Image; the flash/slow-switching complaint stays open until there's
// a safe way to add real image caching that doesn't risk this again.
export default function ScreenBackground({ style, children }) {
    const { base } = useTheme();
    const { backgroundImageEnabled, backgroundImageUri } = usePreferences();
    const hasImage = backgroundImageEnabled && backgroundImageUri;

    // Real bug found here (kept from the expo-image round — unrelated to
    // which Image component is used): the two branches used to return
    // different element types at the root (Image-wrapping vs plain View)
    // with `children` sitting at a different nesting depth in each — so
    // the moment backgroundImageEnabled flipped (e.g. right after picking
    // an image for the first time), React saw the children subtree as
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
                        resizeMode="cover"
                        fadeDuration={0}
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
