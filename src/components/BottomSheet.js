import React, { useRef, useState, useEffect } from 'react';
import { View, Animated, StyleSheet, Dimensions, Modal, PanResponder } from 'react-native';
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
// `expandable` sheets have three resting places: full screen, normal and closed. The sheet follows the finger
// continuously (up and down) and, on release, lands on one of them by distance and speed, so it feels like one
// object instead of jumping between states. It is always laid out full screen and slid down by (screen - normal
// height) while normal, so the movement stays on `transform` (native driver); the content padding that keeps the
// buttons above the visible edge is a separate, JS-driven value on its own wrapper view (never mixed into one style).
const EXPAND_COMMIT_DISTANCE = 50;
const EXPAND_VELOCITY = 0.9;

// For sheets whose content scrolls: the parent makes a guard, passes it as `guard`, and its scroll view reports
// `guard.current.atTop` (offset <= 2) and uses `contentDragging` for `scrollEnabled={!contentDragging}`. With that, a
// downward drag that starts on the content while the list is at the top moves the sheet (swipe away from anywhere,
// not only the handle); anywhere else the list scrolls as usual. `guard.current.isBlocked` can veto it (the queue
// uses that while a row is being picked up).
export function useSheetGuard() {
    const guard = useRef({ atTop: true, isBlocked: null, onContentDrag: null });
    const [contentDragging, setContentDragging] = useState(false);
    guard.current.onContentDrag = setContentDragging;
    return { guard, contentDragging };
}

// Sheets whose list pads itself (`selfPadded`) use this as the list's bottom padding: the sheet is laid out full
// screen and slid down while normal, so the last rows need that much room to be scrollable into view.
export const sheetBottomPad = (normalHeight = SHEET_HEIGHT) => Math.max(0, SCREEN_H - normalHeight);

