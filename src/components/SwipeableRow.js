import React, { useRef, useState } from 'react';
import { View, Animated, PanResponder, StyleSheet, Text } from 'react-native';
import { AddQueueIcon, TrashIcon } from './Icons';

// Generous leeway so browsing/scrolling never accidentally triggers an action:
// - gesture must be clearly more horizontal than vertical to even start
// - must clear COMMIT_DISTANCE before release counts as an action
// - otherwise it always springs back with no effect
const START_THRESHOLD = 10;
const COMMIT_DISTANCE = 72;
const MAX_REVEAL = 96;

export default function SwipeableRow({
    children,
    onSwipeRight,   // e.g. add to queue
    onSwipeLeft,    // e.g. remove from queue
    rightColor = '#7c3aed',
    leftColor = '#dc2626',
    disabled = false,
}) {
    const translateX = useRef(new Animated.Value(0)).current;
    const [revealSide, setRevealSide] = useState(null); // 'left' | 'right' | null

    const pan = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => false,
            onMoveShouldSetPanResponder: (_, gs) => {
                if (disabled) return false;
                if (!onSwipeRight && !onSwipeLeft) return false;
                return Math.abs(gs.dx) > START_THRESHOLD && Math.abs(gs.dx) > Math.abs(gs.dy) * 1.6;
            },
            onPanResponderGrant: () => {
                translateX.setOffset(translateX._value);
                translateX.setValue(0);
            },
            onPanResponderMove: (_, gs) => {
                let dx = gs.dx;
                if (dx > 0 && !onSwipeRight) dx = 0;
                if (dx < 0 && !onSwipeLeft) dx = 0;
                // rubber-band past the max reveal so it never flies off unbounded
                if (dx > MAX_REVEAL) dx = MAX_REVEAL + (dx - MAX_REVEAL) * 0.25;
                if (dx < -MAX_REVEAL) dx = -MAX_REVEAL + (dx + MAX_REVEAL) * 0.25;
                setRevealSide(dx > 4 ? 'right' : dx < -4 ? 'left' : null);
                translateX.setValue(dx);
            },
            onPanResponderRelease: (_, gs) => {
                translateX.flattenOffset();
                const dx = gs.dx;
                if (dx > COMMIT_DISTANCE && onSwipeRight) {
                    Animated.timing(translateX, { toValue: 0, duration: 180, useNativeDriver: true }).start();
                    setRevealSide(null);
                    onSwipeRight();
                    return;
                }
                if (dx < -COMMIT_DISTANCE && onSwipeLeft) {
                    // slide fully off then let caller remove it from the underlying list
                    Animated.timing(translateX, { toValue: -400, duration: 180, useNativeDriver: true }).start(() => {
                        onSwipeLeft();
                    });
                    return;
                }
                Animated.spring(translateX, { toValue: 0, useNativeDriver: true, friction: 8, tension: 60 }).start(() => setRevealSide(null));
            },
            onPanResponderTerminate: () => {
                translateX.flattenOffset();
                Animated.spring(translateX, { toValue: 0, useNativeDriver: true, friction: 8, tension: 60 }).start(() => setRevealSide(null));
            },
        })
    ).current;

    return (
        <View style={styles.wrap}>
            {revealSide === 'right' && (
                <View style={[styles.underlay, styles.underlayLeft, { backgroundColor: rightColor }]}>
                    <AddQueueIcon size={18} color="#fff" />
                    <Text style={styles.underlayText}>Play Next</Text>
                </View>
            )}
            {revealSide === 'left' && (
                <View style={[styles.underlay, styles.underlayRight, { backgroundColor: leftColor }]}>
                    <Text style={styles.underlayText}>Remove</Text>
                    <TrashIcon size={18} color="#fff" />
                </View>
            )}
            <Animated.View style={{ transform: [{ translateX }] }} {...pan.panHandlers}>
                {children}
            </Animated.View>
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { position: 'relative' },
    underlay: {
        position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
        flexDirection: 'row', alignItems: 'center', borderRadius: 12,
        paddingHorizontal: 20, gap: 8,
    },
    underlayLeft: { justifyContent: 'flex-start' },
    underlayRight: { justifyContent: 'flex-end' },
    underlayText: { color: '#fff', fontSize: 13, fontWeight: '700' },
});