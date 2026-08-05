import React, { useRef, useEffect } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';
import { AddQueueIcon, TrashIcon } from './Icons';

const COMMIT_DISTANCE = 72;
const MAX_REVEAL = 96;

export default function SwipeableRow({
    children,
    onSwipeRight,
    onSwipeLeft,
    rightColor = '#7c3aed',
    leftColor = '#dc2626',
    disabled = false,
    // Excludes a strip at the left edge from this row's own pan gesture, so
    // a screen-level edge-swipe-back gesture (e.g. leaving a playlist) can
    // claim that zone instead of this row eating it as a queue-swipe. 0 by
    // default; PlaylistDetailScreen passes the same width as its navigator's
    // gestureResponseDistance.
    edgeExclude = 0,
}) {
    const translateX = useRef(new Animated.Value(0)).current;
    // Post-commit feedback — a soft accent-colored GLOW (border + shadow),
    // not a filled color flash. The flash-fill version read as harsh/didn't
    // land well, so this only ever animates `opacity` on a bordered overlay
    // (native-driver-safe, same pattern as the underlays below) rather than
    // introducing any new animated color/shadow properties.
    const rightGlow = useRef(new Animated.Value(0)).current;
    const leftGlow = useRef(new Animated.Value(0)).current;
    const onSwipeRightRef = useRef(onSwipeRight);
    const onSwipeLeftRef = useRef(onSwipeLeft);
    useEffect(() => { onSwipeRightRef.current = onSwipeRight; onSwipeLeftRef.current = onSwipeLeft; });

    const onGestureEvent = useRef(
        Animated.event(
            [{ nativeEvent: { translationX: translateX } }],
            { useNativeDriver: true }
        )
    ).current;

    const glowPulse = (val) => {
        val.setValue(0);
        Animated.sequence([
            Animated.timing(val, { toValue: 1, duration: 90, useNativeDriver: true }),
            Animated.timing(val, { toValue: 0, duration: 380, useNativeDriver: true }),
        ]).start();
    };

    const onHandlerStateChange = useRef((e) => {
        if (e.nativeEvent.oldState !== State.ACTIVE) return;
        const dx = e.nativeEvent.translationX;
        if (dx > COMMIT_DISTANCE && onSwipeRightRef.current) {
            // Fire immediately, animate the row back with a quick spring
            // instead of teleporting it via setValue(0).
            onSwipeRightRef.current();
            glowPulse(rightGlow);
            Animated.spring(translateX, { toValue: 0, useNativeDriver: true, friction: 10, tension: 120 }).start();
            return;
        }
        if (dx < -COMMIT_DISTANCE && onSwipeLeftRef.current) {
            // Fires immediately now too (was waiting for the slide-off
            // animation to finish first, which made it feel slower to
            // respond than the add side). The actual list-removal round
            // trip through TrackPlayer + refresh() already takes longer
            // than this 130ms slide, so firing in parallel doesn't cut the
            // animation short in practice — the row unmounts only once the
            // real data update lands.
            glowPulse(leftGlow);
            onSwipeLeftRef.current();
            Animated.timing(translateX, { toValue: -400, duration: 130, useNativeDriver: true }).start();
            return;
        }
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, friction: 9, tension: 80 }).start();
    }).current;

    // A small dead zone before ANY visible reaction (position OR underlay)
    // — natural touch jitter at the very start of a swipe (a few px in the
    // "wrong" direction before the real direction settles) was enough to
    // move the row and/or flash the other side's underlay. Both now derive
    // from ONE adjusted value instead of two separately-thresholded ones —
    // that mismatch (row already moving while the underlay was still hidden
    // behind its own threshold, then suddenly appearing) is what read as a
    // "bump" rather than a clean reveal.
    const REVEAL_DEADZONE = 10;
    const REVEAL_FULL = 30;
    const adjustedX = translateX.interpolate({
        inputRange: [-1000, -REVEAL_DEADZONE, REVEAL_DEADZONE, 1000],
        outputRange: [-1000 + REVEAL_DEADZONE, 0, 0, 1000 - REVEAL_DEADZONE],
    });

    // Clamp/rubber-band via interpolation (native thread).
    const displayX = adjustedX.interpolate({
        inputRange: [-300, -MAX_REVEAL, 0, MAX_REVEAL, 300],
        outputRange: [
            onSwipeLeft ? -MAX_REVEAL - 40 : 0,
            onSwipeLeft ? -MAX_REVEAL : 0,
            0,
            onSwipeRight ? MAX_REVEAL : 0,
            onSwipeRight ? MAX_REVEAL + 40 : 0,
        ],
        extrapolate: 'clamp',
    });

    // Both underlays are always mounted, with opacity interpolated DIRECTLY
    // from adjustedX (native thread) instead of a JS state variable set
    // from the gesture listener. The JS-state version lagged a frame or two
    // behind the actual native position, which is what showed the wrong
    // side's color for a moment when reversing direction mid-swipe.
    const rightOpacity = adjustedX.interpolate({ inputRange: [0, REVEAL_FULL - REVEAL_DEADZONE], outputRange: [0, 1], extrapolate: 'clamp' });
    const leftOpacity = adjustedX.interpolate({ inputRange: [-(REVEAL_FULL - REVEAL_DEADZONE), 0], outputRange: [1, 0], extrapolate: 'clamp' });
    const rightGlowOpacity = rightGlow.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });
    const leftGlowOpacity = leftGlow.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

    return (
        <View style={styles.wrap}>
            {onSwipeRight && (
                <Animated.View style={[styles.underlay, styles.underlayLeft, { backgroundColor: rightColor, opacity: rightOpacity }]}>
                    <AddQueueIcon size={18} color="#fff" />
                    <Text style={styles.underlayText}>Play Next</Text>
                </Animated.View>
            )}
            {onSwipeLeft && (
                <Animated.View style={[styles.underlay, styles.underlayRight, { backgroundColor: leftColor, opacity: leftOpacity }]}>
                    <Text style={styles.underlayText}>Remove</Text>
                    <TrashIcon size={18} color="#fff" />
                </Animated.View>
            )}
            <PanGestureHandler
                enabled={!disabled && (!!onSwipeRight || !!onSwipeLeft)}
                onGestureEvent={onGestureEvent}
                onHandlerStateChange={onHandlerStateChange}
                activeOffsetX={[-10, 10]}
                failOffsetY={[-15, 15]}
                hitSlop={edgeExclude ? { left: -edgeExclude } : undefined}
            >
                <Animated.View style={{ transform: [{ translateX: displayX }] }}>
                    {children}
                    {onSwipeRight && (
                        <Animated.View pointerEvents="none" style={[styles.glow, { borderColor: rightColor, shadowColor: rightColor, opacity: rightGlowOpacity }]} />
                    )}
                    {onSwipeLeft && (
                        <Animated.View pointerEvents="none" style={[styles.glow, { borderColor: leftColor, shadowColor: leftColor, opacity: leftGlowOpacity }]} />
                    )}
                </Animated.View>
            </PanGestureHandler>
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { position: 'relative' },
    underlay: {
        position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
        flexDirection: 'row', alignItems: 'center', borderRadius: 12,
        paddingHorizontal: 20, gap: 8,
    },
    underlayLeft: { justifyContent: 'flex-start' },
    underlayRight: { justifyContent: 'flex-end' },
    underlayText: { color: '#fff', fontSize: 13, fontWeight: '700' },
    // Static border + shadow — only `opacity` is ever animated (native-driver
    // safe), same principle as the underlay opacity interpolations above.
    glow: {
        ...StyleSheet.absoluteFillObject,
        borderRadius: 14,
        borderWidth: 1.5,
        shadowOffset: { width: 0, height: 0 },
        shadowRadius: 10,
        shadowOpacity: 0.9,
    },
});
