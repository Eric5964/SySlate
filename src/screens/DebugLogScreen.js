import React, { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Share, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import ScreenBackground from '../components/ScreenBackground';
import { getDebugLogLines, clearDebugLog, subscribeDebugLog } from '../utils/debugLog';

const fmtTime = (t) => {
    const d = new Date(t);
    const p = (n, len = 2) => String(n).padStart(len, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

export default function DebugLogScreen({ navigation }) {
    const { base, theme } = useTheme();
    // Real bug found here: this screen never accounted for the safe area at
    // all (no insets, no SafeAreaView) — on a real device that puts the
    // header (Back/Clear) right under the status bar/notch/Dynamic Island,
    // overlapped and unreachable, and the Share button right against the
    // home indicator at the bottom. PlayerScreen.js already does exactly
    // this (insets.top + a few px) — same fix here, plus a bottom one for
    // the button this screen has that Player's own layout doesn't.
    const insets = useSafeAreaInsets();
    const [lines, setLines] = useState(getDebugLogLines());
    const scrollRef = useRef(null);
    const atBottomRef = useRef(true);

    useEffect(() => {
        // Re-reads the whole buffer on every notify rather than trying to
        // append incrementally — this is a debug tool, not a hot path;
        // simple and always-correct beats fast here.
        return subscribeDebugLog(() => setLines(getDebugLogLines().slice()));
    }, []);

    useEffect(() => {
        if (atBottomRef.current) {
            // Follows new lines as they come in, same idea as a terminal
            // tailing a log file — only while already scrolled to the
            // bottom, so manually scrolling up to read something doesn't
            // get yanked back down by the next line arriving.
            requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
        }
    }, [lines]);

    const allText = () => lines.map(l => `${fmtTime(l.t)}  ${l.line}`).join('\n');

    const s = styles(base, theme);
    return (
        <ScreenBackground ownImage>
            <StatusBar barStyle="light-content" />
            <View style={[s.header, { paddingTop: insets.top + 8 }]}>
                <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                    <Text style={s.headerBtn}>Back</Text>
                </TouchableOpacity>
                <Text style={s.title}>Debug Log</Text>
                <TouchableOpacity onPress={() => clearDebugLog()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                    <Text style={[s.headerBtn, { color: theme.accent }]}>Clear</Text>
                </TouchableOpacity>
            </View>
            <Text style={s.subtitle}>
                {lines.length} lines — captures [RAMP-DEBUG], [SEEK-DEBUG], and any other console.log/native log while this screen (or the app) has been open. Reproduce the issue, then Share to send it over.
            </Text>
            <ScrollView
                ref={scrollRef}
                style={s.scroll}
                contentContainerStyle={{ paddingBottom: 24 }}
                onScroll={(e) => {
                    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                    atBottomRef.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
                }}
                scrollEventThrottle={200}
            >
                {lines.length === 0 ? (
                    <Text style={s.empty}>Nothing logged yet this session.</Text>
                ) : lines.map((l, i) => (
                    <Text key={i} style={s.line} selectable>
                        <Text style={s.lineTime}>{fmtTime(l.t)}  </Text>
                        {l.line}
                    </Text>
                ))}
            </ScrollView>
            <TouchableOpacity
                style={[s.shareBtn, { backgroundColor: theme.accent, marginBottom: insets.bottom + 12 }]}
                onPress={() => Share.share({ message: allText() || '(empty log)' })}
            >
                <Text style={s.shareBtnText}>Share Log</Text>
            </TouchableOpacity>
        </ScreenBackground>
    );
}

const styles = (base, theme) => StyleSheet.create({
    header: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4,
    },
    headerBtn: { color: base.text, fontSize: 16, fontWeight: '500', minWidth: 50 },
    title: { color: base.text, fontSize: 17, fontWeight: '700' },
    subtitle: { color: base.textFaint, fontSize: 12, paddingHorizontal: 16, paddingBottom: 8, lineHeight: 16 },
    scroll: { flex: 1, paddingHorizontal: 12 },
    empty: { color: base.textFaint, fontSize: 13, textAlign: 'center', marginTop: 40 },
    line: { color: base.text, fontSize: 11, fontFamily: 'Menlo', marginBottom: 6, lineHeight: 15 },
    lineTime: { color: base.textDim },
    shareBtn: {
        marginHorizontal: 16, marginBottom: 16, marginTop: 8,
        borderRadius: 14, paddingVertical: 13, alignItems: 'center',
    },
    shareBtnText: { color: '#000', fontSize: 15, fontWeight: '700' },
});
