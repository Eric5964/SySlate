import React, { useState } from 'react';
import { Pressable, View, StyleSheet } from 'react-native';

// A press target that darkens while it is held instead of fading out. Fading
// (TouchableOpacity) lets whatever sits behind the row show through, for
// example the "Next" bar under a swiped song or the song list under the mini
// player. This keeps the row fully solid and puts a dark layer over it.
export const DIM_COLOR = 'rgba(0,0,0,0.3)';

export default function DimPressable({ style, children, onPressIn, onPressOut, dim = DIM_COLOR, disabledDim = false, fade = false, ...rest }) {
    const [down, setDown] = useState(false);
    const flat = StyleSheet.flatten(style) || {};
    return (
        <Pressable
            {...rest}
            style={fade && down ? [style, { opacity: 0.75 }] : style}
            onPressIn={(e) => { if (!disabledDim) setDown(true); if (onPressIn) onPressIn(e); }}
            onPressOut={(e) => { setDown(false); if (onPressOut) onPressOut(e); }}
        >
            {children}
            {down && !fade ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: dim, borderRadius: flat.borderRadius, borderCurve: flat.borderCurve }]} /> : null}
        </Pressable>
    );
}
