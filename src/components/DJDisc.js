import React, { useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { View, Image, Text, Animated, Easing, PanResponder, StyleSheet } from 'react-native';
import AudioEngine from '../native/AudioEngine';
import { subscribeTransportRamp, subscribeSkipPress } from '../utils/transportRamp';
import { COVER_SHADOW } from '../utils/shadow';

// A vinyl record with the song's cover as its label. It spins while the song
// plays. Dragging it scratches: the song plays at the speed and direction of
// the finger (held still = silence, backwards = reversed), through the same
// EQ and levelling as normal playback. Letting go carries on from wherever
// the disc was left.
//
// Scratching is switched off near both ends of a song (where crossfades and
// fade-ins happen, plus a safety margin): the disc dims and ignores touches.

// Speeds:
//  - The idle spin is a real record speed (Settings: 33 1/3, 45 or 78 rpm,
//    6 degrees per second per rpm) times the Player's playback speed, passed
//    in as spinDegPerSec. turnMsRef holds the length of one idle turn.
//  - RPM_DEG_PER_SEC: finger speed that plays the song at normal speed
//    while scratching. Unchanged (90), the scratch feel was fine.
// Finger speed that plays the song at normal speed while scratching is the
// disc's own speed at the Settings RPM (6 degrees per second per rpm), so a
// finger that turns the disc as fast as it idles plays at 1x. (Passed in as
// scratchDegPerSec; this is only the fallback.)
const RPM_DEG_PER_SEC = 200;
const MAX_RATE = 3;
const TICK_MS = 20;
// The idle spin is a native decay animation with an almost-zero decay, i.e. a
// perfectly steady turn that never reaches an end. (It used to be a looping
// timing animation; native restarts a loop every turn, drops the leftover
// frame time and shows the same angle twice, which was the small pause on
// every rotation.) `spin` and `lag` are in milliturns (1000 = one full turn)
// so each frame's step stays far above the native decay's 0.1 stop threshold.
const MT = 1000;
const SPIN_K = 1e-10;

// Where the disc was when the Player last closed, so reopening it shows the
// disc at the same angle (and keeps it turning as if it never stopped).
let savedDisc = null;

const angleOf = (px, py, c) => (Math.atan2(py - c.y, px - c.x) * 180) / Math.PI;
const wrap = (d) => (d > 180 ? d - 360 : d < -180 ? d + 360 : d);

// The static picture of the disc. Memoized so the several-times-a-second
// position updates in the Player do not rebuild it.
const rings = [0.97, 0.91, 0.85, 0.79, 0.73, 0.67, 0.61];
const DiscFace = React.memo(function DiscFace({ R, artwork, discType, placeholderColor }) {
    const labelD = R * 0.4;
    return (
        <>
                    {discType === 'cd' ? (
                        <View style={{ width: R, height: R, borderRadius: R / 2, overflow: 'hidden', backgroundColor: artwork ? '#c9ccd3' : placeholderColor, alignItems: 'center', justifyContent: 'center' }}>
                            {/* A CD: the picture is printed over the whole disc, with
                                a clear plastic ring and the hole around the middle. */}
                            {artwork
                                ? <Image source={{ uri: artwork }} style={{ position: 'absolute', width: R, height: R }} resizeMode="cover" />
                                : null}
                            <View style={{ position: 'absolute', width: R * 0.97, height: R * 0.97, borderRadius: R / 2, borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' }} />
                            <View style={{ position: 'absolute', width: R * 0.36, height: R * 0.36, borderRadius: R * 0.18, borderWidth: 1, borderColor: 'rgba(255,255,255,0.45)' }} />
                            <View style={{ position: 'absolute', width: R * 0.3, height: R * 0.3, borderRadius: R * 0.15, backgroundColor: 'rgba(232,235,242,0.82)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.6)' }} />
                            <View style={{ position: 'absolute', width: R * 0.09, height: R * 0.09, borderRadius: R * 0.045, backgroundColor: '#0b0b0b', borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)' }} />
                        </View>
                    ) : (
                    <View style={[s.vinyl, { width: R, height: R, borderRadius: R / 2, borderColor: '#2a2a2a' }]}>
                        {rings.map((f, i) => (
                            <View key={f} style={{
                                position: 'absolute', width: R * f, height: R * f, borderRadius: (R * f) / 2,
                                left: (R - R * f) / 2 - 2, top: (R - R * f) / 2 - 2,
                                borderWidth: 1, borderColor: `rgba(255,255,255,${i % 2 ? 0.05 : 0.09})`,
                            }} />
                        ))}
                        <View style={[s.label, { width: labelD, height: labelD, borderRadius: labelD / 2, left: (R - labelD) / 2 - 2, top: (R - labelD) / 2 - 2 }, !artwork && { backgroundColor: placeholderColor }]}>
                            {artwork
                                ? <Image source={{ uri: artwork }} style={{ width: labelD, height: labelD }} resizeMode="cover" />
                                : null}
                        </View>
                        <View style={{ position: 'absolute', width: R * 0.04, height: R * 0.04, borderRadius: R * 0.02, backgroundColor: '#000', left: R / 2 - R * 0.02 - 2, top: R / 2 - R * 0.02 - 2, borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' }} />
                    </View>
                    )}
        </>
    );
});

export default function DJDisc({ size, artwork, accent, shadow = false, outline = false, outlineColor = '#161616', outlineInset = 3, spinDegPerSec = 200, scratchDegPerSec = RPM_DEG_PER_SEC, discType = 'vinyl', placeholderColor = '#161616', assist = true, spinOn = true, touchOn = true, isPlaying, visible, active, position, duration, startGuard = 3, endGuard = 12, onTouching, trackKey }) {
    // Bad numbers (NaN, Infinity, negative) from upstream must never reach the
    // maths below: treat them as "unknown", which keeps the disc locked.
    position = Number.isFinite(position) ? position : 0;
    duration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    // One idle turn, in ms (read at call time so a speed change applies to
    // the next animation without rebuilding the callbacks).
    const turnMsRef = useRef(360000 / 200);
    turnMsRef.current = 360000 / Math.max(20, spinDegPerSec);
    const startAt = useRef(null);
    if (startAt.current === null) {
        let sp = 0, us = 0;
        if (savedDisc) {
            const adv = (savedDisc.spinning && isPlaying) ? ((Date.now() - savedDisc.at) / turnMsRef.current) * MT : 0;
            sp = (((savedDisc.spin + adv) % MT) + MT) % MT;
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
    const snapped = useRef(0);
    const draggingRef = useRef(false);
    const scratchingRef = useRef(false);
    const lastAngle = useRef(null);
    // Where in the song the scratch is (seconds), worked out from the speeds
    // sent to native, so the disc can be stopped at the end limit without
    // waiting for the 500ms position updates.
    const scratchEst = useRef(0);
    const scratchEstT = useRef(0);
    const atHi = useRef(false);   // at the end limit (the crossfade area at the end)
    const atLo = useRef(false);   // at the start limit (the crossfade area at the start)
    const pendingDeg = useRef(0);
    const lastTick = useRef(0);
    const tickTimer = useRef(null);
    const lastTouch = useRef({ x: 0, y: 0 });
    const smoothRate = useRef(0);
    const sentRate = useRef(0);

    // On a song change the position still holds the old song's value for a
    // moment, so the disc is held dim from the very first frame of the new
    // song until the position actually moves.
    const holdDim = useRef(false);
    const holdPos = useRef(position);
    const lastDimKey = useRef(trackKey);
    if (holdDim.current && position !== holdPos.current) holdDim.current = false;
    // A skip was pressed and the new song has not arrived yet: dimmed and
    // locked from the moment of the press (cleared when the song changes, or
    // when the position jumps back = the same song restarted, or after 12 s).
    const skipHold = useRef(null);
    const skipTimer = useRef(null);
    if (skipHold.current && position < skipHold.current.pos - 1.5) skipHold.current = null;
    const windowOk = !holdDim.current && visible && duration > 0 && position >= startGuard && position <= duration - endGuard;
    const inWindow = windowOk && !skipHold.current;
    // With touch off the disc ignores fingers and never dims (the dimming only
    // says "you can't scratch right now").
    const allowed = inWindow && touchOn;
    // Fade between enabled and disabled (near the song's ends) instead of
    // switching at once.
    const dimInit = useRef(false);
    useEffect(() => {
        if (!dimInit.current) { dimInit.current = true; dim.setValue(inWindow || !touchOn ? 0 : 1); return; }
        Animated.timing(dim, { toValue: inWindow || !touchOn ? 0 : 1, duration: 450, easing: Easing.inOut(Easing.quad), useNativeDriver: true }).start();
    }, [inWindow, touchOn, dim]);
    useLayoutEffect(() => {
        if (lastDimKey.current === trackKey) return;
        lastDimKey.current = trackKey;
        holdDim.current = true;
        holdPos.current = live.current.position;
        skipHold.current = null;
        if (skipTimer.current) { clearTimeout(skipTimer.current); skipTimer.current = null; }
        dim.stopAnimation();
        dim.setValue(touchOn ? 1 : 0);
    }, [trackKey, touchOn, dim]);
    const live = useRef({});
    live.current = { allowed, windowOk, visible, active, isPlaying, position, duration, startGuard, endGuard, scratchDegPerSec, assist, spin: spinOn, touch: touchOn };

    // Starting and stopping use a quadratic ease over the distance that
    // exactly matches idle speed at the join (distance = half of speed x
    // time), so the record winds up and down smoothly. The ease length is the
    // length of the audio ramp, so the disc is at full speed exactly when the
    // sound is, and stopped exactly when the fade-out ends.
    // How it is built: `spin` turns forever at idle speed as one native decay
    // animation with almost no decay (no loop, so no restart per turn), so nothing on the JS side has
    // to restart it (the old version queued a 1000-turn animation, which
    // made a huge frame table and caused a hitch when winding up). Winding
    // up, slowing down and letting go of a scratch move a second value,
    // `lag`, which is added to the turn. Both run at once, so nothing is
    // handed over between animations and there is no stutter.
    const spinToken = useRef(0);
    const spinState = useRef('stopped');
    const stopSpin = useCallback(() => { spinToken.current++; spinState.current = 'stopped'; spin.stopAnimation(); lag.stopAnimation(); }, [spin, lag]);
    // Starts the endless idle turn from wherever `spin` is right now (native
    // reads its own current value, so nothing has to be read back first and
    // a running turn is replaced without a gap).
    const runIdle = useCallback(() => {
        Animated.decay(spin, { velocity: MT / turnMsRef.current, deceleration: 1 - SPIN_K, useNativeDriver: true }).start();
    }, [spin]);
    const startSpin = useCallback((rampMs) => {
        const token = ++spinToken.current;
        spinState.current = 'spinning';
        // No wind-up: just turn at full speed from the current angle, with no
        // read-back (a read-back freezes the disc for a few frames).
        if (rampMs <= 0) { runIdle(); return; }
        spin.stopAnimation(() => {
            if (token !== spinToken.current) return;
            lag.stopAnimation((l) => {
                if (token !== spinToken.current) return;
                runIdle();
                if (rampMs > 0) {
                    // Quadratic wind-up = the full-speed turn minus a gap that
                    // closes with an out-quad ease; the gap ends at half a
                    // turn-time of the ramp.
                    Animated.timing(lag, { toValue: l - 0.5 * MT * (rampMs / turnMsRef.current), duration: rampMs, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
                }
            });
        });
    }, [spin, lag, runIdle]);
    // Letting go: the disc keeps the speed the finger left it at and settles
    // to the idle speed over a few tens of ms (the sound does the same), so
    // it never stops dead and then winds back up.
    const releaseSpin = useCallback((rate) => {
        const token = ++spinToken.current;
        spinState.current = 'spinning';
        spin.stopAnimation(() => {
            if (token !== spinToken.current) return;
            lag.stopAnimation((l) => {
                if (token !== spinToken.current) return;
                const idle = (MT * 1000) / turnMsRef.current;      // milliturns per second
                const v0 = (rate * Math.max(20, live.current.scratchDegPerSec || RPM_DEG_PER_SEC) / 360) * MT;  // milliturns per second
                const T = 0.08;
                runIdle();
                const A = (v0 - idle) * T / 2;
                if (Math.abs(A) > 1e-5) {
                    Animated.timing(lag, { toValue: l + A, duration: T * 1000, easing: (u) => 2 * u - u * u, useNativeDriver: true }).start();
                }
            });
        });
    }, [spin, lag, runIdle]);
    // Speed changed (rpm setting or the Player's speed button) while the disc
    // is turning: carry on from the same angle at the new speed.
    useEffect(() => {
        if (spinState.current !== 'spinning') return;
        ++spinToken.current;
        runIdle();
    }, [spinDegPerSec, runIdle]);
    const slowSpin = useCallback((rampMs) => {
        if (rampMs <= 0) { stopSpin(); return; }
        const token = ++spinToken.current;
        spinState.current = 'stopped';
        spin.stopAnimation((v) => {
            if (token !== spinToken.current) return;
            Animated.timing(spin, { toValue: v + 0.5 * MT * (rampMs / turnMsRef.current), duration: rampMs, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
        });
    }, [spin, stopSpin]);

    // `active` stays true from the moment the disc is chosen until it has
    // fully faded out, so switching away keeps it spinning as if it were
    // still playing in the background. Only then does it actually stop.
    const startTimer = useRef(null);
    const prevActive = useRef(false);
    // If the disc is already showing while music plays when it mounts (the
    // Player opening), it turns from the very first frame, not a moment after
    // the open animation.
    useLayoutEffect(() => {
        if (!active || !spinOn || !isPlaying) return;
        prevActive.current = true;
        startSpin(0);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => {
        if (startTimer.current) { clearTimeout(startTimer.current); startTimer.current = null; }
        const justActivated = active && !prevActive.current;
        prevActive.current = !!active;
        if (!active || !spinOn) { stopSpin(); return; }
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
            // A real pause announces itself through the transport ramp below
            // (and has already slowed the disc by now). This only catches a
            // state change with no announcement, and waits a moment so a
            // brief state flicker during a song change never slows the disc.
            startTimer.current = setTimeout(() => { if (spinState.current === 'spinning') slowSpin(500); }, 600);
        }
        return () => { if (startTimer.current) { clearTimeout(startTimer.current); startTimer.current = null; } };
    }, [active, spinOn, isPlaying, startSpin, slowSpin, stopSpin]);
    useEffect(() => () => {
        const wasSpinning = spinState.current === 'spinning';
        spin.stopAnimation((v) => { lag.stopAnimation((l) => { savedDisc = { spin: v + l, user: userRotVal.current, at: Date.now(), spinning: wasSpinning }; }); });
    }, [spin, lag]);
    useEffect(() => stopSpin, [stopSpin]);

    // Play / pause ramps announce themselves, so the disc follows them.
    useEffect(() => subscribeTransportRamp(({ type, seconds }) => {
        if (!live.current.active || !live.current.spin || draggingRef.current) return;
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
        const wasDragging = draggingRef.current;
        scratchingRef.current = false;
        draggingRef.current = false;
        lastAngle.current = null;
        pendingDeg.current = 0;
        if (onTouching) onTouching(false);
        if (wasScratching) AudioEngine.scratchEnd().catch(() => { });
        const rel = sentRate.current;
        sentRate.current = 0;
        if (live.current.active && live.current.isPlaying) {
            if (!live.current.spin) { /* spinning is off: nothing to restart */ }
            else if (wasScratching) releaseSpin(rel);
            // Only a finger that was actually holding the disc needs the
            // wind-up. (Leaving the disc view used to restart the spin from
            // a standstill here, which looked like the disc slowing down.)
            else if (wasDragging) startSpin(450);
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

    // A skip pressed anywhere: dim the disc and stop taking touches right now
    // (a scratch in progress ends), without waiting for the new song.
    useEffect(() => subscribeSkipPress(() => {
        if (!live.current.touch) return;   // touch off: the disc never dims
        skipHold.current = { pos: live.current.position };
        if (skipTimer.current) clearTimeout(skipTimer.current);
        skipTimer.current = setTimeout(() => { skipHold.current = null; skipTimer.current = null; }, 12000);
        if (draggingRef.current || scratchingRef.current) { finishScratch(); draggingRef.current = false; }
        dim.stopAnimation();
        // The same fade as the disc coming back to life with a new song
        // (see the inWindow effect below), run the other way.
        Animated.timing(dim, { toValue: 1, duration: 450, easing: Easing.inOut(Easing.quad), useNativeDriver: true }).start();
    }), [finishScratch, dim]);
    useEffect(() => () => { if (skipTimer.current) clearTimeout(skipTimer.current); }, []);

    // Leaving the disc view (or the song changing) mid-scratch ends it.
    useEffect(() => {
        if (!visible) finishScratch();
        return () => { if (scratchingRef.current) AudioEngine.scratchEnd().catch(() => { }); if (tickTimer.current) clearInterval(tickTimer.current); };
    }, [visible, finishScratch]);

    const pan = useRef(PanResponder.create({
        onStartShouldSetPanResponder: (e) => live.current.touch && live.current.allowed && !skipHold.current && insideDisc(e.nativeEvent.pageX, e.nativeEvent.pageY),
        onMoveShouldSetPanResponder: () => false,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
            draggingRef.current = true;
            if (onTouching) onTouching(true);
            stopSpin();
            lastTouch.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
            lastAngle.current = null;
            viewRef.current?.measureInWindow((x, y, w, h) => {
                center.current = { x: x + w / 2, y: y + h / 2, valid: w > 0 };
                if (draggingRef.current) lastAngle.current = angleOf(lastTouch.current.x, lastTouch.current.y, center.current);
            });
            // Grabbing the disc again within ~130ms of letting go is refused by
            // native (the last scratch is still finishing), which used to leave
            // the finger moving a silent disc. Retry a few times instead.
            const tryBegin = (n) => AudioEngine.scratchBegin().then((ok) => {
                if (!draggingRef.current) { if (ok) AudioEngine.scratchEnd().catch(() => { }); return; }
                if (!ok && n < 4) { setTimeout(() => { if (draggingRef.current && !scratchingRef.current) tryBegin(n + 1); }, 70); return; }
                scratchingRef.current = !!ok;
                if (ok) {
                    scratchEst.current = live.current.position;
                    scratchEstT.current = Date.now();
                    atHi.current = false; atLo.current = false;
                    // The exact spot (the position prop can be half a second old).
                    AudioEngine.getProgress().then((p) => { if (p && p.position >= 0 && scratchingRef.current) scratchEst.current = p.position; }).catch(() => { });
                }
            }).catch(() => { });
            tryBegin(0);
            lastTick.current = Date.now();
            smoothRate.current = 0;
            sentRate.current = 0;
            samples.current = [];
            snapped.current = 0;
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
                let rate = Math.max(-MAX_RATE, Math.min(MAX_RATE, vel / Math.max(20, live.current.scratchDegPerSec)));
                rate = smoothRate.current * 0.5 + rate * 0.5;
                smoothRate.current = rate;
                // Speed assist (Settings): the rate clings to 0.5x, 1x and 2x
                // (forward or backward) when the finger is close to one of
                // them, and a nearly still finger holds the record dead still.
                // Hysteresis keeps it from flickering at the edges of a lock.
                // With assist off the speed is exactly the finger's.
                const a = Math.abs(rate);
                if (a < (live.current.assist ? 0.1 : 0.04)) { rate = 0; snapped.current = 0; }
                else if (live.current.assist) {
                    let best = 0, bestD = 1e9;
                    for (const t of [0.5, 1, 2]) { const dd = Math.abs(a - t) / t; if (dd < bestD) { bestD = dd; best = t; } }
                    const tol = snapped.current === best ? 0.3 : 0.18;
                    if (bestD < tol) { snapped.current = best; rate = rate < 0 ? -best : best; }
                    else snapped.current = 0;
                }
                const L = live.current;
                // The disc can turn either way, but it cannot be turned into the
                // crossfade areas at the two ends of the song (the first
                // startGuard seconds and the last endGuard seconds): there it
                // stops, and slows smoothly over the last half second before.
                const dtS = scratchEstT.current ? (now - scratchEstT.current) / 1000 : 0;
                scratchEstT.current = now;
                scratchEst.current += sentRate.current * dtS;
                if (L.duration > 0) {
                    const hiLimit = L.duration - L.endGuard;
                    const loLimit = L.startGuard;
                    const est = scratchEst.current;
                    atHi.current = est >= hiLimit;
                    atLo.current = est <= loLimit;
                    if (rate > 0) rate = Math.min(rate, Math.max(0, (hiLimit - est) / 0.5));
                    else if (rate < 0) rate = Math.max(rate, -Math.max(0, (est - loLimit) / 0.5));
                }
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
            // Physically blocked at the limits: once the disc is at a crossfade
            // area it will not turn further that way (the finger can keep moving,
            // the disc stays put; turning the other way works again at once).
            if ((d > 0 && atHi.current) || (d < 0 && atLo.current)) return;
            pendingDeg.current += d;
            userRotVal.current += d;
            userRot.setValue(userRotVal.current);
        },
        onPanResponderRelease: () => finishScratch(),
        onPanResponderTerminate: () => finishScratch(),
    })).current;

    const R = size;
    const labelD = R * 0.4;
    // Built once: re-creating these on every render (the position changes
    // several times a second) rebuilt the native animation graph each time.
    const spinDeg = useMemo(() => Animated.add(spin, lag).interpolate({ inputRange: [0, MT], outputRange: ['0deg', '360deg'] }), [spin, lag]);
    const userDeg = useMemo(() => userRot.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'] }), [userRot]);

    return (
        <View ref={viewRef} collapsable={false} onLayout={refreshCenter} style={{ width: R, height: R }} {...pan.panHandlers}
            // Turns the Player's swipe-down-to-close off the moment a finger
            // lands ON the disc (only when the disc will take the touch), so
            // swiping anywhere else on the screen still closes the Player.
            onTouchStart={(e) => { if (live.current.allowed && !skipHold.current && onTouching && insideDisc(e.nativeEvent.pageX, e.nativeEvent.pageY)) onTouching(true); }}
            onTouchEnd={() => { if (!draggingRef.current && onTouching) onTouching(false); }}
            onTouchCancel={() => { if (!draggingRef.current && onTouching) onTouching(false); }}>
            <Animated.View style={{ width: R, height: R, opacity: dim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.55] }) }}>
            {/* Card-style outline (same look as the playlist cards): a ring
                of card color behind the disc, so it does not turn with it.
                Takes the shadow when there is one, otherwise the disc does. */}
            {outline && (
                <View pointerEvents="none" style={[{ position: 'absolute', top: -outlineInset, left: -outlineInset, right: -outlineInset, bottom: -outlineInset, borderRadius: (R + outlineInset * 2) / 2, backgroundColor: outlineColor }, shadow && COVER_SHADOW]} />
            )}
            {/* Shadow of the disc itself: a plain round shape under it (the
                turning layers clip their children, which would cut it off). */}
            {shadow && !outline && (
                <View pointerEvents="none" style={[{ position: 'absolute', width: R, height: R, borderRadius: R / 2, backgroundColor: '#0a0a0a' }, COVER_SHADOW]} />
            )}
            <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate: spinDeg }] }]}>
                <Animated.View shouldRasterizeIOS renderToHardwareTextureAndroid style={[StyleSheet.absoluteFill, { transform: [{ rotate: userDeg }] }]}>
                    <DiscFace R={R} artwork={artwork} discType={discType} placeholderColor={placeholderColor} />
                </Animated.View>
            </Animated.View>
            {/* Dim ring: a sibling, not part of the turning (rasterized) layers. */}
            <Animated.View pointerEvents="none" style={{ position: 'absolute', width: R, height: R, borderRadius: R / 2, borderWidth: 2, borderColor: '#2a2a2a', opacity: dim }} />
            </Animated.View>
        </View>
    );
}

const s = StyleSheet.create({
    vinyl: { backgroundColor: '#0a0a0a', borderWidth: 2, overflow: 'hidden' },
    label: { position: 'absolute', overflow: 'hidden', backgroundColor: '#161616', justifyContent: 'center', alignItems: 'center' },
});
