import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePlaybackState, State } from 'react-native-track-player';
import { useNavigation } from '@react-navigation/native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { skipWithCrossfade, playWithRamp, pauseWithRamp } from '../services/PlaybackService';
import { PlayIcon, PauseIcon, SkipNextIcon, SkipPrevIcon } from './Icons';
import GradientCap from './GradientCap';
import { playlistColor } from '../utils/color';
import { getAverageColor } from '../utils/coverColor';
import { squircle } from '../utils/squircle';
import { getPlaylistCovers } from '../utils/storage';

const TAB_BAR_HEIGHT = 49;
const ART_SIZE = 44;

export default function MiniPlayer({ withTabBar = true }) {
    const navigation = useNavigation();
    const { currentTrack, currentPlaylist } = usePlayback();
    const { theme } = useTheme();
    const playbackState = usePlaybackState();
    const isPlaying = playbackState.state === State.Playing;
    const insets = useSafeAreaInsets();
    const [gradientColor, setGradientColor] = useState(theme.accent);

    useEffect(() => {
        const fallback = playlistColor(currentPlaylist?.name ?? currentTrack?.title ?? '');
        if (!currentPlaylist?.path) { setGradientColor(fallback); return; }
        let cancelled = false;
        getPlaylistCovers().then(async covers => {
            const uri = covers[currentPlaylist.path];
            const color = uri ? await getAverageColor(uri, fallback) : fallback;
            if (!cancelled) setGradientColor(color);
        });
        return () => { cancelled = true; };
    }, [currentPlaylist?.path]);

    if (!currentTrack) return null;

    const bottom = (withTabBar ? TAB_BAR_HEIGHT : 0) + insets.bottom + 6;
    const title = currentTrack.ourTitle ?? currentTrack.title ?? '';
    const artist = currentTrack.ourArtist ?? currentTrack.artist ?? '';
    const artwork = currentTrack.artwork;
    const skipIconColor = theme.accent === '#f2f2f2' ? '#333' : '#bbb';

    return (
        <TouchableOpacity
            style={[styles.container, { bottom, borderColor: theme.accentDim }]}
            onPress={() => navigation.navigate('Player', {})}
            activeOpacity={0.9}
        >
            <GradientCap color={gradientColor} height={68} style={{ borderRadius: 16, opacity: 0.55 }} />
            <View style={[styles.art, { borderColor: theme.accentDim, overflow: 'hidden', borderRadius: squircle(ART_SIZE) }]}>
                {artwork
                    ? <Image source={{ uri: artwork }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                    : <Text style={{ fontSize: 18, color: theme.accentDim }}>♪</Text>
                }
            </View>
            <View style={styles.info}>
                <Text style={styles.title} numberOfLines={1}>{title}</Text>
                <Text style={styles.artist} numberOfLines={1}>{artist}</Text>
            </View>
            <TouchableOpacity onPress={() => skipWithCrossfade('prev')} style={styles.btn} hitSlop={HIT}>
                <SkipPrevIcon size={20} color={skipIconColor} />
            </TouchableOpacity>
            <TouchableOpacity
                onPress={() => isPlaying ? pauseWithRamp() : playWithRamp()}
                style={styles.btn} hitSlop={HIT}
            >
                {isPlaying ? <PauseIcon size={20} color={theme.accent} /> : <PlayIcon size={18} color={theme.accent} />}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => skipWithCrossfade('next')} style={styles.btn} hitSlop={HIT}>
                <SkipNextIcon size={20} color={skipIconColor} />
            </TouchableOpacity>
        </TouchableOpacity>
    );
}

const HIT = { top: 16, bottom: 16, left: 16, right: 16 };

const styles = StyleSheet.create({
    container: { position: 'absolute', left: 10, right: 10, height: 68, borderRadius: 16, backgroundColor: '#111', borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 12, overflow: 'hidden' },
    art: { width: ART_SIZE, height: ART_SIZE, marginRight: 12, backgroundColor: '#0f0f0f', borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
    info: { flex: 1, marginRight: 4 },
    title: { color: '#e5e5e5', fontSize: 14, fontWeight: '600' },
    artist: { color: '#555', fontSize: 12, marginTop: 2 },
    btn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
});
