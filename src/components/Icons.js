import React from 'react';
import { View } from 'react-native';

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
            marginLeft: size * 0.08,
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
    const bar = size * 0.86;
    return (
        <View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}>
            <View style={{ position: 'absolute', width: bar, height: 2, backgroundColor: color, borderRadius: 1, transform: [{ rotate: '28deg' }] }} />
            <View style={{ position: 'absolute', width: bar, height: 2, backgroundColor: color, borderRadius: 1, transform: [{ rotate: '-28deg' }] }} />
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
