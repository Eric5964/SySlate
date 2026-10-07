import React from 'react';
import { View, StyleSheet } from 'react-native';
import { usePreferences } from '../context/PreferencesContext';

// Second rewrite. First version (stacked flat-opacity View bands) was
// "visibly steppy". Second version (Image + tintColor stretching a real
// alpha-ramp PNG, src/assets/edge-fade.png) looked right in every way when
// read back from source — asset verified as a real 8x256 white-to-transparent
// PNG, unconditionally rendered in both MiniPlayer and PlayerScreen, no
// hidden toggle gating it — but per his screenshots, isn't rendering AT ALL
// on-device (not faint, not steppy — completely absent, on both mini and
// full player). Couldn't find the actual mechanism by reading code alone —
// something about Image+tintColor is silently failing to paint in this
// specific sideloaded/non-standard-build environment. Rather than keep
// guessing at an invisible failure, going back to the Views approach from
// v1, but with far more, far thinner bands (48 instead of whatever the
// original few-band version used) on an eased curve — should read as a
// genuinely smooth linear fade now, not steppy, while being something that
// can only fail to render the exact same way any other View on this screen
// would (i.e., not silently).
function buildBands(n) {
    const bands = [];
    for (let i = 0; i < n; i++) {
        const t = i / (n - 1); // 0 at top, 1 at bottom
        // Slight ease-out so the fade reads as linear-to-the-eye (perceived
        // brightness isn't linear with alpha) rather than literally linear
        // alpha, which tends to look like it "hangs around" near the top.
        const alpha = Math.pow(1 - t, 1.4);
        bands.push(alpha);
    }
    return bands;
}

const BANDS_48 = buildBands(48);
const BANDS_10 = buildBands(10);   // Performance mode: 10 Views instead of 48

export default function GradientCap({ color = '#7c3aed', height = 90, style, flip = false }) {
    const { performanceMode } = usePreferences();
    const BANDS = performanceMode ? BANDS_10 : BANDS_48;
    const bandHeight = height / BANDS.length;
    return (
        <View pointerEvents="none" style={[styles.wrap, { height }, flip && styles.flip, style]}>
            {BANDS.map((alpha, i) => (
                <View
                    key={i}
                    style={{ height: bandHeight, backgroundColor: color, opacity: alpha }}
                />
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden' },
    flip: { transform: [{ scaleY: -1 }] },
});
