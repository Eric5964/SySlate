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
    const onSwipeRightRef = useRef(onSwipeRight);
    const onSwipeLeftRef = useRef(onSwipeLeft);
    useEffect(() => { onSwipeRightRef.current = onSwipeRight; onSwipeLeftRef.current = onSwipeLeft; });

    const onGestureEvent = useRef(
        Animated.event(
            [{ nativeEvent: { translationX: translateX } }],
            { useNativeDriver: true }
        )
    ).current;

    const onHandlerStateChange = useRef((e) => {
        if (e.nativeEvent.oldState !== State.ACTIVE) return;
        const dx = e.nativeEvent.translationX;
        if (dx > COMMIT_DISTANCE && onSwipeRightRef.current) {
            // Immediate — snap back right away and fire, rather than waiting
            // out an animation before the action registers.
            translateX.setValue(0);
            onSwipeRightRef.current();
            return;
        }
        if (dx < -COMMIT_DISTANCE && onSwipeLeftRef.current) {
            Animated.timing(translateX, { toValue: -400, duration: 100, useNativeDriver: true }).start(() => {
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
