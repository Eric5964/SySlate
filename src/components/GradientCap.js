import React from 'react';
import { View, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

// A colour fading to nothing from the top edge down (flip: from the bottom edge up), drawn as ONE native gradient
// layer. It used to be 8 to 48 stacked Views (an Image + tintColor version before that never painted on the device),
// each of them a layer the compositor had to blend on every frame; this is a single layer in any mode.
//
// The fade is eased, (1 - t)^1.4, which reads as linear to the eye; five stops follow that curve closely enough.
const STOPS = [0, 0.25, 0.5, 0.75, 1];
const ALPHAS = STOPS.map(t => Math.pow(1 - t, 1.4));

// The same colour at a given alpha. A gradient has to fade to the SAME colour at alpha 0: fading to 'transparent'
// (black at alpha 0) passes through a dark grey in between.
function withAlpha(color, a) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color || '');
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a.toFixed(3)})`;
}

export default function GradientCap({ color = '#7c3aed', height = 90, style, flip = false }) {
    const colors = React.useMemo(() => {
        const list = ALPHAS.map(a => withAlpha(color, a));
        // A colour that is not a hex string cannot be given an alpha: fade it with the plain opacity instead.
        return list.every(Boolean) ? list : [color, color];
    }, [color]);
    const stops = colors.length === STOPS.length ? STOPS : undefined;
    return (
        <View pointerEvents="none" style={[styles.wrap, { height }, flip && styles.flip, style]}>
            <LinearGradient colors={colors} locations={stops} style={StyleSheet.absoluteFill} />
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden' },
    flip: { transform: [{ scaleY: -1 }] },
});
