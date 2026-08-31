import React from 'react';
import { View, Animated, Text } from 'react-native';

// Pure-CSS/View icons — no emoji, no SVG library dependency.
// Sizes are the visual bounding box; colors passed as `color`.

export function PlayIcon({ size = 22, color = '#fff', style }) {
    return (
        <View style={[{
            width: 0, height: 0,
            borderTopWidth: size * 0.5,
            borderBottomWidth: size * 0.5,
            borderLeftWidth: size * 0.82,
            borderTopColor: 'transparent',
            borderBottomColor: 'transparent',
            borderLeftColor: color,
            marginLeft: size * 0.14,
        }, style]} />
    );
}

export function PauseIcon({ size = 22, color = '#fff', style }) {
    const barW = Math.round(size * 0.28);
    const gap = Math.round(size * 0.18);
    return (
        <View style={[{ flexDirection: 'row', width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}>
            <View style={{ width: barW, height: size * 0.86, borderRadius: 2, backgroundColor: color, marginRight: gap }} />
            <View style={{ width: barW, height: size * 0.86, borderRadius: 2, backgroundColor: color }} />
        </View>
    );
}

export function SkipNextIcon({ size = 26, color = '#ccc', style }) {
    return (
        <View style={[{ flexDirection: 'row', alignItems: 'center', width: size, height: size, justifyContent: 'center' }, style]}>
            <View style={{
                width: 0, height: 0,
                borderTopWidth: size * 0.32,
                borderBottomWidth: size * 0.32,
                borderLeftWidth: size * 0.5,
                borderTopColor: 'transparent',
                borderBottomColor: 'transparent',
                borderLeftColor: color,
            }} />
            <View style={{ width: size * 0.09, height: size * 0.64, backgroundColor: color, borderRadius: 1, marginLeft: size * 0.06 }} />
        </View>
    );
}

export function SkipPrevIcon({ size = 26, color = '#ccc', style }) {
    return (
        <View style={[{ flexDirection: 'row', alignItems: 'center', width: size, height: size, justifyContent: 'center' }, style]}>
            <View style={{ width: size * 0.09, height: size * 0.64, backgroundColor: color, borderRadius: 1, marginRight: size * 0.06 }} />
            <View style={{
                width: 0, height: 0,
                borderTopWidth: size * 0.32,
                borderBottomWidth: size * 0.32,
                borderRightWidth: size * 0.5,
                borderTopColor: 'transparent',
                borderBottomColor: 'transparent',
                borderRightColor: color,
            }} />
        </View>
    );
}

export function ShuffleIcon({ size = 22, color = '#333', style }) {
    // Two crossing lines, each with a small arrowhead at one end — a plain
    // "X" (no arrowheads) reads as a close/cancel button, not shuffle.
    // `color` may be a plain string or an Animated interpolation (the
    // on/off fade), so every colored piece below is an Animated.View.
    const bar = size * 0.78;
    const arrow = size * 0.22;
    const Strand = ({ rotate }) => (
        <View style={{
            position: 'absolute', width: bar, height: arrow,
            alignItems: 'flex-end', justifyContent: 'center',
            transform: [{ rotate }],
        }}>
            <Animated.View style={{ position: 'absolute', left: 0, right: arrow * 0.5, height: 2, backgroundColor: color, borderRadius: 1 }} />
            <Animated.View style={{ width: arrow * 0.55, height: arrow * 0.55, backgroundColor: color, transform: [{ rotate: '45deg' }] }} />
        </View>
    );
    return (
        <View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}>
            <Strand rotate="26deg" />
            <Strand rotate="-26deg" />
        </View>
    );
}

export function LoopIcon({ size = 22, color = '#333', single = false, style }) {
    // Drawn (not a text glyph) to match the rest of this file — the old
    // "↺¹" Unicode string rendered inconsistently across fonts, and always
    // showed the "1" even while off, implying repeat-one was already
    // active. The "1" badge now only renders when `single` is actually true.
    // `color` may be a plain string or an Animated interpolation.
    const ring = size * 0.72;
    const bw = Math.max(2, size * 0.1);
    return (
        <View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}>
            <Animated.View style={{
                width: ring, height: ring, borderRadius: ring / 2, borderWidth: bw,
                borderColor: color, borderTopColor: 'transparent', borderRightColor: 'transparent',
                transform: [{ rotate: '45deg' }],
            }} />
            <Animated.View style={{
                position: 'absolute', top: size * 0.06, right: size * 0.16,
                width: size * 0.16, height: size * 0.16, backgroundColor: color,
                transform: [{ rotate: '45deg' }],
            }} />
            {single && (
                <Animated.Text style={{ position: 'absolute', bottom: -2, right: -4, fontSize: size * 0.42, fontWeight: '800', color }}>1</Animated.Text>
            )}
        </View>
    );
}

export function AddQueueIcon({ size = 20, color = '#fff', style }) {
    return (
        <View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}>
            <View style={{ position: 'absolute', width: size * 0.8, height: 2, backgroundColor: color, borderRadius: 1 }} />
            <View style={{ position: 'absolute', width: 2, height: size * 0.8, backgroundColor: color, borderRadius: 1 }} />
        </View>
    );
}

export function MenuBarsIcon({ size = 26, color = '#fff', style }) {
    const barH = Math.max(2, Math.round(size * 0.09));
    const gap = Math.round(size * 0.2);
    return (
        <View style={[{ width: size, justifyContent: 'center' }, style]}>
            <View style={{ height: barH, borderRadius: 1, backgroundColor: color, marginBottom: gap }} />
            <View style={{ height: barH, borderRadius: 1, backgroundColor: color, marginBottom: gap }} />
            <View style={{ height: barH, borderRadius: 1, backgroundColor: color }} />
        </View>
    );
}

export function TrashIcon({ size = 20, color = '#fff', style }) {
    return (
        <View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'flex-start' }, style]}>
            <View style={{ width: size * 0.7, height: 2, backgroundColor: color, borderRadius: 1, marginBottom: 2 }} />
            <View style={{ width: size * 0.5, height: size * 0.6, borderWidth: 2, borderTopWidth: 0, borderColor: color, borderBottomLeftRadius: 3, borderBottomRightRadius: 3 }} />
        </View>
    );
}

export function MoonIcon({ size = 20, color = '#fff', bgColor = '#000', style }) {
    return (
        <View style={[{ width: size, height: size }, style]}>
            <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
            <View style={{
                position: 'absolute', top: -size * 0.08, left: size * 0.32,
                width: size, height: size, borderRadius: size / 2, backgroundColor: bgColor,
            }} />
        </View>
    );
}
