import React from 'react';
import { Image, StyleSheet } from 'react-native';

// Was stacked flat-opacity View bands (visibly steppy, not a real gradient —
// exactly what got flagged: "just bars of opacity colors"). Now a genuine
// linear alpha gradient: a small PNG (src/assets/edge-fade.png) that's solid
// white with a real per-pixel alpha ramp from fully opaque to fully
// transparent, tinted to `color` via Image's tintColor (which recolors RGB
// while keeping the source alpha channel intact) and stretched to fill.
// No new native dependency — Image + tintColor already ships with React
// Native, unlike a gradient library, which would mean another native
// rebuild. `flip` mirrors it for a bottom-anchored fade instead of a
// top-anchored one.
export default function GradientCap({ color = '#7c3aed', height = 90, style, flip = false }) {
    return (
        <Image
            source={require('../assets/edge-fade.png')}
            resizeMode="stretch"
            tintColor={color}
            pointerEvents="none"
            style={[styles.wrap, { height }, flip && styles.flip, style]}
        />
    );
}

const styles = StyleSheet.create({
    wrap: { position: 'absolute', top: 0, left: 0, right: 0 },
    flip: { transform: [{ scaleY: -1 }] },
});
