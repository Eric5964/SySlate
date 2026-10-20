import React, { useRef } from 'react';
import { View } from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';
import { EDGE_SWIPE_WIDTH } from '../utils/layout';

// An empty stretch of a screen where a swipe to the right goes back, in
// addition to the normal swipe from the screen's left edge. Only a mostly
// horizontal drag to the right counts, so scrolling and taps are untouched,
// and a swipe that starts inside the edge strip is left to the edge gesture
// (otherwise both would fire and go back twice).
export default function BackSwipeZone({ onBack, style, children, ...rest }) {
    const startX = useRef(0);
    const backRef = useRef(onBack);
    backRef.current = onBack;
    const handlerRef = useRef(({ nativeEvent: e }) => {
        if (e.state === State.BEGAN) { startX.current = e.absoluteX; return; }
        if (e.state !== State.END) return;
        if (startX.current < EDGE_SWIPE_WIDTH + 4) return;
        if (e.translationX > 70 || (e.translationX > 30 && e.velocityX > 600)) {
            if (Math.abs(e.translationY) < e.translationX && backRef.current) backRef.current();
        }
    }).current;
    return (
        <PanGestureHandler activeOffsetX={[-9999, 16]} failOffsetY={[-14, 14]} onHandlerStateChange={handlerRef}>
            <View style={style} collapsable={false} {...rest}>{children}</View>
        </PanGestureHandler>
    );
}
