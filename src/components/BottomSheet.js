import React, { useRef, useState, useEffect } from 'react';
import { View, Animated, PanResponder, StyleSheet, Dimensions, Modal } from 'react-native';

const { height: SCREEN_H } = Dimensions.get('window');

// Shared bottom-sheet used by QueueModal and EQModal. Two things this exists
// to fix, on top of just "a sheet":
// 1. The backdrop dismiss uses a strict small-movement tap check instead of
//    TouchableOpacity — a plain Touchable can fire onPress after a drag that
//    moved through it, which was letting a swipe-down gesture that started
//    inside the sheet "pass through" into whatever was behind it once the
//    sheet closed mid-gesture.
// 2. The handle has its own swipe-down-to-close / swipe-up-to-expand gesture,
//    fully contained here, so it never depends on (or interferes with) the
//    screen underneath.
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

    const pan = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => false,
            onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dy) > 8 && Math.abs(gs.dy) > Math.abs(gs.dx) * 1.3,
            onPanResponderMove: (_, gs) => {
                if (gs.dy > 0) translateY.setValue(gs.dy);
                else if (expanded) translateY.setValue(gs.dy * 0.25); // small rubber-band, already at max
            },
            onPanResponderRelease: (_, gs) => {
                if (gs.dy > 70 || gs.vy > 1.1) { closeNow(); return; }
                if (gs.dy < -50 && !expanded) {
                    Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 8 }).start();
                    expand();
                    return;
                }
                Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 8 }).start();
            },
            onPanResponderTerminate: () => {
                Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 8 }).start();
            },
        })
    ).current;

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
                <View {...pan.panHandlers} style={s.handleArea}>
                    <View style={s.handle} />
                </View>
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
