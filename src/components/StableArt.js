import React, { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';

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
        console.log('[COVER] prefetch start ' + uri);
        let cancelled = false;
        Image.prefetch(uri)
            .then(ok => { if (!cancelled) console.log('[COVER] prefetch end ' + uri + ' ' + (ok ? 'ok' : 'miss')); })
            .catch(() => { if (!cancelled) console.log('[COVER] prefetch failed ' + uri); });
        return () => { cancelled = true; };
    }, [uri]);

    const loaded = (layer) => {
        const cur = layersRef.current;
        if (cur[cur.length - 1]?.id !== layer.id) return;
        console.log('[COVER] new cover loaded ' + layer.uri);
        loadedIdRef.current = layer.id;
        if (cur.length > 1) {
            console.log('[COVER] uri swap to ' + layer.uri);
            setLayers([layer]);
        }
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
