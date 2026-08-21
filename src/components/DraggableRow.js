import React, { useRef } from 'react';
import { Animated } from 'react-native';
import { LongPressGestureHandler, PanGestureHandler, State as GHState } from 'react-native-gesture-handler';

// Long-press-then-drag reordering, composed the same way the progress bar's
// tap+pan combo is (see PlayerScreen) — a LongPressGestureHandler gates
// activation (500ms, matching a standard "reorder mode" hold), a
// PanGestureHandler tracks the actual movement once it's active, and the two
// are marked simultaneousHandlers of each other so RNGH doesn't force one to
// fail before the other can even try. Whatever's inside (a TouchableOpacity
// for tap-to-play/jump, a SwipeableRow for swipe actions) keeps working
// underneath this the same way it already does underneath SwipeableRow's own
// PanGestureHandler — this follows that same proven pattern rather than a
// new one. Shared between QueueModal (Up Next / Priority reordering) and
// PlaylistDetailScreen (playlist song reordering) so both use identical,
// already-exercised gesture logic instead of two separate copies drifting
// apart over time.
export default function DraggableRow({ dragKey, disabled, onDragStart, onDragMove, onDragEnd, children }) {
    const longPressRef = useRef(null);
    const panRef = useRef(null);
    const activeRef = useRef(false);

    const onLongPressStateChange = (e) => {
        const { state } = e.nativeEvent;
        if (state === GHState.ACTIVE) {
            activeRef.current = true;
            onDragStart(dragKey);
        } else if ((state === GHState.END || state === GHState.CANCELLED || state === GHState.FAILED) && activeRef.current) {
            activeRef.current = false;
            onDragEnd();
        }
    };
    const onPanEvent = (e) => {
        if (!activeRef.current) return;
        onDragMove(e.nativeEvent.translationY, e.nativeEvent.absoluteY);
    };
    const onPanStateChange = (e) => {
        if (!activeRef.current) return;
        const { state } = e.nativeEvent;
        if (state === GHState.END || state === GHState.CANCELLED || state === GHState.FAILED) {
            activeRef.current = false;
            onDragEnd();
        }
    };

    return (
        <LongPressGestureHandler
            ref={longPressRef}
            enabled={!disabled}
            minDurationMs={500}
            maxDist={999999}
            simultaneousHandlers={panRef}
            onHandlerStateChange={onLongPressStateChange}
        >
            <Animated.View>
                <PanGestureHandler
                    ref={panRef}
                    enabled={!disabled}
                    simultaneousHandlers={longPressRef}
                    onGestureEvent={onPanEvent}
                    onHandlerStateChange={onPanStateChange}
                >
                    <Animated.View>
                        {children}
                    </Animated.View>
                </PanGestureHandler>
            </Animated.View>
        </LongPressGestureHandler>
    );
}
