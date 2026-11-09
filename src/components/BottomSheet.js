import React, { useRef, useState, useEffect } from 'react';
import { View, Animated, StyleSheet, Dimensions, Modal } from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
// `expandable` sheets: swiping UP on the handle makes the sheet full screen, swiping DOWN on a full
// screen sheet brings it back to normal size, and swiping down again closes it. The sheet is always
// laid out full screen and slid down by (screen - normal height) while normal, so the whole
// animation stays on `transform` (native driver); the content padding that keeps the buttons above the
// visible edge is a separate, JS-driven value on its own wrapper view (never mixed into one style).
const EXPAND_COMMIT_DISTANCE = 50;
const EXPAND_VELOCITY = 0.9;

export default function BottomSheet({ visible, onClose, header, children, height: normalHeight = SHEET_HEIGHT, expandable = false, footer = null }) {
    const { base } = useTheme();
    const insets = useSafeAreaInsets();
    const height = expandable ? SCREEN_H : normalHeight;            // laid-out height
    const collapsedOffset = expandable ? Math.max(0, SCREEN_H - normalHeight) : 0;
    const backdropOpacity = useRef(new Animated.Value(0)).current;
    const translateY = useRef(new Animated.Value(height)).current;
    const expandNative = useRef(new Animated.Value(collapsedOffset)).current;   // transform
    const contentPad = useRef(new Animated.Value(collapsedOffset)).current;     // JS driven
    const topPad = useRef(new Animated.Value(0)).current;                       // JS driven
    const expandedRef = useRef(false);
    const [footerH, setFooterH] = useState(0);
    const api = useRef({});
    api.current.setExpanded = (flag) => {
        expandedRef.current = flag;
        Animated.parallel([
            Animated.timing(expandNative, { toValue: flag ? 0 : collapsedOffset, duration: 260, useNativeDriver: true }),
            Animated.timing(contentPad, { toValue: flag ? 0 : collapsedOffset, duration: 260, useNativeDriver: false }),
            Animated.timing(topPad, { toValue: flag ? insets.top : 0, duration: 260, useNativeDriver: false }),
        ]).start();
    };
    api.current.expandable = expandable;
    // How far the finger has pulled the sheet down. Pulling up does nothing (the
    // sheet used to lift off its bottom edge when dragged upward).
    const dragY = useRef(new Animated.Value(0)).current;
    const dragDown = dragY.interpolate({ inputRange: [0, 1000], outputRange: [0, 1000], extrapolate: 'clamp' });
    const sheetY = useRef(Animated.add(Animated.add(translateY, dragDown), expandNative)).current;
    const footerOpacity = useRef(Animated.add(translateY, dragDown).interpolate({ inputRange: [0, 140], outputRange: [1, 0], extrapolate: 'clamp' })).current;
    const [mounted, setMounted] = useState(visible);
    const backdropStart = useRef({ x: 0, y: 0 });
    const onCloseRef = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; });

    useEffect(() => {
        if (visible) {
            setMounted(true);
            translateY.setValue(height);
            dragY.setValue(0);
            expandedRef.current = false;
            expandNative.setValue(collapsedOffset);
            contentPad.setValue(collapsedOffset);
            topPad.setValue(0);
            backdropOpacity.setValue(0);
            Animated.parallel([
                Animated.timing(backdropOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
                Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 9, tension: 65 }),
            ]).start();
        } else if (mounted) {
            Animated.parallel([
                Animated.timing(backdropOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
                Animated.timing(translateY, { toValue: height, duration: 200, useNativeDriver: true }),
            // `finished` matters: closing then reopening quickly interrupts this animation, and its
            // callback used to unmount the sheet that was just being shown again.
            ]).start(({ finished }) => { if (finished) setMounted(false); });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    const onHandleGestureEvent = useRef(
        Animated.event(
            [{ nativeEvent: { translationY: dragY } }],
            { useNativeDriver: true }
        )
    ).current;

    const onHandleStateChange = useRef((e) => {
        if (e.nativeEvent.oldState !== State.ACTIVE) return;
        const dy = e.nativeEvent.translationY;
        const vy = e.nativeEvent.velocityY;
        if (api.current.expandable) {
            if ((dy < -EXPAND_COMMIT_DISTANCE || vy < -EXPAND_VELOCITY * 1000) && !expandedRef.current) {
                api.current.setExpanded(true);
                Animated.spring(dragY, { toValue: 0, useNativeDriver: true, friction: 9, tension: 80 }).start();
                return;
            }
            if ((dy > CLOSE_COMMIT_DISTANCE || vy > CLOSE_VELOCITY * 1000) && expandedRef.current) {
                api.current.setExpanded(false);   // back to normal size; another swipe down closes
                Animated.spring(dragY, { toValue: 0, useNativeDriver: true, friction: 9, tension: 80 }).start();
                return;
            }
        }
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
        Animated.spring(dragY, { toValue: 0, useNativeDriver: true, friction: 9, tension: 80 }).start();
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
            <Animated.View style={[s.sheet, { height, paddingBottom: footer ? 0 : 34, backgroundColor: base.surface, transform: [{ translateY: sheetY }] }]}>
                <Animated.View style={{ paddingTop: topPad }}>
                    <PanGestureHandler
                        onGestureEvent={onHandleGestureEvent}
                        onHandlerStateChange={onHandleStateChange}
                        activeOffsetY={expandable ? [-12, 12] : [-1000, 12]}
                        failOffsetX={[-20, 20]}
                    >
                        <Animated.View style={s.handleZone}>
                            <View style={[s.handleBar, { backgroundColor: base.border }]} />
                            <View style={s.headerZone}>{header}</View>
                        </Animated.View>
                    </PanGestureHandler>
                </Animated.View>
                <Animated.View style={{ flex: 1, paddingBottom: contentPad }}>
                    <View style={{ flex: 1, paddingBottom: footer ? footerH : 0 }}>
                        {children}
                    </View>
                </Animated.View>
            </Animated.View>
            {footer ? (
                // Pinned to the bottom of the SCREEN, not part of the moving sheet: it stays put while the
                // sheet is dragged or expanded and only fades as the sheet leaves (or arrives).
                <Animated.View
                    onLayout={(e) => setFooterH(e.nativeEvent.layout.height)}
                    style={[s.footer, { backgroundColor: base.surface, borderTopColor: base.border, paddingBottom: Math.max(insets.bottom, 12) + 6, opacity: footerOpacity }]}
                >
                    {footer}
                </Animated.View>
            ) : null}
        </Modal>
    );
}

const s = StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.65)' },
    sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#0f0f0f', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 34, overflow: 'hidden' },
    handleZone: { width: '100%', alignItems: 'center', paddingTop: 12, paddingBottom: 14, gap: 8 },
    headerZone: { width: '100%', alignItems: 'flex-start' },
    footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
    handleBar: { width: 36, height: 4, borderRadius: 2, backgroundColor: '#333' },
});
