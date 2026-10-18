import React, { useContext, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { LibraryContext } from '../context/LibraryContext';
import ScreenBackground from '../components/ScreenBackground';
import { getListeningStats } from '../utils/storage';
import { usePreferences } from '../context/PreferencesContext';

// Hoisted out of the screen body: a component defined inside a component is a
// brand new type on every render, so React tore this row down and remounted it
// instead of updating it (and it would have lost any state it kept). `s` is
// passed in instead of closed over.
const Row = ({ s, i, left, sub, right }) => (
    <View style={s.row}>
        <Text style={s.rank}>{i}</Text>
        <View style={{ flex: 1 }}>
            <Text style={s.rowTitle} numberOfLines={1}>{left}</Text>
            {!!sub && <Text style={s.rowSub} numberOfLines={1}>{sub}</Text>}
        </View>
        <Text style={s.rowRight}>{right}</Text>
    </View>
);

export default function StatsScreen({ navigation }) {
    const { base, theme } = useTheme();
    const insets = useSafeAreaInsets();
    const { allSongs } = useContext(LibraryContext);
    const { artistSeparator, artistDisplayJoin } = usePreferences();
    const [stats, setStats] = useState(null);
    useEffect(() => { getListeningStats(allSongs || [], artistSeparator, artistDisplayJoin).then(setStats).catch(() => setStats({ totalPlays: 0, hours: 0, played: 0, librarySize: 0, topSongs: [], topArtists: [] })); }, [allSongs, artistSeparator, artistDisplayJoin]);
    const s = styles(base, theme);
    return (
        <ScreenBackground ownImage>
            <StatusBar barStyle="light-content" />
            <View style={[s.header, { paddingTop: insets.top + 8 }]}>
                <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                    <Text style={[s.headerBtn, { color: theme.accent }]}>Back</Text>
                </TouchableOpacity>
                <Text style={s.title}>Listening Stats</Text>
                <View style={{ width: 40 }} />
            </View>
            {!stats ? null : (
                <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
                    <View style={s.cards}>
                        <View style={s.card}><Text style={[s.big, { color: theme.accent }]}>{stats.totalPlays}</Text><Text style={s.cardLabel}>plays</Text></View>
                        <View style={s.card}><Text style={[s.big, { color: theme.accent }]}>{stats.hours < 10 ? stats.hours.toFixed(1) : Math.round(stats.hours)}</Text><Text style={s.cardLabel}>hours (est.)</Text></View>
                        <View style={s.card}><Text style={[s.big, { color: theme.accent }]}>{stats.played}</Text><Text style={s.cardLabel}>of {stats.librarySize} songs played</Text></View>
                    </View>
                    {stats.topSongs.length === 0 ? (
                        <Text style={s.empty}>Nothing yet. Play some songs and they will show up here.</Text>
                    ) : (
                        <>
                            <Text style={s.sectionLabel}>Most played songs</Text>
                            <View style={s.body}>
                                {stats.topSongs.map((r, i) => <Row key={i} s={s} i={i + 1} left={r.title} sub={r.artist} right={`${r.n}x`} />)}
                            </View>
                            <Text style={s.sectionLabel}>Top artists</Text>
                            <View style={s.body}>
                                {stats.topArtists.map((r, i) => <Row key={i} s={s} i={i + 1} left={r.name} right={`${r.n}x`} />)}
                            </View>
                        </>
                    )}
                </ScrollView>
            )}
        </ScreenBackground>
    );
}

const styles = (base, theme) => StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 10 },
    headerBtn: { fontSize: 16, fontWeight: '600', width: 40 },
    title: { color: base.text, fontSize: 18, fontWeight: '700' },
    cards: { flexDirection: 'row', gap: 10, marginBottom: 18 },
    card: { flex: 1, backgroundColor: base.surface, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 10, alignItems: 'center' },
    big: { fontSize: 26, fontWeight: '800' },
    cardLabel: { color: base.textFaint, fontSize: 11, marginTop: 2, textAlign: 'center' },
    sectionLabel: { color: base.textFaint, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8, marginLeft: 4 },
    body: { backgroundColor: base.surface, borderRadius: 14, marginBottom: 18, overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 14 },
    rank: { color: base.textFaint, width: 24, fontSize: 13, fontWeight: '700' },
    rowTitle: { color: base.text, fontSize: 15, fontWeight: '600' },
    rowSub: { color: base.textFaint, fontSize: 12, marginTop: 1 },
    rowRight: { color: base.textFaint, fontSize: 13, marginLeft: 10 },
    empty: { color: base.textFaint, textAlign: 'center', marginTop: 30, fontSize: 14 },
});