// selfPadded: the content is NOT squeezed above the visible edge by a padding wrapper. Its list fills the whole
// sheet and pads its own end (sheetBottomPad), so while the sheet is dragged up the rows below the normal edge are
// already there instead of appearing only when the finger lifts.
export default function BottomSheet({ visible, onClose, header, children, height: normalHeight = SHEET_HEIGHT, expandable = false, footer = null, guard = null, selfPadded = false }) {
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
    api.current.setExpanded = (flag, velocity = 0) => {
        expandedRef.current = flag;
        Animated.parallel([
            Animated.spring(expandNative, { toValue: flag ? 0 : collapsedOffset, velocity, useNativeDriver: true, friction: 11, tension: 90 }),
            Animated.timing(contentPad, { toValue: flag ? 0 : collapsedOffset, duration: 260, useNativeDriver: false }),
            Animated.timing(topPad, { toValue: flag ? insets.top : 0, duration: 260, useNativeDriver: false }),
        ]).start();
    };
    api.current.expandable = expandable;
    // How far the finger has dragged the sheet from where it rests. Up is allowed only for expandable sheets
    // (limited to the full-screen position); for the others pulling up does nothing.
    const dragY = useRef(new Animated.Value(0)).current;
    const dragFree = useRef(dragY.interpolate(collapsedOffset > 0
        ? { inputRange: [-collapsedOffset, 0, 1000], outputRange: [-collapsedOffset, 0, 1000], extrapolate: 'clamp' }
        : { inputRange: [0, 1000], outputRange: [0, 1000], extrapolate: 'clamp' })).current;
    const offsetTotal = useRef(Animated.add(expandNative, dragFree).interpolate({ inputRange: [0, 4000], outputRange: [0, 4000], extrapolateLeft: 'clamp' })).current;
    const sheetY = useRef(Animated.add(translateY, offsetTotal)).current;
    // The pinned footer fades only when the sheet is on its way out (below its normal place), not while it grows.
    const belowNormal = useRef(Animated.add(offsetTotal, -collapsedOffset).interpolate({ inputRange: [0, 4000], outputRange: [0, 4000], extrapolateLeft: 'clamp' })).current;
    const footerOpacity = useRef(Animated.add(translateY, belowNormal).interpolate({ inputRange: [0, 140], outputRange: [1, 0], extrapolate: 'clamp' })).current;
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

    // One release routine for the handle and for a drag that started on the content. dy: pixels moved (down is
    // positive), vy: pixels per second.
    api.current.release = (dy, vy) => {
        const base0 = api.current.expandable && !expandedRef.current ? collapsedOffset : 0;
        const y = Math.max(0, base0 + dy);                  // where the sheet is right now (0 = full screen)
        // Hand the finger's position over to the resting value, so nothing jumps.
        expandNative.setValue(y);
        dragY.setValue(0);
        const closeIt = () => {
            Animated.parallel([
                Animated.timing(backdropOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
                Animated.timing(translateY, { toValue: height, duration: 200, useNativeDriver: true }),
            ]).start(() => { setMounted(false); onCloseRef.current?.(); });
        };
        const fromFull = api.current.expandable && expandedRef.current;
        if (api.current.expandable) {
            if (fromFull) {
                if (dy > collapsedOffset + CLOSE_COMMIT_DISTANCE || vy > CLOSE_VELOCITY * 2500) { closeIt(); return; }
                if (dy > CLOSE_COMMIT_DISTANCE || vy > CLOSE_VELOCITY * 1000) { api.current.setExpanded(false, vy / 1000); return; }
                api.current.setExpanded(true, vy / 1000);
                return;
            }
            if (dy < -EXPAND_COMMIT_DISTANCE || vy < -EXPAND_VELOCITY * 1000) { api.current.setExpanded(true, vy / 1000); return; }
            if (dy > CLOSE_COMMIT_DISTANCE || vy > CLOSE_VELOCITY * 1000) { closeIt(); return; }
            api.current.setExpanded(false, vy / 1000);
            return;
        }
        if (dy > CLOSE_COMMIT_DISTANCE || vy > CLOSE_VELOCITY * 1000) { closeIt(); return; }
        Animated.spring(expandNative, { toValue: 0, velocity: vy / 1000, useNativeDriver: true, friction: 9, tension: 80 }).start();
    };

    const onHandleGestureEvent = useRef(
        Animated.event(
            [{ nativeEvent: { translationY: dragY } }],
            { useNativeDriver: true }
        )
    ).current;

    const onHandleStateChange = useRef((e) => {
        if (e.nativeEvent.oldState !== State.ACTIVE) return;
        api.current.release(e.nativeEvent.translationY, e.nativeEvent.velocityY);
    }).current;

    // A downward drag that starts on the content while its list is at the top moves the sheet.
    const contentPan = useRef(PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponderCapture: (_e, g) => {
            const gd = guard?.current;
            if (!gd || !gd.atTop) return false;
            if (gd.isBlocked && gd.isBlocked()) return false;
            return g.dy > 8 && g.dy > Math.abs(g.dx) * 1.6;
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => { guard?.current?.onContentDrag?.(true); },
        onPanResponderMove: (_e, g) => { dragY.setValue(g.dy - 8); },
        onPanResponderRelease: (_e, g) => { guard?.current?.onContentDrag?.(false); api.current.release(g.dy - 8, g.vy * 1000); },
        onPanResponderTerminate: (_e, g) => { guard?.current?.onContentDrag?.(false); api.current.release(g.dy - 8, g.vy * 1000); },
    })).current;

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
                        activeOffsetY={expandable ? [-8, 8] : [-1000, 8]}
                        failOffsetX={[-20, 20]}
                    >
                        <Animated.View style={s.handleZone}>
                            <View style={[s.handleBar, { backgroundColor: base.border }]} />
                            <View style={s.headerZone}>{header}</View>
                        </Animated.View>
                    </PanGestureHandler>
                </Animated.View>
                <Animated.View style={{ flex: 1, paddingBottom: selfPadded ? 0 : contentPad }} {...(guard ? contentPan.panHandlers : {})}>
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
