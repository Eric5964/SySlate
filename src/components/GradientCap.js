import React from 'react';
import { View, StyleSheet } from 'react-native';
import { gradientBands } from '../utils/color';

// Flat gradient built from a single color (either the cover's extracted
// average color, or the deterministic playlist color as a fallback) — no
// image is rendered here, just the color bands.
export default function GradientCap({ color = '#7c3aed', height = 90, style }) {
    const bands = gradientBands(color);
    const bandHeight = height / bands.length;
    return (
        <View pointerEvents="none" style={[styles.wrap, { height }, style]}>
            {bands.map((c, i) => (
                <View key={i} style={{ height: bandHeight, backgroundColor: c }} />
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden' },
});
