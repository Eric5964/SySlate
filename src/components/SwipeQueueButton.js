import React, { useRef } from 'react';
import { Animated } from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';

const COMMIT = 56;   // how far to the right a swipe has to go

// Wraps a button so that swiping it to the right (instead of tapping it) calls
// `onSwipe`. The button follows the finger a little and springs back. Taps
// still reach the button inside as normal; a mostly vertical drag is left to
// the screen's scrolling. `edgeExclude` leaves a strip at the left edge to the
// screen's own swipe-back.
export default function SwipeQueueButton({ onSwipe, edgeExclude = 0, children }) {
    const x = useRef(new Animated.Value(0)).current;
    const fired = useRef(false);
    const swipeRef = useRef(onSwipe);
    swipeRef.current = onSwipe;
    const onGestureEvent = useRef(
        Animated.event([{ nativeEvent: { translationX: x } }], { useNativeDriver: true })
    ).current;
    const shift = x.interpolate({ inputRange: [0, 60, 200], outputRange: [0, 22, 30], extrapolate: 'clamp' });
    const onStateChange = useRef((e) => {
        const { state, oldState, translationX } = e.nativeEvent;
        if (state === State.BEGAN) { fired.current = false; return; }
        if (oldState !== State.ACTIVE) return;
        if (!fired.current && translationX > COMMIT) {
            fired.current = true;
            swipeRef.current && swipeRef.current();
        }
        Animated.spring(x, { toValue: 0, useNativeDriver: true, friction: 9, tension: 90 }).start();
    }).current;
    return (
        <PanGestureHandler
            onGestureEvent={onGestureEvent}
            onHandlerStateChange={onStateChange}
            activeOffsetX={[-1000, 14]}
            failOffsetY={[-14, 14]}
            hitSlop={edgeExclude ? { left: -edgeExclude } : undefined}
        >
            <Animated.View style={{ transform: [{ translateX: shift }] }}>
                {children}
            </Animated.View>
        </PanGestureHandler>
    );
}
