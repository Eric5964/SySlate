import React, { useEffect, useRef } from 'react';
import { View, Dimensions, Animated } from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';
import { EDGE_SWIPE_WIDTH } from '../utils/layout';

// An empty stretch of a screen where a swipe to the right goes back, in
// addition to the normal swipe from the screen's left edge. Only a mostly
// horizontal drag to the right counts, so scrolling and taps are untouched,
// and a swipe that starts inside the edge strip is left to the edge gesture
// (otherwise both would fire and go back twice).
export default function BackSwipeZone({ onBack, style, children, navigation, dragX, ...rest }) {
    const startX = useRef(0);
    const backRef = useRef(onBack);
    backRef.current = onBack;
    // The real edge swipe is the stack's own gesture (it follows the finger). A swipe that starts anywhere else
    // on this screen used to do nothing until the finger lifted. With `dragX` (an Animated.Value the screen
    // moves itself by) it now follows the finger too: the screen slides with it, and on release it either
    // slides off and goes back, or springs back.
    const stackGestureStarted = useRef(false);
    useEffect(() => {
        if (!navigation) return undefined;
        return navigation.addListener('gestureStart', () => { stackGestureStarted.current = true; });
    }, [navigation]);
    const width = Dimensions.get('window').width;
    // Follows the finger with plain setValue calls. (It used to be a native-driver Animated.event on a plain View; that
    // hookup crashed the app with an "onAnimatedValueUpdate listener" error when the swipe was let go.)
    const follow = useRef(dragX ? ({ nativeEvent: e }) => {
        // The edge strip belongs to the stack's own gesture, which already moves the screen.
        if (startX.current < EDGE_SWIPE_WIDTH + 4 || stackGestureStarted.current) return;
        dragX.setValue(Math.max(0, e.translationX));
    } : undefined).current;
    const reset = () => { if (dragX) Animated.spring(dragX, { toValue: 0, useNativeDriver: true, friction: 9, tension: 90 }).start(); };
    const handlerRef = useRef(({ nativeEvent: e }) => {
        if (e.state === State.BEGAN) { startX.current = e.absoluteX; stackGestureStarted.current = false; return; }
        if (e.state === State.CANCELLED || e.state === State.FAILED) { if (startX.current >= EDGE_SWIPE_WIDTH + 4) reset(); return; }
        if (e.state !== State.END) return;
        if (stackGestureStarted.current) return;
        if (startX.current < EDGE_SWIPE_WIDTH + 4) return;
        const goes = e.translationX > 70 || (e.translationX > 30 && e.velocityX > 600);
        if (goes && Math.abs(e.translationY) < e.translationX && backRef.current) {
            if (dragX) {
                Animated.timing(dragX, { toValue: width, duration: 170, useNativeDriver: true }).start(() => {
                    try { navigation?.setOptions({ animationEnabled: false }); } catch { }   // it has already slid off
                    backRef.current();
                });
            } else backRef.current();
        } else reset();
    }).current;
    return (
        <PanGestureHandler activeOffsetX={[-9999, 16]} failOffsetY={[-14, 14]} onGestureEvent={follow} onHandlerStateChange={handlerRef}>
            <View style={style} collapsable={false} {...rest}>{children}</View>
        </PanGestureHandler>
    );
}
