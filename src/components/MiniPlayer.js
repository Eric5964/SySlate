import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TrackPlayer, { usePlaybackState, State } from 'react-native-track-player';
import { useNavigation } from '@react-navigation/native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { skipWithCrossfade, playWithRamp, pauseWithRamp } from '../services/PlaybackService';

const TAB_BAR_HEIGHT = 49;

export default function MiniPlayer() {
    const navigation = useNavigation();
    const { currentTrack } = usePlayback();
    const { theme } = useTheme();
    const playbackState = usePlaybackState();
    const isPlaying = playbackState.state === State.Playing;
    const insets = useSafeAreaInsets();

    if (!currentTrack) return null;

    const bottom = TAB_BAR_HEIGHT + insets.bottom + 6;
    const title = currentTrack.ourTitle ?? currentTrack.title ?? '';
    const artist = currentTrack.ourArtist ?? currentTrack.artist ?? '';

    return (
        <TouchableOpacity
            style={[styles.container, { bottom, borderColor: theme.accentDim }]}
            onPress={() => navigation.navigate('Player', {})}
            activeOpacity={0.9}
        >
            <View style={[styles.art, { borderColor: theme.accentDim }]}>
                <Text style={{ fontSize: 18, color: theme.accentDim }}>♪</Text>
            </View>
            <View style={styles.info}>
                <Text style={styles.title} numberOfLines={1}>{title}</Text>
                <Text style={styles.artist} numberOfLines={1}>{artist}</Text>
            </View>
            <TouchableOpacity onPress={() => skipWithCrossfade('prev')} style={styles.btn} hitSlop={HIT}>
                <Text style={styles.btnTxt}>⏮</Text>
            </TouchableOpacity>
            <TouchableOpacity
                onPress={() => isPlaying ? pauseWithRamp() : playWithRamp()}
                style={styles.btn} hitSlop={HIT}
            >
                <Text style={[styles.btnTxt, { color: theme.accent }]}>{isPlaying ? '⏸' : '▶'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => skipWithCrossfade('next')} style={styles.btn} hitSlop={HIT}>
                <Text style={styles.btnTxt}>⏭</Text>
            </TouchableOpacity>
        </TouchableOpacity>
    );
}

const HIT = { top: 16, bottom: 16, left: 16, right: 16 };

const styles = StyleSheet.create({
    container: { position: 'absolute', left: 10, right: 10, height: 68, borderRadius: 16, backgroundColor: '#111', borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 12 },
    art: { width: 44, height: 44, borderRadius: 10, marginRight: 12, backgroundColor: '#0f0f0f', borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
    info: { flex: 1, marginRight: 4 },
    title: { color: '#e5e5e5', fontSize: 14, fontWeight: '600' },
    artist: { color: '#555', fontSize: 12, marginTop: 2 },
    btn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
    btnTxt: { color: '#bbb', fontSize: 22 },
});