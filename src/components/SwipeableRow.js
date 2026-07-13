import React, { useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';
import { AddQueueIcon, TrashIcon } from './Icons';

const COMMIT_DISTANCE = 72;
const MAX_REVEAL = 96;

// Rebuilt on react-native-gesture-handler instead of PanResponder — gesture
// recognition (including negotiating with a parent ScrollView/FlatList over
// who "owns" the touch) happens off the JS thread, which is what PanResponder
// couldn't do and was the source of swipes feeling laggy/unreliable,
// especially inside the queue's scroll view.
export default function SwipeableRow({
    children,
    onSwipeRight,
    onSwipeLeft,
    rightColor = '#7c3aed',
    leftColor = '#dc2626',
    disabled = false,
}) {
    const translateX = useRef(new Animated.Value(0)).current;
    const [revealSide, setRevealSide] = useState(null);

    const onGestureEvent = Animated.event(
        [{ nativeEvent: { translationX: translateX } }],
        {
            useNativeDriver: true,
            listener: (e) => {
                const dx = e.nativeEvent.translationX;
                setRevealSide(dx > 4 ? 'right' : dx < -4 ? 'left' : null);
            },
        }
    );

    const onHandlerStateChange = (e) => {
        if (e.nativeEvent.oldState !== State.ACTIVE) return;
        const dx = e.nativeEvent.translationX;
        if (dx > COMMIT_DISTANCE && onSwipeRight) {
            Animated.timing(translateX, { toValue: 0, duration: 180, useNativeDriver: true }).start();
            setRevealSide(null);
            onSwipeRight();
            return;
        }
        if (dx < -COMMIT_DISTANCE && onSwipeLeft) {
            Animated.timing(translateX, { toValue: -400, duration: 180, useNativeDriver: true }).start(() => {
                onSwipeLeft();
            });
            return;
        }
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, friction: 8, tension: 60 }).start(() => setRevealSide(null));
    };

    // Clamp/rubber-band entirely via interpolation (stays on the native
    // thread), and zero out whichever direction has no handler.
    const displayX = translateX.interpolate({
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

    return (
        <View style={styles.wrap}>
            {revealSide === 'right' && onSwipeRight && (
                <View style={[styles.underlay, styles.underlayLeft, { backgroundColor: rightColor }]}>
                    <AddQueueIcon size={18} color="#fff" />
                    <Text style={styles.underlayText}>Play Next</Text>
                </View>
            )}
            {revealSide === 'left' && onSwipeLeft && (
                <View style={[styles.underlay, styles.underlayRight, { backgroundColor: leftColor }]}>
                    <Text style={styles.underlayText}>Remove</Text>
                    <TrashIcon size={18} color="#fff" />
                </View>
            )}
            <PanGestureHandler
                enabled={!disabled && (!!onSwipeRight || !!onSwipeLeft)}
                onGestureEvent={onGestureEvent}
                onHandlerStateChange={onHandlerStateChange}
                activeOffsetX={[-10, 10]}
                failOffsetY={[-15, 15]}
            >
                <Animated.View style={{ transform: [{ translateX: displayX }] }}>
                    {children}
                </Animated.View>
            </PanGestureHandler>
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
