import React from 'react';
import { View, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { TOP_FADE } from '../utils/layout';

// The colored back of a top bar: solid color down to TOP_FADE above the bar's
// bottom edge, with a soft shadow under it. Rows scrolling up under the
// bar disappear behind the colored part and the shadow sits on top of them.
// Put it as the FIRST child of the bar (so the bar's buttons and title draw
// on top of it). The bar itself needs no background of its own.
//
// The shadow is one flat gradient layer, in every mode. It used to be a blurred native shadow, which the GPU has to
// render in a separate pass; a plain gradient is only blended.
const SHADOW_H = 10;
const SHADOW_COLORS = ['rgba(0, 0, 0, 0.4)', 'rgba(0, 0, 0, 0.16)', 'rgba(0, 0, 0, 0)'];
const SHADOW_STOPS = [0, 0.4, 1];

export default function TopBarBack({ color }) {
    return (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <View style={[styles.solid, { backgroundColor: color }]} />
            <LinearGradient colors={SHADOW_COLORS} locations={SHADOW_STOPS} style={styles.shadow} />
        </View>
    );
}

const styles = StyleSheet.create({
    solid: { position: 'absolute', left: 0, right: 0, top: 0, bottom: TOP_FADE },
    // Starts where the solid part ends (TOP_FADE above the bar's bottom edge) and runs SHADOW_H below that.
    shadow: { position: 'absolute', left: 0, right: 0, bottom: TOP_FADE - SHADOW_H, height: SHADOW_H },
});
