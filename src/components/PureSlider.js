import React, { useRef, useEffect } from 'react';
import { View, PanResponder, StyleSheet } from 'react-native';
import { isScrolling } from '../utils/scrollGuard';

export default function PureSlider({
    minimumValue = 0, maximumValue = 1, step = 0.5, value = 0,
    onValueChange, onSlidingComplete,
    minimumTrackTintColor = '#7c3aed',
    maximumTrackTintColor = '#222',
    thumbTintColor = '#7c3aed',
    disabled = false,
    // Sliders on a scrolling page (Settings): a touch moves the slider right
    // away, as usual, but not while the page itself is moving (scroll speed
    // above a few pixels per second), and an up-down swipe is left to the
    // page: only a mostly sideways drag, or a plain tap, changes the value.
    guardScroll = false,
    style,
}) {
    const containerRef = useRef(null);
    const layoutRef = useRef({ pageX: 0, width: 1 });
    const valRef = useRef(value);
    const engaged = useRef(false);
    // Keep ALL props fresh — avoids stale closure in PanResponder
    const propsRef = useRef({ onValueChange, onSlidingComplete, minimumValue, maximumValue, step, disabled, value, guardScroll });
    useEffect(() => {
        propsRef.current = { onValueChange, onSlidingComplete, minimumValue, maximumValue, step, disabled, value, guardScroll };
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
    const apply = (pageX) => {
        valRef.current = computeVal(pageX);
        propsRef.current.onValueChange?.(valRef.current);
    };

    const pan = useRef(PanResponder.create({
        // Per-preset lock (premade EQ bands shouldn't be draggable, only
        // custom ones) — reads propsRef so a `disabled` prop change takes
        // effect immediately without needing to recreate the PanResponder.
        // Plain sliders (sheets, EQ bands) grab the touch at once, ahead of
        // any scroll view. Guarded sliders only take it when the page is
        // not scrolling.
        onStartShouldSetPanResponder: () => !!propsRef.current.guardScroll && !propsRef.current.disabled && !isScrolling(),
        onStartShouldSetPanResponderCapture: () => !propsRef.current.guardScroll && !propsRef.current.disabled,
        onMoveShouldSetPanResponderCapture: () => !propsRef.current.guardScroll && !propsRef.current.disabled,
        // Once the slider is moving the page must not take the touch away.
        onPanResponderTerminationRequest: () => !engaged.current,
        onPanResponderGrant: (e) => {
            if (propsRef.current.disabled) return;
            measure();
            engaged.current = false;
            if (propsRef.current.guardScroll) return;   // waits for a sideways move or a tap
            engaged.current = true;
            apply(e.nativeEvent.pageX);
        },
        onPanResponderMove: (e, g) => {
            if (propsRef.current.disabled) return;
            if (propsRef.current.guardScroll && !engaged.current) {
                // Mostly sideways and far enough to be a drag; an up-down swipe is a scroll.
                if (Math.abs(g.dx) < 5 || Math.abs(g.dx) < Math.abs(g.dy) * 1.3 || isScrolling()) return;
                engaged.current = true;
            }
            apply(e.nativeEvent.pageX);
        },
        onPanResponderRelease: (e, g) => {
            if (propsRef.current.disabled) return;
            if (propsRef.current.guardScroll && !engaged.current) {
                // A plain tap (finger barely moved, page still): jump to the tapped spot.
                if (Math.hypot(g.dx, g.dy) > 8 || isScrolling()) return;
                apply(e.nativeEvent.pageX);
                engaged.current = true;
            }
            if (engaged.current) propsRef.current.onSlidingComplete?.(valRef.current);
            engaged.current = false;
        },
        onPanResponderTerminate: () => {
            // Taken over by the page's scrolling: keep what the slider already had.
            if (engaged.current) propsRef.current.onSlidingComplete?.(valRef.current);
            engaged.current = false;
        },
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
