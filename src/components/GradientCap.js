import React from 'react';
import { View, StyleSheet } from 'react-native';
import { gradientBands } from '../utils/color';

// Hand-rolled top-down gradient using stacked semi-transparent bands —
// avoids adding a native gradient dependency for what's meant to be a subtle
// effect. Sits absolutely positioned; parent must have position:relative/overflow hidden.
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
    wrap: { position: 'absolute', top: 0, left: 0, right: 0 },
});