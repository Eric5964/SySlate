import React, { useRef, useEffect, useCallback } from 'react';
import { View, Image, Text, Animated, Easing, PanResponder, StyleSheet } from 'react-native';
import AudioEngine from '../native/AudioEngine';

// A vinyl record with the song's cover as its label. It spins while the song
// plays. Dragging it scratches: the song plays at the speed and direction of
// the finger (held still = silence, backwards = reversed), through the same
// EQ and levelling as normal playback. Letting go carries on from wherever
// the disc was left.
//
// Scratching is switched off near both ends of a song (where crossfades and
// fade-ins happen, plus a safety margin): the disc dims and ignores touches.

// Finger speed that plays the song at normal speed. A real platter turns at
// 200 deg/s (33 1/3 rpm); scratching with the finger felt too fast at that
// ratio, so normal speed is now reached at 360 deg/s and everything else
// scales from there. Raise it for gentler scratching, lower it for faster.
const RPM_DEG_PER_SEC = 360;
const MAX_RATE = 2.5;
const TICK_MS = 20;

const angleOf = (px, py, c) => (Math.atan2(py - c.y, px - c.x) * 180) / Math.PI;
const wrap = (d) => (d > 180 ? d - 360 : d < -180 ? d + 360 : d);

export default function DJDisc({ size, artwork, accent, isPlaying, visible, position, duration, startGuard = 3, endGuard = 12, onTouching }) {
    const spin = useRef(new Animated.Value(0)).current;
    const userRot = useRef(new Animated.Value(0)).current;
    const userRotVal = useRef(0);
    const viewRef = useRef(null);
    const center = useRef({ x: 0, y: 0 });
    const draggingRef = useRef(false);
    const scratchingRef = useRef(false);
    const lastAngle = useRef(null);
    const pendingDeg = useRef(0);
    const lastTick = useRef(0);
    const tickTimer = useRef(null);
    const lastTouch = useRef({ x: 0, y: 0 });
    const smoothRate = useRef(0);

    const allowed = visible && duration > 0 && position >= startGuard && position <= duration - endGuard;
    const live = useRef({});
    live.current = { allowed, visible, isPlaying, position, duration, startGuard, endGuard };

    // One full turn takes 1.8s (33 1/3 rpm). Starting and stopping use a
    // quadratic ease over the distance that exactly matches that speed at
    // the join (distance = half of speed x time), so the record winds up and
    // winds down like a real platter instead of jumping to or from full speed.
    const SPIN_TURN_MS = 1800;
    const SPIN_UP_MS = 700;
    const SPIN_DOWN_MS = 600;
    const spinToken = useRef(0);
    const stopSpin = useCallback(() => { spinToken.current++; spin.stopAnimation(); }, [spin]);
    const startSpin = useCallback(() => {
        const token = ++spinToken.current;
        spin.stopAnimation((v) => {
            if (token !== spinToken.current) return;
            const up = 0.5 * (SPIN_UP_MS / SPIN_TURN_MS);
            Animated.sequence([
                Animated.timing(spin, { toValue: v + up, duration: SPIN_UP_MS, easing: Easing.in(Easing.quad), useNativeDriver: true }),
                Animated.timing(spin, { toValue: v + up + 1000, duration: 1000 * SPIN_TURN_MS, easing: Easing.linear, useNativeDriver: true }),
            ]).start();
        });
    }, [spin]);
    const slowSpin = useCallback(() => {
        const token = ++spinToken.current;
        spin.stopAnimation((v) => {
            if (token !== spinToken.current) return;
            const down = 0.5 * (SPIN_DOWN_MS / SPIN_TURN_MS);
            Animated.timing(spin, { toValue: v + down, duration: SPIN_DOWN_MS, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
        });
    }, [spin]);

    // Spin only while visible, playing and not being held. Pausing winds the
    // disc down; leaving the disc view just stops it.
    const wasSpinning = useRef(false);
    useEffect(() => {
        if (visible && isPlaying && !draggingRef.current) { startSpin(); wasSpinning.current = true; }
        else if (visible && wasSpinning.current && !draggingRef.current) { slowSpin(); wasSpinning.current = false; }
        else { stopSpin(); wasSpinning.current = false; }
    }, [visible, isPlaying, startSpin, slowSpin, stopSpin]);
    useEffect(() => stopSpin, [stopSpin]);

    const finishScratch = useCallback(() => {
        if (tickTimer.current) { clearInterval(tickTimer.current); tickTimer.current = null; }
        const wasScratching = scratchingRef.current;
        scratchingRef.current = false;
        draggingRef.current = false;
        lastAngle.current = null;
        pendingDeg.current = 0;
        if (onTouching) onTouching(false);
        if (wasScratching) AudioEngine.scratchEnd().catch(() => { });
        if (live.current.visible && live.current.isPlaying) { startSpin(); wasSpinning.current = true; }
    }, [startSpin]);

    // Leaving the disc view (or the song changing) mid-scratch ends it.
    useEffect(() => {
        if (!visible) finishScratch();
        return () => { if (scratchingRef.current) AudioEngine.scratchEnd().catch(() => { }); if (tickTimer.current) clearInterval(tickTimer.current); };
    }, [visible, finishScratch]);

    const pan = useRef(PanResponder.create({
        onStartShouldSetPanResponder: () => live.current.allowed,
        onMoveShouldSetPanResponder: () => live.current.allowed,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
            draggingRef.current = true;
            if (onTouching) onTouching(true);
            wasSpinning.current = false;
            stopSpin();
            lastTouch.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
            lastAngle.current = null;
            viewRef.current?.measureInWindow((x, y, w, h) => {
                center.current = { x: x + w / 2, y: y + h / 2 };
                if (draggingRef.current) lastAngle.current = angleOf(lastTouch.current.x, lastTouch.current.y, center.current);
            });
            AudioEngine.scratchBegin().then((ok) => {
                if (!draggingRef.current) { if (ok) AudioEngine.scratchEnd().catch(() => { }); return; }
                scratchingRef.current = !!ok;
            }).catch(() => { });
            lastTick.current = Date.now();
            smoothRate.current = 0;
            tickTimer.current = setInterval(() => {
                const now = Date.now();
                const dt = Math.max(0.001, (now - lastTick.current) / 1000);
                lastTick.current = now;
                const deg = pendingDeg.current;
                pendingDeg.current = 0;
                if (!scratchingRef.current) return;
                // Light smoothing across ticks so finger jitter does not
                // turn into crackle; the native side smooths again.
                const raw = deg / dt / RPM_DEG_PER_SEC;
                let rate = smoothRate.current * 0.45 + raw * 0.55;
                rate = Math.max(-MAX_RATE, Math.min(MAX_RATE, rate));
                smoothRate.current = rate;
                const L = live.current;
                // Never scratch into the protected zones at the ends.
                if (rate > 0 && L.position >= L.duration - L.endGuard) rate = 0;
                if (rate < 0 && L.position <= L.startGuard) rate = 0;
                AudioEngine.scratchSetRate(rate);
            }, TICK_MS);
        },
        onPanResponderMove: (e) => {
            lastTouch.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
            if (lastAngle.current == null) return;
            const a = angleOf(e.nativeEvent.pageX, e.nativeEvent.pageY, center.current);
            const d = wrap(a - lastAngle.current);
            lastAngle.current = a;
            pendingDeg.current += d;
            userRotVal.current += d;
            userRot.setValue(userRotVal.current);
        },
        onPanResponderRelease: () => finishScratch(),
        onPanResponderTerminate: () => finishScratch(),
    })).current;

    const R = size;
    const labelD = R * 0.4;
    const spinDeg = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
    const userDeg = userRot.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'] });
    const rings = [0.97, 0.91, 0.85, 0.79, 0.73, 0.67, 0.61];

    return (
        <View ref={viewRef} collapsable={false} style={{ width: R, height: R, opacity: allowed ? 1 : 0.55 }} {...pan.panHandlers}
            // Turns the Player's swipe-down-to-close off the moment a finger
            // lands ON the disc (only when the disc will take the touch), so
            // swiping anywhere else on the screen still closes the Player.
            onTouchStart={() => { if (live.current.allowed && onTouching) onTouching(true); }}
            onTouchEnd={() => { if (!draggingRef.current && onTouching) onTouching(false); }}
            onTouchCancel={() => { if (!draggingRef.current && onTouching) onTouching(false); }}>
            <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate: spinDeg }] }]}>
                <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate: userDeg }] }]}>
                    <View style={[s.vinyl, { width: R, height: R, borderRadius: R / 2, borderColor: allowed ? accent : '#2a2a2a' }]}>
                        {rings.map((f, i) => (
                            <View key={f} style={{
                                position: 'absolute', width: R * f, height: R * f, borderRadius: (R * f) / 2,
                                left: (R - R * f) / 2 - 2, top: (R - R * f) / 2 - 2,
                                borderWidth: 1, borderColor: `rgba(255,255,255,${i % 2 ? 0.05 : 0.09})`,
                            }} />
                        ))}
                        {/* A marker on the edge so the spin is visible. */}
                        <View style={{ position: 'absolute', top: R * 0.025, left: R / 2 - 1.5, width: 3, height: R * 0.06, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.22)' }} />
                        <View style={[s.label, { width: labelD, height: labelD, borderRadius: labelD / 2, left: (R - labelD) / 2 - 2, top: (R - labelD) / 2 - 2 }]}>
                            {artwork
                                ? <Image source={{ uri: artwork }} style={{ width: labelD, height: labelD }} resizeMode="cover" />
                                : <Text style={{ color: accent, fontSize: labelD * 0.4, textAlign: 'center', lineHeight: labelD }}>♪</Text>}
                        </View>
                        <View style={{ position: 'absolute', width: R * 0.04, height: R * 0.04, borderRadius: R * 0.02, backgroundColor: '#000', left: R / 2 - R * 0.02 - 2, top: R / 2 - R * 0.02 - 2, borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' }} />
                    </View>
                </Animated.View>
            </Animated.View>
        </View>
    );
}

const s = StyleSheet.create({
    vinyl: { backgroundColor: '#0a0a0a', borderWidth: 2, overflow: 'hidden' },
    label: { position: 'absolute', overflow: 'hidden', backgroundColor: '#161616', justifyContent: 'center', alignItems: 'center' },
});
