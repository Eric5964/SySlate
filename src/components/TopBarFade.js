import React from 'react';
import { View, StyleSheet } from 'react-native';
import { TOP_FADE } from '../utils/layout';
import { usePreferences } from '../context/PreferencesContext';

// The colored back of a top bar: solid color down to TOP_FADE above the bar's
// bottom edge, with a soft drop shadow under it. Rows scrolling up under the
// bar disappear behind the colored part and the shadow sits on top of them.
// Put it as the FIRST child of the bar (so the bar's buttons and title draw
// on top of it). The bar itself needs no background of its own.
export default function TopBarBack({ color }) {
    const { performanceMode } = usePreferences();
    return (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <View style={[styles.solid, { backgroundColor: color }, performanceMode && styles.noShadow]} />
        </View>
    );
}

const styles = StyleSheet.create({
    solid: {
        position: 'absolute', left: 0, right: 0, top: 0, bottom: TOP_FADE,
        shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
    },
    noShadow: { shadowOpacity: 0, shadowRadius: 0 },
});
