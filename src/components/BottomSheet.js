import React, { useRef, useState, useEffect } from 'react';
import { View, Animated, StyleSheet, Dimensions, Modal } from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';

const { height: SCREEN_H } = Dimensions.get('window');

// IMPORTANT: translateY (native-driven, via the gesture handler) and
// heightAnim (JS-driven, since 'height' can't be natively animated) must
// live on TWO SEPARATE Animated.Views, not combined into one style object —
// mixing a native-driven and non-native-driven Animated.Value in the same
// style is what was throwing "Style property 'height' is not supported by
// native animated module" and crashing the queue/EQ sheet on open.
export default function BottomSheet({ visible, onClose, children, collapsedHeight = 460, expandedHeight = SCREEN_H * 0.88 }) {
    const heightAnim = useRef(new Animated.Value(collapsedHeight)).current;
    const translateY = useRef(new Animated.Value(0)).current;
    const [expanded, setExpanded] = useState(false);
    const backdropStart = useRef({ x: 0, y: 0 });

    useEffect(() => {
        if (visible) {
            setExpanded(false);
            heightAnim.setValue(collapsedHeight);
            translateY.setValue(0);
        }
    }, [visible]);

    const expand = () => {
        setExpanded(true);
        Animated.spring(heightAnim, { toValue: expandedHeight, useNativeDriver: false, friction: 9 }).start();
    };

    const closeNow = () => {
        Animated.timing(translateY, { toValue: SCREEN_H, duration: 200, useNativeDriver: true }).start(() => onClose());
    };

    const onGestureEvent = Animated.event(
        [{ nativeEvent: { translationY: translateY } }],
        { useNativeDriver: true }
    );

    const onHandlerStateChange = (e) => {
        if (e.nativeEvent.oldState !== State.ACTIVE) return;
        const { translationY, velocityY } = e.nativeEvent;
        if (translationY > 70 || velocityY > 800) { closeNow(); return; }
        if (translationY < -50 && !expanded) {
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 8 }).start();
            expand();
            return;
        }
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 8 }).start();
    };

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
            <View
                style={s.overlay}
                onStartShouldSetResponder={() => true}
                onResponderGrant={e => { backdropStart.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }; }}
                onResponderRelease={e => {
                    const dx = Math.abs(e.nativeEvent.pageX - backdropStart.current.x);
                    const dy = Math.abs(e.nativeEvent.pageY - backdropStart.current.y);
                    if (dx < 10 && dy < 10) onClose();
                }}
            />
            {/* Outer: position + native-driven translateY only */}
            <Animated.View style={[s.sheetOuter, { transform: [{ translateY }] }]}>
                {/* Inner: JS-driven height only */}
                <Animated.View style={[s.sheet, { height: heightAnim }]}>
                    <PanGestureHandler
                        onGestureEvent={onGestureEvent}
                        onHandlerStateChange={onHandlerStateChange}
                        activeOffsetY={[-10, 10]}
                        failOffsetX={[-15, 15]}
                    >
                        <View style={s.handleArea}>
                            <View style={s.handle} />
                        </View>
                    </PanGestureHandler>
                    <View style={{ flex: 1 }}>
                        {children}
                    </View>
                </Animated.View>
            </Animated.View>
        </Modal>
    );
}

const s = StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.65)' },
    sheetOuter: { position: 'absolute', left: 0, right: 0, bottom: 0 },
    sheet: { backgroundColor: '#0f0f0f', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 34, overflow: 'hidden' },
    handleArea: { paddingVertical: 14, alignItems: 'center' },
    handle: { width: 36, height: 4, backgroundColor: '#222', borderRadius: 2 },
});
