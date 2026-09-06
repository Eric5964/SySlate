import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePlaybackState, State, useProgress } from '../native/AudioEngine';
import { useNavigation } from '@react-navigation/native';
import { usePlayback } from '../context/PlaybackContext';
import { useTheme } from '../context/ThemeContext';
import { usePreferences } from '../context/PreferencesContext';
import { skipWithRamp, playWithRamp, pauseWithRamp } from '../services/PlaybackService';
import { PlayIcon, PauseIcon, SkipNextIcon, SkipPrevIcon } from './Icons';
import GradientCap from './GradientCap';
import { squircle } from '../utils/squircle';

const TAB_BAR_HEIGHT = 49;
const ART_SIZE = 44;
const SKIP_ICON_COLOR = '#bbb'; // fixed regardless of accent, including white

export default function MiniPlayer({ withTabBar = true }) {
    const navigation = useNavigation();
    const { currentTrack } = usePlayback();
    const { theme, base } = useTheme();
    const { coverShape, showSongCovers } = usePreferences();
    const playbackState = usePlaybackState();
    const isPlaying = playbackState.state === State.Playing;
    const progress = useProgress(500);
    const insets = useSafeAreaInsets();

    const pct = progress.duration > 0 ? Math.min(1, progress.position / progress.duration) : 0;
    const animPct = useRef(new Animated.Value(pct)).current;
    const animRunRef = useRef(null);
    const animPctValueRef = useRef(pct);
    useEffect(() => {
        const id = animPct.addListener(({ value }) => { animPctValueRef.current = value; });
        return () => animPct.removeListener(id);
    }, []);

    useEffect(() => {
        // Always stop and snap to the exact real position when paused —
        // this used to be gated behind the same drift check as the resync
        // logic below, so if the animation was already running and drift
        // happened to be small at the instant of pausing (the normal case,
        // since pausing is immediate), the running Animated.timing never
        // actually got stopped and kept advancing on its own.
        if (!isPlaying) {
            animRunRef.current?.stop();
            animRunRef.current = null;
            animPct.setValue(pct);
            animPctValueRef.current = pct;
            return;
        }
        const drift = Math.abs(animPctValueRef.current - pct);
        if (!animRunRef.current || drift > 0.02) {
            animRunRef.current?.stop();
            animPct.setValue(pct);
            animPctValueRef.current = pct;
            if (progress.duration > 0 && pct < 1) {
                const remainingMs = Math.max(0, (1 - pct) * progress.duration * 1000);
                const anim = Animated.timing(animPct, { toValue: 1, duration: remainingMs, easing: Easing.linear, useNativeDriver: false });
                animRunRef.current = anim;
                anim.start();
            } else {
                animRunRef.current = null;
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [Math.round(pct * 200), isPlaying, currentTrack?.id]);

    useEffect(() => () => animRunRef.current?.stop(), []);

    const animWidth = animPct.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

    if (!currentTrack) return null;

    const bottom = (withTabBar ? TAB_BAR_HEIGHT : 0) + insets.bottom + 6;
    const title = currentTrack.ourTitle ?? currentTrack.title ?? '';
    const artist = currentTrack.ourArtist ?? currentTrack.artist ?? '';
    const artwork = currentTrack.artwork;

    return (
        <TouchableOpacity
            style={[styles.container, { bottom, borderColor: theme.accentDim, backgroundColor: base.surface }]}
            onPress={() => navigation.navigate('Player', {})}
            activeOpacity={0.9}
        >
            <GradientCap color={theme.accent} height={68} style={{ borderRadius: 16, opacity: 0.5 }} />
            <View pointerEvents="none" style={styles.miniProgressTrack}>
                <Animated.View style={[styles.miniProgressFill, { width: animWidth, backgroundColor: theme.accent }]} />
            </View>
            {/* "Show Song Covers In Lists" previously only applied to All
                Songs/Playlist rows and the Queue sheet — the mini player
                always showed art regardless, unlike everywhere else covers
                appear. */}
            {showSongCovers && (
                <View style={[styles.art, { borderColor: theme.accentDim, overflow: 'hidden', borderRadius: squircle(ART_SIZE, coverShape) }]}>
                    {artwork
                        ? <Image source={{ uri: artwork }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                        : <Text style={{ fontSize: 18, color: theme.accentDim }}>♪</Text>
                    }
                </View>
            )}
            <View style={styles.info}>
                <Text style={styles.title} numberOfLines={1}>{title}</Text>
                <Text style={styles.artist} numberOfLines={1}>{artist}</Text>
            </View>
            <TouchableOpacity onPress={() => skipWithRamp('prev')} style={styles.btn} hitSlop={HIT}>
                <SkipPrevIcon size={20} color={SKIP_ICON_COLOR} />
            </TouchableOpacity>
            <TouchableOpacity
                onPress={() => isPlaying ? pauseWithRamp() : playWithRamp()}
                style={styles.btn} hitSlop={HIT}
            >
                {isPlaying ? <PauseIcon size={20} color={theme.accent} /> : <PlayIcon size={18} color={theme.accent} />}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => skipWithRamp('next')} style={styles.btn} hitSlop={HIT}>
                <SkipNextIcon size={20} color={SKIP_ICON_COLOR} />
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
    // marginHorizontal added — the three buttons sat directly adjacent with
    // no gap at all, just their own 40px width apart, which read as too
    // close together.
    btn: { width: 40, height: 40, marginHorizontal: 3, justifyContent: 'center', alignItems: 'center' },
    miniProgressTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 6, backgroundColor: 'transparent' },
    miniProgressFill: { height: 6, borderRadius: 0 },
});
