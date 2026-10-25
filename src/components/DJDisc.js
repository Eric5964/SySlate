import React, { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState } from 'react';
import { View, Image, Text, Animated, Easing, StyleSheet } from 'react-native';
import { Gesture, GestureDetector, State } from 'react-native-gesture-handler';
import AudioEngine from '../native/AudioEngine';
import { subscribeTransportRamp, subscribeSkipPress } from '../utils/transportRamp';
import { COVER_SHADOW } from '../utils/shadow';
import { holdBackground } from '../utils/memoryPressure';

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
// Wind-up used when a play happens and no transport ramp announced itself (the
// ramp handler below is the normal path, and it matches the audio fade-in).
// It used to start at full speed in one frame there as well, which read as a
// snap next to the ramp's own wind-up.
const FALLBACK_WINDUP_MS = 320;
// The idle spin is a native decay animation with an almost-zero decay, i.e. a
// perfectly steady turn that never reaches an end. (It used to be a looping
// timing animation; native restarts a loop every turn, drops the leftover
// frame time and shows the same angle twice, which was the small pause on
// every rotation.) `spin` and `lag` are in milliturns (1000 = one full turn)
// so each frame's step stays far above the native decay's 0.1 stop threshold.
const MT = 1000;
const SPIN_K = 1e-10;
const IDLE_SPAN_MS = 90000;   // length of the straight-line turn used right after a wind-up (see startSpin)

// Where the disc was when the Player last closed, so reopening it shows the
// disc at the same angle (and keeps it turning as if it never stopped).
let savedDisc = null;

