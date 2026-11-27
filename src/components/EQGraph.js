import React, { useMemo, useRef, useState } from 'react';
import { View, Text, PanResponder, StyleSheet } from 'react-native';
import { GAIN_MIN, GAIN_MAX, FREQ_MIN, FREQ_MAX, freqToPos, responseDb, snapGain, formatFreq } from '../utils/customEQ';

// A graphical view of the 10 advanced-EQ bands: a log frequency axis, a gain axis, the combined
// response drawn as a filled curve, and one dot per band. Dragging a dot up or down sets that
// band's gain, exactly like the Gain slider further down the sheet.
//
// The dot follows the finger locally (so a fast drag never waits on the parent or the engine),
// the sound is previewed at a throttled rate, and the value is only written back to the sheet on
// release. That keeps the ten band cards from re-rendering on every touch move.

const HEIGHT = 180;
const PAD_TOP = 14;
const PAD_BOTTOM = 20;
const PAD_X = 12;
const DOT = 16;
const PREVIEW_MS = 80;
const COLS = 56;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const plotWidth = (w) => Math.max(1, w - PAD_X * 2);
const plotHeight = (h) => Math.max(1, h - PAD_TOP - PAD_BOTTOM);
const xFor = (f, w) => PAD_X + freqToPos(f) * plotWidth(w);
const yFor = (g, h) => PAD_TOP + ((GAIN_MAX - clamp(g, GAIN_MIN, GAIN_MAX)) / (GAIN_MAX - GAIN_MIN)) * plotHeight(h);
const gainForY = (y, h) => GAIN_MAX - ((y - PAD_TOP) / plotHeight(h)) * (GAIN_MAX - GAIN_MIN);

// Labels picked so they stay readable at phone width.
const FREQ_LABELS = [32, 125, 500, 2000, 8000];
const GRID_FREQS = [100, 1000, 10000];
const GRID_GAINS = [6, 3, 0, -3, -6];

