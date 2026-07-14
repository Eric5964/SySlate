import React, { useRef, useEffect } from 'react';
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
    const layoutRef = useRef({ pageX: 0, width: 1 });
    const valRef = useRef(value);
    // Keep ALL props fresh — avoids stale closure in PanResponder
    const propsRef = useRef({ onValueChange, onSlidingComplete, minimumValue, maximumValue, step });
    useEffect(() => {
        propsRef.current = { onValueChange, onSlidingComplete, minimumValue, maximumValue, step };
    });

    const measure = () => {
        containerRef.current?.measure((_x, _y, w, _h, pageX) => {
            layoutRef.current = { pageX: pageX ?? 0, width: w || 1 };
        });
    };

    const computeVal = (pageX) => {
        const { minimumValue: mn, maximumValue: mx, step: st } = propsRef.current;
        const ratio = (pageX - layoutRef.current.pageX) / layoutRef.current.width;
        let v = mn + ratio * (mx - mn);
        v = Math.max(mn, Math.min(mx, v));
        if (st > 0) v = Math.round((v - mn) / st) * st + mn;
        return Math.round(v * 1000) / 1000;
    };

    const pan = useRef(PanResponder.create({
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderGrant: (e) => {
            measure();
            valRef.current = computeVal(e.nativeEvent.pageX);
            propsRef.current.onValueChange?.(valRef.current);
        },
        onPanResponderMove: (e) => {
            valRef.current = computeVal(e.nativeEvent.pageX);
            propsRef.current.onValueChange?.(valRef.current);
        },
        onPanResponderRelease: () => {
            propsRef.current.onSlidingComplete?.(valRef.current);
        },
    })).current;

    const pct = Math.max(0, Math.min(1,
        (value - minimumValue) / ((maximumValue - minimumValue) || 1)
    ));

    return (
        <View
            ref={containerRef}
            style={[styles.container, style]}
            onLayout={measure}
            {...pan.panHandlers}
        >
            <View style={[styles.track, { backgroundColor: maximumTrackTintColor }]}>
                <View style={[styles.fill, { width: `${pct * 100}%`, backgroundColor: minimumTrackTintColor }]} />
            </View>
            <View style={[styles.thumb, {
                left: `${pct * 100}%`,
                marginLeft: -14,
                backgroundColor: thumbTintColor,
            }]} />
        </View>
    );
}

const styles = StyleSheet.create({
    container: { height: 52, justifyContent: 'center', position: 'relative' },
    track: { height: 4, borderRadius: 2, overflow: 'hidden' },
    fill: { height: '100%', borderRadius: 2 },
    thumb: { position: 'absolute', width: 28, height: 28, borderRadius: 14, top: 12, borderWidth: 1.5, borderColor: 'rgba(0,0,0,0.18)' },
});