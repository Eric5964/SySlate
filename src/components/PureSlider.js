import React, { useRef } from 'react';
import { View, PanResponder, StyleSheet } from 'react-native';

export default function PureSlider({
    minimumValue = 0, maximumValue = 1, step = 0.5, value = 0,
    onValueChange, onSlidingComplete,
    minimumTrackTintColor = '#7c3aed',
    maximumTrackTintColor = '#222',
    thumbTintColor = '#7c3aed',
    style,
}) {
    const containerRef = useRef(null);
    const layout = useRef({ pageX: 0, width: 1 });
    const val = useRef(value);

    const clampSnap = (v) => {
        let c = Math.max(minimumValue, Math.min(maximumValue, v));
        if (step > 0) c = Math.round((c - minimumValue) / step) * step + minimumValue;
        return Math.round(c * 1000) / 1000;
    };

    const getVal = (pageX) => {
        const ratio = (pageX - layout.current.pageX) / layout.current.width;
        return clampSnap(minimumValue + ratio * (maximumValue - minimumValue));
    };

    const measure = () => {
        containerRef.current?.measure((x, y, w, h, pageX) => {
            layout.current = { pageX, width: w || 1 };
        });
    };

    const pan = useRef(PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
            measure();
            val.current = getVal(e.nativeEvent.pageX);
            onValueChange?.(val.current);
        },
        onPanResponderMove: (e) => {
            val.current = getVal(e.nativeEvent.pageX);
            onValueChange?.(val.current);
        },
        onPanResponderRelease: () => onSlidingComplete?.(val.current),
    })).current;

    const pct = Math.max(0, Math.min(1,
        (value - minimumValue) / (maximumValue - minimumValue)
    ));

    return (
        <View
            ref={containerRef}
            style={[styles.container, style]}
            onLayout={measure}
            {...pan.panHandlers}
        >
            <View style={[styles.track, { backgroundColor: maximumTrackTintColor }]}>
                <View style={[styles.fill, {
                    width: `${pct * 100}%`,
                    backgroundColor: minimumTrackTintColor,
                }]} />
            </View>
            <View style={[styles.thumb, {
                left: `${pct * 100}%`,
                transform: [{ translateX: -10 }],
                backgroundColor: thumbTintColor,
            }]} />
        </View>
    );
}

const styles = StyleSheet.create({
    container: { height: 44, justifyContent: 'center', position: 'relative' },
    track: { height: 3, borderRadius: 2, overflow: 'hidden' },
    fill: { height: '100%', borderRadius: 2 },
    thumb: { position: 'absolute', width: 20, height: 20, borderRadius: 10, top: 12 },
});