import React, { useEffect, useRef, useState } from 'react';
import { View, Animated, StyleSheet } from 'react-native';
import AudioEngine, { Event, usePlaybackState, State } from '../native/AudioEngine';

// A soft, see-through bar visualizer that fills the box it is placed in (a song's cover or
// its whole row). It is only mounted on the ONE row that is playing, so the audio tap and
// the event stream exist only while something is actually showing it.
//
// The native side sends eight loudness readings (low to high pitch) about 20 times a second;
// they are spread over BARS bars, smoothed (quick up, slower down) and written straight into
// animated heights, so there is no React re-render per update.
const BARS_PILL = 18;
const BARS_COVER = 8;

// The audio tap is shared by whichever row shows the visualizer. When the playing song
// changes (a skip, or the halfway point of a crossfade) one row unmounts and the next
// mounts at once; the tap is only switched off if nobody has asked for it 3 s later,
// so it is not torn down and rebuilt on every song change, or when the Player is closed
// and opened again a moment later.
let users = 0;
let offTimer = null;
const acquireTap = () => {
    const alreadyOn = users > 0 || offTimer !== null;
    users += 1;
    if (offTimer) { clearTimeout(offTimer); offTimer = null; }
    if (!alreadyOn) AudioEngine.setVisualizerEnabled(true);
};
const releaseTap = () => {
    users = Math.max(0, users - 1);
    if (users === 0 && !offTimer) {
        offTimer = setTimeout(() => { offTimer = null; if (users === 0) AudioEngine.setVisualizerEnabled(false); }, 3000);
    }
};

// Bars are drawn by scaling (a native transform), not by changing their height, so a reading
// costs no layout pass; each bar is anchored to the bottom of the box.
const MIN = 0.06, SPAN = 0.84;
const BAR_OPACITY = 0.37;   // the same on a pill and on a cover
const COVER_DIM = 0.5;      // a cover is darkened under the bars so they show on bright artwork

function Bar({ v, h, color }) {
    return (
        <Animated.View
            style={{
                flex: 1,
                height: h,
                backgroundColor: color,
                opacity: BAR_OPACITY,
                transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [h / 2, 0] }) }, { scaleY: v }],
            }}
        />
    );
}

export default function SongVisualizer({ color, mode, radius = 0, size = 0 }) {
    const bars = mode === 'cover' ? BARS_COVER : BARS_PILL;
    const vals = useRef(null);
    if (!vals.current || vals.current.length !== bars) vals.current = Array.from({ length: bars }, () => new Animated.Value(MIN));
    const shown = useRef(new Array(bars).fill(0));
    const target = useRef(new Array(8).fill(0));
    const lastEvent = useRef(0);
    const [h, setH] = useState(size > 0 ? size : 0);   // known up front: no wait for the first layout pass
    const { state } = usePlaybackState();
    const playing = state === State.Playing;
    const playingRef = useRef(playing);
    playingRef.current = playing;
    const mountedAt = useRef(Date.now());

    // Tap + event stream: on while this is mounted. Switched on again whenever playback
    // (re)starts, since the engine may have been rebuilt while paused.
    useEffect(() => {
        const sub = AudioEngine.addEventListener(Event.VizLevels, (e) => {
            const l = e && e.l;
            if (!l || l.length < 8) return;
            for (let i = 0; i < 8; i++) target.current[i] = l[i];
            lastEvent.current = Date.now();
        });
        acquireTap();
        return () => { try { sub.remove(); } catch (e) { } releaseTap(); };
    }, []);
    const firstRun = useRef(true);
    useEffect(() => {
        if (firstRun.current) { firstRun.current = false; return; }
        if (playing) AudioEngine.setVisualizerEnabled(true);   // playback restarted: put the tap in fresh (the engine may have been rebuilt)
    }, [playing]);

    // Once per screen frame (it was a 50 ms timer, which alone added up to 50 ms of delay): ease each bar
    // toward its reading, very quick up and slower down; with no readings (paused) fall to rest.
    useEffect(() => {
        let raf = 0;
        let lastHeal = 0;
        const loop = () => {
            const nowMs = Date.now();
            const live = nowMs - lastEvent.current < 250;
            // Playing, yet no readings for a moment: the tap was lost (an interruption, a route
            // change or a rebuilt engine drops it without telling JS). Put it in again, at most
            // once every 1.5 s, instead of waiting for the next pause/play to do it.
            if (playingRef.current && nowMs - Math.max(lastEvent.current, mountedAt.current) > 800 && nowMs - lastHeal > 1500) {
                lastHeal = nowMs;
                console.log('[VIZ] no readings while playing, putting the tap in again');
                AudioEngine.setVisualizerEnabled(true);
            }
            for (let i = 0; i < bars; i++) {
                const pos = (i / Math.max(1, bars - 1)) * 7;
                const a = Math.floor(pos); const b = Math.min(7, a + 1); const f = pos - a;
                const want = live ? target.current[a] * (1 - f) + target.current[b] * f : 0;
                const prev = shown.current[i];
                const next = want > prev ? prev + (want - prev) * 0.85 : prev + (want - prev) * 0.22;
                if (Math.abs(next - prev) > 0.004) { shown.current[i] = next; vals.current[i].setValue(MIN + next * SPAN); }
            }
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(raf);
    }, [bars]);

    // The box fills the whole pill or cover and is cut to its exact outline, so the bars follow the
    // curve of the corners instead of stopping short of them.
    return (
        <View pointerEvents="none" onLayout={(e) => setH(e.nativeEvent.layout.height)} style={[styles.box, { borderRadius: radius }]}>
            {mode === 'cover' ? <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,' + COVER_DIM + ')' }]} /> : null}
            {h > 0 ? vals.current.map((v, i) => <Bar key={i} v={v} h={h} color={color} />) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    box: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, flexDirection: 'row', alignItems: 'flex-end', gap: 2, overflow: 'hidden' },
});
