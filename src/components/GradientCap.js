import React from 'react';
import { View, Image, StyleSheet } from 'react-native';
import { gradientBands } from '../utils/color';

const DARK_BANDS = [0.55, 0.42, 0.28, 0.16, 0.07, 0].map(a => `rgba(0,0,0,${a})`);

// If a real cover image is set, show the actual (blurred) image with a dark
// fade over it — this is what makes the gradient genuinely match the
// playlist's cover instead of an approximated color, with no image-color-
// extraction dependency needed. Falls back to the old solid-color fake
// gradient when there's no cover image yet.
export default function GradientCap({ color = '#7c3aed', imageUri = null, height = 90, style }) {
    const bands = imageUri ? DARK_BANDS : gradientBands(color);
    const bandHeight = height / bands.length;
    return (
        <View pointerEvents="none" style={[styles.wrap, { height }, style]}>
            {imageUri && (
                <Image source={{ uri: imageUri }} style={StyleSheet.absoluteFillObject} resizeMode="cover" blurRadius={10} />
            )}
            {bands.map((c, i) => (
                <View key={i} style={{ height: bandHeight, backgroundColor: c }} />
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden' },
});
