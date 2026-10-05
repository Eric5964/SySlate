import React, { useRef, useEffect, useState } from 'react';
import { View, PanResponder, StyleSheet } from 'react-native';

export default function PureSlider({
    minimumValue = 0, maximumValue = 1, step = 0.5, value = 0,
    onValueChange, onSlidingComplete,
    minimumTrackTintColor = '#7c3aed',
    maximumTrackTintColor = '#222',
    thumbTintColor = '#7c3aed',
    disabled = false,
    // Settings sliders: a plain tap or a swipe that happens to start on the
    // slider does nothing (a swipe just scrolls the page). Press and hold
    // for a moment, then drag; the value moves relative to where it was, so
    // it can't jump to the finger.
    holdToAdjust = false,
    style,
}) {
    const [armed, setArmed] = useState(false);
    const armedRef = useRef(false);
    const holdTimer = useRef(null);
    const drag0 = useRef({ x: 0, v: 0 });
    const lastX = useRef(0);
    const containerRef = useRef(null);
    const layoutRef = useRef({ pageX: 0, width: 1 });
    const valRef = useRef(value);
    // Keep ALL props fresh — avoids stale closure in PanResponder
    const propsRef = useRef({ onValueChange, onSlidingComplete, minimumValue, maximumValue, step, disabled, value, holdToAdjust });
    useEffect(() => {
        propsRef.current = { onValueChange, onSlidingComplete, minimumValue, maximumValue, step, disabled, value, holdToAdjust };
    });
    useEffect(() => () => clearTimeout(holdTimer.current), []);

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

    const relativeVal = (pageX) => {
        const { minimumValue: mn, maximumValue: mx, step: st } = propsRef.current;
        let v = drag0.current.v + ((pageX - drag0.current.x) / layoutRef.current.width) * (mx - mn);
        v = Math.max(mn, Math.min(mx, v));
        if (st > 0) v = Math.round((v - mn) / st) * st + mn;
        return Math.round(v * 1000) / 1000;
    };
    const endHold = () => { clearTimeout(holdTimer.current); armedRef.current = false; setArmed(false); };

    const pan = useRef(PanResponder.create({
        // Per-preset lock (premade EQ bands shouldn't be draggable, only
        // custom ones) — reads propsRef so a `disabled` prop change takes
        // effect immediately without needing to recreate the PanResponder.
        onStartShouldSetPanResponder: () => !!propsRef.current.holdToAdjust && !propsRef.current.disabled,
        onStartShouldSetPanResponderCapture: () => !propsRef.current.holdToAdjust && !propsRef.current.disabled,
        onMoveShouldSetPanResponderCapture: () => !propsRef.current.holdToAdjust && !propsRef.current.disabled,
        // Once armed the page must not scroll away from under the finger.
        onPanResponderTerminationRequest: () => !armedRef.current,
        onPanResponderGrant: (e) => {
            if (propsRef.current.disabled) return;
            measure();
            if (propsRef.current.holdToAdjust) {
                lastX.current = e.nativeEvent.pageX;
                clearTimeout(holdTimer.current);
                holdTimer.current = setTimeout(() => {
                    armedRef.current = true;
                    setArmed(true);
                    drag0.current = { x: lastX.current, v: propsRef.current.value };
                    valRef.current = propsRef.current.value;
                }, 350);
                return;
            }
            valRef.current = computeVal(e.nativeEvent.pageX);
            propsRef.current.onValueChange?.(valRef.current);
        },
        onPanResponderMove: (e, g) => {
            if (propsRef.current.disabled) return;
            if (propsRef.current.holdToAdjust) {
                lastX.current = e.nativeEvent.pageX;
                if (!armedRef.current) {
                    // Moved before the hold finished: this was a scroll or a slip, not an adjustment.
                    if (Math.hypot(g.dx, g.dy) > 10) clearTimeout(holdTimer.current);
                    return;
                }
                valRef.current = relativeVal(e.nativeEvent.pageX);
                propsRef.current.onValueChange?.(valRef.current);
                return;
            }
            valRef.current = computeVal(e.nativeEvent.pageX);
            propsRef.current.onValueChange?.(valRef.current);
        },
        onPanResponderRelease: () => {
            if (propsRef.current.disabled) return;
            const wasArmed = armedRef.current;
            if (propsRef.current.holdToAdjust) {
                endHold();
                if (wasArmed) propsRef.current.onSlidingComplete?.(valRef.current);
                return;
            }
            propsRef.current.onSlidingComplete?.(valRef.current);
        },
        onPanResponderTerminate: () => { if (propsRef.current.holdToAdjust) endHold(); },
    })).current;

    const pct = Math.max(0, Math.min(1,
        (value - minimumValue) / ((maximumValue - minimumValue) || 1)
    ));

    return (
        <View
            ref={containerRef}
            style={[styles.container, style, disabled && { opacity: 0.4 }]}
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
                transform: [{ scale: armed ? 1.25 : 1 }],
                opacity: holdToAdjust && !armed ? 0.75 : 1,
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