import React, { useRef, useState, useEffect } from 'react';
import { View, Animated, StyleSheet, Dimensions, Modal } from 'react-native';
import { useTheme } from '../context/ThemeContext';

const { height: SCREEN_H } = Dimensions.get('window');

// One shared height for every half-screen pop-up in the app (Queue, EQ,
// New EQ Preset, Import Settings, the playlist long-press menu) so they all
// feel like the same component family.
export const SHEET_HEIGHT = Math.round(SCREEN_H * (2 / 3));

// Simplified on purpose: no more drag-to-expand/drag-to-close gesture on the
// handle. That PanGestureHandler was the source of a real, repeated crash
// ("expected onGestureHandlerEvent listener to be a function...") and wasn't
// worth the risk once the design settled on "every sheet is the same fixed
// height" — there's nothing left to expand TO. Open/close is now two plain,
// independent Animated transitions: the backdrop fades, the sheet slides up
// — matching the same "fade the background, slide up the sheet" language
// used for the playlist long-press menu.
export default function BottomSheet({ visible, onClose, children, height = SHEET_HEIGHT }) {
    const { base } = useTheme();
    const backdropOpacity = useRef(new Animated.Value(0)).current;
    const translateY = useRef(new Animated.Value(height)).current;
    const [mounted, setMounted] = useState(visible);
    const backdropStart = useRef({ x: 0, y: 0 });

    useEffect(() => {
        if (visible) {
            setMounted(true);
            translateY.setValue(height);
            backdropOpacity.setValue(0);
            Animated.parallel([
                Animated.timing(backdropOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
                Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 9, tension: 65 }),
            ]).start();
        } else if (mounted) {
            Animated.parallel([
                Animated.timing(backdropOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
                Animated.timing(translateY, { toValue: height, duration: 200, useNativeDriver: true }),
            ]).start(() => setMounted(false));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    if (!mounted) return null;

    return (
        <Modal visible transparent animationType="none" onRequestClose={onClose}>
            <Animated.View
                style={[s.overlay, { opacity: backdropOpacity }]}
                onStartShouldSetResponder={() => true}
                onResponderGrant={e => { backdropStart.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }; }}
                onResponderRelease={e => {
                    const dx = Math.abs(e.nativeEvent.pageX - backdropStart.current.x);
                    const dy = Math.abs(e.nativeEvent.pageY - backdropStart.current.y);
                    if (dx < 10 && dy < 10) onClose();
                }}
            />
            <Animated.View style={[s.sheet, { height, backgroundColor: base.surface, transform: [{ translateY }] }]}>
                <View style={{ flex: 1 }}>
                    {children}
                </View>
            </Animated.View>
        </Modal>
    );
}

const s = StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.65)' },
    sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#0f0f0f', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 20, paddingBottom: 34, overflow: 'hidden' },
});
