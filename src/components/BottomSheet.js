import React, { useRef, useState, useEffect } from 'react';
import { View, Animated, StyleSheet, Dimensions, Modal } from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';
import { useTheme } from '../context/ThemeContext';

const { height: SCREEN_H } = Dimensions.get('window');

// One shared height for every half-screen pop-up in the app (Queue, EQ,
// New EQ Preset, Import Settings, the playlist long-press menu) so they all
// feel like the same component family.
export const SHEET_HEIGHT = Math.round(SCREEN_H * (2 / 3));

// Swipe-down-to-close lives ONLY on the small handle strip at the top, not
// on the whole sheet, so it never has to arbitrate against scrollable
// content underneath (Queue's ScrollView, etc). The handle's gesture is
// bound straight onto `translateY` — the SAME Animated.Value the open/close
// effect below already drives — and animates ONLY `transform`. That's the
// direct fix for the crash that killed the old handle gesture
// ("expected onGestureHandlerEvent listener to be a function" from mixing
// a native-driven `transform` with a non-native `height` in one style
// object): this version never touches `height` or any other non-native
// property from the gesture path, so there's nothing to mix.
const CLOSE_COMMIT_DISTANCE = 70; // lower = easier to trigger = "less resistance"
const CLOSE_VELOCITY = 1.1;

export default function BottomSheet({ visible, onClose, header, children, height = SHEET_HEIGHT }) {
    const { base } = useTheme();
    const backdropOpacity = useRef(new Animated.Value(0)).current;
    const translateY = useRef(new Animated.Value(height)).current;
    const [mounted, setMounted] = useState(visible);
    const backdropStart = useRef({ x: 0, y: 0 });
    const onCloseRef = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; });

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

    const onHandleGestureEvent = useRef(
        Animated.event(
            [{ nativeEvent: { translationY: translateY } }],
            { useNativeDriver: true }
        )
    ).current;

    const onHandleStateChange = useRef((e) => {
        if (e.nativeEvent.oldState !== State.ACTIVE) return;
        const dy = e.nativeEvent.translationY;
        const vy = e.nativeEvent.velocityY;
        if (dy > CLOSE_COMMIT_DISTANCE || vy > CLOSE_VELOCITY * 1000) {
            // Same "fade the background, slide up/down the sheet" language as
            // the open/close effect and the Player modal's own swipe-to-
            // dismiss, just triggered from the drag instead of the visible
            // prop flipping first.
            Animated.parallel([
                Animated.timing(backdropOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
                Animated.timing(translateY, { toValue: height, duration: 200, useNativeDriver: true }),
            ]).start(() => { setMounted(false); onCloseRef.current?.(); });
            return;
        }
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 9, tension: 80 }).start();
    }).current;

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
                <PanGestureHandler
                    onGestureEvent={onHandleGestureEvent}
                    onHandlerStateChange={onHandleStateChange}
                    activeOffsetY={[-1000, 12]}
                    failOffsetX={[-20, 20]}
                >
                    <Animated.View style={s.handleZone}>
                        <View style={s.handleBar} />
                        {header}
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
    handleZone: { width: '100%', alignItems: 'center', paddingTop: 10, paddingBottom: 4 },
    handleBar: { width: 36, height: 4, borderRadius: 2, backgroundColor: '#333' },
});
