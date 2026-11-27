import React, { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { prefetchCover } from '../utils/coverPrefetch';

// Draws a cover without ever showing an empty frame while the next one loads.
// The layer already on screen stays underneath, and the new one is mounted on
// top of it and only replaces it once it has actually loaded. Changing the
// Image's source (or its key) used to leave one dark frame, which showed
// through as a black flash. A full-size to 720px swap of the SAME song is just
// another layer here, so it does not remount or blank either.
let layerSeq = 0;

export default function StableArt({ uri, style, resizeMode = 'cover' }) {
    const [layers, setLayers] = useState(() => (uri ? [{ id: ++layerSeq, uri }] : []));
    const layersRef = useRef(layers);
    layersRef.current = layers;
    // The layer that has really finished loading (the one the person is looking at). A new uri is
    // stacked on top of THIS one, so skipping through several songs quickly (A, then B, then C
    // before B has loaded) keeps A drawn until C is ready, instead of dropping A for an unloaded B.
    const loadedIdRef = useRef(layers[0]?.id ?? null);

    useEffect(() => {
        if (!uri) {
            loadedIdRef.current = null;
            if (layersRef.current.length) setLayers([]);
            return undefined;
        }
        const cur = layersRef.current[layersRef.current.length - 1];
        if (cur?.uri === uri) return undefined;
        const layer = { id: ++layerSeq, uri };
        setLayers(prev => {
            const last = prev[prev.length - 1];
            if (last?.uri === uri) return prev;
            const shown = prev.find(l => l.id === loadedIdRef.current) || prev[0];
            return shown ? [shown, layer] : [layer];
        });
        // The visible Image below is the real load; this only warms the cache
        // for the next screen. prefetchCover dedupes it against the playback
        // prefetches and logs failures only, instead of a start/end pair for
        // every mounted cover.
        prefetchCover(uri);
        return undefined;
    }, [uri]);

    const loaded = (layer) => {
        const cur = layersRef.current;
        if (cur[cur.length - 1]?.id !== layer.id) return;
        loadedIdRef.current = layer.id;
        if (cur.length > 1) setLayers([layer]);
    };

    return (
        <View style={[styles.wrap, style]}>
            {layers.map(layer => (
                <Image
                    key={layer.id}
                    source={{ uri: layer.uri }}
                    style={StyleSheet.absoluteFill}
                    resizeMode={resizeMode}
                    onLoad={() => loaded(layer)}
                    onError={() => {
                        console.log('[COVER] load failed ' + layer.uri);
                        // Keep the cover that is showing; just drop the one that failed.
                        setLayers(prev => (prev.length > 1 && prev[prev.length - 1].id === layer.id ? prev.slice(0, -1) : prev));
                    }}
                />
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { overflow: 'hidden' },
});
