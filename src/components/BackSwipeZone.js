import React, { useEffect, useRef } from 'react';
import { View, Dimensions } from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';
import { EDGE_SWIPE_WIDTH } from '../utils/layout';

// An empty stretch of a screen where a swipe to the right goes back, in
// addition to the normal swipe from the screen's left edge. Only a mostly
// horizontal drag to the right counts, so scrolling and taps are untouched,
// and a swipe that starts inside the edge strip is left to the edge gesture
// (otherwise both would fire and go back twice).
export default function BackSwipeZone({ onBack, style, children, navigation, ...rest }) {
    const startX = useRef(0);
    const backRef = useRef(onBack);
    backRef.current = onBack;
    // With `navigation` given, a touch that lands here widens the screen's own back gesture to the full
    // width for that touch, so the screen follows the finger exactly like the left-edge swipe does. The
    // gesture below stays as the fallback (and does nothing if the real gesture already took over).
    const stackGestureStarted = useRef(false);
    const timer = useRef(null);
    const narrow = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } navigation?.setOptions({ gestureResponseDistance: EDGE_SWIPE_WIDTH }); };
    const widen = () => {
        stackGestureStarted.current = false;
        navigation?.setOptions({ gestureResponseDistance: Dimensions.get('window').width });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(narrow, 1500);   // never stays wide if no end-of-touch event arrives
    };
    useEffect(() => {
        if (!navigation) return undefined;
        const sub = navigation.addListener('gestureStart', () => { stackGestureStarted.current = true; });
        return () => { sub(); if (timer.current) clearTimeout(timer.current); };
    }, [navigation]);
    const handlerRef = useRef(({ nativeEvent: e }) => {
        if (e.state === State.BEGAN) { startX.current = e.absoluteX; return; }
        if (e.state !== State.END) return;
        if (stackGestureStarted.current) return;
        if (startX.current < EDGE_SWIPE_WIDTH + 4) return;
        if (e.translationX > 70 || (e.translationX > 30 && e.velocityX > 600)) {
            if (Math.abs(e.translationY) < e.translationX && backRef.current) backRef.current();
        }
    }).current;
    return (
        <PanGestureHandler activeOffsetX={[-9999, 16]} failOffsetY={[-14, 14]} onHandlerStateChange={handlerRef}>
            <View style={style} collapsable={false}
                onTouchStart={navigation ? widen : undefined}
                onTouchEnd={navigation ? () => setTimeout(narrow, 300) : undefined}
                onTouchCancel={navigation ? () => setTimeout(narrow, 300) : undefined}
                {...rest}>{children}</View>
        </PanGestureHandler>
    );
}
