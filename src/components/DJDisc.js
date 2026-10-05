import React, { useRef, useEffect, useCallback } from 'react';
import { View, Image, Text, Animated, Easing, PanResponder, StyleSheet } from 'react-native';
import AudioEngine from '../native/AudioEngine';
import { subscribeTransportRamp } from '../utils/transportRamp';

// A vinyl record with the song's cover as its label. It spins while the song
// plays. Dragging it scratches: the song plays at the speed and direction of
// the finger (held still = silence, backwards = reversed), through the same
// EQ and levelling as normal playback. Letting go carries on from wherever
// the disc was left.
//
// Scratching is switched off near both ends of a song (where crossfades and
// fade-ins happen, plus a safety margin): the disc dims and ignores touches.

// Two linked speeds (change both together):
//  - SPIN_TURN_MS: how long one idle turn takes while playing (4s = 90 deg/s,
//    slower than a real 33 1/3 rpm platter, which is 1.8s). Kept equal to
//    RPM_DEG_PER_SEC so a finger turning at the idle pace plays normal speed.
//  - RPM_DEG_PER_SEC: finger speed that plays the song at normal speed. It was
//    360, and is now 600 to match the slower disc (360 x 1.8/3.0 ratio of the
//    old and new idle speeds), so forwarding and rewinding are 40% slower.
const SPIN_TURN_MS = 4000;
const RPM_DEG_PER_SEC = 90;
const MAX_RATE = 3;
const TICK_MS = 20;

// Where the disc was when the Player last closed, so reopening it shows the
// disc at the same angle (and keeps it turning as if it never stopped).
let savedDisc = null;

const angleOf = (px, py, c) => (Math.atan2(py - c.y, px - c.x) * 180) / Math.PI;
const wrap = (d) => (d > 180 ? d - 360 : d < -180 ? d + 360 : d);

