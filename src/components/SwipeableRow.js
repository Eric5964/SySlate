import React, { useRef, useEffect } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';
import { AddQueueIcon, TrashIcon } from './Icons';

const COMMIT_DISTANCE = 72;
const MAX_REVEAL = 108;

export default function SwipeableRow({
    children,
    onSwipeRight,
    onSwipeLeft,
    rightColor = '#7c3aed',
    leftColor = '#dc2626',
    disabled = false,
    // Matches the swiped row's own borderRadius so the color underneath
    // reads as part of the same shape, not a differently-rounded layer
    // behind it.
    radius = 12,
    // The row's own outer margin (every song row uses 14 / 2). The glow,
    // the swipe underlay and the Added badge are placed relative to the
    // visible pill, not the full-width wrapper, so the outline hugs it.
    insetX = 14,
    insetY = 2,
    // Excludes a strip at the left edge from this row's own pan gesture, so
    // a screen-level edge-swipe-back gesture (e.g. leaving a playlist) can
    // claim that zone instead of this row eating it as a queue-swipe. 0 by
    // default; PlaylistDetailScreen passes the same width as its navigator's
    // gestureResponseDistance.
    edgeExclude = 0,
}) {
    const translateX = useRef(new Animated.Value(0)).current;
    // Post-commit feedback — a soft accent-colored GLOW (border + shadow),
    // not a filled color flash. The flash-fill version read as harsh/didn't
    // land well, so this only ever animates `opacity` on a bordered overlay
    // (native-driver-safe, same pattern as the underlays below) rather than
    // introducing any new animated color/shadow properties.
    const rightGlow = useRef(new Animated.Value(0)).current;
    const leftGlow = useRef(new Animated.Value(0)).current;
    const addedTextOpacity = useRef(new Animated.Value(0)).current;
    const onSwipeRightRef = useRef(onSwipeRight);
    const onSwipeLeftRef = useRef(onSwipeLeft);
    useEffect(() => { onSwipeRightRef.current = onSwipeRight; onSwipeLeftRef.current = onSwipeLeft; });
    // Real bug found here: "with one swipe, [the row] showed several times"
    // (added to the queue more than once from what read as a single swipe).
    // onHandlerStateChange fires on EVERY state transition, guarded only by
    // "did we just leave ACTIVE" — RNGH can legitimately report ACTIVE more
    // than once for what feels like one continuous gesture (most often when
    // this pan is competing with the enclosing FlatList's own scroll
    // recognizer, which is exactly the context this fired in — a queue
    // list). Without a per-gesture latch, a second ACTIVE→END transition
    // re-fires onSwipeRightRef/onSwipeLeftRef a second time for the same
    // physical swipe. Latched below: fires once, then ignored until the
    // NEXT gesture actually begins.
    const hasFiredRef = useRef(false);

    const onGestureEvent = useRef(
        Animated.event(
            [{ nativeEvent: { translationX: translateX } }],
            { useNativeDriver: true }
        )
    ).current;

    const glowPulse = (val) => {
        val.setValue(0);
        Animated.sequence([
            Animated.timing(val, { toValue: 1, duration: 90, useNativeDriver: true }),
            Animated.timing(val, { toValue: 0, duration: 380, useNativeDriver: true }),
        ]).start();
    };

    const showAddedText = () => {
        addedTextOpacity.setValue(0);
        Animated.sequence([
            Animated.timing(addedTextOpacity, { toValue: 1, duration: 120, useNativeDriver: true }),
            Animated.delay(500),
            Animated.timing(addedTextOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
        ]).start();
    };

    const onHandlerStateChange = useRef((e) => {
        if (e.nativeEvent.state === State.BEGAN) {
            hasFiredRef.current = false;
            return;
        }
        if (e.nativeEvent.oldState !== State.ACTIVE) return;
        if (hasFiredRef.current) return;
        const dx = e.nativeEvent.translationX;
        if (dx > COMMIT_DISTANCE && onSwipeRightRef.current) {
            hasFiredRef.current = true;
            // Fire immediately, animate the row back with a quick spring
            // instead of teleporting it via setValue(0).
            onSwipeRightRef.current();
            glowPulse(rightGlow);
            showAddedText();
            Animated.spring(translateX, { toValue: 0, useNativeDriver: true, friction: 10, tension: 120 }).start();
            return;
        }
        if (dx < -COMMIT_DISTANCE && onSwipeLeftRef.current) {
            hasFiredRef.current = true;
            // Fires immediately now too (was waiting for the slide-off
            // animation to finish first, which made it feel slower to
            // respond than the add side). The actual list-removal round
            // trip through TrackPlayer + refresh() already takes longer
            // than this 130ms slide, so firing in parallel doesn't cut the
            // animation short in practice — the row unmounts only once the
            // real data update lands.
            glowPulse(leftGlow);
            onSwipeLeftRef.current();
            Animated.spring(translateX, { toValue: -400, useNativeDriver: true, friction: 9, tension: 100 }).start();
            return;
        }
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, friction: 9, tension: 80 }).start();
    }).current;

    // A small dead zone before ANY visible reaction (position OR underlay)
    // — natural touch jitter at the very start of a swipe (a few px in the
    // "wrong" direction before the real direction settles) was enough to
    // move the row and/or flash the other side's underlay. Both now derive
    // from ONE adjusted value instead of two separately-thresholded ones —
    // that mismatch (row already moving while the underlay was still hidden
    // behind its own threshold, then suddenly appearing) is what read as a
    // "bump" rather than a clean reveal.
    const REVEAL_DEADZONE = 10;
    const REVEAL_FULL = 30;
    const adjustedX = translateX.interpolate({
        inputRange: [-1000, -REVEAL_DEADZONE, REVEAL_DEADZONE, 1000],
        outputRange: [-1000 + REVEAL_DEADZONE, 0, 0, 1000 - REVEAL_DEADZONE],
    });

    // Clamp/rubber-band via interpolation (native thread).
    const displayX = adjustedX.interpolate({
        inputRange: [-300, -MAX_REVEAL, 0, MAX_REVEAL, 300],
        outputRange: [
            onSwipeLeft ? -MAX_REVEAL - 40 : 0,
            onSwipeLeft ? -MAX_REVEAL : 0,
            0,
            onSwipeRight ? MAX_REVEAL : 0,
            onSwipeRight ? MAX_REVEAL + 40 : 0,
        ],
        extrapolate: 'clamp',
    });

    // Both underlays are always mounted, with opacity interpolated DIRECTLY
    // from adjustedX (native thread) instead of a JS state variable set
    // from the gesture listener. The JS-state version lagged a frame or two
    // behind the actual native position, which is what showed the wrong
    // side's color for a moment when reversing direction mid-swipe.
    const rightOpacity = adjustedX.interpolate({ inputRange: [0, REVEAL_FULL - REVEAL_DEADZONE], outputRange: [0, 1], extrapolate: 'clamp' });
    const leftOpacity = adjustedX.interpolate({ inputRange: [-(REVEAL_FULL - REVEAL_DEADZONE), 0], outputRange: [1, 0], extrapolate: 'clamp' });
    const rightGlowOpacity = rightGlow.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });
    const leftGlowOpacity = leftGlow.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

    // Previously a narrow fixed-width strip (MAX_REVEAL wide) sitting off to
    // the side with its own rounded corners — it read as a separate floating
    // pill next to the row rather than a background the row was sliding off
    // of. This instead spans the row's own full footprint (same size,
    // matching radius via the `radius` prop) and sits directly underneath
    // it — the row sliding away (its existing displayX transform, unchanged)
    // is what reveals it, the same way Gmail/Mail's swipe actions work.
    // Nothing about the underlay itself needs to grow or scale anymore;
    // there's no separate fill layer, no transform-origin math — just a
    // solid color the row slides off of. The icon/text still fade in via
    // the opacity interpolations above so they don't pop in instantly.
    // Outline sits just outside the pill (2px), same corner shape plus
    // the 2px, so it reads as a thin ring around it with no empty walls.
    const GLOW_OUT = 2;
    const glowBox = {
        left: insetX - GLOW_OUT, right: insetX - GLOW_OUT,
        top: insetY - GLOW_OUT, bottom: insetY - GLOW_OUT,
        borderRadius: radius + GLOW_OUT,
    };
    return (
        <View style={styles.wrap}>
            {onSwipeRight && (
                <Animated.View style={[styles.underlay, { left: insetX, right: insetX, top: insetY, bottom: insetY, backgroundColor: rightColor, borderRadius: radius, opacity: rightOpacity }]}>
                    <View style={[styles.underlayContent, styles.underlayContentLeft]}>
                        <AddQueueIcon size={15} color="#fff" />
                        <Text style={styles.underlayText}>Next</Text>
                    </View>
                </Animated.View>
            )}
            {onSwipeLeft && (
                <Animated.View style={[styles.underlay, { left: insetX, right: insetX, top: insetY, bottom: insetY, backgroundColor: leftColor, borderRadius: radius, opacity: leftOpacity }]}>
                    <View style={[styles.underlayContent, styles.underlayContentRight]}>
                        <Text style={styles.underlayText}>Remove</Text>
                        <TrashIcon size={15} color="#fff" />
                    </View>
                </Animated.View>
            )}
            <PanGestureHandler
                enabled={!disabled && (!!onSwipeRight || !!onSwipeLeft)}
                onGestureEvent={onGestureEvent}
                onHandlerStateChange={onHandlerStateChange}
                activeOffsetX={[-10, 10]}
                failOffsetY={[-15, 15]}
                hitSlop={edgeExclude ? { left: -edgeExclude } : undefined}
            >
                <Animated.View style={{ transform: [{ translateX: displayX }] }}>
                    {children}
                    {onSwipeRight && (
                        <Animated.View pointerEvents="none" style={[styles.glow, glowBox, { borderColor: rightColor, shadowColor: rightColor, opacity: rightGlowOpacity }]} />
                    )}
                    {onSwipeLeft && (
                        <Animated.View pointerEvents="none" style={[styles.glow, glowBox, { borderColor: leftColor, shadowColor: leftColor, opacity: leftGlowOpacity }]} />
                    )}
                    {onSwipeRight && (
                        <Animated.View pointerEvents="none" style={[styles.addedBadgeZone, { right: 80 + insetX - 14, opacity: addedTextOpacity }]}>
                            <View style={[styles.addedBadge, { backgroundColor: rightColor }]}>
                                <Text style={styles.addedText}>Added</Text>
                            </View>
                        </Animated.View>
                    )}
                </Animated.View>
            </PanGestureHandler>
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { position: 'relative' },
    underlay: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'center',
    },
    underlayContent: {
        ...StyleSheet.absoluteFillObject,
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: 20, gap: 6,
    },
    underlayContentLeft: { justifyContent: 'flex-start' },
    underlayContentRight: { justifyContent: 'flex-end' },
    underlayText: { color: '#fff', fontSize: 12, fontWeight: '700' },
    // Static border + shadow — only `opacity` is ever animated (native-driver
    // safe), same principle as the underlay opacity interpolations above.
    glow: {
        position: 'absolute',
        borderWidth: 1.5,
        shadowOffset: { width: 0, height: 0 },
        shadowRadius: 5,
        shadowOpacity: 0.55,
    },
    // Was right:56 — sat close enough to the row's own trailing play-count
    // text (see AllSongsScreen/PlaylistDetailScreen's playCount style) that
    // the two could visually collide. Pushed further left for clearance.
    addedBadgeZone: {
        position: 'absolute', top: 0, bottom: 0, right: 80,
        justifyContent: 'center', alignItems: 'flex-end',
    },
    addedBadge: {
        paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8,
    },
    addedText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
