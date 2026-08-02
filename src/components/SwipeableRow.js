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
}) {
    const translateX = useRef(new Animated.Value(0)).current;
    // Post-commit color flash — one Animated.Value per side rather than
    // trying to interpolate a single value between two arbitrary colors.
    // Both are opacity-only (native-driver-safe) overlays on fixed-color
    // layers, kept in the SAME transformed Animated.View as children so
    // they travel with the row instead of the fixed underlay track.
    const rightFlash = useRef(new Animated.Value(0)).current;
    const leftFlash = useRef(new Animated.Value(0)).current;
    const onSwipeRightRef = useRef(onSwipeRight);
    const onSwipeLeftRef = useRef(onSwipeLeft);
    useEffect(() => { onSwipeRightRef.current = onSwipeRight; onSwipeLeftRef.current = onSwipeLeft; });

    const onGestureEvent = useRef(
        Animated.event(
            [{ nativeEvent: { translationX: translateX } }],
            { useNativeDriver: true }
        )
    ).current;

    const flashPulse = (val) => {
        val.setValue(1);
        Animated.timing(val, { toValue: 0, duration: 320, useNativeDriver: true }).start();
    };

    const onHandlerStateChange = useRef((e) => {
        if (e.nativeEvent.oldState !== State.ACTIVE) return;
        const dx = e.nativeEvent.translationX;
        if (dx > COMMIT_DISTANCE && onSwipeRightRef.current) {
            // Fire the action immediately — no lag on the actual "add" — but
            // animate the row back into place with a quick spring instead of
            // teleporting it via setValue(0). The instant jump was what read
            // as "jumpy"; this keeps the same snappy response time while
            // still looking like motion rather than a cut.
            onSwipeRightRef.current();
            flashPulse(rightFlash);
            Animated.spring(translateX, { toValue: 0, useNativeDriver: true, friction: 10, tension: 120 }).start();
            return;
        }
        if (dx < -COMMIT_DISTANCE && onSwipeLeftRef.current) {
            // Fires after the slide-off finishes (not before), since the row
            // actually gets removed from the underlying list — firing early
            // would unmount it mid-animation. Duration shortened so it feels
            // as quick as the add-side spring above, just necessarily
            // sequenced (animate then fire) rather than parallel.
            flashPulse(leftFlash);
            Animated.timing(translateX, { toValue: -400, duration: 130, useNativeDriver: true }).start(() => {
                onSwipeLeftRef.current();
            });
            return;
        }
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, friction: 9, tension: 80 }).start();
    }).current;

    // Clamp/rubber-band via interpolation (native thread).
    const displayX = translateX.interpolate({
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
    // from translateX (native thread) instead of a JS state variable set
    // from the gesture listener. The JS-state version lagged a frame or two
    // behind the actual native position, which is what showed the wrong
    // side's color for a moment when reversing direction mid-swipe.
    const rightOpacity = translateX.interpolate({ inputRange: [0, 12], outputRange: [0, 1], extrapolate: 'clamp' });
    const leftOpacity = translateX.interpolate({ inputRange: [-12, 0], outputRange: [1, 0], extrapolate: 'clamp' });
    const rightFlashOpacity = rightFlash.interpolate({ inputRange: [0, 1], outputRange: [0, 0.32] });
    const leftFlashOpacity = leftFlash.interpolate({ inputRange: [0, 1], outputRange: [0, 0.32] });

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
            >
                <Animated.View style={{ transform: [{ translateX: displayX }] }}>
                    {children}
                    {onSwipeRight && (
                        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { backgroundColor: rightColor, opacity: rightFlashOpacity, borderRadius: 12 }]} />
                    )}
                    {onSwipeLeft && (
                        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { backgroundColor: leftColor, opacity: leftFlashOpacity, borderRadius: 12 }]} />
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
});
