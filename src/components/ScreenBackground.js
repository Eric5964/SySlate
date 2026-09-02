import React from 'react';
import { View, ImageBackground, StyleSheet } from 'react-native';
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
export default function ScreenBackground({ style, children }) {
    const { base } = useTheme();
    const { backgroundImageEnabled, backgroundImageUri } = usePreferences();

    if (backgroundImageEnabled && backgroundImageUri) {
        return (
            <ImageBackground source={{ uri: backgroundImageUri }} style={styles.flexFill} resizeMode="cover">
                {/* Scrim so existing text (styled assuming a plain dark
                     background) stays legible over an arbitrary photo —
                     explicitly asked not to harshly hurt legibility. */}
                <View style={[StyleSheet.absoluteFillObject, styles.scrim]} pointerEvents="none" />
                <View style={[styles.flexFill, style]}>{children}</View>
            </ImageBackground>
        );
    }
    return (
        <View style={[styles.flexFill, { backgroundColor: base.bg }, style]}>
            {children}
        </View>
    );
}

const styles = StyleSheet.create({
    flexFill: { flex: 1 },
    scrim: { backgroundColor: 'rgba(0,0,0,0.55)' },
});
