import React, { useRef, useState } from 'react';
import { View, PanResponder, StyleSheet } from 'react-native';

export default function PureSlider({
    minimumValue = 0, maximumValue = 1, step = 0.5, value = 0,
    onValueChange, onSlidingComplete,
    minimumTrackTintColor = '#7c3aed',
    maximumTrackTintColor = '#222',
    thumbTintColor = '#7c3aed',
    style,
}) {
    const [trackWidth, setTrackWidth] = useState(0);
    const current = useRef(value);

    const snap = (v) => {
        let c = Math.max(minimumValue, Math.min(maximumValue, v));
        if (step > 0) c = Math.round((c - minimumValue) / step) * step + minimumValue;
        return Math.round(c * 100) / 100;
    };

    const fromX = (x) => snap(minimumValue + (x / trackWidth) * (maximumValue - minimumValue));

    const pan = useRef(PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
            if (!trackWidth) return;
            const v = fromX(Math.max(0, Math.min(trackWidth, e.nativeEvent.locationX)));
            current.current = v;
            onValueChange?.(v);
        },
        onPanResponderMove: (e) => {
            if (!trackWidth) return;
            const v = fromX(Math.max(0, Math.min(trackWidth, e.nativeEvent.locationX)));
            current.current = v;
            onValueChange?.(v);
        },
        onPanResponderRelease: () => onSlidingComplete?.(current.current),
    })).current;

    const pct = trackWidth > 0
        ? Math.max(0, Math.min(1, (value - minimumValue) / (maximumValue - minimumValue)))
        : 0;

    return (
        <View
            style={[styles.wrap, style]}
            onLayout={e => setTrackWidth(e.nativeEvent.layout.width)}
            {...pan.panHandlers}
        >
            <View style={[styles.track, { backgroundColor: maximumTrackTintColor }]}>
                <View style={[styles.fill, { width: `${pct * 100}%`, backgroundColor: minimumTrackTintColor }]} />
            </View>
            <View style={[styles.thumb, { marginLeft: pct * trackWidth - 10, backgroundColor: thumbTintColor }]} />
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { height: 40, justifyContent: 'center' },
    track: { height: 3, borderRadius: 2, overflow: 'hidden' },
    fill: { height: '100%', borderRadius: 2 },
    thumb: { position: 'absolute', width: 20, height: 20, borderRadius: 10, top: 10 },
});