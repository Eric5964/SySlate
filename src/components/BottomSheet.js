import React, { useRef, useState, useEffect } from 'react';
import { View, Animated, StyleSheet, Dimensions, Modal } from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';

const { height: SCREEN_H } = Dimensions.get('window');

// IMPORTANT: onGestureEvent/onHandlerStateChange must be referentially STABLE
// across re-renders (created once via useRef, not recreated every render) —
// this component re-renders mid-interaction (expand() flips state right as a
// gesture ends), and handing gesture-handler a brand new event-handler
// reference while it's reconciling was throwing "expected
// 'onGestureHandlerEvent' listener to be a function, instead got a value of
// 'object' type" and crashing on swipe-up-to-expand.
export default function BottomSheet({ visible, onClose, children, collapsedHeight = 460, expandedHeight = SCREEN_H * 0.88 }) {
    const heightAnim = useRef(new Animated.Value(collapsedHeight)).current;
    const translateY = useRef(new Animated.Value(0)).current;
    const [expanded, setExpanded] = useState(false);
    const expandedRef = useRef(false);
    const backdropStart = useRef({ x: 0, y: 0 });

    useEffect(() => {
        if (visible) {
            setExpanded(false);
            expandedRef.current = false;
            heightAnim.setValue(collapsedHeight);
            translateY.setValue(0);
        }
    }, [visible]);

    const expand = () => {
        setExpanded(true);
        expandedRef.current = true;
        Animated.spring(heightAnim, { toValue: expandedHeight, useNativeDriver: false, friction: 9 }).start();
    };

    const closeNow = () => {
        Animated.timing(translateY, { toValue: SCREEN_H, duration: 200, useNativeDriver: true }).start(() => onClose());
    };

    const onGestureEvent = useRef(
        Animated.event(
            [{ nativeEvent: { translationY: translateY } }],
            { useNativeDriver: true }
        )
    ).current;

    const onHandlerStateChange = useRef((e) => {
        if (e.nativeEvent.oldState !== State.ACTIVE) return;
        const { translationY, velocityY } = e.nativeEvent;
        if (translationY > 70 || velocityY > 800) { closeNow(); return; }
        if (translationY < -50 && !expandedRef.current) {
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 8 }).start();
            expand();
            return;
        }
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 8 }).start();
    }).current;

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
            <Animated.View style={[s.sheetOuter, { transform: [{ translateY }] }]}>
                <Animated.View style={[s.sheet, { height: heightAnim }]}>
                    <PanGestureHandler
                        onGestureEvent={onGestureEvent}
                        onHandlerStateChange={onHandlerStateChange}
                        activeOffsetY={[-10, 10]}
                        failOffsetX={[-15, 15]}
                    >
                        <View style={s.handleArea} />
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
    handleArea: { height: 22 },
});