export default function EQGraph({ bands, base, accent, onPreview, onCommit, disabled = false }) {
    const [layout, setLayout] = useState({ w: 0, h: HEIGHT });
    const [drag, setDrag] = useState(null);   // { i, g } while a dot is held
    const stateRef = useRef({});
    stateRef.current = { bands, layout, onPreview, onCommit, disabled };

    const graphRef = useRef(null);
    const activeRef = useRef(-1);
    // The graph's page origin, measured once at the start of every gesture. Using pageY against
    // this (instead of deriving an offset from locationY) stays correct even when the sheet is
    // still moving, and measuring per gesture means it also survives the sheet being scrolled.
    const winYRef = useRef(0);
    // Where the finger sits relative to the grabbed dot, so touching a dot never jumps its gain.
    const grabRef = useRef(0);
    const gainRef = useRef(0);
    const lastPreviewRef = useRef(0);
    // Identifies the current gesture: a measureInWindow callback that arrives after the finger
    // was lifted must not start a drag that never ends.
    const gestureIdRef = useRef(0);
    const measuringRef = useRef(false);
    const movedYRef = useRef(null);

    // One place turns a page Y into a snapped gain: the dot, the readout, the preview and the
    // committed value all use this exact number.
    const applyAtPageY = (pageY) => {
        const { layout: l, bands: b, onPreview: prev } = stateRef.current;
        if (activeRef.current < 0 || !Number.isFinite(pageY)) return;
        const y = pageY - winYRef.current - grabRef.current;
        const g = snapGain(gainForY(y, l.h));
        gainRef.current = g;
        setDrag({ i: activeRef.current, g });
        const now = Date.now();
        if (now - lastPreviewRef.current >= PREVIEW_MS) {
            lastPreviewRef.current = now;
            const next = b.map((x, j) => (j === activeRef.current ? { ...x, g } : x));
            prev?.(next);
        }
    };

    const beginAt = (pageX, pageY, winX, winY) => {
        const { bands: b, layout: l } = stateRef.current;
        if (!l.w || !b?.length) return;
        if (!Number.isFinite(pageX) || !Number.isFinite(pageY) || !Number.isFinite(winY)) return;
        winYRef.current = winY;
        const x = pageX - winX;
        const y = pageY - winY;
        let best = 0, bestD = Infinity;
        b.forEach((band, i) => {
            const dx = xFor(band.f, l.w) - x;
            // Normally the horizontal distance decides. If two bands share a frequency,
            // the vertical distance to their dots breaks the tie instead of the first
            // one in the list always winning.
            const dy = yFor(band.g, l.h) - y;
            const d = dx * dx + dy * dy * 0.25;
            if (d < bestD) { bestD = d; best = i; }
        });
        activeRef.current = best;
        // Grab offset, not a snap-to-finger: if the touch landed a few points above/below the
        // dot's centre, that distance is kept for the whole drag. Without this the dot jumped
        // to the finger on touch-down, changing the gain before the person had moved at all.
        grabRef.current = y - yFor(b[best].g, l.h);
        gainRef.current = snapGain(b[best].g);
    };

    const responder = useRef(PanResponder.create({
        onStartShouldSetPanResponder: () => !stateRef.current.disabled,
        onMoveShouldSetPanResponder: () => !stateRef.current.disabled,
        // A vertical drag here must not scroll the sheet under it.
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
            const { bands: b, layout: l } = stateRef.current;
            if (!l.w || !b?.length) return;
            const { pageX, pageY, locationY } = e.nativeEvent;
            const id = ++gestureIdRef.current;
            movedYRef.current = null;
            // only if measureInWindow is unavailable or gives nothing usable
            const fallbackY = Number.isFinite(locationY) ? pageY - locationY : 0;
            const node = graphRef.current;
            if (node && typeof node.measureInWindow === 'function') {
                measuringRef.current = true;
                node.measureInWindow((x, y, w, h) => {
                    if (gestureIdRef.current !== id) return;   // finger already lifted
                    measuringRef.current = false;
                    const wx = Number.isFinite(x) ? x : 0;
                    const wy = Number.isFinite(y) ? y : fallbackY;
                    beginAt(pageX, pageY, w > 0 ? wx : 0, (w > 0 && h > 0) ? wy : fallbackY);
                    // A move may have arrived while the measurement was in flight: apply the
                    // latest one now so the dot does not lag behind the finger.
                    const movedY = movedYRef.current;
                    movedYRef.current = null;
                    // Also on a touch with no move: this is what highlights the
                    // grabbed dot and shows its readout straight away.
                    applyAtPageY(movedY != null ? movedY : pageY);
                });
            } else {
                beginAt(pageX, pageY, 0, fallbackY);
                applyAtPageY(pageY);
            }
        },
        onPanResponderMove: (e) => {
            if (activeRef.current >= 0) applyAtPageY(e.nativeEvent.pageY);
            else if (measuringRef.current) movedYRef.current = e.nativeEvent.pageY;
        },
        onPanResponderRelease: () => finish(),
        onPanResponderTerminate: () => finish(),
    })).current;

    function finish() {
        gestureIdRef.current++;   // cancels a measureInWindow callback still in flight
        measuringRef.current = false;
        movedYRef.current = null;
        const i = activeRef.current;
        const g = gainRef.current;
        activeRef.current = -1;
        setDrag(null);
        // g was snapped once in applyAtPageY; the parent stores that same value.
        if (i >= 0 && Number.isFinite(g)) stateRef.current.onCommit?.(i, g);
    }

    const shown = useMemo(() => (drag && bands[drag.i] ? bands.map((b, j) => (j === drag.i ? { ...b, g: drag.g } : b)) : bands), [bands, drag]);

    const curve = useMemo(() => {
        if (!layout.w) return [];
        const w = layout.w, h = layout.h;
        const out = [];
        for (let i = 0; i < COLS; i++) {
            const p = i / (COLS - 1);
            const f = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, p);
            const db = clamp(responseDb(shown, f), GAIN_MIN, GAIN_MAX);
            const y = yFor(db, h);
            const y0 = yFor(0, h);
            out.push({ x: PAD_X + p * plotWidth(w), y, top: Math.min(y, y0), height: Math.max(1, Math.abs(y - y0)) });
        }
        return out;
    }, [shown, layout]);

    const activeBand = drag && bands[drag.i] ? { ...bands[drag.i], g: drag.g } : null;
    const barW = layout.w ? plotWidth(layout.w) / (COLS - 1) + 1 : 1;
    const zeroY = yFor(0, layout.h);

    return (
        <View>
            <View style={st.readout}>
                <Text style={{ color: base.textFaint, fontSize: 11 }} numberOfLines={1}>
                    {activeBand
                        ? `Band ${drag.i + 1}  ${formatFreq(activeBand.f)}  ${activeBand.g > 0 ? '+' : ''}${activeBand.g.toFixed(1)} dB`
                        : disabled ? 'Premade preset: bands are fixed' : 'Drag a dot up or down'}
                </Text>
            </View>
            <View
                ref={graphRef}
                style={[st.graph, { borderColor: base.border }]}
                onLayout={e => setLayout({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
                {...responder.panHandlers}
            >
                {layout.w > 0 && (
                    <>
                        {GRID_GAINS.map(g => (
                            <View key={g} pointerEvents="none" style={[st.hLine, { top: yFor(g, layout.h), backgroundColor: g === 0 ? base.textFaint : base.border, opacity: g === 0 ? 0.55 : 0.4 }]} />
                        ))}
                        {GRID_FREQS.map(f => (
                            <View key={f} pointerEvents="none" style={[st.vLine, { left: xFor(f, layout.w), backgroundColor: base.border }]} />
                        ))}
                        {curve.map((c, i) => (
                            <View key={i} pointerEvents="none" style={[st.bar, { left: c.x - barW / 2, width: barW, top: c.top, height: c.height, backgroundColor: accent }]} />
                        ))}
                        <View pointerEvents="none" style={[st.hLine, { top: zeroY, backgroundColor: base.textFaint, opacity: 0.7 }]} />
                        {bands.map((b, i) => {
                            const isActive = drag?.i === i;
                            const g = isActive ? drag.g : b.g;
                            return (
                                <View key={i} pointerEvents="none" style={[st.dot, {
                                    left: xFor(b.f, layout.w) - DOT / 2,
                                    top: yFor(g, layout.h) - DOT / 2,
                                    width: isActive ? DOT + 6 : DOT,
                                    height: isActive ? DOT + 6 : DOT,
                                    borderRadius: (isActive ? DOT + 6 : DOT) / 2,
                                    marginLeft: isActive ? -3 : 0,
                                    marginTop: isActive ? -3 : 0,
                                    backgroundColor: accent,
                                    borderColor: base.surface,
                                }]} />
                            );
                        })}
                        {FREQ_LABELS.map(f => (
                            <Text key={f} pointerEvents="none" style={[st.freqLabel, { left: clamp(xFor(f, layout.w) - 18, 0, layout.w - 36), color: base.textFaint }]}>
                                {formatFreq(f).replace(' ', '')}
                            </Text>
                        ))}
                        <Text pointerEvents="none" style={[st.gainLabel, { top: PAD_TOP - 6, color: base.textFaint }]}>+6</Text>
                        <Text pointerEvents="none" style={[st.gainLabel, { top: layout.h - PAD_BOTTOM - 6, color: base.textFaint }]}>-6</Text>
                    </>
                )}
            </View>
        </View>
    );
}

const st = StyleSheet.create({
    readout: { height: 16, justifyContent: 'center', marginBottom: 4 },
    graph: { height: HEIGHT, borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
    hLine: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth },
    vLine: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, opacity: 0.6 },
    bar: { position: 'absolute', opacity: 0.3 },
    dot: { position: 'absolute', borderWidth: 1.5 },
    freqLabel: { position: 'absolute', bottom: 3, width: 36, fontSize: 9, textAlign: 'center' },
    gainLabel: { position: 'absolute', right: 4, fontSize: 9 },
});