export default function DJDisc({ size, artwork, accent, isPlaying, visible, active, position, duration, startGuard = 3, endGuard = 12, onTouching, trackKey }) {
    const startAt = useRef(null);
    if (startAt.current === null) {
        let sp = 0, us = 0;
        if (savedDisc) {
            const adv = (savedDisc.spinning && isPlaying) ? (Date.now() - savedDisc.at) / SPIN_TURN_MS : 0;
            sp = (savedDisc.spin + adv) % 1;
            us = savedDisc.user;
        }
        startAt.current = { sp, us };
    }
    const spin = useRef(new Animated.Value(startAt.current.sp)).current;
    const lag = useRef(new Animated.Value(0)).current;
    const userRot = useRef(new Animated.Value(startAt.current.us)).current;
    const userRotVal = useRef(startAt.current.us);
    const dim = useRef(new Animated.Value(0)).current;
    const viewRef = useRef(null);
    const center = useRef({ x: 0, y: 0, valid: false });
    const samples = useRef([]);
    const snapped = useRef(false);
    const draggingRef = useRef(false);
    const scratchingRef = useRef(false);
    const lastAngle = useRef(null);
    const pendingDeg = useRef(0);
    const lastTick = useRef(0);
    const tickTimer = useRef(null);
    const lastTouch = useRef({ x: 0, y: 0 });
    const smoothRate = useRef(0);
    const sentRate = useRef(0);

    const allowed = visible && duration > 0 && position >= startGuard && position <= duration - endGuard;
    // Fade between enabled and disabled (near the song's ends) instead of
    // switching at once.
    const dimInit = useRef(false);
    useEffect(() => {
        if (!dimInit.current) { dimInit.current = true; dim.setValue(allowed ? 0 : 1); return; }
        Animated.timing(dim, { toValue: allowed ? 0 : 1, duration: 450, easing: Easing.inOut(Easing.quad), useNativeDriver: true }).start();
    }, [allowed, dim]);
    const live = useRef({});
    live.current = { allowed, visible, active, isPlaying, position, duration, startGuard, endGuard };

    // Starting and stopping use a quadratic ease over the distance that
    // exactly matches idle speed at the join (distance = half of speed x
    // time), so the record winds up and down smoothly. The ease length is the
    // length of the audio ramp, so the disc is at full speed exactly when the
    // sound is, and stopped exactly when the fade-out ends.
    // How it is built: `spin` turns forever at idle speed, looped by the
    // native side itself (one turn per loop), so nothing on the JS side has
    // to restart it (the old version queued a 1000-turn animation, which
    // made a huge frame table and caused a hitch when winding up). Winding
    // up, slowing down and letting go of a scratch move a second value,
    // `lag`, which is added to the turn. Both run at once, so nothing is
    // handed over between animations and there is no stutter.
    const spinToken = useRef(0);
    const spinState = useRef('stopped');
    const stopSpin = useCallback(() => { spinToken.current++; spinState.current = 'stopped'; spin.stopAnimation(); lag.stopAnimation(); }, [spin, lag]);
    const loopFrom = useCallback((v) => {
        Animated.loop(Animated.timing(spin, { toValue: v + 1, duration: SPIN_TURN_MS, easing: Easing.linear, useNativeDriver: true })).start();
    }, [spin]);
    const startSpin = useCallback((rampMs) => {
        const token = ++spinToken.current;
        spinState.current = 'spinning';
        spin.stopAnimation((v) => {
            if (token !== spinToken.current) return;
            lag.stopAnimation((l) => {
                if (token !== spinToken.current) return;
                loopFrom(v);
                if (rampMs > 0) {
                    // Quadratic wind-up = the full-speed turn minus a gap that
                    // closes with an out-quad ease; the gap ends at half a
                    // turn-time of the ramp.
                    Animated.timing(lag, { toValue: l - 0.5 * (rampMs / SPIN_TURN_MS), duration: rampMs, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
                }
            });
        });
    }, [spin, lag, loopFrom]);
    // Letting go: the disc keeps the speed the finger left it at and settles
    // to the idle speed over a few tens of ms (the sound does the same), so
    // it never stops dead and then winds back up.
    const releaseSpin = useCallback((rate) => {
        const token = ++spinToken.current;
        spinState.current = 'spinning';
        spin.stopAnimation((v) => {
            if (token !== spinToken.current) return;
            lag.stopAnimation((l) => {
                if (token !== spinToken.current) return;
                const idle = 1000 / SPIN_TURN_MS;                 // turns per second
                const v0 = (rate * RPM_DEG_PER_SEC) / 360;        // turns per second
                const T = 0.08;
                loopFrom(v);
                const A = (v0 - idle) * T / 2;
                if (Math.abs(A) > 1e-5) {
                    Animated.timing(lag, { toValue: l + A, duration: T * 1000, easing: (u) => 2 * u - u * u, useNativeDriver: true }).start();
                }
            });
        });
    }, [spin, lag, loopFrom]);
    const slowSpin = useCallback((rampMs) => {
        if (rampMs <= 0) { stopSpin(); return; }
        const token = ++spinToken.current;
        spinState.current = 'stopped';
        spin.stopAnimation((v) => {
            if (token !== spinToken.current) return;
            Animated.timing(spin, { toValue: v + 0.5 * (rampMs / SPIN_TURN_MS), duration: rampMs, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
        });
    }, [spin, stopSpin]);

    // `active` stays true from the moment the disc is chosen until it has
    // fully faded out, so switching away keeps it spinning as if it were
    // still playing in the background. Only then does it actually stop.
    const startTimer = useRef(null);
    const prevActive = useRef(false);
    useEffect(() => {
        if (startTimer.current) { clearTimeout(startTimer.current); startTimer.current = null; }
        const justActivated = active && !prevActive.current;
        prevActive.current = !!active;
        if (!active) { stopSpin(); return; }
        if (draggingRef.current) return;
        if (isPlaying) {
            if (justActivated) startSpin(0); // looks like it never stopped
            else if (spinState.current !== 'spinning') {
                // Give the ramp announcement (below) a moment to arrive first,
                // so the wind-up can match the audio fade-in exactly.
                // The disc never winds up on its own: if music is already
                // playing it turns at full speed at once. A real play fade-in
                // announces itself below and gets its own wind-up.
                startTimer.current = setTimeout(() => { if (spinState.current !== 'spinning') startSpin(0); }, 160);
            }
        } else if (spinState.current === 'spinning') {
            slowSpin(500);
        }
        return () => { if (startTimer.current) { clearTimeout(startTimer.current); startTimer.current = null; } };
    }, [active, isPlaying, startSpin, slowSpin, stopSpin]);
    useEffect(() => () => {
        const wasSpinning = spinState.current === 'spinning';
        spin.stopAnimation((v) => { lag.stopAnimation((l) => { savedDisc = { spin: v + l, user: userRotVal.current, at: Date.now(), spinning: wasSpinning }; }); });
    }, [spin, lag]);
    useEffect(() => stopSpin, [stopSpin]);

    // Play / pause ramps announce themselves, so the disc follows them.
    useEffect(() => subscribeTransportRamp(({ type, seconds }) => {
        if (!live.current.active || draggingRef.current) return;
        if (startTimer.current) { clearTimeout(startTimer.current); startTimer.current = null; }
        if (type === 'play') startSpin(Math.max(250, seconds * 1000));
        else slowSpin(seconds * 1000);
    }), [startSpin, slowSpin]);

    // Only the round disc itself takes touches, not the square box around it.
    const refreshCenter = useCallback(() => {
        viewRef.current?.measureInWindow((x, y, w, h) => {
            if (w > 0) center.current = { x: x + w / 2, y: y + h / 2, valid: true };
        });
    }, []);
    const insideDisc = (px, py) => {
        const c = center.current;
        if (!c.valid) return true;
        return Math.hypot(px - c.x, py - c.y) <= size / 2;
    };
    useEffect(() => {
        if (!visible) return;
        refreshCenter();
        const t = setTimeout(refreshCenter, 500); // after the view-switch fade settles
        return () => clearTimeout(t);
    }, [visible, refreshCenter]);

    const finishScratch = useCallback(() => {
        if (tickTimer.current) { clearInterval(tickTimer.current); tickTimer.current = null; }
        const wasScratching = scratchingRef.current;
        scratchingRef.current = false;
        draggingRef.current = false;
        lastAngle.current = null;
        pendingDeg.current = 0;
        if (onTouching) onTouching(false);
        if (wasScratching) AudioEngine.scratchEnd().catch(() => { });
        const rel = sentRate.current;
        sentRate.current = 0;
        if (live.current.active && live.current.isPlaying) {
            if (wasScratching) releaseSpin(rel); else startSpin(450);
        }
    }, [startSpin, releaseSpin]);

    // The song changing mid-scratch ends the scratch right away. The finger
    // may still be on the disc, but it does nothing until it is lifted and
    // put down again (it used to keep scratching the old song underneath
    // the new one).
    const lastTrackKey = useRef(trackKey);
    useEffect(() => {
        if (lastTrackKey.current === trackKey) return;
        lastTrackKey.current = trackKey;
        if (draggingRef.current || scratchingRef.current) { finishScratch(); draggingRef.current = false; }
    }, [trackKey, finishScratch]);

    // Leaving the disc view (or the song changing) mid-scratch ends it.
    useEffect(() => {
        if (!visible) finishScratch();
        return () => { if (scratchingRef.current) AudioEngine.scratchEnd().catch(() => { }); if (tickTimer.current) clearInterval(tickTimer.current); };
    }, [visible, finishScratch]);

    const pan = useRef(PanResponder.create({
        onStartShouldSetPanResponder: (e) => live.current.allowed && insideDisc(e.nativeEvent.pageX, e.nativeEvent.pageY),
        onMoveShouldSetPanResponder: () => false,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
            draggingRef.current = true;
            if (onTouching) onTouching(true);
            stopSpin();
            lastTouch.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
            lastAngle.current = null;
            viewRef.current?.measureInWindow((x, y, w, h) => {
                center.current = { x: x + w / 2, y: y + h / 2 };
                if (draggingRef.current) lastAngle.current = angleOf(lastTouch.current.x, lastTouch.current.y, center.current);
            });
            // Grabbing the disc again within ~130ms of letting go is refused by
            // native (the last scratch is still finishing), which used to leave
            // the finger moving a silent disc. Retry a few times instead.
            const tryBegin = (n) => AudioEngine.scratchBegin().then((ok) => {
                if (!draggingRef.current) { if (ok) AudioEngine.scratchEnd().catch(() => { }); return; }
                if (!ok && n < 4) { setTimeout(() => { if (draggingRef.current && !scratchingRef.current) tryBegin(n + 1); }, 70); return; }
                scratchingRef.current = !!ok;
            }).catch(() => { });
            tryBegin(0);
            lastTick.current = Date.now();
            smoothRate.current = 0;
            sentRate.current = 0;
            samples.current = [];
            snapped.current = false;
            tickTimer.current = setInterval(() => {
                const now = Date.now();
                lastTick.current = now;
                pendingDeg.current = 0;
                if (!scratchingRef.current) return;
                // Speed = how far the disc turned over the last ~110ms (a
                // sliding window, not just the last 20ms tick), so a steady
                // hand gives a steady number instead of a jittery one.
                const arr = samples.current;
                arr.push([now, userRotVal.current]);
                while (arr.length > 2 && now - arr[0][0] > 110) arr.shift();
                const span = (now - arr[0][0]) / 1000;
                const vel = span >= 0.04 ? (userRotVal.current - arr[0][1]) / span : 0;
                let rate = Math.max(-MAX_RATE, Math.min(MAX_RATE, vel / RPM_DEG_PER_SEC));
                rate = smoothRate.current * 0.5 + rate * 0.5;
                smoothRate.current = rate;
                // Detents that make a steady pace easy: close to normal speed
                // (forward or backward) it locks onto exactly 1x, and a nearly
                // still finger holds the record dead still. Hysteresis keeps
                // it from flickering at the edges of the lock.
                const a = Math.abs(rate);
                if (a < 0.1) rate = 0;
                else if (Math.abs(a - 1) < (snapped.current ? 0.4 : 0.25)) { snapped.current = true; rate = rate < 0 ? -1 : 1; }
                else snapped.current = false;
                const L = live.current;
                // Never scratch into the protected zones at the ends.
                if (rate > 0 && L.position >= L.duration - L.endGuard) rate = 0;
                if (rate < 0 && L.position <= L.startGuard) rate = 0;
                sentRate.current = rate;
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
    const spinDeg = Animated.add(spin, lag).interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
    const userDeg = userRot.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'] });
    const rings = [0.97, 0.91, 0.85, 0.79, 0.73, 0.67, 0.61];

    return (
        <View ref={viewRef} collapsable={false} onLayout={refreshCenter} style={{ width: R, height: R }} {...pan.panHandlers}
            // Turns the Player's swipe-down-to-close off the moment a finger
            // lands ON the disc (only when the disc will take the touch), so
            // swiping anywhere else on the screen still closes the Player.
            onTouchStart={(e) => { if (live.current.allowed && onTouching && insideDisc(e.nativeEvent.pageX, e.nativeEvent.pageY)) onTouching(true); }}
            onTouchEnd={() => { if (!draggingRef.current && onTouching) onTouching(false); }}
            onTouchCancel={() => { if (!draggingRef.current && onTouching) onTouching(false); }}>
            <Animated.View style={{ width: R, height: R, opacity: dim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.55] }) }}>
            <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate: spinDeg }] }]}>
                <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate: userDeg }] }]}>
                    <View style={[s.vinyl, { width: R, height: R, borderRadius: R / 2, borderColor: accent }]}>
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
                    <Animated.View pointerEvents="none" style={{ position: 'absolute', width: R, height: R, borderRadius: R / 2, borderWidth: 2, borderColor: '#2a2a2a', opacity: dim }} />
                </Animated.View>
            </Animated.View>
            </Animated.View>
        </View>
    );
}

const s = StyleSheet.create({
    vinyl: { backgroundColor: '#0a0a0a', borderWidth: 2, overflow: 'hidden' },
    label: { position: 'absolute', overflow: 'hidden', backgroundColor: '#161616', justifyContent: 'center', alignItems: 'center' },
});
