import React from 'react';
import { View, StyleSheet } from 'react-native';
import { TOP_FADE } from '../utils/layout';

// The colored back of a top bar, with a soft bottom edge: solid color down to
// TOP_FADE above the bar's bottom, then thin slices of the same color going
// from solid to fully see-through right at the bottom edge. The bar melts
// into the base color or background picture instead of ending in a hard line,
// and list rows scrolling up under it disappear into it.
// Put it as the FIRST child of the bar (so the bar's buttons and title draw
// on top of it). The bar itself needs no background of its own.
const SLICES = TOP_FADE * 2;
const ALPHAS = Array.from({ length: SLICES }, (_, i) => Math.pow(1 - (i + 0.5) / SLICES, 1.3));

export default function TopBarBack({ color }) {
    return (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: TOP_FADE, backgroundColor: color }} />
            <View style={styles.fade}>
                {ALPHAS.map((a, i) => (
                    <View key={i} style={{ height: TOP_FADE / SLICES, backgroundColor: color, opacity: a }} />
                ))}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    fade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: TOP_FADE },
});
