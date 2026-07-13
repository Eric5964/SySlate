import React, { useRef, useState, useEffect } from 'react';
import { View, Animated, StyleSheet, Dimensions, Modal } from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';

const { height: SCREEN_H } = Dimensions.get('window');

// Rebuilt on react-native-gesture-handler (see SwipeableRow for why) — the
// handle's drag now runs on the native thread, which is what was needed for
// this to feel smooth, especially since it can overlap with scrolling on
// the content underneath it.
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
            <Animated.View style={[s.sheet, { height: heightAnim, transform: [{ translateY }] }]}>
                <PanGestureHandler
                    onGestureEvent={onGestureEvent}
                    onHandlerStateChange={onHandlerStateChange}
                    activeOffsetY={[-10, 10]}
                    failOffsetX={[-15, 15]}
                >
                    <Animated.View style={s.handleArea}>
                        <View style={s.handle} />
                    </Animated.View>
                </PanGestureHandler>
                <View style={{ flex: 1 }}>
                    {children}
                </View>
            </Animated.View>
        </Modal>
    );
}

const s = StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.65)' },
    sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#0f0f0f', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 34, overflow: 'hidden' },
    handleArea: { paddingVertical: 14, alignItems: 'center' },
    handle: { width: 36, height: 4, backgroundColor: '#222', borderRadius: 2 },
});
