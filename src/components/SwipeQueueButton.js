import React, { useRef } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';

// Same swipe feel as SwipeableRow (the song rows): the same activation and
// give-up thresholds, the same small dead zone before anything moves, the
// same commit distance, and the same quick "Added" fade.
const COMMIT_DISTANCE = 52;
const REVEAL_DEADZONE = 10;

// Wraps a button so that swiping it to the right (instead of tapping it) calls
// `onSwipe`. Taps still reach the button inside as normal; a mostly vertical
// drag is left to the screen's scrolling. `edgeExclude` leaves a strip at the
// left edge to the screen's own swipe-back. On a swipe the button's face is
// briefly covered by an "Added" label that fades in and out like the one on
// song rows.
export default function SwipeQueueButton({ onSwipe, edgeExclude = 0, badgeColor = '#7c3aed', badgeTextColor = '#fff', radius = 24, children }) {
    const x = useRef(new Animated.Value(0)).current;
    const addedOpacity = useRef(new Animated.Value(0)).current;
    const fired = useRef(false);
    const swipeRef = useRef(onSwipe);
    swipeRef.current = onSwipe;
    const onGestureEvent = useRef(
        Animated.event([{ nativeEvent: { translationX: x } }], { useNativeDriver: true })
    ).current;
    // Nothing moves for the first few px (finger jitter), then the button
    // follows a little and stops.
    const shift = x.interpolate({
        inputRange: [-1000, -REVEAL_DEADZONE, REVEAL_DEADZONE, 60, 200],
        outputRange: [0, 0, 0, 22, 30],
        extrapolate: 'clamp',
    });
    const showAdded = () => {
        addedOpacity.setValue(0);
        Animated.sequence([
            Animated.timing(addedOpacity, { toValue: 1, duration: 120, useNativeDriver: true }),
            Animated.delay(500),
            Animated.timing(addedOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
        ]).start();
    };
    const onStateChange = useRef((e) => {
        const { state, oldState, translationX, velocityX } = e.nativeEvent;
        if (state === State.BEGAN) { fired.current = false; return; }
        if (oldState !== State.ACTIVE) return;
        if (!fired.current && state === State.END && (translationX > COMMIT_DISTANCE || (translationX > 28 && velocityX > 500))) {   // a cancelled gesture must not count as a swipe
            fired.current = true;
            swipeRef.current && swipeRef.current();
            showAdded();
        }
        Animated.spring(x, { toValue: 0, useNativeDriver: true, friction: 10, tension: 120 }).start();
    }).current;
    return (
        <PanGestureHandler
            onGestureEvent={onGestureEvent}
            onHandlerStateChange={onStateChange}
            activeOffsetX={[-6, 6]}
            failOffsetY={[-32, 32]}
            hitSlop={edgeExclude ? { left: -edgeExclude } : undefined}
        >
            <Animated.View style={{ transform: [{ translateX: shift }] }}>
                {children}
                <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.badge, { backgroundColor: badgeColor, borderRadius: radius, opacity: addedOpacity }]}>
                    <Text style={[styles.badgeText, { color: badgeTextColor }]}>Added</Text>
                </Animated.View>
            </Animated.View>
        </PanGestureHandler>
    );
}

const styles = StyleSheet.create({
    badge: { alignItems: 'center', justifyContent: 'center' },
    badgeText: { fontSize: 13, fontWeight: '700' },
});