// While a finger is on the disc the background tag/cover loader and library rebuilds wait (the
// scratch runs on a 20 ms JS timer; heavy JS work next to it made it choppy). Expires on its own.
let discHold = null;
const holdForTouch = (on) => {
    if (on) { if (discHold) discHold(); discHold = holdBackground(20000); }
    else if (discHold) { discHold(); discHold = null; }
};

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
    // How the song and disc are brought back to normal speed after the finger
    // lets go ('release') or the disc reaches the crossfade area at either
    // end of the song ('edge'). While it runs the song and disc move on their
    // own; after an 'edge' the finger is ignored until it is lifted.
    const autoRef = useRef(null);
    const ignoreTouch = useRef(false);
    const maxAbsRate = useRef(0);
    const lagVal = useRef(0);
    const grantAt = useRef(0);
    const api = useRef({});

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
        if (autoRef.current && autoRef.current.kind === 'edge') return;   // stays faded until the ease is done
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
    const stopSpin = useCallback(() => { spinToken.current++; spinState.current = 'stopped'; spin.stopAnimation(); lag.stopAnimation((v) => { lagVal.current = v; }); }, [spin, lag]);
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
        spin.stopAnimation((v) => {
            if (token !== spinToken.current) return;
            lag.stopAnimation((l) => {
                if (token !== spinToken.current) return;
                // The full-speed turn is a long straight-line timing here, NOT a decay: a
                // decay and a timing animation started together do not begin on the same
                // frame (the decay's first step already includes up to one frame of full
                // speed, the timing's is zero), and from rest that showed as a sudden jump
                // of about 3 degrees the moment Play was pressed (measured in a screen
                // recording). Two timings begin identically. A few seconds before it
                // runs out it is handed to the ordinary endless turn (runIdle), which
                // at full speed cannot be told apart.
                const spanMs = IDLE_SPAN_MS;
                Animated.timing(spin, { toValue: v + MT * (spanMs / turnMsRef.current), duration: spanMs, easing: Easing.linear, useNativeDriver: true }).start();
                setTimeout(() => { if (token === spinToken.current && spinState.current === 'spinning') runIdle(); }, spanMs - 10000);
                // Quadratic wind-up = the full-speed turn minus a gap that
                // closes with an out-quad ease; the gap ends at half a
                // turn-time of the ramp.
                Animated.timing(lag, { toValue: l - 0.5 * MT * (rampMs / turnMsRef.current), duration: rampMs, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
            });
        });
    }, [spin, lag, runIdle]);
    // Letting go: the disc keeps the speed the finger left it at and settles
    // to the idle speed over a few tens of ms (the sound does the same), so
    // it never stops dead and then winds back up.
    const releaseSpin = useCallback((rate) => {
        ++spinToken.current;
        spinState.current = 'spinning';
        const l = lagVal.current;                          // known from when the disc was grabbed
        const idle = (MT * 1000) / turnMsRef.current;      // milliturns per second
        const v0 = (rate * Math.max(20, live.current.scratchDegPerSec || RPM_DEG_PER_SEC) / 360) * MT;
        const T = 0.08;
        runIdle();                                         // starts at once, from where the disc is
        const A = (v0 - idle) * T / 2;
        if (Math.abs(A) > 1e-5) {
            lagVal.current = l + A;
            Animated.timing(lag, { toValue: l + A, duration: T * 1000, easing: (u) => 2 * u - u * u, useNativeDriver: true }).start();
        }
    }, [lag, runIdle]);
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
                // so the wind-up can match the audio fade-in exactly. If none
                // arrives, wind up over a short fixed ramp rather than jumping
                // to full speed in one frame (see FALLBACK_WINDUP_MS).
                startTimer.current = setTimeout(() => { if (spinState.current !== 'spinning') startSpin(FALLBACK_WINDUP_MS); }, 160);
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
    useEffect(() => () => holdForTouch(false), []);

    // Play / pause ramps announce themselves, so the disc follows them.
    useEffect(() => subscribeTransportRamp(({ type, seconds }) => {
        if (!live.current.active || !live.current.spin || draggingRef.current) return;
        if (startTimer.current) { clearTimeout(startTimer.current); startTimer.current = null; }
        if (type === 'play') {
            // Already turning at speed: a wind-up subtracts half a ramp of
            // angle from the turn, so applying one here would visibly stop the
            // disc and start it again. That double announcement (the Player
            // opening, or the fallback in the effect above, plus this ramp
            // arriving a moment later) is exactly the "rotates instantly, then
            // starts to gain velocity" jump.
            if (spinState.current === 'spinning') return;
            startSpin(Math.max(250, seconds * 1000));
        } else slowSpin(Math.max(250, seconds * 1000));   // never stops dead, even with the pause fade off
    }), [startSpin, slowSpin]);

    // While the disc can be scratched, keep a copy of the audio around the
    // playing spot ready natively, so a touch starts scratching at once.
    useEffect(() => {
        if (!visible || !active || !touchOn) return undefined;
        AudioEngine.scratchPrefetch(true);
        const t = setInterval(() => AudioEngine.scratchPrefetch(true), 5000);
        return () => { clearInterval(t); AudioEngine.scratchPrefetch(false); };
    }, [visible, active, touchOn, trackKey]);

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

    // The finger lifted (or, with `force`, something ended the scratch: leaving
    // the view, a skip, a song change). A normal lift does not stop anything
    // dead: the song and disc ease back to normal speed (startAuto).
    const finishScratch = useCallback((force) => {
        const wasDragging = draggingRef.current;
        draggingRef.current = false;
        lastAngle.current = null;
        pendingDeg.current = 0;
        if (wasDragging) holdForTouch(false);
        if (wasDragging && onTouching) onTouching(false);
        if (!force) {
            if (autoRef.current) { ignoreTouch.current = false; return; }   // already easing back: nothing more to do (and the finger is up, so a new touch is possible once it is done)
            if (ignoreTouch.current) { ignoreTouch.current = false; return; }
            if (scratchingRef.current) { api.current.startAuto('release'); return; }
            api.current.stopTick();
            if (wasDragging && live.current.active && live.current.isPlaying && live.current.spin) startSpin(450);
            return;
        }
        ignoreTouch.current = false;
        if (autoRef.current) api.current.settleAutoAngle();
        autoRef.current = null;
        api.current.stopTick();
        const wasScratching = scratchingRef.current;
        scratchingRef.current = false;
        sentRate.current = 0;
        if (wasScratching) AudioEngine.scratchEnd().catch(() => { });
        if (wasDragging && live.current.active && live.current.isPlaying && live.current.spin) startSpin(0);
    }, [startSpin]);


    // The song changing mid-scratch ends the scratch right away. The finger
    // may still be on the disc, but it does nothing until it is lifted and
    // put down again (it used to keep scratching the old song underneath
    // the new one).
    const lastTrackKey = useRef(trackKey);
    useEffect(() => {
        if (lastTrackKey.current === trackKey) return;
        lastTrackKey.current = trackKey;
        if (draggingRef.current || scratchingRef.current || autoRef.current) { finishScratch(true); draggingRef.current = false; }
    }, [trackKey, finishScratch]);

    // A skip pressed anywhere: dim the disc and stop taking touches right now
    // (a scratch in progress ends), without waiting for the new song.
    useEffect(() => subscribeSkipPress(() => {
        if (!live.current.touch) return;   // touch off: the disc never dims
        skipHold.current = { pos: live.current.position };
        if (skipTimer.current) clearTimeout(skipTimer.current);
        skipTimer.current = setTimeout(() => { skipHold.current = null; skipTimer.current = null; }, 12000);
        if (draggingRef.current || scratchingRef.current || autoRef.current) { finishScratch(true); draggingRef.current = false; }
        dim.stopAnimation();
        // The same fade as the disc coming back to life with a new song
        // (see the inWindow effect below), run the other way.
        Animated.timing(dim, { toValue: 1, duration: 450, easing: Easing.inOut(Easing.quad), useNativeDriver: true }).start();
    }), [finishScratch, dim]);
    useEffect(() => () => { if (skipTimer.current) clearTimeout(skipTimer.current); }, []);

    // Leaving the disc view (or the song changing) mid-scratch ends it.
    useEffect(() => {
        if (!visible) finishScratch(true);
        return () => { if (scratchingRef.current) AudioEngine.scratchEnd().catch(() => { }); if (tickTimer.current) clearInterval(tickTimer.current); };
    }, [visible, finishScratch]);

    // The scratch loop and the two "ease back to normal" ramps. Kept in a ref
    // and re-assigned every render, so the touch handlers (created once) and
    // the timer always call the latest version.
    const stopTick = () => { if (tickTimer.current) { clearInterval(tickTimer.current); tickTimer.current = null; } };
    api.current.stopTick = stopTick;
    api.current.ensureTick = () => { if (!tickTimer.current) tickTimer.current = setInterval(() => api.current.tick(), TICK_MS); };
    api.current.refreshDim = () => {
        const L = live.current;
        const ok = (L.windowOk && !skipHold.current) || !L.touch;
        dim.stopAnimation();
        Animated.timing(dim, { toValue: ok ? 0 : 1, duration: 450, easing: Easing.inOut(Easing.quad), useNativeDriver: true }).start();
    };
    // Degrees the disc has turned `u` (0 to 1) of the way through an ease: the
    // sound's speed goes from `from` to `to` along a smoothstep.
    api.current.autoDeg = (au, u) => au.degPerSec * (au.ms / 1000) * (au.from * u + (au.to - au.from) * (u * u * u - (u * u * u * u) / 2));
    // Stops the native disc motion where it is and records the angle.
    api.current.settleAutoAngle = () => {
        const au = autoRef.current;
        if (!au || !au.drive) return;
        const u = Math.max(0, Math.min(1, (Date.now() - au.t0) / au.ms));
        userRotVal.current = au.startAngle + api.current.autoDeg(au, u);
        userRot.stopAnimation();
        userRot.setValue(userRotVal.current);
    };
    api.current.startAuto = (kind) => {
        const L = live.current;
        // A paused disc always goes back to silence and the song stays paused,
        // however far it was turned (or if it reached an end). Only a disc that
        // was playing when touched carries on playing.
        const to = L.isPlaying ? 1 : 0;
        const from = sentRate.current;
        const ms = kind === 'edge' ? 700 : (Math.abs(to - from) < 0.15 ? 120 : 320);
        const au = { kind, t0: Date.now(), from, to, ms, degPerSec: Math.max(20, L.scratchDegPerSec), startAngle: userRotVal.current, drive: !!L.spin };
        autoRef.current = au;
        lastTick.current = Date.now();
        // The disc's motion during the ease runs on the native side (it was
        // set from this timer every 20 ms, which made it look choppy): the
        // same curve as the sound, worked out exactly.
        const total = api.current.autoDeg(au, 1);
        au.total = total;
        if (au.drive && Math.abs(total) > 1) {
            userRot.stopAnimation();
            Animated.timing(userRot, { toValue: au.startAngle + total, duration: ms, easing: (u) => api.current.autoDeg(au, u) / total, useNativeDriver: true }).start();
        }
        if (kind === 'edge') {
            // Fades like the end-of-song lock, so it is clear the disc is no
            // longer yours until it is done (and your finger is lifted).
            ignoreTouch.current = draggingRef.current;
            dim.stopAnimation();
            Animated.timing(dim, { toValue: 1, duration: 450, easing: Easing.inOut(Easing.quad), useNativeDriver: true }).start();
        }
        api.current.ensureTick();
    };
    api.current.finishAuto = () => {
        const au = autoRef.current;
        autoRef.current = null;
        stopTick();
        if (au && au.drive && Math.abs(au.total) > 1) userRotVal.current = au.startAngle + au.total;
        const was = scratchingRef.current;
        scratchingRef.current = false;
        sentRate.current = 0;
        const L = live.current;
        const carryOn = !au || au.to === 1;
        if (was) {
            AudioEngine.scratchEnd().catch(() => { });
        }
        // The idle turn takes over from the same angle at the same speed.
        if (carryOn && L.active && L.spin) releaseSpin(1);
        if (au && au.kind === 'edge') api.current.refreshDim();
        if (!draggingRef.current) { ignoreTouch.current = false; holdForTouch(false); if (onTouching) onTouching(false); }
    };
    api.current.tick = () => {
        const now = Date.now();
        const L = live.current;
        const dtS = Math.max(0, Math.min(0.1, (now - (lastTick.current || now)) / 1000));
        lastTick.current = now;
        pendingDeg.current = 0;
        const au = autoRef.current;
        if (au) {
            const u = Math.min(1, (now - au.t0) / au.ms);
            const e = u * u * (3 - 2 * u);
            const rate = au.from + (au.to - au.from) * e;
            sentRate.current = rate;
            if (scratchingRef.current) AudioEngine.scratchSetRate(rate);
            if (u >= 1) api.current.finishAuto();
            return;
        }
        if (!draggingRef.current) { stopTick(); return; }
        // Speed = how far the disc turned over the last ~110ms (a sliding
        // window, not just the last tick), so a steady hand gives a steady
        // number. This runs from the moment of the touch, even before the
        // audio is ready, so the first movement is not lost.
        const arr = samples.current;
        arr.push([now, userRotVal.current]);
        while (arr.length > 2 && now - arr[0][0] > 110) arr.shift();
        const span = (now - arr[0][0]) / 1000;
        const vel = span >= 0.04 ? (userRotVal.current - arr[0][1]) / span : 0;
        let rate = Math.max(-MAX_RATE, Math.min(MAX_RATE, vel / Math.max(20, L.scratchDegPerSec)));
        rate = smoothRate.current * 0.5 + rate * 0.5;
        smoothRate.current = rate;
        // Speed assist (Settings): the rate clings to 0.5x, 1x and 2x (forward
        // or backward) when the finger is close, and a nearly still finger
        // holds the record dead still. With assist off the speed is exactly
        // the finger's.
        const a = Math.abs(rate);
        if (a < (L.assist ? 0.1 : 0.04)) { rate = 0; snapped.current = 0; }
        else if (L.assist) {
            let best = 0, bestD = 1e9;
            for (const t of [0.5, 1, 2]) { const dd = Math.abs(a - t) / t; if (dd < bestD) { bestD = dd; best = t; } }
            const tol = snapped.current === best ? 0.3 : 0.18;
            if (bestD < tol) { snapped.current = best; rate = rate < 0 ? -best : best; }
            else snapped.current = 0;
        }
        if (!scratchingRef.current) return;      // audio not ready yet
        if (Math.abs(rate) > maxAbsRate.current) maxAbsRate.current = Math.abs(rate);
        const dtEst = scratchEstT.current ? (now - scratchEstT.current) / 1000 : 0;
        scratchEstT.current = now;
        scratchEst.current += sentRate.current * dtEst;
        // Reaching the crossfade area at either end of the song: the song and
        // disc ease to normal speed (backwards turns round into forwards, on
        // into the next song at the end) and the finger is ignored until lifted.
        if (L.duration > 0) {
            const hiLimit = L.duration - L.endGuard;
            const loLimit = L.startGuard;
            const est = scratchEst.current;
            if ((rate > 0.05 && est >= hiLimit - 0.35) || (rate < -0.05 && est <= loLimit + 0.35)) {
                sentRate.current = rate;
                AudioEngine.scratchSetRate(rate);
                api.current.startAuto('edge');
                return;
            }
        }
        sentRate.current = rate;
        AudioEngine.scratchSetRate(rate);
    };

    const panCfg = useRef({
        onStartShouldSetPanResponder: (e) => {
            const au = autoRef.current;
            return live.current.touch && live.current.allowed && !skipHold.current && !ignoreTouch.current
                && !(au && au.kind === 'edge') && (e.nativeEvent.trusted || insideDisc(e.nativeEvent.pageX, e.nativeEvent.pageY));
        },
        onPanResponderGrant: (e) => {
            const au = autoRef.current;
            draggingRef.current = true;
            grantAt.current = Date.now();
            console.log('[DISC] touch down' + (au ? ' (during ' + au.kind + ' ease)' : ''));
            holdForTouch(true);
            if (onTouching) onTouching(true);
            lastTouch.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
            // The disc's centre is already known from the last measurement, so the very first movement counts
            // (it used to wait for a new measurement, which swallowed the first few degrees of every scratch).
            lastAngle.current = center.current.valid ? angleOf(lastTouch.current.x, lastTouch.current.y, center.current) : null;
            viewRef.current?.measureInWindow((x, y, w, h) => {
                const was = center.current;
                center.current = { x: x + w / 2, y: y + h / 2, valid: w > 0 };
                const moved = !was.valid || Math.hypot(center.current.x - was.x, center.current.y - was.y) > 1;
                if (draggingRef.current && (lastAngle.current == null || moved)) lastAngle.current = angleOf(lastTouch.current.x, lastTouch.current.y, center.current);
            });
            samples.current = [];
            snapped.current = 0;
            lastTick.current = Date.now();
            // Caught the disc again while it was still easing back after a
            // lift: carry on scratching from the speed it had.
            if (au && au.kind === 'release' && scratchingRef.current) {
                api.current.settleAutoAngle();
                autoRef.current = null;
                smoothRate.current = sentRate.current;
                api.current.ensureTick();
                return;
            }
            stopSpin();
            smoothRate.current = 0;
            sentRate.current = 0;
            maxAbsRate.current = 0;
            // Grabbing the disc again within ~130ms of letting go is refused by
            // native (the last scratch is still finishing). Retry a few times.
            const tryBegin = (n) => AudioEngine.scratchBegin().then((ok) => {
                if (!draggingRef.current) { if (ok) AudioEngine.scratchEnd().catch(() => { }); return; }
                if (!ok && n < 6) { setTimeout(() => { if (draggingRef.current && !scratchingRef.current) tryBegin(n + 1); }, 70); return; }
                if (!ok) console.log('[DISC] could not start scratching after retries');
                scratchingRef.current = !!ok;
                console.log('[DISC] audio ready after ' + (Date.now() - grantAt.current) + 'ms: ' + (ok ? 'yes' : 'no'));
                if (ok) {
                    scratchEst.current = live.current.position;
                    scratchEstT.current = Date.now();
                    // The exact spot (the position prop can be half a second old).
                    AudioEngine.getProgress().then((p) => { if (p && p.position >= 0 && scratchingRef.current) scratchEst.current = p.position; }).catch(() => { });
                }
            }).catch(() => { });
            tryBegin(0);
            api.current.ensureTick();
        },
        onPanResponderMove: (e) => {
            lastTouch.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
            if (lastAngle.current == null) return;
            const a = angleOf(e.nativeEvent.pageX, e.nativeEvent.pageY, center.current);
            const d = wrap(a - lastAngle.current);
            lastAngle.current = a;
            // Not yours right now (easing back at an end of the song).
            if (ignoreTouch.current || autoRef.current) return;
            pendingDeg.current += d;
            userRotVal.current += d;
            userRot.setValue(userRotVal.current);
        },
        onPanResponderRelease: () => { console.log('[DISC] finger lifted after ' + (Date.now() - grantAt.current) + 'ms'); finishScratch(); },
        onPanResponderTerminate: () => { console.log('[DISC] touch cancelled by the system after ' + (Date.now() - grantAt.current) + 'ms'); finishScratch(); },
    }).current;

    // The finger is followed by native gesture handlers (not the JS touch responder) so the Player's
    // swipe-down-to-close, which is a gesture handler too, can never take the touch away. Two handlers on one
    // touch are exclusive, and these activate on the very first movement (minDistance 0), long before the
    // swipe needs its 5 px. A handler can only cover a rectangle, so the round disc is covered by a stack of thin
    // strips (each as wide as the circle is at that height): the corners outside the circle belong to nobody, and
    // swiping down from there still closes the Player. (Activating a handler by hand needs Reanimated, which the
    // app does not have, so activation is left to the handler itself.)
    const accepted = useRef(false);
    const [gestureOn, setGestureOn] = useState(allowed);
    useEffect(() => { if (!draggingRef.current) setGestureOn(allowed); }, [allowed]);
    const makeGesture = () => Gesture.Pan()
        .enabled(gestureOn)
        .minDistance(0)
        .shouldCancelWhenOutside(false)
        .runOnJS(true)
        .onBegin((e) => {
            if (accepted.current) return;   // a second finger: the first one owns the disc
            const te = { nativeEvent: { pageX: e.absoluteX, pageY: e.absoluteY, trusted: true } };
            if (!panCfg.onStartShouldSetPanResponder(te)) return;
            accepted.current = true;
            panCfg.onPanResponderGrant(te);
        })
        .onUpdate((e) => { if (accepted.current) panCfg.onPanResponderMove({ nativeEvent: { pageX: e.absoluteX, pageY: e.absoluteY } }); })
        .onFinalize((e) => {
            if (!accepted.current) return;
            accepted.current = false;
            if (e.state === State.CANCELLED) console.log('[DISC] touch cancelled by the system');
            panCfg.onPanResponderRelease();
            setGestureOn(live.current.allowed);
        });
    const STRIPS = 24;
    const strips = useMemo(() => {
        const out = [];
        const c = size / 2;
        for (let k = 0; k < STRIPS; k++) {
            const y0 = (k * size) / STRIPS, y1 = ((k + 1) * size) / STRIPS;
            const dy = Math.max(Math.abs(y0 - c), Math.abs(y1 - c));   // the edge of the strip farthest from the middle
            if (dy >= c) continue;
            const hw = Math.sqrt(c * c - dy * dy);
            out.push({ key: k, left: c - hw, top: y0, width: 2 * hw, height: y1 - y0, gesture: makeGesture() });
        }
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gestureOn, size]);


    const R = size;
    const labelD = R * 0.4;
    // Built once: re-creating these on every render (the position changes
    // several times a second) rebuilt the native animation graph each time.
    const spinDeg = useMemo(() => Animated.add(spin, lag).interpolate({ inputRange: [0, MT], outputRange: ['0deg', '360deg'] }), [spin, lag]);
    const userDeg = useMemo(() => userRot.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'] }), [userRot]);

    return (
        <View collapsable={false} style={{ width: R, height: R }}>
        <View ref={viewRef} collapsable={false} onLayout={refreshCenter} style={{ width: R, height: R }}>
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
        {strips.map(st => (
            <GestureDetector key={st.key} gesture={st.gesture}>
                <View collapsable={false} style={{ position: 'absolute', left: st.left, top: st.top, width: st.width, height: st.height }} />
            </GestureDetector>
        ))}
        </View>
    );
}

const s = StyleSheet.create({
    vinyl: { backgroundColor: '#0a0a0a', borderWidth: 2, overflow: 'hidden' },
    label: { position: 'absolute', overflow: 'hidden', backgroundColor: '#161616', justifyContent: 'center', alignItems: 'center' },
});
